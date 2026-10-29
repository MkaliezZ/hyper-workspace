import { useEffect, useRef, useState } from "react";
import type { FollowUpPlan, WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";

interface Schedule {
  id: string;
  state: "active" | "paused" | "cancelled" | "completed";
  version: number;
  engine: string;
  modelProfileId: string | null;
  intervalMinutes: number;
  maxChecks: number;
  checksStarted: number;
  nextCheckAt: string | null;
  expiresAt: string;
  lastRunId: string | null;
  lastError: string | null;
}
const stateLabels = {
  active: "定时检查中",
  paused: "已暂停",
  cancelled: "已取消",
  completed: "已停止调度（次数用完或到期）",
};
export function FollowUpPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (value: any) => void;
}) {
  const [rows, setRows] = useState<Schedule[]>([]),
    [models, setModels] = useState<ModelSummary[]>([]);
  const [interval, setIntervalMinutes] = useState(60),
    [maxChecks, setMaxChecks] = useState(8);
  const [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [mode, setMode] = useState("direct");
  const [busy, setBusy] = useState(false),
    [available, setAvailable] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const conversationId = view.project.conversationId;
  const path = "/conversations/" + conversationId + "/follow-ups";
  async function load() {
    const current = ++generation.current;
    try {
      const list = await api<Schedule[]>(path);
      if (alive.current && current === generation.current) {
        setRows(list);
        setAvailable(true);
        setError("");
      }
    } catch (e) {
      if (alive.current && current === generation.current) {
        setError((e as Error).message);
        setRows([]);
        setAvailable(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    let current = true;
    void api<ModelSummary[]>("/models")
      .then((values) => {
        if (current) setModels(values.filter((m) => m.purpose === "chat"));
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    return () => {
      current = false;
      alive.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [conversationId]);
  useEffect(() => {
    if (
      run?.workflow === "configure_follow_up" &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded" ? "AI 配置已保存，以下为实际跟进记录。" : "",
      );
      void load();
    }
  }, [run?.id, run?.state]);
  async function apply(plan: FollowUpPlan, target?: Schedule) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const chosenEngine = target?.engine ?? engine,
      chosenModel = target?.modelProfileId ?? modelId;
    const input = {
      plan,
      engine: chosenEngine,
      ...(chosenEngine !== "fixture" && chosenModel
        ? { modelProfileId: chosenModel }
        : {}),
    };
    const hash = JSON.stringify({ mode, input });
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId,
          workflow: "configure_follow_up",
          engine: chosenEngine,
          instruction: "严格按我选定的操作、间隔与次数上限配置此项目跟进。",
          followUpPlan: plan,
          ...(chosenEngine !== "fixture" && chosenModel
            ? { modelProfileId: chosenModel }
            : {}),
          idempotencyKey: attempt.current!.key,
        });
        if (!alive.current) return;
        onRun({
          ...started,
          engine: chosenEngine,
          workflow: "configure_follow_up",
        });
        setNotice("已发起 AI 配置；执行完成后显示实际配置回执。");
      } else {
        await mutation(path, {
          ...input,
          idempotencyKey: attempt.current!.key,
        });
        if (!alive.current) return;
        setNotice("跟进配置已保存。已完成的检查与消息保留。");
        await load();
      }
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const active = rows.some((r) => ["active", "paused"].includes(r.state));
  const configuring =
    run?.workflow === "configure_follow_up" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const selected = models.find((m) => m.id === modelId);
  const incompatible =
    engine !== "fixture" &&
    selected &&
    view.engines[engine]?.modelProviders &&
    !view.engines[engine]!.modelProviders!.includes(selected.provider);
  return (
    <section className="follow-up-panel" aria-label="我的定时跟进">
      <h3>我的定时跟进</h3>
      <p className="muted small">
        只跟进当前项目待办；首次建立基线，无变化不发项目消息。每次检查仍会调用所选模型。最多运行
        30 天，达到次数上限即停止调度；失败或授权失效后暂停。
      </p>
      <label className="follow-up-mode">
        配置方式
        <select
          aria-label="跟进配置方式"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          disabled={busy || configuring}
        >
          <option value="direct">直接设置</option>
          <option value="ai">让 AI 设置</option>
        </select>
      </label>
      {error ? (
        <p role="alert" className="error-banner">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="muted small">
          {notice}
        </p>
      ) : null}
      {active || !available ? null : (
        <form
          className="follow-up-form"
          onSubmit={(e) => {
            e.preventDefault();
            void apply({
              operation: "create",
              intervalMinutes: interval,
              maxChecks,
            });
          }}
        >
          <label>
            每隔多少分钟
            <input
              aria-label="跟进间隔分钟"
              type="number"
              min={15}
              max={1440}
              required
              value={interval}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            />
          </label>
          <label>
            最多检查次数
            <input
              aria-label="跟进次数上限"
              type="number"
              min={1}
              max={96}
              required
              value={maxChecks}
              onChange={(e) => setMaxChecks(Number(e.target.value))}
            />
          </label>
          <label>
            执行器
            <select
              aria-label="跟进执行器"
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
            >
              <option value="dsh">DSH</option>
              <option value="hermes">Hermes</option>
              {view.user.demo ? (
                <option value="fixture">演示流程 · 不调用模型</option>
              ) : null}
            </select>
          </label>
          {engine !== "fixture" ? (
            <label>
              模型连接
              <select
                aria-label="跟进模型连接"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              >
                <option value="">当前默认连接（保存时固定）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="muted small">
            最短间隔 15 分钟，最多 96
            次。创建后首次检查尽快开始；暂停、取消会阻止尚未完成的检查，不撤回已保存结果。次数上限限制检查发起次数，不是金额预算；AI
            配置本身也可能产生模型费用。
          </p>
          <button
            className="primary"
            disabled={busy || configuring || !!incompatible}
          >
            {mode === "ai" ? "让 AI 创建跟进" : "保存定时跟进"}
          </button>
        </form>
      )}
      <div className="follow-up-list">
        {rows.map((row) => (
          <article key={row.id} className="follow-up-row">
            <div>
              <strong>{stateLabels[row.state]}</strong>
              <p>
                {row.engine === "fixture"
                  ? "演示执行"
                  : row.engine.toUpperCase()}{" "}
                · 每 {row.intervalMinutes} 分钟 · 已发起 {row.checksStarted}/
                {row.maxChecks} 次
              </p>
              <small>
                {row.nextCheckAt
                  ? "下次：" + new Date(row.nextCheckAt).toLocaleString("zh-CN")
                  : "没有下一次检查"}{" "}
                · 最晚到期：
                {new Date(row.expiresAt).toLocaleDateString("zh-CN")}
              </small>
              {row.lastError ? <p role="status">{row.lastError}</p> : null}
            </div>
            <div className="follow-up-actions">
              {row.state === "active" ? (
                <button
                  disabled={busy || configuring}
                  onClick={() =>
                    void apply(
                      {
                        operation: "pause",
                        scheduleId: row.id,
                        expectedVersion: row.version,
                      },
                      row,
                    )
                  }
                >
                  {mode === "ai" ? "AI 暂停" : "暂停跟进"}
                </button>
              ) : null}
              {row.state === "paused" ? (
                <button
                  disabled={
                    busy || configuring || row.checksStarted >= row.maxChecks
                  }
                  onClick={() =>
                    void apply(
                      {
                        operation: "resume",
                        scheduleId: row.id,
                        expectedVersion: row.version,
                      },
                      row,
                    )
                  }
                >
                  {mode === "ai" ? "AI 恢复" : "恢复跟进"}
                </button>
              ) : null}
              {["active", "paused"].includes(row.state) ? (
                <button
                  disabled={busy || configuring}
                  onClick={() =>
                    void apply(
                      {
                        operation: "cancel",
                        scheduleId: row.id,
                        expectedVersion: row.version,
                      },
                      row,
                    )
                  }
                >
                  {mode === "ai" ? "AI 取消" : "取消跟进"}
                </button>
              ) : null}
              {row.lastRunId ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    void api("/runs/" + row.lastRunId)
                      .then((value) => {
                        if (alive.current) onRun(value);
                      })
                      .catch((e) => {
                        if (alive.current) setError(e.message);
                      });
                  }}
                >
                  查看最近检查
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
