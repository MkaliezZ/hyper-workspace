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
import { FollowUpScheduleService } from "../../apps/api/src/core/follow-up-schedules.js";
import { MethodsService } from "../../apps/api/src/core/methods.js";
import type { MethodPlan } from "@hyper/contracts";

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
    const fileReadingRevision = JSON.stringify(body.messages).includes(
      "native-file-revision-fixture",
    );
    const followUp =
      /native-follow-up-fixture|Check only this authorized project's current product tasks\./.test(
        JSON.stringify(body.messages),
      );
    const configureFollowUp = JSON.stringify(body.messages).includes(
      "Host-bound follow-up plan.",
    );
    const configurePolicy = JSON.stringify(body.messages).includes(
      "Host-bound execution policy plan.",
    );
    const usageReport = JSON.stringify(body.messages).includes(
      "Host-bound personal model usage query.",
    );
    if (configurePolicy && cap !== 128)
      violations.push(
        "Execution policy token bound was not passed to the native runtime",
      );
    const artifactReview = JSON.stringify(body.messages).includes(
      "Host-bound artifact review decision.",
    );
    const taskRevision = JSON.stringify(body.messages).includes(
      "Host-bound task revision.",
    );
    if (
      artifactReview &&
      /protocol-fixture-model-result|protocol-fixture-revision/.test(
        JSON.stringify(body.messages),
      )
    )
      violations.push("Review dispatch included artifact content");
    const methodDraft = JSON.stringify(body.messages).includes(
      "Host-bound method draft.",
    );
    const methodManagement = JSON.stringify(body.messages).includes(
      "Host-bound method management.",
    );
    if (
      methodManagement &&
      /protocol-fixture-model-result|protocol-fixture-method-guidance/.test(
        JSON.stringify(body.messages),
      )
    )
      violations.push("Method management dispatch included body");
    const text = JSON.stringify({
      text: "已准备测试成果。",
      actions: [
        usageReport
          ? { tool: "usage.report", args: {} }
          : configurePolicy
            ? { tool: "policy.configure", args: {} }
            : methodDraft
              ? {
                  tool: "method.write",
                  args: {
                    title: "Protocol fixture method candidate",
                    kind: "sop",
                    content:
                      "protocol-fixture-method-guidance: check evidence before output.",
                  },
                }
              : methodManagement
                ? { tool: "method.manage", args: {} }
                : taskRevision
                  ? {
                      tool: "task.update",
                      args: {
                        title: "protocol-fixture-task-update",
                        status: "done",
                      },
                    }
                  : artifactReview
                    ? { tool: "artifact.review", args: {} }
                    : configureFollowUp
                      ? { tool: "follow_up.configure", args: {} }
                      : followUp
                        ? { tool: "follow_up.check", args: {} }
                        : fileReading
                          ? {
                              tool: "file.reading.save",
                              args: {
                                content:
                                  (fileReadingRevision
                                    ? "private-native-file-revision-"
                                    : "private-native-file-reading-") +
                                  employee,
                              },
                            }
                          : draftReply
                            ? {
                                tool: "communication.draft",
                                args: {
                                  content:
                                    "private-native-reply-draft-" + employee,
                                },
                              }
                            : revision
                              ? {
                                  tool: "artifact.revise",
                                  args: {
                                    content:
                                      "protocol-fixture-revision " + revision,
                                  },
                                }
                              : {
                                  tool: "artifact.create",
                                  args: {
                                    title: "Native runtime test " + employee,
                                    content:
                                      "protocol-fixture-model-result " +
                                      employee,
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
              ...(choice.finish_reason
                ? {
                    usage: {
                      prompt_tokens: 8,
                      completion_tokens: 8,
                      total_tokens: 16,
                    },
                  }
                : {}),
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

async function verifyArtifactReview(
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engines: NativeEngine[],
) {
  const id = employee.artifactId!,
    runs: string[] = [];
  const before = await service.artifact(employee.subject, id);
  for (const [index, engine] of engines.entries()) {
    const plan = {
      expectedVersion: before.current.version,
      expectedReviewRevision: index,
      decision:
        index === 0 ? ("accept" as const) : ("request_changes" as const),
      feedback: "Synthetic employee-confirmed review " + index,
      confirmed: true as const,
    };
    const run = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      engine,
      workflow: "review_artifact",
      artifactId: id,
      artifactReviewPlan: plan,
      instruction: "Record only this confirmed employee decision.",
      modelProfileId: employee.modelId,
      idempotencyKey: randomUUID(),
    });
    runs.push(run.id);
    await processor.process(run.id);
    const result = await service.getRun(employee.subject, run.id);
    assert.equal(result.state, "succeeded", result.error ?? "review failed");
    const saved = result.result.receipts[0];
    assert.equal(saved.tool, "artifact.review");
    assert.equal(saved.artifactId, id);
    assert.equal(saved.version, plan.expectedVersion);
    assert.equal(saved.reviewRevision, index + 1);
    assert.equal(saved.channel, "ai_assisted");
    assert.equal(saved.sourceRunId, run.id);
    const detail = await service.artifact(employee.subject, id);
    assert.equal(detail.current.content, before.current.content);
    assert.equal(
      detail.current.status,
      index === 0 ? "accepted" : "changes_requested",
    );
  }
  await service.revise(employee.subject, id, {
    content: before.current.content + "\nSynthetic manual update after review.",
    feedback: "Preserve acceptance history while creating a fresh draft.",
    expectedVersion: before.current.version,
  });
  const next = await service.artifact(employee.subject, id);
  assert.equal(next.current.status, "draft");
  assert.equal(next.current.version, before.current.version + 1);
  assert.equal(next.current.acceptedVersion, null);
  assert.equal(next.reviews.length, 2);
  assert.equal(next.versions[1].status, "changes_requested");
  return runs;
}

async function verifyMethods(
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engine: NativeEngine,
) {
  const methods = new MethodsService(service.db),
    source = await service.artifact(employee.subject, employee.artifactId!);
  const projectId = (
    await service.conversation(employee.subject, employee.conversation)
  ).project_id;
  const perform = async (plan: MethodPlan) => {
    const run = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      workflow: "manage_method",
      methodPlan: plan,
      engine,
      modelProfileId: employee.modelId,
      instruction: "Use only the selected source and confirmed operation.",
      idempotencyKey: randomUUID(),
    });
    await processor.process(run.id);
    const result = await service.getRun(employee.subject, run.id);
    assert.equal(result.state, "succeeded", result.error);
    return { run, result };
  };
  const created = await perform({
      operation: "create",
      sourceArtifactId: employee.artifactId!,
      expectedSourceVersion: source.current.version,
    }),
    m = created.result.result.receipts[0];
  assert.equal(m.state, "candidate");
  assert.equal(m.verification, "candidate");
  const verified = await methods.record(employee.subject, projectId, {
    plan: {
      operation: "verify",
      methodId: m.id,
      expectedVersion: m.version,
      expectedRevision: m.revision,
      evidence: "Synthetic employee verification declaration.",
      confirmed: true,
    },
    idempotencyKey: randomUUID(),
  });
  const published = await perform({
    operation: "publish",
    methodId: m.id,
    expectedVersion: verified.version,
    expectedRevision: verified.revision,
    scope: "project",
    confirmed: true,
  });
  const current = (await methods.get(employee.subject, m.id)).current;
  const reuse = await service.startRun(employee.subject, {
    conversationId: employee.conversation,
    workflow: "project_report",
    engine,
    modelProfileId: employee.modelId,
    instruction:
      "Apply the selected published method as guidance, keep current facts separate.",
    methodRefs: [
      { id: m.id, version: current.version, revision: current.revision },
    ],
    idempotencyKey: randomUUID(),
  });
  await processor.process(reuse.id);
  const result = await service.getRun(employee.subject, reuse.id);
  assert.equal(result.state, "succeeded", result.error);
  assert.ok(
    result.contextRefs.includes(
      "method:" + m.id + "@" + current.version + "#" + current.revision,
    ),
  );
  assert.equal(
    (await methods.get(employee.subject, m.id)).uses[0].runId,
    reuse.id,
  );
  await methods.record(employee.subject, projectId, {
    plan: {
      operation: "withdraw",
      methodId: m.id,
      expectedVersion: current.version,
      expectedRevision: current.revision,
      reason: "Synthetic retirement after reuse.",
      confirmed: true,
    },
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    (await methods.get(employee.subject, m.id)).current.state,
    "withdrawn",
  );
  return [created.run.id, published.run.id, reuse.id];
}

async function verifyTaskRevision(
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engine: NativeEngine,
) {
  const task = await service.createTask(
    employee.subject,
    employee.conversation,
    {
      title: "Native task before revision",
      assignee: "Synthetic label",
      dueDate: null,
    },
  );
  const run = await service.startRun(employee.subject, {
    conversationId: employee.conversation,
    workflow: "revise_task",
    taskId: task.id,
    expectedTaskVersion: task.version,
    engine,
    modelProfileId: employee.modelId,
    instruction:
      "Update the selected task record title and mark its record done.",
    idempotencyKey: randomUUID(),
  });
  await processor.process(run.id);
  const result = await service.getRun(employee.subject, run.id);
  assert.equal(result.state, "succeeded", result.error);
  assert.equal(result.result.receipts[0].id, task.id);
  assert.equal(result.result.receipts[0].version, 2);
  assert.equal(result.result.receipts[0].status, "done");
  const detail = await service.task(employee.subject, task.id);
  assert.equal(detail.current.title, "protocol-fixture-task-update");
  assert.equal(detail.history[0].sourceRunId, run.id);
  assert.equal(detail.history[0].channel, "ai");
  return run.id;
}

async function verifyFollowUp(
  db: Database,
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engines: NativeEngine[],
) {
  const task = await service.createTask(
    employee.subject,
    employee.conversation,
    {
      title: "Native follow-up synthetic task",
      assignee: "Runtime test",
      dueDate: null,
    },
  );
  const runs: string[] = [];
  for (const [index, engine] of engines.entries()) {
    if (index === 1)
      await service.patchTask(employee.subject, task.id, { status: "done" });
    const run = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      engine,
      workflow: "follow_up",
      instruction: "native-follow-up-fixture: compare only current tasks.",
      modelProfileId: employee.modelId,
      idempotencyKey: randomUUID(),
    });
    runs.push(run.id);
    await processor.process(run.id);
    const result = await service.getRun(employee.subject, run.id);
    assert.equal(result.state, "succeeded", result.error);
    const receipt = result.result.receipts[0];
    assert.equal(receipt.notify, index === 1);
    assert.equal(receipt.reason, ["baseline", "changed", "unchanged"][index]);
    assert.ok(
      result.contextRefs.every((ref: string) => ref.startsWith("task:")),
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT id FROM cw_messages WHERE metadata->>'runId'=$1",
          [run.id],
        )
      ).rowCount,
      index === 1 ? 1 : 0,
    );
  }
  return runs;
}

