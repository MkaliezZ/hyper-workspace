import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { SourceFileService } from "./source-files.js";
import { ModelService, embed } from "./models.js";
import { MethodsService } from "./methods.js";

/** Text index v1: one vector per short asset. Source content remains authoritative. */
export class KnowledgeService {
  constructor(private db: Database) {}

  async index(s: Subject, ids: string[], modelProfileId?: string) {
    await assertMember(this.db, s);
    const visible = await new ProjectAccess(this.db).visibleIds(s);
    const files = new SourceFileService(this.db);
    const fileAccess = await files.verify(s, ids);
    const rows = (
      await this.db.pool.query(
        'SELECT id,title,content,source_version,source_version AS "sourceVersion",source_ref AS "sourceRef",project_id,EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) AS "fileSource" FROM cw_assets WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL AND validity=\'active\' AND (visibility=\'workspace\' OR owner_id=$3) AND (project_id IS NULL OR project_id=ANY($4::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) OR id=ANY($5::uuid[])) ORDER BY id',
        [ids, s.workspaceId, s.id, visible, [...fileAccess.allowed.keys()]],
      )
    ).rows;
    if (
      (await MethodsService.filterAssets(this.db, rows)).length !== rows.length
    )
      throw new NotFoundException(
        "方法未发布、已撤回或资产版本不一致，未发送给向量模型。",
      );
    if (rows.length !== new Set(ids).size)
      throw new NotFoundException("部分资料不存在或无权访问。");
    if (rows.some((row) => (row.title + "\n" + row.content).length > 20000))
      throw new BadRequestException(
        "当前索引只支持两万字符以内的文本；长文分块尚待实现。",
      );
    const connection = await new ModelService(this.db).resolve(
      s,
      "embedding",
      modelProfileId,
    );
    for (const projectId of new Set(
      rows.map((row) => row.project_id).filter(Boolean),
    ))
      await new ProjectAccess(this.db).assert(s, projectId);
    const dispatchAccess = await files.verify(s, ids);
    if (
      rows.some(
        (row) =>
          row.fileSource &&
          dispatchAccess.allowed.get(row.id) !== row.source_version,
      )
    )
      throw new NotFoundException(
        "文件已变化或来源权限无法确认，未发送给向量模型。",
      );
    const vectors = await embed(
      connection,
      rows.map((row) => row.title + "\n" + row.content),
    );
    await assertMember(this.db, s);
    const current = new Set(await new ProjectAccess(this.db).visibleIds(s));
    const afterEmbedding = await files.verify(s, ids);
    const indexed: string[] = [];
    for (const [i, row] of rows.entries()) {
      if (row.project_id && !current.has(row.project_id)) continue;
      if (
        row.fileSource &&
        afterEmbedding.allowed.get(row.id) !== row.source_version
      )
        continue;
      const result = await this.db.pool.query(
        "UPDATE cw_assets SET embedding=$1::vector,embedding_profile_id=$2,embedding_model=$3,embedding_dimensions=$4,embedding_source_version=source_version,embedding_version='text-v1',indexed_at=clock_timestamp() WHERE id=$5 AND workspace_id=$6 AND source_version=$7 AND deleted_at IS NULL AND validity='active' AND (visibility='workspace' OR owner_id=$8) AND (NOT EXISTS(SELECT 1 FROM cw_methods m WHERE m.id=cw_assets.id) OR EXISTS(SELECT 1 FROM cw_methods m WHERE m.id=cw_assets.id AND m.state='published' AND m.workspace_id=cw_assets.workspace_id AND m.project_id=cw_assets.project_id AND m.current_version::text||':'||m.revision::text=cw_assets.source_version)) AND EXISTS(SELECT 1 FROM cw_members WHERE workspace_id=$6 AND user_id=$8) RETURNING id",
        [
          JSON.stringify(vectors[i]),
          connection.id,
          connection.model,
          vectors[i]!.length,
          row.id,
          s.workspaceId,
          row.source_version,
          s.id,
        ],
      );
      if (result.rowCount) indexed.push(row.id);
    }
    return {
      indexed,
      skipped: ids.filter((id) => !indexed.includes(id)),
      modelProfileId: connection.id,
      indexVersion: "text-v1",
    };
  }

  async semantic(s: Subject, query: string, modelProfileId?: string) {
    await assertMember(this.db, s);
    const connection = await new ModelService(this.db).resolve(
      s,
      "embedding",
      modelProfileId,
    );
    const vector = (await embed(connection, [query]))[0]!;
    await assertMember(this.db, s);
    const visible = await new ProjectAccess(this.db).visibleIds(s);
    const files = new SourceFileService(this.db),
      fileAccess = await files.verify(s);
    const result = await this.db.pool.query(
      "SELECT id,title,content,type,project_id,EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) AS \"fileSource\",source_ref AS \"sourceRef\",source_version AS \"sourceVersion\",1-(embedding <=> $1::vector) AS similarity FROM cw_assets WHERE workspace_id=$2 AND deleted_at IS NULL AND validity='active' AND (visibility='workspace' OR owner_id=$3) AND (project_id IS NULL OR project_id=ANY($6::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) OR id=ANY($7::uuid[])) AND embedding_profile_id=$4 AND embedding_dimensions=$5 AND embedding_source_version=source_version AND embedding_version='text-v1' AND embedding IS NOT NULL ORDER BY embedding <=> $1::vector,id LIMIT 30",
      [
        JSON.stringify(vector),
        s.workspaceId,
        s.id,
        connection.id,
        vector.length,
        visible,
        [...fileAccess.allowed.keys()],
      ],
    );
    const current = new Set(await new ProjectAccess(this.db).visibleIds(s));
    const finalFiles = await files.verify(
      s,
      result.rows.filter((row) => row.fileSource).map((row) => row.id),
    );
    return (await MethodsService.filterAssets(this.db, result.rows))
      .filter((row) => !row.project_id || current.has(row.project_id))
      .filter(
        (row) =>
          !row.fileSource ||
          finalFiles.allowed.get(row.id) === row.sourceVersion,
      )
      .map(({ project_id, fileSource, ...row }) => row);
  }
}

export async function refreshArtifactIndex(
  c: PoolClient,
  workspaceId: string,
  id: string,
  content: string,
  version: number,
) {
  await c.query(
    "UPDATE cw_assets SET content=$1,source_version=$2,updated_at=clock_timestamp(),embedding=NULL,embedding_profile_id=NULL,embedding_dimensions=NULL,embedding_source_version=NULL,embedding_model=NULL,embedding_version=NULL,indexed_at=NULL WHERE workspace_id=$3 AND source_ref=$4 AND deleted_at IS NULL",
    [content, String(version), workspaceId, "artifact:" + id],
  );
}
