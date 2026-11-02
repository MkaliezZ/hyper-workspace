import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "../apps/api/src/db/database.js";
import { WorkspaceService } from "../apps/api/src/core/workspace.js";
import { KnowledgeService } from "../apps/api/src/core/knowledge.js";
import { engineRegistry } from "../apps/api/src/engines/adapters.js";
import { createRoomManagementScope } from "../tests/fixtures/room-management-scope.js";

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        database: "Isolated loopback _test database only",
        provider: "Explicit loopback OpenAI-compatible embedding endpoint only",
        corpus: "synthetic-chinese-office-v1",
        queries: 8,
        qualityGate: "Top1 >= 0.75 and Recall@3 = 1; fixed before execution",
        boundary:
          "Short synthetic Chinese text retrieval, not long-document/RAG answer or company acceptance",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--execute")
    throw Error("Invalid arguments");
  const url = new URL(process.env.TEST_DATABASE_URL ?? ""),
    endpoint = new URL(process.env.EMBEDDING_EVAL_ENDPOINT ?? "");
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.pathname.endsWith("_test"),
    "Use an isolated local _test database",
  );
  assert.ok(
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) &&
      ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    "Use a loopback evaluation endpoint without credentials",
  );
  const model = process.env.EMBEDDING_EVAL_MODEL;
  assert.ok(
    model && model.length <= 200,
    "Set the explicit local embedding model",
  );
  process.env.DATABASE_URL = url.toString();
  process.env.NEXTCLOUD_FILES_ENABLED = "false";
  const db = new Database(url.toString());
  const dir = resolve(
    ".runtime/private-model-checks",
    "semantic-" +
      new Date().toISOString().replaceAll(":", "-") +
      "-" +
      randomUUID().slice(0, 8),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const corpus = JSON.parse(
    await readFile(
      new URL(
        "../tests/fixtures/semantic-quality-corpus.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const report: any = {
    date: new Date().toISOString(),
    status: "running",
    corpus,
    model,
    source:
      "Synthetic source HTTP fixture; actual local embedding inference and product pgvector",
    boundary:
      "Short Chinese documents only; no company data, remote supplier charge, generic benchmark or RAG answer claim",
    results: [],
  };
  const save = () =>
    writeFile(
      resolve(dir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  let scope: Awaited<ReturnType<typeof createRoomManagementScope>> | undefined;
  try {
    await db.migrate();
    scope = await createRoomManagementScope(db);
    const { actor, peer, source, room } = scope;
    const work = new WorkspaceService(db, engineRegistry()),
      knowledge = new KnowledgeService(db);
    const profile = await work.saveModel(peer, {
      name: "Synthetic real local embedding evaluation",
      provider: "openai-compatible",
      endpoint: endpoint.toString().replace(/\/$/, ""),
      model,
      purpose: "embedding",
      scope: "workspace",
      apiKey: "synthetic-local-embedding-evaluation",
      embeddingInputChars: 400,
    });
    const project = await work.createTalkProject(
      actor,
      room.token,
      "Synthetic semantic quality",
      "Evaluate retrieval and current permissions, not company instructions",
    );
    const restrictedRoom = source.addRoom(
        "Synthetic subsequently revoked corpus",
      ),
      restricted = await work.createTalkProject(
        actor,
        restrictedRoom.token,
        "Synthetic revoked corpus",
        "Never return inaccessible semantic matches",
      );
    const ids = new Map<string, string>();
    async function asset(
      key: string,
      title: string,
      content: string,
      projectId = project.id,
      ownerId = actor.id,
      visibility = "workspace",
    ) {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_ref,source_version,visibility)VALUES($1,$2,$3,$4,$5,$6,'document',$7,'v1',$8)",
        [
          id,
          actor.workspaceId,
          projectId,
          ownerId,
          title,
          content,
          "synthetic-evaluation:" + key,
          visibility,
        ],
      );
      ids.set(key, id);
      return id;
    }
    for (const doc of corpus.documents)
      await asset(doc.key, doc.title, doc.content);
    const privateId = await asset(
      "private",
      "私人请假记录（合成）",
      "下周想休息两天，需要怎么报备？这是另一员工的私人请假记录，任何普通同事都不应看到此内容。",
      project.id,
      peer.id,
      "private",
    );
    const revokedId = await asset(
      "revoked",
      "已失去权限的发布说明（合成）",
      "把新版本放到生产之前要查什么？这个文档来自另一个房间，撤权后不能通过语义相似度读到。",
      restricted.id,
    );
    report.workspaceId = actor.workspaceId;
    report.profileId = profile.id;
    report.assets = [...ids].map(([key, id]) => ({ key, id }));
    await knowledge.index(
      actor,
      corpus.documents.map((d: any) => ids.get(d.key)!).concat(revokedId),
      profile.id,
    );
    await knowledge.index(peer, [privateId], profile.id);
    restrictedRoom.people.delete("operator");
    const count = async () =>
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM cw_model_requests WHERE workspace_id=$1",
            [actor.workspaceId],
          )
        ).rows[0].count,
      );
    const beforeDenied = await count();
    await assert.rejects(
      knowledge.index(actor, [privateId], profile.id),
      (e: any) => e.getStatus?.() === 404,
    );
    await assert.rejects(
      knowledge.index(actor, [revokedId], profile.id),
      (e: any) => e.getStatus?.() === 404,
    );
    assert.equal(await count(), beforeDenied);
    report.deniedIndexBeforeProvider = true;
    let top1 = 0,
      top3 = 0,
      reciprocal = 0;
    for (const sample of corpus.queries) {
      const hits = await knowledge.semantic(actor, sample.query, profile.id);
      assert.ok(
        hits.every((h: any) => h.id !== privateId && h.id !== revokedId),
        "Private or revoked content must never appear in semantic results",
      );
      const rank =
        hits.findIndex((h: any) => h.id === ids.get(sample.expected)) + 1;
      if (rank === 1) top1++;
      if (rank > 0 && rank <= 3) top3++;
      if (rank > 0) reciprocal += 1 / rank;
      report.results.push({
        ...sample,
        rank,
        top3: hits.slice(0, 3).map((h: any) => ({
          key: [...ids].find(([, id]) => id === h.id)?.[0],
          similarity: Number(h.similarity),
          reference: h.chunks[0]?.reference,
        })),
      });
      await save();
    }
    report.metrics = {
      top1: top1 / corpus.queries.length,
      recallAt3: top3 / corpus.queries.length,
      meanReciprocalRank: reciprocal / corpus.queries.length,
    };
    // This independent tail-retrieval check does not alter the eight fixed
    // quality questions or their denominator. Original text must remain whole.
    const longText =
      "新员工入职后领取办公电脑，阅读培训资料并办理访客登记。\n".repeat(90) +
      "夜间服务器机房出现漏水时，由设施组值班员关闭北侧总阀门，工单编号 WX-END-042，随后通知运维负责人。";
    const longId = await asset(
      "long-tail",
      "合成长文：培训与机房设施处置",
      longText,
    );
    await knowledge.index(actor, [longId], profile.id);
    const longChunks = (
      await db.pool.query(
        "SELECT char_start,char_end,content FROM cw_asset_chunks WHERE asset_id=$1 ORDER BY ordinal",
        [longId],
      )
    ).rows;
    assert.equal(longChunks[0].char_start, 0);
    assert.equal(longChunks.at(-1).char_end, longText.length);
    longChunks.forEach((chunk, i) => {
      assert.equal(
        chunk.content,
        longText.slice(chunk.char_start, chunk.char_end),
      );
      if (i) assert.ok(chunk.char_start <= longChunks[i - 1].char_end);
    });
    const longHits = await knowledge.semantic(
      actor,
      "机房夜里漏水应该先关闭哪一侧的阀门？",
      profile.id,
    );
    const tailHit = longHits
      .slice(0, 3)
      .find(
        (hit: any) => hit.id === longId && hit.content.includes("WX-END-042"),
      );
    assert.ok(
      tailHit,
      "Long document tail must be retrievable through product chunking, without truncation",
    );
    report.longDocument = {
      characters: longText.length,
      chunks: longChunks.length,
      capacity: 400,
      fullTextCoverage: true,
      tailInTop3: true,
      reference:
        tailHit.chunks.find((chunk: any) =>
          chunk.content?.includes("WX-END-042"),
        )?.reference ?? tailHit.chunks[0]?.reference,
    };
    // Stale vectors remain physically present; current versions and deletion must filter them.
    const leave = ids.get("leave")!;
    await db.pool.query(
      "UPDATE cw_assets SET source_version='v2',content=$2,updated_at=clock_timestamp() WHERE id=$1",
      [
        leave,
        corpus.documents.find((d: any) => d.key === "leave").content +
          " 更新：紧急病假先通知主管后补材料。",
      ],
    );
    assert.ok(
      !(
        await knowledge.semantic(actor, corpus.queries[0].query, profile.id)
      ).some((h: any) => h.id === leave),
    );
    await knowledge.index(actor, [leave], profile.id);
    const refreshed = await knowledge.semantic(
      actor,
      corpus.queries[0].query,
      profile.id,
    );
    assert.ok(
      refreshed.some((h: any) => h.id === leave && h.sourceVersion === "v2"),
    );
    await db.pool.query(
      "UPDATE cw_assets SET deleted_at=clock_timestamp() WHERE id=$1",
      [leave],
    );
    assert.ok(
      !(
        await knowledge.semantic(actor, corpus.queries[0].query, profile.id)
      ).some((h: any) => h.id === leave),
    );
    room.people.delete("operator");
    assert.equal(
      (await knowledge.semantic(actor, corpus.queries[0].query, profile.id))
        .length,
      0,
    );
    report.lifecycle = {
      staleVectorExcluded: true,
      refreshedVersionReturned: true,
      deletedAssetExcluded: true,
      sourceRevokedExcludedAll: true,
    };
    report.requests = (
      await db.pool.query(
        "SELECT purpose,usage_status,transport,input_tokens::text,cost_status FROM cw_model_requests WHERE workspace_id=$1 ORDER BY started_at,id",
        [actor.workspaceId],
      )
    ).rows;
    assert.ok(
      report.requests.length > 0 &&
        report.requests.every(
          (r: any) =>
            r.transport === "completed" && r.usage_status === "reported",
        ),
    );
    assert.ok(
      report.metrics.top1 >= corpus.limits.minimumTop1,
      "Fixed Top1 retrieval quality threshold not met",
    );
    assert.ok(
      report.metrics.recallAt3 >= corpus.limits.minimumRecallAt3,
      "Fixed Recall@3 threshold not met",
    );
    assert.equal(source.writes.length, 0);
    report.status = "passed-synthetic-short-chinese-retrieval";
  } catch (error: any) {
    report.status = "failed";
    report.failure = {
      name: error?.name,
      message:
        error?.name === "AssertionError"
          ? error.message
          : "语义检索核验未完成，请查看受限报告及本地模型服务。",
    };
    process.exitCode = 1;
  } finally {
    report.cleanupFailures = [];
    if (scope) {
      report.sourceWrites = scope.source.writes.length;
      try {
        await db.pool.query(
          "UPDATE cw_identity_credentials SET disabled_at=clock_timestamp(),credential_enc='' WHERE id=ANY($1::uuid[])",
          [[scope.actor.identityCredentialId, scope.peer.identityCredentialId]],
        );
      } catch {
        report.cleanupFailures.push("synthetic_credentials_disable");
      }
      try {
        await scope.close();
      } catch {
        report.cleanupFailures.push("synthetic_source_close");
      }
    }
    if (report.cleanupFailures.length) {
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
        metrics: report.metrics ?? null,
        modelRequests: report.requests?.length ?? null,
        sourceWrites: report.sourceWrites ?? 0,
        cleanupFailures: report.cleanupFailures,
      }),
    );
  }
}
main().catch(() => {
  console.error(
    "Semantic quality check did not finish; inspect local isolated configuration. No connection secrets are printed.",
  );
  process.exitCode = 1;
});
