import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { modelFixture } from "../runtime/business-contract";
import { Database } from "../../apps/api/src/db/database.js";
import { origin, source, password, login } from "./helpers";
const db = new Database(process.env.TEST_DATABASE_URL);
test.afterAll(async () => db.close());
async function upload(
  uid: string,
  name: string,
  content: string | Buffer,
  mime = "text/markdown",
) {
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
        "Content-Type": mime,
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
  test.setTimeout(300000);
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
  let currentEngine = "dsh";
  let currentSource = v1;
  const enginesSeen = new Set<string>();
  const fixture = modelFixture(["synthetic-file-reading-key"], (body) => {
    const text = JSON.stringify(body.messages);
    expect(text).toContain("native-file-reading-fixture");
    expect(text).toContain(currentSource);
    expect(text).toContain("Employee-selected private file");
    enginesSeen.add(currentEngine);
  });
  await new Promise<void>((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
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
    const chat = await bob.context.request.post(origin + "/api/models", {
      headers: { Origin: origin },
      data: {
        name: "Synthetic file reading",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" +
          (fixture.server.address() as { port: number }).port +
          "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        apiKey: "synthetic-file-reading-key",
      },
    });
    expect(chat.status()).toBe(201);
    const chatId = (await chat.json()).id;
    async function read(engine: string) {
      currentEngine = engine;
      await bob.page
        .getByRole("button", { name: "AI 阅读此文件", exact: true })
        .click();
      await bob.page
        .getByRole("combobox", { name: "执行器", exact: true })
        .selectOption(engine);
      await bob.page
        .getByRole("combobox", { name: "阅读模型", exact: true })
        .selectOption(chatId);
      await bob.page
        .getByRole("textbox", { name: "阅读问题", exact: true })
        .fill(
          "native-file-reading-fixture: Explain only the selected version.",
        );
      await bob.page
        .getByRole("button", { name: "开始个人阅读", exact: true })
        .click();
      await expect(
        bob.page.getByRole("textbox", { name: "修改解读", exact: true }),
      ).toHaveValue("private-native-file-reading-0", { timeout: 75000 });
      const library = await (
        await bob.context.request.get(
          origin + "/api/files/imports/" + asset.id + "/readings",
        )
      ).json();
      expect(library.readings).toHaveLength(1);
      const reading = await (
        await bob.context.request.get(
          origin + "/api/files/readings/" + library.readings[0].id,
        )
      ).json();
      expect(reading.assetId).toBe(asset.id);
      expect(
        (
          await alice.context.request.get(
            origin + "/api/files/readings/" + reading.id,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await alice.context.request.get(origin + "/api/runs/" + reading.runId)
        ).status(),
      ).toBe(404);
      await expect
        .poll(
          async () =>
            (
              await db.pool.query(
                "SELECT runtime_cleaned_at FROM cw_runs WHERE id=$1",
                [reading.runId],
              )
            ).rows[0].runtime_cleaned_at,
          { timeout: 10000 },
        )
        .toBeTruthy();
      return reading;
    }
    async function revise(
      reading: any,
      engine: string,
      expectedVersion: number,
    ) {
      currentEngine = engine;
      await bob.page
        .getByRole("combobox", { name: "执行器", exact: true })
        .selectOption(engine);
      await bob.page
        .getByRole("textbox", { name: "AI 修改要求", exact: true })
        .fill(
          "native-file-revision-fixture: Keep the selected saved draft and clarify its next steps.",
        );
      await bob.page
        .getByRole("button", { name: "按要求修改解读", exact: true })
        .click();
      await expect(
        bob.page.getByText(
          "解读 v" +
            (expectedVersion + 1) +
            " 已保存，可重新读取。当前编辑内容已保留。",
          { exact: true },
        ),
      ).toBeVisible({ timeout: 75000 });
      await bob.page
        .getByRole("button", { name: "重新读取解读", exact: true })
        .click();
      await expect(
        bob.page.getByRole("textbox", { name: "修改解读", exact: true }),
      ).toHaveValue("private-native-file-revision-0");
      const updated = await (
        await bob.context.request.get(
          origin + "/api/files/readings/" + reading.id,
        )
      ).json();
      expect(updated.id).toBe(reading.id);
      expect(updated.version).toBe(expectedVersion + 1);
      expect(updated.versions.at(-1).engine).toBe(engine);
      const revisionRunId = updated.versions.at(-1).runId;
      const run = await (
        await bob.context.request.get(origin + "/api/runs/" + revisionRunId)
      ).json();
      expect(run.result.evidence).toBe("runtime");
      expect(run.result.receipts[0]).toMatchObject({
        id: reading.id,
        version: expectedVersion + 1,
      });
      expect(run.contextRefs).toContain(
        "file-reading:" + reading.id + "@" + expectedVersion,
      );
      expect(
        (
          await alice.context.request.get(origin + "/api/runs/" + revisionRunId)
        ).status(),
      ).toBe(404);
      return revisionRunId;
    }

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
    const firstReading = await read("dsh");
    const firstRevision = await revise(firstReading, "hermes", 1);
    expect(
      (
        await (
          await bob.context.request.get(
            origin + "/api/runs/" + firstReading.runId,
          )
        ).json()
      ).result.receipts[0].version,
    ).toBe(1);
    await upload("talk-alice", filename, v2);
    currentSource = v2;
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
    expect(
      (
        await bob.context.request.get(origin + "/api/runs/" + firstRevision)
      ).status(),
    ).toBe(404);
    expect(
      (
        await db.pool.query(
          "SELECT instruction,result FROM cw_runs WHERE id=$1",
          [firstRevision],
        )
      ).rows[0],
    ).toMatchObject({ instruction: "", result: null });
    expect(
      (
        await bob.context.request.get(
          origin + "/api/files/readings/" + firstReading.id,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await db.pool.query(
          "SELECT content FROM cw_file_reading_versions WHERE reading_id=$1",
          [firstReading.id],
        )
      ).rows.every((r) => r.content === ""),
    ).toBe(true);

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
    const secondReading = await read("hermes");
    await bob.page
      .getByRole("textbox", { name: "修改解读", exact: true })
      .fill("human-reviewed-private-file-reading");
    await bob.page
      .getByRole("button", { name: "保存解读修订", exact: true })
      .click();
    await expect(
      bob.page.getByText("当前修订 v2", { exact: false }),
    ).toBeVisible();
    await revise(secondReading, "dsh", 2);
    await share("talk-alice", filename, "DELETE", String(sharing.id));
    expect(
      (
        await bob.context.request.get(
          origin + "/api/files/readings/" + secondReading.id,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await db.pool.query(
          "SELECT content FROM cw_file_reading_versions WHERE reading_id=$1",
          [secondReading.id],
        )
      ).rows.every((r) => r.content === ""),
    ).toBe(true);
    expect(fixture.violations).toEqual([]);
    expect([...enginesSeen].sort()).toEqual(["dsh", "hermes"]);

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
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await bob.context.close();
    await alice.context.close();
  }
});

test("Real PDF and Office shares produce versioned private readings through both native engines and clear on revocation", async ({
  browser,
}) => {
  test.setTimeout(240000);
  let selected = "";
  const fixture = modelFixture(["synthetic-document-reading-key"], (body) => {
    const context = JSON.stringify(body.messages);
    expect(context).toContain(selected);
    expect(context).toContain("document-text-v1");
    expect(context).toContain("native-file-reading-fixture");
  });
  await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
  const actor = await login(browser, "talk-bob");
  const headers = { Origin: origin };
  try {
    // Source consent completes before the product's login poll sets its cookie.
    // Wait for the authenticated workspace instead of racing a protected write.
    await expect(
      actor.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    expect(
      (await actor.context.request.get(origin + "/api/workspace")).status(),
    ).toBe(200);
    const profileResponse = await actor.context.request.post(
      origin + "/api/models",
      {
        headers,
        data: {
          name: "Synthetic document reading",
          provider: "openai-compatible",
          purpose: "chat",
          scope: "personal",
          endpoint:
            "http://127.0.0.1:" +
            (fixture.server.address() as { port: number }).port +
            "/v1",
          model: "native-test-model",
          apiKey: "synthetic-document-reading-key",
        },
      },
    );
    expect(profileResponse.status()).toBe(201);
    const profile = await profileResponse.json();
    for (const [index, format] of ["pdf", "docx", "xlsx", "pptx"].entries()) {
      const name = "Hyper-document-" + randomUUID() + "." + format;
      selected = "synthetic-document-" + format;
      const binary = execFileSync(resolve(".runtime/documents/bin/python"), [
        "tests/fixtures/document-source.py",
        format,
        selected,
      ]);
      const mime = {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }[format]!;
      await upload("talk-alice", name, binary, mime);
      const shared = await share("talk-alice", name);
      const listing = await actor.context.request.post(
        origin + "/api/files/list",
        { headers, data: { path: [] } },
      );
      expect(listing.status()).toBe(201);
      const file = (await listing.json()).find((f: any) => f.name === name);
      expect(file?.importable).toBe(true);
      const imported = await actor.context.request.post(
        origin + "/api/files/import",
        {
          headers,
          data: {
            path: file.path,
            expectedId: file.id,
            expectedEtag: file.etag,
          },
        },
      );
      expect(imported.status()).toBe(201);
      const asset = await imported.json();
      const preview = await (
        await actor.context.request.get(
          origin + "/api/files/imports/" + asset.id,
        )
      ).json();
      expect(preview.content).toContain(selected);
      expect(preview.extraction.format).toBe(format);
      expect(preview.extraction.sections.length).toBeGreaterThan(0);
      const started = await actor.context.request.post(
        origin + "/api/files/imports/" + asset.id + "/readings",
        {
          headers,
          data: {
            engine: index % 2 ? "hermes" : "dsh",
            modelProfileId: profile.id,
            instruction:
              "native-file-reading-fixture: explain this exact extracted document.",
            expectedSourceVersion: asset.sourceVersion,
            idempotencyKey: randomUUID(),
          },
        },
      );
      expect(started.status()).toBe(201);
      const run = await started.json();
      await expect
        .poll(
          async () =>
            (
              await (
                await actor.context.request.get(origin + "/api/runs/" + run.id)
              ).json()
            ).state,
          { timeout: 60000, intervals: [700] },
        )
        .toBe("succeeded");
      const result = await (
        await actor.context.request.get(origin + "/api/runs/" + run.id)
      ).json();
      const readingId = result.result.receipts[0].id;
      await share("talk-alice", name, "DELETE", String(shared.id));
      expect(
        (
          await actor.context.request.get(
            origin + "/api/files/imports/" + asset.id,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await actor.context.request.get(
            origin + "/api/files/readings/" + readingId,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await db.pool.query(
            "SELECT content,embedding FROM cw_assets WHERE id=$1",
            [asset.id],
          )
        ).rows[0],
      ).toEqual({ content: "", embedding: null });
      expect(
        (
          await db.pool.query(
            "SELECT extraction_metadata FROM cw_source_files WHERE asset_id=$1",
            [asset.id],
          )
        ).rows[0].extraction_metadata,
      ).toEqual({});
    }
    expect(fixture.violations).toEqual([]);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((r) => fixture.server.close(() => r()));
    await actor.context.close();
  }
});
