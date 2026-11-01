import { useEffect, useRef, useState } from "react";
import type { WorkspaceView } from "@hyper/contracts";
import {
  NotificationPlan,
  type NotificationRules,
} from "@hyper/contracts/notifications";
import { api, ApiError, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";

type Scope = "workspace" | "project" | "personal";
type PolicyView = {
  layers: {
    scope: Scope;
    scopeId: string;
    revision: number;
    rules: NotificationRules;
  }[];
  effective: Required<NotificationRules>;
  canManageShared: boolean;
  recentChanges: {
    id: string;
    scope: Scope;
    revision: number;
    requestKey?: string;
  }[];
  recentRuns?: {
    id: string;
    state: string;
    engine: string;
    operation: string;
    requestKey: string;
  }[];
};
type Attempt = {
  path: string;
  body: Record<string, unknown>;
  ai: boolean;
  operation: string;
  engine: string;
};
const scopeNames = {
  workspace: "工作区",
  project: "当前项目",
  personal: "本人",
};
const modeNames = { all: "全部变化", important: "仅重要变化", quiet: "静默" };
const fields = [
  ["added", "新增待办"],
  ["removed", "移除待办"],
  ["title", "标题"],
  ["assignee", "负责人"],
  ["status", "状态"],
  ["dueDate", "截止日期"],
] as const;

export function NotificationPolicyPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
}) {
  const [data, setData] = useState<PolicyView>(),
    [scope, setScope] = useState<Scope>("personal");
  const [rules, setRules] = useState<NotificationRules>({}),
    [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState("");
  const [models, setModels] = useState<ModelSummary[]>([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState<Attempt>();
  const alive = useRef(false),
    generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined),
    modelController = useRef<AbortController | undefined>(undefined),
    scopeRef = useRef(scope);
  const admitted = useRef<{ id: string; operation: string } | undefined>(
    undefined,
  );
  const path = `/projects/${view.project.id}/notification-policy`;
  const configuring =
    !!admitted.current &&
    run?.id === admitted.current?.id &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const canUseModel =
    engine === "fixture"
      ? view.user.demo
      : models.some(
          (m) =>
            m.id === modelId &&
            m.keyHint &&
            (engine !== "dsh" || m.provider === "openai-compatible"),
        );
  const denied = (e: unknown) =>
    e instanceof ApiError && [401, 403, 404].includes(e.status);
  function clearPrivate() {
    generation.current++;
    controller.current?.abort();
    modelController.current?.abort();
    admitted.current = undefined;
    setData(undefined);
    setRules({});
    setConfirmed(false);
    setModels([]);
    setPending(undefined);
  }
  async function load() {
    controller.current?.abort();
    const control = new AbortController(),
      version = ++generation.current;
    controller.current = control;
    setData(undefined);
    setRules({});
    setConfirmed(false);
    try {
      const value = await api<PolicyView>(path, { signal: control.signal });
      if (!alive.current || version !== generation.current) return;
      setData(value);
      setRules(
        value.layers.find((x) => x.scope === scopeRef.current)?.rules ?? {},
      );
      setError("");
    } catch (e) {
      if (
        !alive.current ||
        version !== generation.current ||
        control.signal.aborted
      )
        return;
      if (denied(e)) clearPrivate();
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const control = new AbortController();
    modelController.current = control;
    void api<ModelSummary[]>("/models", { signal: control.signal })
      .then((value) => {
        if (alive.current && !control.signal.aborted)
          setModels(value.filter((m) => m.purpose === "chat"));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
      controller.current?.abort();
      control.abort();
    };
  }, []);
  useEffect(() => {
    if (
      run?.id !== admitted.current?.id ||
      !["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run?.state,
      )
    )
      return;
    const operation = admitted.current!.operation;
    admitted.current = undefined;
    setNotice(
      run.state === "succeeded"
        ? operation === "read"
          ? "AI 已回读当前有效规则，请核对实际回执。"
          : "AI 已按确认方案保存提醒规则。"
        : "提醒操作未完成，请核对实际回执。必要时重新读取并确认新方案。",
    );
    void load();
  }, [run?.id, run?.state]);
  function edit(next: NotificationRules) {
    setRules(next);
    setConfirmed(false);
    setNotice("");
  }
  async function dispatch(attempt: Attempt) {
    if (busy || configuring) return;
    setBusy(true);
    setError("");
    setNotice("");
    // Freeze the entire request before sending. A missing receipt may follow a committed write.
    setPending(attempt);
    try {
      const actual = await mutation(attempt.path, attempt.body);
      if (!alive.current) return;
      setPending(undefined);
      if (attempt.ai) {
        admitted.current = { id: actual.id, operation: attempt.operation };
        onRun({
          ...actual,
          workflow: "manage_notifications",
          engine: attempt.engine,
        });
        setNotice("提醒操作已排队，完成后按实际回执更新。");
      } else {
        await load();
        if (alive.current) setNotice("提醒规则已保存。");
      }
    } catch (e) {
      if (!alive.current) return;
      if (denied(e)) {
        generation.current++;
        controller.current?.abort();
        clearPrivate();
      } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        setPending(undefined);
        await load();
      }
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function inspectOwn() {
    if (busy || configuring) return;
    setBusy(true);
    setError("");
    controller.current?.abort();
    const control = new AbortController(),
      version = ++generation.current;
    controller.current = control;
    try {
      const value = await api<PolicyView>(path, { signal: control.signal });
      if (!alive.current || version !== generation.current) return;
      // A history check must not silently rebase an unsaved edit onto a newer revision.
      setData((current) =>
        current
          ? {
              ...current,
              recentChanges: value.recentChanges,
              recentRuns: value.recentRuns,
            }
          : value,
      );
      const known = pending?.ai
        ? value.recentRuns?.find(
            (item) => item.requestKey === pending.body.idempotencyKey,
          )
        : undefined;
      if (known) {
        const actual = await api(`/runs/${known.id}`, {
          signal: control.signal,
        });
        if (!alive.current || version !== generation.current) return;
        admitted.current = { id: actual.id, operation: known.operation };
        setPending(undefined);
        onRun(actual);
        setNotice("已找到原提醒执行，未提交第二次请求。");
      } else if (
        pending &&
        !pending.ai &&
        value.recentChanges.some(
          (item) => item.requestKey === pending.body.idempotencyKey,
        )
      ) {
        setPending(undefined);
        await load();
        if (alive.current) setNotice("已找到原提醒设置回执，未再次写入。");
      } else
        setNotice(
          pending
            ? "当前最近记录中尚未找到原回执，不能据此判断失败；可继续使用原请求键核对。"
            : "已读取本人最近操作；未更改当前编辑方案或规则版本。",
        );
    } catch (e) {
      if (
        !alive.current ||
        version !== generation.current ||
        control.signal.aborted
      )
        return;
      if (denied(e)) clearPrivate();
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function openRecent(id: string) {
    if (busy || pending || configuring) return;
    const version = generation.current;
    setBusy(true);
    setError("");
    try {
      const actual = await api(`/runs/${id}`);
      if (alive.current && version === generation.current) onRun(actual);
    } catch (e) {
      if (!alive.current) return;
      if (denied(e)) clearPrivate();
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function start(operation: "configure" | "read") {
    if (
      !data ||
      pending ||
      busy ||
      configuring ||
      (operation === "configure" && !confirmed)
    )
      return;
    try {
      const plan = NotificationPlan.parse(
        operation === "read"
          ? { operation }
          : {
              operation,
              scope,
              expectedRevision:
                data.layers.find((x) => x.scope === scope)?.revision ?? 0,
              rules,
              confirmed: true,
            },
      );
      const ai = operation === "read" || mode === "ai";
      if (ai && !canUseModel) {
        setError(
          "请选择可用的对话模型连接。DSH 使用 OpenAI-compatible 连接；演示流程不调用真实模型。",
        );
        return;
      }
      void dispatch({
        path: ai ? "/runs" : path,
        ai,
        operation,
        engine,
        body: ai
          ? {
              conversationId: view.project.conversationId,
              workflow: "manage_notifications",
              engine,
              instruction:
                operation === "read"
                  ? "只回读当前有效提醒规则，不修改任何设置。"
                  : "仅保存我已确认的提醒范围、版本和规则，不改变任何参数。",
              notificationPlan: plan,
              ...(engine !== "fixture" ? { modelProfileId: modelId } : {}),
              idempotencyKey: crypto.randomUUID(),
            }
          : { plan, idempotencyKey: crypto.randomUUID() },
      });
    } catch {
      setError("请核对提醒条件和合并间隔（0 至 1440 的整数分钟）。");
    }
  }
  return (
    <section className="work-panel settings-panel" aria-label="跟进提醒">
      <h3>跟进提醒</h3>
      <p className="muted">
        设置项目进展检查何时发布一条合并消息。本人偏好只约束由本人发起的手动或定时检查；其他同事的检查仍按其有效规则执行。手机和来源会话通知请在企业消息的通信管理中设置。
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {pending && !busy ? (
        <div className="policy-summary" role="status">
          尚未取得原操作回执。已保留原方案和请求键，请核对原操作结果。
          <button className="secondary" onClick={() => void dispatch(pending)}>
            重试原提醒请求
          </button>
        </div>
      ) : null}
      <button
        className="secondary"
        disabled={busy || configuring || !!pending}
        onClick={() => void load()}
      >
        重新读取提醒规则
      </button>
      <button
        className="secondary"
        disabled={busy || configuring || (!data && !pending)}
        onClick={() => void inspectOwn()}
      >
        核对本人提醒操作
      </button>
      {data ? (
        <>
          <p className="policy-summary">
            当前有效提醒：{modeNames[data.effective.mode]} · 合并间隔{" "}
            {data.effective.minIntervalMinutes} 分钟。
          </p>
          <p className="muted">
            工作区、项目和本人规则取更严限制；重要条件取交集，未设置时继承。静默、未达重要条件和间隔中的变化会保留到下次获准检查，不保证在间隔结束时立即推送。
          </p>
          <p>
            有效重要条件：
            {data.effective.importantFields
              .map((field) => fields.find(([id]) => id === field)?.[1])
              .join("、") || "无"}
            。
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              start("configure");
            }}
          >
            <fieldset
              disabled={busy || configuring || !!pending}
              className="policy-fields"
            >
              <label>
                提醒规则范围
                <select
                  value={scope}
                  onChange={(e) => {
                    const next = e.target.value as Scope;
                    scopeRef.current = next;
                    setScope(next);
                    edit(
                      data.layers.find((x) => x.scope === next)?.rules ?? {},
                    );
                  }}
                >
                  {Object.entries(scopeNames).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                当前提醒版本：
                {data.layers.find((x) => x.scope === scope)?.revision ?? 0}
              </p>
              {scope !== "personal" && !data.canManageShared ? (
                <p>只有当前管理员可以修改共享提醒规则。</p>
              ) : null}
              <fieldset
                disabled={scope !== "personal" && !data.canManageShared}
                className="policy-fields"
              >
                <label>
                  提醒模式
                  <select
                    aria-label="提醒模式"
                    value={rules.mode ?? "inherit"}
                    onChange={(e) =>
                      edit({
                        ...rules,
                        mode:
                          e.target.value === "inherit"
                            ? undefined
                            : (e.target.value as NotificationRules["mode"]),
                      })
                    }
                  >
                    <option value="inherit">继承其他层</option>
                    {Object.entries(modeNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="policy-confirm">
                  <input
                    type="checkbox"
                    checked={rules.importantFields !== undefined}
                    onChange={(e) =>
                      edit({
                        ...rules,
                        importantFields: e.target.checked
                          ? [...data.effective.importantFields]
                          : undefined,
                      })
                    }
                  />
                  自定义重要变化条件
                </label>
                {rules.importantFields !== undefined ? (
                  <div
                    className="notification-options"
                    role="group"
                    aria-label="重要变化条件"
                  >
                    {fields.map(([id, name]) => (
                      <label className="policy-confirm" key={id}>
                        <input
                          type="checkbox"
                          checked={rules.importantFields!.includes(id)}
                          onChange={(e) =>
                            edit({
                              ...rules,
                              importantFields: e.target.checked
                                ? [...rules.importantFields!, id]
                                : rules.importantFields!.filter(
                                    (value) => value !== id,
                                  ),
                            })
                          }
                        />
                        {name}
                      </label>
                    ))}
                    <p className="muted">
                      全部取消表示没有变化能触发“仅重要变化”提醒。达到重要条件时，其他尚未通知的变化一并合入一条消息。
                    </p>
                  </div>
                ) : null}
                <label>
                  最短合并间隔（分钟）
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    step={1}
                    placeholder="留空继承"
                    value={rules.minIntervalMinutes ?? ""}
                    onChange={(e) =>
                      edit({
                        ...rules,
                        minIntervalMinutes:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  提醒保存方式
                  <select
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="direct">直接保存</option>
                    <option value="ai">AI 按确认方案保存</option>
                  </select>
                </label>
                <label className="policy-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已核对提醒范围、条件与版本，确认保存此方案
                </label>
                <button
                  className="primary"
                  disabled={!confirmed || (mode === "ai" && !canUseModel)}
                >
                  {mode === "ai" ? "发起 AI 提醒配置" : "保存提醒规则"}
                </button>
              </fieldset>
              <label>
                提醒执行服务
                <select
                  value={engine}
                  onChange={(e) => {
                    setEngine(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="dsh">DSH</option>
                  <option value="hermes">Hermes</option>
                  {view.user.demo ? (
                    <option value="fixture">演示流程（无真实模型）</option>
                  ) : null}
                </select>
              </label>
              <label>
                提醒模型连接
                <select
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">请选择连接</option>
                  {models
                    .filter(
                      (m) =>
                        engine !== "dsh" || m.provider === "openai-compatible",
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.keyHint}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              {!canUseModel ? (
                <p className="muted">
                  AI 操作需要可用对话模型。DSH 使用 OpenAI-compatible
                  连接；也可先直接保存。
                </p>
              ) : null}
              <button
                type="button"
                className="secondary"
                disabled={!canUseModel}
                onClick={() => start("read")}
              >
                AI 回读提醒规则
              </button>
            </fieldset>
          </form>
          {data.recentRuns?.length ? (
            <details>
              <summary>本人最近的提醒执行</summary>
              <ul>
                {data.recentRuns.map((item) => (
                  <li key={item.id}>
                    {item.engine} ·{" "}
                    {(
                      {
                        queued: "已排队",
                        running: "执行中",
                        succeeded: "已完成",
                        failed: "未完成",
                        cancelled: "已停止",
                        recovery_required: "待核对",
                      } as Record<string, string>
                    )[item.state] ?? "状态待核对"}{" "}
                    <button
                      className="secondary"
                      disabled={busy || configuring || !!pending}
                      onClick={() => void openRecent(item.id)}
                    >
                      查看提醒执行 {item.id.slice(0, 8)}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {data.recentChanges.length ? (
            <details>
              <summary>本人最近的提醒设置回执</summary>
              <ul>
                {data.recentChanges.map((item) => (
                  <li key={item.id}>
                    {scopeNames[item.scope]} · 版本 {item.revision} · {item.id}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
