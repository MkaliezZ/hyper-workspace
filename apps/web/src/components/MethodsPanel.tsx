import { useEffect, useRef, useState } from "react";
import type {
  MethodAsset,
  MethodDraft,
  MethodPlan,
  WorkspaceView,
} from "@hyper/contracts";
import { api, ApiError, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
type Detail = {
  current: MethodAsset;
  versions: any[];
  actions: any[];
  uses: any[];
};
const empty: MethodDraft = { title: "", kind: "sop", content: "" };
const fields = (m: MethodAsset): MethodDraft => ({
  title: m.title,
  kind: m.kind,
  content: m.content,
});
const stateName = (s: string) =>
  ({ candidate: "候选", published: "已发布", withdrawn: "已撤回" })[s] ?? s;
const kindName = (s: string) =>
  ({
    sop: "SOP",
    template: "模板",
    case: "案例",
    rubric: "质量量规",
    glossary: "术语",
  })[s] ?? s;
export function MethodsPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
}) {
  const [rows, setRows] = useState<MethodAsset[]>([]),
    [detail, setDetail] = useState<Detail>(),
    [base, setBase] = useState<MethodAsset>();
  const [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<MethodDraft>(empty),
    [source, setSource] = useState<{
      id: string;
      title: string;
      version: number;
    }>();
  const [mode, setMode] = useState("human"),
    [operation, setOperation] = useState<"verify" | "publish" | "withdraw">(
      "verify",
    ),
    [evidence, setEvidence] = useState(""),
    [scope, setScope] = useState<"project" | "workspace">("project"),
    [confirmed, setConfirmed] = useState(false);
  const [instruction, setInstruction] = useState(""),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [models, setModels] = useState<ModelSummary[]>([]);
  const [reuseWorkflow, setReuseWorkflow] = useState("project_report"),
    [reuseArtifact, setReuseArtifact] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    query = useRef(0),
    saving = useRef(false),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const ownRun =
    run &&
    (run.workflow === "manage_method"
      ? selected
        ? run.methodPlan?.methodId === selected
        : run.methodPlan?.sourceArtifactId === source?.id
      : run.methodRefs?.some((r: any) => r.id === selected));
  const pending =
    ownRun &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const stale =
    !!base &&
    !!detail &&
    (base.version !== detail.current.version ||
      base.revision !== detail.current.revision);
  const dirty =
    !!base && JSON.stringify(draft) !== JSON.stringify(fields(base));
  const manages =
    !!detail?.current.canManage && detail.current.projectId === view.project.id;
  const model = models.find((x) => x.id === modelId);
  const incompatible =
    engine !== "fixture" &&
    !!model &&
    !view.engines[engine]?.modelProviders?.includes(model.provider);
  async function list() {
    try {
      const values = await api<MethodAsset[]>(
        "/projects/" + view.project.id + "/methods",
      );
      if (alive.current) setRows(values);
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setRows([]);
          setDetail(undefined);
          setBase(undefined);
          setDraft(empty);
          setSource(undefined);
          setEvidence("");
          setInstruction("");
          setConfirmed(false);
          attempt.current = undefined;
          generation.current++;
        }
      }
    }
  }
  async function load(id: string, reset = false, token = generation.current) {
    const sequence = ++query.current;
    try {
      const value = await api<Detail>("/methods/" + id);
      if (
        !alive.current ||
        token !== generation.current ||
        sequence !== query.current
      )
        return;
      setDetail(value);
      if (reset) {
        setBase(value.current);
        setDraft(fields(value.current));
        setConfirmed(false);
      }
      return value;
    } catch (e) {
      if (
        alive.current &&
        token === generation.current &&
        sequence === query.current
      ) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setDetail(undefined);
          setBase(undefined);
          setDraft(empty);
          setEvidence("");
          setInstruction("");
          setConfirmed(false);
        }
      }
    }
  }
  function choose(id: string) {
    const token = ++generation.current;
    setSelected(id);
    setDetail(undefined);
    setBase(undefined);
    setDraft(empty);
    setError("");
    setNotice("");
    setConfirmed(false);
    setEvidence("");
    attempt.current = undefined;
    if (id) void load(id, true, token);
  }
  useEffect(() => {
    alive.current = true;
    void list();
    let active = false;
    const timer = setInterval(() => {
      if (active || saving.current || document.visibilityState !== "visible")
        return;
      active = true;
      void list().finally(() => {
        active = false;
      });
    }, 8000);
    return () => {
      alive.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [view.project.id]);
  useEffect(() => {
    if (!selected) return;
    let active = false;
    const timer = setInterval(() => {
      if (active || saving.current || document.visibilityState !== "visible")
        return;
      active = true;
      void load(selected).finally(() => {
        active = false;
      });
    }, 8000);
    return () => clearInterval(timer);
  }, [selected]);
  useEffect(() => {
    let current = true;
    void api<ModelSummary[]>("/models")
      .then((values) => {
        if (current) setModels(values.filter((x) => x.purpose === "chat"));
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !ownRun ||
      !["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      return;
    setNotice(
      run.state === "succeeded"
        ? "操作已结束，请核对实际回执。编辑草稿已保留；新方法请从列表打开。"
        : "",
    );
    if (run.error) setError(run.error);
    void list();
    if (selected && !saving.current) void load(selected);
  }, [run?.id, run?.state]);
  useEffect(() => setConfirmed(false), [detail?.current.revision]);
  function draftPlan(): MethodPlan | undefined {
    if (selected && base)
      return {
        operation: "revise",
        methodId: base.id,
        expectedVersion: base.version,
        expectedRevision: base.revision,
      };
    if (source)
      return {
        operation: "create",
        sourceArtifactId: source.id,
        expectedSourceVersion: source.version,
      };
  }
  function managementPlan(): MethodPlan | undefined {
    if (!base || !confirmed) return;
    const target = {
      methodId: base.id,
      expectedVersion: base.version,
      expectedRevision: base.revision,
      confirmed: true as const,
    };
    if (operation === "verify")
      return { operation, ...target, evidence: evidence.trim() };
    if (operation === "publish") return { operation, ...target, scope };
    return { operation, ...target, reason: evidence.trim() };
  }
  async function submit(plan: MethodPlan, writing: boolean, ai: boolean) {
    if (
      busy ||
      (selected && (stale || (ai && writing && dirty))) ||
      (ai && (pending || incompatible))
    )
      return;
    const token = generation.current;
    const body = ai
      ? {
          conversationId: view.project.conversationId,
          workflow: "manage_method",
          methodPlan: plan,
          engine,
          instruction:
            instruction.trim() ||
            "仅代执行我确认的方法管理操作，不改变决定或范围。",
          ...(engine !== "fixture" && modelId
            ? { modelProfileId: modelId }
            : {}),
        }
      : { plan, ...(writing ? { draft } : {}) };
    const hash = JSON.stringify({ ai, body });
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    setBusy(true);
    saving.current = true;
    setError("");
    setNotice("");
    try {
      const value = await mutation(
        ai ? "/runs" : "/projects/" + view.project.id + "/methods/actions",
        { ...body, idempotencyKey: attempt.current!.key },
      );
      if (!alive.current || token !== generation.current) return;
      attempt.current = undefined;
      if (ai) {
        onRun({
          ...value,
          workflow: "manage_method",
          methodPlan: plan,
          engine,
        });
        setNotice("已发起方法操作。AI 生成内容只保存为候选，不能自行发布。");
      } else {
        await list();
        if (token !== generation.current || !alive.current) return;
        if (!selected) {
          choose(value.id);
        } else {
          await load(selected, true, token);
        }
        if (alive.current && (token === generation.current || !selected))
          setNotice("已保存，请核对当前版本与操作记录。");
      }
    } catch (e) {
      if (alive.current && token === generation.current) {
        setError((e as Error).message);
        if (selected) await load(selected);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        saving.current = false;
      }
    }
  }
  async function reuse() {
    if (
      !detail ||
      detail.current.state !== "published" ||
      busy ||
      pending ||
      incompatible ||
      !instruction.trim()
    )
      return;
    const current = detail.current,
      token = generation.current;
    const body = {
      conversationId: view.project.conversationId,
      workflow: reuseWorkflow,
      engine,
      instruction: instruction.trim(),
      methodRefs: [
        {
          id: current.id,
          version: current.version,
          revision: current.revision,
        },
      ],
      ...(reuseWorkflow === "revise_artifact"
        ? { artifactId: reuseArtifact }
        : {}),
      ...(engine !== "fixture" && modelId ? { modelProfileId: modelId } : {}),
    };
    const hash = JSON.stringify(body);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    setBusy(true);
    saving.current = true;
    setError("");
    try {
      const value = await mutation("/runs", {
        ...body,
        idempotencyKey: attempt.current!.key,
      });
      if (!alive.current || token !== generation.current) return;
      attempt.current = undefined;
      onRun({
        ...value,
        workflow: reuseWorkflow,
        methodRefs: body.methodRefs,
        engine,
      });
      setNotice("已发起复用；成果仍是待核对草稿，方法不能替代当前事实或规则。");
    } catch (e) {
      if (alive.current && token === generation.current) {
        setError((e as Error).message);
        await load(selected);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        saving.current = false;
      }
    }
  }
  const controls = (
    <div className="method-pair">
      <label>
        方法执行器
        <select
          aria-label="方法执行器"
          value={engine}
          disabled={busy}
          onChange={(e) => setEngine(e.target.value)}
        >
          <option value="dsh">DSH</option>
          <option value="hermes">Hermes</option>
          {view.user.demo ? (
            <option value="fixture">演示执行 · 不调用模型</option>
          ) : null}
        </select>
      </label>
      {engine !== "fixture" ? (
        <label>
          方法模型连接
          <select
            aria-label="方法模型连接"
            value={modelId}
            disabled={busy}
            onChange={(e) => setModelId(e.target.value)}
          >
            <option value="">当前默认连接</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
  return (
    <section className="methods-panel" aria-label="方法与模板">
      <div className="method-heading">
        <div>
          <h3>方法与模板</h3>
          <p className="muted">
            候选经验经员工验证后发布；保留来源、版本和维护人。方法提供工作指导，不改变公司规则。
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            choose("");
            setSource(undefined);
          }}
        >
          新建方法
        </button>
      </div>
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="methods-layout">
        <div className="method-list" aria-label="可见方法">
          {rows.length ? (
            rows.map((m) => (
              <button
                key={m.id}
                className={selected === m.id ? "active" : ""}
                disabled={busy}
                onClick={() => choose(m.id)}
                aria-label={"打开方法：" + m.title}
              >
                <strong>{m.title}</strong>
                <span>
                  {kindName(m.kind)} · {stateName(m.state)} · v{m.version}
                </span>
                <small>
                  {m.maintainerName} · {m.projectName}
                </small>
              </button>
            ))
          ) : (
            <p className="muted">
              当前没有可见方法。可从项目成果整理候选经验。
            </p>
          )}
        </div>
        <div className="method-editor">
          {!selected ? (
            <>
              <h4>从当前项目成果整理候选</h4>
              <label>
                方法来源成果
                <select
                  aria-label="方法来源成果"
                  value={source?.id ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const a = view.artifacts.find(
                      (x) => x.id === e.target.value,
                    );
                    setSource(
                      a
                        ? { id: a.id, title: a.title, version: a.version }
                        : undefined,
                    );
                  }}
                >
                  <option value="">选择一个已保存成果</option>
                  {view.artifacts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} · v{a.version}
                    </option>
                  ))}
                </select>
              </label>
              {source ? (
                <p className="muted small">
                  绑定《{source.title}》v{source.version}
                  。来源变化会拒绝旧操作。
                </p>
              ) : null}
            </>
          ) : null}
          {selected && !detail ? (
            <p className="muted">
              方法尚未加载，或已无法访问。
              <button disabled={busy} onClick={() => void load(selected, true)}>
                重新读取方法
              </button>
            </p>
          ) : null}
          {detail ? (
            <>
              <h4>{detail.current.title}</h4>
              <p className="muted small">
                {stateName(detail.current.state)} · 内容 v
                {detail.current.version} · 状态修订 {detail.current.revision} ·
                维护人 {detail.current.maintainerName}
              </p>
              <p className="muted small">
                来源：《{detail.current.sourceTitle}》v
                {detail.current.sourceVersion} · {detail.current.projectName}
                。来源版本是依据，不代表当前事实。
              </p>
              <p className="muted small">
                验证：
                {detail.current.verification === "employee_verified"
                  ? "员工已声明验证"
                  : "候选，尚未验证"}
                {detail.current.evidence ? "；" + detail.current.evidence : ""}
              </p>
              {detail.current.projectId !== view.project.id ? (
                <p className="muted">
                  跨项目发布的方法可在这里复用；管理操作请回到来源项目。
                </p>
              ) : null}
            </>
          ) : null}
          {!selected || (manages && base) ? (
            <>
              {stale ? (
                <p role="status">
                  已有新的内容或状态，人工草稿已保留。请读取当前版本后再操作。
                </p>
              ) : null}
              {selected ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    void load(selected, true);
                  }}
                >
                  读取当前方法版本{dirty ? "（将替换编辑内容）" : ""}
                </button>
              ) : null}
              <label>
                方法操作方式
                <select
                  aria-label="方法操作方式"
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="human">直接操作</option>
                  <option value="ai">AI 操作</option>
                </select>
              </label>
              <form
                className="dialog-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const p = draftPlan();
                  if (p) void submit(p, true, false);
                }}
              >
                <label>
                  方法标题
                  <input
                    aria-label="方法标题"
                    required
                    maxLength={200}
                    disabled={busy}
                    value={draft.title}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  方法类型
                  <select
                    aria-label="方法类型"
                    value={draft.kind}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        kind: e.target.value as MethodDraft["kind"],
                      })
                    }
                  >
                    {["sop", "template", "case", "rubric", "glossary"].map(
                      (k) => (
                        <option key={k} value={k}>
                          {kindName(k)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  方法内容
                  <textarea
                    aria-label="方法内容"
                    required
                    maxLength={12000}
                    rows={8}
                    disabled={busy}
                    value={draft.content}
                    onChange={(e) =>
                      setDraft({ ...draft, content: e.target.value })
                    }
                  />
                </label>
                <p className="muted small">
                  修改后形成新的候选版本，原验证和发布状态重置；需重新验证、发布。
                </p>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    stale ||
                    (!selected && !source) ||
                    (!!selected && !dirty)
                  }
                >
                  保存候选方法
                </button>
              </form>
              {mode === "ai" ? (
                <>
                  <p className="muted small">
                    AI
                    仅使用已选成果或已保存方法与下方要求，不读取群消息；不会覆盖输入框中的人工草稿。调用模型可能产生费用。
                  </p>
                  {controls}
                  <label>
                    方法 AI 要求
                    <textarea
                      aria-label="方法 AI 要求"
                      value={instruction}
                      maxLength={20000}
                      disabled={busy}
                      onChange={(e) => setInstruction(e.target.value)}
                    />
                  </label>
                  {incompatible ? (
                    <p role="status">模型连接与执行器不兼容，请更换连接。</p>
                  ) : null}
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      pending ||
                      stale ||
                      incompatible ||
                      !instruction.trim() ||
                      (!selected && !source) ||
                      (!!selected && dirty)
                    }
                    onClick={() => {
                      const p = draftPlan();
                      if (p) void submit(p, true, true);
                    }}
                  >
                    让 AI 保存候选方法
                  </button>
                </>
              ) : null}
              {selected ? (
                <div className="method-management">
                  <h4>验证、发布与撤回</h4>
                  <p className="muted small">
                    验证是员工基于实际依据的声明，不是模型独立验证。未保存内容或版本冲突时先保存或重新读取。
                  </p>
                  <label>
                    方法管理操作
                    <select
                      aria-label="方法管理操作"
                      value={operation}
                      disabled={busy}
                      onChange={(e) => {
                        setOperation(e.target.value as typeof operation);
                        setConfirmed(false);
                      }}
                    >
                      <option value="verify">记录员工验证依据</option>
                      <option value="publish">发布当前方法版本</option>
                      <option value="withdraw">撤回当前方法</option>
                    </select>
                  </label>
                  {operation === "publish" ? (
                    <label>
                      方法发布范围
                      <select
                        aria-label="方法发布范围"
                        value={scope}
                        disabled={busy}
                        onChange={(e) => {
                          setScope(e.target.value as typeof scope);
                          setConfirmed(false);
                        }}
                      >
                        <option value="project">来源项目</option>
                        {detail?.current.canPublishWorkspace &&
                        !view.project.source ? (
                          <option value="workspace">工作区</option>
                        ) : null}
                      </select>
                    </label>
                  ) : (
                    <label>
                      {operation === "verify" ? "方法验证依据" : "方法撤回原因"}
                      <textarea
                        aria-label={
                          operation === "verify"
                            ? "方法验证依据"
                            : "方法撤回原因"
                        }
                        required
                        maxLength={4000}
                        disabled={busy}
                        value={evidence}
                        onChange={(e) => {
                          setEvidence(e.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </label>
                  )}
                  <label className="method-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已核对当前方法版本、依据和范围，确认上述管理操作
                  </label>
                  <button
                    disabled={
                      busy ||
                      stale ||
                      dirty ||
                      !confirmed ||
                      (operation !== "publish" && !evidence.trim()) ||
                      (mode === "ai" && (pending || incompatible))
                    }
                    onClick={() => {
                      const p = managementPlan();
                      if (p) void submit(p, false, mode === "ai");
                    }}
                  >
                    {mode === "ai"
                      ? "让 AI 代执行已确认操作"
                      : "执行已确认操作"}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          {detail?.current.state === "published" ? (
            <div className="method-reuse">
              <h4>使用此版本生成成果</h4>
              <p className="muted small">
                只使用当前已发布的保存内容，未保存草稿不发送给模型。记录确切版本和上下文准备时间；撤回后拒绝新复用及尚未提交的旧修改，已有成果保留历史。模型可能产生费用。
              </p>
              {mode !== "ai" || !manages ? controls : null}
              <label>
                方法复用场景
                <select
                  aria-label="方法复用场景"
                  value={reuseWorkflow}
                  disabled={busy}
                  onChange={(e) => setReuseWorkflow(e.target.value)}
                >
                  <option value="project_report">项目周报</option>
                  <option value="discussion_to_minutes">
                    讨论转纪要与待办
                  </option>
                  <option value="revise_artifact">修改已有成果</option>
                </select>
              </label>
              {reuseWorkflow === "revise_artifact" ? (
                <label>
                  待修改成果
                  <select
                    aria-label="方法复用待修改成果"
                    value={reuseArtifact}
                    disabled={busy}
                    onChange={(e) => setReuseArtifact(e.target.value)}
                  >
                    <option value="">选择当前项目成果</option>
                    {view.artifacts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title} · v{a.version}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                方法复用要求
                <textarea
                  aria-label="方法复用要求"
                  value={instruction}
                  maxLength={20000}
                  disabled={busy}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  pending ||
                  incompatible ||
                  !instruction.trim() ||
                  (reuseWorkflow === "revise_artifact" && !reuseArtifact)
                }
                onClick={() => void reuse()}
              >
                使用当前已发布版本
              </button>
            </div>
          ) : null}
          {detail ? (
            <details className="method-history">
              <summary>版本、操作与本人复用记录</summary>
              <h4>内容版本</h4>
              <ol>
                {detail.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} · {v.title} · {v.actorName}
                    <pre>{v.content}</pre>
                  </li>
                ))}
              </ol>
              <h4>最近操作</h4>
              <ol>
                {detail.actions.map((a) => (
                  <li key={a.revision}>
                    {
                      (
                        {
                          create: "创建候选",
                          revise: "修订候选",
                          verify: "员工验证",
                          publish: "发布",
                          withdraw: "撤回",
                        } as Record<string, string>
                      )[a.operation]
                    }{" "}
                    · v{a.version} · 状态修订 {a.revision}
                    {a.receipt.reason ? " · " + a.receipt.reason : ""}
                  </li>
                ))}
              </ol>
              <h4>本人复用记录</h4>
              <p className="muted small">
                记录上下文已准备，不代表模型已成功调用或成果已验收；需结合实际执行状态。
              </p>
              <ol>
                {detail.uses.map((u) => (
                  <li key={u.runId}>
                    v{u.version} · 状态修订 {u.revision} · {u.state} ·{" "}
                    {new Date(u.contextPreparedAt).toLocaleString()}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
