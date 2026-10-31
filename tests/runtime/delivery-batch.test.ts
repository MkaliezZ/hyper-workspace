import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { WorkPlanService } from "../../apps/api/src/core/work-plans.js";
import { DecisionService } from "../../apps/api/src/core/decisions.js";
import { MethodsService } from "../../apps/api/src/core/methods.js";
import {
  WorkPlanResponse,
  type Subject,
  type RunInput,
} from "@hyper/contracts";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { modelFixture } from "./business-contract.js";
test(
  "Native engines share product-owned work clarification, decisions, private retrieval and maintainer transfer",
  { timeout: 180000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const originalDir = process.env.RUNTIME_DIR,
      originalKey = process.env.CREDENTIAL_MASTER_KEY,
      dir = await mkdtemp(join(tmpdir(), "hyper-delivery-native-"));
    process.env.RUNTIME_DIR = dir;
    process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
    const db = new Database(url),
      workspace = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(workspace),
      key = "native-batch-" + randomUUID(),
      fixture = modelFixture([key]);
    await new Promise<void>((resolve) =>
      fixture.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await db.migrate();
      for (const engine of ["dsh", "hermes"] as const)
        assert.equal(
          workspace.engines.get(engine)?.describeCapabilities().configured,
          true,
        );
      const workspaceId = randomUUID(),
        actor: Subject = {
          workspaceId,
          id: randomUUID(),
          name: "Native batch owner",
          role: "admin",
          demo: false,
        },
        peer: Subject = {
          ...actor,
          id: randomUUID(),
          name: "Native batch peer",
          role: "member",
        };
      await db.pool.query(
        "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic native delivery batch')",
        [workspaceId],
      );
      for (const subject of [actor, peer]) {
        await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
          subject.id,
          subject.name,
        ]);
        await db.pool.query(
          "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
          [workspaceId, subject.id, subject.role],
        );
      }
      const project = await workspace.createProject(
        actor,
        "Native delivery batch",
        "Retain current identities, product decisions and source provenance.",
      );
      await workspace.message(
        actor,
        project.conversationId,
        "Synthetic discussion: prepare a candidate, clarify audience, retain exact employee identity.",
      );
      const profile = await workspace.saveModel(actor, {
        name: "Native batch protocol fixture",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" + (fixture.server.address() as any).port + "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        apiKey: key,
      });
      const perform = async (input: Partial<RunInput>) => {
        const run = await workspace.startRun(actor, {
          conversationId: project.conversationId,
          engine: "dsh",
          workflow: "plan_work",
          instruction:
            "Use only the selected synthetic scope and the exact employee-confirmed operation.",
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
          ...input,
        });
        await processor.process(run.id);
        return await workspace.getRun(actor, run.id);
      };
      const plan = await perform({ workflow: "plan_work", engine: "dsh" }),
        plans = new WorkPlanService(db);
      assert.equal(plan.state, "waiting_input", plan.error);
      const first = await plans.view(actor, plan.id);
      await plans.respond(
        actor,
        plan.id,
        WorkPlanResponse.parse({
          expectedRevision: first.revision,
          answers: [{ key: "question:0", text: "native-work-audience-answer" }],
          regenerate: true,
          idempotencyKey: randomUUID(),
        }),
      );
      await processor.process(plan.id);
      const rewritten = await plans.view(actor, plan.id);
      assert.equal(rewritten.state, "waiting_confirmation");
      const calls = fixture.calls();
      const executed = await plans.respond(
        actor,
        plan.id,
        WorkPlanResponse.parse({
          expectedRevision: rewritten.revision,
          confirmed: true,
          idempotencyKey: randomUUID(),
        }),
      );
      assert.equal(executed.state, "succeeded");
      assert.equal(
        fixture.calls(),
        calls,
        "Host confirmation must not call the model again",
      );
      const artifact = executed.receipts.find(
        (r: any) => r.tool === "artifact.create",
      );
      const task = (await workspace.view(actor, project.id)).tasks[0]!;
      assert.equal(task.assigneeId, actor.id);
      const proposed = await perform({
        workflow: "manage_decision",
        engine: "dsh",
        decisionPlan: { operation: "create" },
      });
      assert.equal(proposed.state, "succeeded", proposed.error);
      const decision = proposed.result.receipts[0];
      const confirmed = await perform({
        workflow: "manage_decision",
        engine: "hermes",
        decisionPlan: {
          operation: "confirm",
          decisionId: decision.id,
          expectedVersion: decision.version,
          confirmed: true,
        },
      });
      assert.equal(confirmed.state, "succeeded", confirmed.error);
      assert.equal(
        (await new DecisionService(db).current(actor, project.id))[0]!.id,
        decision.id,
      );
      const source = (
        await db.pool.query(
          "SELECT id,source_version FROM cw_assets WHERE workspace_id=$1 AND source_ref=$2",
          [workspaceId, "artifact:" + artifact.id],
        )
      ).rows[0];
      const privateId = randomUUID();
      await db.pool.query(
        "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,visibility,title,content,type,source_version)VALUES($1,$2,$3,$4,'private','Synthetic private companion','Companion evidence for the chosen excerpt.','text','1')",
        [privateId, workspaceId, project.id, actor.id],
      );
      const answer = await perform({
        workflow: "query_knowledge",
        engine: "hermes",
        knowledgePlan: {
          query: "What evidence supports the selected workflow?",
          mode: "keyword",
          assetRefs: [
            { id: source.id, sourceVersion: source.source_version },
            { id: privateId, sourceVersion: "1" },
          ],
        },
      });
      assert.equal(answer.state, "succeeded", answer.error);
      assert.match(answer.knowledgeAnswer.content, /asset:/);
      assert.ok(answer.knowledgeAnswer.citations.length >= 2);
      await assert.rejects(() => workspace.getRun(peer, answer.id));
      const methods = new MethodsService(db),
        candidate = await methods.record(actor, project.id, {
          plan: {
            operation: "create",
            sourceArtifactId: artifact.id,
            expectedSourceVersion: 1,
          },
          draft: {
            title: "Native batch method",
            kind: "sop",
            content: "Synthetic reusable guidance, not company policy.",
          },
          idempotencyKey: randomUUID(),
        });
      const transferred = await perform({
        workflow: "manage_method",
        engine: "hermes",
        methodPlan: {
          operation: "transfer",
          methodId: candidate.id,
          expectedVersion: candidate.version,
          expectedRevision: candidate.revision,
          maintainerId: peer.id,
          confirmed: true,
        },
      });
      assert.equal(transferred.state, "succeeded", transferred.error);
      assert.equal(transferred.result.receipts[0].maintainerId, peer.id);
      assert.equal(
        (await methods.get(peer, candidate.id)).current.canManage,
        true,
      );
      assert.deepEqual(fixture.violations, []);
      const messages = (
        await db.pool.query(
          "SELECT content FROM cw_messages WHERE conversation_id=$1",
          [project.conversationId],
        )
      ).rows;
      assert.equal(
        messages.length,
        1,
        "Planning, decisions and private answers must not publish raw model text",
      );
    } finally {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        fixture.server.close(() => resolve()),
      );
      await db.close();
      await rm(dir, { recursive: true, force: true });
      if (originalDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = originalDir;
      if (originalKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY;
      else process.env.CREDENTIAL_MASTER_KEY = originalKey;
    }
  },
);
