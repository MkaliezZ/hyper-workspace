import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { OrganizationService } from "../../apps/api/src/core/organization.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  await db.migrate();
});
after(() => db.close());
async function fixture() {
  const keys = [
    "NEXTCLOUD_URL",
    "NEXTCLOUD_INTERNAL_URL",
    "NEXTCLOUD_WORKSPACE_ID",
    "NEXTCLOUD_MEMBER_GROUP",
    "CREDENTIAL_MASTER_KEY",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const workspaceId = randomUUID(),
    members = new Set(["alice", "bob", "carol"]),
    seen: string[] = [];
  let onLabel: (() => void) | undefined;
  const server = createServer((req, res) => {
    const auth = Buffer.from(
      req.headers.authorization?.slice(6) ?? "",
      "base64",
    ).toString();
    seen.push(auth);
    const actor = auth.split(":")[0];
    if (!auth.endsWith(":synthetic-password")) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url!, "http://synthetic.invalid");
    let data: unknown;
    if (url.pathname === "/ocs/v2.php/cloud/user")
      data = { id: actor, displayname: "Employee " + actor, enabled: true };
    else if (url.pathname.endsWith("/groups"))
      data = {
        groups: members.has(actor!) ? [process.env.NEXTCLOUD_MEMBER_GROUP] : [],
      };
    else if (url.pathname.includes("/cloud/groups/"))
      data = { users: [...members] };
    else if (url.pathname === "/ocs/v2.php/core/autocomplete/get") {
      onLabel?.();
      const q = url.searchParams.get("search")!;
      data = [...members, "outside"]
        .filter((uid) => uid.includes(q) || q === "同名")
        .map((uid) => ({
          id: uid,
          label: uid === "alice" ? "当前管理员" : "同名员工",
          source: "users",
          subline: "private email",
        }));
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ocs: { meta: { statuscode: 100 }, data } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  Object.assign(process.env, {
    NEXTCLOUD_URL: base,
    NEXTCLOUD_INTERNAL_URL: base,
    NEXTCLOUD_WORKSPACE_ID: workspaceId,
    NEXTCLOUD_MEMBER_GROUP: "synthetic-staff",
    CREDENTIAL_MASTER_KEY: "cd".repeat(32),
  });
  const config = requireNextcloud();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic source directory')",
    [workspaceId],
  );
  const actors: Subject[] = [];
  for (const uid of ["alice", "bob"]) {
    const actor: Subject = {
        id: randomUUID(),
        workspaceId,
        name: "Untrusted cached name",
        role: uid === "alice" ? "admin" : "member",
        demo: false,
        identityCredentialId: randomUUID(),
      },
      identityId = randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      actor.id,
      actor.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, actor.id, actor.role],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identityId, config.providerKey, uid, actor.id, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [
        actor.identityCredentialId,
        identityId,
        uid,
        new Vault().encrypt("synthetic-password"),
      ],
    );
    actors.push(actor);
  }
  return {
    admin: actors[0]!,
    member: actors[1]!,
    members,
    seen,
    service: new OrganizationService(db),
    setOnLabel(fn: () => void) {
      onLabel = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const key of keys) {
        const old = original.get(key);
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      }
    },
  };
}
test("Source organization intersects current group, preserves exact UID identity and omits cached names, outsiders and private extras", async () => {
  const f = await fixture();
  try {
    const view = await f.service.read(f.member);
    assert.equal(view.origin, "nextcloud");
    assert.equal(view.sourceTotal, 3);
    const registered = view.rows.find((r) => r.uid === "bob")!,
      unregistered = view.rows.find((r) => r.uid === "carol")!;
    assert.equal(registered.id, f.member.id);
    assert.equal(unregistered.id, null);
    assert.equal(unregistered.role, null);
    assert.ok(!JSON.stringify(view).includes("Untrusted cached name"));
    assert.ok(!JSON.stringify(view).includes("private email"));
    const matches = await f.service.read(f.admin, { query: "同名" });
    assert.equal(matches.rows.length, 3);
    assert.ok(!matches.rows.some((r) => r.uid === "outside"));
    assert.ok(
      f.seen.every(
        (value) => value.startsWith("alice:") || value.startsWith("bob:"),
      ),
    );
  } finally {
    await f.close();
  }
});
test("Organization source rebinding invalidates old confirmations and does not reuse departments or employee relations", async () => {
  const f = await fixture();
  try {
    const view = await f.service.read(f.admin),
      plan = {
        operation: "create_department",
        bindingKey: view.bindingKey,
        name: "只属于旧来源",
        parentId: null,
        expectedRevision: 0,
        confirmed: true,
      };
    await f.service.save(f.admin, plan, randomUUID());
    process.env.NEXTCLOUD_MEMBER_GROUP = "another-configured-source-group";
    const changed = await f.service.read(f.admin);
    assert.notEqual(changed.bindingKey, view.bindingKey);
    assert.equal(changed.departments.length, 0);
    assert.equal(changed.revision, 0);
    await assert.rejects(
      f.service.save(f.admin, plan, randomUUID()),
      /来源已变化/,
    );
  } finally {
    await f.close();
  }
});
test("Membership changes during lookup reject the whole roster; source deprovision prevents product-admin cache reuse", async () => {
  const f = await fixture();
  try {
    f.setOnLabel(() => f.members.delete("bob"));
    await assert.rejects(f.service.read(f.admin), /成员范围已变化/);
    f.members.delete("alice");
    await assert.rejects(
      f.service.read({ ...f.admin, role: "admin" }),
      /成员资格已撤销/,
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
          [f.admin.workspaceId, f.admin.id],
        )
      ).rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});
