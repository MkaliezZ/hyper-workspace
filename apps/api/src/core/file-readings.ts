import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { SourceFileService } from "./source-files.js";
export class ReadingVersionConflict extends ConflictException {
  constructor() {
    super("解读版本已变化，本次修改未覆盖更新内容；请重新读取后发起。");
  }
}
export class ReadingInputLimit extends BadRequestException {
  constructor() {
    super("文件与当前解读合计超过 100 KB，请先缩短已保存解读或拆分文件。");
  }
}
export class FileReadingService {
  constructor(private db: Database) {}
  private async target(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_file_readings WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND invalidated_at IS NULL",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("文件解读不存在或已失效。");
    await new SourceFileService(this.db).assertVersion(
      s,
      row.source_asset_id,
      row.source_version,
    );
    return row;
  }
  async list(s: Subject, assetId: string) {
    const file = await new SourceFileService(this.db).get(s, assetId);
    const rows = (
      await this.db.pool.query(
        `SELECT f.id,f.current_version AS version,f.created_at AS "createdAt",COALESCE(r.engine,'manual') AS engine
         FROM cw_file_readings f JOIN cw_file_reading_versions v ON v.reading_id=f.id AND v.version=f.current_version
         LEFT JOIN cw_runs r ON r.id=v.source_run_id AND r.workspace_id=f.workspace_id AND r.actor_id=f.actor_id
         AND r.source_file_asset_id=f.source_asset_id AND r.expected_file_version=f.source_version
         AND (r.workflow='read_file' OR (r.workflow='revise_file_reading' AND r.source_file_reading_id=f.id))
         WHERE f.source_asset_id=$1 AND f.source_version=$2 AND (v.source_run_id IS NULL OR r.id IS NOT NULL)
         AND f.workspace_id=$3 AND f.actor_id=$4 AND f.invalidated_at IS NULL ORDER BY f.created_at DESC,f.id LIMIT 20`,
        [assetId, file.sourceVersion, s.workspaceId, s.id],
      )
    ).rows;
    await new SourceFileService(this.db).assertVersion(
      s,
      assetId,
      file.sourceVersion,
    );
    const runs = (
      await this.db.pool.query(
        "SELECT id,state,engine FROM cw_runs WHERE source_file_asset_id=$1 AND expected_file_version=$2 AND workspace_id=$3 AND actor_id=$4 AND state IN ('queued','running') ORDER BY created_at DESC,id LIMIT 5",
        [assetId, file.sourceVersion, s.workspaceId, s.id],
      )
    ).rows;
    await new SourceFileService(this.db).assertVersion(
      s,
      assetId,
      file.sourceVersion,
    );
    return { readings: rows, runs };
  }
  async get(s: Subject, id: string) {
    const target = await this.target(s, id);
    const row = (
      await this.db.pool.query(
        `SELECT f.id,f.source_asset_id AS "assetId",f.source_version AS "sourceVersion",f.source_run_id AS "runId",f.current_version AS version,r.instruction AS question
         FROM cw_file_readings f JOIN cw_runs r ON r.id=f.source_run_id AND r.workspace_id=f.workspace_id AND r.actor_id=f.actor_id
         AND r.source_file_asset_id=f.source_asset_id AND r.expected_file_version=f.source_version AND r.workflow='read_file'
         WHERE f.id=$1 AND f.invalidated_at IS NULL`,
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("文件解读已失效。");
    const versions = (
      await this.db.pool.query(
        `SELECT v.version,v.content,v.created_at AS "createdAt",v.source_run_id AS "runId",r.engine,r.instruction AS feedback
         FROM cw_file_reading_versions v JOIN cw_file_readings f ON f.id=v.reading_id
         LEFT JOIN cw_runs r ON r.id=v.source_run_id AND r.workspace_id=f.workspace_id AND r.actor_id=f.actor_id
         AND r.source_file_asset_id=f.source_asset_id AND r.expected_file_version=f.source_version
         AND (r.workflow='read_file' OR (r.workflow='revise_file_reading' AND r.source_file_reading_id=f.id))
         WHERE v.reading_id=$1 AND v.version<=$2 ORDER BY v.version`,
        [id, row.version],
      )
    ).rows;
    await new SourceFileService(this.db).assertVersion(
      s,
      target.source_asset_id,
      target.source_version,
    );
    if (
      !versions.some((v) => v.version === row.version) ||
      versions.some((v) => v.runId && !v.engine) ||
      !(
        await this.db.pool.query(
          `SELECT id FROM cw_file_readings WHERE id=$1 AND workspace_id=$2 AND actor_id=$3
        AND source_asset_id=$4 AND source_version=$5 AND invalidated_at IS NULL`,
          [
            id,
            s.workspaceId,
            s.id,
            target.source_asset_id,
            target.source_version,
          ],
        )
      ).rowCount
    )
      throw new NotFoundException("文件解读或其执行记录已失效。");
    return {
      ...row,
      content: versions.find((v) => v.version === row.version)?.content,
      versions,
    };
  }
  /** Source asset lock precedes reading/run locks everywhere, including revocation. */
  static async lockSource(
    c: PoolClient,
    s: Subject,
    assetId: string,
    version: string,
  ) {
    const r = await c.query(
      "SELECT a.id FROM cw_assets a JOIN cw_source_files f ON f.asset_id=a.id WHERE a.id=$1 AND a.workspace_id=$2 AND a.owner_id=$3 AND f.actor_id=$3 AND f.workspace_id=$2 AND a.source_version=$4 AND a.validity='active' AND a.deleted_at IS NULL FOR SHARE OF a",
      [assetId, s.workspaceId, s.id, version],
    );
    if (!r.rowCount) throw new NotFoundException("文件已变化或无权读取。");
  }
  static async save(c: PoolClient, s: Subject, run: any, content: string) {
    if (run.workflow === "revise_file_reading") {
      const result = await FileReadingService.appendVersion(
        c,
        s,
        run.source_file_reading_id,
        {
          content,
          expectedVersion: run.expected_reading_version,
          assetId: run.source_file_asset_id,
          sourceVersion: run.expected_file_version,
          runId: run.id,
        },
      );
      return { tool: "file.reading.save", ...result };
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "file-reading:" + run.source_file_asset_id,
    ]);
    const count = (
      await c.query(
        "SELECT count(*) FROM cw_file_readings WHERE source_asset_id=$1",
        [run.source_file_asset_id],
      )
    ).rows[0];
    if (Number(count.count) >= 20)
      throw new BadRequestException("当前每个文件最多保留 20 条解读记录。");
    const id = randomUUID();
    await c.query(
      "INSERT INTO cw_file_readings(id,workspace_id,actor_id,source_asset_id,source_version,source_run_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        s.workspaceId,
        s.id,
        run.source_file_asset_id,
        run.expected_file_version,
        run.id,
      ],
    );
    await c.query(
      "INSERT INTO cw_file_reading_versions(reading_id,version,content,created_by,source_run_id) VALUES($1,1,$2,$3,$4)",
      [id, content, s.id, run.id],
    );
    return { tool: "file.reading.save", id, version: 1 };
  }
  private static async appendVersion(
    c: PoolClient,
    s: Subject,
    id: string,
    input: {
      content: string;
      expectedVersion: number;
      assetId: string;
      sourceVersion: string;
      runId?: string;
    },
  ) {
    const current = (
      await c.query(
        `SELECT current_version FROM cw_file_readings WHERE id=$1 AND workspace_id=$2 AND actor_id=$3
       AND source_asset_id=$4 AND source_version=$5 AND invalidated_at IS NULL FOR UPDATE`,
        [id, s.workspaceId, s.id, input.assetId, input.sourceVersion],
      )
    ).rows[0];
    if (!current) throw new NotFoundException("文件解读已失效。");
    if (current.current_version !== input.expectedVersion)
      throw new ReadingVersionConflict();
    if (current.current_version >= 10)
      throw new BadRequestException("当前每条解读最多保留 10 个版本。");
    const version = current.current_version + 1;
    await c.query(
      "INSERT INTO cw_file_reading_versions(reading_id,version,content,created_by,source_run_id) VALUES($1,$2,$3,$4,$5)",
      [id, version, input.content, s.id, input.runId ?? null],
    );
    await c.query(
      "UPDATE cw_file_readings SET current_version=$2,updated_at=clock_timestamp() WHERE id=$1",
      [id, version],
    );
    return { id, version };
  }
  async revise(
    s: Subject,
    id: string,
    input: { content: string; expectedVersion: number },
  ) {
    const row = await this.target(s, id);
    const result = await this.db.tx(async (c) => {
      await FileReadingService.lockSource(
        c,
        s,
        row.source_asset_id,
        row.source_version,
      );
      return FileReadingService.appendVersion(c, s, id, {
        ...input,
        assetId: row.source_asset_id,
        sourceVersion: row.source_version,
      });
    });
    await new SourceFileService(this.db).assertVersion(
      s,
      row.source_asset_id,
      row.source_version,
    );
    return result;
  }
}
