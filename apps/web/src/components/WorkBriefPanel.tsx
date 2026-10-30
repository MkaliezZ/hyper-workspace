import { useEffect, useRef, useState } from "react";
import type {
  WorkBriefPlan,
  WorkBriefContent,
  WorkspaceView,
  BriefReference,
} from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
type Summary = {
  id: string;
  title: string;
  version: number;
  status: string;
  ownerId: string;
};
type Detail = {
  current: {
    id: string;
    version: number;
    status: string;
    content: Omit<WorkBriefContent, "questions">;
    questions: {
      id: string;
      question: string;
      answer: string | null;
      answeredBy: string | null;
    }[];
  };
  history: {
    version: number;
    snapshot: any;
    sourceRunId: string | null;
    actorId: string;
  }[];
  canManage: boolean;
};
const empty = {
  title: "",
  goal: "",
  scope: "",
  constraints: "",
  completionCriteria: "",
  questions: "",
};
const labels = {
  title: "说明标题",
  goal: "工作目标",
  scope: "工作范围",
  constraints: "约束条件",
  completionCriteria: "完成标准",
  questions: "待澄清问题（每行一个）",
};
const states: Record<string, string> = {
  draft: "待确认",
  needs_input: "待补充澄清",
  confirmed: "已确认",
};
export function WorkBriefPanel({
  view,
  run,
  onRun,
  onUse,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (r: any) => void;
  onUse: (ref: BriefReference) => void;
}) {
  const [list, setList] = useState<Summary[]>([]),
    [models, setModels] = useState<ModelSummary[]>([]),
    [id, setId] = useState(""),
    [data, setData] = useState<Detail>(),
    [fields, setFields] = useState(empty),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(false),
    [resultId, setResultId] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    listGeneration = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const base = "/projects/" + view.project.id + "/work-briefs";
  const active =
    run?.workflow === "manage_brief" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const disabled = busy || active;
  async function reloadList() {
    const version = ++listGeneration.current;
    const rows = await api<Summary[]>(base);
    if (alive.current && version === listGeneration.current) setList(rows);
  }
  function clear() {
    generation.current++;
    setId("");
    setData(undefined);
    setFields(empty);
    setAnswers({});
    setConfirm(false);
    setError("");
    setNotice("");
    setResultId("");
  }
  async function read(target: string) {
    const g = ++generation.current;
    setId(target);
    setData(undefined);
    setFields(empty);
    setAnswers({});
    setConfirm(false);
    setError("");
    setNotice("");
    setResultId("");
    try {
      const d = await api<Detail>(base + "/" + target);
      if (!alive.current || g !== generation.current) return;
      setData(d);
      setFields({
        ...d.current.content,
        questions: d.current.questions.map((q) => q.question).join("\n"),
      });
      setAnswers(
        Object.fromEntries(
          d.current.questions.map((q) => [q.id, q.answer ?? ""]),
        ),
      );
    } catch (e) {
      if (alive.current && g === generation.current) {
        setData(undefined);
        setFields(empty);
        setAnswers({});
        listGeneration.current++;
        setList([]);
        setModels([]);
        setId("");
        setResultId("");
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    const version = ++listGeneration.current;
    void Promise.all([api<Summary[]>(base), api<ModelSummary[]>("/models")])
      .then(([rows, ms]) => {
        if (alive.current && version === listGeneration.current) {
          setList(rows);
          setModels(ms.filter((m) => m.purpose === "chat"));
        }
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
      generation.current++;
      listGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (
      run?.workflow !== "manage_brief" ||
      !["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      return;
    void reloadList().catch((e) => {
      if (alive.current) {
        clear();
        setList([]);
        setError(e.message);
      }
    });
    setResultId(run.result?.receipts?.[0]?.briefId ?? "");
    setNotice(
      run.state === "succeeded"
        ? "AI 操作已保存。当前编辑内容保留，请明确读取保存结果。"
        : "AI 操作未完成，请核对执行状态及已有回执。",
    );
  }, [run?.id, run?.state]);
  async function save(plan: WorkBriefPlan) {
    setBusy(true);
    setError("");
    setNotice("");
    setConfirm(false);
    const draft = {
      ...fields,
      questions: fields.questions
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
    const writing = plan.operation === "create" || plan.operation === "revise";
    const input = {
      plan,
      draft: writing ? draft : undefined,
      mode,
      engine,
      model,
    };
    const hash = JSON.stringify(input);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId: view.project.conversationId,
          workflow: "manage_brief",
          briefPlan: plan,
          engine,
          ...(engine !== "fixture" && model ? { modelProfileId: model } : {}),
          instruction: writing
            ? "整理以下员工输入，保留明确约束，未知不猜测，提出必要澄清问题，不确认或执行工作：\n" +
              JSON.stringify(draft)
            : "仅执行我在界面明确选择的任务说明操作和答案，不更改目标、版本或确认决定。",
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current)
          onRun({ ...started, engine, workflow: "manage_brief" });
      } else {
        const result = (await mutation(base, {
          plan,
          ...(writing ? { draft } : {}),
          idempotencyKey: attempt.current!.key,
        })) as any;
        if (alive.current) {
          await reloadList();
          await read(result.briefId);
          setNotice("操作已保存，显示当前实际版本。");
        }
      }
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const canEdit = !id || !!data?.canManage;
  const dirty =
    !!data &&
    (JSON.stringify(fields) !==
      JSON.stringify({
        ...data.current.content,
        questions: data.current.questions.map((q) => q.question).join("\n"),
      }) ||
      data.current.questions.some(
        (q) => (answers[q.id] ?? "") !== (q.answer ?? ""),
      ));
  const incomplete =
    !!data &&
    (!data.current.content.scope ||
      !data.current.content.completionCriteria ||
      data.current.questions.some((q) => !q.answer));
  const target = data
    ? { briefId: data.current.id, expectedVersion: data.current.version }
    : null;
  return (
    <section className="work-panel brief-panel" aria-label="任务说明">
      <div className="work-panel-heading">
        <h3>任务说明与澄清</h3>
        <button className="secondary" disabled={disabled} onClick={clear}>
          新建说明
        </button>
      </div>
      <p className="muted">
        说明及答案对当前项目可访问成员可见。先明确目标、范围、约束和完成标准。AI
        只整理所填要求和所选说明，不读取讨论；问题须由员工回答，确认后才能按此版本执行。员工确认不代表事实已独立验证。
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {resultId ? (
        <button
          disabled={disabled}
          className="secondary"
          onClick={() => void read(resultId)}
        >
          读取保存结果
        </button>
      ) : null}
      <label>
        已有任务说明
        <select
          aria-label="已有任务说明"
          value={id}
          disabled={disabled}
          onChange={(e) =>
            e.target.value ? void read(e.target.value) : clear()
          }
        >
          <option value="">新说明</option>
          {list.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} · v{b.version} · {states[b.status]}
            </option>
          ))}
        </select>
      </label>
      {id ? (
        <button
          disabled={disabled}
          className="secondary"
          onClick={() => void read(id)}
        >
          重新读取说明
        </button>
      ) : null}
      {data ? (
        <p className="policy-summary">
          当前版本 {data.current.version} · {states[data.current.status]}
          {!data.canManage
            ? " · 你有查看与引用权限，修改请联系维护人或管理员。"
            : ""}
        </p>
      ) : null}
      {canEdit ? (
        <>
          <div className="settings-form">
            <label>
              说明操作方式
              <select
                disabled={disabled}
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setConfirm(false);
                }}
              >
                <option value="direct">直接保存</option>
                <option value="ai">AI 处理说明</option>
              </select>
            </label>
            {mode === "ai" ? (
              <>
                <label>
                  说明执行服务
                  <select
                    disabled={disabled}
                    value={engine}
                    onChange={(e) => setEngine(e.target.value)}
                  >
                    <option value="dsh">DSH</option>
                    <option value="hermes">Hermes</option>
                    {view.user.demo ? (
                      <option value="fixture">演示流程（无模型调用）</option>
                    ) : null}
                  </select>
                </label>
                <label>
                  说明执行模型
                  <select
                    disabled={disabled}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">可用默认对话连接</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save(
                target
                  ? { operation: "revise", ...target }
                  : { operation: "create" },
              );
            }}
          >
            <fieldset disabled={disabled}>
              {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
                <label key={key}>
                  {labels[key]}
                  <textarea
                    aria-label={labels[key]}
                    rows={key === "title" ? 1 : 3}
                    required={key === "title" || key === "goal"}
                    maxLength={
                      key === "title" ? 200 : key === "questions" ? 6000 : 4000
                    }
                    value={fields[key]}
                    onChange={(e) => {
                      setFields((f) => ({ ...f, [key]: e.target.value }));
                      setConfirm(false);
                    }}
                  />
                </label>
              ))}
              <button type="submit" disabled={!!id && !data}>
                {mode === "ai" ? "AI 整理说明草稿" : "保存说明草稿"}
              </button>
            </fieldset>
          </form>
          {data && target ? (
            <div className="brief-clarification">
              <h4>必要澄清</h4>
              {data.current.questions.length ? (
                <form
                  className="dialog-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save({
                      operation: "answer",
                      ...target,
                      answers: data.current.questions.map((q) => ({
                        questionId: q.id,
                        answer: answers[q.id] ?? "",
                      })),
                    });
                  }}
                >
                  <fieldset disabled={disabled}>
                    {data.current.questions.map((q) => (
                      <label key={q.id}>
                        {q.question}
                        <textarea
                          required
                          aria-label={"回答：" + q.question}
                          maxLength={4000}
                          rows={2}
                          value={answers[q.id] ?? ""}
                          onChange={(e) => {
                            setAnswers((a) => ({
                              ...a,
                              [q.id]: e.target.value,
                            }));
                            setConfirm(false);
                          }}
                        />
                      </label>
                    ))}
                    <button>保存澄清回答</button>
                  </fieldset>
                </form>
              ) : (
                <p className="muted">
                  当前没有保存的澄清问题。仍须由你检查范围和完成标准。
                </p>
              )}
              {dirty ? (
                <p className="muted">
                  有未保存的编辑或回答，请先保存并检查当前版本再确认。
                </p>
              ) : null}
              <label className="confirmation-label">
                <input
                  type="checkbox"
                  disabled={disabled || dirty || incomplete}
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                我已检查保存的当前版本、答案、范围和完成标准，确认可据此执行
              </label>
              <button
                disabled={disabled || dirty || incomplete || !confirm}
                onClick={() =>
                  void save({
                    operation: "confirm",
                    ...target,
                    confirmed: true,
                  })
                }
              >
                确认当前说明
              </button>
              {data.current.status === "confirmed" ? (
                <button
                  disabled={disabled}
                  className="secondary"
                  onClick={() => void save({ operation: "reopen", ...target })}
                >
                  重新打开说明
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {data?.current.status === "confirmed" ? (
        <button
          disabled={disabled || dirty || !!resultId}
          onClick={() =>
            onUse({ id: data.current.id, version: data.current.version })
          }
        >
          按此说明发起任务
        </button>
      ) : null}
      {data ? (
        <details>
          <summary>保存版本与来源</summary>
          {data.history.map((h) => (
            <div key={h.version} className="brief-history">
              <strong>
                v{h.version} · {states[h.snapshot.status]}
              </strong>
              <span>
                {h.sourceRunId ? "AI Run " + h.sourceRunId : "员工直接保存"}
              </span>
              <pre>{JSON.stringify(h.snapshot, null, 2)}</pre>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
