import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  OrganizationPlan,
  OrganizationQuery,
  type Subject,
} from "@hyper/contracts";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { stableDigest } from "./credentials.js";
import { sourceConnection } from "./source-connection.js";
import { requireNextcloud } from "../providers/nextcloud.js";
import { NextcloudOrganizationProvider } from "../providers/nextcloud-organization.js";
import { ExecutionPolicyService } from "./execution-policy.js";

type Scope = {
  bindingKey: string;
  uids: string[];
  provider?: NextcloudOrganizationProvider;
  remoteUid: string;
  rosterHash: string;
};
function binding(s: Subject) {
  if (s.demo) return "demo:workspace-members";
  const config = requireNextcloud();
  return stableDigest({
    provider: config.providerKey,
    transportUrl: config.transportUrl,
    workspaceId: config.workspaceId,
    group: config.memberGroup,
  });
}
export class OrganizationService {
  constructor(readonly db: Database) {}
  /** Exact IDs for communication invitations; no privileged profile lookup, auto-enrollment or credential return. */
  async eligibleUids(s: Subject, uids: string[]) {
    if (
      !Array.isArray(uids) ||
      uids.length < 1 ||
      uids.length > 20 ||
      new Set(uids).size !== uids.length ||
      uids.some(
        (uid) =>
          typeof uid !== "string" ||
          !uid ||
          uid.length > 255 ||
          /[\u0000-\u001f\u007f]/.test(uid),
      )
    )
      throw new BadRequestException("请选择 1–20 个不同的员工 UID。");
    const scope = await this.scope(s);
    if (uids.some((uid) => !scope.uids.includes(uid)))
      throw new NotFoundException("所选员工已不在当前企业成员范围。");
    await this.recheck(s, scope);
    return { bindingKey: scope.bindingKey, uids: [...uids] };
  }
  static async lock(c: PoolClient, workspaceId: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "organization:" + workspaceId,
    ]);
  }
  private async scope(s: Subject): Promise<Scope> {
    await assertMember(this.db, s);
    const bindingKey = binding(s);
    if (s.demo) {
      const rows = (
        await this.db.pool.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 ORDER BY user_id LIMIT 2001",
          [s.workspaceId],
        )
      ).rows;
      if (rows.length > 2000)
        throw new ServiceUnavailableException(
          "成员目录超过 2000 人，请扩展分页后再使用。",
        );
      const uids = rows.map((r) => r.user_id as string);
      return {
        bindingKey,
        uids,
        remoteUid: s.id,
        rosterHash: stableDigest(uids),
      };
    }
    const connection = await sourceConnection(this.db, s);
    const provider = new NextcloudOrganizationProvider(
      connection.config,
      connection.credentials,
    );
    const uids = await provider.members();
    if (!uids.includes(connection.remoteUid))
      throw new ForbiddenException("当前员工已不在企业成员范围。");
    if (binding(s) !== bindingKey)
      throw new ForbiddenException("通讯录来源已变化，请重新登录。");
    return {
      bindingKey,
      uids,
      provider,
      remoteUid: connection.remoteUid,
      rosterHash: stableDigest(uids),
    };
  }
  private async recheck(s: Subject, scope: Scope) {
    const current = await this.scope(s);
    if (
      current.bindingKey !== scope.bindingKey ||
      current.rosterHash !== scope.rosterHash
    )
      throw new ConflictException("通讯录成员范围已变化，请重新读取。");
  }
  private async metadata(s: Subject, scope: Scope) {
    // One SQL snapshot binds all product metadata to the same revision.
    const result = (
      await this.db.pool.query(
        `SELECT
      COALESCE((SELECT jsonb_agg(d ORDER BY d.name,d.id) FROM (SELECT id,name,parent_id AS "parentId" FROM cw_departments WHERE workspace_id=$1 AND binding_key=$2 ORDER BY name,id LIMIT 501)d),'[]'::jsonb) AS departments,
      COALESCE((SELECT jsonb_agg(r) FROM (SELECT remote_uid,department_id FROM cw_department_people WHERE workspace_id=$1 AND binding_key=$2 AND remote_uid=ANY($3::text[]))r),'[]'::jsonb) AS relations,
      COALESCE((SELECT revision FROM cw_organization_states WHERE workspace_id=$1 AND binding_key=$2),0) AS revision`,
        [s.workspaceId, scope.bindingKey, scope.uids],
      )
    ).rows[0];
    const departments = result.departments as {
        id: string;
        name: string;
        parentId: string | null;
      }[],
      relations = result.relations as {
        remote_uid: string;
        department_id: string;
      }[],
      revision = result.revision as number;
    if (departments.length > 500)
      throw new ServiceUnavailableException(
        "部门目录超过 500 个，请扩展组织目录后再使用。",
      );
    return { departments, relations, revision };
  }
  async read(s: Subject, raw: unknown = {}) {
    const query = OrganizationQuery.parse(raw),
      scope = await this.scope(s);
    const meta = await this.metadata(s, scope);
    if (
      query.departmentId &&
      !meta.departments.some((d) => d.id === query.departmentId)
    )
      throw new NotFoundException("部门不存在或来源已变化。");
    let candidates = scope.uids,
      partial = false;
    const names = new Map<
      string,
      {
        uid: string;
        name: string;
        nameState: "source-verified" | "uid-only" | "product";
      }
    >();
    if (query.query) {
      const q = query.query.toLocaleLowerCase();
      if (scope.provider) {
        const found = await scope.provider.search(query.query);
        partial = found.partial;
        for (const row of found.rows)
          if (scope.uids.includes(row.uid))
            names.set(row.uid, { ...row, nameState: "source-verified" });
        candidates = scope.uids.filter(
          (uid) => uid.toLocaleLowerCase().includes(q) || names.has(uid),
        );
      } else {
        const rows = (
          await this.db.pool.query(
            "SELECT id,name FROM cw_users WHERE id=ANY($1::uuid[])",
            [scope.uids],
          )
        ).rows;
        candidates = rows
          .filter(
            (r) => r.id.includes(q) || r.name.toLocaleLowerCase().includes(q),
          )
          .map((r) => r.id);
      }
    }
    const departmentByUid = new Map<string, string>(
      meta.relations.map((r) => [r.remote_uid, r.department_id]),
    );
    if (query.departmentId)
      candidates = candidates.filter(
        (uid) => departmentByUid.get(uid) === query.departmentId,
      );
    candidates.sort((a, b) => a.localeCompare(b));
    const page = candidates.slice(query.offset, query.offset + 30);
    if (scope.provider) {
      for (const row of await scope.provider.people(page))
        names.set(row.uid, row);
    } else if (page.length) {
      for (const row of (
        await this.db.pool.query(
          "SELECT id,name FROM cw_users WHERE id=ANY($1::uuid[])",
          [page],
        )
      ).rows)
        names.set(row.id, {
          uid: row.id,
          name: row.name,
          nameState: "product",
        });
    }
    const mapped = scope.provider
      ? (
          await this.db.pool.query(
            'SELECT x.remote_uid AS uid,m.user_id AS id,m.role,m.role_revision AS "roleRevision",m.membership_id AS "membershipId" FROM cw_external_identities x JOIN cw_members m ON m.workspace_id=x.workspace_id AND m.user_id=x.user_id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.remote_uid=ANY($3::text[])',
            [s.workspaceId, scope.provider.config.providerKey, page],
          )
        ).rows
      : (
          await this.db.pool.query(
            'SELECT user_id::text AS uid,user_id AS id,role,role_revision AS "roleRevision",membership_id AS "membershipId" FROM cw_members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[])',
            [s.workspaceId, page],
          )
        ).rows;
    const ids = new Map(mapped.map((r) => [r.uid, r]));
    await this.recheck(s, scope);
    // Product metadata is versioned independently of the live source; do not combine mismatched snapshots.
    if ((await this.metadata(s, scope)).revision !== meta.revision)
      throw new ConflictException("组织信息已更新，请重新读取。");
    const recentChanges = (
      await this.db.pool.query(
        'SELECT id,operation,revision,receipt,created_at AS "createdAt" FROM cw_organization_changes WHERE workspace_id=$1 AND binding_key=$2 AND actor_id=$3 ORDER BY created_at DESC,id LIMIT 20',
        [s.workspaceId, scope.bindingKey, s.id],
      )
    ).rows;
    const role = await assertMember(this.db, s);
    return {
      recentChanges,
      bindingKey: scope.bindingKey,
      revision: meta.revision,
      checkedAt: new Date().toISOString(),
      origin: s.demo ? "demo" : "nextcloud",
      canManage: role === "admin",
      departments: meta.departments,
      total: candidates.length,
      sourceTotal: scope.uids.length,
      partial,
      offset: query.offset,
      nextOffset:
        query.offset + 30 < candidates.length ? query.offset + 30 : null,
      rows: page.map((uid) => ({
        ...(names.get(uid) ?? { uid, name: uid, nameState: "uid-only" }),
        id: ids.get(uid)?.id ?? null,
        role: ids.get(uid)?.role ?? null,
        roleRevision: ids.get(uid)?.roleRevision ?? null,
        membershipId: ids.get(uid)?.membershipId ?? null,
        departmentId: departmentByUid.get(uid) ?? null,
      })),
    };
  }
  async prepare(s: Subject, raw: unknown) {
    const plan = OrganizationPlan.parse(raw),
      scope = await this.scope(s);
    if (plan.bindingKey !== scope.bindingKey)
      throw new ConflictException("组织来源已变化，请重新读取后确认。");
    const role = await assertMember(this.db, s);
    if (plan.operation !== "read" && role !== "admin")
      throw new ForbiddenException("只有当前工作区管理员可以修改组织信息。");
    if (
      plan.operation === "assign_department" &&
      !scope.uids.includes(plan.uid)
    )
      throw new NotFoundException("员工已不在当前来源成员范围。");
    if (plan.operation === "change_role") {
      const mapped = s.demo
        ? scope.uids.includes(plan.userId)
        : !!(
            await this.db.pool.query(
              "SELECT user_id FROM cw_external_identities WHERE workspace_id=$1 AND provider_key=$2 AND user_id=$3 AND remote_uid=ANY($4::text[])",
              [
                s.workspaceId,
                scope.provider!.config.providerKey,
                plan.userId,
                scope.uids,
              ],
            )
          ).rowCount;
      if (!mapped)
        throw new NotFoundException("所选员工当前没有对应的企业成员身份。");
    }
    return { plan, scope };
  }
  async apply(
    c: PoolClient,
    s: Subject,
    raw: unknown,
    scope: Scope,
    key: string,
    runId?: string,
  ) {
    const plan = OrganizationPlan.parse(raw);
    if (plan.operation === "read")
      throw new BadRequestException("读取操作无需保存组织变更。");
    await OrganizationService.lock(c, s.workspaceId);
    if (binding(s) !== scope.bindingKey)
      throw new ForbiddenException("通讯录来源已变化。");
    const role = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0]?.role;
    if (role !== "admin") throw new ForbiddenException("组织管理权限已撤销。");
    if (
      s.identityCredentialId &&
      !(
        await c.query(
          "SELECT id FROM cw_identity_credentials WHERE id=$1 AND disabled_at IS NULL FOR SHARE",
          [s.identityCredentialId],
        )
      ).rowCount
    )
      throw new ForbiddenException("来源登录已撤销。");
    const hash = stableDigest({ plan, bindingKey: scope.bindingKey });
    const prior = (
      await c.query(
        "SELECT input_hash,receipt FROM cw_organization_changes WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("组织操作幂等键冲突。");
      return prior.receipt;
    }
    await c.query(
      "INSERT INTO cw_organization_states(workspace_id,binding_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [s.workspaceId, scope.bindingKey],
    );
    const revision = (
      await c.query(
        "SELECT revision FROM cw_organization_states WHERE workspace_id=$1 AND binding_key=$2 FOR UPDATE",
        [s.workspaceId, scope.bindingKey],
      )
    ).rows[0].revision;
    if (revision !== plan.expectedRevision)
      throw new ConflictException("组织信息已更新，请重新读取后确认。");
    const departments = (
      await c.query(
        "SELECT id,name,parent_id FROM cw_departments WHERE workspace_id=$1 AND binding_key=$2 ORDER BY id FOR UPDATE",
        [s.workspaceId, scope.bindingKey],
      )
    ).rows;
    const department = (id: string) => {
      const d = departments.find((row) => row.id === id);
      if (!d) throw new NotFoundException("部门不存在或不在当前组织范围。");
      return d;
    };
    let detail: Record<string, unknown> = {};
    if (
      plan.operation === "create_department" ||
      plan.operation === "update_department"
    ) {
      if (plan.operation === "create_department" && departments.length >= 500)
        throw new BadRequestException("部门数量已达 500 个上限。");
      const id =
        plan.operation === "create_department"
          ? randomUUID()
          : department(plan.departmentId).id;
      if (
        departments.some(
          (d) =>
            d.id !== id &&
            d.parent_id === plan.parentId &&
            d.name === plan.name,
        )
      )
        throw new ConflictException("同级已有同名部门。");
      const tree = departments
        .filter((d) => d.id !== id)
        .concat([{ id, parent_id: plan.parentId }]);
      for (const node of tree) {
        let current: string | null = node.id,
          depth = 0;
        const visited = new Set<string>();
        while (current) {
          if (visited.has(current))
            throw new BadRequestException("部门不能形成循环关系。");
          visited.add(current);
          const item = tree.find((d) => d.id === current);
          if (!item)
            throw new NotFoundException("上级部门不存在或不在当前组织范围。");
          current = item.parent_id;
          if (++depth > 20)
            throw new BadRequestException("部门层级不能超过 20 层。");
        }
      }
      if (plan.operation === "create_department")
        await c.query(
          "INSERT INTO cw_departments(id,workspace_id,binding_key,name,parent_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",
          [id, s.workspaceId, scope.bindingKey, plan.name, plan.parentId, s.id],
        );
      else
        await c.query(
          "UPDATE cw_departments SET name=$2,parent_id=$3,updated_at=clock_timestamp() WHERE id=$1",
          [id, plan.name, plan.parentId],
        );
      detail = { departmentId: id };
    } else if (plan.operation === "delete_department") {
      department(plan.departmentId);
      if (
        departments.some((d) => d.parent_id === plan.departmentId) ||
        (
          await c.query(
            "SELECT 1 FROM cw_department_people WHERE workspace_id=$1 AND binding_key=$2 AND department_id=$3 LIMIT 1",
            [s.workspaceId, scope.bindingKey, plan.departmentId],
          )
        ).rowCount
      )
        throw new ConflictException("请先移走子部门和成员，再删除空部门。");
      await c.query("DELETE FROM cw_departments WHERE id=$1", [
        plan.departmentId,
      ]);
      detail = { departmentId: plan.departmentId };
    } else if (plan.operation === "assign_department") {
      if (!scope.uids.includes(plan.uid))
        throw new NotFoundException("所选员工不在核验范围。");
      if (plan.departmentId) {
        department(plan.departmentId);
        await c.query(
          "INSERT INTO cw_department_people(workspace_id,binding_key,remote_uid,department_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,binding_key,remote_uid) DO UPDATE SET department_id=EXCLUDED.department_id",
          [s.workspaceId, scope.bindingKey, plan.uid, plan.departmentId],
        );
      } else
        await c.query(
          "DELETE FROM cw_department_people WHERE workspace_id=$1 AND binding_key=$2 AND remote_uid=$3",
          [s.workspaceId, scope.bindingKey, plan.uid],
        );
      detail = { uid: plan.uid, departmentId: plan.departmentId };
    } else if (plan.operation === "change_role") {
      if (plan.userId === s.id)
        throw new ForbiddenException("请由另一位管理员调整你的角色。");
      const member = (
        await c.query(
          "SELECT role,role_revision,membership_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
          [s.workspaceId, plan.userId],
        )
      ).rows[0];
      if (!member) throw new NotFoundException("员工已失去工作区成员资格。");
      if (
        member.role !== plan.expectedRole ||
        member.role_revision !== plan.expectedRoleRevision ||
        member.membership_id !== plan.expectedMembershipId
      )
        throw new ConflictException("员工角色已更新，请重新核对。");
      if (
        !s.demo &&
        !(
          await c.query(
            "SELECT user_id FROM cw_external_identities WHERE workspace_id=$1 AND provider_key=$2 AND user_id=$3 AND remote_uid=ANY($4::text[]) FOR SHARE",
            [
              s.workspaceId,
              scope.provider!.config.providerKey,
              plan.userId,
              scope.uids,
            ],
          )
        ).rowCount
      )
        throw new ForbiddenException("员工来源身份已失效。");
      if (plan.role === member.role)
        throw new BadRequestException("所选员工已经拥有此角色。");
      // The actor is a different, current administrator; another admin always remains.
      await c.query(
        "UPDATE cw_members SET role=$3,role_revision=role_revision+1 WHERE workspace_id=$1 AND user_id=$2",
        [s.workspaceId, plan.userId, plan.role],
      );
      detail = {
        userId: plan.userId,
        previousRole: member.role,
        role: plan.role,
        roleRevision: member.role_revision + 1,
      };
    }
    const receipt = {
      tool: "organization.manage",
      operation: plan.operation,
      revision: revision + 1,
      ...detail,
    };
    await c.query(
      "UPDATE cw_organization_states SET revision=revision+1 WHERE workspace_id=$1 AND binding_key=$2",
      [s.workspaceId, scope.bindingKey],
    );
    await c.query(
      "INSERT INTO cw_organization_changes(id,workspace_id,binding_key,actor_id,identity_credential_id,revision,operation,source_run_id,idempotency_key,input_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        randomUUID(),
        s.workspaceId,
        scope.bindingKey,
        s.id,
        s.identityCredentialId ?? null,
        revision + 1,
        plan.operation,
        runId ?? null,
        key,
        hash,
        receipt,
      ],
    );
    return receipt;
  }
  async save(s: Subject, raw: unknown, key: string) {
    const { plan, scope } = await this.prepare(s, raw);
    await this.recheck(s, scope);
    return this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      return this.apply(c, s, plan, scope, key);
    });
  }
}
