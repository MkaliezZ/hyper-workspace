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

type NativeEngine = "dsh" | "hermes";
interface Employee {
  subject: Subject;
  conversation: string;
  modelId: string;
  runId: string;
  artifactId?: string;
}

/** Real engines and database; this model endpoint is explicitly a protocol fixture. */
export function modelFixture(
  keys: string[],
  observeRequest?: (body: any, employee: number) => void | Promise<void>,
) {
  const observed = new Set<number>(),
    violations: string[] = [];
  let chatCalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "native-test-model",
              object: "model",
              created: 1,
              owned_by: "fixture",
            },
          ],
        }),
      );
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      employee = keys.findIndex(
        (key) => req.headers.authorization === "Bearer " + key,
      );
    const cap = body.max_tokens ?? body.max_completion_tokens;
    if (
      employee < 0 ||
      body.tools?.length ||
      typeof cap !== "number" ||
      cap < 1 ||
      cap > 4096
    ) {
      violations.push("credential, tool or output-cap contract violated");
      res.writeHead(400);
      res.end('{"error":"invalid fixture request"}');
      return;
    }
    await observeRequest?.(body, employee);
    chatCalls++;
    observed.add(employee);
    const revision = JSON.stringify(body.messages).match(
      /switch-revise-(\d+)/,
    )?.[1];
    const draftReply = JSON.stringify(body.messages).includes(
      "native-reply-draft-fixture",
    );
    const fileReading = JSON.stringify(body.messages).includes(
      "native-file-reading-fixture",
    );
    const text = JSON.stringify({
      text: "已准备测试成果。",
      actions: [
        fileReading
          ? {
              tool: "file.reading.save",
              args: { content: "private-native-file-reading-" + employee },
            }
          : draftReply
            ? {
                tool: "communication.draft",
                args: { content: "private-native-reply-draft-" + employee },
              }
            : revision
              ? {
                  tool: "artifact.revise",
                  args: { content: "protocol-fixture-revision " + revision },
                }
              : {
                  tool: "artifact.create",
                  args: {
                    title: "Native runtime test " + employee,
                    content: "protocol-fixture-model-result " + employee,
                  },
                },
      ],
    });
    if (body.stream) {
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
    } else
      res.end(
        JSON.stringify({
          id: "native-test",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }),
      );
  });
  return { server, observed, violations, calls: () => chatCalls };
}

async function seedEmployee(
  db: Database,
  service: WorkspaceService,
  key: string,
  index: number,
  endpoint: string,
  engine: NativeEngine,
  workspaceId: string,
): Promise<Employee> {
  const subject: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "Runtime test " + index,
    role: index === 0 ? "admin" : "member",
    demo: false,
  };
  const project = randomUUID(),
    conversation = randomUUID();
  await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
    subject.id,
    subject.name,
  ]);
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Native runtime test') ON CONFLICT DO NOTHING",
    [subject.workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [subject.workspaceId, subject.id, subject.role],
  );
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,'Native test','Verify scoped model routing')",
    [project, subject.workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
    [conversation, subject.workspaceId, project],
  );
  await service.message(
    subject,
    conversation,
    "Use this authorized test discussion.",
  );
  const model = await service.saveModel(subject, {
    name: "Native test model",
    provider: "openai-compatible",
    endpoint,
    model: "native-test-model",
    apiKey: key,
    purpose: "chat",
    scope: "personal",
  });
  const run = await service.startRun(subject, {
    conversationId: conversation,
    engine,
    workflow: "discussion_to_minutes",
    instruction: "Create a short test artifact.",
    modelProfileId: model.id,
    idempotencyKey: randomUUID(),
  });
  return { subject, conversation, modelId: model.id, runId: run.id };
}

