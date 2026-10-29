import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ArtifactReviewInput,
  ArtifactReviewPlan,
  type Subject,
} from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { lockArtifact } from "./artifacts.js";
import { stableDigest } from "./credentials.js";

function checkPlan(artifact: any, plan: ArtifactReviewPlan) {
  if (artifact.current_version !== plan.expectedVersion)
    throw new ConflictException("成果版本已变化，请重新读取后验收。");
  if (artifact.review_revision !== plan.expectedReviewRevision)
    throw new ConflictException("验收意见已变化，请刷新记录后操作。");
  if (plan.decision === "accept" && artifact.status === "accepted")
    throw new ConflictException("此版本已验收，请先核对已有记录。");
  if (plan.decision === "reopen" && artifact.status === "draft")
    throw new ConflictException("此版本已经是草稿。");
}
const receipt = (row: any) => ({
  tool: "artifact.review",
  id: row.id,
  artifactId: row.artifact_id,
  version: row.artifact_version,
  reviewRevision: row.review_revision,
  decision: row.decision,
  status: row.status_after,
  feedback: row.feedback,
  reviewerId: row.reviewer_id,
  reviewerAuthority: row.reviewer_authority,
  policyVersion: row.policy_version,
  confirmed: row.confirmed,
  channel: row.channel,
  sourceRunId: row.source_run_id,
  createdAt: row.created_at,
});

/** Employee confirmation is an explicit input, never an engine-generated quality verdict. */
export class ArtifactReviewService {
  constructor(readonly db: Database) {}
  async prepare(
    s: Subject,
    id: string,
    raw?: ArtifactReviewPlan,
    projectId?: string,
  ) {
    const role = await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        `SELECT id,project_id,created_by,current_version,status,review_revision,accepted_version
      FROM cw_artifacts WHERE id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR project_id=$3)`,
        [id, s.workspaceId, projectId ?? null],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("成果不存在或不在当前项目。");
    await new ProjectAccess(this.db).assert(s, row.project_id);
    const canReview = role === "admin" || row.created_by === s.id;
    if (raw) {
      if (!canReview)
        throw new ForbiddenException(
          "仅成果创建人或有项目访问权限的工作区管理员可验收。",
        );
      checkPlan(row, ArtifactReviewPlan.parse(raw));
    }
    return { ...row, canReview };
  }
  async record(s: Subject, id: string, raw: ArtifactReviewInput) {
    const input = ArtifactReviewInput.parse(raw);
    const { idempotencyKey, ...plan } = input;
    const scope = await this.prepare(s, id);
    const hash = stableDigest({ artifactId: id, ...plan });
    const old = (
      await this.db.pool.query(
        "SELECT * FROM cw_artifact_reviews WHERE workspace_id=$1 AND reviewer_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, idempotencyKey],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同验收意见。");
      return receipt(old);
    }
    if (!scope.canReview)
      throw new ForbiddenException(
        "仅成果创建人或有项目访问权限的工作区管理员可验收。",
      );
    checkPlan(scope, plan);
    return this.db.tx((c) =>
      ArtifactReviewService.apply(
        c,
        s,
        id,
        plan,
        scope.project_id,
        idempotencyKey,
      ),
    );
  }
  static async apply(
    c: PoolClient,
    s: Subject,
    id: string,
    raw: ArtifactReviewPlan,
    projectId: string,
    key: string,
    sourceRunId?: string,
  ) {
    const plan = ArtifactReviewPlan.parse(raw),
      hash = stableDigest({ artifactId: id, ...plan });
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "artifact-review:" + s.workspaceId + ":" + s.id + ":" + key,
    ]);
    const artifact = await lockArtifact(c, s, id, projectId);
    const member = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0];
    if (!member) throw new ForbiddenException("工作区权限已撤销。");
    const old = (
      await c.query(
        "SELECT * FROM cw_artifact_reviews WHERE workspace_id=$1 AND reviewer_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同验收意见。");
      return receipt(old);
    }
    if (member.role !== "admin" && artifact.created_by !== s.id)
      throw new ForbiddenException("当前主体没有成果验收权限。");
    checkPlan(artifact, plan);
    const status =
      plan.decision === "accept"
        ? "accepted"
        : plan.decision === "request_changes"
          ? "changes_requested"
          : "draft";
    const revision = artifact.review_revision + 1;
    const record = (
      await c.query(
        `INSERT INTO cw_artifact_reviews(id,artifact_id,workspace_id,artifact_version,review_revision,
      reviewer_id,reviewer_authority,identity_credential_id,decision,status_before,status_after,feedback,confirmed,channel,source_run_id,idempotency_key,input_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16) RETURNING *`,
        [
          randomUUID(),
          id,
          s.workspaceId,
          plan.expectedVersion,
          revision,
          s.id,
          artifact.created_by === s.id ? "creator" : "workspace_admin",
          s.identityCredentialId ?? null,
          plan.decision,
          artifact.status,
          status,
          plan.feedback,
          sourceRunId ? "ai_assisted" : "human",
          sourceRunId ?? null,
          key,
          hash,
        ],
      )
    ).rows[0];
    const updated = await c.query(
      `UPDATE cw_artifacts SET status=$2,review_revision=$3,accepted_version=$4
      WHERE id=$1 AND current_version=$5 RETURNING id`,
      [
        id,
        status,
        revision,
        status === "accepted" ? plan.expectedVersion : null,
        plan.expectedVersion,
      ],
    );
    if (!updated.rowCount)
      throw new ConflictException("成果版本已变化，未保存验收。");
    return receipt(record);
  }
}
