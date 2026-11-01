import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NextcloudOrganizationProvider } from "../apps/api/src/providers/nextcloud-organization.js";

let mode = "valid",
  active = 0,
  peak = 0;
const requests: URL[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture.invalid");
  requests.push(url);
  assert.equal(
    req.headers.authorization,
    "Basic " +
      Buffer.from("ordinary-employee:synthetic-password").toString("base64"),
  );
  assert.equal(req.headers["ocs-apirequest"], "true");
  const send = (data: unknown, code = 100) =>
    res.end(JSON.stringify({ ocs: { meta: { statuscode: code }, data } }));
  if (mode === "empty") return void res.end();
  if (mode === "denied") {
    res.writeHead(403);
    return void res.end("private upstream message");
  }
  if (mode === "expired") return void send({}, 997);
  if (mode === "oversize") return void res.end("x".repeat(2 * 1024 * 1024 + 1));
  if (url.pathname.endsWith("/users")) {
    return void send({
      users:
        mode === "duplicate"
          ? ["a", "a"]
          : mode === "too-many"
            ? Array.from({ length: 2001 }, (_, i) => String(i))
            : ["z", "employee&one", "a"],
    });
  }
  if (mode === "names-hidden") {
    res.writeHead(403);
    return void res.end();
  }
  if (mode === "names-malformed") return void send({ users: [] });
  const uid = url.searchParams.get("search")!;
  active++;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  active--;
  return void send([
    {
      source: "users",
      id: uid + "-similar",
      label: "同名员工",
      subline: "private@example.invalid",
    },
    { source: "groups", id: uid, label: "伪装的组" },
    {
      source: "users",
      id: uid,
      label: "员工 " + uid,
      subline: "private@example.invalid",
      status: { message: "hidden status" },
    },
  ]);
});
let provider: NextcloudOrganizationProvider;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  provider = new NextcloudOrganizationProvider(
    {
      publicUrl: base,
      transportUrl: base,
      providerKey: "synthetic:organization",
      workspaceId: "synthetic",
      memberGroup: "staff / &",
      bootstrapAdminIds: [],
    },
    { loginName: "ordinary-employee", appPassword: "synthetic-password" },
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test("Organization uses employee credentials and encoded membership group; exact UID labels omit private extra fields and bound concurrency", async () => {
  mode = "valid";
  assert.deepEqual(await provider.members(), ["a", "employee&one", "z"]);
  assert.equal(
    requests.at(-1)!.pathname,
    "/ocs/v2.php/cloud/groups/staff%20%2F%20%26/users",
  );
  const rows = await provider.people(
    Array.from({ length: 9 }, (_, i) => "id" + i),
  );
  assert.equal(rows.length, 9);
  assert.ok(peak <= 4);
  assert.deepEqual(rows[0], {
    uid: "id0",
    name: "员工 id0",
    nameState: "source-verified",
  });
  assert.ok(!JSON.stringify(rows).includes("private@example"));
  const search = await provider.search("陈");
  assert.equal(search.rows.length, 2);
  assert.equal(requests.at(-1)!.searchParams.get("shareTypes[]"), "0");
});
test("Organization distinguishes hidden labels from lost credentials or malformed directory; never treats a truncated roster as complete", async () => {
  mode = "names-hidden";
  assert.deepEqual(await provider.people(["known-uid"]), [
    { uid: "known-uid", name: "known-uid", nameState: "uid-only" },
  ]);
  mode = "names-malformed";
  await assert.rejects(provider.people(["known-uid"]), /响应无效/);
  for (const scenario of [
    "duplicate",
    "too-many",
    "empty",
    "oversize",
    "denied",
    "expired",
  ]) {
    mode = scenario;
    await assert.rejects(provider.members(), (error) => {
      assert.ok(!String(error).includes("private upstream message"));
      return true;
    });
  }
});
test("Organization rejects duplicate targets, control characters and oversized label batches before network requests", async () => {
  mode = "valid";
  const count = requests.length;
  await assert.rejects(provider.people(["same", "same"]));
  await assert.rejects(provider.people(["bad\nuid"]));
  await assert.rejects(
    provider.people(Array.from({ length: 51 }, (_, i) => String(i))),
  );
  await assert.rejects(provider.search(" "));
  assert.equal(requests.length, count);
});
