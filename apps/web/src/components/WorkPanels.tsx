import {
  FileText,
  ChevronRight,
  Target,
  SquareCheck,
  Plus,
  Check,
} from "lucide-react";
import type { Artifact, Task, WorkspaceView } from "@hyper/contracts";
export function ContextPanel({
  view,
  onTask,
  onToggle,
  onArtifact,
  open,
}: {
  view: WorkspaceView;
  onTask: (t?: string) => void;
  onToggle: (t: Task) => void;
  onArtifact: (a: Artifact) => void;
  open: boolean;
}) {
  return (
    <aside className={"context-panel " + (open ? "context-open" : "")}>
      <h2>项目上下文</h2>
      <section>
        <h3>
          <Target size={22} />
          当前目标
        </h3>
        <p className="goal-box">{view.project.goal}</p>
      </section>
      <section>
        <div className="context-section-title">
          <h3>
            <SquareCheck size={22} />
            待办
          </h3>
          <button
            className="icon-button"
            aria-label="添加待办"
            onClick={() => onTask()}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="context-tasks">
          {view.tasks.slice(0, 5).map((t) => (
            <button
              key={t.id}
              className={
                "task-check-row " + (t.status === "done" ? "is-done" : "")
              }
              onClick={() => onToggle(t)}
            >
              <span className="checkbox">
                {t.status === "done" ? <Check size={13} /> : null}
              </span>
              <span>{t.title}</span>
            </button>
          ))}
          {!view.tasks.length ? (
            <p className="muted small">还没有待办</p>
          ) : null}
        </div>
      </section>
      <section>
        <h3>
          <FileText size={22} />
          最新成果
        </h3>
        {view.artifacts.slice(0, 3).map((a) => (
          <button
            className="artifact-row"
            key={a.id}
            onClick={() => onArtifact(a)}
          >
            <FileText size={27} />
            <span>
              <strong>{a.title}</strong>
              <small>草稿 · v{a.version}</small>
            </span>
            <ChevronRight size={18} />
          </button>
        ))}
        {!view.artifacts.length ? (
          <p className="muted small">成果将在这里沉淀</p>
        ) : null}
      </section>
    </aside>
  );
}
export function TasksPanel({
  tasks,
  onNew,
  onToggle,
  query,
}: {
  tasks: Task[];
  onNew: () => void;
  onToggle: (t: Task) => void;
  query: string;
}) {
  const rows = tasks.filter((t) => t.title.includes(query));
  return (
    <div className="work-panel">
      <div className="panel-heading">
        <div>
          <h3>一起把事情推进</h3>
          <p>明确分工，保留每一步实际进展。</p>
        </div>
        <button className="primary" onClick={onNew}>
          <Plus size={17} />
          新建待办
        </button>
      </div>
      <div className="task-table">
        <div className="task-table-head">
          <span>待办事项</span>
          <span>负责人</span>
          <span>截止日期</span>
        </div>
        {rows.map((t) => (
          <div className="task-table-row" key={t.id}>
            <button
              className={
                "task-check-row " + (t.status === "done" ? "is-done" : "")
              }
              onClick={() => onToggle(t)}
            >
              <span className="checkbox">
                {t.status === "done" ? <Check size={13} /> : null}
              </span>
              {t.title}
            </button>
            <span>{t.assignee}</span>
            <span>{t.dueDate ?? "未设置"}</span>
          </div>
        ))}
        {!rows.length ? (
          <div className="empty-state">没有待办事项。</div>
        ) : null}
      </div>
    </div>
  );
}
export function ArtifactsPanel({
  artifacts,
  onArtifact,
  query,
}: {
  artifacts: Artifact[];
  onArtifact: (a: Artifact) => void;
  query: string;
}) {
  return (
    <div className="work-panel">
      <div className="panel-heading">
        <div>
          <h3>每一次交付，都能继续完善</h3>
          <p>查看成果、保留版本，根据反馈持续修改。</p>
        </div>
      </div>
      <div className="artifact-list">
        {artifacts
          .filter((a) => a.title.includes(query))
          .map((a) => (
            <button
              className="artifact-list-row"
              key={a.id}
              onClick={() => onArtifact(a)}
            >
              <FileText size={29} />
              <span>
                <strong>{a.title}</strong>
                <small>草稿 · v{a.version}</small>
              </span>
              <ChevronRight size={20} />
            </button>
          ))}
      </div>
      {!artifacts.length ? (
        <div className="empty-state">从讨论开始，生成第一份成果。</div>
      ) : null}
    </div>
  );
}
