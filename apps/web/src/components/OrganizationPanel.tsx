import { useEffect, useRef, useState } from "react";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import type { OrganizationPlan, WorkspaceView } from "@hyper/contracts";
import { api, mutation, ApiError } from "../api";
import { Dialog } from "./Dialog";
import type { ModelSummary } from "./ModelSettings";
type Person = {
  uid: string;
  name: string;
  nameState: string;
  id: string | null;
  role: "admin" | "member" | null;
  roleRevision: number | null;
  membershipId: string | null;
  departmentId: string | null;
};
type Department = { id: string; name: string; parentId: string | null };
type OrganizationView = {
  bindingKey: string;
  revision: number;
  checkedAt: string;
  origin: string;
  canManage: boolean;
  departments: Department[];
  rows: Person[];
  offset: number;
  total: number;
  sourceTotal: number;
  partial: boolean;
  nextOffset: number | null;
  recentChanges: {
    id: string;
    operation: Operation;
    revision: number;
    createdAt: string;
    receipt: Record<string, unknown>;
  }[];
};
function departmentOrder(rows: Department[]) {
  const groups = new Map<string | null, Department[]>();
  for (const row of rows) {
    const group = groups.get(row.parentId) ?? [];
    group.push(row);
    groups.set(row.parentId, group);
  }
  const ordered: { department: Department; depth: number }[] = [],
    seen = new Set<string>();
  function visit(parent: string | null, depth: number) {
    if (depth > 20) return;
    for (const row of groups.get(parent) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ordered.push({ department: row, depth });
      visit(row.id, depth + 1);
    }
  }
  visit(null, 0);
  for (const row of rows)
    if (!seen.has(row.id)) ordered.push({ department: row, depth: 0 });
  return ordered;
}
type Operation = Exclude<OrganizationPlan["operation"], "read">;
const titles: Record<Operation, string> = {
  create_department: "新建部门",
  update_department: "修改部门",
  delete_department: "删除空部门",
  assign_department: "调整员工部门",
  change_role: "调整产品角色",
};
export function OrganizationPanel({
  view,
  run,
  onRun,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (value: any) => void;
}) {
  const [data, setData] = useState<OrganizationView>(),
    [query, setQuery] = useState(""),
    [appliedQuery, setAppliedQuery] = useState(""),
    [filter, setFilter] = useState(""),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [models, setModels] = useState<ModelSummary[]>([]);
  const [dialog, setDialog] = useState<Operation>(),
    [person, setPerson] = useState<Person>(),
    [target, setTarget] = useState<Department>(),
    [name, setName] = useState(""),
    [parent, setParent] = useState(""),
    [role, setRole] = useState("member"),
    [confirmed, setConfirmed] = useState(false),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState("");
  const alive = useRef(false),
    generation = useRef(0),
    readRequest = useRef<AbortController | undefined>(undefined),
    reported = useRef(""),
    attempt = useRef<{ path: string; body: any; ai: boolean } | undefined>(
      undefined,
    ),
    [uncertain, setUncertain] = useState(false);
  const pending =
    run?.workflow === "manage_organization" &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const blocked = busy || pending || uncertain;
  const clear = () => {
    setData(undefined);
    setModels([]);
    setPerson(undefined);
    setTarget(undefined);
    setDialog(undefined);
    setName("");
    setParent("");
    setConfirmed(false);
  };
  async function load(q = appliedQuery, d = filter, o = offset) {
    const g = ++generation.current;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setData(undefined);
    setError("");
    setConfirmed(false);
    try {
      const params = new URLSearchParams({ query: q, offset: String(o) });
      if (d) params.set("departmentId", d);
      const [result, connections] = await Promise.all([
        api<OrganizationView>("/organization?" + params, {
          signal: controller.signal,
        }),
        api<ModelSummary[]>("/models", { signal: controller.signal }),
      ]);
      if (!alive.current || g !== generation.current) return;
      setData(result);
      setAppliedQuery(q);
      setModels(connections.filter((m) => m.purpose === "chat"));
    } catch (e) {
      if (
        !alive.current ||
        g !== generation.current ||
        controller.signal.aborted
      )
        return;
      clear();
      setQuery("");
      setAppliedQuery("");
      setFilter("");
      setOffset(0);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load("", "", 0);
    return () => {
      alive.current = false;
      generation.current++;
      readRequest.current?.abort();
    };
  }, [view.user.id, view.user.workspaceId]);
  useEffect(() => {
    if (
      run?.workflow !== "manage_organization" ||
      !["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      ) ||
      reported.current === run.id + run.state
    )
      return;
    reported.current = run.id + run.state;
    setNotice(
      run.state === "succeeded"
        ? "AI 操作已有实际回执，以下重新核对当前组织。"
        : "AI 操作未完成，请核对执行回执与当前组织状态。",
    );
    setDialog(undefined);
    setConfirmed(false);
    void load();
  }, [run?.id, run?.state]);
  function open(operation: Operation, p?: Person, d?: Department) {
    setDialog(operation);
    setPerson(p);
    setTarget(d);
    setName(d?.name ?? "");
    setParent(
      operation === "assign_department"
        ? (p?.departmentId ?? "")
        : (d?.parentId ?? ""),
    );
    setRole(p?.role === "admin" ? "member" : "admin");
    setConfirmed(false);
    setError("");
    setNotice("");
  }
  function plan(): OrganizationPlan {
    if (!data || !dialog) throw Error("请先读取当前组织。");
    const base = {
      bindingKey: data.bindingKey,
      expectedRevision: data.revision,
      confirmed: true as const,
    };
    switch (dialog) {
      case "create_department":
        return { ...base, operation: dialog, name, parentId: parent || null };
      case "update_department":
        return {
          ...base,
          operation: dialog,
          departmentId: target!.id,
          name,
          parentId: parent || null,
        };
      case "delete_department":
        return { ...base, operation: dialog, departmentId: target!.id };
      case "assign_department":
        return {
          ...base,
          operation: dialog,
          uid: person!.uid,
          departmentId: parent || null,
        };
      case "change_role":
        return {
          ...base,
          operation: dialog,
          userId: person!.id!,
          role: role as "admin" | "member",
          expectedRole: person!.role!,
          expectedRoleRevision: person!.roleRevision!,
          expectedMembershipId: person!.membershipId!,
        };
    }
  }
  async function submit(read = false, retry = false) {
    if (busy || pending || (!read && !retry && !confirmed) || (!retry && !data))
      return;
    if (!retry) {
      const selected = read
        ? {
            operation: "read",
            bindingKey: data!.bindingKey,
            query: {
              query: appliedQuery,
              offset,
              ...(filter ? { departmentId: filter } : {}),
            },
          }
        : plan();
      const ai = read || mode === "ai",
        key = crypto.randomUUID();
      attempt.current = ai
        ? {
            path: "/runs",
            ai,
            body: {
              conversationId: view.project.conversationId,
              workflow: "manage_organization",
              organizationPlan: selected,
              engine,
              ...(engine !== "fixture" && model
                ? { modelProfileId: model }
                : {}),
              instruction:
                "只核对或保存当前明确的组织操作；不改变来源权限，不通知员工。",
              idempotencyKey: key,
            },
          }
        : {
            path: "/organization",
            ai,
            body: { plan: selected, idempotencyKey: key },
          };
    }
    if (!attempt.current) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await mutation(attempt.current.path, attempt.current.body);
      if (!alive.current) return;
      if (attempt.current.ai)
        onRun({
          ...saved,
          workflow: "manage_organization",
          engine: attempt.current.body.engine,
        });
      else {
        setNotice("组织操作已保存，当前状态已重新核对。");
        await load();
      }
      attempt.current = undefined;
      setUncertain(false);
      setDialog(undefined);
      setConfirmed(false);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        attempt.current = undefined;
        setUncertain(false);
        clear();
      } else setUncertain(true);
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const compatible =
    !models.find((m) => m.id === model) ||
    !view.engines[engine]?.modelProviders ||
    view.engines[engine]!.modelProviders!.includes(
      models.find((m) => m.id === model)!.provider,
    );
  function execution() {
    return (
      <div className="settings-form">
        <label>
          组织执行服务
          <select
            value={engine}
            disabled={blocked}
            onChange={(e) => {
              setEngine(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="dsh">DSH</option>
            <option value="hermes">Hermes</option>
            {view.user.demo ? (
              <option value="fixture">演示流程（无模型调用）</option>
            ) : null}
          </select>
        </label>
        <label>
          组织执行模型
          <select
            value={model}
            disabled={blocked}
            onChange={(e) => {
              setModel(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">可用默认对话连接</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {!compatible ? (
          <p role="alert">此连接与所选执行服务不兼容，请更换连接。</p>
        ) : null}
      </div>
    );
  }
  return (
    <section className="organization-panel" aria-label="组织通讯录">
      <div className="organization-heading">
        <div>
          <h3>让协作找到对的人</h3>
          <p className="muted">
            {view.user.demo ? "演示成员数据" : "当前企业成员目录"} ·
            部门归属不改变项目与文件权限
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy || pending}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
          重新读取通讯录
        </button>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {uncertain && !dialog ? (
        <div className="notice">
          <p>
            回执暂未取得。请核对当前状态，或使用原请求核对；暂时不能提交另一项操作。
          </p>
          <button
            disabled={busy || pending}
            onClick={() => void submit(false, true)}
          >
            核对并重试原组织操作
          </button>
        </div>
      ) : null}
      <form
        className="organization-search"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          void load(query, filter, 0);
        }}
      >
        <Search size={18} />
        <input
          aria-label="查找企业联系人"
          placeholder="姓名或来源 UID"
          value={query}
          maxLength={200}
          disabled={blocked}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="secondary" disabled={blocked}>
          查找联系人
        </button>
      </form>
      {data ? (
        <>
          <p className="muted">
            已核验 {data.sourceTotal} 位来源成员 · 当前匹配 {data.total} 位 ·{" "}
            {new Date(data.checkedAt).toLocaleString()}
            <br />
            {data.partial ? "来源搜索只返回有限结果，请缩小关键词。" : null}
          </p>
          <div className="organization-layout">
            <aside aria-label="部门导航">
              <div className="organization-heading">
                <h4>组织部门</h4>
                {data.canManage ? (
                  <button
                    className="icon-button"
                    aria-label="新建部门"
                    disabled={blocked}
                    onClick={() => open("create_department")}
                  >
                    <Plus size={17} />
                  </button>
                ) : null}
              </div>
              <button
                className={
                  filter ? "department-row" : "department-row selected"
                }
                disabled={blocked}
                onClick={() => {
                  setFilter("");
                  setOffset(0);
                  void load(query, "", 0);
                }}
              >
                <Building2 size={16} />
                全部成员
              </button>
              {departmentOrder(data.departments).map(
                ({ department: d, depth }) => {
                  return (
                    <div className="department-item" key={d.id}>
                      <button
                        className={
                          filter === d.id
                            ? "department-row selected"
                            : "department-row"
                        }
                        style={{
                          paddingInlineStart: 12 + Math.min(depth, 5) * 12,
                        }}
                        disabled={blocked}
                        onClick={() => {
                          setFilter(d.id);
                          setOffset(0);
                          void load(query, d.id, 0);
                        }}
                      >
                        {d.name}
                      </button>
                      {data.canManage ? (
                        <button
                          className="icon-button"
                          aria-label={"管理部门 " + d.name}
                          disabled={blocked}
                          onClick={() =>
                            open("update_department", undefined, d)
                          }
                        >
                          ···
                        </button>
                      ) : null}
                    </div>
                  );
                },
              )}
              {!data.departments.length ? (
                <p className="muted">尚未建立产品部门。</p>
              ) : null}
            </aside>
            <div>
              <ul className="organization-people">
                {data.rows.map((p) => (
                  <li key={p.uid}>
                    <div className="contact-avatar">
                      <UserRound size={22} />
                    </div>
                    <div className="contact-detail">
                      <strong>{p.name}</strong>
                      <span>
                        {p.nameState === "uid-only" ? "来源未公开姓名 · " : ""}
                        {p.uid}
                      </span>
                      <span>
                        {data.departments.find((d) => d.id === p.departmentId)
                          ?.name ?? "未分配部门"}{" "}
                        ·{" "}
                        {p.id
                          ? p.role === "admin"
                            ? "产品管理员"
                            : "已验证员工"
                          : "尚未登录产品"}
                      </span>
                    </div>
                    {data.canManage ? (
                      <div className="contact-actions">
                        <button
                          className="secondary"
                          disabled={blocked}
                          onClick={() => open("assign_department", p)}
                        >
                          调整部门
                        </button>
                        {p.id && p.id !== view.user.id ? (
                          <button
                            className="secondary"
                            disabled={blocked}
                            onClick={() => open("change_role", p)}
                          >
                            产品角色
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!data.rows.length ? (
                <div className="empty-state">当前范围没有匹配联系人。</div>
              ) : null}
              <div className="organization-pagination">
                <button
                  className="secondary"
                  disabled={blocked || !offset}
                  onClick={() => {
                    const next = Math.max(0, offset - 30);
                    setOffset(next);
                    void load(appliedQuery, filter, next);
                  }}
                >
                  <ChevronLeft size={16} />
                  上一页
                </button>
                <span>第 {Math.floor(data.offset / 30) + 1} 页</span>
                <button
                  className="secondary"
                  disabled={blocked || data.nextOffset === null}
                  onClick={() => {
                    const next = data.nextOffset!;
                    setOffset(next);
                    void load(appliedQuery, filter, next);
                  }}
                >
                  下一页
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
          {data.recentChanges.length ? (
            <details className="member-panel">
              <summary>我的组织操作回执</summary>
              <p className="muted">
                最近 20 项已提交的操作；可在刷新后核对实际组织版本。
              </p>
              <ul className="member-list">
                {data.recentChanges.map((change) => (
                  <li key={change.id}>
                    <strong>
                      {titles[change.operation]} · 组织版本 {change.revision}
                    </strong>
                    <span>{new Date(change.createdAt).toLocaleString()}</span>
                    <details>
                      <summary>查看对象引用与回执</summary>
                      <pre className="organization-receipt">
                        {JSON.stringify(change.receipt, null, 2)}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <details className="member-panel">
            <summary>AI 读取当前组织范围</summary>
            <p className="muted">
              AI
              触发同一实时查询，回执只记录范围和数量，姓名列表在此页按当前权限重新读取。
            </p>
            {execution()}
            <button
              disabled={blocked || !compatible}
              onClick={() => void submit(true)}
            >
              AI 读取当前通讯录
            </button>
          </details>
        </>
      ) : !error ? (
        <p role="status">正在核验当前通讯录…</p>
      ) : null}
      {dialog && data ? (
        <Dialog
          title={titles[dialog]}
          dismissible={!busy && !uncertain}
          onClose={() => {
            setDialog(undefined);
            setConfirmed(false);
          }}
          error={error}
        >
          <div className="settings-form">
            {uncertain ? (
              <button
                disabled={busy || pending}
                onClick={() => void submit(false, true)}
              >
                核对并重试原组织操作
              </button>
            ) : null}
            <p className="muted">
              仅保存 Hyper Workspace 的组织信息；当前组织版本 {data.revision}。
              {person ? (
                <>
                  <br />
                  {person.name} · {person.uid}
                  <br />
                  {person.id ? "产品 ID：" + person.id : "尚无已验证产品身份"}
                </>
              ) : null}
            </p>
            {dialog === "create_department" ||
            dialog === "update_department" ? (
              <label>
                部门名称
                <input
                  aria-label="部门名称"
                  value={name}
                  maxLength={100}
                  disabled={blocked}
                  onChange={(e) => {
                    setName(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
            ) : null}
            {dialog === "create_department" ||
            dialog === "update_department" ||
            dialog === "assign_department" ? (
              <label>
                {dialog === "assign_department" ? "员工所属部门" : "上级部门"}
                <select
                  aria-label={
                    dialog === "assign_department" ? "员工所属部门" : "上级部门"
                  }
                  value={parent}
                  disabled={blocked}
                  onChange={(e) => {
                    setParent(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">
                    {dialog === "assign_department" ? "未分配部门" : "顶级部门"}
                  </option>
                  {data.departments
                    .filter((d) => d.id !== target?.id)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.id.slice(0, 8)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {dialog === "change_role" ? (
              <>
                <label>
                  产品角色
                  <select
                    aria-label="产品角色"
                    value={role}
                    disabled={blocked}
                    onChange={(e) => {
                      setRole(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <p>
                  管理员可修改共享规则和组织信息；不会获得 Nextcloud
                  管理员身份或额外来源权限。
                </p>
              </>
            ) : null}
            {dialog === "delete_department" ? (
              <p>
                删除部门“{target?.name}”。服务端会拒绝仍有子部门或成员的部门。
              </p>
            ) : null}
            <label>
              保存方式
              <select
                aria-label="组织保存方式"
                value={mode}
                disabled={blocked}
                onChange={(e) => {
                  setMode(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="direct">直接保存</option>
                <option value="ai">AI 按确认操作保存</option>
              </select>
            </label>
            {mode === "ai" ? execution() : null}
            <label className="confirmation-label">
              <input
                type="checkbox"
                disabled={blocked}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对当前组织版本、部门和员工唯一身份，确认此项操作
            </label>
            <button
              className="primary"
              disabled={
                blocked ||
                !confirmed ||
                (mode === "ai" && !compatible) ||
                (["create_department", "update_department"].includes(dialog) &&
                  !name.trim())
              }
              onClick={() => void submit()}
            >
              {mode === "ai" ? "AI 保存组织操作" : "保存组织操作"}
            </button>
            {dialog === "update_department" ? (
              <button
                className="danger"
                disabled={blocked}
                onClick={() => {
                  setDialog("delete_department");
                  setConfirmed(false);
                }}
              >
                删除此空部门
              </button>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
