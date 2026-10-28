import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import type { Subject } from "@hyper/contracts";

test(
  "Real pinned DSH runs two employee model profiles through product receipts without native tools",
  { timeout: 60000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(
      url && new URL(url).pathname.endsWith("_test"),
      "Use an isolated _test database.",
    );
    process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
    const directory = await mkdtemp(join(tmpdir(), "hyper-native-dsh-"));
    const oldDirectory = process.env.RUNTIME_DIR;
    process.env.RUNTIME_DIR = directory;
    const db = new Database(url),
      service = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(service);
    assert.equal(
      service.engines.get("dsh")?.describeCapabilities().configured,
      true,
      "Install runtime/dsh dependencies first.",
    );
    const keys = [
      "runtime-test-a-" + randomUUID(),
      "runtime-test-b-" + randomUUID(),
    ];
    const observed = new Set<number>();
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw),
        employee = keys.findIndex(
          (key) => req.headers.authorization === "Bearer " + key,
        );
      assert.ok(employee >= 0);
      assert.ok(!body.tools?.length, "Native tools must remain disabled.");
      observed.add(employee);
      const text = JSON.stringify({
        text: "已准备测试成果。",
        actions: [
          {
            tool: "artifact.create",
            args: {
              title: "DSH runtime test " + employee,
              content: "protocol-fixture-model-result " + employee,
            },
          },
        ],
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
        { index: 0, delta: {}, finish_reason: "stop" },
      ])
        res.write(
          "data: " +
            JSON.stringify({
              id: "native-test",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [choice],
            }) +
            "\n\n",
        );
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      await db.migrate();
      const subjects: Subject[] = [],
        runs: { id: string }[] = [];
      for (const [index, key] of keys.entries()) {
        const s: Subject = {
          id: randomUUID(),
          workspaceId: randomUUID(),
          name: "Runtime test " + index,
          role: "admin",
          demo: false,
        };
        const project = randomUUID(),
          conversation = randomUUID();
        await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
          s.id,
          s.name,
        ]);
        await db.pool.query(
          "INSERT INTO cw_workspaces(id,name) VALUES($1,'DSH runtime test')",
          [s.workspaceId],
        );
        await db.pool.query(
          "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",
          [s.workspaceId, s.id],
        );
        await db.pool.query(
          "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,'Native test','Verify scoped model routing')",
          [project, s.workspaceId],
        );
        await db.pool.query(
          "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
          [conversation, s.workspaceId, project],
        );
        await service.message(
          s,
          conversation,
          "Use this authorized test discussion.",
        );
        const model = await service.saveModel(s, {
          name: "Native test model",
          provider: "openai-compatible",
          endpoint: `http://127.0.0.1:${address.port}/v1`,
          model: "native-test-model",
          apiKey: key,
          purpose: "chat",
          scope: "personal",
        });
        runs.push(
          await service.startRun(s, {
            conversationId: conversation,
            engine: "dsh",
            workflow: "discussion_to_minutes",
            instruction: "Create a short test artifact.",
            modelProfileId: model.id,
            idempotencyKey: randomUUID(),
          }),
        );
        subjects.push(s);
      }
      await Promise.all(runs.map((run) => processor.process(run.id)));
      assert.equal(observed.size, 2);
      for (const [index, run] of runs.entries()) {
        const s = subjects[index]!,
          result = await service.getRun(s, run.id);
        assert.equal(result.state, "succeeded", result.error ?? "run failed");
        const receipt = result.result.receipts[0];
        assert.equal(
          (await service.artifact(s, receipt.id)).current.content,
          "protocol-fixture-model-result " + index,
        );
        await assert.rejects(service.getRun(subjects[1 - index]!, run.id));
        const events = JSON.stringify(await service.events(s, run.id));
        for (const key of keys) assert.equal(events.includes(key), false);
      }
      async function inspect(path: string): Promise<void> {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) await inspect(child);
          else if (entry.isFile()) {
            const text = await readFile(child, "utf8");
            for (const key of keys)
              assert.equal(
                text.includes(key),
                false,
                "Credential persisted in runtime files",
              );
          }
        }
      }
      await inspect(directory);
    } finally {
      await db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (oldDirectory === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = oldDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
