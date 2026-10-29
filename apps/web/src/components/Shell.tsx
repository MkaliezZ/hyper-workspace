import {
  MessageSquare,
  MessagesSquare,
  Folder,
  FileText,
  Settings,
  Plus,
  Search,
  PanelRight,
  Menu,
} from "lucide-react";
import type { Project, WorkspaceView } from "@hyper/contracts";
export type Section =
  | "messages"
  | "projects"
  | "knowledge"
  | "settings"
  | "enterprise";
const navigation = [
  { id: "messages", label: "消息", Icon: MessageSquare },
  { id: "enterprise", label: "企业消息", Icon: MessagesSquare },
  { id: "projects", label: "项目", Icon: Folder },
  { id: "knowledge", label: "知识库", Icon: FileText },
  { id: "settings", label: "设置", Icon: Settings },
] as const;
export function Navigation({
  view,
  section,
  onSection,
  onProject,
  onRun,
  onNewProject,
  onLogout,
  open,
}: {
  view: WorkspaceView;
  section: Section;
  onSection: (s: Section) => void;
  onProject: (p: Project) => void;
  onRun: () => void;
  onNewProject: () => void;
  onLogout: () => void;
  open: boolean;
}) {
  return (
    <>
      <aside className="app-rail" aria-label="应用导航">
        <div className="brand-mark" aria-label="Hyper Workspace">
          H
        </div>
        <div className="rail-actions">
          {navigation.map(({ id, label, Icon }) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              onClick={() => onSection(id)}
              className={section === id ? "active" : ""}
            >
              <Icon size={22} />
            </button>
          ))}
        </div>
        <button
          className="user-initial"
          title={view.user.name + " · 退出登录"}
          aria-label="退出登录"
          onClick={onLogout}
        >
          {view.user.name.slice(0, 1)}
        </button>
      </aside>
      <aside className={"sidebar " + (open ? "mobile-open" : "")}>
        <header className="workspace-brand">
          <h1>
            Hyper
            <br />
            Workspace
          </h1>
          <span>
            {view.user.demo ? "演示工作区" : "团队工作区"}
            <span className="subtle-chevron">⌄</span>
          </span>
        </header>
        <button className="primary new-run" onClick={onRun}>
          <Plus size={19} />
          发起任务
        </button>
        <nav aria-label="工作区导航">
          {navigation.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onSection(id)}
              className={"nav-item " + (section === id ? "selected" : "")}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="section-label">
          <span>项目空间</span>
          <button
            className="icon-button"
            aria-label="新建项目"
            onClick={onNewProject}
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="project-list">
          {view.projects.map((p) => (
            <button
              key={p.id}
              className={
                "nav-item " + (p.id === view.project.id ? "selected" : "")
              }
              onClick={() => onProject(p)}
            >
              <Folder size={20} />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
export function MainHeader({
  title,
  subtitle,
  query,
  onQuery,
  onMenu,
  onContext,
  enterprise = false,
}: {
  title: string;
  subtitle: string;
  query: string;
  onQuery: (v: string) => void;
  onMenu: () => void;
  onContext: () => void;
  enterprise?: boolean;
}) {
  return (
    <header className="main-header">
      <button
        className="icon-button mobile-menu"
        aria-label="展开导航"
        onClick={onMenu}
      >
        <Menu size={22} />
      </button>
      <div className="heading">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <label className="search-box">
        <Search size={18} />
        <input
          aria-label={enterprise ? "搜索当前页企业消息" : "搜索当前项目"}
          placeholder={enterprise ? "搜索当前页消息…" : "搜索讨论、任务或文件…"}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <button
        className="icon-button context-toggle"
        aria-label="项目上下文"
        onClick={onContext}
      >
        <PanelRight size={21} />
      </button>
    </header>
  );
}
