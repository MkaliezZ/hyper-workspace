import { useEffect, useRef, useState } from "react";
import type { WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
interface UsageView {
  summary: {
    requests: number;
    reported: number;
    incomplete: number;
    reportedInputTokens: number | null;
    reportedOutputTokens: number | null;
  };
  rows: {
    id: string;
    purpose: string;
    model: string;
    transport: string;
    usageStatus: string;
    inputTokens: number | null;
    outputTokens: number | null;
    startedAt: string;
  }[];
  note: string;
}
const number = (v: number | null) => (v === null ? "未知" : v.toLocaleString());
const status: Record<string, string> = {
  reported: "已返回用量",
  partial: "部分用量",
  unknown: "用量未知",
  invalid: "统计无效",
};
export function ModelUsagePanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
}) {
  const [data, setData] = useState<UsageView>(),
    [models, setModels] = useState<ModelSummary[]>([]),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const querying =
    run?.workflow === "usage_report" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  async function load() {
    const version = ++generation.current;
    setData(undefined);
    try {
      const value = await api<UsageView>("/model-usage");
      if (alive.current && version === generation.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (alive.current && version === generation.current) {
        setData(undefined);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    void api<ModelSummary[]>("/models")
      .then((m) => {
        if (alive.current) setModels(m.filter((x) => x.purpose === "chat"));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (
      run?.workflow === "usage_report" &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已回读本人的实际用量记录。"
          : "用量查询未完成，请核对执行状态。",
      );
      void load();
    }
  }, [run?.id, run?.state]);
  async function query() {
    setBusy(true);
    setError("");
    const input = {
      conversationId: view.project.conversationId,
      engine,
      workflow: "usage_report",
      instruction:
        "回读我本人的实际模型用量，明确区分完整、部分与未知统计，不推断价格或费用。",
      ...(engine !== "fixture" && modelId ? { modelProfileId: modelId } : {}),
    };
    const hash = JSON.stringify(input);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      const started = await mutation("/runs", {
        ...input,
        idempotencyKey: attempt.current!.key,
      });
      if (alive.current) {
        onRun({ ...started, workflow: "usage_report", engine });
        setNotice("已发起 AI 回读，完成后刷新实际记录。");
      }
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="work-panel settings-panel" aria-label="模型用量">
      <h3>模型用量</h3>
      <p className="muted">
        仅显示本人发起的模型请求。今日合计按 UTC 日界；明细为最近 30 天、至多
        100 条。缺失统计保留为未知。
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <button
        className="secondary"
        disabled={busy || querying}
        onClick={() => void load()}
      >
        刷新用量记录
      </button>
      {data ? (
        <>
          <div className="policy-summary" aria-label="今日模型请求统计">
            今日发起请求 {data.summary.requests} 次 · 已返回完整用量{" "}
            {data.summary.reported} 次 · 不完整 {data.summary.incomplete} 次
            <br />
            已返回输入 token：{number(data.summary.reportedInputTokens)} ·
            已返回输出 token：{number(data.summary.reportedOutputTokens)}
          </div>
          <p className="muted">{data.note}</p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void query();
            }}
          >
            <fieldset className="policy-fields" disabled={busy || querying}>
              <label>
                用量查询执行服务
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                >
                  <option value="dsh">DSH</option>
                  <option value="hermes">Hermes</option>
                  {view.user.demo ? (
                    <option value="fixture">演示回读（不调用模型）</option>
                  ) : null}
                </select>
              </label>
              {engine !== "fixture" ? (
                <label>
                  用量查询模型
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    <option value="">可用默认连接</option>
                    {models.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <p className="muted">
                AI
                查询会调用所选模型，可能产生费用；完成回执会包含本次已返回的统计。直接刷新无需模型调用。
              </p>
              <button className="primary">让 AI 回读本人用量</button>
            </fieldset>
          </form>
          <h4>请求明细</h4>
          {data.rows.map((row) => (
            <article className="usage-row" key={row.id}>
              <strong>{row.model}</strong>
              <span>{status[row.usageStatus] ?? "用量未知"}</span>
              <small>
                {new Date(row.startedAt).toLocaleString()} ·{" "}
                {row.purpose === "run"
                  ? "AI 执行"
                  : row.purpose === "embedding"
                    ? "向量请求"
                    : row.purpose === "verification"
                      ? "连接验证"
                      : "模型对话"}{" "}
                ·{" "}
                {row.transport === "completed"
                  ? "收到完整响应"
                  : row.transport === "rejected"
                    ? "服务拒绝"
                    : "请求结果未知"}
              </small>
              <span>
                输入 {number(row.inputTokens)} · 输出 {number(row.outputTokens)}
              </span>
            </article>
          ))}
          {!data.rows.length ? (
            <p className="muted">
              尚无请求记录。此前没有被观察的调用不会补记为零消耗。
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
