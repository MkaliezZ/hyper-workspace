import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { IdentityService } from "../../apps/api/src/core/identity.js";
import {
  authenticate,
  assertMember,
} from "../../apps/api/src/core/security.js";
import {
  requireNextcloud,
  NextcloudIdentityProvider,
} from "../../apps/api/src/providers/nextcloud.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import type { EngineAdapter } from "@hyper/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use an isolated TEST_DATABASE_URL ending in _test.");
const db = new Database(url),
  identity = new IdentityService(db),
  workspaceId = randomUUID();
interface Remote {
  uid: string;
  name: string;
  groups: string[];
  devices: Set<string>;
  outage?: boolean;
}
const users = new Map<string, Remote>(),
  flows = new Map<string, { credentials: unknown; polls: number }>();
let base = "",
  planned: { loginName: string; appPassword: string; server?: string },
  malicious = false;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url === "/nc/index.php/login/v2") {
    const token = randomUUID().replaceAll("-", "");
    flows.set(token, {
      credentials: { ...planned, server: planned.server ?? base },
      polls: 0,
    });
    res.end(
      JSON.stringify({
        login:
          (malicious ? "https://attacker.invalid" : base) +
          "/index.php/login/v2/flow/" +
          token,
        poll: { endpoint: base + "/index.php/login/v2/poll", token },
      }),
    );
    return;
  }
  if (req.url === "/nc/index.php/login/v2/poll") {
    const flow = flows.get(new URLSearchParams(raw).get("token") ?? "");
    if (!flow || flow.polls++) {
      res.writeHead(404);
      res.end("[]");
      return;
    }
    res.end(JSON.stringify(flow.credentials));
    return;
  }
  const auth = Buffer.from(
    req.headers.authorization?.replace(/^Basic /, "") ?? "",
    "base64",
  ).toString();
  const colon = auth.indexOf(":"),
    login = auth.slice(0, colon),
    password = auth.slice(colon + 1);
  const remote = users.get(login);
  if (!remote?.devices.has(password)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "private-upstream-details" }));
    return;
  }
  if (remote.outage) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "private-upstream-details" }));
    return;
  }
  let data;
  if (req.url === "/nc/ocs/v2.php/cloud/user?format=json")
    data = {
      id: remote.uid,
      displayname: remote.name,
      email: "never-import@example.invalid",
      quota: { secret: true },
    };
  else if (
    req.url ===
    "/nc/ocs/v2.php/cloud/users/" +
      encodeURIComponent(remote.uid) +
      "/groups?format=json"
  )
    data = { groups: remote.groups };
  else {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  assert.equal(req.headers["ocs-apirequest"], "true");
  res.end(JSON.stringify({ ocs: { meta: { statuscode: 200 }, data } }));
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/nc";
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  process.env.NEXTCLOUD_URL = base;
  process.env.NEXTCLOUD_INTERNAL_URL = base;
  process.env.NEXTCLOUD_WORKSPACE_ID = workspaceId;
  process.env.NEXTCLOUD_MEMBER_GROUP = "hyper-members";
  process.env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS = '["bootstrap-owner"]';
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Identity protocol fixture')",
    [workspaceId],
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});
function account(uid = randomUUID(), groups = ["hyper-members"]) {
  const login = uid + "@example.invalid",
    remote: Remote = { uid, name: "相同显示名", groups, devices: new Set() };
  users.set(login, remote);
  return { login, remote };
}
async function start(login: string) {
  const password = "test-device-" + randomUUID();
  users.get(login)!.devices.add(password);
  planned = { loginName: login, appPassword: password };
  return { ...(await identity.start()), password };
}
async function complete(login: string) {
  const flow = await start(login),
    result = await identity.poll(flow.flowId, flow.binding);
  assert.equal(result.state, "complete");
  if (result.state !== "complete")
    throw new Error("Expected fixture completion");
  return {
    flow,
    session: result.session,
    subject: await authenticate(db, result.session),
  };
}

