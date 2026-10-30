import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes } from "node:crypto";
import { modelFixture } from "../runtime/business-contract";
import { Database } from "../../apps/api/src/db/database.js";
import { source, password, origin, login } from "./helpers";
const db = new Database(process.env.TEST_DATABASE_URL);
test.afterAll(async () => {
  await db.close();
});
async function talk(
  uid: string,
  path: string,
  method = "GET",
  data?: Record<string, string>,
) {
  const response = await fetch(
    source +
      "/ocs/v2.php/apps/spreed/api/" +
      path +
      (path.includes("?") ? "&" : "?") +
      "format=json",
    {
      method,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "OCS-APIRequest": "true",
        Authorization:
          "Basic " + Buffer.from(uid + ":" + password).toString("base64"),
        ...(data
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: data ? new URLSearchParams(data) : undefined,
    },
  );
  expect(response.status).toBeLessThan(300);
  const body = await response.json();
  return body.ocs.data;
}
test("Real Talk group messages use employee credentials, read back sends and deny removed members", async ({
  browser,
}) => {
  const room = await talk("talk-alice", "v4/room", "POST", {
    roomType: "2",
    roomName: "Hyper Talk CI Shared",
  });
  await talk("talk-alice", "v4/room/" + room.token + "/participants", "POST", {
    newParticipant: "talk-bob",
    source: "users",
  });
  const initial = "来自真实 Talk 的测试消息";
  await talk("talk-alice", "v1/chat/" + room.token, "POST", {
    message: initial,
    referenceId: randomBytes(32).toString("hex"),
  });
  const alice = await login(browser, "talk-alice"),
    bob = await login(browser, "talk-bob"),
    outside = await login(browser, "talk-outsider");
  try {
    for (const user of [alice, bob, outside]) {
      await expect(
        user.page.getByRole("heading", { name: "团队讨论", exact: true }),
      ).toBeVisible();
      await user.page
        .getByRole("navigation", { name: "工作区导航" })
        .getByRole("button", { name: "企业消息", exact: true })
        .click();
    }
    await alice.page
      .getByRole("button", { name: "Hyper Talk CI Shared", exact: true })
      .click();
    await bob.page
      .getByRole("button", { name: "Hyper Talk CI Shared", exact: true })
      .click();
    await expect(alice.page.getByText(initial, { exact: true })).toBeVisible();
    await expect(bob.page.getByText(initial, { exact: true })).toBeVisible();
    await expect(
      outside.page.getByRole("button", {
        name: "Hyper Talk CI Shared",
        exact: true,
      }),
    ).toHaveCount(0);
    const denied = await outside.context.request.get(
      origin + "/api/talk/rooms/" + room.token + "/messages",
    );
    expect([403, 404]).toContain(denied.status());
    const message = "Hyper 产品发送并回读的真实 Talk 消息";
    await alice.page
      .getByRole("textbox", { name: "企业消息内容" })
      .fill(message);
    await alice.page
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(
      alice.page.getByRole("textbox", { name: "企业消息内容" }),
    ).toHaveValue("");
    await expect(bob.page.getByText(message, { exact: true })).toBeVisible();
    const key = randomUUID(),
      body = { content: "Hyper Talk 幂等验证", idempotencyKey: key };
    const [one, two] = await Promise.all([
      alice.context.request.post(
        origin + "/api/talk/rooms/" + room.token + "/messages",
        { headers: { Origin: origin }, data: body },
      ),
      alice.context.request.post(
        origin + "/api/talk/rooms/" + room.token + "/messages",
        { headers: { Origin: origin }, data: body },
      ),
    ]);
    expect(one.status()).toBe(201);
    expect(two.status()).toBe(201);
    const a = await one.json(),
      b = await two.json();
    expect(a.id).toBe(b.id);
    const receipt = await alice.context.request.get(
      origin + "/api/talk/sends/" + a.id,
    );
    expect((await receipt.json()).state).toBe("succeeded");
    const native = await talk(
      "talk-bob",
      "v1/chat/" + room.token + "?lookIntoFuture=0&setReadMarker=0&limit=100",
    );
    expect(native.filter((m: any) => m.message === body.content)).toHaveLength(
      1,
    );
    expect(
      (
        await db.pool.query("SELECT id FROM cw_messages WHERE content=$1", [
          message,
        ])
      ).rowCount,
    ).toBe(0);
    const forged = await alice.context.request.post(
      origin + "/api/talk/rooms/" + room.token + "/messages",
      { headers: { Origin: origin }, data: { ...body, actorId: "talk-bob" } },
    );
    expect(forged.status()).toBe(400);
    const participants = await talk(
        "talk-alice",
        "v4/room/" + room.token + "/participants",
      ),
      participant = participants.find(
        (p: any) => p.actorType === "users" && p.actorId === "talk-bob",
      );
    expect(participant).toBeTruthy();
    await talk("talk-alice", "v4/room/" + room.token + "/attendees", "DELETE", {
      attendeeId: String(participant.attendeeId),
    });
    await expect
      .poll(async () =>
        (
          await bob.context.request.get(
            origin + "/api/talk/rooms/" + room.token + "/messages",
          )
        ).status(),
      )
      .toBe(404);
    await expect(bob.page.getByText(message, { exact: true })).toHaveCount(0);
    expect(
      (
        await alice.context.request.get(
          origin + "/api/talk/rooms/" + room.token + "/messages",
        )
      ).status(),
    ).toBe(200);
    expect(receipt.headers()["cache-control"]).toBe("no-store");
  } finally {
    await alice.context.close();
    await bob.context.close();
    await outside.context.close();
  }
});
test("Real one-to-one Talk messages are available without importing them into product projects", async ({
  browser,
}) => {
  const room = await talk("talk-alice", "v4/room", "POST", {
      roomType: "1",
      invite: "talk-bob",
    }),
    user = await login(browser, "talk-alice");
  try {
    await expect(
      user.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const response = await user.context.request.get(origin + "/api/talk/rooms");
    expect(response.status()).toBe(200);
    expect((await response.json()).some((r: any) => r.id === room.token)).toBe(
      true,
    );
    const sent = await user.context.request.post(
      origin + "/api/talk/rooms/" + room.token + "/messages",
      {
        headers: { Origin: origin },
        data: { content: "一对一通信验证", idempotencyKey: randomUUID() },
      },
    );
    expect(sent.status()).toBe(201);
    expect((await sent.json()).state).toBe("succeeded");
    expect(
      (
        await talk(
          "talk-bob",
          "v1/chat/" +
            room.token +
            "?lookIntoFuture=0&setReadMarker=0&limit=100",
        )
      ).some((m: any) => m.message === "一对一通信验证"),
    ).toBe(true);
  } finally {
    await user.context.close();
  }
});

test("Source project scope survives both real engines and blocks results after real room revocation", async ({
  browser,
}) => {
  test.setTimeout(420000);
  const room = await talk("talk-alice", "v4/room", "POST", {
    roomType: "2",
    roomName: "Hyper AI Scoped Room",
  });
  await talk("talk-alice", "v4/room/" + room.token + "/participants", "POST", {
    newParticipant: "talk-bob",
    source: "users",
  });
  const sentinel = "synthetic-source-context-privacy-sentinel";
  await talk("talk-alice", "v1/chat/" + room.token, "POST", {
    message: sentinel,
    referenceId: randomBytes(32).toString("hex"),
  });
  let currentEngine = "",
    revoke = false;
  const seen = new Set<string>();
  const fixture = modelFixture(["synthetic-source-model-key"], async (body) => {
    const text = JSON.stringify(body.messages);
    if (
      text.includes("Host-bound method draft.") ||
      text.includes("Host-bound method management.")
    )
      expect(text).not.toContain(sentinel);
    if (text.includes("Host-bound task revision.")) {
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain("protocol-fixture-model-result");
    }
    if (
      text.includes("Host-bound task assignment.") ||
      text.includes("Host-bound project directory query.")
    )
      expect(text).not.toContain(sentinel);
    if (text.includes("native-follow-up-fixture"))
      expect(text).not.toContain(sentinel);
    if (text.includes("Host-bound artifact review decision.")) {
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain("protocol-fixture-model-result");
    }
    if (text.includes(sentinel) && /talk:nextcloud:/.test(text))
      seen.add(currentEngine);
    if (revoke) {
      revoke = false;
      const participants = await talk(
          "talk-alice",
          "v4/room/" + room.token + "/participants",
        ),
        member = participants.find(
          (p: any) => p.actorType === "users" && p.actorId === "talk-bob",
        );
      await talk(
        "talk-alice",
        "v4/room/" + room.token + "/attendees",
        "DELETE",
        { attendeeId: String(member.attendeeId) },
      );
    }
  });
  await new Promise<void>((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
  const actor = await login(browser, "talk-bob"),
    outside = await login(browser, "talk-outsider");
  try {
    await expect(
      actor.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    await expect(
      outside.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    await actor.page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "企业消息", exact: true })
      .click();
    await actor.page
      .getByRole("button", { name: "Hyper AI Scoped Room", exact: true })
      .click();
    const unbound = await actor.context.request.get(
      origin + "/api/talk/rooms/" + room.token + "/project",
    );
    expect(unbound.status()).toBe(200);
    expect(await unbound.json()).toEqual({ project: null });
    await actor.page
      .getByRole("button", { name: "项目空间", exact: true })
      .click();
    await actor.page
      .getByLabel("项目名称", { exact: true })
      .fill("Private source AI project");
    await actor.page
      .getByLabel("当前目标", { exact: true })
      .fill("Summarize only the authorized source");
    await actor.page
      .getByRole("button", { name: "创建项目", exact: true })
      .click();
    await expect(
      actor.page.getByRole("heading", {
        name: "Private source AI project",
        exact: true,
      }),
    ).toBeVisible();
    const workspace = await (
      await actor.context.request.get(
        origin +
          "/api/workspace?projectId=" +
          (
            await actor.context.request
              .get(origin + "/api/talk/rooms/" + room.token + "/project")
              .then((r) => r.json())
          ).project.id,
      )
    ).json();
    expect(workspace.project.source.roomId).toBe(room.token);
    const outsideView = await (
      await outside.context.request.get(origin + "/api/workspace")
    ).json();
    expect(
      outsideView.projects.some((p: any) => p.id === workspace.project.id),
    ).toBe(false);
    expect(
      (
        await outside.context.request.get(
          origin + "/api/workspace?projectId=" + workspace.project.id,
        )
      ).status(),
    ).toBe(404);
    const briefBase =
      origin + "/api/projects/" + workspace.project.id + "/work-briefs";
    const briefResponse = await actor.context.request.post(briefBase, {
      headers: { Origin: origin },
      data: {
        plan: { operation: "create" },
        draft: {
          title: "Source work brief",
          goal: "Use only current authorized messages",
          scope: "This source-linked project",
          constraints: "No external sends",
          completionCriteria: "Persist an editable artifact with references",
          questions: [],
        },
        idempotencyKey: randomUUID(),
      },
    });
    expect(briefResponse.status()).toBe(201);
    const brief = await briefResponse.json();
    const confirmedBriefResponse = await actor.context.request.post(briefBase, {
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
    expect(
      (
        await outside.context.request.get(briefBase + "/" + brief.briefId)
      ).status(),
    ).toBe(404);
    const profileResponse = await actor.context.request.post(
      origin + "/api/models",
      {
        headers: { Origin: origin },
        data: {
          name: "Synthetic source model",
          provider: "openai-compatible",
          endpoint:
            "http://127.0.0.1:" +
            (fixture.server.address() as { port: number }).port +
            "/v1",
          model: "native-test-model",
          purpose: "chat",
          scope: "personal",
          apiKey: "synthetic-source-model-key",
        },
      },
    );
    expect(profileResponse.status()).toBe(201);
    const profile = await profileResponse.json();
    const start = async (
      engine: string,
      workflow = "discussion_to_minutes",
    ) => {
      const response = await actor.context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine,
          workflow,
          instruction:
            workflow === "follow_up"
              ? "native-follow-up-fixture: check only current product tasks."
              : "Use authorized source messages to prepare a draft artifact.",
          ...(workflow === "discussion_to_minutes"
            ? {
                briefRef: {
                  id: brief.briefId,
                  version: confirmedBrief.version,
                },
              }
            : {}),
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      return response.json();
    };
    let reviewedArtifactId = "";
    let firstTaskRevisionRun = "";
    for (const engine of ["dsh", "hermes"]) {
      currentEngine = engine;
      const run = await start(engine);
      await expect
        .poll(
          async () => {
            const response = await actor.context.request.get(
              origin + "/api/runs/" + run.id,
            );
            if (response.status() !== 200) return "unavailable";
            const body = await response.json();
            return ["failed", "recovery_required"].includes(body.state)
              ? body.state + ": " + body.error
              : body.state;
          },
          { timeout: 60000, intervals: [700] },
        )
        .toBe("succeeded");
      const result = await (
        await actor.context.request.get(origin + "/api/runs/" + run.id)
      ).json();
      expect(
        result.contextRefs.some((ref: string) => ref.startsWith("talk:")),
      ).toBe(true);
      expect(result.contextRefs).toContain(
        "work-brief:" + brief.briefId + "@" + confirmedBrief.version,
      );
      const artifactId = result.result.receipts[0].id;
      expect(
        (
          await outside.context.request.get(
            origin + "/api/artifacts/" + artifactId,
          )
        ).status(),
      ).toBe(404);
      const artifact = await (
        await actor.context.request.get(origin + "/api/artifacts/" + artifactId)
      ).json();
      expect(artifact.current.sourceMessageIds).toEqual(
        expect.arrayContaining(result.contextRefs),
      );
      const reviewData = {
        expectedVersion: 1,
        expectedReviewRevision: 0,
        decision: "accept",
        feedback: "Synthetic employee checked the authorized source version.",
        confirmed: true,
      };
      expect(
        (
          await outside.context.request.post(
            origin + "/api/artifacts/" + artifactId + "/reviews",
            {
              headers: { Origin: origin },
              data: { ...reviewData, idempotencyKey: randomUUID() },
            },
          )
        ).status(),
      ).toBe(404);
      const accepted = await actor.context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine,
          workflow: "review_artifact",
          artifactId,
          artifactReviewPlan: reviewData,
          instruction: "Record the employee's confirmed decision.",
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        },
      });
      expect(accepted.status()).toBe(201);
      const reviewRun = await accepted.json();
      await expect
        .poll(
          async () =>
            (
              await (
                await actor.context.request.get(
                  origin + "/api/runs/" + reviewRun.id,
                )
              ).json()
            ).state,
          { timeout: 60000, intervals: [700] },
        )
        .toBe("succeeded");
      const reviewed = await (
        await actor.context.request.get(origin + "/api/artifacts/" + artifactId)
      ).json();
      expect(reviewed.current).toMatchObject({
        status: "accepted",
        acceptedVersion: 1,
        reviewRevision: 1,
      });
      expect(reviewed.reviews[0]).toMatchObject({
        channel: "ai_assisted",
        reviewerAuthority: "creator",
        version: 1,
      });
      reviewedArtifactId = artifactId;
    }
    expect([...seen].sort()).toEqual(["dsh", "hermes"]);
    expect(fixture.violations).toEqual([]);
    const taskResponse = await actor.context.request.post(
      origin +
        "/api/conversations/" +
        workspace.project.conversationId +
        "/tasks",
      {
        headers: { Origin: origin },
        data: {
          title: "Synthetic source-scoped follow-up task",
          assignee: "talk-bob",
          dueDate: null,
        },
      },
    );
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();
    let baselineRunId = "";
    for (const [index, engine] of ["dsh", "hermes", "dsh"].entries()) {
      if (index === 1)
        expect(
          (
            await actor.context.request.patch(
              origin + "/api/tasks/" + task.id,
              {
                headers: { Origin: origin },
                data: { status: "done" },
              },
            )
          ).status(),
        ).toBe(200);
      const run = await start(engine, "follow_up");
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
      expect(result.result.receipts[0].notify).toBe(index === 1);
      expect(result.result.receipts[0].reason).toBe(
        ["baseline", "changed", "unchanged"][index],
      );
      expect(
        result.contextRefs.every((ref: string) => ref.startsWith("task:")),
      ).toBe(true);
      expect(
        (
          await db.pool.query(
            "SELECT id FROM cw_messages WHERE metadata->>'runId'=$1",
            [run.id],
          )
        ).rowCount,
      ).toBe(index === 1 ? 1 : 0);
      baselineRunId = run.id;
    }
    const scheduled = await actor.context.request.post(
      origin +
        "/api/conversations/" +
        workspace.project.conversationId +
        "/follow-ups",
      {
        headers: { Origin: origin },
        data: {
          plan: { operation: "create", intervalMinutes: 15, maxChecks: 2 },
          engine: "hermes",
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(scheduled.status()).toBe(201);
    const schedule = await scheduled.json();
    await expect
      .poll(
        async () => {
          const row = (
            await db.pool.query(
              "SELECT last_run_id FROM cw_follow_up_schedules WHERE id=$1",
              [schedule.id],
            )
          ).rows[0];
          if (!row.last_run_id) return "waiting";
          return (
            await (
              await actor.context.request.get(
                origin + "/api/runs/" + row.last_run_id,
              )
            ).json()
          ).state;
        },
        { timeout: 75000, intervals: [700] },
      )
      .toBe("succeeded");
    const savedSchedule = (
      await db.pool.query("SELECT * FROM cw_follow_up_schedules WHERE id=$1", [
        schedule.id,
      ])
    ).rows[0];
    expect(savedSchedule.identity_credential_id).toBeTruthy();
    expect(savedSchedule.checks_started).toBe(1);
    baselineRunId = savedSchedule.last_run_id;
    expect(
      (
        await talk(
          "talk-alice",
          "v1/chat/" +
            room.token +
            "?lookIntoFuture=0&setReadMarker=0&limit=100",
        )
      ).some((message: any) => message.message?.startsWith("待办有")),
    ).toBe(false);
    expect(
      (
        await outside.context.request.get(
          origin + "/api/knowledge?q=Native%20runtime%20test",
        )
      ).status(),
    ).toBe(200);
    expect(
      await (
        await outside.context.request.get(
          origin + "/api/knowledge?q=Native%20runtime%20test",
        )
      ).json(),
    ).toHaveLength(0);
    for (const engine of ["dsh", "hermes"]) {
      const before = await (
        await actor.context.request.get(origin + "/api/tasks/" + task.id)
      ).json();
      const response = await actor.context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine,
          workflow: "revise_task",
          taskId: task.id,
          expectedTaskVersion: before.current.version,
          instruction: "Update only this selected synthetic task.",
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      const revision = await response.json();
      await expect
        .poll(
          async () =>
            (
              await (
                await actor.context.request.get(
                  origin + "/api/runs/" + revision.id,
                )
              ).json()
            ).state,
          { timeout: 60000, intervals: [700] },
        )
        .toBe("succeeded");
      const detail = await (
        await actor.context.request.get(origin + "/api/tasks/" + task.id)
      ).json();
      expect(detail.current).toMatchObject({
        id: task.id,
        title: "protocol-fixture-task-update",
        status: "done",
      });
      // Hermes proposes the same canonical fields, so the second edit is a no-op.
      expect(detail.current.version).toBe(
        engine === "dsh" ? before.current.version + 1 : before.current.version,
      );
      if (engine === "dsh") firstTaskRevisionRun = revision.id;
      expect(detail.history[0]).toMatchObject({
        channel: "ai",
        sourceRunId: firstTaskRevisionRun,
      });
      const result = await (
        await actor.context.request.get(origin + "/api/runs/" + revision.id)
      ).json();
      expect(result.result.receipts[0]).toMatchObject({
        id: task.id,
        version: detail.current.version,
        changed: engine === "dsh",
      });
      expect(
        (
          await outside.context.request.get(origin + "/api/tasks/" + task.id)
        ).status(),
      ).toBe(404);
    }
    const directoryPath =
      origin + "/api/projects/" + workspace.project.id + "/directory";
    const membersResponse = await actor.context.request.get(directoryPath);
    expect(membersResponse.status()).toBe(200);
    const members = await membersResponse.json();
    const employee = members.rows.find((p: any) => p.id === workspace.user.id);
    expect(employee).toMatchObject({
      sourceUid: "talk-bob",
      state: "available",
    });
    expect((await outside.context.request.get(directoryPath)).status()).toBe(
      404,
    );
    const beforeAssignment = await (
      await actor.context.request.get(origin + "/api/tasks/" + task.id)
    ).json();
    const assignmentResponse = await actor.context.request.post(
      origin + "/api/runs",
      {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          workflow: "assign_task",
          taskAssignmentPlan: {
            taskId: task.id,
            expectedVersion: beforeAssignment.current.version,
            assigneeId: employee.id,
            confirmed: true,
          },
          engine: "hermes",
          modelProfileId: profile.id,
          instruction:
            "Execute only the explicit employee UID assignment, never send notifications or grant membership",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(assignmentResponse.status()).toBe(201);
    const assignmentRun = await assignmentResponse.json();
    await expect
      .poll(
        async () =>
          (
            await (
              await actor.context.request.get(
                origin + "/api/runs/" + assignmentRun.id,
              )
            ).json()
          ).state,
        { timeout: 60000, intervals: [700] },
      )
      .toBe("succeeded");
    const assignedTask = await (
      await actor.context.request.get(origin + "/api/tasks/" + task.id)
    ).json();
    expect(assignedTask.current.assigneeId).toBe(employee.id);
    expect(assignedTask.history[0].snapshot.assigneeId).toBe(employee.id);
    const methodRunResponse = await actor.context.request.post(
      origin + "/api/runs",
      {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          workflow: "manage_method",
          methodPlan: {
            operation: "create",
            sourceArtifactId: reviewedArtifactId,
            expectedSourceVersion: 1,
          },
          engine: "dsh",
          modelProfileId: profile.id,
          instruction:
            "From this selected source artifact, save only a candidate method.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(methodRunResponse.status()).toBe(201);
    const methodRun = await methodRunResponse.json();
    await expect
      .poll(
        async () =>
          (
            await (
              await actor.context.request.get(
                origin + "/api/runs/" + methodRun.id,
              )
            ).json()
          ).state,
        { timeout: 60000, intervals: [700] },
      )
      .toBe("succeeded");
    const candidate = (
      await (
        await actor.context.request.get(origin + "/api/runs/" + methodRun.id)
      ).json()
    ).result.receipts[0];
    expect(candidate).toMatchObject({
      state: "candidate",
      verification: "candidate",
      sourceArtifactId: reviewedArtifactId,
      sourceVersion: 1,
    });
    expect(
      (
        await outside.context.request.get(
          origin + "/api/methods/" + candidate.id,
        )
      ).status(),
    ).toBe(404);
    const methodAction = async (plan: any) => {
      const response = await actor.context.request.post(
        origin + "/api/projects/" + workspace.project.id + "/methods/actions",
        {
          headers: { Origin: origin },
          data: { plan, idempotencyKey: randomUUID() },
        },
      );
      expect(response.status()).toBe(201);
      return response.json();
    };
    const verified = await methodAction({
      operation: "verify",
      methodId: candidate.id,
      expectedVersion: 1,
      expectedRevision: 1,
      evidence: "Synthetic employee source-scope validation declaration.",
      confirmed: true,
    });
    const published = await methodAction({
      operation: "publish",
      methodId: candidate.id,
      expectedVersion: 1,
      expectedRevision: verified.revision,
      scope: "project",
      confirmed: true,
    });
    const reuseResponse = await actor.context.request.post(
      origin + "/api/runs",
      {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          workflow: "project_report",
          engine: "hermes",
          modelProfileId: profile.id,
          instruction:
            "Apply the selected published method as guidance, not current facts.",
          methodRefs: [
            { id: candidate.id, version: 1, revision: published.revision },
          ],
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(reuseResponse.status()).toBe(201);
    const methodReuse = await reuseResponse.json();
    await expect
      .poll(
        async () =>
          (
            await (
              await actor.context.request.get(
                origin + "/api/runs/" + methodReuse.id,
              )
            ).json()
          ).state,
        { timeout: 60000, intervals: [700] },
      )
      .toBe("succeeded");
    expect(
      (
        await (
          await actor.context.request.get(
            origin + "/api/methods/" + candidate.id,
          )
        ).json()
      ).uses[0],
    ).toMatchObject({
      runId: methodReuse.id,
      version: 1,
      revision: published.revision,
      state: "succeeded",
    });
    expect(
      (
        await outside.context.request.get(
          origin + "/api/methods/" + candidate.id,
        )
      ).status(),
    ).toBe(404);
    const taskBeforeRevocation = (
      await db.pool.query("SELECT version FROM cw_tasks WHERE id=$1", [task.id])
    ).rows[0].version;
    expect(fixture.violations).toEqual([]);
    currentEngine = "revoked";
    revoke = true;
    const interrupted = await start("dsh", "follow_up");
    await expect
      .poll(
        async () =>
          (
            await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [
              interrupted.id,
            ])
          ).rows[0].state,
        { timeout: 60000, intervals: [700] },
      )
      .toBe("failed");
    await db.pool.query(
      "UPDATE cw_follow_up_schedules SET next_check_at=clock_timestamp() WHERE id=$1",
      [schedule.id],
    );
    await expect
      .poll(
        async () =>
          (
            await db.pool.query(
              "SELECT state FROM cw_follow_up_schedules WHERE id=$1",
              [schedule.id],
            )
          ).rows[0].state,
        { timeout: 30000, intervals: [700] },
      )
      .toBe("paused");
    const revokedSchedule = (
      await db.pool.query(
        "SELECT checks_started,last_run_id FROM cw_follow_up_schedules WHERE id=$1",
        [schedule.id],
      )
    ).rows[0];
    expect(
      (
        await actor.context.request.get(briefBase + "/" + brief.briefId)
      ).status(),
    ).toBe(404);
    expect(
      (
        await actor.context.request.post(briefBase, {
          headers: { Origin: origin },
          data: {
            plan: {
              operation: "reopen",
              briefId: brief.briefId,
              expectedVersion: confirmedBrief.version,
            },
            idempotencyKey: randomUUID(),
          },
        })
      ).status(),
    ).toBe(404);
    expect((await actor.context.request.get(directoryPath)).status()).toBe(404);
    expect(revokedSchedule).toEqual({
      checks_started: 1,
      last_run_id: savedSchedule.last_run_id,
    });
    expect(
      (
        await db.pool.query(
          "SELECT last_run_id FROM cw_follow_up_baselines WHERE project_id=$1",
          [workspace.project.id],
        )
      ).rows[0].last_run_id,
    ).toBe(baselineRunId);
    expect(
      (
        await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
          interrupted.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await actor.context.request.get(origin + "/api/runs/" + interrupted.id)
      ).status(),
    ).toBe(404);
    expect(
      (
        await actor.context.request.get(origin + "/api/methods/" + candidate.id)
      ).status(),
    ).toBe(404);
    expect(
      (
        await actor.context.request.get(origin + "/api/runs/" + methodReuse.id)
      ).status(),
    ).toBe(404);
    expect(
      (
        await actor.context.request.get(origin + "/api/tasks/" + task.id)
      ).status(),
    ).toBe(404);
    expect(
      (
        await actor.context.request.patch(origin + "/api/tasks/" + task.id, {
          headers: { Origin: origin },
          data: {
            title: "Revoked source edit",
            expectedVersion: taskBeforeRevocation,
          },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await db.pool.query("SELECT version FROM cw_tasks WHERE id=$1", [
          task.id,
        ])
      ).rows[0].version,
    ).toBe(taskBeforeRevocation);
    expect(
      (
        await actor.context.request.post(
          origin + "/api/artifacts/" + reviewedArtifactId + "/reviews",
          {
            headers: { Origin: origin },
            data: {
              expectedVersion: 1,
              expectedReviewRevision: 1,
              decision: "reopen",
              confirmed: true,
              feedback: "Revoked source cannot change review state.",
              idempotencyKey: randomUUID(),
            },
          },
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await db.pool.query(
          "SELECT status,review_revision FROM cw_artifacts WHERE id=$1",
          [reviewedArtifactId],
        )
      ).rows[0],
    ).toEqual({ status: "accepted", review_revision: 1 });
    await expect(
      actor.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const cancellation = await actor.context.request.post(
      origin + "/api/runs/" + interrupted.id + "/cancel",
      { headers: { Origin: origin }, data: {} },
    );
    expect(cancellation.status()).toBe(201);
    expect(Object.keys(await cancellation.json()).sort()).toEqual([
      "id",
      "state",
    ]);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await actor.context.close();
    await outside.context.close();
  }
});

test("Both native engines prepare private Talk replies that an employee reviews and sends through the real source", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const room = await talk("talk-alice", "v4/room", "POST", {
    roomType: "2",
    roomName: "Hyper Reply Draft Room",
  });
  await talk("talk-alice", "v4/room/" + room.token + "/participants", "POST", {
    newParticipant: "talk-bob",
    source: "users",
  });
  await talk("talk-alice", "v1/chat/" + room.token, "POST", {
    message: "synthetic-reply-context",
    referenceId: randomBytes(32).toString("hex"),
  });
  let sourceContexts = 0;
  const fixture = modelFixture(["synthetic-reply-model-key"], (body) => {
    if (JSON.stringify(body.messages).includes("synthetic-reply-context"))
      sourceContexts++;
  });
  await new Promise<void>((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
  const actor = await login(browser, "talk-bob"),
    peer = await login(browser, "talk-alice");
  try {
    await expect(
      actor.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    await expect(
      peer.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    expect(
      (await peer.context.request.get(origin + "/api/workspace")).status(),
    ).toBe(200);
    const created = await actor.context.request.post(
      origin + "/api/projects/from-talk",
      {
        headers: { Origin: origin },
        data: {
          roomId: room.token,
          name: "Personal reply preparation",
          goal: "Prepare source-scoped employee replies",
        },
      },
    );
    expect(created.status()).toBe(201);
    const project = await created.json();
    const profile = await (
      await actor.context.request.post(origin + "/api/models", {
        headers: { Origin: origin },
        data: {
          name: "Synthetic draft model",
          provider: "openai-compatible",
          endpoint:
            "http://127.0.0.1:" +
            (fixture.server.address() as { port: number }).port +
            "/v1",
          model: "native-test-model",
          purpose: "chat",
          scope: "personal",
          apiKey: "synthetic-reply-model-key",
        },
      })
    ).json();
    const draftIds: string[] = [];
    for (const engine of ["dsh", "hermes"]) {
      const started = await actor.context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: project.conversationId,
          engine,
          workflow: "draft_reply",
          instruction:
            "native-reply-draft-fixture: prepare a reply from the authorized source; never send",
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        },
      });
      expect(started.status()).toBe(201);
      const run = await started.json();
      await expect
        .poll(
          async () => {
            const data = await (
              await actor.context.request.get(origin + "/api/runs/" + run.id)
            ).json();
            return data.error ? data.state + ":" + data.error : data.state;
          },
          { timeout: 60000, intervals: [700] },
        )
        .toBe("succeeded");
      const result = await (
        await actor.context.request.get(origin + "/api/runs/" + run.id)
      ).json();
      expect(result.result.text).toBe("回复草稿已保存，尚未发送。");
      const id = result.result.receipts[0].id;
      draftIds.push(id);
      const draft = await actor.context.request.get(
        origin + "/api/talk/drafts/" + id,
      );
      expect(draft.status()).toBe(200);
      expect((await draft.json()).sourceMessageIds).toEqual(result.contextRefs);
      expect(
        (
          await peer.context.request.get(origin + "/api/talk/drafts/" + id)
        ).status(),
      ).toBe(404);
    }
    expect(
      (
        await (
          await peer.context.request.get(
            origin + "/api/talk/rooms/" + room.token + "/drafts",
          )
        ).json()
      ).length,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM cw_messages WHERE conversation_id=$1",
          [project.conversationId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT id FROM cw_communication_sends WHERE conversation_ref=$1",
          [room.token],
        )
      ).rowCount,
    ).toBe(0);
    await actor.page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "企业消息", exact: true })
      .click();
    await actor.page
      .getByRole("button", { name: "Hyper Reply Draft Room", exact: true })
      .click();
    await actor.page.getByText("我的 AI 草稿", { exact: false }).click();
    await actor.page
      .getByRole("button", { name: "预览草稿", exact: true })
      .first()
      .click();
    await expect(
      actor.page.getByRole("region", { name: "AI 回复草稿" }),
    ).toContainText("private-native-reply-draft");
    await actor.page
      .getByRole("button", { name: "放入发送框", exact: true })
      .click();
    const reviewed = "Synthetic human-reviewed AI reply";
    await actor.page
      .getByRole("textbox", { name: "企业消息内容", exact: true })
      .fill(reviewed);
    await actor.page
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(
      actor.page.getByRole("textbox", { name: "企业消息内容", exact: true }),
    ).toHaveValue("");
    const messages = await talk(
      "talk-alice",
      "v1/chat/" + room.token + "?lookIntoFuture=0&setReadMarker=0&limit=100",
    );
    expect(
      messages.filter(
        (m: any) => m.message === reviewed && m.actorId === "talk-bob",
      ),
    ).toHaveLength(1);
    const sent = (
      await db.pool.query(
        "SELECT * FROM cw_communication_sends WHERE conversation_ref=$1",
        [room.token],
      )
    ).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0].draft_modified).toBe(true);
    expect(draftIds).toContain(sent[0].draft_id);
    expect(
      (
        await actor.context.request.post(
          origin + "/api/talk/rooms/" + room.token + "/messages",
          {
            headers: { Origin: origin },
            data: {
              content: reviewed,
              draftId: sent[0].draft_id,
              idempotencyKey: randomUUID(),
            },
          },
        )
      ).status(),
    ).toBe(409);
    expect(sourceContexts).toBeGreaterThanOrEqual(2);
    expect(fixture.violations).toEqual([]);
    const participants = await talk(
      "talk-alice",
      "v4/room/" + room.token + "/participants",
    );
    const member = participants.find(
      (p: any) => p.actorType === "users" && p.actorId === "talk-bob",
    );
    await talk("talk-alice", "v4/room/" + room.token + "/attendees", "DELETE", {
      attendeeId: String(member.attendeeId),
    });
    expect(
      (
        await actor.context.request.get(
          origin + "/api/talk/drafts/" + draftIds[0],
        )
      ).status(),
    ).toBe(404);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await actor.context.close();
    await peer.context.close();
  }
});