async function verifyScheduledFollowUp(
  db: Database,
  service: WorkspaceService,
  processor: RunProcessor,
  employee: Employee,
  engine: NativeEngine,
) {
  const configuration = await service.startRun(employee.subject, {
    conversationId: employee.conversation,
    engine,
    workflow: "configure_follow_up",
    instruction: "Create the explicitly selected finite follow-up schedule.",
    modelProfileId: employee.modelId,
    followUpPlan: { operation: "create", intervalMinutes: 15, maxChecks: 2 },
    idempotencyKey: randomUUID(),
  });
  await processor.process(configuration.id);
  const saved = await service.getRun(employee.subject, configuration.id);
  assert.equal(saved.state, "succeeded", saved.error);
  const schedule = saved.result.receipts[0];
  assert.equal(schedule.modelProfileId, employee.modelId);
  assert.equal(schedule.engine, engine);
  const scheduler = new FollowUpScheduleService(service);
  const runs = await scheduler.dispatchDue();
  assert.equal(runs.length, 1);
  await processor.process(runs[0]!);
  assert.equal(
    (await service.getRun(employee.subject, runs[0]!)).state,
    "succeeded",
  );
  const current = (
    await scheduler.list(employee.subject, employee.conversation)
  ).find((row) => row.id === schedule.id)!;
  const cancel = await service.startRun(employee.subject, {
    conversationId: employee.conversation,
    engine,
    workflow: "configure_follow_up",
    instruction: "Cancel this selected follow-up.",
    modelProfileId: employee.modelId,
    followUpPlan: {
      operation: "cancel",
      scheduleId: schedule.id,
      expectedVersion: current.version,
    },
    idempotencyKey: randomUUID(),
  });
  await processor.process(cancel.id);
  assert.equal(
    (await service.getRun(employee.subject, cancel.id)).state,
    "succeeded",
  );
  assert.equal(
    (await scheduler.list(employee.subject, employee.conversation)).find(
      (row) => row.id === schedule.id,
    )!.state,
    "cancelled",
  );
  return [configuration.id, ...runs, cancel.id];
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
      allRuns.push(
        ...(await verifyFollowUp(db, service, processor, employees[0]!, [
          engine,
          switchThrough,
          engine,
        ])),
      );
    }
    assert.deepEqual(fixture.violations, []);
    allRuns.push(
      ...(await verifyScheduledFollowUp(
        db,
        service,
        processor,
        employees[0]!,
        engine,
      )),
    );
    allRuns.push(
      ...(await verifyArtifactReview(service, processor, employees[0]!, [
        engine,
        switchThrough ?? engine,
      ])),
    );
    allRuns.push(
      await verifyTaskRevision(service, processor, employees[0]!, engine),
    );
    allRuns.push(
      ...(await verifyMethods(service, processor, employees[0]!, engine)),
    );
    const employee = employees[0]!;
    const policyRun = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      engine,
      workflow: "configure_policy",
      instruction:
        "Apply only the confirmed synthetic personal execution rule.",
      policyPlan: {
        scope: "personal",
        expectedRevision: 0,
        rules: { maxOutputTokens: 256, expression: "concise" },
        confirmed: true,
      },
      taskRules: { maxOutputTokens: 128 },
      modelProfileId: employee.modelId,
      idempotencyKey: randomUUID(),
    });
    allRuns.push(policyRun.id);
    await processor.process(policyRun.id);
    const policyResult = await service.getRun(employee.subject, policyRun.id);
    assert.equal(policyResult.state, "succeeded", policyResult.error);
    assert.equal(policyResult.result.receipts[0].scope, "personal");
    assert.equal(policyResult.result.receipts[0].rules.maxOutputTokens, 256);
    assert.equal(policyResult.executionPolicy.effective.maxOutputTokens, 128);
    const usageRun = await service.startRun(employee.subject, {
      conversationId: employee.conversation,
      engine,
      workflow: "usage_report",
      instruction: "Read only my actual usage ledger.",
      modelProfileId: employee.modelId,
      idempotencyKey: randomUUID(),
    });
    allRuns.push(usageRun.id);
    await processor.process(usageRun.id);
    const usageResult = await service.getRun(employee.subject, usageRun.id);
    assert.equal(usageResult.state, "succeeded", usageResult.error);
    assert.ok(usageResult.result.receipts[0].summary.requests > 0);
    assert.equal(usageResult.result.receipts[0].summary.incomplete, 0);
    const requestRows = await db.pool.query(
      "SELECT run_id,usage_status,input_tokens,output_tokens FROM cw_model_requests WHERE run_id=ANY($1::uuid[])",
      [allRuns],
    );
    assert.ok(requestRows.rowCount! >= allRuns.length);
    assert.ok(
      requestRows.rows.every(
        (row) =>
          row.usage_status === "reported" &&
          Number(row.input_tokens) === 8 &&
          Number(row.output_tokens) === 8,
      ),
    );
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
