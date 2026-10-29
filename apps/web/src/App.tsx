import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, Task, Project, WorkspaceView } from "@hyper/contracts";
import { Plus, ArrowRight, LoaderCircle, X } from "lucide-react";
import { api, mutation, ApiError } from "./api";
import { Navigation, MainHeader, type Section } from "./components/Shell";
import { Discussion } from "./components/Discussion";
import {
  ContextPanel,
  TasksPanel,
  ArtifactsPanel,
} from "./components/WorkPanels";
import { Dialog } from "./components/Dialog";
import { ModelSettings, type ModelSummary } from "./components/ModelSettings";
import { EnterpriseMessages } from "./components/EnterpriseMessages";
import { Login } from "./components/Login";
import { KnowledgePanel } from "./components/KnowledgePanel";
type Tab = "discussion" | "tasks" | "artifacts";
export function App() {
  const [view, setView] = useState<WorkspaceView | null>(null),
    [login, setLogin] = useState(false),
    [status, setStatus] = useState<{
      demoEnabled: boolean;
      nextcloudConfigured: boolean;
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("messages"),
    [tab, setTab] = useState<Tab>("discussion"),
    [query, setQuery] = useState(""),
    [navOpen, setNavOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false);
  const [dialog, setDialog] = useState<
      "run" | "task" | "artifact" | "project" | null
    >(null),
    [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null),
    [title, setTitle] = useState(""),
    [assignee, setAssignee] = useState(""),
    [due, setDue] = useState(""),
    [goal, setGoal] = useState("");
  const [sourceRoom, setSourceRoom] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [initialRoomId, setInitialRoomId] = useState<string>();
  const loadVersion = useRef(0);
  const [instruction, setInstruction] = useState(
      "请把当前讨论整理成纪要，保留明确分工与时间。",
    ),
    [workflow, setWorkflow] = useState("discussion_to_minutes"),
    [engine, setEngine] = useState("dsh"),
    [run, setRun] = useState<any>(null);
  const [runModels, setRunModels] = useState<ModelSummary[]>([]),
    [modelProfileId, setModelProfileId] = useState("");
  const [edit, setEdit] = useState(""),
    [feedback, setFeedback] = useState("");
  const load = useCallback(async (projectId?: string) => {
    const version = ++loadVersion.current;
    const clearPrivateDrafts = () => {
      setDialog(null);
      setSelectedArtifact(null);
      setEdit("");
      setFeedback("");
      setTitle("");
      setGoal("");
      setSourceRoom(null);
      setRun(null);
      setInstruction("请把当前讨论整理成纪要，保留明确分工与时间。");
      setRunModels([]);
      setModelProfileId("");
    };
    try {
      const value = await api<WorkspaceView>(
        "/workspace" + (projectId ? "?projectId=" + projectId : ""),
      );
      if (version !== loadVersion.current) return;
      setView(value);
      setLogin(false);
      setError("");
    } catch (error) {
      if (version !== loadVersion.current) return;
      if (
        projectId &&
        !(error instanceof ApiError && [401, 403].includes(error.status))
      ) {
        clearPrivateDrafts();
        try {
          const fallback = await api<WorkspaceView>("/workspace");
          if (version !== loadVersion.current) return;
          setView(fallback);
          setLogin(false);
          setSection("messages");
          setError("当前项目不可访问或来源暂不可用，已切换到可访问的项目。");
          return;
        } catch {
          if (version !== loadVersion.current) return;
          setView(null);
          setLogin(true);
          setError((error as Error).message);
          return;
        }
      }
      if (version !== loadVersion.current) return;
      if (
        error instanceof ApiError &&
        [401, 403, 404, 503].includes(error.status)
      ) {
        clearPrivateDrafts();
        setView(null);
        setLogin(true);
        setError(error.status === 401 ? "" : error.message);
      } else setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!view?.project.source) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(view.project.id);
    }, 10000);
    return () => clearInterval(timer);
  }, [view?.project.id, view?.project.source?.roomId, load]);
  useEffect(() => {
    void load();
    void api<typeof status>("/auth/status")
      .then(setStatus)
      .catch(() => {});
  }, [load]);
  useEffect(() => {
    if (dialog !== "run") return;
    let alive = true;
    void api<ModelSummary[]>("/models")
      .then((models) => {
        if (alive) {
          const chat = models.filter((model) => model.purpose === "chat");
          setRunModels(chat);
          setModelProfileId((current) =>
            chat.some((model) => model.id === current) ? current : "",
          );
        }
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [dialog, view?.user.id]);
  useEffect(() => {
    if (
      !run ||
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      return;
    let alive = true;
    const timer = setInterval(() => {
      void api("/runs/" + run.id)
        .then((r) => {
          if (alive) {
            setRun(r);
            if (
              [
                "succeeded",
                "failed",
                "cancelled",
                "recovery_required",
              ].includes(r.state)
            )
              void load(view?.project.id);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.state, load, view?.project.id]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    await load(view?.project.id);
  }
  function openTask(t = "") {
    setError("");
    setTitle(t);
    setAssignee("");
    setDue("");
    setDialog("task");
  }
  function openArtifact(a: Artifact) {
    setError("");
    setSelectedArtifact(a);
    setEdit(a.content);
    setFeedback("");
    setDialog("artifact");
  }
  function selectProject(p: Project) {
    setSection("messages");
    setTab("discussion");
    setQuery("");
    setNavOpen(false);
    void load(p.id);
  }
  function navigate(s: Section) {
    setSection(s);
    setQuery("");
    setNavOpen(false);
  }
  if (!view)
    return (
      <Login
        ready={login}
        status={status}
        error={error}
        onAuthenticated={() => load()}
      />
    );
  const projectTitle =
    section === "knowledge"
      ? "知识库"
      : section === "settings"
        ? "设置"
        : section === "enterprise"
          ? "企业消息"
          : view.project.name;
  const selectedRunModel = runModels.find(
    (model) => model.id === modelProfileId,
  );
  const incompatibleRunModel =
    engine !== "fixture" &&
    selectedRunModel &&
    view.engines[engine]?.modelProviders &&
    !view.engines[engine]!.modelProviders!.includes(selectedRunModel.provider);
  return (
    <div
      className={
        "app-shell" + (section === "enterprise" ? " enterprise-view" : "")
      }
    >
      <Navigation
        view={view}
        section={section}
        onSection={navigate}
        onProject={selectProject}
        onRun={() => {
          setError("");
          if (section === "enterprise") setSection("messages");
          setDialog("run");
          setEngine("dsh");
        }}
        onNewProject={() => {
          setError("");
          setTitle("");
          setGoal("");
          setSourceRoom(null);
          setDialog("project");
        }}
        open={navOpen}
        onLogout={() =>
          void act(async () => {
            await mutation("/auth/logout", {});
            window.location.reload();
          })
        }
      />
      <main className="main-pane">
        <MainHeader
          title={projectTitle}
          enterprise={section === "enterprise"}
          subtitle={
            section === "knowledge"
              ? "有来源、可复用的工作资料"
              : section === "settings"
                ? "模型与执行服务"
                : section === "enterprise"
                  ? "查看和回复你有权限访问的会话"
                  : "项目空间"
          }
          query={query}
          onQuery={setQuery}
          onMenu={() => setNavOpen((v) => !v)}
          onContext={() => setContextOpen((v) => !v)}
        />
        {error && !dialog ? (
          <div role="alert" className="error-banner">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <X size={17} />
            </button>
          </div>
        ) : null}
        {view.project.source &&
        section !== "enterprise" &&
        section !== "settings" &&
        section !== "knowledge" ? (
          <div className="project-source-banner">
            <span>
              已关联「{view.project.source.name}
              」，项目访问范围随来源会话成员变化。
              <br />
              <small>
                本页工作记录留在项目，回复会话请使用“查看企业会话”。
              </small>
            </span>
            <button
              onClick={() => {
                setInitialRoomId(view.project.source!.roomId);
                setSection("enterprise");
              }}
            >
              查看企业会话
            </button>
          </div>
        ) : null}
        {run ? (
          <div className={"run-strip " + run.state}>
            <span>
              {run.engine === "fixture" ? "演示执行" : "AI 执行"} ·{" "}
              {(
                {
                  queued: "等待处理",
                  running: "正在推进",
                  succeeded: "已完成",
                  failed: "执行未完成",
                  cancelled: "已停止",
                  recovery_required: "需要核对已执行操作",
                } as any
              )[run.state] ?? run.state}
              {run.error ? "：" + run.error : ""}
            </span>
            {![
              "succeeded",
              "failed",
              "cancelled",
              "recovery_required",
            ].includes(run.state) ? (
              <button
                onClick={() =>
                  void act(async () => {
                    setRun(await mutation("/runs/" + run.id + "/cancel", {}));
                  })
                }
              >
                停止
              </button>
            ) : (
              <button onClick={() => setRun(null)}>收起</button>
            )}
          </div>
        ) : null}
        {section === "messages" || section === "projects" ? (
          <>
            <div className="tabs" role="tablist">
              {(
                [
                  ["discussion", view.project.source ? "工作记录" : "讨论"],
                  ["tasks", "任务"],
                  ["artifacts", "成果"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "discussion" ? (
              <Discussion
                key={view.project.conversationId}
                messages={view.messages}
                artifacts={view.artifacts}
                onArtifact={openArtifact}
                onTask={openTask}
                query={query}
                busy={busy}
                demo={view.user.demo}
                onSend={(text) =>
                  act(async () => {
                    await mutation(
                      "/conversations/" +
                        view.project.conversationId +
                        "/messages",
                      { content: text },
                    );
                    await refresh();
                  })
                }
              />
            ) : tab === "tasks" ? (
              <TasksPanel
                tasks={view.tasks}
                query={query}
                onNew={() => openTask()}
                onToggle={(t) =>
                  void act(async () => {
                    await mutation(
                      "/tasks/" + t.id,
                      { status: t.status === "done" ? "open" : "done" },
                      "PATCH",
                    );
                    await refresh();
                  })
                }
              />
            ) : (
              <ArtifactsPanel
                artifacts={view.artifacts}
                query={query}
                onArtifact={openArtifact}
              />
            )}
          </>
        ) : null}
        {section === "enterprise" ? (
          <EnterpriseMessages
            demo={view.user.demo}
            query={query}
            initialRoomId={initialRoomId}
            onProject={async (room) => {
              const existing = await api<Project | null>(
                "/talk/rooms/" + room.id + "/project",
              );
              if (existing) {
                setSection("messages");
                setTab("discussion");
                setNavOpen(false);
                await load(existing.id);
              } else {
                setSourceRoom({ id: room.id, name: room.name });
                setTitle(room.name);
                setGoal("");
                setError("");
                setDialog("project");
              }
            }}
            onLogout={() =>
              void act(async () => {
                await mutation("/auth/logout", {});
                window.location.reload();
              })
            }
          />
        ) : null}
        {section === "knowledge" ? (
          <KnowledgePanel busy={busy} act={act} />
        ) : null}
        {section === "settings" ? (
          <ModelSettings view={view} busy={busy} act={act} />
        ) : null}
      </main>
      {section !== "enterprise" ? (
        <ContextPanel
          view={view}
          open={contextOpen}
          onTask={openTask}
          onArtifact={openArtifact}
          onToggle={(t) =>
            void act(async () => {
              await mutation(
                "/tasks/" + t.id,
                { status: t.status === "done" ? "open" : "done" },
                "PATCH",
              );
              await refresh();
            })
          }
        />
      ) : null}
      {dialog === "task" ? (
        <Dialog title="新建待办" error={error} onClose={() => setDialog(null)}>
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await mutation(
                  "/conversations/" + view.project.conversationId + "/tasks",
                  {
                    title,
                    assignee: assignee || "待分配",
                    dueDate: due || null,
                  },
                );
                setDialog(null);
                await refresh();
              });
            }}
          >
            <label>
              待办事项
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              负责人
              <input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="待分配"
              />
            </label>
            <label>
              截止日期
              <input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              创建待办
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "project" ? (
        <Dialog
          title={sourceRoom ? "创建关联项目" : "新建项目空间"}
          error={error}
          onClose={() => setDialog(null)}
        >
          {sourceRoom ? (
            <p className="source-scope-note">
              关联「{sourceRoom.name}
              」。只有当前来源会话成员能访问这个新项目，原始消息仍保留在企业会话。
            </p>
          ) : null}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const p = await mutation(
                  sourceRoom ? "/projects/from-talk" : "/projects",
                  {
                    name: title,
                    goal,
                    ...(sourceRoom ? { roomId: sourceRoom.id } : {}),
                  },
                );
                setSourceRoom(null);
                setSection("messages");
                setTab("discussion");
                setDialog(null);
                await load(p.id);
              });
            }}
          >
            <label>
              项目名称
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              当前目标
              <textarea
                required
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              创建项目
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "run" ? (
        <Dialog
          title="让 AI 帮你推进工作"
          error={error}
          onClose={() => setDialog(null)}
        >
          {view.project.source ? (
            <p className="source-scope-note">
              此任务会读取「{view.project.source.name}」当前获准的最近至多 60
              条普通消息，并交给所选模型连接处理。成果保存在当前项目，不会自动发布到企业会话。
            </p>
          ) : null}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setRun(
                  await mutation("/runs", {
                    conversationId: view.project.conversationId,
                    workflow,
                    engine,
                    instruction,
                    ...(engine !== "fixture" && modelProfileId
                      ? { modelProfileId }
                      : {}),
                    idempotencyKey: crypto.randomUUID(),
                    ...(workflow === "revise_artifact" && selectedArtifact
                      ? { artifactId: selectedArtifact.id }
                      : {}),
                  }),
                );
                setDialog(null);
              });
            }}
          >
            <label>
              工作类型
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
              >
                <option value="discussion_to_minutes">讨论 → 纪要</option>
                <option value="project_report">项目周报</option>
                <option value="follow_up">检查待办进展</option>
                {selectedArtifact ? (
                  <option value="revise_artifact">按反馈修改成果</option>
                ) : null}
              </select>
            </label>
            <label>
              工作要求
              <textarea
                required
                autoFocus
                rows={4}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <label>
              执行服务
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
              >
                <option value="dsh">
                  DSH{view.engines.dsh?.configured ? "" : " · 未配置"}
                </option>
                <option value="hermes">
                  Hermes{view.engines.hermes?.configured ? "" : " · 未配置"}
                </option>
                {view.user.demo ? (
                  <option value="fixture">演示流程 · 不调用真实模型</option>
                ) : null}
              </select>
            </label>
            {engine !== "fixture" ? (
              <label>
                模型连接
                <select
                  value={modelProfileId}
                  onChange={(e) => setModelProfileId(e.target.value)}
                >
                  <option value="">自动选择（优先个人连接）</option>
                  {runModels.map((model) => (
                    <option
                      key={model.id}
                      value={model.id}
                      disabled={
                        !!view.engines[engine]?.modelProviders &&
                        !view.engines[engine]!.modelProviders!.includes(
                          model.provider,
                        )
                      }
                    >
                      {model.name} ·{" "}
                      {model.scope === "personal" ? "个人" : "工作区"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="muted small">
              {engine === "fixture"
                ? "验证保存成果与业务回执，不代表模型执行效果。"
                : "使用服务端配置的执行器；未连接时会明确报告。"}
            </p>
            {incompatibleRunModel ? (
              <p role="status" className="muted small">
                请选择与执行服务兼容的模型连接。
              </p>
            ) : null}
            <button
              className="primary"
              disabled={busy || !!incompatibleRunModel}
            >
              {busy ? "正在提交…" : "开始执行"}
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "artifact" && selectedArtifact ? (
        <Dialog
          title={selectedArtifact.title}
          error={error}
          wide
          onClose={() => setDialog(null)}
        >
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await mutation(
                  "/artifacts/" + selectedArtifact.id + "/revisions",
                  {
                    content: edit,
                    feedback,
                    expectedVersion: selectedArtifact.version,
                  },
                );
                setDialog(null);
                await refresh();
              });
            }}
          >
            <div className="artifact-version-label">
              草稿 · v{selectedArtifact.version} · 修改将保留历史版本
            </div>
            <label>
              成果内容
              <textarea
                className="artifact-editor"
                aria-label="成果内容"
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
              />
            </label>
            <label>
              修改说明
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="记录这次修改的原因"
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setError("");
                  setWorkflow("revise_artifact");
                  setInstruction(
                    feedback || "请改进这份成果，保留原有事实与引用。",
                  );
                  setDialog("run");
                }}
              >
                让 AI 按反馈修改
              </button>
              <button className="primary" disabled={busy}>
                保存新版本
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
