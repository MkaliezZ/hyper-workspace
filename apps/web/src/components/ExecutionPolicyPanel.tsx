import { useEffect, useRef, useState } from "react";
import {
  Workflow,
  type ExecutionRules,
  type WorkspaceView,
  type ExecutionPolicyPlan,
} from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
type PolicyView = {
  layers: {
    scope: string;
    scopeId: string;
    revision: number;
    rules: ExecutionRules;
  }[];
  effective: Required<Omit<ExecutionRules, "dailyRuns">>;
  counts: { workspace: number; project: number; personal: number };
  canManageShared: boolean;
};
const numbers = [
  ["maxContextBytes", "上下文上限（字节）", 1024, 100000],
  ["maxOutputTokens", "模型输出上限（token）", 64, 4096],
  ["maxDurationSeconds", "执行时限（秒）", 5, 180],
  ["maxActions", "业务动作上限", 0, 30],
  ["dailyRuns", "每日执行次数（UTC）", 0, 10000],
] as const;
const labels: Record<string, string> = {
  discussion_to_minutes: "讨论转纪要",
  project_report: "项目周报",
  revise_artifact: "修改成果",
  revise_task: "修改待办",
  manage_method: "方法与模板",
  review_artifact: "成果验收",
  follow_up: "检查进展",
  configure_follow_up: "配置定时跟进",
  configure_policy: "配置执行规则",
  usage_report: "查询本人用量",
  chat: "讨论回复",
  draft_reply: "企业回复草稿",
  read_file: "文件阅读",
  revise_file_reading: "修改文件解读",
};
export function ExecutionPolicyPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
}) {
  const [data, setData] = useState<PolicyView>(),
    [models, setModels] = useState<ModelSummary[]>([]),
    [scope, setScope] = useState<ExecutionPolicyPlan["scope"]>("personal");
  const [rules, setRules] = useState<ExecutionRules>({}),
    [confirmed, setConfirmed] = useState(false),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const path = `/projects/${view.project.id}/execution-policy`;
  const configuring =
    run?.workflow === "configure_policy" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  async function load() {
    const version = ++generation.current;
    setData(undefined);
    setRules({});
    setConfirmed(false);
    try {
      const value = await api<PolicyView>(path);
      if (alive.current && version === generation.current) {
        setData(value);
        setRules(value.layers.find((x) => x.scope === scope)?.rules ?? {});
        setConfirmed(false);
        setError("");
      }
    } catch (e) {
      if (alive.current && version === generation.current) {
        setData(undefined);
        setRules({});
        setConfirmed(false);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    void api<ModelSummary[]>("/models")
      .then((v) => {
        if (alive.current) setModels(v.filter((x) => x.purpose === "chat"));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (
      run?.workflow === "configure_policy" &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已按确认方案保存规则。"
          : "规则执行未完成，请核对回执后重试。",
      );
      void load();
    }
  }, [run?.id, run?.state]);
  const edit = (next: ExecutionRules) => {
    setRules(next);
    setConfirmed(false);
    setNotice("");
  };
  async function save() {
    if (!data || !confirmed || busy || configuring) return;
    setBusy(true);
    setError("");
    setNotice("");
    const policyPlan = {
      scope,
      expectedRevision:
        data.layers.find((x) => x.scope === scope)?.revision ?? 0,
      rules,
      confirmed: true,
    };
    const body = { policyPlan, mode, engine, modelId };
    const hash = JSON.stringify(body);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId: view.project.conversationId,
          workflow: "configure_policy",
          engine,
          instruction:
            "仅保存我明确确认的执行规则方案，不改变范围、权限和数值。",
          policyPlan,
          ...(engine !== "fixture" && modelId
            ? { modelProfileId: modelId }
            : {}),
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          onRun({ ...started, workflow: "configure_policy", engine });
          setNotice("已发起 AI 配置，完成后显示实际规则版本。");
        }
      } else {
        await mutation(path, {
          ...policyPlan,
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          await load();
          setNotice("执行规则已保存。");
        }
      }
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="work-panel settings-panel" aria-label="执行规则">
      <h3>执行规则</h3>
      <p className="muted">
        共享限制、个人限制与单次任务限制取交集。提高某一层的上限不会放宽其他层；运行中的任务保留已获准的更严限制。
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <button
        className="secondary"
        type="button"
        disabled={busy || configuring}
        onClick={() => void load()}
      >
        重新读取规则
      </button>
      {data ? (
        <>
          <p className="policy-summary">
            当前项目有效限制：{data.effective.maxOutputTokens} 输出 token ·{" "}
            {data.effective.maxDurationSeconds} 秒 · {data.effective.maxActions}{" "}
            个业务动作。今日获准执行：工作区 {data.counts.workspace}，本项目{" "}
            {data.counts.project}，本人 {data.counts.personal}。
          </p>
          <p className="muted">
            次数按 UTC
            每日累计，已获准后失败或取消仍计数；排队中取消不计数。此处只统计获准的执行次数；模型
            HTTP 请求和已返回 token 请查看“模型用量”，费用账单尚未接入。
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy || configuring} className="policy-fields">
              <label>
                规则范围
                <select
                  value={scope}
                  onChange={(e) => {
                    const next = e.target.value as typeof scope;
                    setScope(next);
                    edit(
                      data.layers.find((x) => x.scope === next)?.rules ?? {},
                    );
                  }}
                >
                  <option value="personal">个人 · 仅影响自己</option>
                  {data.canManageShared ? (
                    <>
                      <option value="project">
                        项目 · {view.project.name}
                      </option>
                      <option value="workspace">工作区 · 所有成员</option>
                    </>
                  ) : null}
                </select>
              </label>
              <p className="muted">
                当前版本：
                {data.layers.find((x) => x.scope === scope)?.revision ?? 0}
                。空白数值继承其他层；保存替换当前范围的整份配置。
              </p>
              {numbers.map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={rules[key] ?? ""}
                    placeholder="继承其他层"
                    onChange={(e) =>
                      edit({
                        ...rules,
                        [key]:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
              <label>
                表达偏好
                <select
                  value={rules.expression ?? ""}
                  onChange={(e) =>
                    edit({
                      ...rules,
                      expression: (e.target.value ||
                        undefined) as ExecutionRules["expression"],
                    })
                  }
                >
                  <option value="">继承</option>
                  <option value="concise">简洁</option>
                  <option value="balanced">适中</option>
                  <option value="detailed">详细</option>
                </select>
              </label>
              <label>
                允许的执行服务
                <select
                  multiple
                  aria-label="允许的执行服务"
                  value={rules.engines ?? []}
                  onChange={(e) =>
                    edit({
                      ...rules,
                      engines: Array.from(
                        e.target.selectedOptions,
                        (x) => x.value,
                      ) as ExecutionRules["engines"],
                    })
                  }
                >
                  <option value="dsh">DSH</option>
                  <option value="hermes">Hermes</option>
                  {view.user.demo ? (
                    <option value="fixture">演示流程（无真实模型）</option>
                  ) : null}
                </select>
              </label>
              <button
                className="secondary"
                type="button"
                onClick={() => edit({ ...rules, engines: undefined })}
              >
                执行服务继承其他层
              </button>
              <label>
                允许的工作类型
                <select
                  multiple
                  aria-label="允许的工作类型"
                  value={rules.workflows ?? []}
                  onChange={(e) =>
                    edit({
                      ...rules,
                      workflows: Array.from(
                        e.target.selectedOptions,
                        (x) => x.value,
                      ) as ExecutionRules["workflows"],
                    })
                  }
                >
                  {Workflow.options.map((x) => (
                    <option key={x} value={x}>
                      {labels[x]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary"
                type="button"
                onClick={() => edit({ ...rules, workflows: undefined })}
              >
                工作类型继承其他层
              </button>
              <p className="muted">
                未设置列表时继承；设置后空列表会禁止全部。关闭 AI
                配置后，仍可在此手动调整。
              </p>
              <label>
                保存方式
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="direct">直接保存</option>
                  <option value="ai">AI 按确认方案保存</option>
                </select>
              </label>
              {mode === "ai" ? (
                <>
                  <label>
                    规则执行服务
                    <select
                      value={engine}
                      onChange={(e) => setEngine(e.target.value)}
                    >
                      <option value="dsh">DSH</option>
                      <option value="hermes">Hermes</option>
                      {view.user.demo ? (
                        <option value="fixture">演示流程（无真实模型）</option>
                      ) : null}
                    </select>
                  </label>
                  <label>
                    规则模型连接
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    >
                      <option value="">使用可用默认连接</option>
                      {models.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              <label className="policy-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对范围和全部规则，确认保存此方案
              </label>
              <button className="primary" disabled={!confirmed}>
                {mode === "ai" ? "发起 AI 规则配置" : "保存执行规则"}
              </button>
            </fieldset>
          </form>
        </>
      ) : null}
    </section>
  );
}
