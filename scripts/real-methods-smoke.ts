import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunInput, Subject } from "@hyper/contracts";
import { Database } from "../apps/api/src/db/database.js";
import { WorkspaceService } from "../apps/api/src/core/workspace.js";
import { RunProcessor } from "../apps/api/src/core/processor.js";
import { MethodsService } from "../apps/api/src/core/methods.js";
import { Vault } from "../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../apps/api/src/providers/nextcloud.js";
import { engineRegistry } from "../apps/api/src/engines/adapters.js";
import { TalkManagementFixture } from "../tests/fixtures/talk-management.js";

const maxBusinessRuns = 8;
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        executionMayBeBillable: true,
        execute:
          "Add --execute after reviewing the existing profile and provider pricing",
        profileEnvironment: "REAL_MODEL_PROFILE_ID",
        businessRuns: maxBusinessRuns,
        actualHttpRequests:
          "All requests/retries are recorded; Run count is not a provider billing hard cap",
        scope:
          "Seeded demo workspace and synthetic source only; existing prices, budgets, roles and keys are unchanged",
        humanQualityReview:
          "Not implied by synthetic operator verification/publication",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--execute")
    throw Error("Invalid arguments");
  const profileId = process.env.REAL_MODEL_PROFILE_ID;
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(profileId ?? "")) {
    console.error(
      "Set REAL_MODEL_PROFILE_ID to an existing demo chat profile UUID; never provide an API key.",
    );
    process.exitCode = 1;
    return;
  }
  // This reproducible check writes only new synthetic objects in the local demo.
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(
    ["127.0.0.1", "localhost"].includes(databaseUrl.hostname),
    "Local demo database required",
  );
  const db = new Database(),
    source = new TalkManagementFixture();
  const dir = resolve(
    ".runtime/private-model-checks",
    "methods-" +
      new Date().toISOString().replaceAll(":", "-") +
      "-" +
      randomUUID().slice(0, 8),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const report: any = {
    date: new Date().toISOString(),
    status: "running",
    maxBusinessRuns,
    model: "deepseek-flash",
    source: "Synthetic loopback Talk protocol, not real Nextcloud/company data",
    scope:
      "P04/P06/P07/P08, C02/C04/C06, A06/A07/A08/A09/A10, E06/E07/E09/E10 subsets",
    humanQualityVerdict:
      "not_requested_yet; synthetic operator declarations are not an employee quality verdict",
    pricingReference: "https://api-docs.deepseek.com/quick_start/pricing/",
    projects: [],
    runs: [],
    credentials: [],
  };
  const save = () =>
    writeFile(
      resolve(dir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  const credentials: string[] = [];
  try {
    const profile = (
      await db.pool.query(
        "SELECT p.workspace_id,p.owner_id,p.model,p.endpoint,p.provider,u.name,m.role FROM cw_model_profiles p JOIN cw_users u ON u.id=p.owner_id JOIN cw_members m ON m.user_id=p.owner_id AND m.workspace_id=p.workspace_id WHERE p.id=$1 AND p.purpose='chat'",
        [profileId],
      )
    ).rows[0];
    assert.ok(profile, "Select a currently owned chat profile");
    assert.equal(profile.workspace_id, "00000000-0000-4000-8000-000000000001");
    assert.equal(profile.owner_id, "00000000-0000-4000-8000-000000000011");
    assert.equal(profile.model, "deepseek-flash");
    assert.equal(profile.endpoint, "https://api.deepseek.com");
    assert.equal(profile.provider, "openai-compatible");
    const peerId = "00000000-0000-4000-8000-000000000012";
    const peerMember = (
      await db.pool.query(
        "SELECT u.name,m.role FROM cw_members m JOIN cw_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2",
        [profile.workspace_id, peerId],
      )
    ).rows[0];
    assert.equal(
      peerMember?.role,
      "member",
      "Synthetic reader must already be an ordinary member; do not rewrite roles",
    );
    const base = await source.start();
    Object.assign(process.env, {
      NEXTCLOUD_URL: base,
      NEXTCLOUD_INTERNAL_URL: base,
      NEXTCLOUD_WORKSPACE_ID: profile.workspace_id,
      NEXTCLOUD_MEMBER_GROUP: "synthetic-staff",
      NEXTCLOUD_TALK_ENABLED: "true",
      NEXTCLOUD_FILES_ENABLED: "false",
      RUNTIME_DIR: resolve(dir, "runs"),
    });
    const config = requireNextcloud();
    const actors: Subject[] = [];
    for (const [uid, id, name, role] of [
      ["operator", profile.owner_id, profile.name, profile.role],
      ["peer", peerId, peerMember.name, peerMember.role],
    ]) {
      const identity = randomUUID(),
        credential = randomUUID();
      await db.pool.query(
        "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
        [identity, config.providerKey, uid, id, profile.workspace_id],
      );
      // Register cleanup before an insertion with an ambiguous response can finish.
      credentials.push(credential);
      report.credentials.push(credential);
      await db.pool.query(
        "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
        [credential, identity, uid, new Vault().encrypt("synthetic-password")],
      );
      actors.push({
        id,
        workspaceId: profile.workspace_id,
        name,
        role,
        demo: false,
        identityCredentialId: credential,
      });
    }
    const [actor, peer] = actors as [Subject, Subject];
    const work = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(work),
      methods = new MethodsService(db);
    async function requests(runId: string) {
      return (
        await db.pool.query(
          "SELECT id,transport,http_status,usage_status,input_tokens::text,output_tokens::text,cost_status FROM cw_model_requests WHERE run_id=$1 ORDER BY started_at,id",
          [runId],
        )
      ).rows;
    }
    async function run(
      project: any,
      engine: "dsh" | "hermes",
      workflow: RunInput["workflow"],
      instruction: string,
      extra: Partial<RunInput> = {},
    ) {
      assert.ok(report.runs.length < maxBusinessRuns);
      const input = {
        conversationId: project.conversationId,
        engine,
        workflow,
        instruction,
        modelProfileId: profileId!,
        idempotencyKey: randomUUID(),
        taskRules: {
          maxActions: 2,
          maxOutputTokens: 2048,
          maxDurationSeconds: 120,
          maxContextBytes: 50000,
        },
        ...extra,
      };
      const started = await work.startRun(actor, input);
      const record: any = {
        id: started.id,
        engine,
        workflow,
        projectId: project.id,
      };
      report.runs.push(record);
      try {
        await processor.process(started.id);
        const actual = await work.getRun(actor, started.id);
        Object.assign(record, {
          state: actual.state,
          error: actual.error,
          evidence: actual.result?.evidence,
          result: actual.result,
          contextRefs: actual.contextRefs,
        });
        record.requests = await requests(started.id);
        await save();
        assert.equal(
          actual.state,
          "succeeded",
          "Real method workflow must produce a successful business receipt",
        );
        assert.equal(actual.result.evidence, "runtime");
        assert.ok(record.requests.length > 0);
        assert.ok(record.requests.some((q: any) => q.http_status === 200));
        await assert.rejects(
          work.getRun(peer, started.id),
          (e: any) => e.getStatus?.() === 404,
        );
        return actual;
      } finally {
        record.requests = await requests(started.id);
        await save();
      }
    }
    const target = (m: any) => ({
      methodId: m.id,
      expectedVersion: m.version,
      expectedRevision: m.revision,
    });
    for (const engine of ["dsh", "hermes"] as const) {
      const other = engine === "dsh" ? "hermes" : "dsh";
      const room = source.addRoom("Synthetic method quality " + engine);
      room.messages.length = 0;
      const inputs = [
        [
          "operator",
          "合成项目青禾，2026-11-02。已确认事实：内测清单已完成；回滚清单仍待 peer 复核；发布审批尚未获得，尚未上线。",
        ],
        [
          "peer",
          "方法建议：交付说明先写当前结果，再列风险与未知，最后给出下一步；每次使用前先查项目当前事实。该建议不是已发布公司制度。",
        ],
        [
          "operator",
          "这是合成质量验收资料，不是公司会议。没有新增业务待办，也没有通知任何人的授权。",
        ],
      ];
      for (const [uid, content] of inputs) source.message(room, uid!, content!);
      const project = await work.createTalkProject(
        actor,
        room.token,
        "Synthetic real method quality " + engine,
        "合成资料：保存可追溯候选和当前事实，不把建议升级为公司制度。",
      );
      const record: any = {
        ...project,
        engine,
        inputs: inputs.map(([author, content]) => ({ author, content })),
      };
      report.projects.push(record);
      await run(
        project,
        engine,
        "discussion_to_minutes",
        "仅保存一份合成纪要，明确事实、待核实与方法建议三部分。保留审批尚未获得和未上线；不创建待办，不通知，不把建议写为已发布公司制度。",
      );
      const artifacts = (
        await db.pool.query("SELECT id FROM cw_artifacts WHERE project_id=$1", [
          project.id,
        ])
      ).rows;
      assert.equal(artifacts.length, 1);
      record.source = (await work.artifact(actor, artifacts[0].id)).current;
      await run(
        project,
        engine,
        "manage_method",
        "从所选成果提炼一份 SOP 候选，kind 使用 sop，标题以‘合成方法：’开头。正文须分成‘已确认事实（仅为合成例子）’、‘待核实事项’、‘方法建议’三部分。明确审批尚未获得、尚未上线；要求复用前读取项目当前事实。该建议不是已发布的公司制度。只保存候选，不自行验证或发布。",
        {
          methodPlan: {
            operation: "create",
            sourceArtifactId: record.source.id,
            expectedSourceVersion: record.source.version,
          },
        },
      );
      const rows = (
        await db.pool.query("SELECT id FROM cw_methods WHERE project_id=$1", [
          project.id,
        ])
      ).rows;
      assert.equal(rows.length, 1);
      const candidate = (await methods.get(actor, rows[0].id)).current;
      record.candidate = candidate;
      assert.equal(candidate.state, "candidate");
      assert.equal(candidate.verification, "candidate");
      assert.equal(candidate.maintainerId, actor.id);
      assert.equal(candidate.sourceArtifactId, record.source.id);
      assert.equal(candidate.sourceVersion, record.source.version);
      for (const label of ["合成", "事实", "待核实", "方法建议", "审批"])
        assert.ok(
          candidate.content.includes(label),
          "Candidate must retain evidence/unknown/suggestion labels: " + label,
        );
      await assert.rejects(
        methods.get(peer, candidate.id),
        (e: any) => e.getStatus?.() === 404,
      );
      const verified = await methods.record(actor, project.id, {
        plan: {
          operation: "verify",
          ...target(candidate),
          confirmed: true,
          evidence:
            "合成验收操作者声明：仅核对选定成果来源、候选/建议/事实标签和产品回读；不代表真实员工质量认可、公司制度发布或业务效果已验证。",
        },
        idempotencyKey: randomUUID(),
      });
      const published = await methods.record(actor, project.id, {
        plan: {
          operation: "publish",
          ...target(verified),
          scope: "project",
          confirmed: true,
        },
        idempotencyKey: randomUUID(),
      });
      record.publication = published;
      assert.equal(
        (await methods.get(peer, candidate.id)).current.state,
        "published",
      );
      const refs = [
        {
          id: published.id,
          version: published.version,
          revision: published.revision,
        },
      ];
      assert.ok(
        (await work.search(actor, candidate.title)).some(
          (x: any) => x.id === candidate.id,
        ),
      );
      const update =
        "最新合成事实（2026-11-02）：peer 现已复核回滚清单，核对编号 QH-REV-02。发布审批仍未获得，尚未上线。旧例子中的‘回滚清单待复核’已过时，不得当成当前状态。";
      source.message(room, "peer", update);
      record.updatedSource = update;
      const reused = await run(
        project,
        other,
        "project_report",
        "按我选定的方法建议，保存一份当前项目报告：先当前结果，再风险/未知，最后下一步。以最新来源为准，保留明确的核对编号与合成样例标记；方法中的历史例子不是当前事实或公司制度。如提及所选方法的状态，请依据主机元数据简要写清当前发布范围和验证性质。不新建业务待办，不通知。",
        { methodRefs: refs },
      );
      assert.ok(
        reused.contextRefs.includes(
          "method:" +
            published.id +
            "@" +
            published.version +
            "#" +
            published.revision,
        ),
      );
      const reports = (
        await db.pool.query(
          "SELECT id FROM cw_artifacts WHERE project_id=$1 AND id<>$2",
          [project.id, record.source.id],
        )
      ).rows;
      assert.equal(reports.length, 1);
      record.reused = (await work.artifact(actor, reports[0].id)).current;
      assert.ok(
        record.reused.content.includes("QH-REV-02"),
        "Reuse must use the new authoritative source, not only the old method example",
      );
      assert.match(record.reused.content, /合成/);
      assert.match(
        record.reused.content,
        /项目.{0,12}已发布|已.{0,8}项目.{0,8}发布|已发布.{0,12}项目|项目内发布/,
        "Report must state the current project publication from host metadata",
      );
      assert.match(
        record.reused.content,
        /声明|员工确认|操作者确认/,
        "Publication must not become independent quality proof",
      );
      assert.doesNotMatch(
        record.reused.content,
        /state\s*[=:]|publicationScope|employee_verified/,
        "Report must explain current method status without internal field names",
      );
      assert.equal(
        Number(
          (
            await db.pool.query(
              "SELECT count(*) FROM cw_tasks WHERE project_id=$1",
              [project.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      record.use = (await methods.get(actor, candidate.id)).uses;
      assert.ok(
        record.use.some(
          (u: any) =>
            u.runId === reused.id &&
            u.version === published.version &&
            u.revision === published.revision,
        ),
      );
      await run(
        project,
        other,
        "manage_method",
        "仅执行已明确确认的本方法撤回，不重新发布、不删除旧成果、不通知。",
        {
          methodPlan: {
            operation: "withdraw",
            ...target(published),
            reason:
              "合成验收结束，停止新复用；不撤销已经保存的报告或真实业务动作。",
            confirmed: true,
          },
        },
      );
      const withdrawn = await methods.get(actor, candidate.id);
      record.withdrawn = withdrawn.current;
      assert.equal(withdrawn.current.state, "withdrawn");
      assert.equal(withdrawn.versions.length, 1);
      assert.equal(
        (await work.artifact(actor, record.reused.id)).current.content,
        record.reused.content,
      );
      assert.ok(
        !(await work.search(actor, candidate.title)).some(
          (x: any) => x.id === candidate.id,
        ),
      );
      const projectRequestCount = async () =>
        Number(
          (
            await db.pool.query(
              "SELECT count(*) FROM cw_model_requests m JOIN cw_runs r ON r.id=m.run_id WHERE r.conversation_id=$1",
              [project.conversationId],
            )
          ).rows[0].count,
        );
      const before = await projectRequestCount();
      await assert.rejects(
        work.startRun(actor, {
          conversationId: project.conversationId,
          engine,
          workflow: "project_report",
          instruction:
            "Synthetic withdrawn reference must be refused before a model call",
          modelProfileId: profileId!,
          methodRefs: refs,
          idempotencyKey: randomUUID(),
        }),
        (e: any) => e.getStatus?.() === 409,
      );
      assert.equal(await projectRequestCount(), before);
      record.withdrawalDeniedBeforeProvider = true;
      room.people.delete("operator");
      await assert.rejects(
        methods.get(actor, candidate.id),
        (e: any) => e.getStatus?.() === 404,
      );
      record.sourceRevocationDeniedAdmin = true;
      await save();
    }
    assert.equal(source.writes.length, 0);
    assert.equal(report.runs.length, maxBusinessRuns);
    report.status = "technical-readback-passed-human-quality-open";
  } catch (error: any) {
    report.status = "failed";
    report.failure = {
      name: error?.name,
      message:
        error?.name === "AssertionError"
          ? error.message
          : "实际方法核验未完成，请核对受控报告和产品回执。",
    };
    process.exitCode = 1;
  } finally {
    const cleanupFailures: string[] = [];
    for (const id of credentials) {
      try {
        await db.pool.query(
          "UPDATE cw_identity_credentials SET disabled_at=clock_timestamp(),credential_enc='' WHERE id=$1",
          [id],
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
      cleanupFailures.push("synthetic_source_close");
    }
    report.sourceWrites = source.writes.length;
    report.cleanupFailures = cleanupFailures;
    if (cleanupFailures.length) {
      report.status = "failed";
      process.exitCode = 1;
    }
    try {
      const ids = report.runs.map((r: any) => r.id);
      report.supplierRequests = ids.length
        ? (
            await db.pool.query(
              "SELECT id,run_id,transport,http_status,usage_status,input_tokens::text,output_tokens::text,cost_status FROM cw_model_requests WHERE run_id=ANY($1::uuid[]) ORDER BY started_at,id",
              [ids],
            )
          ).rows
        : [];
      report.incompleteUsage = report.supplierRequests
        .filter(
          (q: any) =>
            q.transport !== "completed" || q.usage_status !== "reported",
        )
        .map((q: any) => q.id);
      await save();
    } finally {
      await db.close();
    }
    console.log(
      JSON.stringify({
        status: report.status,
        reportDirectory: dir,
        businessRuns: report.runs.length,
        supplierRequests: report.supplierRequests?.length ?? null,
        incompleteUsage: report.incompleteUsage?.length ?? null,
        sourceWrites: report.sourceWrites,
        cleanupFailures,
      }),
    );
  }
}
main().catch(() => {
  console.error(
    "Real methods check did not finish; inspect private product receipts and configuration. No connection secrets are printed.",
  );
  process.exitCode = 1;
});
