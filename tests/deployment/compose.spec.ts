import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    const start = async (
      engine: string,
      workflow: string,
      instruction: string,
      artifactId?: string,
    ) => {
      const r = await context.request.post(origin + "/api/runs", {
        headers: { Origin: origin },
        data: {
          conversationId: workspace.project.conversationId,
          engine,
          workflow,
          instruction,
          artifactId,
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
    await page.reload();
    await page.getByRole("tab", { name: "成果", exact: true }).click();
    await page
      .locator(".artifact-list-row")
      .filter({ hasText: "Container native artifact" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "成果内容", exact: true }),
    ).toHaveValue("synthetic-container-version-two");
    const saved = await (
      await context.request.get(origin + "/api/artifacts/" + artifactId)
    ).json();
    expect(saved.current.version).toBe(2);
    expect(saved.versions).toHaveLength(2);
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
    expect(stats.calls).toBe(2);
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
