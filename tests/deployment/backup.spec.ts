import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../apps/api/src/core/credentials";
import {
  composeTransport,
  createWorkspaceBackup,
  restoreWorkspaceBackup,
} from "../../scripts/workspace-backup.mjs";

test("Compose PG17 backs up and independently restores encrypted product assets without replaying work or overwriting the active database", async () => {
  const source = "hyper_backup_compose_" + randomBytes(6).toString("hex"),
    dir = await mkdtemp(join(tmpdir(), "hyper-compose-backup-")),
    key = randomBytes(32).toString("hex"),
    transport = composeTransport({
      project: process.env.COMPOSE_TEST_PROJECT ?? "hyper-deployment-ci",
      envFile: process.env.COMPOSE_TEST_ENV ?? ".runtime/compose-ci.env",
      files: ["compose.yaml", "deploy/compose.ci.yaml"],
      database: source,
    });
  const names = await readdir("db/migrations"),
    workspace = randomUUID(),
    actor = randomUUID(),
    project = randomUUID(),
    conversation = randomUUID(),
    run = randomUUID(),
    profile = randomUUID();
  const q = (v: string) => "'" + v.replaceAll("'", "''") + "'";
  let created = false,
    restored: string | undefined;
  const before = await transport.run("psql", [
    "-XqAt",
    "--dbname",
    "hyper",
    "--command",
    "SELECT json_build_object('database',current_database(),'workspaces',(SELECT count(*) FROM cw_workspaces))",
  ]);
  try {
    await transport.run("createdb", [
      "--maintenance-db=postgres",
      "--template=template0",
      source,
    ]);
    created = true;
    const sql = [
      "SET client_min_messages=warning; BEGIN; CREATE TABLE cw_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now());",
    ];
    for (const name of names.filter((n) => n.endsWith(".sql")).sort())
      sql.push(
        await readFile(join("db/migrations", name), "utf8"),
        `INSERT INTO cw_migrations(name)VALUES(${q(name)});`,
      );
    sql.push(`INSERT INTO cw_workspaces(id,name)VALUES('${workspace}','Synthetic Compose archive');
      INSERT INTO cw_users(id,name)VALUES('${actor}','Synthetic restore employee');
      INSERT INTO cw_members(workspace_id,user_id,role)VALUES('${workspace}','${actor}','admin');
      INSERT INTO cw_projects(id,workspace_id,name,goal)VALUES('${project}','${workspace}','Synthetic archived project','Keep product-owned records');
      INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES('${conversation}','${workspace}','${project}');
      INSERT INTO cw_model_profiles(id,workspace_id,owner_id,name,provider,endpoint,model,purpose,credential_enc)VALUES('${profile}','${workspace}','${actor}','Synthetic backup model','openai-compatible','https://synthetic.invalid','synthetic','chat',${q(new Vault(key).encrypt("synthetic-backup-only-key"))});
      INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,state,demo)VALUES('${run}','${workspace}','${actor}','${conversation}','fixture','follow_up','Synthetic interrupted check','${randomUUID()}','synthetic-hash','running',true);
      CREATE SCHEMA hyper_jobs; CREATE TABLE hyper_jobs.synthetic_pending(id uuid); INSERT INTO hyper_jobs.synthetic_pending VALUES('${run}'); COMMIT;`);
    const input = join(dir, "synthetic-fixture.sql");
    await writeFile(input, sql.join("\n"), { mode: 0o600 });
    await transport.run(
      "psql",
      ["-XqAt", "--set=ON_ERROR_STOP=1", "--dbname", source],
      { input },
    );
    const backup = await createWorkspaceBackup(
      transport,
      join(dir, "backup"),
      key,
    );
    expect(backup.credentialChecks).toBe(1);
    const result = await restoreWorkspaceBackup(
      transport,
      join(dir, "backup"),
      key,
      join(dir, "restore.json"),
    );
    restored = result.database;
    expect(result.status).toBe("verified_isolated");
    expect(result.quarantine.recoveryRuns).toBe(1);
    expect(result.quarantine.queueAbsent).toBe(true);
    expect(result.servicesStarted).toBe(false);
    expect(result.productionPromoted).toBe(false);
    const sourceState = JSON.parse(
      await transport.run("psql", [
        "-XqAt",
        "--dbname",
        source,
        "--command",
        `SELECT json_build_object('state',state) FROM cw_runs WHERE id='${run}'`,
      ]),
    );
    expect(sourceState.state).toBe("running");
    const targetState = JSON.parse(
      await transport.run("psql", [
        "-XqAt",
        "--dbname",
        restored,
        "--command",
        `SELECT json_build_object('state',state) FROM cw_runs WHERE id='${run}'`,
      ]),
    );
    expect(targetState.state).toBe("recovery_required");
    expect(
      await transport.run("psql", [
        "-XqAt",
        "--dbname",
        "hyper",
        "--command",
        "SELECT json_build_object('database',current_database(),'workspaces',(SELECT count(*) FROM cw_workspaces))",
      ]),
    ).toBe(before);
  } finally {
    if (!restored) {
      try {
        restored = JSON.parse(
          await readFile(join(dir, "restore.json"), "utf8"),
        ).database;
      } catch {}
    }
    if (restored && /^hyper_restore_[a-f0-9]{16}$/.test(restored))
      await transport.run("psql", [
        "-XqAt",
        "--set=ON_ERROR_STOP=1",
        "--dbname",
        "postgres",
        "--command",
        `DROP DATABASE "${restored}"`,
      ]);
    if (created)
      await transport.run("psql", [
        "-XqAt",
        "--set=ON_ERROR_STOP=1",
        "--dbname",
        "postgres",
        "--command",
        `DROP DATABASE "${source}"`,
      ]);
    await rm(dir, { recursive: true, force: true });
  }
});
