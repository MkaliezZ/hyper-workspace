import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  chmod,
  rename,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkspaceBackup,
  verifyWorkspaceBackup,
  restoreWorkspaceBackup,
  localTransport,
} from "../scripts/workspace-backup.mjs";
const key = "ab".repeat(32);
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "hyper-backup-protocol-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const migrationNames = (await readdir("db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const calls: any[] = [];
  // Explicit process protocol fixture; actual archives and SQL run in integration/Compose tests.
  const transport = {
    database: "synthetic",
    kind: "protocol-fixture",
    run: async (name: string, args: string[], options: any = {}) => {
      calls.push({ name, args });
      if (args[0] === "--version") return name + " (PostgreSQL) 17.11";
      if (name === "pg_dump") {
        await writeFile(options.output, "synthetic archive protocol", {
          flag: "wx",
          mode: 0o600,
        });
        return "";
      }
      if (name === "pg_restore") return "";
      return args.at(-1)?.includes("foreignObjects")
        ? JSON.stringify({
            serverVersion: "170011",
            extensions: [{ name: "vector", version: "0.8.7" }],
            migrations: migrationNames,
            foreignObjects: false,
            invalidConstraints: false,
            invalidIndexes: false,
          })
        : "[]";
    },
  };
  return { dir, transport, calls };
}
test("Signed backup metadata rejects path changes and archive permissions before SQL access", async (t) => {
  const f = await fixture(t),
    dir = join(f.dir, "archive");
  await createWorkspaceBackup(f.transport, dir, key);
  assert.equal(
    (await verifyWorkspaceBackup(dir, key)).format,
    "hyper-workspace.database-backup.v1",
  );
  await chmod(join(dir, "workspace.dump"), 0o644);
  await assert.rejects(verifyWorkspaceBackup(dir, key), /其他账号/);
  await chmod(join(dir, "workspace.dump"), 0o600);
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  manifest.archive = "../../other.dump";
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  await assert.rejects(verifyWorkspaceBackup(dir, key), /清单无效/);
});
test("A symlink cannot substitute a verified backup archive", async (t) => {
  const f = await fixture(t),
    dir = join(f.dir, "archive");
  await createWorkspaceBackup(f.transport, dir, key);
  await rename(join(dir, "workspace.dump"), join(dir, "original.dump"));
  await symlink(join(dir, "original.dump"), join(dir, "workspace.dump"));
  await assert.rejects(verifyWorkspaceBackup(dir, key), /符号链接/);
});
test("Restore refuses an existing report before any target command and never overwrites the operator file", async (t) => {
  const f = await fixture(t),
    dir = join(f.dir, "archive"),
    report = join(f.dir, "report.json");
  await createWorkspaceBackup(f.transport, dir, key);
  await writeFile(report, "operator-owned-original", { mode: 0o600 });
  const before = f.calls.length;
  await assert.rejects(
    restoreWorkspaceBackup(f.transport, dir, key, report),
    /隔离恢复未完成/,
  );
  assert.equal(f.calls.length, before);
  assert.equal(await readFile(report, "utf8"), "operator-owned-original");
});
test("A failed isolated restore records only its own new target and never drops a database or starts services", async (t) => {
  const f = await fixture(t),
    dir = join(f.dir, "archive"),
    report = join(f.dir, "report.json");
  await createWorkspaceBackup(f.transport, dir, key);
  const prior = f.calls.length,
    transport = {
      ...f.transport,
      run: async (name: string, args: string[], options: any) => {
        if (name === "createdb") {
          f.calls.push({ name, args });
          return "";
        }
        if (name === "pg_restore" && args.includes("--dbname"))
          throw Error("synthetic-private-diagnostic-must-not-escape");
        return f.transport.run(name, args, options);
      },
    };
  await assert.rejects(
    restoreWorkspaceBackup(transport, dir, key, report),
    /诊断|没有覆盖原库/,
  );
  const value = JSON.parse(await readFile(report, "utf8"));
  assert.equal(value.status, "failed_isolated");
  assert.match(value.database, /^hyper_restore_[a-f0-9]{16}$/);
  assert.equal(value.productionPromoted, false);
  assert.ok(!JSON.stringify(value).includes("synthetic-private-diagnostic"));
  assert.ok(
    !f.calls
      .slice(prior)
      .some((c) => ["dropdb", "docker", "api", "worker"].includes(c.name)),
  );
});
test("Local PG clients receive explicit arguments and only PG connection credentials, while diagnostic content stays private", async (t) => {
  const f = await fixture(t),
    sentinel = process.env.UNRELATED_BACKUP_SENTINEL;
  const program = join(f.dir, "pg_dump");
  await writeFile(
    program,
    `#!${process.execPath}\nimport{writeFileSync}from'node:fs';import{dirname}from'node:path';writeFileSync(dirname(process.argv[1])+'/observed.json',JSON.stringify({args:process.argv.slice(2),pgPassword:process.env.PGPASSWORD,unrelated:process.env.UNRELATED_BACKUP_SENTINEL}),{mode:384});process.stderr.write('synthetic-secret-diagnostic');process.exit(1);\n`,
    { mode: 0o700 },
  );
  process.env.UNRELATED_BACKUP_SENTINEL = "unrelated-must-not-be-forwarded";
  try {
    const transport = localTransport(
      "postgres://synthetic:synthetic-password@127.0.0.1:5432/synthetic",
      { binDir: f.dir },
    );
    await assert.rejects(transport.run("pg_dump", ["--version"]), (e: any) => {
      assert.ok(!e.message.includes("synthetic-secret"));
      return true;
    });
    const observed = JSON.parse(
      await readFile(join(f.dir, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed.args, ["--version"]);
    assert.equal(observed.pgPassword, "synthetic-password");
    assert.equal(observed.unrelated, undefined);
  } finally {
    if (sentinel === undefined) delete process.env.UNRELATED_BACKUP_SENTINEL;
    else process.env.UNRELATED_BACKUP_SENTINEL = sentinel;
  }
  assert.throws(
    () =>
      localTransport(
        "postgres://synthetic@127.0.0.1/synthetic?options=-c%20something",
      ),
    /连接选项尚未支持/,
  );
});

test("Restore uses its private verified copy even if the original archive changes after verification", async (t) => {
  const f = await fixture(t),
    dir = join(f.dir, "archive"),
    report = join(f.dir, "report.json");
  await createWorkspaceBackup(f.transport, dir, key);
  let checked = false;
  const transport = {
    ...f.transport,
    run: async (name: string, args: string[], options: any) => {
      if (name === "pg_restore" && args[0] === "--version") {
        await writeFile(
          join(dir, "workspace.dump"),
          "changed-after-verification",
        );
        return "pg_restore (PostgreSQL) 17.11";
      }
      if (name === "createdb") return "";
      if (name === "pg_restore" && args.includes("--dbname")) {
        assert.notEqual(options.input, join(dir, "workspace.dump"));
        assert.equal(
          await readFile(options.input, "utf8"),
          "synthetic archive protocol",
        );
        checked = true;
        throw Error("synthetic stop after byte comparison");
      }
      return f.transport.run(name, args, options);
    },
  };
  await assert.rejects(
    restoreWorkspaceBackup(transport, dir, key, report),
    /隔离恢复未完成/,
  );
  assert.equal(checked, true);
});

test("Backup output and restore reports cannot be written into public repository paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createWorkspaceBackup(
      f.transport,
      resolve("untracked-enterprise-backup"),
      key,
    ),
    /仓库外/,
  );
  assert.equal(f.calls.length, 0);
  const directory = join(f.dir, "archive");
  await createWorkspaceBackup(f.transport, directory, key);
  const before = f.calls.length;
  await assert.rejects(
    restoreWorkspaceBackup(
      f.transport,
      directory,
      key,
      resolve("untracked-enterprise-restore.json"),
    ),
    /仓库外/,
  );
  assert.equal(f.calls.length, before);
});
