import { useEffect, useRef, useState } from "react";
import type { WorkspaceView, WorkProposal } from "@hyper/contracts";
import { api, ApiError, mutation } from "../api";
const names: Record<string, string> = {
  waiting_input: "待澄清",
  waiting_confirmation: "待确认",
  succeeded: "已执行",
  cancelled: "已停止",
  failed: "未完成",
};
export function WorkPlanPanel({
  view,
  run,
  onRun,
  onStart,
  onChanged,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (value: any) => void;
  onStart: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<any>(),
    [draft, setDraft] = useState<WorkProposal>(),
    [editing, setEditing] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [choices, setChoices] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [original, setOriginal] = useState<any>(),
    [receipt, setReceipt] = useState<any>();
  const alive = useRef(false),
    generation = useRef(0),
    sequence = useRef(0),
    listSequence = useRef(0),
    selectedRef = useRef(selected),
    saving = useRef(false),
    attempt = useRef<any>(undefined);
  selectedRef.current = selected;
  const locked = busy || uncertain,
    writable =
      detail &&
      ["waiting_input", "waiting_confirmation"].includes(detail.state);
  function fail(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status)) {
      generation.current++;
      setDetail(undefined);
      setDraft(undefined);
      setAnswers({});
      setChoices({});
      setOriginal(undefined);
      setReceipt(undefined);
      setConfirmed(false);
      setEditing(false);
    }
  }
  async function list() {
    const g = generation.current,
      seq = ++listSequence.current;
    try {
      const result = await api<any[]>(
        "/projects/" + view.project.id + "/work-plans",
      );
      if (
        !alive.current ||
        g !== generation.current ||
        seq !== listSequence.current
      )
        return;
      setRows(result);
      if (!selectedRef.current && result.length) setSelected(result[0].id);
    } catch (e) {
      if (alive.current && g === generation.current) fail(e);
    }
  }
  async function load(id: string, reset = false) {
    const g = generation.current,
      seq = ++sequence.current;
    try {
      const value = await api<any>("/runs/" + id + "/plan");
      if (
        !alive.current ||
        g !== generation.current ||
        seq !== sequence.current ||
        selectedRef.current !== id
      )
        return;
      setDetail(value);
      if (reset) {
        setDraft(value.proposal);
        setAnswers({});
        setChoices({});
        setConfirmed(false);
        setEditing(false);
        setOriginal(undefined);
      }
      const actual = await api<any>("/runs/" + id);
      if (
        alive.current &&
        g === generation.current &&
        seq === sequence.current &&
        selectedRef.current === id
      )
        setReceipt(actual.result?.receipts ?? []);
    } catch (e) {
      if (
        alive.current &&
        g === generation.current &&
        selectedRef.current === id
      )
        fail(e);
    }
  }
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => {
      if (!saving.current && document.visibilityState === "visible")
        void list();
    }, 8000);
    return () => {
      alive.current = false;
      generation.current++;
      sequence.current++;
      clearInterval(timer);
    };
  }, [view.user.id, view.project.id]);
  useEffect(() => {
    generation.current++;
    setDetail(undefined);
    setDraft(undefined);
    setOriginal(undefined);
    setReceipt(undefined);
    setEditing(false);
    setConfirmed(false);
    setAnswers({});
    setChoices({});
    setError("");
    setNotice("");
    void list();
    if (selected) void load(selected, true);
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(() => {
      if (
        !saving.current &&
        !editing &&
        !uncertain &&
        document.visibilityState === "visible"
      )
        void load(selected);
    }, 8000);
    return () => clearInterval(timer);
  }, [selected, editing, uncertain]);
  useEffect(() => {
    if (
      run?.workflow === "plan_work" &&
      !["queued", "running"].includes(run.state) &&
      !locked
    ) {
      if (selected !== run.id) setSelected(run.id);
      else if (!editing) void load(run.id);
      void list();
    }
  }, [run?.id, run?.state]);
  useEffect(() => setConfirmed(false), [detail?.revision]);
  async function send(
    url?: string,
    body?: any,
    method = "POST",
    retry = false,
  ) {
    if (busy || (!retry && uncertain)) return;
    const request = retry
      ? attempt.current
      : { url, body: { ...body, idempotencyKey: crypto.randomUUID() }, method };
    if (!request) return;
    const g = generation.current,
      id = selected;
    attempt.current = request;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await mutation<any>(
        request.url,
        request.body,
        request.method,
      );
      const latest = await api<any>("/runs/" + id);
      if (!alive.current || g !== generation.current) return;
      attempt.current = undefined;
      setUncertain(false);
      setConfirmed(false);
      setEditing(false);
      onRun(latest);
      await load(id, true);
      await list();
      if (!alive.current || g !== generation.current) return;
      setNotice(
        result.state === "succeeded"
          ? "已保存实际业务记录，请核对回执；未发送员工通知。"
          : "已保存，请重新核对计划。确认前没有执行业务动作。",
      );
      if (result.state === "succeeded") onChanged();
    } catch (e) {
      if (!alive.current || g !== generation.current) return;
      if (!(e instanceof ApiError) || e.status >= 500) setUncertain(true);
      else {
        attempt.current = undefined;
        setUncertain(false);
      }
      fail(e);
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function showOriginal(id: string) {
    const g = generation.current,
      seq = ++sequence.current;
    setOriginal(undefined);
    try {
      const value = await api<any>("/artifacts/" + id);
      if (alive.current && g === generation.current && seq === sequence.current)
        setOriginal(value.current);
    } catch (e) {
      if (alive.current && g === generation.current) fail(e);
    }
  }
  function editStep(index: number, fields: any) {
    setDraft(
      (value) =>
        value && {
          ...value,
          operations: value.operations.map((operation, i) =>
            i === index ? { ...operation, ...fields } : operation,
          ),
        },
    );
    setConfirmed(false);
  }
  return (
    <section className="work-panel work-plan-panel" aria-label="工作计划与澄清">
      <div className="panel-heading">
        <div>
          <h3>先明确，再推进</h3>
          <p>有歧义先核对，确认后一次保存本批内部业务记录。</p>
        </div>
        <button className="primary" disabled={locked} onClick={onStart}>
          整理工作计划
        </button>
      </div>
      <p className="muted">
        计划为本人私有，24
        小时内有效。等待员工输入不消耗执行时限；确认后不再次调用模型。回执不证明实际工作质量或员工已获通知。
      </p>
      <label>
        已保存的工作计划
        <select
          aria-label="已保存的工作计划"
          disabled={locked}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">选择计划</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {names[row.state] ?? row.state} · {row.engine} ·{" "}
              {row.id.slice(0, 8)} · r{row.revision}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {uncertain ? (
        <button
          disabled={busy}
          onClick={() => void send(undefined, undefined, undefined, true)}
        >
          核对原计划操作
        </button>
      ) : null}
      {detail ? (
        <>
          <h4>
            {detail.proposal.summary} · r{detail.revision} ·{" "}
            {names[detail.state] ?? detail.state}
          </h4>
          {detail.proposal.operations.map((operation: any, index: number) => (
            <article className="work-plan-step" key={index}>
              <h4>
                第 {index + 1} 步 ·{" "}
                {
                  (
                    {
                      create_task: "创建待办",
                      update_task: "修改待办记录",
                      create_artifact: "保存成果草稿",
                      revise_artifact: "完整替换成果正文",
                    } as Record<string, string>
                  )[operation.operation]
                }
              </h4>
              <p>
                {operation.title ?? operation.target?.name}
                {operation.target?.version
                  ? " · 请求 v" + operation.target.version
                  : ""}
              </p>
              {Object.entries(detail.resolvedDisplay)
                .filter(([key]) => key.startsWith(index + ":"))
                .map(([key, value]: any) => (
                  <p key={key}>
                    {key.endsWith(":target") ? "确切目标" : "负责人"}：
                    {value.name} · {value.id ?? "未分配"}
                    {value.version ? " · v" + value.version : ""}
                  </p>
                ))}
              {operation.dueDate !== undefined ? (
                <p>日期：{operation.dueDate ?? "待定"}</p>
              ) : null}
              {operation.status ? (
                <p>
                  待办标记：
                  {operation.status === "done"
                    ? "已完成（非独立验收）"
                    : "未完成"}
                </p>
              ) : null}
              {operation.content ? (
                <details>
                  <summary>检查将保存的完整正文</summary>
                  <pre>{operation.content}</pre>
                </details>
              ) : null}
              {operation.operation === "revise_artifact" &&
              detail.resolved[index + ":target"]?.id ? (
                <button
                  disabled={locked}
                  onClick={() =>
                    void showOriginal(detail.resolved[index + ":target"].id)
                  }
                >
                  查看当前成果原文
                </button>
              ) : null}
            </article>
          ))}
          {original ? (
            <aside aria-label="当前成果原文">
              <h4>
                {original.title} · v{original.version}
              </h4>
              <pre>{original.content}</pre>
              <button onClick={() => setOriginal(undefined)}>关闭原文</button>
            </aside>
          ) : null}
          {Object.entries(detail.answers).map(([key, text]: any) => (
            <p key={key}>员工回答：{text}</p>
          ))}
          {writable && !editing ? (
            <>
              {detail.questions.map((question: any) => (
                <label className="work-plan-question" key={question.key}>
                  {question.prompt}
                  {question.choices ? (
                    <select
                      aria-label={question.prompt}
                      value={choices[question.key] ?? ""}
                      disabled={locked}
                      onChange={(e) => {
                        setChoices({
                          ...choices,
                          [question.key]: e.target.value,
                        });
                        setConfirmed(false);
                      }}
                    >
                      <option value="">明确选择</option>
                      {question.allowUnassigned ? (
                        <option value="unassigned">保持待分配</option>
                      ) : null}
                      {question.choices.map((choice: any) => (
                        <option
                          key={choice.id}
                          value={JSON.stringify({
                            id: choice.id,
                            ...(choice.version
                              ? { version: choice.version }
                              : {}),
                          })}
                        >
                          {choice.name} · {choice.sourceUid ?? choice.id}
                          {choice.version ? " · v" + choice.version : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <textarea
                      aria-label={question.prompt}
                      maxLength={4000}
                      value={answers[question.key] ?? ""}
                      disabled={locked}
                      onChange={(e) => {
                        setAnswers({
                          ...answers,
                          [question.key]: e.target.value,
                        });
                        setConfirmed(false);
                      }}
                    />
                  )}
                </label>
              ))}
              {detail.questions.length ? (
                <button
                  disabled={
                    locked ||
                    (!Object.values(answers).some((text) => text.trim()) &&
                      !Object.values(choices).some(Boolean))
                  }
                  onClick={() =>
                    void send("/runs/" + selected + "/plan/responses", {
                      expectedRevision: detail.revision,
                      answers: Object.entries(answers)
                        .filter(([, text]) => text.trim())
                        .map(([key, text]) => ({ key, text })),
                      selections: Object.entries(choices)
                        .filter(([, value]) => value)
                        .map(([key, value]) => ({
                          key,
                          ...(value === "unassigned"
                            ? { id: null }
                            : JSON.parse(value)),
                        })),
                      confirmed: false,
                    })
                  }
                >
                  保存澄清结果
                </button>
              ) : (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={locked}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已检查所有步骤、员工
                    ID、目标版本和完整正文，确认执行当前计划
                  </label>
                  <button
                    className="primary"
                    disabled={locked || !confirmed}
                    onClick={() =>
                      void send("/runs/" + selected + "/plan/responses", {
                        expectedRevision: detail.revision,
                        confirmed: true,
                      })
                    }
                  >
                    执行已确认工作计划
                  </button>
                </>
              )}
              <button
                disabled={locked}
                onClick={() => {
                  setDraft(detail.proposal);
                  setEditing(true);
                  setConfirmed(false);
                }}
              >
                人工接管并修改计划
              </button>
              <button
                disabled={
                  locked ||
                  Object.values(answers).some(Boolean) ||
                  Object.values(choices).some(Boolean)
                }
                onClick={() =>
                  void send("/runs/" + selected + "/plan/responses", {
                    expectedRevision: detail.revision,
                    regenerate: true,
                  })
                }
              >
                让 AI 根据已保存答案重新整理（可能产生费用）
              </button>
            </>
          ) : null}
          {writable && editing && draft ? (
            <div className="work-plan-editor">
              <label>
                计划说明
                <input
                  aria-label="计划说明"
                  value={draft.summary}
                  maxLength={1000}
                  disabled={locked}
                  onChange={(e) =>
                    setDraft({ ...draft, summary: e.target.value })
                  }
                />
              </label>
              {draft.operations.map((operation: any, index: number) => (
                <fieldset key={index} disabled={locked}>
                  <legend>编辑第 {index + 1} 步</legend>
                  {"title" in operation ||
                  operation.operation === "update_task" ? (
                    <label>
                      步骤标题
                      <input
                        value={operation.title ?? ""}
                        maxLength={200}
                        onChange={(e) =>
                          editStep(index, {
                            title:
                              operation.operation === "update_task" &&
                              !e.target.value.trim()
                                ? undefined
                                : e.target.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {operation.target ? (
                    <>
                      <label>
                        目标名称
                        <input
                          value={operation.target.name}
                          maxLength={300}
                          onChange={(e) =>
                            editStep(index, {
                              target: {
                                ...operation.target,
                                name: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        目标版本（空白重新核对当前版本）
                        <input
                          type="number"
                          min={1}
                          value={operation.target.version ?? ""}
                          onChange={(e) =>
                            editStep(index, {
                              target: {
                                name: operation.target.name,
                                ...(e.target.value
                                  ? { version: Number(e.target.value) }
                                  : {}),
                              },
                            })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {"content" in operation ? (
                    <label>
                      完整正文
                      <textarea
                        value={operation.content}
                        rows={6}
                        maxLength={20000}
                        onChange={(e) =>
                          editStep(index, { content: e.target.value })
                        }
                      />
                    </label>
                  ) : null}
                  {"assignee" in operation ||
                  operation.operation === "update_task" ? (
                    <label>
                      负责人名称（空白待分配）
                      <input
                        value={operation.assignee?.name ?? ""}
                        maxLength={255}
                        onChange={(e) =>
                          editStep(index, {
                            assignee: e.target.value.trim()
                              ? { name: e.target.value }
                              : null,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {"dueDate" in operation ||
                  operation.operation === "update_task" ? (
                    <label>
                      截止日期
                      <input
                        type="date"
                        value={operation.dueDate ?? ""}
                        onChange={(e) =>
                          editStep(index, { dueDate: e.target.value || null })
                        }
                      />
                    </label>
                  ) : null}
                  {operation.operation === "update_task" ? (
                    <label>
                      待办标记
                      <select
                        value={operation.status ?? ""}
                        onChange={(e) =>
                          editStep(index, {
                            status: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">保持当前标记</option>
                        <option value="open">未完成</option>
                        <option value="done">完成标记（非独立验收）</option>
                      </select>
                    </label>
                  ) : null}
                  <button
                    disabled={draft.operations.length <= 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        operations: draft.operations.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    移除此步骤
                  </button>
                </fieldset>
              ))}
              <button
                disabled={locked || draft.operations.length >= 6}
                onClick={() =>
                  setDraft({
                    ...draft,
                    operations: [
                      ...draft.operations,
                      {
                        operation: "create_task",
                        title: "新待办",
                        assignee: null,
                        dueDate: null,
                      },
                    ],
                  })
                }
              >
                增加待办步骤
              </button>
              <button
                disabled={locked}
                onClick={() =>
                  void send(
                    "/runs/" + selected + "/plan",
                    { expectedRevision: detail.revision, proposal: draft },
                    "PATCH",
                  )
                }
              >
                保存人工修改并重新核对
              </button>
              <button disabled={locked} onClick={() => setEditing(false)}>
                放弃本次编辑
              </button>
            </div>
          ) : null}
          <details>
            <summary>实际执行回执</summary>
            <pre>{JSON.stringify(receipt ?? [], null, 2)}</pre>
          </details>
          <button disabled={locked} onClick={() => void load(selected, true)}>
            重新读取当前计划
          </button>
        </>
      ) : null}
    </section>
  );
}
