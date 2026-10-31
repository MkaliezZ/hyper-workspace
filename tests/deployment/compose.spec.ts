import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:8080";
const args = [
  "compose",
  "--project-name",
  process.env.COMPOSE_TEST_PROJECT ?? "hyper-deployment-ci",
  "--env-file",
  process.env.COMPOSE_TEST_ENV ?? ".runtime/compose-ci.env",
  "-f",
  "compose.yaml",
  "-f",
  "deploy/compose.ci.yaml",
];
function compose(...command: string[]) {
  return execFileSync("docker", [...args, ...command], {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function session(context: any) {
  // Issue a synthetic demo session from the API container's own loopback. Never weaken the public login check.
  const raw = compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `const r=await fetch('http://127.0.0.1:3100/api/auth/demo',{method:'POST',headers:{Origin:process.env.APP_ORIGIN}});if(!r.ok)process.exit(1);process.stdout.write(r.headers.get('set-cookie').split(';')[0]);`,
  );
  const split = raw.indexOf("=");
  expect(split).toBeGreaterThan(0);
  await context.addCookies([
    {
      name: raw.slice(0, split),
      value: raw.slice(split + 1),
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

test("Compiled restricted containers extract all four document formats without engine credentials", async () => {
  const fixture = readFileSync("tests/fixtures/document-source.py", "utf8");
  const script = `
    import {execFileSync} from 'node:child_process';
    import {DocumentExtractor} from './dist/core/document-extraction.js';
    const generator=${JSON.stringify(fixture)};
    const host=new DocumentExtractor();
    const result=[];
    for(const format of ['pdf','docx','xlsx','pptx']) {
      const token='synthetic-container-document-'+format;
      const bytes=execFileSync('/app/.runtime/documents/bin/python',['-c',generator,format,token]);
      const parsed=await host.extract(bytes,format);
      if(!parsed.text.includes(token)||!parsed.sections.length) throw Error('Missing extraction result');
      result.push({format,parserVersion:parsed.parserVersion});
    }
    process.stdout.write(JSON.stringify(result));`;
  const result = JSON.parse(
    compose("exec", "-T", "api", "node", "--input-type=module", "-e", script),
  );
  expect(result).toEqual(
    ["pdf", "docx", "xlsx", "pptx"].map((format) => ({
      format,
      parserVersion: "document-text-v1",
    })),
  );
});
async function completed(request: any, id: string) {
  await expect
    .poll(
      async () => {
        const r = await request.get("/api/runs/" + id);
        const value = await r.json();
        return value.state === "failed" ? value.error : value.state;
      },
      { timeout: 75000, intervals: [1000] },
    )
    .toBe("succeeded");
  return (await request.get("/api/runs/" + id)).json();
}
test("API and Worker use the restricted role without administrator credentials or business schema privileges", async () => {
  for (const service of ["api", "worker"]) {
    const report = JSON.parse(
      compose(
        "exec",
        "-T",
        service,
        "node",
        "--input-type=module",
        "-e",
        `
      import {Pool} from 'pg';
      const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
      try {
        const {rows:[role]}=await pool.query("SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS business_ddl,has_table_privilege(current_user,'public.cw_migrations','UPDATE') AS edit_migrations,has_database_privilege(current_user,current_database(),'TEMP') AS temporary_tables FROM pg_roles WHERE rolname=current_user");
        const denied=[];
        for(const sql of ["ALTER TABLE cw_users ADD COLUMN forbidden text","SELECT * FROM pg_authid","SELECT pg_read_file('postgresql.conf')"]){
          try{await pool.query(sql);denied.push('unexpected-success')}catch(error){denied.push(error.code)}
        }
        process.stdout.write(JSON.stringify({role,denied,adminEnvironment:'DB_PASSWORD' in process.env || 'DB_RUNTIME_PASSWORD' in process.env}));
      }finally{await pool.end()}
    `,
      ),
    );
    expect(report).toEqual({
      role: {
        name: "hyper_runtime",
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        business_ddl: false,
        edit_migrations: false,
        temporary_tables: false,
      },
      denied: ["42501", "42501", "42501"],
      adminEnvironment: false,
    });
  }
});
test("Built containers serve only the compiled web app and preserve native DSH/Hermes revisions across restart", async ({
  browser,
  request,
}) => {
  expect((await request.get("/api/health")).status()).toBe(200);
  // Host-to-container NAT is deliberately not treated as loopback.
  expect(
    (
      await request.post("/api/auth/demo", {
        headers: { Origin: origin },
        data: {},
      })
    ).status(),
  ).toBe(403);
  for (const path of [
    "/package.json",
    "/.env",
    "/.runtime/hermes-install.json",
    "/runtime/hermes/lock.json",
    "/AGENTS.md",
    "/apps/api/src/main.ts",
  ])
    expect([403, 404]).toContain((await request.get(path)).status());
  const context = await browser.newContext({ baseURL: origin });
  await session(context);
  try {
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await expect(page).toHaveTitle(/Hyper Workspace/);
    await expect(
      page.getByRole("navigation", { name: "工作区导航", exact: true }),
    ).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const html = await (await request.get("/")).text();
    expect(html).toContain("/assets/");
    expect(html).not.toContain("/@vite/client");
    const workspace = await (
      await context.request.get(origin + "/api/workspace")
    ).json();
    expect(workspace.engines.dsh.configured).toBe(true);
    expect(workspace.engines.hermes.configured).toBe(true);
    const profile = await context.request.post(origin + "/api/models", {
      headers: { Origin: origin },
      data: {
        name: "Synthetic container model",
        provider: "openai-compatible",
        endpoint: "http://model-fixture:8100/v1",
        model: "compose-model",
        purpose: "chat",
        scope: "personal",
        apiKey: "synthetic-compose-model-key",
      },
    });
    expect(profile.status()).toBe(201);
    const modelId = (await profile.json()).id;
    const briefBase =
      origin + "/api/projects/" + workspace.project.id + "/work-briefs";
    const briefResponse = await context.request.post(briefBase, {
      headers: { Origin: origin },
      data: {
        plan: { operation: "create" },
        draft: {
          title: "Container work brief",
          goal: "Persist product context across restarts",
          scope: "The selected product project",
          constraints: "No external sends",
          completionCriteria: "Readable artifact and saved versions",
          questions: [],
        },
        idempotencyKey: randomUUID(),
      },
    });
    expect(briefResponse.status()).toBe(201);
    const brief = await briefResponse.json();
    const confirmedBriefResponse = await context.request.post(briefBase, {
      headers: { Origin: origin },
      data: {
        plan: {
          operation: "confirm",
          briefId: brief.briefId,
          expectedVersion: brief.version,
          confirmed: true,
        },
        idempotencyKey: randomUUID(),
      },
    });
    expect(confirmedBriefResponse.status()).toBe(201);
    const confirmedBrief = await confirmedBriefResponse.json();

    const start = async (
      engine: string,
      workflow: string,
      instruction: string,
      artifactId?: string,
      artifactReviewPlan?: any,
    ) => {
      const r = await context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine,
          workflow,
          instruction,
          artifactId,
          artifactReviewPlan,
          ...(workflow === "discussion_to_minutes"
            ? {
                briefRef: {
                  id: brief.briefId,
                  version: confirmedBrief.version,
                },
              }
            : {}),
          modelProfileId: modelId,
          idempotencyKey: randomUUID(),
        },
      });
      expect(r.status()).toBe(201);
      return (await r.json()).id;
    };
    const dsh = await completed(
      context.request,
      await start("dsh", "discussion_to_minutes", "compose-create"),
    );
    expect(dsh.contextRefs).toContain(
      "work-brief:" + brief.briefId + "@" + confirmedBrief.version,
    );
    const artifactId = dsh.result.receipts[0].id;
    expect(dsh.result.evidence).toBe("runtime");
    const hermes = await completed(
      context.request,
      await start("hermes", "revise_artifact", "compose-revise", artifactId),
    );
    expect(hermes.result.receipts[0]).toMatchObject({
      id: artifactId,
      version: 2,
    });
    const reviewed = await completed(
      context.request,
      await start(
        "dsh",
        "review_artifact",
        "Record the confirmed employee review.",
        artifactId,
        {
          expectedVersion: 2,
          expectedReviewRevision: 0,
          decision: "accept",
          feedback: "Synthetic employee acceptance before restart.",
          confirmed: true,
        },
      ),
    );
    expect(reviewed.result.receipts[0]).toMatchObject({
      artifactId,
      version: 2,
      status: "accepted",
      channel: "ai_assisted",
    });
    const taskResponse = await context.request.post(
      origin +
        "/api/conversations/" +
        workspace.project.conversationId +
        "/tasks",
      {
        headers: { Origin: origin },
        data: {
          title: "Synthetic container task before restart",
          assignee: "Synthetic label",
          dueDate: null,
        },
      },
    );
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();
    const taskRunResponse = await context.request.post(origin + "/api/runs", {
      headers: { Origin: origin },
      data: {
        conversationId: workspace.project.conversationId,
        engine: "hermes",
        workflow: "revise_task",
        taskId: task.id,
        expectedTaskVersion: task.version,
        instruction: "Update this synthetic container task.",
        modelProfileId: modelId,
        idempotencyKey: randomUUID(),
      },
    });
    expect(taskRunResponse.status()).toBe(201);
    const taskRun = await completed(
      context.request,
      (await taskRunResponse.json()).id,
    );
    expect(taskRun.result.receipts[0]).toMatchObject({
      id: task.id,
      version: 2,
      status: "done",
    });
    const directory = await (
      await context.request.get(
        origin + "/api/projects/" + workspace.project.id + "/directory",
      )
    ).json();
    expect(directory.rows.some((p: any) => p.id === workspace.user.id)).toBe(
      true,
    );
    const assignmentResponse = await context.request.post(
      origin + "/api/runs",
      {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          workflow: "assign_task",
          taskAssignmentPlan: {
            taskId: task.id,
            expectedVersion: 2,
            assigneeId: workspace.user.id,
            confirmed: true,
          },
          engine: "dsh",
          modelProfileId: modelId,
          instruction:
            "Only this exact employee identity; no notifications or access grants",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(assignmentResponse.status()).toBe(201);
    const assignmentRun = await completed(
      context.request,
      (await assignmentResponse.json()).id,
    );
    expect(assignmentRun.result.receipts[0]).toMatchObject({
      assigneeId: workspace.user.id,
      version: 3,
    });
    const methodResponse = await context.request.post(origin + "/api/runs", {
      headers: { Origin: origin },
      data: {
        conversationId: workspace.project.conversationId,
        workflow: "manage_method",
        methodPlan: {
          operation: "create",
          sourceArtifactId: artifactId,
          expectedSourceVersion: 2,
        },
        engine: "dsh",
        modelProfileId: modelId,
        instruction:
          "Create only a candidate from the selected synthetic artifact.",
        idempotencyKey: randomUUID(),
      },
    });
    expect(methodResponse.status()).toBe(201);
    const methodCreated = await completed(
        context.request,
        (await methodResponse.json()).id,
      ),
      method = methodCreated.result.receipts[0];
    const methodAction = async (plan: any) => {
      const response = await context.request.post(
        origin + "/api/projects/" + workspace.project.id + "/methods/actions",
        {
          headers: { Origin: origin },
          data: { plan, idempotencyKey: randomUUID() },
        },
      );
      expect(response.status()).toBe(201);
      return response.json();
    };
    const methodVerified = await methodAction({
      operation: "verify",
      methodId: method.id,
      expectedVersion: 1,
      expectedRevision: 1,
      evidence: "Synthetic employee verification before container restart.",
      confirmed: true,
    });
    const methodPublished = await methodAction({
      operation: "publish",
      methodId: method.id,
      expectedVersion: 1,
      expectedRevision: methodVerified.revision,
      scope: "project",
      confirmed: true,
    });
    const schedulePath =
      origin +
      "/api/conversations/" +
      workspace.project.conversationId +
      "/follow-ups";
    const configure = async (plan: any) => {
      const response = await context.request.post(schedulePath, {
        headers: { Origin: origin },
        data: {
          plan,
          engine: "dsh",
          modelProfileId: modelId,
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const schedule = await configure({
      operation: "create",
      intervalMinutes: 15,
      maxChecks: 2,
    });
    const scheduled = async () =>
      (await (await context.request.get(schedulePath)).json()).find(
        (row: any) => row.id === schedule.id,
      );
    await expect
      .poll(async () => !!(await scheduled()).lastRunId, { timeout: 45000 })
      .toBe(true);
    const initial = await scheduled();
    expect(
      (await completed(context.request, initial.lastRunId)).result.receipts[0]
        .notify,
    ).toBe(false);
    const paused = await configure({
      operation: "pause",
      scheduleId: schedule.id,
      expectedVersion: initial.version,
    });
    const nativeBatch = async (data: any) => {
      const response = await context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine: "dsh",
          modelProfileId: modelId,
          instruction: "Execute only this scoped synthetic operation.",
          idempotencyKey: randomUUID(),
          ...data,
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id;
    };
    const pendingPlan = await nativeBatch({
      workflow: "plan_work",
      engine: "dsh",
    });
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get(origin + "/api/runs/" + pendingPlan)
            ).json()
          ).state,
        { timeout: 60000 },
      )
      .toBe("waiting_confirmation");
    const batchDecision = await completed(
      context.request,
      await nativeBatch({
        workflow: "manage_decision",
        decisionPlan: { operation: "create" },
      }),
    );
    const decisionRecord = batchDecision.result.receipts[0];
    await completed(
      context.request,
      await nativeBatch({
        workflow: "manage_decision",
        engine: "hermes",
        decisionPlan: {
          operation: "confirm",
          decisionId: decisionRecord.id,
          expectedVersion: decisionRecord.version,
          confirmed: true,
        },
      }),
    );
    const citationSource = JSON.parse(
      compose(
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
        "-e",
        "import{Database}from'./dist/db/database.js';const d=new Database();try{const r=await d.pool.query('SELECT id,source_version FROM cw_assets WHERE source_ref=$1',['artifact:" +
          artifactId +
          "']);process.stdout.write(JSON.stringify(r.rows[0]));}finally{await d.close();}",
      ),
    );
    const knowledgeRun = await nativeBatch({
      workflow: "query_knowledge",
      engine: "hermes",
      knowledgePlan: {
        query: "What does the synthetic source say?",
        mode: "keyword",
        assetRefs: [
          {
            id: citationSource.id,
            sourceVersion: citationSource.source_version,
          },
        ],
      },
    });
    expect(
      (await completed(context.request, knowledgeRun)).knowledgeAnswer
        .citations[0].assetId,
    ).toBe(citationSource.id);
    compose("stop", "api", "worker", "db");
    compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120");
    await expect
      .poll(
        async () => {
          try {
            return (await request.get("/api/health")).status();
          } catch {
            return 0;
          }
        },
        { timeout: 60000 },
      )
      .toBe(200);
    const restoredBrief = await (
      await context.request.get(briefBase + "/" + brief.briefId)
    ).json();
    expect(restoredBrief.current).toMatchObject({
      version: confirmedBrief.version,
      status: "confirmed",
      content: { goal: "Persist product context across restarts" },
    });
    expect(restoredBrief.history).toHaveLength(2);
    const persistedPlan = await (
      await context.request.get(origin + "/api/runs/" + pendingPlan + "/plan")
    ).json();
    expect(persistedPlan.state).toBe("waiting_confirmation");
    const planConfirmation = await context.request.post(
      origin + "/api/runs/" + pendingPlan + "/plan/responses",
      {
        headers: { Origin: origin },
        data: {
          expectedRevision: persistedPlan.revision,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(planConfirmation.status()).toBe(201);
    expect((await planConfirmation.json()).state).toBe("succeeded");
    const restoredDecision = await (
      await context.request.get(origin + "/api/decisions/" + decisionRecord.id)
    ).json();
    expect(restoredDecision.current.state).toBe("confirmed");
    expect(
      (
        await (
          await context.request.get(origin + "/api/runs/" + knowledgeRun)
        ).json()
      ).knowledgeAnswer.content,
    ).toContain("asset:");
    const transferCandidate = await context.request.post(
      origin + "/api/projects/" + workspace.project.id + "/methods/actions",
      {
        headers: { Origin: origin },
        data: {
          plan: {
            operation: "create",
            sourceArtifactId: artifactId,
            expectedSourceVersion: 2,
          },
          draft: {
            title: "Container transfer candidate",
            kind: "sop",
            content: "Synthetic candidate for ownership migration.",
          },
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(transferCandidate.status()).toBe(201);
    const transferMethod = await transferCandidate.json();
    const transferRun = await completed(
      context.request,
      await nativeBatch({
        workflow: "manage_method",
        engine: "hermes",
        methodPlan: {
          operation: "transfer",
          methodId: transferMethod.id,
          expectedVersion: transferMethod.version,
          expectedRevision: transferMethod.revision,
          maintainerId: "00000000-0000-4000-8000-000000000012",
          confirmed: true,
        },
      }),
    );
    expect(transferRun.result.receipts[0].maintainerId).toBe(
      "00000000-0000-4000-8000-000000000012",
    );

    await page.reload();
    await page.getByRole("tab", { name: "成果", exact: true }).click();
    await page
      .locator(".artifact-list-row")
      .filter({ hasText: "Container native artifact" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "成果内容", exact: true }),
    ).toHaveValue("synthetic-container-version-two");
    const restoredMethod = await (
      await context.request.get(origin + "/api/methods/" + method.id)
    ).json();
    expect(restoredMethod.current).toMatchObject({
      id: method.id,
      version: 1,
      revision: methodPublished.revision,
      state: "published",
      verification: "employee_verified",
      sourceArtifactId: artifactId,
      sourceVersion: 2,
    });
    expect(restoredMethod.versions).toHaveLength(1);
    expect(restoredMethod.actions).toHaveLength(3);
    const withdrawalResponse = await context.request.post(
      origin + "/api/runs",
      {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          workflow: "manage_method",
          methodPlan: {
            operation: "withdraw",
            methodId: method.id,
            expectedVersion: 1,
            expectedRevision: methodPublished.revision,
            reason: "Synthetic employee retirement after restart.",
            confirmed: true,
          },
          engine: "hermes",
          modelProfileId: modelId,
          instruction: "Execute only the confirmed method retirement.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(withdrawalResponse.status()).toBe(201);
    const withdrawal = await completed(
      context.request,
      (await withdrawalResponse.json()).id,
    );
    expect(withdrawal.result.receipts[0]).toMatchObject({
      id: method.id,
      state: "withdrawn",
      version: 1,
      revision: 4,
    });
    const restoredTask = await (
      await context.request.get(origin + "/api/tasks/" + task.id)
    ).json();
    expect(restoredTask.current).toMatchObject({
      id: task.id,
      title: "synthetic-container-task-update",
      version: 3,
      assigneeId: workspace.user.id,
      status: "done",
    });
    expect(restoredTask.history).toHaveLength(3);
    expect(restoredTask.history[0]).toMatchObject({
      channel: "ai",
      sourceRunId: assignmentRun.id,
    });
    expect(
      restoredTask.history.find((v: any) => v.version === 2),
    ).toMatchObject({ channel: "ai", sourceRunId: taskRun.id });
    const saved = await (
      await context.request.get(origin + "/api/artifacts/" + artifactId)
    ).json();
    expect(saved.current.version).toBe(2);
    expect(saved.versions).toHaveLength(2);
    expect(saved.current).toMatchObject({
      status: "accepted",
      acceptedVersion: 2,
      reviewRevision: 1,
    });
    expect(saved.reviews).toHaveLength(1);
    expect(saved.reviews[0].sourceRunId).toBe(reviewed.id);
    expect(
      (
        await context.request.post(
          origin + "/api/artifacts/" + artifactId + "/revisions",
          {
            headers: { Origin: origin },
            data: {
              expectedVersion: 2,
              content: "synthetic-container-version-three",
              feedback: "New draft after accepted version",
            },
          },
        )
      ).status(),
    ).toBe(201);
    const revised = await (
      await context.request.get(origin + "/api/artifacts/" + artifactId)
    ).json();
    expect(revised.current).toMatchObject({
      version: 3,
      status: "draft",
      acceptedVersion: null,
      reviewRevision: 0,
    });
    expect(revised.reviews[0].version).toBe(2);
    const persisted = await scheduled();
    expect(persisted).toMatchObject({
      state: "paused",
      checksStarted: 1,
      lastRunId: initial.lastRunId,
      version: paused.version,
      modelProfileId: modelId,
    });
    expect(
      (
        await context.request.post(
          origin +
            "/api/conversations/" +
            workspace.project.conversationId +
            "/tasks",
          {
            headers: { Origin: origin },
            data: {
              title: "Container scheduled task after restart",
              assignee: "Synthetic employee",
              dueDate: null,
            },
          },
        )
      ).status(),
    ).toBe(201);
    await configure({
      operation: "resume",
      scheduleId: schedule.id,
      expectedVersion: persisted.version,
    });
    await expect
      .poll(async () => (await scheduled()).checksStarted, { timeout: 45000 })
      .toBe(2);
    const final = await scheduled();
    expect(final.state).toBe("completed");
    expect(
      (await completed(context.request, final.lastRunId)).result.receipts[0]
        .notify,
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    const stats = JSON.parse(
      compose(
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
        "-e",
        `process.stdout.write(await(await fetch('http://model-fixture:8100/stats')).text())`,
      ),
    );
    // Five new native requests; confirming the persisted work plan runs host services only.
    expect(stats.calls).toBe(14);
    expect(stats.violations).toBe(0);
  } finally {
    await context.close();
  }
});
test("Interrupted worker containers quarantine expired work without replaying model calls", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ baseURL: origin });
  await session(context);
  try {
    const workspace = await (
      await context.request.get(origin + "/api/workspace")
    ).json();
    const r = await context.request.post(origin + "/api/runs", {
      headers: { Origin: origin },
      data: {
        conversationId: workspace.project.conversationId,
        engine: "dsh",
        workflow: "discussion_to_minutes",
        instruction: "compose-interrupt",
        idempotencyKey: randomUUID(),
      },
    });
    expect(r.status()).toBe(201);
    const id = (await r.json()).id;
    const stats = () =>
      JSON.parse(
        compose(
          "exec",
          "-T",
          "api",
          "node",
          "--input-type=module",
          "-e",
          `process.stdout.write(await(await fetch('http://model-fixture:8100/stats')).text())`,
        ),
      );
    await expect.poll(() => stats().interrupted, { timeout: 45000 }).toBe(1);
    compose("restart", "worker");
    await expect
      .poll(
        async () =>
          (await (await context.request.get(origin + "/api/runs/" + id)).json())
            .state,
        { timeout: 90000, intervals: [2000] },
      )
      .toBe("recovery_required");
    expect(stats().interrupted).toBe(1);
    const after = await (
      await context.request.get(origin + "/api/workspace")
    ).json();
    expect(after.artifacts).toHaveLength(workspace.artifacts.length);
    expect((await request.get("/api/health")).status()).toBe(200);
  } finally {
    await context.close();
  }
});
