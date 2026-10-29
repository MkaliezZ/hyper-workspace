import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../apps/api/src/db/database.js";
import { origin, source, password, login } from "./helpers";
const db = new Database(process.env.TEST_DATABASE_URL);
test.afterAll(async () => db.close());
async function upload(uid: string, name: string, content: string) {
  const response = await fetch(
    source +
      "/remote.php/dav/files/" +
      encodeURIComponent(uid) +
      "/" +
      encodeURIComponent(name),
    {
      method: "PUT",
      redirect: "error",
      headers: {
        Authorization:
          "Basic " + Buffer.from(uid + ":" + password).toString("base64"),
        "Content-Type": "text/markdown",
      },
      body: content,
    },
  );
  expect([201, 204]).toContain(response.status);
}
async function share(uid: string, path: string, method = "POST", id?: string) {
  const response = await fetch(
    source +
      "/ocs/v2.php/apps/files_sharing/api/v1/shares" +
      (id ? "/" + id : "") +
      "?format=json",
    {
      method,
      redirect: "error",
      headers: {
        Authorization:
          "Basic " + Buffer.from(uid + ":" + password).toString("base64"),
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        method === "POST"
          ? new URLSearchParams({
              path: "/" + path,
              shareType: "0",
              shareWith: "talk-bob",
              permissions: "1",
            })
          : undefined,
    },
  );
  expect(response.ok).toBe(true);
  return method === "POST" ? (await response.json()).ocs.data : undefined;
}
test("Real Files imports and pgvector retain employee scope and reject changed or revoked shared content", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const filename = "Hyper-source-" + randomUUID() + ".md",
    v1 = "synthetic-enterprise-file-version-one",
    v2 = "synthetic-enterprise-file-version-two";
  await upload("talk-alice", filename, v1);
  const sharing = await share("talk-alice", filename);
  const inputs: string[][] = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (
      req.url !== "/v1/embeddings" ||
      req.headers.authorization !== "Bearer synthetic-real-file-embedding"
    ) {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    const body = JSON.parse(raw);
    inputs.push(body.input);
    res.end(
      JSON.stringify({
        data: body.input.map((_: string, index: number) => ({
          index,
          embedding: [1, 0],
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const bob = await login(browser, "talk-bob"),
    alice = await login(browser, "talk-alice");
  try {
    await expect(
      bob.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    await expect(
      alice.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    const profile = await bob.context.request.post(origin + "/api/models", {
      headers: { Origin: origin },
      data: {
        name: "Synthetic file embedding",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" +
          (model.address() as { port: number }).port +
          "/v1",
        model: "file-vector-2d",
        purpose: "embedding",
        scope: "personal",
        apiKey: "synthetic-real-file-embedding",
      },
    });
    expect(profile.status()).toBe(201);
    const profileId = (await profile.json()).id;
    await bob.page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "知识库", exact: true })
      .click();
    await bob.page.getByRole("tab", { name: "企业文件", exact: true }).click();
    const row = bob.page.getByRole("listitem").filter({ hasText: filename });
    await expect(row).toBeVisible();
    await row
      .getByRole("button", { name: "导入个人资料", exact: true })
      .click();
    await bob.page
      .getByRole("button", { name: "查看文本", exact: true })
      .click();
    await expect(
      bob.page.getByRole("region", { name: "文件文本预览" }),
    ).toContainText(v1);
    const records = await (
      await bob.context.request.get(origin + "/api/files/imports")
    ).json();
    const asset = records.find((r: any) => r.title === filename);
    expect(asset.state).toBe("ready");
    expect(
      (
        await alice.context.request.get(
          origin + "/api/files/imports/" + asset.id,
        )
      ).status(),
    ).toBe(404);
    const index = await bob.context.request.post(
      origin + "/api/knowledge/index",
      {
        headers: { Origin: origin },
        data: { assetIds: [asset.id], modelProfileId: profileId },
      },
    );
    expect(index.status()).toBe(201);
    expect((await index.json()).indexed).toContain(asset.id);
    const semantic = await bob.context.request.post(
      origin + "/api/knowledge/semantic",
      {
        headers: { Origin: origin },
        data: { query: "source file", modelProfileId: profileId },
      },
    );
    expect((await semantic.json()).some((r: any) => r.id === asset.id)).toBe(
      true,
    );
    await upload("talk-alice", filename, v2);
    expect(
      await (
        await bob.context.request.get(origin + "/api/knowledge?q=" + v1)
      ).json(),
    ).toHaveLength(0);
    const stale = (
      await db.pool.query(
        "SELECT content,embedding,validity FROM cw_assets WHERE id=$1",
        [asset.id],
      )
    ).rows[0];
    expect(stale.content).toBe("");
    expect(stale.embedding).toBe(null);
    expect(stale.validity).toBe("stale");
    const refresh = await bob.context.request.post(
      origin + "/api/files/imports/" + asset.id + "/refresh",
      { headers: { Origin: origin }, data: {} },
    );
    expect(refresh.status()).toBe(201);
    expect((await refresh.json()).id).toBe(asset.id);
    await bob.page
      .getByRole("button", { name: "刷新文件权限", exact: true })
      .click();
    await bob.page
      .getByRole("button", { name: "查看文本", exact: true })
      .click();
    await expect(
      bob.page.getByRole("region", { name: "文件文本预览" }),
    ).toContainText(v2);
    await share("talk-alice", filename, "DELETE", String(sharing.id));
    expect(
      (
        await bob.context.request.get(origin + "/api/files/imports/" + asset.id)
      ).status(),
    ).toBe(404);
    expect(
      await (
        await bob.context.request.get(origin + "/api/knowledge?q=" + v2)
      ).json(),
    ).toHaveLength(0);
    await expect(bob.page.getByText(v2, { exact: true })).toHaveCount(0, {
      timeout: 20000,
    });
    expect(
      (
        await db.pool.query(
          "SELECT content,embedding FROM cw_assets WHERE id=$1",
          [asset.id],
        )
      ).rows[0],
    ).toEqual({ content: "", embedding: null });
    expect(inputs.flat().some((value) => value.includes(v1))).toBe(true);
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await bob.context.close();
    await alice.context.close();
  }
});
