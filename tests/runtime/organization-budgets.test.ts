import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { OrganizationBudgetService } from "../../apps/api/src/core/organization-budgets.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createRoomManagementScope } from "../fixtures/room-management-scope.js";
import { modelFixture } from "./business-contract.js";
import type { OrganizationBudgetPlan } from "@hyper/contracts";

test(
  "Native DSH and Hermes share independent company budgets with host-bound private prices, declarations, role rechecks and no invented amounts",
  { timeout: 240000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      directory = await mkdtemp(join(tmpdir(), "hyper-native-company-budget-")),
      original = process.env.RUNTIME_DIR,
      key = "synthetic-company-budget-" + randomUUID(),
      note = "private-company-evidence-" + randomUUID();
    let scope:
        | Awaited<ReturnType<typeof createRoomManagementScope>>
        | undefined,
      hostile = false,
      revoke = false;
    const fixture = modelFixture(
      [key],
      async (body) => {
        assert.ok(!JSON.stringify(body.messages).includes(note));
        if (revoke && scope)
          await db.pool.query(
            "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
            [scope.peer.workspaceId, scope.peer.id],
          );
      },
      () => ({
        text: "Synthetic budget protocol output is not a receipt",
        actions: [
          {
            tool: "spending.manage",
            args: hostile ? { dailyLimit: "999999" } : {},
          },
        ],
      }),
    );
    process.env.RUNTIME_DIR = directory;
    await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
    try {
      await db.migrate();
      scope = await createRoomManagementScope(db);
      const actor = scope.peer,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work),
        budget = new OrganizationBudgetService(db),
        project = await work.createTalkProject(
          actor,
          scope.room.token,
          "Synthetic company budget source",
          "Company financial control, no source writes",
        );
      const endpoint =
          "http://127.0.0.1:" + (fixture.server.address() as any).port + "/v1",
        profile = await work.saveModel(actor, {
          name: "Synthetic company native connection",
          provider: "openai-compatible",
          endpoint,
          model: "native-test-model",
          purpose: "chat",
          scope: "personal",
          apiKey: key,
        });
      const price: OrganizationBudgetPlan = {
        operation: "budget_price",
        provider: "openai-compatible",
        endpoint,
        model: "native-test-model",
        purpose: "chat",
        expectedRevision: 0,
        currency: "USD",
        inputPerMillion: "0",
        outputPerMillion: "0",
        cacheReadPerMillion: "0",
        cacheWritePerMillion: "0",
        source: note,
        confirmed: true,
      };
      await budget.save(actor, price, randomUUID());
      async function run(
        engine: "dsh" | "hermes",
        plan: OrganizationBudgetPlan,
      ) {
        const input = {
          conversationId: project.conversationId,
          engine,
          workflow: "manage_spending" as const,
          modelProfileId: profile.id,
          spendingPlan: plan,
          instruction:
            "Only execute the exact employee-confirmed company financial operation, do not publish or notify anyone",
          idempotencyKey: randomUUID(),
        };
        const started = await work.startRun(actor, input);
        await processor.process(started.id);
        return work.getRun(actor, started.id);
      }
      const dsh = await run("dsh", {
        operation: "budget_configure",
        scope: "project",
        projectId: project.id,
        expectedRevision: 0,
        currency: "USD",
        dailyLimit: "1",
        requestReservation: "0",
        confirmed: true,
      });
      assert.equal(dsh.state, "succeeded", dsh.error);
      assert.equal(dsh.result.evidence, "runtime");
      assert.equal(dsh.result.receipts[0].operation, "budget_configure");
      const hermes = await run("hermes", { ...price, expectedRevision: 1 });
      assert.equal(hermes.state, "succeeded", hermes.error);
      assert.equal(hermes.result.receipts[0].revision, 2);
      const charge = (await budget.view(actor, project.id)).charges.find(
        (x) => x.projectId === project.id,
      )!;
      assert.ok(charge);
      const declared = await run("dsh", {
        operation: "budget_reconcile",
        requestId: charge.id,
        expectedRevision: charge.revision,
        currency: "USD",
        amount: "0",
        evidence: note,
        confirmed: true,
      });
      assert.equal(declared.state, "succeeded", declared.error);
      assert.equal(declared.result.receipts[0].notInvoice, true);
      const zero = await run("hermes", {
        operation: "budget_configure",
        scope: "workspace",
        projectId: null,
        expectedRevision: 0,
        currency: "USD",
        dailyLimit: "0",
        requestReservation: "0",
        confirmed: true,
      });
      assert.equal(zero.state, "succeeded", zero.error);
      const before = (await budget.view(actor, project.id)).history.length;
      hostile = true;
      const invalid = await run("dsh", {
        operation: "budget_configure",
        scope: "project",
        projectId: project.id,
        expectedRevision: 1,
        currency: "USD",
        dailyLimit: "2",
        requestReservation: "0",
        confirmed: true,
      });
      assert.equal(invalid.state, "failed");
      hostile = false;
      assert.equal(
        (await budget.view(actor, project.id)).history.length,
        before,
      );
      revoke = true;
      const denied = await run("hermes", {
        operation: "budget_configure",
        scope: "project",
        projectId: project.id,
        expectedRevision: 1,
        currency: "USD",
        dailyLimit: "2",
        requestReservation: "0",
        confirmed: true,
      });
      assert.equal(denied.state, "failed");
      assert.equal(
        (
          await db.pool.query(
            "SELECT revision FROM cw_budget_controls WHERE workspace_id=$1 AND scope_id=$2",
            [actor.workspaceId, project.id],
          )
        ).rows[0].revision,
        1,
      );
      assert.equal(fixture.calls(), 6);
      assert.equal(scope.source.writes.length, 0);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM cw_budget_charges WHERE workspace_id=$1",
            [actor.workspaceId],
          )
        ).rows[0].n,
        6,
      );
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await scope?.close();
      await db.close();
      if (original === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = original;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
