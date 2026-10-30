import { useEffect, useRef, useState } from "react";
import type { ModelSpendingPlan, WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
import { Dialog } from "./Dialog";
type Charge = {
  id: string;
  revision: number;
  currency: string | null;
  status: string;
  estimate: string | null;
  declared: string | null;
  reserved: string;
  reviewRequired: boolean;
  startedAt: string;
};
type Account = {
  id: string;
  name: string;
  model: string;
  canManage: boolean;
  revision: number;
  currency: string | null;
  dailyLimit: string | null;
  requestReservation: string;
  inputPerMillion: string | null;
  outputPerMillion: string | null;
  cacheReadPerMillion: string | null;
  cacheWritePerMillion: string | null;
  source?: string;
  balance: {
    known: string;
    held: string;
    unknown: number;
    review: number;
    remaining: string | null;
  } | null;
  requests: Charge[];
  history: {
    plan: ModelSpendingPlan;
    receipt: any;
    actorName: string;
    createdAt: string;
  }[];
};
const labels = {
  inputPerMillion: "普通输入单价 / 百万 token",
  outputPerMillion: "输出单价 / 百万 token",
  cacheReadPerMillion: "缓存读取单价 / 百万 token",
  cacheWritePerMillion: "缓存写入单价 / 百万 token",
};
const empty = {
  currency: "CNY",
  inputPerMillion: "",
  outputPerMillion: "",
  cacheReadPerMillion: "",
  cacheWritePerMillion: "",
  dailyLimit: "",
  requestReservation: "0",
  source: "",
};
const chargeLabel: Record<string, string> = {
  unpriced: "未定价",
  unknown: "费用未知",
  estimated: "价格估算",
  upper_estimate: "保守上界估算",
  declared: "员工核对声明",
};
export function ModelSpendingPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
}) {
  const [models, setModels] = useState<ModelSummary[]>([]),
    [id, setId] = useState(""),
    [data, setData] = useState<Account>(),
    [fields, setFields] = useState(empty),
    [confirmed, setConfirmed] = useState(false),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [executionModel, setExecutionModel] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [charge, setCharge] = useState<Charge>(),
    [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState("CNY"),
    [evidence, setEvidence] = useState(""),
    [reconciled, setReconciled] = useState(false);
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const managing =
    run?.workflow === "manage_spending" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  async function load(profileId: string) {
    const version = ++generation.current;
    setData(undefined);
    setFields(empty);
    setConfirmed(false);
    setCharge(undefined);
    setAmount("");
    setEvidence("");
    setReconciled(false);
    try {
      const result = await api<{ rows: Account[] }>(
        `/model-spending?modelProfileId=${encodeURIComponent(profileId)}`,
      );
      if (alive.current && version === generation.current) {
        const row = result.rows[0];
        if (!row) throw Error("此模型费用账户不可访问。");
        setData(row);
        setError("");
        setFields({
          currency: row.currency ?? "CNY",
          inputPerMillion: row.inputPerMillion ?? "",
          outputPerMillion: row.outputPerMillion ?? "",
          cacheReadPerMillion: row.cacheReadPerMillion ?? "",
          cacheWritePerMillion: row.cacheWritePerMillion ?? "",
          dailyLimit: row.dailyLimit ?? "",
          requestReservation: row.requestReservation,
          source: row.source ?? "",
        });
      }
    } catch (e) {
      if (alive.current && version === generation.current) {
        setData(undefined);
        setFields(empty);
        setCharge(undefined);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void api<ModelSummary[]>("/models")
      .then(async (list) => {
        if (!alive.current) return;
        setModels(list);
        if (list[0]) {
          setId(list[0].id);
          await load(list[0].id);
        }
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (
      run?.workflow === "manage_spending" &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已保存确认方案，以下显示实际费用账户。"
          : "费用操作未完成，请检查执行状态后重新核对。",
      );
      if (id) void load(id);
    }
  }, [run?.id, run?.state]);
  const edit = (key: keyof typeof fields, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setConfirmed(false);
    setNotice("");
  };
  async function apply(plan: ModelSpendingPlan) {
    setBusy(true);
    setError("");
    setNotice("");
    const input = { plan, mode, engine, executionModel },
      hash = JSON.stringify(input);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId: view.project.conversationId,
          engine,
          workflow: "manage_spending",
          instruction:
            "仅执行我已确认的费用方案，不改变模型连接、币种、价格、金额或预算，不宣称供应商账单已验证。",
          spendingPlan: plan,
          ...(engine !== "fixture" && executionModel
            ? { modelProfileId: executionModel }
            : {}),
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          setCharge(undefined);
          onRun({ ...started, engine, workflow: "manage_spending" });
          setNotice("已发起 AI 费用管理；执行完成后显示实际回执。");
        }
      } else {
        await mutation("/model-spending", {
          plan,
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          await load(id);
          setNotice(
            "费用方案已保存；核对金额仍是员工声明，不是系统验证的账单。",
          );
        }
      }
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || managing;
  return (
    <section className="work-panel settings-panel" aria-label="价格与预算">
      <h3>价格与预算</h3>
      <p className="muted">
        每个模型连接独立计价、预留和限制新请求；UTC
        日界，不同币种不混算。个人连接由本人管理，工作区连接由管理员管理。
      </p>
      {error && !charge ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <label className="spending-select">
        费用账户
        <select
          aria-label="费用账户"
          disabled={disabled}
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            void load(e.target.value);
          }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.scope === "personal" ? "个人" : "工作区"}
            </option>
          ))}
        </select>
      </label>
      {!models.length ? (
        <p className="muted">
          先在“模型连接”添加连接；系统不自动猜测价格或设置实际预算。
        </p>
      ) : null}
      <button
        type="button"
        className="secondary"
        disabled={!id || disabled}
        onClick={() => void load(id)}
      >
        重新读取费用账户
      </button>
      {data ? (
        <>
          <p className="policy-summary">
            配置版本 {data.revision} · {data.currency ?? "未定价"} ·{" "}
            {data.dailyLimit === null
              ? "本连接金额预算未启用"
              : `今日预算 ${data.dailyLimit}`}
            <br />
            {data.balance
              ? `已估算/声明 ${data.balance.known} · 预留 ${data.balance.held} · 可用 ${data.balance.remaining ?? "不限"} · 未知 ${data.balance.unknown} · 待核对 ${data.balance.review}`
              : "历史费用未知，不会自动按新价格回算或补零。"}
          </p>
          <p className="muted">
            预留限制新请求。已发请求可能超出预留；未知消耗或超额记录会在预算启用时暂停后续调用。价格是人工配置的估算依据，员工核对也不代表系统验证了供应商账单。
          </p>
          {data.canManage ? (
            <>
              <div className="settings-form">
                <label>
                  费用保存方式
                  <select
                    disabled={disabled}
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="direct">直接保存</option>
                    <option value="ai">AI 按确认方案保存</option>
                  </select>
                </label>
                {mode === "ai" ? (
                  <>
                    <label>
                      费用执行服务
                      <select
                        disabled={disabled}
                        value={engine}
                        onChange={(e) => setEngine(e.target.value)}
                      >
                        <option value="dsh">DSH</option>
                        <option value="hermes">Hermes</option>
                        {view.user.demo ? (
                          <option value="fixture">
                            演示流程（无模型调用）
                          </option>
                        ) : null}
                      </select>
                    </label>
                    <label>
                      费用执行模型
                      <select
                        disabled={disabled}
                        value={executionModel}
                        onChange={(e) => setExecutionModel(e.target.value)}
                      >
                        <option value="">可用默认对话连接</option>
                        {models
                          .filter((m) => m.purpose === "chat")
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="muted">
                      AI
                      保存可能产生模型费用；预算不足或账户冻结时，可直接保存或自行选择另一可用连接，系统不会自动换
                      Key。
                    </p>
                  </>
                ) : null}
              </div>
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!confirmed) return;
                  void apply({
                    operation: "configure",
                    modelProfileId: id,
                    expectedRevision: data.revision,
                    ...fields,
                    currency: fields.currency as "CNY" | "USD",
                    dailyLimit: fields.dailyLimit || null,
                    confirmed: true,
                  });
                }}
              >
                <fieldset className="policy-fields" disabled={disabled}>
                  <label>
                    计价币种
                    <select
                      value={fields.currency}
                      onChange={(e) => edit("currency", e.target.value)}
                    >
                      <option value="CNY">CNY</option>
                      <option value="USD">USD</option>
                    </select>
                  </label>
                  {(Object.keys(labels) as (keyof typeof labels)[]).map(
                    (key) => (
                      <label key={key}>
                        {labels[key]}
                        <input
                          required
                          inputMode="decimal"
                          value={fields[key]}
                          onChange={(e) => edit(key, e.target.value)}
                          placeholder="人工确认的单价，最多六位小数"
                        />
                      </label>
                    ),
                  )}
                  <p className="muted">
                    不区分缓存计费时，缓存单价填普通输入价；缺失缓存分类按较高单价保守估算，不自动计算汇率。
                  </p>
                  <label>
                    每日预算上限
                    <input
                      inputMode="decimal"
                      value={fields.dailyLimit}
                      onChange={(e) => edit("dailyLimit", e.target.value)}
                      placeholder="留空表示不启用本连接金额预算"
                    />
                  </label>
                  <label>
                    每请求预留金额
                    <input
                      required
                      inputMode="decimal"
                      value={fields.requestReservation}
                      onChange={(e) =>
                        edit("requestReservation", e.target.value)
                      }
                    />
                  </label>
                  <label>
                    计价依据
                    <input
                      required
                      maxLength={1000}
                      value={fields.source}
                      onChange={(e) => edit("source", e.target.value)}
                      placeholder="价格来源、日期与适用条件；不要填 Key"
                    />
                  </label>
                  <label className="policy-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已核对账户、单价、币种、预算和预留，确认保存
                  </label>
                  <button className="primary" disabled={!confirmed}>
                    {mode === "ai" ? "让 AI 保存费用配置" : "保存价格与预算"}
                  </button>
                </fieldset>
              </form>
              <h4>请求费用与核对</h4>
              <p className="muted">
                近 30 天最多 100
                条，未知/待核对优先。未结束请求不能立即核对，未结算中断记录至少等待五分钟。核对金额及依据会保留历史。
              </p>
              {data.requests.map((r) => (
                <article className="usage-row" key={r.id}>
                  <strong>
                    {chargeLabel[r.status] ?? r.status}
                    {r.reviewRequired ? " · 需核对" : ""}
                  </strong>
                  <span>
                    {r.declared ?? r.estimate ?? "未知"}{" "}
                    {r.currency ?? "币种未确定"}
                  </span>
                  <small>
                    {new Date(r.startedAt).toLocaleString()} · 预留 {r.reserved}{" "}
                    · 请求 {r.id}
                  </small>
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setCharge(r);
                      setAmount("");
                      setCurrency(r.currency ?? data.currency ?? "CNY");
                      setEvidence("");
                      setReconciled(false);
                      setError("");
                    }}
                  >
                    核对请求费用
                  </button>
                </article>
              ))}
              {!data.requests.length ? (
                <p className="muted">尚无请求费用记录。</p>
              ) : null}
              <details>
                <summary>费用变更与核对记录（最近 20 条）</summary>
                {data.history.map((h, i) => (
                  <article className="usage-row" key={i}>
                    <strong>
                      {h.plan.operation === "configure"
                        ? `价格/预算版本 ${h.receipt.revision}`
                        : `员工核对 ${h.receipt.amount} ${h.receipt.currency}`}
                    </strong>
                    <small>
                      {h.actorName} · {new Date(h.createdAt).toLocaleString()}
                    </small>
                    <p>
                      {h.plan.operation === "configure"
                        ? h.plan.source
                        : h.plan.evidence}
                    </p>
                  </article>
                ))}
              </details>
            </>
          ) : (
            <p className="muted">
              此工作区连接的费用由管理员管理；本人用量仍可在“模型用量”查看。
            </p>
          )}
        </>
      ) : null}
      {charge ? (
        <Dialog
          title="核对请求费用"
          error={error}
          onClose={() => {
            setCharge(undefined);
            setAmount("");
            setEvidence("");
            setReconciled(false);
          }}
        >
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reconciled) return;
              void apply({
                operation: "reconcile",
                requestId: charge.id,
                expectedRevision: charge.revision,
                currency: currency as "CNY" | "USD",
                amount,
                evidence,
                confirmed: true,
              });
            }}
          >
            <p className="muted">
              当前记录：{chargeLabel[charge.status]}
              。请依据实际核对结果填写；明确声明零金额也需要依据，不会把未知消耗自动视为零。
            </p>
            <label>
              核对币种
              <select
                disabled={disabled || !!charge.currency}
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setReconciled(false);
                }}
              >
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label>
              核对金额
              <input
                required
                inputMode="decimal"
                disabled={disabled}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setReconciled(false);
                }}
                placeholder="人工核对的金额，最多十二位小数"
              />
            </label>
            <label>
              核对依据
              <textarea
                required
                disabled={disabled}
                maxLength={2000}
                value={evidence}
                onChange={(e) => {
                  setEvidence(e.target.value);
                  setReconciled(false);
                }}
                placeholder="单据引用或核对说明；不填写 Key 或原始资料"
              />
            </label>
            <label className="policy-confirm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={reconciled}
                onChange={(e) => setReconciled(e.target.checked)}
              />
              我确认金额和依据，这是员工核对声明
            </label>
            <button className="primary" disabled={disabled || !reconciled}>
              {mode === "ai" ? "让 AI 保存费用核对" : "保存费用核对"}
            </button>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
