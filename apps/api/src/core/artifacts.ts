import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { ArtifactRevision, type Subject } from "@hyper/contracts";
import { refreshArtifactIndex } from "./knowledge.js";
export async function createProjectArtifact(
  c: PoolClient,
  s: Subject,
  projectId: string,
  input: { title: string; content: string },
  sourceIds: string[] = [],
) {
  const member = await c.query(
    "SELECT 1 FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    [s.workspaceId, s.id],
  );
  if (!member.rowCount) throw new ForbiddenException("工作区权限已撤销。");
  if (
    !(
      await c.query(
        "SELECT id FROM cw_projects WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE",
        [s.workspaceId, projectId],
      )
    ).rowCount
  )
    throw new NotFoundException("项目不可访问。");
  if (
    !input.title.trim() ||
    input.title.length > 300 ||
    !input.content.trim() ||
    input.content.length > 100000
  )
    throw new ConflictException("成果标题或正文超出允许范围。");
  const id = randomUUID();
  await c.query(
    "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by)VALUES($1,$2,$3,$4,$5)",
    [id, s.workspaceId, projectId, input.title, s.id],
  );
  await c.query(
    "INSERT INTO cw_artifact_versions(artifact_id,version,content,source_message_ids,created_by)VALUES($1,1,$2,$3,$4)",
    [id, input.content, JSON.stringify(sourceIds), s.id],
  );
  await c.query(
    "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_ref,source_version)VALUES($1,$2,$3,$4,$5,$6,'artifact',$7,'1')",
    [
      randomUUID(),
      s.workspaceId,
      projectId,
      s.id,
      input.title,
      input.content,
      "artifact:" + id,
    ],
  );
  return { id, title: input.title, version: 1 };
}
export async function lockArtifact(
  c: PoolClient,
  subject: Subject,
  id: string,
  projectId?: string,
) {
  const artifact = (
    await c.query(
      "SELECT id,project_id,created_by,current_version,status,review_revision,accepted_version FROM cw_artifacts WHERE id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR project_id=$3) FOR UPDATE",
      [id, subject.workspaceId, projectId ?? null],
    )
  ).rows[0];
  if (!artifact) throw new NotFoundException("成果不存在或不在本次授权项目。");
  return artifact;
}

/** One transaction path for human and AI revisions, including provenance. */
export async function reviseArtifactVersion(
  c: PoolClient,
  subject: Subject,
  id: string,
  raw: ArtifactRevision,
  projectId?: string,
  additionalSourceIds: string[] = [],
) {
  const input = ArtifactRevision.parse(raw);
  const artifact = await lockArtifact(c, subject, id, projectId);
  const member = await c.query(
    "SELECT 1 FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    [subject.workspaceId, subject.id],
  );
  if (!member.rowCount) throw new ForbiddenException("工作区权限已撤销。");
  if (artifact.current_version !== input.expectedVersion)
    throw new ConflictException("成果已更新，请刷新后再修改。");
  const previous = (
    await c.query(
      "SELECT source_message_ids FROM cw_artifact_versions WHERE artifact_id=$1 AND version=$2",
      [id, input.expectedVersion],
    )
  ).rows[0];
  if (!previous)
    throw new ConflictException("成果当前版本缺失，请先核对版本记录。");
  const version = input.expectedVersion + 1;
  await c.query(
    "INSERT INTO cw_artifact_versions(artifact_id,version,content,feedback,source_message_ids,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      version,
      input.content,
      input.feedback,
      JSON.stringify([
        ...new Set([
          ...(previous.source_message_ids as string[]),
          ...additionalSourceIds,
        ]),
      ]),
      subject.id,
    ],
  );
  await c.query(
    "UPDATE cw_artifacts SET current_version=$2,status='draft',accepted_version=NULL,review_revision=0 WHERE id=$1",
    [id, version],
  );
  await refreshArtifactIndex(
    c,
    subject.workspaceId,
    id,
    input.content,
    version,
  );
  return { id, version };
}
