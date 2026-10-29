import { useEffect, useRef, useState } from "react";
import type { Task, WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
interface History {
  version: number;
  snapshot: Pick<Task, "title" | "assignee" | "dueDate" | "status">;
  actorName?: string;
  channel: string;
  createdAt: string;
}
interface Detail {
  current: Task;
  history: History[];
}
const values = (task: Task) => ({
  title: task.title,
  assignee: task.assignee,
  dueDate: task.dueDate ?? "",
  status: task.status,
});
export function TaskEditor({
  task,
  view,
  run,
  onRun,
  onUpdated,
}: {
  task: Task;
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
  onUpdated: (task: Task) => void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [base, setBase] = useState<Task>(),
    [fields, setFields] = useState(values(task));
  const [mode, setMode] = useState("human"),
    [instruction, setInstruction] = useState(""),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [models, setModels] = useState<ModelSummary[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const ownsRun = run?.workflow === "revise_task" && run.taskId === task.id;
  const pending =
    ownsRun &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  async function load(reset = false) {
    const token = ++generation.current;
    try {
      const result = await api<Detail>("/tasks/" + task.id);
      if (!alive.current || token !== generation.current) return;
      setDetail(result);
      onUpdated(result.current);
      if (reset) {
        setBase(result.current);
        setFields(values(result.current));
      }
    } catch (e) {
      if (alive.current && token === generation.current) {
        setDetail(undefined);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [task.id]);
  useEffect(() => {
    if (mode !== "ai") return;
    let current = true;
    void api<ModelSummary[]>("/models")
      .then((rows) => {
        if (current) setModels(rows.filter((x) => x.purpose === "chat"));
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [mode]);
  useEffect(() => {
    if (
      ownsRun &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已处理待办记录。编辑框已保留，请读取当前版本核对结果。"
          : "",
      );
      if (run.error) setError(run.error);
      void load();
    }
  }, [run?.id, run?.state]);
  const stale = !!detail && !!base && detail.current.version !== base.version;
  const dirty =
    !!base && JSON.stringify(fields) !== JSON.stringify(values(base));
  const selected = models.find((x) => x.id === modelId),
    incompatible =
      engine !== "fixture" &&
      selected &&
      view.engines[engine]?.modelProviders &&
      !view.engines[engine]!.modelProviders!.includes(selected.provider);
  async function save() {
    if (busy || !base || !detail || stale) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await mutation<Task>(
        "/tasks/" + task.id,
        {
          ...fields,
          dueDate: fields.dueDate || null,
          expectedVersion: base.version,
        },
        "PATCH",
      );
      if (!alive.current) return;
      setBase(saved);
      setFields(values(saved));
      setDetail((current) => ({
        current: saved,
        history: current?.history ?? [],
      }));
      onUpdated(saved);
      await load();
      if (alive.current) setNotice("已保存待办记录的新版本。");
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        await load();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function revise() {
    if (
      busy ||
      pending ||
      !base ||
      !detail ||
      stale ||
      dirty ||
      !instruction.trim() ||
      incompatible
    )
      return;
    const payload = {
      conversationId: view.project.conversationId,
      workflow: "revise_task",
      taskId: task.id,
      expectedTaskVersion: base.version,
      engine,
      instruction: instruction.trim(),
      ...(engine !== "fixture" && modelId ? { modelProfileId: modelId } : {}),
    };
    const hash = JSON.stringify(payload);
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const started = await mutation("/runs", {
        ...payload,
        idempotencyKey: attempt.current!.key,
      });
      if (!alive.current) return;
      onRun({ ...started, workflow: "revise_task", taskId: task.id, engine });
      setNotice(
        "已发起修改。AI 只使用当前已保存的这条待办，编辑框仍可保留人工草稿。",
      );
      attempt.current = undefined;
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        await load();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="task-editor" aria-label="待办修改">
      <p className="muted small">
        仅修改当前项目的这条待办。负责人是文字标记，未绑定员工账号；记录“已完成”不代表实际工作已独立验收，也不会发送外部通知。
      </p>
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="muted small">
          {notice}
        </p>
      ) : null}
      {detail && base ? (
        <>
          <p className="muted small" role="status">
            当前已保存 v{detail.current.version} ·{" "}
            {detail.current.status === "done" ? "已标记完成" : "待处理"}
            ；编辑框基于 v{base.version}
          </p>
          {stale ? (
            <p role="status" className="muted small">
              已有新版，当前编辑内容已保留。读取当前版本后再修改。
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              void load(true);
            }}
          >
            读取当前版本{dirty ? "（将替换编辑内容）" : ""}
          </button>
          <label>
            修改方式
            <select
              aria-label="待办修改方式"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="human">直接修改</option>
              <option value="ai">AI 修改</option>
            </select>
          </label>
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              待办标题
              <input
                aria-label="待办标题"
                required
                maxLength={300}
                value={fields.title}
                disabled={busy}
                onChange={(e) =>
                  setFields({ ...fields, title: e.target.value })
                }
              />
            </label>
            <label>
              负责人文字标记
              <input
                aria-label="负责人文字标记"
                required
                maxLength={100}
                value={fields.assignee}
                disabled={busy}
                onChange={(e) =>
                  setFields({ ...fields, assignee: e.target.value })
                }
              />
            </label>
            <div className="task-editor-pair">
              <label>
                截止日期
                <input
                  aria-label="待办截止日期"
                  type="date"
                  value={fields.dueDate}
                  disabled={busy}
                  onChange={(e) =>
                    setFields({ ...fields, dueDate: e.target.value })
                  }
                />
              </label>
              <label>
                待办状态
                <select
                  aria-label="待办状态"
                  value={fields.status}
                  disabled={busy}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      status: e.target.value as Task["status"],
                    })
                  }
                >
                  <option value="open">待处理</option>
                  <option value="done">已标记完成</option>
                </select>
              </label>
            </div>
            <button className="primary" disabled={busy || stale || !dirty}>
              保存待办修改
            </button>
          </form>
          {mode === "ai" ? (
            <form
              className="dialog-form task-ai-form"
              onSubmit={(e) => {
                e.preventDefault();
                void revise();
              }}
            >
              <p className="muted small">
                AI
                可修改标题、负责人文字标记、日期和状态，只把这条已保存待办与下面的要求交给模型，不包含群消息或文件正文。未保存编辑请先保存或重新读取。
              </p>
              <label>
                待办修改要求
                <textarea
                  aria-label="待办修改要求"
                  required
                  maxLength={20000}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
              <div className="task-editor-pair">
                <label>
                  执行器
                  <select
                    aria-label="待办执行器"
                    value={engine}
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
                    模型连接
                    <select
                      aria-label="待办模型连接"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    >
                      <option value="">当前默认连接</option>
                      {models.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              {incompatible ? (
                <p role="status" className="muted small">
                  所选模型连接与执行器不兼容，请更换连接。
                </p>
              ) : null}
              <p className="muted small">
                使用所选模型可能产生费用；完成后需核对实际修改回执及版本。
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  pending ||
                  stale ||
                  dirty ||
                  !instruction.trim() ||
                  !!incompatible
                }
              >
                让 AI 修改待办
              </button>
            </form>
          ) : null}
          <h3>最近版本（最多 20 条）</h3>
          <ol className="task-version-history">
            {detail.history.map((item) => (
              <li key={item.version}>
                <strong>
                  v{item.version} · {item.snapshot.title}
                </strong>
                <p>
                  {item.channel === "legacy_snapshot"
                    ? "此前状态快照，原修改人未知"
                    : `${item.actorName ?? "员工"} · ${item.channel === "ai" ? "AI 修改" : "人工修改"}`}
                </p>
                <small>
                  {item.snapshot.assignee} ·{" "}
                  {item.snapshot.dueDate ?? "未设日期"} ·{" "}
                  {item.snapshot.status === "done" ? "已标记完成" : "待处理"}
                </small>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="muted">正在读取待办或当前记录不可访问。</p>
      )}
    </section>
  );
}