async function verifySwitch(
  db: Database,
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engines: NativeEngine[],
) {
  const id = employee.artifactId!,
    runs: string[] = [];
  const originalSources = (await service.artifact(employee.subject, id)).current
    .sourceMessageIds;
  assert.ok(originalSources.length > 0);
  const originalAsset = (
    await db.pool.query("SELECT id FROM cw_assets WHERE source_ref=$1", [
      "artifact:" + id,
    ])
  ).rows[0].id;
  for (const [offset, engine] of engines.entries()) {
    const version = offset + 2;
    const run = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      engine,
      workflow: "revise_artifact",
      artifactId: id,
      instruction: "switch-revise-" + version,
      modelProfileId: employee.modelId,
      idempotencyKey: randomUUID(),
    });
    runs.push(run.id);
    await processor.process(run.id);
    const result = await service.getRun(employee.subject, run.id);
    assert.equal(result.state, "succeeded", result.error ?? "switch failed");
    assert.equal(result.engine, engine);
    const artifact = await service.artifact(employee.subject, id);
    assert.equal(artifact.current.version, version);
    assert.equal(
      artifact.current.content,
      "protocol-fixture-revision " + version,
    );
    assert.ok(
      originalSources.every((ref: string) =>
        artifact.current.sourceMessageIds.includes(ref),
      ),
    );
    assert.ok(
      result.contextRefs
        .filter((ref: string) => !ref.startsWith("artifact:"))
        .every((ref: string) =>
          artifact.current.sourceMessageIds.includes(ref),
        ),
    );
    assert.ok(
      result.contextRefs.includes("artifact:" + id + "@" + (version - 1)),
    );
    const asset = (
      await db.pool.query(
        "SELECT id,source_version FROM cw_assets WHERE source_ref=$1",
        ["artifact:" + id],
      )
    ).rows[0];
    assert.equal(asset.id, originalAsset);
    assert.equal(asset.source_version, String(version));
  }
  return runs;
}

async function inspectHomes(path: string, keys: string[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await inspectHomes(child, keys);
    else if (entry.isFile()) {
      const bytes = await readFile(child);
      for (const key of keys)
        assert.equal(
          bytes.includes(Buffer.from(key)),
          false,
          "Credential persisted in runtime files",
        );
    }
  }
}

export async function exerciseNativeBusiness(
  engine: NativeEngine,
  switchThrough?: NativeEngine,
) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(
    url && new URL(url).pathname.endsWith("_test"),
    "Use an isolated _test database.",
  );
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  const directory = await mkdtemp(
    join(tmpdir(), "hyper-native-" + engine + "-"),
  );
  const oldDirectory = process.env.RUNTIME_DIR;
  process.env.RUNTIME_DIR = directory;
  const db = new Database(url),
    service = new WorkspaceService(db, engineRegistry()),
    processor = new RunProcessor(service);
  const keys = [
    "runtime-test-a-" + randomUUID(),
    "runtime-test-b-" + randomUUID(),
  ];
  const fixture = modelFixture(keys);
  await new Promise<void>((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
  const address = fixture.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const id of [engine, ...(switchThrough ? [switchThrough] : [])])
      assert.equal(
        service.engines.get(id)?.describeCapabilities().configured,
        true,
        "Install runtime/" + id + " first.",
      );
    await db.migrate();
    const employees: Employee[] = [],
      allRuns: string[] = [];
    const workspaceId = randomUUID();
    for (const [index, key] of keys.entries())
      employees.push(
        await seedEmployee(
          db,
          service,
          key,
          index,
          `http://127.0.0.1:${address.port}/v1`,
          engine,
          workspaceId,
        ),
      );
    await Promise.all(
      employees.map((employee) => processor.process(employee.runId)),
    );
    assert.deepEqual(fixture.violations, []);
    assert.equal(fixture.observed.size, 2);
    assert.equal(fixture.calls(), 2);
    for (const [index, employee] of employees.entries()) {
      allRuns.push(employee.runId);
      const result = await service.getRun(employee.subject, employee.runId);
      assert.equal(result.state, "succeeded", result.error ?? "run failed");
      employee.artifactId = result.result.receipts[0].id;
      assert.equal(
        (await service.artifact(employee.subject, employee.artifactId!)).current
          .content,
        "protocol-fixture-model-result " + index,
      );
      await assert.rejects(
        service.getRun(employees[1 - index]!.subject, employee.runId),
      );
    }
    if (switchThrough) {
      allRuns.push(
        ...(await verifySwitch(db, service, processor, employees[0]!, [
          switchThrough,
          engine,
        ])),
      );
      assert.equal(
        (await service.getRun(employees[0]!.subject, employees[0]!.runId))
          .engine,
        engine,
      );
    }
    assert.deepEqual(fixture.violations, []);
    for (const id of allRuns) {
      const events = JSON.stringify(
        (
          await db.pool.query(
            "SELECT data FROM cw_run_events WHERE run_id=$1",
            [id],
          )
        ).rows,
      );
      for (const key of keys) assert.equal(events.includes(key), false);
      assert.ok(
        (await readdir(directory)).includes(id),
        "Each Run must have its own runtime home.",
      );
    }
    await inspectHomes(directory, keys);
  } finally {
    await db.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    if (oldDirectory === undefined) delete process.env.RUNTIME_DIR;
    else process.env.RUNTIME_DIR = oldDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}
