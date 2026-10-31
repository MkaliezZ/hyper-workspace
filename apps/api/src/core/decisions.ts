import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DecisionDraft,
  DecisionMutation,
  DecisionPlan,
  DecisionSourceRefs,
  type DecisionReceipt,
  type Subject,
  type CommunicationMessage,
} from "@hyper/contracts";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { digest, stableDigest } from "./credentials.js";
import { ProjectAccess } from "./project-access.js";
import { assertMember } from "./security.js";
import { sourceConnection } from "./source-connection.js";
import { NextcloudTalkProvider } from "../providers/nextcloud-talk.js";
type Proof = {
  projectId: string;
  binding: string;
  planHash: string;
  sourceRefs: string[];
};
const writing = (plan: DecisionPlan) =>
  ["create", "revise"].includes(plan.operation);
const refs = (raw: unknown) =>
  [...new Set(DecisionSourceRefs.parse(raw))].sort();
const bindingKey = (row: any) =>
  row ? row.provider_key + "\n" + row.conversation_ref : "";
const sourceContent = (m: CommunicationMessage) =>
  m.content +
  (m.attachments?.length
    ? "\n[附件引用；未读取正文，不得据文件名推断内容] " +
      JSON.stringify(
        m.attachments.map(({ id, name, mime, etag }) => ({
          id,
          name,
          mime,
          etag,
        })),
      )
    : "");
const savedDraft = (snapshot: any) =>
  DecisionDraft.parse({
    title: snapshot.title,
    content: snapshot.content,
    rationale: snapshot.rationale,
    links: snapshot.links,
  });
const inputHash = (
  projectId: string,
  plan: DecisionPlan,
  draft: DecisionDraft | undefined,
  selected: string[],
) =>
  stableDigest({
    projectId,
    plan,
    draft,
    sourceRefs: writing(plan) ? refs(selected) : [],
  });
