import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import type { PoolClient } from "pg";
import { ProjectAccess } from "./project-access.js";
import { sourceConnection } from "./source-connection.js";
import { NextcloudTalkProvider } from "../providers/nextcloud-talk.js";
import { stableDigest } from "./credentials.js";
export interface DirectoryEntry {
  id: string | null;
  name: string;
  sourceUid: string | null;
  state: "available" | "unavailable";
  origin: "workspace" | "nextcloud-talk";
}
export interface AssignmentProof {
  workspaceId: string;
  projectId: string;
  userId: string;
  name: string;
  identityId: string | null;
  sourceUid: string | null;
  bindingHash: string;
}
export class DirectoryService {
  constructor(readonly db: Database) {}
  async read(s: Subject, projectId: string) {
    const access = new ProjectAccess(this.db);
    await access.assert(s, projectId);
    const binding = await access.binding(s, projectId);
    let rows: DirectoryEntry[];
    if (binding) {
      const connection = await sourceConnection(this.db, s);
      if (connection.config.providerKey !== binding.provider_key)
        throw new NotFoundException("项目成员来源不可访问。");
      const provider = new NextcloudTalkProvider(
        connection.config,
        connection.credentials,
        connection.remoteUid,
      );
      const participants = await provider.participants(
        binding.conversation_ref,
      );
      const mapped = (
        await this.db.pool.query(
          "SELECT x.remote_uid,u.id FROM cw_external_identities x JOIN cw_users u ON u.id=x.user_id JOIN cw_members m ON m.user_id=u.id AND m.workspace_id=x.workspace_id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.remote_uid=ANY($3::text[])",
          [s.workspaceId, binding.provider_key, participants.map((p) => p.uid)],
        )
      ).rows;
      const ids = new Map<string, string>(
        mapped.map((r) => [r.remote_uid, r.id]),
      );
      rows = participants.map((p) => ({
        id: ids.get(p.uid) ?? null,
        name: p.name,
        sourceUid: p.uid,
        state: ids.has(p.uid) ? "available" : "unavailable",
        origin: "nextcloud-talk",
      }));
    } else {
      const members = (
        await this.db.pool.query(
          "SELECT u.id,u.name FROM cw_members m JOIN cw_users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name,u.id LIMIT 2001",
          [s.workspaceId],
        )
      ).rows;
      if (members.length > 2000)
        throw new ServiceUnavailableException(
          "当前成员目录超过可处理上限，请缩小工作区或扩展分页。",
        );
      rows = members.map((m) => ({
        id: m.id,
        name: m.name,
        sourceUid: null,
        state: "available",
        origin: "workspace",
      }));
    }
    await access.assert(s, projectId);
    const finalBinding = await access.binding(s, projectId);
    if (stableDigest(finalBinding ?? null) !== stableDigest(binding ?? null))
      throw new ForbiddenException("成员目录来源已变化，请重新读取。");
    return {
      projectId,
      bindingHash: stableDigest(binding ?? null),
      checkedAt: new Date().toISOString(),
      scope: binding ? "current-source-participants" : "workspace-members",
      rows: rows.sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          (a.sourceUid ?? a.id ?? "").localeCompare(b.sourceUid ?? b.id ?? ""),
      ),
    };
  }
  async resolve(
    s: Subject,
    projectId: string,
    userId: string,
  ): Promise<AssignmentProof> {
    const view = await this.read(s, projectId),
      person = view.rows.find(
        (r) => r.id === userId && r.state === "available",
      );
    if (!person)
      throw new NotFoundException(
        "所选员工不在当前可分配范围；不根据姓名猜测身份。",
      );
    const binding = await new ProjectAccess(this.db).binding(s, projectId);
    if (stableDigest(binding ?? null) !== view.bindingHash)
      throw new ForbiddenException("成员目录来源已变化，请重新读取。");
    const identity = binding
      ? (
          await this.db.pool.query(
            "SELECT id FROM cw_external_identities WHERE workspace_id=$1 AND provider_key=$2 AND user_id=$3 AND remote_uid=$4",
            [s.workspaceId, binding.provider_key, userId, person.sourceUid],
          )
        ).rows[0]
      : null;
    if (binding && !identity)
      throw new ForbiddenException("员工身份映射已变化，请重新读取。");
    return {
      workspaceId: s.workspaceId,
      projectId,
      userId,
      name: person.name,
      identityId: identity?.id ?? null,
      sourceUid: person.sourceUid,
      bindingHash: view.bindingHash,
    };
  }
  static async validate(
    c: PoolClient,
    s: Subject,
    projectId: string,
    userId: string,
    proof: AssignmentProof | undefined,
  ) {
    if (
      !proof ||
      proof.userId !== userId ||
      proof.projectId !== projectId ||
      proof.workspaceId !== s.workspaceId
    )
      throw new ForbiddenException(
        "缺少当前员工范围核验，不接受模型提供的身份声明。",
      );
    const binding = (
      await c.query(
        "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2",
        [projectId, s.workspaceId],
      )
    ).rows[0];
    if (stableDigest(binding ?? null) !== proof.bindingHash)
      throw new ForbiddenException("项目成员来源已变化，请重新读取。");
    if (
      !(
        await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, userId],
        )
      ).rowCount
    )
      throw new ForbiddenException("员工已离开工作区，不能继续分配。");
    if (
      proof.identityId &&
      !(
        await c.query(
          "SELECT id FROM cw_external_identities WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND remote_uid=$4 FOR SHARE",
          [proof.identityId, s.workspaceId, userId, proof.sourceUid],
        )
      ).rowCount
    )
      throw new ForbiddenException("员工身份映射已失效。");
  }
}
