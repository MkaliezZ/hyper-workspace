import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "../apps/api/src/db/database.js";
import { WorkspaceService } from "../apps/api/src/core/workspace.js";
import { RunProcessor } from "../apps/api/src/core/processor.js";
import { Vault } from "../apps/api/src/core/credentials.js";
import { NotificationPolicyService } from "../apps/api/src/core/notification-policy.js";
import { requireNextcloud } from "../apps/api/src/providers/nextcloud.js";
import { engineRegistry } from "../apps/api/src/engines/adapters.js";
import { TalkManagementFixture } from "../tests/fixtures/talk-management.js";
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        execute:
          "Add --execute after reviewing the model profile and provider pricing",
        profileEnvironment: "REAL_MODEL_PROFILE_ID",
        workspace: "Seeded demo workspace only",
        businessRuns: 14,
        actualHttpRequests: "Recorded, not a provider billing hard cap",
        executionMayBeBillable: true,
        requestsSent: 0,
        source: "Synthetic loopback HTTP fixture, no company originals",
        output: ".runtime/private-model-checks/dual-business-*",
      }),
    );
    process.exit(0);
  }
  if (args.length !== 1 || args[0] !== "--execute") {
    throw new Error("invalid arguments");
  }
  const profileId = process.env.REAL_MODEL_PROFILE_ID;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      profileId ?? "",
    )
  ) {
    console.error(
      "Set REAL_MODEL_PROFILE_ID to an existing demo chat profile UUID; never provide an API key.",
    );
    process.exitCode = 1;
    return;
  }
  const db = new Database(),
    source = new TalkManagementFixture(),
    dir = resolve(
      ".runtime/private-model-checks",
      "dual-business-" +
        new Date().toISOString().replaceAll(":", "-") +
        "-" +
        randomUUID().slice(0, 8),
    );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const report: any = {
    date: new Date().toISOString(),
    supplier: "DeepSeek",
    model: "deepseek-flash",
    source:
      "Synthetic loopback HTTP protocol fixture, not real Nextcloud/company data",
    runs: [],
    projects: [],
    maxBusinessRuns: 14,
  };
  let credential: string | undefined;
  async function save() {
    await writeFile(
      resolve(dir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  try {
    const profile = (
      await db.pool.query(
        "SELECT p.workspace_id,p.owner_id,p.model,p.endpoint,p.provider,u.name,m.role FROM cw_model_profiles p JOIN cw_users u ON u.id=p.owner_id JOIN cw_members m ON m.user_id=p.owner_id AND m.workspace_id=p.workspace_id WHERE p.id=$1 AND p.purpose=\u0027chat\u0027",
        [profileId],
      )
    ).rows[0];
    assert.ok(profile, "Select a currently owned chat profile.");
    assert.equal(profile.workspace_id, "00000000-0000-4000-8000-000000000001");
    assert.equal(profile.owner_id, "00000000-0000-4000-8000-000000000011");
    assert.equal(profile.model, "deepseek-flash");
    assert.equal(profile.endpoint, "https://api.deepseek.com");
    assert.equal(profile.provider, "openai-compatible");
    const peerId = "00000000-0000-4000-8000-000000000012";
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
          [profile.workspace_id, peerId],
        )
      ).rows[0].n,
      1,
    );
    const base = await source.start();
    Object.assign(process.env, {
      NEXTCLOUD_URL: base,
      NEXTCLOUD_INTERNAL_URL: base,
      NEXTCLOUD_WORKSPACE_ID: profile.workspace_id,
      NEXTCLOUD_MEMBER_GROUP: "synthetic-staff",
      NEXTCLOUD_TALK_ENABLED: "true",
      RUNTIME_DIR: resolve(dir, "runs"),
    });
    const config = requireNextcloud(),
      identity = randomUUID();
    credential = randomUUID();
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)",
      [
        identity,
        config.providerKey,
        "operator",
        profile.owner_id,
        profile.workspace_id,
        randomUUID(),
        "peer",
        peerId,
      ],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [
        credential,
        identity,
        "operator",
        new Vault().encrypt("synthetic-password"),
      ],
    );
    const actor = {
        id: profile.owner_id,
        workspaceId: profile.workspace_id,
        name: profile.name,
        role: profile.role,
        demo: false,
        identityCredentialId: credential,
      },
      work = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(work),
      notifications = new NotificationPolicyService(db);
    async function run(
      project: any,
      engine: "dsh" | "hermes",
      workflow: any,
      instruction: string,
      extra: any = {},
    ) {
      assert.ok(report.runs.length < 14);
      const input = {
        conversationId: project.conversationId,
        engine,
        workflow,
        instruction,
        modelProfileId: profileId,
        idempotencyKey: randomUUID(),
        taskRules: {
          maxActions: 4,
          maxOutputTokens: 2048,
          maxDurationSeconds: 120,
          maxContextBytes: 50000,
        },
        ...extra,
      };
      const started = await work.startRun(actor, input);
      await processor.process(started.id);
      const actual = await work.getRun(actor, started.id);
      const requests = (
        await db.pool.query(
          "SELECT transport,http_status,usage_status,input_tokens::text,output_tokens::text,cost_status FROM cw_model_requests WHERE run_id=$1 ORDER BY started_at",
          [started.id],
        )
      ).rows;
      report.runs.push({
        id: started.id,
        engine,
        workflow,
        projectId: project.id,
        state: actual.state,
        error: actual.error,
        evidence: actual.result?.evidence,
        contextRefs: actual.contextRefs,
        result: actual.result,
        requests,
      });
      await save();
      assert.equal(actual.state, "succeeded");
      assert.equal(actual.result.evidence, "runtime");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].http_status, 200);
      assert.notEqual(requests[0].transport, "rejected");
      assert.ok(
        ["reported", "partial", "unknown", "invalid"].includes(
          requests[0].usage_status,
        ),
      );
      return actual;
    }
    for (const engine of ["dsh", "hermes"] as const) {
      const room = source.addRoom("Synthetic dual-engine business " + engine);
      room.messages.length = 0;
      const inputs = [
        [
          "operator",
          "合成验收讨论，日期 2026-11-01。确定两项工作：operator 负责提交内测清单，截止日期 2026-11-04；peer 负责完成风险表草稿，截止日期 2026-11-05。当前均未完成。",
        ],
        [
          "peer",
          "确认上述分工与日期。发布审批尚未获得，依赖的 DNS 问题尚未确认，请明确列为风险与未知，不要写成已上线。",
        ],
        [
          "operator",
          "这是合成样例，不是公司真实会议。只形成一份纪要与上述两条待办，未决定向外部群组发送任何消息。",
        ],
      ];
      for (const [uid, text] of inputs) source.message(room, uid!, text!);
      const project = await work.createTalkProject(
        actor,
        room.token,
        "Synthetic real supplier dual business " + engine,
        "合成验收：只按本房间明确分工和日期准备内部演示，审批未通过。",
      );
      const record: any = {
        ...project,
        engine,
        roomId: room.token,
        inputs: inputs.map(([author, content]) => ({ author, content })),
        tasks: [],
      };
      report.projects.push(record);
      await save();
      const minutes = await run(
        project,
        engine,
        "discussion_to_minutes",
        "仅按当前来源消息保存一份纪要和恰好两条待办。保留两位负责人 UID 与准确的 YYYY-MM-DD 截止日期；审批未获、DNS 未确认及合成样例标记必须明确，不新增推断工作。",
      );
      const tasks = (
        await db.pool.query(
          'SELECT id,title,version,assignee,assignee_id AS "assigneeId",to_char(due_date,\'YYYY-MM-DD\') AS "dueDate",status FROM cw_tasks WHERE project_id=$1 ORDER BY due_date,id',
          [project.id],
        )
      ).rows;
      assert.equal(tasks.length, 2);
      assert.deepEqual(
        tasks.map((t) => t.dueDate),
        ["2026-11-04", "2026-11-05"],
      );
      for (const task of tasks) {
        const assigneeId = task.dueDate === "2026-11-04" ? actor.id : peerId;
        await run(
          project,
          engine,
          "assign_task",
          "只按我已明确选定的测试员工身份分配此待办，不通知任何人，不授予权限。",
          {
            taskAssignmentPlan: {
              taskId: task.id,
              expectedVersion: task.version,
              assigneeId,
              confirmed: true,
            },
          },
        );
        const current = (await work.task(actor, task.id)).current;
        assert.equal(current.assigneeId, assigneeId);
        assert.equal(current.status, "open");
        record.tasks.push(current);
      }
      const artifacts = (
        await db.pool.query("SELECT id FROM cw_artifacts WHERE project_id=$1", [
          project.id,
        ])
      ).rows;
      assert.equal(artifacts.length, 1);
      record.artifactId = artifacts[0].id;
      const initial = await work.artifact(actor, record.artifactId);
      assert.equal(initial.current.version, 1);
      assert.ok(initial.current.sourceMessageIds.length >= 3);
      record.initial = initial.current;
      const other = engine === "dsh" ? "hermes" : "dsh";
      await run(
        project,
        other,
        "revise_artifact",
        "保留同一成果 ID 和原始依据，将纪要重写为“结果、负责人、下一步、风险与未知”四部分。明确“合成样例，不是公司真实会议”；审批仍未获得、DNS 仍未确认，不写成已上线，不新建待办。",
        { artifactId: record.artifactId },
      );
      const changed = await work.artifact(actor, record.artifactId);
      assert.equal(changed.current.version, 2);
      assert.equal(changed.versions.length, 2);
      assert.equal(changed.current.status, "draft");
      record.revised = changed.current;
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
            [project.id],
          )
        ).rows[0].n,
        2,
      );
      await save();
    }
    const project = report.projects[0],
      first = await run(
        project,
        "dsh",
        "follow_up",
        "只核对当前授权项目待办，根据产品的现行提醒规则决定是否合并通知。",
      );
    assert.equal(first.result.receipts[0].notify, false);
    assert.equal(first.result.receipts[0].reason, "baseline");
    const unchanged = await run(
      project,
      "hermes",
      "follow_up",
      "只核对当前授权项目待办，未变化时保持安静。",
    );
    assert.equal(unchanged.result.receipts[0].notify, false);
    await notifications.save(
      actor,
      project.id,
      {
        operation: "configure",
        scope: "project",
        expectedRevision: 0,
        rules: { mode: "quiet" },
        confirmed: true,
      },
      randomUUID(),
    );
    const task = (await work.task(actor, project.tasks[0].id)).current;
    await work.patchTask(actor, task.id, {
      expectedVersion: task.version,
      status: "done",
    });
    for (const engine of ["dsh", "hermes"] as const) {
      const quiet = await run(
        project,
        engine,
        "follow_up",
        "只按当前权限核对进展，并遵守项目静默偏好。",
      );
      assert.equal(quiet.result.receipts[0].notify, false);
      assert.equal(quiet.result.receipts[0].notification.reason, "quiet");
    }
    await notifications.save(
      actor,
      project.id,
      {
        operation: "configure",
        scope: "project",
        expectedRevision: 1,
        rules: { mode: "important", importantFields: ["status"] },
        confirmed: true,
      },
      randomUUID(),
    );
    const published = await run(
      project,
      "dsh",
      "follow_up",
      "只按当前提醒规则合并此前尚未通知的重要变化。",
    );
    assert.equal(published.result.receipts[0].notify, true);
    const last = await run(
      project,
      "hermes",
      "follow_up",
      "核对同一项目，已通知且没有新变化时保持安静。",
    );
    assert.equal(last.result.receipts[0].notify, false);
    const notices = (
      await db.pool.query(
        "SELECT id,content,metadata FROM cw_messages WHERE conversation_id=$1 AND metadata->'receipts' @> '[{\"tool\":\"follow_up.check\"}]'::jsonb",
        [project.conversationId],
      )
    ).rows;
    assert.equal(notices.length, 1);
    report.notificationTrace = notices;
    report.finalTasks = [];
    for (const p of report.projects) {
      for (const saved of p.tasks) {
        const current = (await work.task(actor, saved.id)).current;
        const expected =
          p.id === project.id && saved.id === task.id ? "done" : "open";
        assert.equal(current.status, expected);
        assert.equal(current.assigneeId, saved.assigneeId);
        assert.equal(current.dueDate, saved.dueDate);
        report.finalTasks.push(current);
      }
    }
    assert.equal(source.writes.length, 0);
    report.status = "passed";
    report.sourceWrites = 0;
    report.usageIncomplete = report.runs
      .filter((r: any) =>
        r.requests.some(
          (q: any) =>
            q.transport !== "completed" || q.usage_status !== "reported",
        ),
      )
      .map((r: any) => r.id);
    report.supplierCalls = report.runs.reduce(
      (n: number, r: any) => n + r.requests.length,
      0,
    );
    assert.equal(report.supplierCalls, 14);
  } catch (error: any) {
    report.status = "failed";
    report.failure = {
      name: error?.name,
      message:
        error?.name === "AssertionError"
          ? error.message
          : "验收未完成；请在受控环境核对产品回执和模型连接。",
    };
    process.exitCode = 1;
  } finally {
    const cleanupFailures: string[] = [];
    if (credential) {
      try {
        await db.pool.query(
          "UPDATE cw_identity_credentials SET disabled_at=clock_timestamp(),credential_enc='' WHERE id=$1",
          [credential],
        );
      } catch {
        cleanupFailures.push("synthetic_credential_disable");
      }
    }
    source.rooms.clear();
    try {
      await source.close();
      report.syntheticSourceRemoved = true;
    } catch {
      report.syntheticSourceRemoved = false;
      cleanupFailures.push("synthetic_source_close");
    }
    report.cleanupFailures = cleanupFailures;
    if (cleanupFailures.length) {
      report.status = "failed";
      process.exitCode = 1;
    }
    try {
      await save();
    } finally {
      await db.close();
    }
    console.log(
      JSON.stringify({
        status: report.status,
        reportDirectory: dir,
        businessRuns: report.runs.length,
        supplierRequests: report.runs.reduce(
          (n: number, r: any) => n + r.requests.length,
          0,
        ),
        usageIncomplete: report.usageIncomplete?.length ?? null,
        cleanupFailures,
      }),
    );
  }
}
main().catch(() => {
  console.error(
    "Real business check did not finish; inspect the private product receipts and configuration. No connection secrets are printed.",
  );
  process.exitCode = 1;
});