export class DecisionService {
  readonly access: ProjectAccess;
  constructor(readonly db: Database) {
    this.access = new ProjectAccess(db);
  }
  private async row(
    s: Subject,
    id: string,
    projectId?: string,
    c?: PoolClient,
  ) {
    const row = (
      await (c ?? this.db.pool).query(
        "SELECT d.*,v.snapshot,v.source_refs FROM cw_decisions d JOIN cw_decision_versions v ON v.decision_id=d.id AND v.version=d.current_version WHERE d.id=$1 AND d.workspace_id=$2 AND ($3::uuid IS NULL OR d.project_id=$3)" +
          (c ? " FOR UPDATE OF d" : ""),
        [id, s.workspaceId, projectId ?? null],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("决定不存在或不在当前项目。");
    return row;
  }
  private mayManage(row: any, s: Subject, role: string) {
    if (row.created_by !== s.id && role !== "admin")
      throw new ForbiddenException(
        "仅创建人或有项目权限的工作区管理员可修改决定。",
      );
  }
  private check(
    row: any,
    plan: Exclude<DecisionPlan, { operation: "create" }>,
  ) {
    if (row.current_version !== plan.expectedVersion)
      throw new ConflictException("决定版本已变化，请重新读取后操作。");
    if (
      ["revise", "confirm"].includes(plan.operation) &&
      row.state !== "proposed"
    )
      throw new ConflictException(
        "仅待确认提议可修改或确认；已确认决定请创建替代提议。",
      );
    if (
      plan.operation === "withdraw" &&
      !["proposed", "confirmed"].includes(row.state)
    )
      throw new ConflictException("此决定已撤回或已被替代。");
  }
  /** Verify exact references, including messages outside the latest page; absence is never called proof of deletion. */
  async references(s: Subject, projectId: string, selected: string[]) {
    if (!selected.length) return true;
    const binding = await this.access.binding(s, projectId),
      local = selected
        .map((ref) => /^message:([0-9a-f-]{36})@([a-f0-9]{64})$/.exec(ref))
        .filter(
          (value): value is RegExpExecArray =>
            !!value && z.uuid().safeParse(value[1]).success,
        );
    const rows = (
      await this.db.pool.query(
        "SELECT m.id,m.content FROM cw_messages m JOIN cw_conversations c ON c.id=m.conversation_id WHERE m.workspace_id=$1 AND c.project_id=$2 AND m.id=ANY($3::uuid[])",
        [s.workspaceId, projectId, local.map((match) => match[1])],
      )
    ).rows;
    const existing = new Set(
      rows.map((row) => "message:" + row.id + "@" + digest(row.content)),
    );
    const remote = selected.filter((r) => !existing.has(r));
    if (!remote.length) return true;
    if (!binding) return false;
    const current = await this.access.sourceMessages(s, projectId),
      seen = new Set(current.map((m) => m.id));
    const pending = remote.filter((r) => !seen.has(r));
    if (!pending.length) return true;
    const prefix =
      "talk:" + binding.provider_key + ":" + binding.conversation_ref + ":";
    if (
      pending.some(
        (r) =>
          !r.startsWith(prefix) ||
          !/^([1-9]\d{0,15})@(\d+):([a-f0-9]{64})$/.test(
            r.slice(prefix.length),
          ),
      )
    )
      return false;
    const source = await sourceConnection(this.db, s);
    if (source.config.providerKey !== binding.provider_key) return false;
    const provider = new NextcloudTalkProvider(
      source.config,
      source.credentials,
      source.remoteUid,
    );
    for (let i = 0; i < pending.length; i += 4) {
      const found = await Promise.all(
        pending.slice(i, i + 4).map(async (ref) => {
          const match = /^([1-9]\d{0,15})@(\d+):([a-f0-9]{64})$/.exec(
            ref.slice(prefix.length),
          )!;
          const message = await provider.find(
            binding.conversation_ref,
            match[1]!,
          );
          return (
            !!message &&
            message.kind === "comment" &&
            (!message.expiresAt ||
              Date.parse(message.expiresAt) > Date.now()) &&
            message.version === match[2] &&
            digest(sourceContent(message)) === match[3]
          );
        }),
      );
      if (found.some((value) => !value)) return false;
    }
    return true;
  }
  async sources(s: Subject, projectId: string) {
    await this.access.assert(s, projectId);
    const local = (
      await this.db.pool.query(
        "SELECT m.id,m.author,m.role,m.content FROM cw_messages m JOIN cw_conversations c ON c.id=m.conversation_id WHERE m.workspace_id=$1 AND c.project_id=$2 ORDER BY m.position DESC LIMIT 60",
        [s.workspaceId, projectId],
      )
    ).rows.reverse();
    const remote = await this.access.sourceMessages(s, projectId);
    await this.access.assert(s, projectId);
    return [
      ...local.map((row) => ({
        id: "message:" + row.id + "@" + digest(row.content),
        author: row.author,
        kind: row.role === "assistant" ? "AI draft" : "employee statement",
        content: row.content,
      })),
      ...remote.map((row) => ({
        id: row.id,
        author: row.author,
        kind: "source statement",
        content: row.content,
      })),
    ];
  }
  private async links(
    c: PoolClient | Database["pool"],
    s: Subject,
    projectId: string,
    draft: DecisionDraft,
  ) {
    const seen = new Set<string>();
    for (const link of draft.links) {
      const key = link.kind + ":" + link.id;
      if (seen.has(key)) throw new BadRequestException("决定关系不能重复。");
      seen.add(key);
      const sql =
        link.kind === "task"
          ? "SELECT id,version FROM cw_tasks"
          : "SELECT id,current_version AS version FROM cw_artifacts";
      const row = (
        await c.query(
          sql +
            " WHERE id=$1 AND workspace_id=$2 AND project_id=$3" +
            ("release" in c ? " FOR SHARE" : ""),
          [link.id, s.workspaceId, projectId],
        )
      ).rows[0];
      if (!row || row.version !== link.version)
        throw new ConflictException(
          "关联待办或成果不在当前项目，或版本已变化。",
        );
    }
  }
  async prepare(
    s: Subject,
    projectId: string,
    raw: DecisionPlan,
    selected: string[] = [],
  ): Promise<Proof> {
    const plan = DecisionPlan.parse(raw);
    await this.access.assert(s, projectId);
    const role = await assertMember(this.db, s);
    let selectedRefs = writing(plan) ? refs(selected) : [];
    if (plan.operation !== "create") {
      const row = await this.row(s, plan.decisionId, projectId);
      this.mayManage(row, s, role);
      this.check(row, plan);
      if (plan.operation === "confirm") {
        selectedRefs = refs(row.source_refs);
        await this.links(this.db.pool, s, projectId, savedDraft(row.snapshot));
        if (plan.supersedes) {
          if (plan.supersedes.id === row.id)
            throw new BadRequestException("决定不能替代自己。");
          const old = await this.row(s, plan.supersedes.id, projectId);
          this.mayManage(old, s, role);
          if (
            old.state !== "confirmed" ||
            old.current_version !== plan.supersedes.version
          )
            throw new ConflictException("被替代决定的当前状态或版本已变化。");
        }
      }
    }
    if (!(await this.references(s, projectId, selectedRefs)))
      throw new ConflictException(
        "提议依据当前不可核验，请重新读取或明确修改内容与来源。",
      );
    return {
      projectId,
      binding: bindingKey(await this.access.binding(s, projectId)),
      planHash: stableDigest(plan),
      sourceRefs: selectedRefs,
    };
  }
  private async guard(
    c: PoolClient,
    s: Subject,
    projectId: string,
    proof: Proof,
  ) {
    const member = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0];
    if (!member) throw new ForbiddenException("工作区权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [projectId, s.workspaceId],
        )
      ).rowCount
    )
      throw new NotFoundException("项目不可用。");
    const binding = (
      await c.query(
        "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2 FOR SHARE",
        [projectId, s.workspaceId],
      )
    ).rows[0];
    if (proof.projectId !== projectId || proof.binding !== bindingKey(binding))
      throw new ConflictException("决定项目来源已变化。");
    if (
      s.identityCredentialId &&
      !(
        await c.query(
          "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i",
          [s.identityCredentialId, s.id, s.workspaceId],
        )
      ).rowCount
    )
      throw new ForbiddenException("来源凭据已撤销。");
    return member.role as string;
  }
  private async saveVersion(
    c: PoolClient,
    s: Subject,
    row: any,
    draft: DecisionDraft,
    selected: string[],
    sourceRunId?: string,
  ) {
    const snapshot = {
      ...draft,
      state: row.state,
      confirmedBy: row.confirmed_by ?? null,
      confirmedAt: row.confirmed_at ?? null,
      supersedesId: row.supersedes_id ?? null,
      supersededBy: row.superseded_by ?? null,
    };
    await c.query(
      "INSERT INTO cw_decision_versions(decision_id,version,snapshot,source_refs,actor_id,identity_credential_id,source_run_id,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        row.id,
        row.current_version,
        JSON.stringify(snapshot),
        JSON.stringify(selected),
        s.id,
        s.identityCredentialId ?? null,
        sourceRunId ?? null,
        sourceRunId ? "ai_assisted" : "human",
      ],
    );
    await c.query(
      "DELETE FROM cw_asset_links WHERE workspace_id=$1 AND from_id=$2 AND relation IN ('decision-task','decision-artifact')",
      [s.workspaceId, row.id],
    );
    for (const link of draft.links)
      await c.query(
        "INSERT INTO cw_asset_links(id,workspace_id,from_id,to_id,relation,source_version) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          s.workspaceId,
          row.id,
          link.id,
          "decision-" + link.kind,
          String(row.current_version),
        ],
      );
  }
  async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: DecisionPlan,
    rawDraft: DecisionDraft | undefined,
    proof: Proof,
    key: string,
    sourceRunId?: string,
  ): Promise<DecisionReceipt> {
    const plan = DecisionPlan.parse(raw),
      draft = rawDraft ? DecisionDraft.parse(rawDraft) : undefined;
    if (writing(plan) !== !!draft)
      throw new BadRequestException("决定内容与操作不匹配。");
    if (proof.planHash !== stableDigest(plan))
      throw new ConflictException("决定操作与已检查目标不符。");
    const hash = inputHash(projectId, plan, draft, proof.sourceRefs);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "decision:" + s.workspaceId + ":" + s.id + ":" + key,
    ]);
    const role = await this.guard(c, s, projectId, proof);
    const prior = (
      await c.query(
        "SELECT * FROM cw_decision_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.params_hash !== hash)
        throw new ConflictException("相同幂等键不能更换决定操作。");
      return prior.result;
    }
    let row: any,
      content: DecisionDraft,
      selected: string[],
      superseded: DecisionReceipt["superseded"];
    if (plan.operation === "create") {
      content = draft!;
      selected = proof.sourceRefs;
      await this.links(c, s, projectId, content);
      row = (
        await c.query(
          "INSERT INTO cw_decisions(id,workspace_id,project_id,created_by,state) VALUES($1,$2,$3,$4,'proposed') RETURNING *",
          [randomUUID(), s.workspaceId, projectId, s.id],
        )
      ).rows[0];
    } else {
      const old = await this.row(s, plan.decisionId, projectId, c);
      this.mayManage(old, s, role);
      this.check(old, plan);
      content = draft ?? savedDraft(old.snapshot);
      selected =
        plan.operation === "revise" ? proof.sourceRefs : refs(old.source_refs);
      if (plan.operation !== "withdraw")
        await this.links(c, s, projectId, content);
      if (
        plan.operation === "confirm" &&
        stableDigest(selected) !== stableDigest(proof.sourceRefs)
      )
        throw new ConflictException("提议依据已变化。");
      if (plan.operation === "confirm" && plan.supersedes) {
        if (plan.supersedes.id === old.id)
          throw new BadRequestException("决定不能替代自己。");
        const previous = await this.row(s, plan.supersedes.id, projectId, c);
        this.mayManage(previous, s, role);
        if (
          previous.state !== "confirmed" ||
          previous.current_version !== plan.supersedes.version
        )
          throw new ConflictException("被替代决定已变化。");
        const updated = (
          await c.query(
            "UPDATE cw_decisions SET state='superseded',current_version=current_version+1,superseded_by=$2,updated_at=now() WHERE id=$1 RETURNING *",
            [previous.id, old.id],
          )
        ).rows[0];
        await this.saveVersion(
          c,
          s,
          updated,
          savedDraft(previous.snapshot),
          refs(previous.source_refs),
          sourceRunId,
        );
        superseded = { id: updated.id, version: updated.current_version };
      }
      const state =
        plan.operation === "confirm"
          ? "confirmed"
          : plan.operation === "withdraw"
            ? "withdrawn"
            : "proposed";
      row = (
        await c.query(
          "UPDATE cw_decisions SET state=$2,current_version=current_version+1,confirmed_by=CASE WHEN $3 THEN $4 ELSE confirmed_by END,confirmed_at=CASE WHEN $3 THEN now() ELSE confirmed_at END,supersedes_id=COALESCE($5,supersedes_id),updated_at=now() WHERE id=$1 RETURNING *",
          [
            old.id,
            state,
            plan.operation === "confirm",
            s.id,
            plan.operation === "confirm" ? (plan.supersedes?.id ?? null) : null,
          ],
        )
      ).rows[0];
    }
    await this.saveVersion(c, s, row, content, selected, sourceRunId);
    const result: DecisionReceipt = {
      tool: writing(plan) ? "decision.write" : "decision.manage",
      id: row.id,
      version: row.current_version,
      state: row.state,
      sourceRunId: sourceRunId ?? null,
      ...(superseded ? { superseded } : {}),
    };
    await c.query(
      "INSERT INTO cw_decision_actions(id,workspace_id,project_id,actor_id,idempotency_key,params_hash,result,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        s.workspaceId,
        projectId,
        s.id,
        key,
        hash,
        JSON.stringify(result),
        sourceRunId ?? null,
      ],
    );
    return result;
  }
  async mutate(s: Subject, projectId: string, raw: DecisionMutation) {
    const input = DecisionMutation.parse(raw);
    if (!writing(input.plan) && input.sourceRefs.length)
      throw new BadRequestException("管理操作不能修改决定来源。");
    await this.access.assert(s, projectId);
    const previous = (
      await this.db.pool.query(
        "SELECT * FROM cw_decision_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.params_hash !==
        inputHash(projectId, input.plan, input.draft, input.sourceRefs)
      )
        throw new ConflictException("相同幂等键不能更换决定操作。");
      return previous.result as DecisionReceipt;
    }
    const proof = await this.prepare(
      s,
      projectId,
      input.plan,
      input.sourceRefs,
    );
    return this.db.tx((c) =>
      this.apply(
        c,
        s,
        projectId,
        input.plan,
        input.draft,
        proof,
        input.idempotencyKey,
      ),
    );
  }
  private async visibleVersion(s: Subject, projectId: string, row: any) {
    const snapshot = row.snapshot;
    const available =
      !row.source_refs.length ||
      (await this.references(s, projectId, refs(row.source_refs)));
    const retained = !!snapshot.confirmedBy || available;
    return {
      version: row.version,
      state: snapshot.state,
      title: retained ? snapshot.title : "依据当前不可核验的提议",
      content: retained ? snapshot.content : null,
      rationale: retained ? snapshot.rationale : null,
      links: retained ? snapshot.links : [],
      confirmedBy: snapshot.confirmedBy,
      confirmedAt: snapshot.confirmedAt,
      supersedesId: snapshot.supersedesId,
      supersededBy: snapshot.supersededBy,
      sourceRefs: row.source_refs,
      basisAvailable: available,
      actorId: row.actor_id,
      sourceRunId: row.source_run_id,
      channel: row.channel,
      createdAt: row.created_at,
    };
  }
  async get(
    s: Subject,
    id: string,
    projectId?: string,
    beforeVersion?: number,
  ) {
    const row = await this.row(s, id, projectId);
    await this.access.assert(s, row.project_id);
    const history = (
      await this.db.pool.query(
        "SELECT * FROM cw_decision_versions WHERE decision_id=$1 AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT 21",
        [id, beforeVersion ?? null],
      )
    ).rows;
    const current = (
      await this.db.pool.query(
        "SELECT * FROM cw_decision_versions WHERE decision_id=$1 AND version=$2",
        [id, row.current_version],
      )
    ).rows[0];
    const versions = [];
    for (const version of history.slice(0, 20))
      versions.push(await this.visibleVersion(s, row.project_id, version));
    const visible = await this.visibleVersion(s, row.project_id, current),
      role = await assertMember(this.db, s);
    await this.access.assert(s, row.project_id);
    return {
      id,
      projectId: row.project_id,
      createdBy: row.created_by,
      canManage: row.created_by === s.id || role === "admin",
      current: visible,
      history: versions,
      beforeVersion: history.length > 20 ? versions.at(-1)!.version : null,
    };
  }
  async list(s: Subject, projectId: string) {
    await this.access.assert(s, projectId);
    const role = await assertMember(this.db, s);
    const rows = (
      await this.db.pool.query(
        "SELECT d.*,v.snapshot,v.source_refs FROM cw_decisions d JOIN cw_decision_versions v ON v.decision_id=d.id AND v.version=d.current_version WHERE d.workspace_id=$1 AND d.project_id=$2 ORDER BY d.updated_at DESC,d.id LIMIT 100",
        [s.workspaceId, projectId],
      )
    ).rows;
    const checked = new Map<string, Promise<boolean>>();
    const result = [];
    for (const row of rows) {
      let available: boolean | null = null;
      if (!row.snapshot.confirmedBy) {
        const key = stableDigest(row.source_refs);
        if (!checked.has(key))
          checked.set(
            key,
            this.references(s, projectId, refs(row.source_refs)),
          );
        available = await checked.get(key)!;
      }
      result.push({
        id: row.id,
        projectId,
        createdBy: row.created_by,
        canManage: row.created_by === s.id || role === "admin",
        version: row.current_version,
        state: row.state,
        title:
          row.snapshot.confirmedBy || available
            ? row.snapshot.title
            : "依据当前不可核验的提议",
        basisAvailable: available,
        confirmedBy: row.confirmed_by,
        supersededBy: row.superseded_by,
      });
    }
    await this.access.assert(s, projectId);
    return result;
  }
  async current(s: Subject, projectId: string) {
    await this.access.assert(s, projectId);
    const rows = (
      await this.db.pool.query(
        "SELECT d.id,d.current_version AS version,d.confirmed_by AS \"confirmedBy\",v.snapshot FROM cw_decisions d JOIN cw_decision_versions v ON v.decision_id=d.id AND v.version=d.current_version WHERE d.workspace_id=$1 AND d.project_id=$2 AND d.state='confirmed' ORDER BY d.updated_at DESC,d.id LIMIT 20",
        [s.workspaceId, projectId],
      )
    ).rows;
    await this.access.assert(s, projectId);
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      confirmedBy: row.confirmedBy,
      ...savedDraft(row.snapshot),
      reference: "decision:" + row.id + "@" + row.version,
      basisStatus: "employee_record_source_not_revalidated",
    }));
  }
}
