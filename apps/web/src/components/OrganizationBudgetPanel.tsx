import { useEffect, useRef, useState } from "react";
import type { OrganizationBudgetPlan, WorkspaceView } from "@hyper/contracts";
import { api, mutation, ApiError } from "../api";
import type { ModelSummary } from "./ModelSettings";
type Price = Omit<
  Extract<OrganizationBudgetPlan, { operation: "budget_price" }>,
  "operation" | "expectedRevision" | "confirmed"
> & { priceKey: string; revision: number };
type Control = {
  scope: string;
  projectId: string | null;
  revision: number;
  currency: "USD" | "CNY";
  dailyLimit: string | null;
  requestReservation: string;
  balance: {
    known: string;
    held: string;
    unknown: number;
    review: number;
    mismatched: number;
    remaining: string | null;
  };
};
type Charge = {
  scope: "workspace" | "project" | "other-project";
  id: string;
  projectId: string | null;
  revision: number;
  currency: "USD" | "CNY" | null;
  status: string;
  estimate: string | null;
  declared: string | null;
  reviewRequired: boolean;
  startedAt: string;
};
type Data = {
  controls: Control[];
  costsByCurrency?: {
    currency: string | null;
    known: string;
    requests: number;
    unknown: number;
    review: number;
  }[];
  prices: Price[];
  charges: Charge[];
  history: { receipt: any; createdAt: string }[];
  note: string;
  nextBefore: string | null;
};
const emptyPrice = {
  provider: "openai-compatible",
  endpoint: "",
  model: "",
  purpose: "chat",
  currency: "CNY",
  inputPerMillion: "",
  outputPerMillion: "",
  cacheReadPerMillion: "",
  cacheWritePerMillion: "",
  source: "",
};
const rateLabels = {
  inputPerMillion: "企业普通输入单价 / 百万 token",
  outputPerMillion: "企业输出单价 / 百万 token",
  cacheReadPerMillion: "企业缓存读取单价 / 百万 token",
  cacheWritePerMillion: "企业缓存写入单价 / 百万 token",
};
const chargeLabels: Record<string, string> = {
  unpriced: "未定价",
  unknown: "企业费用未知",
  estimated: "企业价格估算",
  upper_estimate: "企业保守上界",
  declared: "管理员核对声明",
};
export function OrganizationBudgetPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
}) {
  const [data, setData] = useState<Data>(),
    [models, setModels] = useState<ModelSummary[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(true);
  const [kind, setKind] = useState("limits"),
    [scope, setScope] = useState("project"),
    [currency, setCurrency] = useState<"CNY" | "USD">("CNY"),
    [limit, setLimit] = useState(""),
    [reservation, setReservation] = useState("0");
  const [priceKey, setPriceKey] = useState(""),
    [price, setPrice] = useState(emptyPrice),
    [chargeId, setChargeId] = useState(""),
    [amount, setAmount] = useState(""),
    [evidence, setEvidence] = useState("");
  const [limitRevision, setLimitRevision] = useState(0),
    [chargeRevision, setChargeRevision] = useState(0);
  const [exactPrice, setExactPrice] = useState<Price>(),
    [before, setBefore] = useState(""),
    [pendingOnly, setPendingOnly] = useState(false);
  const [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const alive = useRef(false),
    sequence = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined),
    ownRun = useRef<string | undefined>(undefined);
  const selected = data?.controls.find((x) => x.scope === scope),
    selectedPrice =
      exactPrice?.priceKey === priceKey
        ? exactPrice
        : data?.prices.find((x) => x.priceKey === priceKey),
    selectedCharge = data?.charges.find((x) => x.id === chargeId);
  const managing =
    run?.workflow === "manage_spending" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const disabled = busy || managing || stale || !data;
  function clearPrivate() {
    setData(undefined);
    setModels([]);
    setPrice({ ...emptyPrice });
    setPriceKey("");
    setExactPrice(undefined);
    setBefore("");
    setPendingOnly(false);
    setChargeId("");
    setAmount("");
    setEvidence("");
    setConfirmed(false);
    setNotice("");
    setLimit("");
    setReservation("0");
    setLimitRevision(0);
    setChargeRevision(0);
  }
  function hydrate(c?: Control) {
    setLimitRevision(c?.revision ?? 0);
    setCurrency(c?.currency ?? "CNY");
    setLimit(c?.dailyLimit ?? "");
    setReservation(c?.requestReservation ?? "0");
    setConfirmed(false);
  }
  async function load(
    initial = false,
    pageBefore = "",
    onlyPending = pendingOnly,
  ) {
    const seq = ++sequence.current;
    setStale(true);
    try {
      const [result, connections] = await Promise.all([
        api<Data>(
          "/organization-budgets?projectId=" +
            encodeURIComponent(view.project.id) +
            (pageBefore ? "&before=" + encodeURIComponent(pageBefore) : "") +
            (onlyPending ? "&pendingOnly=true" : ""),
        ),
        api<ModelSummary[]>("/models"),
      ]);
      if (!alive.current || seq !== sequence.current) return;
      setData(result);
      setBefore(pageBefore);
      setPendingOnly(onlyPending);
      if (!result.charges.some((c) => c.id === chargeId)) {
        setChargeId("");
        setAmount("");
        setEvidence("");
        setConfirmed(false);
      }
      setModels(connections.filter((x) => x.purpose === "chat"));
      setError("");
      setStale(false);
      if (initial) hydrate(result.controls.find((x) => x.scope === scope));
    } catch (e) {
      if (!alive.current || seq !== sequence.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        clearPrivate();
    }
  }
  useEffect(() => {
    alive.current = true;
    if (view.user.role === "admin") void load(true);
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (
      run?.id === ownRun.current &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run?.state,
      )
    ) {
      ownRun.current = undefined;
      const receipt = run.result?.receipts?.find(
        (r: any) => r.tool === "spending.manage",
      );
      if (
        run.state === "succeeded" &&
        receipt?.operation === "budget_configure"
      )
        setLimitRevision(receipt.revision);
      if (
        run.state === "succeeded" &&
        receipt?.operation === "budget_reconcile"
      )
        setChargeRevision(receipt.revision);
      if (run.state === "succeeded" && receipt?.operation === "budget_price") {
        setPriceKey(receipt.priceKey);
        setExactPrice({
          ...price,
          priceKey: receipt.priceKey,
          revision: receipt.revision,
        } as Price);
      }

      setNotice(
        run.state === "succeeded"
          ? "AI 企业费用操作已保存，请核对当前版本与实际回执。"
          : "企业费用操作未完成，请核对原任务后操作。",
      );
      void load();
    }
  }, [run?.id, run?.state]);
  const change = () => {
    setConfirmed(false);
    setNotice("");
  };
  async function lookupPrice() {
    const seq = sequence.current;
    setBusy(true);
    setError("");
    change();
    try {
      const result = await mutation<{ priceKey: string; price: Price | null }>(
        "/organization-budgets/price-lookup",
        {
          provider: price.provider,
          endpoint: price.endpoint,
          model: price.model,
          purpose: price.purpose,
        },
      );
      if (!alive.current || seq !== sequence.current) return;
      const current = result.price;
      setPriceKey(result.priceKey);
      setExactPrice(
        current ??
          ({ ...price, priceKey: result.priceKey, revision: 0 } as Price),
      );
      if (current)
        setPrice({
          provider: current.provider,
          endpoint: current.endpoint,
          model: current.model,
          purpose: current.purpose,
          currency: current.currency,
          inputPerMillion: current.inputPerMillion,
          outputPerMillion: current.outputPerMillion,
          cacheReadPerMillion: current.cacheReadPerMillion,
          cacheWritePerMillion: current.cacheWritePerMillion,
          source: current.source,
        });
      setNotice(
        current
          ? "已读取此模型当前企业计价，请核对后再确认修改。"
          : "此模型尚无企业计价依据，确认保存后建立版本 1。",
      );
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          clearPrivate();
          setStale(true);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function apply(plan: OrganizationBudgetPlan) {
    if (!confirmed || disabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    const hash = JSON.stringify({ plan, mode, engine, modelId });
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId: view.project.conversationId,
          engine,
          workflow: "manage_spending",
          instruction:
            "只执行我明确确认的企业计价、跨连接预算或管理员金额声明，不改变范围、价格、币种、金额，不宣称供应商账单已验证。",
          spendingPlan: plan,
          ...(engine !== "fixture" && modelId
            ? { modelProfileId: modelId }
            : {}),
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          ownRun.current = started.id;
          onRun({ ...started, engine, workflow: "manage_spending" });
          setNotice("已发起 AI 企业费用操作，实际保存以回执为准。");
        }
      } else {
        const receipt = await mutation("/model-spending", {
          plan,
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          setNotice("企业费用操作已保存，当前版本 " + receipt.revision + "。");
          if (plan.operation === "budget_configure")
            setLimitRevision(receipt.revision);
          if (plan.operation === "budget_reconcile")
            setChargeRevision(receipt.revision);
          if (plan.operation === "budget_price") {
            setPriceKey(receipt.priceKey);
            setExactPrice({
              ...price,
              priceKey: receipt.priceKey,
              revision: receipt.revision,
            } as Price);
          }
          await load(false, before);
        }
      }
      if (alive.current) setConfirmed(false);
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          clearPrivate();
          setStale(true);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function submit() {
    if (kind === "limits" && selected)
      void apply({
        operation: "budget_configure",
        scope: scope as "workspace" | "project",
        projectId: scope === "project" ? view.project.id : null,
        expectedRevision: limitRevision,
        currency,
        dailyLimit: limit || null,
        requestReservation: reservation,
        confirmed: true,
      });
    if (kind === "prices")
      void apply({
        operation: "budget_price",
        ...price,
        provider: price.provider as
          | "openai-compatible"
          | "deepseek"
          | "anthropic",
        purpose: price.purpose as "chat" | "embedding",
        currency: price.currency as "CNY" | "USD",
        expectedRevision: selectedPrice?.revision ?? 0,
        confirmed: true,
      });
    if (kind === "reconcile" && selectedCharge)
      void apply({
        operation: "budget_reconcile",
        requestId: selectedCharge.id,
        expectedRevision: chargeRevision,
        currency,
        amount,
        evidence,
        confirmed: true,
      });
  }
  if (view.user.role !== "admin")
    return (
      <section
        className="work-panel settings-panel organization-budget-panel"
        aria-label="企业预算"
      >
        <h3>企业预算</h3>
        <p>
          企业计价、跨连接金额预算与企业费用声明由当前管理员管理。个人连接的价格与预算仍在“价格与预算”中管理。
        </p>
      </section>
    );
  return (
    <section
      className="work-panel settings-panel organization-budget-panel"
      aria-label="企业预算"
    >
      <header className="panel-heading">
        <div>
          <h3>企业预算</h3>
          <p>跨个人和共享连接检查金额；企业账本与个人声明分别保存。</p>
        </div>
        <button disabled={busy || managing} onClick={() => void load()}>
          重新读取企业账本
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p className="muted">
        按 UTC
        请求发起日核对。不自动换汇，未知不是零；价格估算和管理员声明不等于已验证账单。全局查询及无项目的验证/资料请求计入工作区；项目任务和项目资料索引另受项目额度约束。
      </p>
      {data ? (
        <>
          <div className="policy-summary">
            <strong>今日企业金额（分币种）</strong>
            {data.costsByCurrency === undefined ? (
              <p>金额汇总待读取，不推断为零。</p>
            ) : data.costsByCurrency.length === 0 ? (
              <p>今日尚无企业请求记录。</p>
            ) : (
              data.costsByCurrency.map((c) => (
                <p key={c.currency ?? "unknown"}>
                  {c.currency === null
                    ? `币种未知 · ${c.requests} 条记录`
                    : `${c.currency} 已知估算/声明 ${c.known}`}{" "}
                  · 未知 {c.unknown} · 待核对 {c.review}
                </p>
              ))
            )}
          </div>
          <div className="policy-summary">
            {data.controls.map((c) => (
              <article key={c.scope}>
                <strong>
                  {c.scope === "workspace"
                    ? "工作区跨连接额度"
                    : "当前项目跨连接额度"}
                </strong>
                {c.revision === 0 ? (
                  <p>尚未配置此范围的预算；实际费用见分币种汇总。</p>
                ) : (
                  <>
                    <p>
                      版本 {c.revision} ·{" "}
                      {c.dailyLimit === null
                        ? "未启用金额限制"
                        : c.dailyLimit + " " + c.currency}
                    </p>
                    <p>
                      已知估算/声明 {c.balance.known} {c.currency} · 在途预留{" "}
                      {c.balance.held} {c.currency} · 未知 {c.balance.unknown} ·
                      待核对 {c.balance.review} · 其他币种记录{" "}
                      {c.balance.mismatched}
                    </p>
                    <p>
                      可用余额：
                      {c.balance.remaining === null
                        ? "尚不能确认"
                        : c.balance.remaining + " " + c.currency}
                    </p>
                  </>
                )}
              </article>
            ))}
          </div>
          <form
            className="settings-form organization-budget-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <fieldset className="policy-fields" disabled={disabled}>
              <label className="policy-confirm">
                <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={(e) => {
                    change();
                    void load(false, "", e.target.checked);
                  }}
                />
                只看未知或待核对企业费用
              </label>
              <label>
                企业费用操作
                <select
                  aria-label="企业费用操作"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    change();
                    setChargeId("");
                    setAmount("");
                    setEvidence("");
                  }}
                >
                  <option value="limits">跨连接额度</option>
                  <option value="prices">企业计价依据</option>
                  <option value="reconcile">企业费用核对声明</option>
                </select>
              </label>
              {kind === "limits" ? (
                <>
                  <label>
                    企业预算范围
                    <select
                      aria-label="企业预算范围"
                      value={scope}
                      onChange={(e) => {
                        setScope(e.target.value);
                        hydrate(
                          data.controls.find((x) => x.scope === e.target.value),
                        );
                        change();
                      }}
                    >
                      <option value="project">当前项目</option>
                      <option value="workspace">整个工作区</option>
                    </select>
                  </label>
                  <p>
                    当前企业预算版本：{selected?.revision ?? 0} · 表单依据版本：
                    {limitRevision}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      hydrate(selected);
                      change();
                    }}
                  >
                    将当前额度读入表单
                  </button>
                  <label>
                    企业预算币种
                    <select
                      aria-label="企业预算币种"
                      value={currency}
                      onChange={(e) => {
                        setCurrency(e.target.value as "CNY" | "USD");
                        change();
                      }}
                    >
                      <option>CNY</option>
                      <option>USD</option>
                    </select>
                  </label>
                  <label>
                    企业每日预算上限
                    <input
                      aria-label="企业每日预算上限"
                      inputMode="decimal"
                      value={limit}
                      onChange={(e) => {
                        setLimit(e.target.value);
                        change();
                      }}
                      placeholder="留空不启用；0 为零预算"
                    />
                  </label>
                  <label>
                    企业每请求预留金额
                    <input
                      aria-label="企业每请求预留金额"
                      required
                      inputMode="decimal"
                      value={reservation}
                      onChange={(e) => {
                        setReservation(e.target.value);
                        change();
                      }}
                    />
                  </label>
                </>
              ) : kind === "prices" ? (
                <>
                  <label>
                    企业计价条目
                    <select
                      aria-label="企业计价条目"
                      value={priceKey}
                      onChange={(e) => {
                        setPriceKey(e.target.value);
                        const x = data.prices.find(
                          (p) => p.priceKey === e.target.value,
                        );
                        setExactPrice(x);
                        setPrice(
                          x
                            ? {
                                provider: x.provider,
                                endpoint: x.endpoint,
                                model: x.model,
                                purpose: x.purpose,
                                currency: x.currency,
                                inputPerMillion: x.inputPerMillion,
                                outputPerMillion: x.outputPerMillion,
                                cacheReadPerMillion: x.cacheReadPerMillion,
                                cacheWritePerMillion: x.cacheWritePerMillion,
                                source: x.source,
                              }
                            : { ...emptyPrice },
                        );
                        change();
                      }}
                    >
                      <option value="">新增计价依据</option>
                      {exactPrice &&
                      !data.prices.some(
                        (p) => p.priceKey === exactPrice.priceKey,
                      ) ? (
                        <option value={exactPrice.priceKey}>
                          {exactPrice.model} · 读取版本 {exactPrice.revision}
                        </option>
                      ) : null}
                      {data.prices.map((p) => (
                        <option key={p.priceKey} value={p.priceKey}>
                          {p.model} · {p.purpose} · v{p.revision} · {p.endpoint}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    表单计价依据版本：{selectedPrice?.revision ?? 0}。最多显示
                    100 个当前计价条目。
                  </p>
                  <label>
                    企业计价协议
                    <select
                      aria-label="企业计价协议"
                      value={price.provider}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, provider: e.target.value }));
                        setPriceKey("");
                        change();
                      }}
                    >
                      <option value="openai-compatible">
                        OpenAI-compatible
                      </option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>
                  <label>
                    企业模型地址
                    <input
                      aria-label="企业模型地址"
                      required
                      type="url"
                      value={price.endpoint}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, endpoint: e.target.value }));
                        setPriceKey("");
                        change();
                      }}
                      placeholder="不含 Key、查询或凭据的地址"
                    />
                  </label>
                  <label>
                    企业模型名称
                    <input
                      aria-label="企业模型名称"
                      required
                      value={price.model}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, model: e.target.value }));
                        setPriceKey("");
                        change();
                      }}
                    />
                  </label>
                  <label>
                    企业模型用途
                    <select
                      aria-label="企业模型用途"
                      value={price.purpose}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, purpose: e.target.value }));
                        setPriceKey("");
                        change();
                      }}
                    >
                      <option value="chat">对话</option>
                      <option value="embedding">向量</option>
                    </select>
                  </label>
                  <button type="button" onClick={() => void lookupPrice()}>
                    读取确切模型当前计价（覆盖表单）
                  </button>
                  <label>
                    企业计价币种
                    <select
                      aria-label="企业计价币种"
                      value={price.currency}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, currency: e.target.value }));
                        change();
                      }}
                    >
                      <option>CNY</option>
                      <option>USD</option>
                    </select>
                  </label>
                  {(Object.keys(rateLabels) as (keyof typeof rateLabels)[]).map(
                    (key) => (
                      <label key={key}>
                        {rateLabels[key]}
                        <input
                          required
                          inputMode="decimal"
                          value={price[key]}
                          onChange={(e) => {
                            setPrice((p) => ({ ...p, [key]: e.target.value }));
                            change();
                          }}
                        />
                      </label>
                    ),
                  )}
                  <label>
                    企业计价依据
                    <textarea
                      aria-label="企业计价依据"
                      required
                      maxLength={1000}
                      value={price.source}
                      onChange={(e) => {
                        setPrice((p) => ({ ...p, source: e.target.value }));
                        change();
                      }}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    企业请求记录
                    <select
                      aria-label="企业请求记录"
                      required
                      value={chargeId}
                      onChange={(e) => {
                        setChargeId(e.target.value);
                        setChargeRevision(
                          data.charges.find((x) => x.id === e.target.value)
                            ?.revision ?? 0,
                        );
                        setCurrency(
                          data.charges.find((x) => x.id === e.target.value)
                            ?.currency ?? "CNY",
                        );
                        setAmount("");
                        setEvidence("");
                        change();
                      }}
                    >
                      <option value="">请选择确切请求</option>
                      {data.charges.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id} · {chargeLabels[c.status]} ·{" "}
                          {c.scope === "project"
                            ? "当前项目"
                            : c.scope === "other-project"
                              ? "其他项目企业金额"
                              : "工作区请求"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    当前请求版本：{selectedCharge?.revision ?? 0} ·
                    表单依据版本：{chargeRevision}
                  </p>
                  <button
                    type="button"
                    disabled={!selectedCharge}
                    onClick={() => {
                      setChargeRevision(selectedCharge?.revision ?? 0);
                      setCurrency(selectedCharge?.currency ?? "CNY");
                      setAmount("");
                      setEvidence("");
                      change();
                    }}
                  >
                    将当前请求读入核对表单
                  </button>
                  <label>
                    企业声明币种
                    <select
                      aria-label="企业声明币种"
                      value={currency}
                      onChange={(e) => {
                        setCurrency(e.target.value as "CNY" | "USD");
                        change();
                      }}
                    >
                      <option>CNY</option>
                      <option>USD</option>
                    </select>
                  </label>
                  <label>
                    企业声明金额
                    <input
                      aria-label="企业声明金额"
                      required
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        change();
                      }}
                    />
                  </label>
                  <label>
                    企业核对依据
                    <textarea
                      aria-label="企业核对依据"
                      required
                      maxLength={2000}
                      value={evidence}
                      onChange={(e) => {
                        setEvidence(e.target.value);
                        change();
                      }}
                    />
                  </label>
                </>
              )}
              <label>
                企业费用保存方式
                <select
                  aria-label="企业费用保存方式"
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value);
                    change();
                  }}
                >
                  <option value="direct">直接保存</option>
                  <option value="ai">AI 执行已确认方案</option>
                </select>
              </label>
              {mode === "ai" ? (
                <>
                  <label>
                    企业费用执行服务
                    <select
                      aria-label="企业费用执行服务"
                      value={engine}
                      onChange={(e) => {
                        setEngine(e.target.value);
                        change();
                      }}
                    >
                      <option value="dsh">DSH</option>
                      <option value="hermes">Hermes</option>
                      {view.user.demo ? (
                        <option value="fixture">演示流程（无真实模型）</option>
                      ) : null}
                    </select>
                  </label>
                  {engine !== "fixture" ? (
                    <label>
                      企业费用执行连接
                      <select
                        aria-label="企业费用执行连接"
                        value={modelId}
                        onChange={(e) => {
                          setModelId(e.target.value);
                          change();
                        }}
                      >
                        <option value="">按已有规则选择</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} · {m.model}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <p>
                    AI
                    操作本身可能计费，也受保存前的有效预算限制。被拒绝时可直接管理预算，系统不会自动换
                    Key。
                  </p>
                </>
              ) : null}
              <label className="policy-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对企业范围、币种、金额与计价依据，确认本次操作。
              </label>
              <button
                className="primary"
                disabled={
                  !confirmed ||
                  disabled ||
                  (kind === "reconcile" && !selectedCharge)
                }
                type="submit"
              >
                {mode === "ai" ? "发起 AI 企业费用操作" : "保存企业费用操作"}
              </button>
            </fieldset>
          </form>
          <div className="toolbar">
            <button
              type="button"
              disabled={disabled || !before}
              onClick={() => {
                change();
                void load(false, "");
              }}
            >
              从最新企业记录读取
            </button>
            <button
              type="button"
              disabled={disabled || !data.nextBefore}
              onClick={() => {
                change();
                void load(false, data.nextBefore ?? "");
              }}
            >
              读取更早企业记录
            </button>
          </div>
          <details>
            <summary>企业请求记录与操作回执</summary>
            <p>
              最多显示近 30 天 100
              条工作区未归属项目请求及当前获准项目的记录，不显示其他员工个人连接或私人发票。工作区汇总仍包含所有连接。
            </p>
            {data.charges.map((c) => (
              <article className="usage-row" key={c.id}>
                <strong>
                  {chargeLabels[c.status]}
                  {c.reviewRequired ? " · 待核对" : ""}
                </strong>
                <small>
                  {c.id} · {new Date(c.startedAt).toLocaleString()}
                </small>
                <p>
                  估算：{c.estimate ?? "未知"} · 管理员声明：
                  {c.declared ?? "未声明"} · {c.currency ?? "币种未知"}
                </p>
              </article>
            ))}
            {data.history.map((h, i) => (
              <article className="usage-row" key={i}>
                <strong>
                  {(
                    {
                      budget_configure: "企业额度配置",
                      budget_price: "企业计价依据",
                      budget_reconcile: "企业金额声明",
                    } as Record<string, string>
                  )[h.receipt.operation] ?? "企业费用操作"}{" "}
                  · 版本 {h.receipt.revision}
                </strong>
                <pre>{JSON.stringify(h.receipt, null, 2)}</pre>
              </article>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