test("Source identity uses canonical UID and explicit product roles, never display name or upstream admin role", async () => {
  const one = account("source-admin", ["hyper-members", "admin"]),
    two = account(),
    owner = account("bootstrap-owner");
  const a = await complete(one.login),
    b = await complete(two.login),
    c = await complete(owner.login);
  assert.notEqual(a.subject.id, b.subject.id);
  assert.equal(a.subject.role, "member");
  assert.equal(c.subject.role, "admin");
  assert.equal(a.subject.demo, false);
  const row = (
    await db.pool.query(
      "SELECT remote_uid FROM cw_external_identities WHERE user_id=$1",
      [a.subject.id],
    )
  ).rows[0];
  assert.equal(row.remote_uid, one.remote.uid);
  assert.equal(JSON.stringify(row).includes("never-import"), false);
  const viewService = new WorkspaceService(db, engineRegistry());
  const project = await viewService.createProject(
    c.subject,
    "登录测试",
    "验证工作区",
  );
  const view = await viewService.view(a.subject, project.id);
  assert.equal("identityCredentialId" in view.user, false);
});
test("Flow is browser-bound, replay-safe, encrypted, cancellable and expires", async () => {
  const a = account(),
    flow = await start(a.login);
  await assert.rejects(
    identity.poll(flow.flowId, "another-browser"),
    /过期|取消/,
  );
  const [one, two] = await Promise.all([
    identity.poll(flow.flowId, flow.binding),
    identity.poll(flow.flowId, flow.binding),
  ]);
  assert.equal(one.state, "complete");
  assert.deepEqual(one, two);
  if (one.state !== "complete") throw new Error("Fixture completion missing");
  const stored = (
    await db.pool.query("SELECT * FROM cw_login_flows WHERE id=$1", [
      flow.flowId,
    ])
  ).rows[0];
  assert.equal(JSON.stringify(stored).includes(flow.password), false);
  assert.equal(JSON.stringify(stored).includes(one.session), false);
  assert.equal(stored.poll_token_enc, null);
  assert.equal(stored.upstream_credentials_enc, null);
  await identity.cancel(flow.flowId, flow.binding);
  await assert.rejects(authenticate(db, one.session));
  const expired = await start(a.login);
  await db.pool.query(
    "UPDATE cw_login_flows SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.flowId],
  );
  await assert.rejects(identity.poll(expired.flowId, expired.binding), /过期/);
});
test("Device token revocation does not substitute another device credential", async () => {
  const a = account(),
    one = await complete(a.login),
    two = await complete(a.login);
  assert.equal(one.subject.id, two.subject.id);
  assert.notEqual(
    one.subject.identityCredentialId,
    two.subject.identityCredentialId,
  );
  a.remote.devices.delete(one.flow.password);
  await assert.rejects(authenticate(db, one.session), /凭据/);
  assert.equal((await authenticate(db, two.session)).id, one.subject.id);
  const rows = await db.pool.query(
    "SELECT credential_enc FROM cw_identity_credentials WHERE identity_id IN(SELECT id FROM cw_external_identities WHERE user_id=$1)",
    [one.subject.id],
  );
  assert.equal(JSON.stringify(rows.rows).includes(two.flow.password), false);
});
test("One-shot poll credentials survive a temporary source outage without granting access", async () => {
  const a = account(),
    flow = await start(a.login);
  a.remote.outage = true;
  await assert.rejects(identity.poll(flow.flowId, flow.binding), /暂时不可用/);
  const before = await db.pool.query(
    "SELECT id FROM cw_external_identities WHERE remote_uid=$1",
    [a.remote.uid],
  );
  assert.equal(before.rowCount, 0);
  a.remote.outage = false;
  const result = await identity.poll(flow.flowId, flow.binding);
  assert.equal(result.state, "complete");
  if (result.state !== "complete") throw new Error("Expected fixture session");
  a.remote.outage = true;
  await assert.rejects(authenticate(db, result.session), /暂时不可用/);
  a.remote.outage = false;
  await authenticate(db, result.session);
});
test("Group removal revokes membership and all sessions; restoring the source group alone does not restore product access", async () => {
  const a = account(),
    one = await complete(a.login),
    two = await complete(a.login);
  a.remote.groups = ["admin"];
  await assert.rejects(assertMember(db, one.subject), /撤销/);
  await assert.rejects(authenticate(db, two.session));
  a.remote.groups = ["hyper-members"];
  const again = await start(a.login);
  await assert.rejects(
    identity.poll(again.flowId, again.binding),
    /产品权限已撤销/,
  );
});
test("Local revocation cannot be bypassed by re-login or forged product roles", async () => {
  const a = account(),
    one = await complete(a.login);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, one.subject.id],
  );
  await assert.rejects(assertMember(db, { ...one.subject, role: "admin" }));
  const again = await start(a.login);
  await assert.rejects(
    identity.poll(again.flowId, again.binding),
    /产品权限已撤销/,
  );
  const guest = account(undefined, ["admin"]),
    denied = await start(guest.login);
  await assert.rejects(
    identity.poll(denied.flowId, denied.binding),
    /允许的企业群组/,
  );
});
test("Source URL changes and hostile login responses cannot redirect existing app passwords", async () => {
  const a = account(),
    one = await complete(a.login);
  process.env.NEXTCLOUD_URL = base + "/other";
  await assert.rejects(authenticate(db, one.session), /身份来源已更改/);
  process.env.NEXTCLOUD_URL = base;
  malicious = true;
  await assert.rejects(identity.start(), /地址与配置不符/);
  malicious = false;
  planned = {
    loginName: a.login,
    appPassword: "not-sent",
    server: "https://attacker.invalid",
  };
  const flow = await identity.start();
  await assert.rejects(
    identity.poll(flow.flowId, flow.binding),
    /身份来源与工作区配置不匹配/,
  );
  const provider = new NextcloudIdentityProvider(requireNextcloud());
  await assert.rejects(
    provider.current({ loginName: "bad:alias", appPassword: "test" }),
    /凭据无效/,
  );
});
test("Queued runs retain the initiating device identity and stop before business writes after source revocation", async () => {
  const a = account(),
    login = await complete(a.login),
    engines = engineRegistry();
  const revokeEngine: EngineAdapter = {
    id: "dsh",
    describeCapabilities: () => ({
      configured: true,
      operations: ["discussion_to_minutes"],
      evidence: "protocol-fixture",
    }),
    execute: async () => {
      a.remote.groups = [];
      return {
        text: "cannot publish",
        evidence: "fixture",
        actions: [
          {
            tool: "artifact.create",
            args: { title: "must not exist", content: "test" },
          },
        ],
      };
    },
  };
  engines.set("dsh", revokeEngine);
  const service = new WorkspaceService(db, engines),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    login.subject,
    "撤权验证",
    "不得执行撤权后的动作",
  );
  const view = await service.view(login.subject, project.id);
  await service.saveModel(login.subject, {
    name: "protocol-only",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:1/v1",
    model: "unused",
    purpose: "chat",
    scope: "personal",
    apiKey: "test-no-real-model",
  });
  const run = await service.startRun(login.subject, {
    conversationId: view.project.conversationId,
    engine: "dsh",
    workflow: "discussion_to_minutes",
    instruction: "create artifact",
    idempotencyKey: randomUUID(),
  });
  const stored = (
    await db.pool.query(
      "SELECT identity_credential_id FROM cw_runs WHERE id=$1",
      [run.id],
    )
  ).rows[0];
  assert.equal(
    stored.identity_credential_id,
    login.subject.identityCredentialId,
  );
  await processor.process(run.id);
  assert.equal(
    (await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [run.id]))
      .rows[0].state,
    "failed",
  );
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_artifacts WHERE project_id=$1", [
        project.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_messages WHERE conversation_id=$1",
        [view.project.conversationId],
      )
    ).rowCount,
    0,
  );
});

test("Group removal observed by a new login also revokes existing devices", async () => {
  const a = account(),
    prior = await complete(a.login);
  a.remote.groups = [];
  const next = await start(a.login);
  await assert.rejects(
    identity.poll(next.flowId, next.binding),
    /允许的企业群组/,
  );
  a.remote.groups = ["hyper-members"];
  await assert.rejects(authenticate(db, prior.session));
  await assert.rejects(
    identity.poll(next.flowId, next.binding),
    /产品权限已撤销/,
  );
});
