import { useEffect, useRef, useState } from "react";
import type {
  DecisionDraft,
  DecisionPlan,
  WorkspaceView,
} from "@hyper/contracts";
import { api, ApiError, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
const labels: Record<string, string> = {
  proposed: "待确认提议",
  confirmed: "已确认决定",
  withdrawn: "已撤回",
  superseded: "已被替代",
};
type Summary = {
  id: string;
  title: string;
  version: number;
  state: string;
  canManage: boolean;
  createdBy: string;
};
type Detail = {
  id: string;
  projectId: string;
  createdBy: string;
  canManage: boolean;
  current: any;
  history: any[];
  beforeVersion: number | null;
};
const empty: DecisionDraft = {
  title: "",
  content: "",
  rationale: "",
  links: [],
};
export function DecisionPanel({
  view,
  run,
  onRun,
  onChanged,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<Summary[]>([]),
    [sources, setSources] = useState<any[]>([]),
    [data, setData] = useState<Detail>(),
    [fields, setFields] = useState<DecisionDraft>(empty),
    [selectedRefs, setSelectedRefs] = useState<string[]>([]),
    [models, setModels] = useState<ModelSummary[]>([]),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [instruction, setInstruction] = useState(""),
    [supersedes, setSupersedes] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [dirty, setDirty] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [ownRun, setOwnRun] = useState(""),
    [resultId, setResultId] = useState("");
  const alive = useRef(true),
    generation = useRef(0),
    listGeneration = useRef(0),
    pending = useRef<{ path: string; body: any; ai: boolean } | undefined>(
      undefined,
    );
  const base = "/projects/" + view.project.id + "/decisions",
    active = run?.id === ownRun && ["queued", "running"].includes(run.state),
    locked = busy || uncertain || !ready;
  const canWrite =
      !data || (data.canManage && data.current.state === "proposed"),
    canManage =
      !!data?.canManage &&
      ["proposed", "confirmed"].includes(data.current.state);
  function clearPrivate() {
    setBusy(false);
    generation.current++;
    setData(undefined);
    setFields(empty);
    setSelectedRefs([]);
    setConfirmed(false);
    setDirty(false);
    setSupersedes("");
    setResultId("");
    pending.current = undefined;
    setUncertain(false);
  }
  function failed(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      clearPrivate();
      setList([]);
      setSources([]);
      setModels([]);
      setReady(false);
    }
  }
  async function load() {
    const g = ++listGeneration.current;
    try {
      const [rows, refs] = await Promise.all([
        api<Summary[]>(base),
        api<any[]>("/projects/" + view.project.id + "/decision-sources"),
      ]);
      if (alive.current && g === listGeneration.current) {
        setList(rows);
        setConfirmed(false);
        setSources(refs);
        setReady(true);
      }
    } catch (e) {
      if (alive.current && g === listGeneration.current) failed(e);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    void api<ModelSummary[]>("/models")
      .then((rows) => {
        if (alive.current)
          setModels(rows.filter((row) => row.purpose === "chat"));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
      listGeneration.current++;
    };
  }, [view.project.id, view.user.id]);
  useEffect(() => {
    if (
      ownRun &&
      run?.id === ownRun &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      void load();
      setNotice(
        run.state === "succeeded"
          ? "实际决定操作已保存；你的编辑草稿保持原样，可读取结果核对。"
          : (run.error ?? "执行已停止，请查看实际对象和回执。"),
      );
      setResultId(run.result?.receipts?.[0]?.id ?? "");
      onChanged();
    }
  }, [run?.id, run?.state, ownRun]);
  async function read(id: string, append = false) {
    const g = ++generation.current;
    if (!append) {
      setData(undefined);
      setFields(empty);
      setSelectedRefs([]);
      setConfirmed(false);
      setDirty(false);
      setSupersedes("");
      setError("");
      setNotice("");
      setResultId("");
    }
    setBusy(true);
    try {
      const result = await api<Detail>(
        "/decisions/" +
          id +
          (append && data?.beforeVersion
            ? "?beforeVersion=" + data.beforeVersion
            : ""),
      );
      if (alive.current && g === generation.current) {
        setData(
          append && data
            ? { ...result, history: [...data.history, ...result.history] }
            : result,
        );
        if (!append) {
          setFields({
            title: result.current.title,
            content: result.current.content ?? "",
            rationale: result.current.rationale ?? "",
            links: result.current.links ?? [],
          });
          setSelectedRefs(result.current.sourceRefs ?? []);
        }
      }
    } catch (e) {
      if (alive.current && g === generation.current) failed(e);
    } finally {
      if (alive.current && g === generation.current) setBusy(false);
    }
  }
  function edit<K extends keyof DecisionDraft>(
    key: K,
    value: DecisionDraft[K],
  ) {
    setFields((old) => ({ ...old, [key]: value }));
    setDirty(true);
    setConfirmed(false);
  }
  async function request(value: { path: string; body: any; ai: boolean }) {
    const g = generation.current;
    pending.current = value;
    setBusy(true);
    setUncertain(false);
    setError("");
    setNotice("");
    try {
      const result = await mutation<any>(value.path, value.body);
      if (!alive.current || g !== generation.current) return;
      pending.current = undefined;
      setConfirmed(false);
      if (value.ai) {
        setOwnRun(result.id);
        onRun(result);
        setNotice("决定执行已排队；提议不表示团队已采纳。");
      } else {
        setNotice("实际决定对象已保存。");
        setResultId(result.id);
        await load();
        onChanged();
        if (!dirty || value.body.draft) await read(result.id);
      }
    } catch (e) {
      if (alive.current && g === generation.current) {
        failed(e);
        if (!(e instanceof ApiError) || e.status >= 500) setUncertain(true);
      }
    } finally {
      if (alive.current && g === generation.current) setBusy(false);
    }
  }
  async function perform(plan: DecisionPlan) {
    if (locked || active) return;
    const drafting = ["create", "revise"].includes(plan.operation);
    if (!drafting && (!confirmed || dirty)) return;
    if (mode === "ai") {
      if (
        !view.engines[engine]?.configured ||
        !view.engines[engine]!.operations.includes("manage_decision")
      ) {
        setError("请配置支持决定操作的执行器和对话连接。");
        return;
      }
      await request({
        path: "/runs",
        ai: true,
        body: {
          conversationId: view.project.conversationId,
          workflow: "manage_decision",
          decisionPlan: plan,
          engine,
          modelProfileId: model || undefined,
          instruction: drafting
            ? "根据获准讨论和员工要求整理待确认提议。未知信息明确保留，不能代替员工确认。\n" +
              instruction +
              "\n员工编辑草稿（待整理，不是已确认事实）：" +
              JSON.stringify(fields)
            : "仅代执行员工确认的此决定操作和确切版本，不改变方向、目标、关系或权限。",
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } else
      await request({
        path: base,
        ai: false,
        body: {
          plan,
          ...(drafting ? { draft: fields } : {}),
          sourceRefs: drafting ? selectedRefs : [],
          idempotencyKey: crypto.randomUUID(),
        },
      });
  }
  const target = data
    ? { decisionId: data.id, expectedVersion: data.current.version }
    : null;
  return (
    <section className="work-panel decision-panel" aria-label="项目决定">
      <div className="work-panel-heading">
        <h2>项目决定</h2>
        <button
          className="secondary"
          disabled={busy || uncertain || active}
          onClick={() => {
            clearPrivate();
            setNotice("");
            setError("");
          }}
        >
          新建提议
        </button>
      </div>
      <p className="muted">
        AI
        先整理待确认提议；员工确认后才进入当前决定。已确认内容通过新提议替代，历史保留。
      </p>
      <div className="attachment-toolbar">
        <button disabled={busy || uncertain} onClick={() => void load()}>
          刷新决定列表
        </button>
        {resultId ? (
          <button
            disabled={busy || uncertain}
            onClick={() => void read(resultId)}
          >
            读取实际决定结果
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {uncertain ? (
        <div className="enterprise-recovery">
          <p>请求结果未确认。将使用原参数和同一幂等键核对，不新建重复操作。</p>
          <button
            disabled={busy}
            onClick={() => {
              if (pending.current) void request(pending.current);
            }}
          >
            核对原保存请求
          </button>
        </div>
      ) : null}
      <div className="decision-layout">
        <nav className="method-list" aria-label="决定列表">
          {list.map((row) => (
            <button
              key={row.id}
              className={data?.id === row.id ? "active" : ""}
              disabled={busy || uncertain}
              onClick={() => void read(row.id)}
            >
              <strong>{row.title}</strong>
              <small>
                {labels[row.state]} · v{row.version}
              </small>
            </button>
          ))}
          {!list.length ? (
            <p className="muted">当前项目还没有决定记录。</p>
          ) : null}
        </nav>
        <div className="method-editor">
          {data ? (
            <p className="policy-summary">
              当前保存版本 v{data.current.version} ·{" "}
              {labels[data.current.state]}
              {data.current.confirmedBy ? " · 已有具名员工确认" : ""}
              {data.current.basisAvailable === false
                ? " · 原讨论依据当前不可核验"
                : ""}
            </p>
          ) : (
            <h3>整理待确认提议</h3>
          )}
          {data && data.current.content === null ? (
            <p role="status">
              来源已变化或当前不能核验，未展示尚未采纳的旧提议正文。可撤回此提议，或根据当前资料新建。
            </p>
          ) : null}
          <div className="settings-form">
            <label>
              决定标题
              <input
                maxLength={300}
                value={fields.title}
                disabled={locked || !canWrite}
                onChange={(e) => edit("title", e.target.value)}
              />
            </label>
            <label>
              决定内容
              <textarea
                maxLength={8000}
                rows={6}
                value={fields.content}
                disabled={locked || !canWrite}
                onChange={(e) => edit("content", e.target.value)}
              />
            </label>
            <label>
              理由与约束
              <textarea
                maxLength={2000}
                value={fields.rationale}
                disabled={locked || !canWrite}
                onChange={(e) => edit("rationale", e.target.value)}
              />
            </label>
          </div>
          {canWrite ? (
            <details>
              <summary>关联当前待办与成果 · {fields.links.length}</summary>
              {[
                ...view.tasks.map((row) => ({
                  kind: "task" as const,
                  id: row.id,
                  title: row.title,
                  version: row.version ?? 0,
                })),
                ...view.artifacts.map((row) => ({
                  kind: "artifact" as const,
                  id: row.id,
                  title: row.title,
                  version: row.version ?? 0,
                })),
              ].map((row) => (
                <label className="check-row" key={row.kind + row.id}>
                  <input
                    type="checkbox"
                    checked={fields.links.some(
                      (link) => link.kind === row.kind && link.id === row.id,
                    )}
                    disabled={locked || row.version < 1}
                    onChange={(e) =>
                      edit(
                        "links",
                        e.target.checked
                          ? [
                              ...fields.links,
                              {
                                kind: row.kind,
                                id: row.id,
                                version: row.version ?? 0,
                              },
                            ]
                          : fields.links.filter(
                              (link) =>
                                link.id !== row.id || link.kind !== row.kind,
                            ),
                      )
                    }
                  />
                  {row.kind === "task" ? "待办" : "成果"}：{row.title} · v
                  {row.version}
                </label>
              ))}
            </details>
          ) : data?.current.links?.length ? (
            <p>
              此版本关联 {data.current.links.length}{" "}
              项待办/成果，具体版本保留在记录中。
            </p>
          ) : null}
          {canWrite && mode === "direct" ? (
            <details>
              <summary>选择讨论依据（可选）· {selectedRefs.length}</summary>
              <button
                disabled={locked}
                onClick={() => {
                  setSelectedRefs([]);
                  setDirty(true);
                  setConfirmed(false);
                }}
              >
                清除讨论依据
              </button>
              <p className="muted">
                未选择依据时，记录为员工输入的提议；不自动归因于讨论。
              </p>
              {sources.map((row) => (
                <label key={row.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selectedRefs.includes(row.id)}
                    disabled={locked}
                    onChange={(e) => {
                      setSelectedRefs((old) =>
                        e.target.checked
                          ? [...old, row.id]
                          : old.filter((id) => id !== row.id),
                      );
                      setDirty(true);
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    {row.author}：{row.content.slice(0, 120)}
                    {row.content.length > 120 ? "…" : ""}
                  </span>
                </label>
              ))}
            </details>
          ) : null}
          <div className="settings-form">
            <label>
              决定执行方式
              <select
                value={mode}
                disabled={locked || active}
                onChange={(e) => {
                  setMode(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="direct">人工直接保存</option>
                <option value="ai">由 AI 执行</option>
              </select>
            </label>
            {mode === "ai" ? (
              <>
                <label>
                  决定执行器
                  <select
                    value={engine}
                    disabled={locked || active}
                    onChange={(e) => {
                      setEngine(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="dsh">DSH</option>
                    <option value="hermes">Hermes</option>
                  </select>
                </label>
                <label>
                  决定模型
                  <select
                    value={model}
                    disabled={locked || active}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">默认对话连接</option>
                    {models.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
                {canWrite ? (
                  <label>
                    AI 整理要求
                    <textarea
                      value={instruction}
                      maxLength={4000}
                      disabled={locked || active}
                      onChange={(e) => setInstruction(e.target.value)}
                    />
                  </label>
                ) : null}
                <p className="muted">
                  整理提议会使用当前项目获准讨论与所选已保存提议；管理操作只使用员工确认的方案。本次可能产生模型费用。
                </p>
              </>
            ) : null}
          </div>
          {canWrite ? (
            <button
              className="primary"
              disabled={
                locked ||
                active ||
                (mode === "direct" &&
                  (!fields.title.trim() || !fields.content.trim()))
              }
              onClick={() =>
                void perform(
                  target
                    ? { operation: "revise", ...target }
                    : { operation: "create" },
                )
              }
            >
              {mode === "ai" ? "让 AI 整理提议" : "保存待确认提议"}
            </button>
          ) : null}
          {data?.canManage && data.current.state === "proposed" ? (
            <label>
              确认时替代哪个已有决定（可选）
              <select
                value={supersedes}
                disabled={locked || active}
                onChange={(e) => {
                  setSupersedes(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">作为新增决定</option>
                {list
                  .filter(
                    (row) =>
                      row.state === "confirmed" &&
                      row.id !== data.id &&
                      row.canManage,
                  )
                  .map((row) => (
                    <option key={row.id} value={row.id + ":" + row.version}>
                      {row.title} · v{row.version}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {canManage && target ? (
            <>
              <label className="check-row attachment-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked || active || dirty}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对已保存的 v{target.expectedVersion}
                ，确认记录上述操作；编辑草稿不属于本次确认
              </label>
              {dirty ? (
                <p>有未保存编辑，请先保存或重新读取已保存版本。</p>
              ) : null}
              <div className="attachment-toolbar">
                {data!.current.state === "proposed" ? (
                  <button
                    className="primary"
                    disabled={
                      locked ||
                      active ||
                      dirty ||
                      !confirmed ||
                      data!.current.content === null
                    }
                    onClick={() => {
                      const old = list.find(
                        (row) => row.id + ":" + row.version === supersedes,
                      );
                      if (supersedes && !old) {
                        setConfirmed(false);
                        setError("被替代决定已变化，请重新选择并核对版本。");
                        return;
                      }
                      void perform({
                        operation: "confirm",
                        ...target,
                        confirmed: true,
                        ...(old
                          ? { supersedes: { id: old.id, version: old.version } }
                          : {}),
                      });
                    }}
                  >
                    {mode === "ai" ? "让 AI 记录确认" : "确认此决定"}
                  </button>
                ) : null}
                <button
                  disabled={locked || active || dirty || !confirmed}
                  onClick={() =>
                    void perform({
                      operation: "withdraw",
                      ...target,
                      confirmed: true,
                    })
                  }
                >
                  {mode === "ai" ? "让 AI 撤回此决定" : "撤回此决定"}
                </button>
              </div>
            </>
          ) : null}
          {active ? (
            <button
              disabled={busy}
              onClick={() =>
                void mutation("/runs/" + ownRun + "/cancel", {})
                  .then((result) => {
                    if (alive.current) onRun({ ...run, ...result });
                  })
                  .catch(failed)
              }
            >
              停止决定执行
            </button>
          ) : null}
          {data ? (
            <details>
              <summary>
                决定历史 · 本次显示 {data.history.length} 个版本
              </summary>
              {data.history.map((row) => (
                <article className="brief-history" key={row.version}>
                  <strong>
                    v{row.version} · {labels[row.state]} ·{" "}
                    {row.channel === "ai_assisted" ? "AI 代执行" : "人工记录"}
                  </strong>
                  <p>{row.title}</p>
                  {row.content ? (
                    <pre>{row.content}</pre>
                  ) : (
                    <p>未采纳内容的当前依据不可核验，正文已隐藏。</p>
                  )}
                  <small>
                    {row.sourceRefs.length} 条讨论依据 · {row.links.length}{" "}
                    条业务关系
                  </small>
                </article>
              ))}
              {data.beforeVersion ? (
                <button
                  disabled={busy || uncertain}
                  onClick={() => void read(data.id, true)}
                >
                  读取更早决定版本
                </button>
              ) : null}
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
