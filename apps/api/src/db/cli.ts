import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Database, seedDemo, DEMO } from "./database.js";
const db = new Database();
try {
  if (process.argv[2] === "migrate") {
    await db.migrate();
    console.log("Migrations applied.");
  } else if (process.argv[2] === "seed") {
    if (process.env.DEMO_MODE !== "true")
      throw new Error(
        "Set DEMO_MODE=true to create explicitly labelled sample data.",
      );
    await seedDemo(db);
    console.log("Demo data seeded. No company sources connected.");
  } else if (process.argv[2] === "workspace:init") {
    const id = z.uuid().parse(process.env.NEXTCLOUD_WORKSPACE_ID);
    if (id === DEMO.workspace)
      throw new Error(
        "Enterprise identity must use a separate workspace from demo data.",
      );
    const name = z
      .string()
      .trim()
      .min(1)
      .max(100)
      .parse(process.env.WORKSPACE_NAME);
    await db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(246813581)");
      await c.query(
        "INSERT INTO cw_workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, name],
      );
      if (
        !(
          await c.query(
            "SELECT id FROM cw_projects WHERE workspace_id=$1 LIMIT 1",
            [id],
          )
        ).rowCount
      ) {
        const projectId = randomUUID();
        await c.query(
          "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,'团队讨论','')",
          [projectId, id],
        );
        await c.query(
          "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
          [randomUUID(), id, projectId],
        );
      }
    });
    console.log(
      "Workspace initialized: " +
        id +
        ". No source data imported or roles changed.",
    );
  } else throw new Error("Expected migrate, seed or workspace:init");
} finally {
  await db.close();
}
