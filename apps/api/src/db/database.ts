import { Pool, type PoolClient } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export class Database {
  readonly pool: Pool;
  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error("DATABASE_URL is required. See .env.example.");
    this.pool = new Pool({ connectionString: url, max: 12 });
  }
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(246813579)");
      await c.query(
        "CREATE TABLE IF NOT EXISTS cw_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
      );
      const dir = new URL("../../../../db/migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        const done = await c.query(
          "SELECT name FROM cw_migrations WHERE name=$1",
          [name],
        );
        if (!done.rowCount) {
          await c.query(await readFile(new URL(name, dir), "utf8"));
          await c.query("INSERT INTO cw_migrations(name) VALUES($1)", [name]);
        }
      }
    });
  }
  async close() {
    await this.pool.end();
  }
}
export const DEMO = {
  workspace: "00000000-0000-4000-8000-000000000001",
  user: "00000000-0000-4000-8000-000000000011",
  other: "00000000-0000-4000-8000-000000000012",
  project: "00000000-0000-4000-8000-000000000101",
  conversation: "00000000-0000-4000-8000-000000000201",
};
export async function seedDemo(db: Database) {
  await db.tx(async (c) => {
    await c.query(
      "INSERT INTO cw_users(id,name) VALUES($1,$2),($3,$4) ON CONFLICT DO NOTHING",
      [DEMO.user, "林晓", DEMO.other, "陈远"],
    );
    await c.query(
      "INSERT INTO cw_workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [DEMO.workspace, "演示工作区"],
    );
    await c.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member') ON CONFLICT DO NOTHING",
      [DEMO.workspace, DEMO.user, DEMO.other],
    );
    for (const [offset, name, goal] of [
      [0, "产品共创", "跑通讨论到成果的协作流程。"],
      [1, "内容运营", "将内容讨论沉淀为可交付成果。"],
      [2, "团队事务", "让团队分工与工作进度保持清晰。"],
    ] as const) {
      const pid =
        "00000000-0000-4000-8000-" + String(101 + offset).padStart(12, "0");
      const cid =
        "00000000-0000-4000-8000-" + String(201 + offset).padStart(12, "0");
      await c.query(
        "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [pid, DEMO.workspace, name, goal],
      );
      await c.query(
        "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [cid, DEMO.workspace, pid],
      );
    }
    const present = await c.query(
      "SELECT id FROM cw_messages WHERE conversation_id=$1 LIMIT 1",
      [DEMO.conversation],
    );
    if (!present.rowCount) {
      for (const [author, aid, content] of [
        [
          "林晓",
          DEMO.user,
          "本周先把协作原型跑通，重点是讨论、待办和成果修改。",
        ],
        ["陈远", DEMO.other, "我负责接口契约，周五前完成第一版。"],
      ]) {
        await c.query(
          "INSERT INTO cw_messages(id,workspace_id,conversation_id,author_id,author,role,content,metadata) VALUES($1,$2,$3,$4,$5,'user',$6,$7)",
          [
            randomUUID(),
            DEMO.workspace,
            DEMO.conversation,
            aid,
            author,
            content,
            { evidence: "fixture" },
          ],
        );
      }
      const artifact = randomUUID();
      await c.query(
        "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,$4,$5)",
        [
          artifact,
          DEMO.workspace,
          DEMO.project,
          "协作原型 · 讨论纪要",
          DEMO.user,
        ],
      );
      await c.query(
        "INSERT INTO cw_artifact_versions(artifact_id,version,content,created_by) VALUES($1,1,$2,$3)",
        [
          artifact,
          "# 协作原型 · 讨论纪要\n\n- 接口契约由陈远负责。\n- 周五前完成第一版。\n\n> 演示资料，尚未连接企业数据。",
          DEMO.user,
        ],
      );
      await c.query(
        "INSERT INTO cw_messages(id,workspace_id,conversation_id,author,role,content,metadata) VALUES($1,$2,$3,'协作助手','assistant',$4,$5)",
        [
          randomUUID(),
          DEMO.workspace,
          DEMO.conversation,
          "已整理讨论要点，以下内容可继续修改。",
          { evidence: "fixture", artifactId: artifact },
        ],
      );
      for (const title of ["确认接口契约", "完成界面原型"])
        await c.query(
          "INSERT INTO cw_tasks(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), DEMO.workspace, DEMO.project, title, DEMO.user],
        );
      await c.query(
        "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_version,source_ref) VALUES($1,$2,$3,$4,$5,$6,'method','1','fixture:working-principles')",
        [
          randomUUID(),
          DEMO.workspace,
          DEMO.project,
          DEMO.user,
          "团队协作约定",
          "讨论应形成明确待办；成果支持反馈修改；事实与建议分别标记。",
        ],
      );
    }
  });
}
