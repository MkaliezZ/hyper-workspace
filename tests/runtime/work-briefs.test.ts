import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { WorkBriefService } from "../../apps/api/src/core/work-briefs.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunInput, type Subject } from "@hyper/contracts";
import { modelFixture } from "./business-contract.js";
test(
  "Native DSH and Hermes share brief identity, employee clarification, confirmation and version-gated business execution",
  { timeout: 180000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const oldDir = process.env.RUNTIME_DIR,
      oldKey = process.env.CREDENTIAL_MASTER_KEY,
      dir = await mkdtemp(join(tmpdir(), "hyper-brief-native-"));
    process.env.RUNTIME_DIR = dir;
    process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
    const db = new Database(url),
      service = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(service),
      briefs = new WorkBriefService(db),
      key = "synthetic-native-brief-" + randomUUID();
    const fixture = modelFixture([key]);
    await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
    try {
      await db.migrate();
      const subject: Subject = {
        id: randomUUID(),
        workspaceId: randomUUID(),
        name: "Native brief maintainer",
        role: "member",
        demo: false,
      };
      await db.pool.query(
        "INSERT INTO cw_workspaces(id,name) VALUES($1,'Native brief fixture')",
        [subject.workspaceId],
      );
      await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
        subject.id,
        subject.name,
      ]);
      await db.pool.query(
        "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [subject.workspaceId, subject.id],
      );
      const project = await service.createProject(
        subject,
        "Native work brief",
        "Maintain understanding independently of the engine",
      );
      const address = fixture.server.address() as { port: number };
      const model = await service.saveModel(subject, {
        name: "Native brief model fixture",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:" + address.port + "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        apiKey: key,
      });
      const run = async (engine: "dsh" | "hermes", plan: any) => {
        const r = await service.startRun(
          subject,
          RunInput.parse({
            conversationId: project.conversationId,
            engine,
            workflow: "manage_brief",
            briefPlan: plan,
            modelProfileId: model.id,
            instruction:
              "Organize a project delivery plan; ask for missing audience, never confirm autonomously.",
            idempotencyKey: randomUUID(),
          }),
        );
        await processor.process(r.id);
        const d = await service.getRun(subject, r.id);
        assert.equal(d.state, "succeeded", d.error);
        assert.equal(d.result.evidence, "runtime");
        return d;
      };
      const first = await run("dsh", { operation: "create" });
      let b = first.result.receipts[0];
      const d = await briefs.get(subject, project.id, b.briefId);
      assert.equal(d.current.status, "needs_input");
      assert.equal(d.history[0].sourceRunId, first.id);
      b = await briefs.save(
        subject,
        project.id,
        {
          operation: "answer",
          briefId: b.briefId,
          expectedVersion: b.version,
          answers: [
            {
              questionId: d.current.questions[0].id,
              answer: "Employee audience",
            },
          ],
        },
        undefined,
        randomUUID(),
      );
      const revision = await run("hermes", {
        operation: "revise",
        briefId: b.briefId,
        expectedVersion: b.version,
      });
      assert.equal(revision.result.receipts[0].briefId, b.briefId);
      b = revision.result.receipts[0];
      assert.equal(
        (await briefs.get(subject, project.id, b.briefId)).current.questions[0]
          .answer,
        "Employee audience",
      );
      const confirmation = await run("hermes", {
        operation: "confirm",
        briefId: b.briefId,
        expectedVersion: b.version,
        confirmed: true,
      });
      b = confirmation.result.receipts[0];
      assert.equal(b.status, "confirmed");
      const input = RunInput.parse({
        conversationId: project.conversationId,
        engine: "dsh",
        workflow: "discussion_to_minutes",
        modelProfileId: model.id,
        instruction:
          "Produce the artifact following the employee-confirmed brief",
        briefRef: { id: b.briefId, version: b.version },
        idempotencyKey: randomUUID(),
      });
      const execution = await service.startRun(subject, input);
      await processor.process(execution.id);
      const result = await service.getRun(subject, execution.id);
      assert.equal(result.state, "succeeded", result.error);
      assert.ok(
        result.contextRefs.includes(
          "work-brief:" + b.briefId + "@" + b.version,
        ),
      );
      await briefs.save(
        subject,
        project.id,
        { operation: "reopen", briefId: b.briefId, expectedVersion: b.version },
        undefined,
        randomUUID(),
      );
      const before = fixture.calls();
      await assert.rejects(
        service.startRun(subject, {
          ...input,
          engine: "hermes",
          idempotencyKey: randomUUID(),
        }),
        /未确认/,
      );
      assert.equal(fixture.calls(), before);
      assert.deepEqual(fixture.violations, []);
      assert.equal(fixture.calls(), 4);
    } finally {
      await db.close();
      fixture.server.closeAllConnections();
      await new Promise<void>((r) => fixture.server.close(() => r()));
      if (oldDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = oldDir;
      if (oldKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY;
      else process.env.CREDENTIAL_MASTER_KEY = oldKey;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
