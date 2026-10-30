import { useEffect, useRef, useState } from "react";
import type { Task, WorkspaceView } from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
type Person = {
  id: string | null;
  name: string;
  sourceUid: string | null;
  state: "available" | "unavailable";
  origin: string;
};
type Directory = {
  projectId: string;
  checkedAt: string;
  scope: string;
  rows: Person[];
};
function useMembers(projectId: string, open: boolean) {
  const [data, setData] = useState<Directory>(),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [models, setModels] = useState<ModelSummary[]>([]),
    alive = useRef(false),
    version = useRef(0);
  function invalidate(message = "成员范围需重新核验，请重新读取。") {
    window.dispatchEvent(
      new CustomEvent("hyper-directory-invalidated", {
        detail: { projectId, message },
      }),
    );
  }
  async function load() {
    const g = ++version.current;
    setData(undefined);
    setModels([]);
    setError("");
    try {
      const [d, m] = await Promise.all([
        api<Directory>("/projects/" + projectId + "/directory"),
        api<ModelSummary[]>("/models"),
      ]);
      if (alive.current && g === version.current) {
        setData(d);
        setModels(m.filter((x) => x.purpose === "chat"));
      }
    } catch (e) {
      if (alive.current && g === version.current) {
        setData(undefined);
        setModels([]);
        setError((e as Error).message);
        invalidate((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    const invalidated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.projectId === projectId) {
        version.current++;
        setData(undefined);
        setModels([]);
        setError(detail.message);
        setQuery("");
      }
    };
    window.addEventListener("hyper-directory-invalidated", invalidated);

    if (open) void load();
    return () => {
      window.removeEventListener("hyper-directory-invalidated", invalidated);
      alive.current = false;
      version.current++;
    };
  }, [projectId, open]);
  return { data, error, models, load, alive, invalidate, query, setQuery };
}
function Execution({
  view,
  engine,
  setEngine,
  model,
  setModel,
  models,
  disabled,
}: {
  view: WorkspaceView;
  engine: string;
  setEngine: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  models: ModelSummary[];
  disabled: boolean;
}) {
  return (
    <div className="settings-form">
      <label>
        成员执行服务
        <select
          value={engine}
          disabled={disabled}
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
        成员执行模型
        <select
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">可用默认对话连接</option>
          {models.map((m) => (
            <option
              key={m.id}
              value={m.id}
              disabled={
                !!view.engines[engine]?.modelProviders &&
                !view.engines[engine]!.modelProviders!.includes(m.provider)
              }
            >
              {m.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function ProjectMembers({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (v: any) => void;
}) {
  const [open, setOpen] = useState(false),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const {
    data,
    error: readError,
    models,
    load,
    alive,
    invalidate,
    query,
    setQuery,
  } = useMembers(view.project.id, open);
  const pending =
    run?.workflow === "directory_report" &&
    ["queued", "running"].includes(run.state);
  useEffect(() => {
    if (
      run?.workflow === "directory_report" &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已回读成员范围；以下重新显示当前目录。"
          : "读取未完成，请核对执行状态。",
      );
      if (open) void load();
    }
  }, [run?.id, run?.state]);
  return (
    <details
      className="member-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>项目成员与真实身份</summary>
      <section aria-label="项目成员目录">
        <p className="muted">
          来源项目按当前会话成员和已登录的工作区身份精确对应；未关联来源的项目显示当前工作区成员。同名不自动匹配。未加入工作区的来源成员不能分配，不自动建号或授权。
        </p>
        {readError || error ? (
          <p role="alert" className="error">
            {readError || error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        <button
          className="secondary"
          disabled={busy || pending}
          onClick={() => void load()}
        >
          重新读取项目成员
        </button>
        {data ? (
          <>
            <p className="muted">
              核验时间：{new Date(data.checkedAt).toLocaleString()}
            </p>
            <label>
              查找项目成员
              <input
                className="member-search"
                aria-label="查找项目成员"
                maxLength={200}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="姓名、来源 UID 或员工 ID"
              />
            </label>
            <ul className="member-list">
              {data.rows
                .filter((p) =>
                  [p.name, p.sourceUid ?? "", p.id ?? ""].some((v) =>
                    v
                      .toLocaleLowerCase()
                      .includes(query.trim().toLocaleLowerCase()),
                  ),
                )
                .map((p, i) => (
                  <li key={p.sourceUid ?? p.id ?? i}>
                    <strong>{p.name}</strong>
                    <span>
                      {p.sourceUid
                        ? "来源 UID：" + p.sourceUid
                        : "产品员工 ID：" + p.id}
                    </span>
                    <span>
                      {p.state === "available"
                        ? "已对应工作区员工"
                        : "未加入或已失去工作区权限，不可分配"}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        ) : null}
        <Execution
          view={view}
          engine={engine}
          setEngine={setEngine}
          model={model}
          setModel={setModel}
          models={models}
          disabled={busy || pending}
        />
        <button
          disabled={!data || busy || pending}
          onClick={() => {
            setBusy(true);
            setError("");
            void mutation("/runs", {
              conversationId: view.project.conversationId,
              workflow: "directory_report",
              engine,
              ...(engine !== "fixture" && model
                ? { modelProfileId: model }
                : {}),
              instruction:
                "回读我当前项目可访问的成员和精确身份，不创建账号、不授权、不发消息。",
              idempotencyKey: crypto.randomUUID(),
            })
              .then((r) => {
                if (alive.current)
                  onRun({ ...r, engine, workflow: "directory_report" });
              })
              .catch((e) => {
                if (alive.current) {
                  invalidate();
                  setError(e.message);
                }
              })
              .finally(() => {
                if (alive.current) setBusy(false);
              });
          }}
        >
          AI 读取项目成员
        </button>
      </section>
    </details>
  );
}
export function TaskAssignmentPanel({
  view,
  task,
  run,
  onRun,
  onSaved,
  onBusy,
  blocked,
}: {
  view: WorkspaceView;
  task: Task;
  run: any;
  onRun: (v: any) => void;
  onSaved: (reset: boolean) => Promise<void>;
  onBusy: (v: boolean) => void;
  blocked: boolean;
}) {
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState(task.assigneeId ?? ""),
    [confirmed, setConfirmed] = useState(false),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const {
      data,
      error: readError,
      models,
      load,
      alive,
      invalidate,
    } = useMembers(view.project.id, open),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const owns =
      run?.workflow === "assign_task" &&
      run.taskAssignmentPlan?.taskId === task.id,
    pending =
      owns &&
      ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
        run.state,
      );
  const eligible =
      !target ||
      !!data?.rows.some((p) => p.id === target && p.state === "available"),
    disabled = busy || pending || blocked;
  useEffect(() => {
    setTarget(task.assigneeId ?? "");
    setConfirmed(false);
  }, [task.id, task.version]);
  useEffect(() => {
    onBusy(!!(busy || pending));
    return () => onBusy(false);
  }, [busy, pending]);
  useEffect(() => {
    if (
      owns &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded"
          ? "AI 已保存实际员工分配，请读取待办当前版本核对。"
          : "分配未完成，请核对执行状态及已有回执。",
      );
      setConfirmed(false);
      void onSaved(false);
      if (open) void load();
    }
  }, [run?.id, run?.state]);
  async function assign() {
    if (!confirmed || !eligible || disabled) return;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    const plan = {
        taskId: task.id,
        expectedVersion: task.version,
        assigneeId: target || null,
        confirmed: true,
      },
      hash = JSON.stringify({ plan, mode, engine, model });
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const r = await mutation("/runs", {
          conversationId: view.project.conversationId,
          workflow: "assign_task",
          taskAssignmentPlan: plan,
          engine,
          ...(engine !== "fixture" && model ? { modelProfileId: model } : {}),
          instruction:
            "仅按我确认的员工 ID 和待办版本保存分配，不改选人员、不授权、不通知。",
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current)
          onRun({
            ...r,
            engine,
            workflow: "assign_task",
            taskAssignmentPlan: plan,
          });
      } else {
        await mutation("/tasks/" + task.id + "/assignment", {
          plan,
          idempotencyKey: attempt.current!.key,
        });
        if (alive.current) {
          await onSaved(true);
          setNotice("员工分配已保存；未自动发送通知。");
        }
      }
      attempt.current = undefined;
      setConfirmed(false);
    } catch (e) {
      if (alive.current) {
        invalidate();
        setError((e as Error).message);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details
      className="member-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>按真实员工身份分配</summary>
      <section aria-label="待办员工分配">
        <p className="muted">
          文字标记不等于员工身份。请选择当前范围中的确切员工
          ID；分配只修改产品待办，不赋予项目权限或发送通知。
        </p>
        {blocked ? (
          <p className="muted">
            请先保存当前编辑或读取待办当前版本，再进行员工分配。
          </p>
        ) : null}
        {readError || error ? (
          <p role="alert" className="error">
            {readError || error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void load()}
        >
          重新读取可分配员工
        </button>
        <label>
          分配员工
          <select
            aria-label="分配员工"
            disabled={disabled || !data}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">未分配（清除真实员工绑定）</option>
            {task.assigneeId &&
            !data?.rows.some((p) => p.id === task.assigneeId) ? (
              <option value={task.assigneeId} disabled>
                {task.assignee} · 当前不在可分配范围
              </option>
            ) : null}
            {data?.rows.map((p, i) => (
              <option
                key={p.sourceUid ?? p.id ?? i}
                value={p.id ?? "unavailable-" + i}
                disabled={p.state !== "available"}
              >
                {p.name} · {p.sourceUid ?? p.id}
                {p.state === "available" ? "" : " · 无当前工作区身份或权限"}
              </option>
            ))}
          </select>
        </label>
        <label>
          分配方式
          <select
            disabled={disabled}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="direct">直接保存</option>
            <option value="ai">AI 按确认身份保存</option>
          </select>
        </label>
        {mode === "ai" ? (
          <Execution
            view={view}
            engine={engine}
            setEngine={setEngine}
            model={model}
            setModel={setModel}
            models={models}
            disabled={disabled}
          />
        ) : null}
        <label className="confirmation-label">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={disabled || !data || !eligible}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我已核对待办 v{task.version} 和所选员工的唯一身份，确认保存此分配
        </label>
        <button
          disabled={disabled || !confirmed || !data || !eligible}
          onClick={() => void assign()}
        >
          {mode === "ai" ? "AI 保存员工分配" : "保存员工分配"}
        </button>
      </section>
    </details>
  );
}
