import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { modelFixture } from "../runtime/business-contract";
import { source, password, origin, login } from "./helpers";

test("Real Nextcloud project members share native reminder rules, quiet checks and one eligible merged product message", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const owner = await login(browser, "org-reader"),
    peer = await login(browser, "employee-one"),
    headers = { Origin: origin },
    key = "synthetic-source-notification-" + randomUUID(),
    model = modelFixture([key], (body) => {
      const text = JSON.stringify(body.messages);
      if (text.includes("Host-bound notification policy operation.")) {
        expect(text).not.toContain("Synthetic source reminder task");
        expect(text).not.toContain('"mode":"quiet"');
      }
    });
  await new Promise<void>((r) => model.server.listen(0, "127.0.0.1", r));
  let roomId: string | undefined;
  const talk = async (
    path: string,
    method = "GET",
    body?: Record<string, string>,
  ) => {
    const response = await fetch(
      source + "/ocs/v2.php/apps/spreed/api/" + path + "?format=json",
      {
        method,
        headers: {
          Authorization:
            "Basic " + Buffer.from("org-reader:" + password).toString("base64"),
          "OCS-APIRequest": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        ...(body ? { body: new URLSearchParams(body) } : {}),
        redirect: "error",
      },
    );
    expect(response.ok).toBe(true);
    return (await response.json()).ocs.data;
  };
  try {
    for (const actor of [owner, peer])
      await expect
        .poll(async () =>
          (await actor.context.request.get(origin + "/api/workspace")).status(),
        )
        .toBe(200);
    const room = await talk("v4/room", "POST", {
      roomType: "2",
      roomName: "Synthetic source reminder group",
    });
    roomId = room.token;
    await talk("v4/room/" + roomId + "/participants", "POST", {
      newParticipant: "employee-one",
    });
    const created = await owner.context.request.post(
      origin + "/api/projects/from-talk",
      {
        headers,
        data: {
          roomId,
          name: "Synthetic source reminder project",
          goal: "Quiet checks retain pending facts",
        },
      },
    );
    expect(created.status()).toBe(201);
    const project = await created.json();
    const profileResponse = await peer.context.request.post(
      origin + "/api/models",
      {
        headers,
        data: {
          name: "Synthetic source reminder protocol",
          provider: "openai-compatible",
          endpoint:
            "http://127.0.0.1:" + (model.server.address() as any).port + "/v1",
          model: "native-test-model",
          purpose: "chat",
          scope: "workspace",
          apiKey: key,
        },
      },
    );
    expect(profileResponse.status()).toBe(201);
    const profile = await profileResponse.json();
    const taskResponse = await owner.context.request.post(
      origin + "/api/conversations/" + project.conversationId + "/tasks",
      {
        headers,
        data: {
          title: "Synthetic source reminder task",
          assignee: "org-reader",
          dueDate: null,
        },
      },
    );
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();
    async function native(actor: typeof owner, engine: string, plan?: any) {
      const response = await actor.context.request.post(origin + "/api/runs", {
        headers,
        data: {
          conversationId: project.conversationId,
          workflow: plan ? "manage_notifications" : "follow_up",
          engine,
          instruction: plan
            ? "Only the employee-confirmed reminder operation"
            : "native-follow-up-fixture",
          modelProfileId: profile.id,
          ...(plan ? { notificationPlan: plan } : {}),
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      const run = await response.json();
      const get = async () => {
        const r = await actor.context.request.get(
          origin + "/api/runs/" + run.id,
        );
        expect(r.status()).toBe(200);
        return r.json();
      };
      await expect
        .poll(
          async () => {
            const r = await get();
            return ["failed", "recovery_required"].includes(r.state)
              ? r.state + ": " + r.error
              : r.state;
          },
          { timeout: 120000, intervals: [1000] },
        )
        .toBe("succeeded");
      const result = await get();
      expect(result.result.evidence).toBe("runtime");
      return result.result.receipts[0];
    }
    await native(owner, "dsh", {
      operation: "configure",
      scope: "personal",
      expectedRevision: 0,
      rules: { mode: "quiet" },
      confirmed: true,
    });
    expect((await native(owner, "dsh")).reason).toBe("baseline");
    const patch = await owner.context.request.patch(
      origin + "/api/tasks/" + task.id,
      { headers, data: { expectedVersion: 1, status: "done" } },
    );
    expect(patch.status()).toBe(200);
    const quiet = await native(owner, "hermes");
    expect(quiet.notify).toBe(false);
    expect(quiet.notification.reason).toBe("quiet");
    const published = await native(peer, "hermes");
    expect(published.notify).toBe(true);
    expect(
      (await native(owner, "hermes", { operation: "read" })).effective.mode,
    ).toBe("quiet");
    const peerViewResponse = await peer.context.request.get(
      origin + "/api/projects/" + project.id + "/notification-policy",
    );
    expect(peerViewResponse.status()).toBe(200);
    expect(
      (await peerViewResponse.json()).layers.some(
        (l: any) => l.scope === "personal",
      ),
    ).toBe(false);
    const workspace = await (
      await peer.context.request.get(
        origin + "/api/workspace?projectId=" + project.id,
      )
    ).json();
    const messages = workspace.messages.filter((m: any) =>
      m.metadata?.receipts?.some((r: any) => r.tool === "follow_up.check"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(published.notificationMessageId);
    expect(JSON.stringify(messages)).not.toContain('"scope":"personal"');
    expect(model.calls()).toBe(5);
    const participants = await talk("v4/room/" + roomId + "/participants"),
      member = participants.find((p: any) => p.actorId === "employee-one");
    await talk("v4/room/" + roomId + "/attendees", "DELETE", {
      attendeeId: String(member.attendeeId),
    });
    expect(
      (
        await peer.context.request.get(
          origin + "/api/projects/" + project.id + "/notification-policy",
        )
      ).status(),
    ).toBe(404);
  } finally {
    if (roomId) await talk("v4/room/" + roomId, "DELETE").catch(() => {});
    await new Promise<void>((r) => model.server.close(() => r()));
    await owner.context.close();
    await peer.context.close();
  }
});
