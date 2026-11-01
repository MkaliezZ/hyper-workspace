import { useEffect, useRef, useState } from "react";
import type { CommunicationMessage, WorkspaceView } from "@hyper/contracts";
import type { RoomManagementPlan } from "@hyper/contracts/room-management";
import { api, mutation, ApiError } from "../api";
import { Dialog } from "./Dialog";
import type { ModelSummary } from "./ModelSettings";

type Room = {
  id: string;
  name: string;
  displayName: string;
  type: number;
  participantType: number;
  objectType: string | null;
  hasCall: boolean | null;
  breakoutRoomMode: number | null;
  canDelete: boolean | null;
  canLeave: boolean | null;
  favorite: boolean | null;
  notificationLevel: number | null;
  unreadMessages: number | null;
  unreadMention: boolean | null;
  lastReadMessage: string | null;
  expected: Record<string, string>;
};
type Person = {
  uid: string;
  name: string;
  attendeeId: number;
  participantType: number;
};
type Data = {
  bindingRef: string;
  actorUid: string;
  checkedAt: string;
  features: string[];
  rooms: Room[];
  participants: { rows: Person[]; unsupported: number } | null;
};
type Command = {
  id: string;
  operation: string;
  state: string;
  roomId: string | null;
  scopeAvailable: boolean;
  completedSteps: number;
  totalSteps: number;
  acknowledgedAt: string | null;
  sourceRoomDisposition?: "created" | "existing" | null;
  steps: { sequence: number; operation: string; state: string }[];
};
const labels: Record<RoomManagementPlan["operation"], string> = {
  read: "AI 查询当前会话",
  create_direct: "新建单聊",
  create_group: "新建私群",
  notify: "修改消息通知",
  favorite: "修改收藏",
  mark_read: "标记到所选消息已读",
  mark_unread: "标为未读",
  rename: "修改群名",
  add_member: "邀请群成员",
  remove_member: "移除群成员",
  moderator: "调整群管理员",
  leave: "退出会话",
  delete: "删除私群",
};
const levels = ["来源默认", "所有消息", "仅提及我", "不通知"];
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
]);
export function RoomManagementDialog({
  view,
  roomId,
  messages,
  onClose,
  onChanged,
}: {
  view: WorkspaceView;
  roomId?: string;
  messages: CommunicationMessage[];
  onClose: () => void;
  onChanged: (roomId?: string) => void;
}) {
  const [data, setData] = useState<Data>(),
    [commands, setCommands] = useState<Command[]>([]),
    [models, setModels] = useState<ModelSummary[]>([]),
    [project, setProject] = useState<{ name: string } | null>(null);
  const [operation, setOperation] = useState<RoomManagementPlan["operation"]>(
      roomId ? "notify" : "create_group",
    ),
    [name, setName] = useState(""),
    [level, setLevel] = useState(2),
    [enabled, setEnabled] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [member, setMember] = useState(""),
    [messageId, setMessageId] = useState("");
  const [query, setQuery] = useState(""),
    [contacts, setContacts] = useState<{ uid: string; name: string }[]>([]),
    [partial, setPartial] = useState(false),
    [mode, setMode] = useState("direct"),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState("");
  const [busy, setBusy] = useState(false),
    [manualInFlight, setManualInFlight] = useState(false),
    [controlBusy, setControlBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [run, setRun] = useState<any>();
  const alive = useRef(false),
    generation = useRef(0),
    attempt = useRef<{ path: string; body: any; ai: boolean } | undefined>(
      undefined,
    ),
    reader = useRef<AbortController | undefined>(undefined);
  const pending = !!run && !terminal.has(run.state),
    frozen = busy || controlBusy || pending || uncertain;
  const room = data?.rooms.find((r) => r.id === roomId),
    people = data?.participants?.rows ?? [],
    chosen = people.find((p) => p.uid === member);
  function clearPrivate() {
    generation.current++;
    reader.current?.abort();
    setData(undefined);
    setContacts([]);
    setCommands([]);
    setModels([]);
    setProject(null);
    setSelected([]);
    setMember("");
    setConfirmed(false);
  }
  async function load() {
    const g = ++generation.current;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    try {
      const [d, history, connections, linked] = await Promise.all([
        api<Data>("/talk/management" + (roomId ? "?roomId=" + roomId : ""), {
          signal: controller.signal,
        }),
        api<Command[]>("/talk/management/commands", {
          signal: controller.signal,
        }),
        api<ModelSummary[]>("/models", { signal: controller.signal }),
        roomId
          ? api<{ project: { name: string } | null }>(
              "/talk/rooms/" + roomId + "/project",
              { signal: controller.signal },
            )
          : Promise.resolve({ project: null }),
      ]);
      if (!alive.current || g !== generation.current) return;
      setData(d);
      setCommands(history);
      setModels(connections.filter((m) => m.purpose === "chat"));
      setProject(linked.project);
      setError("");
    } catch (e) {
      if (
        !alive.current ||
        g !== generation.current ||
        controller.signal.aborted
      )
        return;
      clearPrivate();
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
      reader.current?.abort();
    };
  }, [roomId]);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api("/runs/" + run.id);
        if (!live || !alive.current) return;
        setRun(value);
        setError("");
        if (terminal.has(value.state)) {
          setNotice(
            value.state === "succeeded"
              ? "AI 操作已有实际回执，请核对当前来源状态。"
              : "AI 已停止，请核对实际回执；取消不会回滚已派发操作。",
          );
          await load();
          onChanged(value.result?.receipts?.[0]?.roomId ?? undefined);
          return;
        }
      } catch (e) {
        if (!live || !alive.current) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          clearPrivate();
          setRun(undefined);
        }
        setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [run?.id, pending]);
  useEffect(() => {
    if (!manualInFlight) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    const poll = async () => {
      try {
        const history = await api<Command[]>("/talk/management/commands");
        if (!live || !alive.current || epoch !== generation.current) return;
        setCommands(history);
      } catch (e) {
        if (!live || !alive.current || epoch !== generation.current) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          clearPrivate();
        setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [manualInFlight]);
  async function search() {
    setBusy(true);
    setError("");
    const g = generation.current;
    try {
      const result = await api(
        "/organization?query=" + encodeURIComponent(query),
      );
      if (!alive.current || g !== generation.current) return;
      setContacts(result.rows.filter((p: any) => p.uid !== data?.actorUid));
      setPartial(result.partial || result.nextOffset !== null);
    } catch (e) {
      if (!alive.current) return;
      setContacts([]);
      if (e instanceof ApiError && [401, 403].includes(e.status))
        clearPrivate();
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function plan(): RoomManagementPlan {
    if (!data) throw Error("请先读取当前通信范围。");
    const bindingRef = data.bindingRef;
    if (operation === "read")
      return { operation, bindingRef, ...(roomId ? { roomId } : {}) };
    if (operation === "create_direct")
      return { operation, bindingRef, uid: selected[0] ?? "", confirmed: true };
    if (operation === "create_group")
      return { operation, bindingRef, name, uids: selected, confirmed: true };
    if (!room) throw Error("请先选择当前可访问会话。");
    const expected = room.expected[operation];
    if (!expected) throw Error("来源未提供此操作的当前确认版本，请重新读取。");
    const target = {
      bindingRef,
      roomId: room.id,
      expected,
      confirmed: true as const,
    };
    switch (operation) {
      case "notify":
        return { ...target, operation, level };
      case "favorite":
        return { ...target, operation, enabled };
      case "mark_read":
        return { ...target, operation, messageId };
      case "mark_unread":
        return { ...target, operation };
      case "rename":
        return { ...target, operation, name };
      case "add_member":
        return { ...target, operation, uid: selected[0] ?? "" };
      case "remove_member":
        if (!chosen) throw Error("请按 UID 选择当前成员。");
        return {
          ...target,
          operation,
          uid: chosen.uid,
          attendeeId: chosen.attendeeId,
        };
      case "moderator":
        if (!chosen) throw Error("请按 UID 选择当前成员。");
        return {
          ...target,
          operation,
          uid: chosen.uid,
          attendeeId: chosen.attendeeId,
          enabled,
        };
      case "leave":
      case "delete":
        return { ...target, operation };
    }
  }
  async function submit(retry = false) {
    if (busy || pending || (!retry && !confirmed && operation !== "read"))
      return;
    if (!retry) {
      try {
        const selectedPlan = plan(),
          ai = mode === "ai" || operation === "read";
        attempt.current = {
          path: ai ? "/talk/management/runs" : "/talk/management/commands",
          ai,
          body: {
            plan: selectedPlan,
            idempotencyKey: crypto.randomUUID(),
            ...(ai
              ? { engine, ...(model ? { modelProfileId: model } : {}) }
              : {}),
          },
        };
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    if (!attempt.current) return;
    setBusy(true);
    setManualInFlight(!attempt.current.ai);
    setError("");
    setNotice("");
    try {
      const result = await mutation(attempt.current.path, attempt.current.body);
      if (!alive.current) return;
      if (attempt.current.ai) setRun(result);
      else {
        setNotice(
          result.state === "succeeded"
            ? result.sourceRoomDisposition === "existing"
              ? "已打开来源已有单聊，未重复创建。"
              : "操作已有来源确认与回读。"
            : "操作未全部确认，请查看实际步骤，未自动重发。",
        );
        await load();
        onChanged(result.roomId ?? undefined);
      }
      attempt.current = undefined;
      setUncertain(false);
      setConfirmed(false);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        attempt.current = undefined;
        setUncertain(false);
        if ([401, 403, 404].includes(e.status)) clearPrivate();
      } else setUncertain(true);
      setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setManualInFlight(false);
      }
    }
  }
  async function control(command: Command, action: string) {
    setControlBusy(true);
    setError("");
    try {
      await mutation(
        "/talk/management/commands/" + command.id + "/" + action,
        action === "acknowledge" ? { confirmed: true } : {},
      );
      await load();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        clearPrivate();
      setError((e as Error).message);
    } finally {
      if (alive.current) setControlBusy(false);
    }
  }
  const group =
      room?.type === 2 &&
      room.objectType === "" &&
      room.breakoutRoomMode === 0 &&
      !data?.participants?.unsupported &&
      [1, 2].includes(room.participantType),
    invite = ["create_group", "create_direct", "add_member"].includes(
      operation,
    ),
    memberOperation = ["remove_member", "moderator"].includes(operation);
  const compatible =
    !model ||
    !view.engines[engine]?.modelProviders ||
    view.engines[engine].modelProviders!.includes(
      models.find((m) => m.id === model)?.provider ?? "",
    );
  const ready =
    !!data &&
    compatible &&
    (operation === "read" || confirmed) &&
    (!invite || selected.length > 0) &&
    (operation !== "create_direct" || selected.length === 1) &&
    (operation !== "add_member" || selected.length === 1) &&
    (!["rename", "create_group"].includes(operation) || !!name.trim()) &&
    (!memberOperation || !!chosen) &&
    (operation !== "mark_read" || !!messageId);
  return (
    <Dialog
      title="会话与通知管理"
      wide
      error={error}
      dismissible={!frozen}
      onClose={onClose}
    >
      <div className="room-management">
        <p className="source-scope-note">
          {room ? "当前会话：" + room.displayName : "可创建单聊或私群。"}{" "}
          读取页面不会自动标记消息已读。通知设置保存在企业通信来源，手机实际提醒取决于来源客户端与设备设置。
        </p>
        {notice ? <p role="status">{notice}</p> : null}
        {data ? (
          <p>
            未读 {room?.unreadMessages ?? "未知"} · 提及{" "}
            {room?.unreadMention === null || room?.unreadMention === undefined
              ? "未知"
              : room.unreadMention
                ? "有"
                : "无"}{" "}
            · 已读位置 {room?.lastReadMessage ?? "未知"}
          </p>
        ) : (
          <p>通信范围未就绪。请重新读取当前来源。</p>
        )}
        <div className="room-management-fields">
          <label>
            通信操作
            <select
              value={operation}
              disabled={frozen}
              onChange={(e) => {
                setOperation(e.target.value as any);
                setConfirmed(false);
                setSelected([]);
                setMember("");
                setName("");
                setError("");
              }}
            >
              {Object.entries(labels)
                .filter(
                  ([op]) =>
                    ["read", "create_direct", "create_group"].includes(op) ||
                    !!room,
                )
                .map(([op, label]) => (
                  <option
                    key={op}
                    value={op}
                    disabled={
                      ([
                        "rename",
                        "add_member",
                        "remove_member",
                        "moderator",
                        "delete",
                      ].includes(op) &&
                        !group) ||
                      (op === "delete" &&
                        (room?.canDelete !== true ||
                          room.hasCall !== false ||
                          room.breakoutRoomMode !== 0)) ||
                      (op === "leave" && room?.canLeave !== true) ||
                      (op === "notify" &&
                        !data?.features.includes("notification-levels")) ||
                      (op === "favorite" &&
                        !data?.features.includes("favorites")) ||
                      (op === "mark_read" &&
                        !data?.features.includes("chat-read-marker")) ||
                      (op === "mark_unread" &&
                        !data?.features.includes("chat-unread"))
                    }
                  >
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {operation === "notify" ? (
            <label>
              消息通知
              <select
                aria-label="消息通知"
                disabled={frozen}
                value={level}
                onChange={(e) => {
                  setLevel(Number(e.target.value));
                  setConfirmed(false);
                }}
              >
                {levels.map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </select>
              <small>
                当前：
                {room?.notificationLevel === null
                  ? "未知"
                  : levels[room?.notificationLevel ?? 0]}
              </small>
            </label>
          ) : null}
          {["favorite", "moderator"].includes(operation) ? (
            <label>
              {operation === "favorite" ? "收藏状态" : "群管理员身份"}
              <select
                value={String(enabled)}
                disabled={frozen}
                onChange={(e) => {
                  setEnabled(e.target.value === "true");
                  setConfirmed(false);
                }}
              >
                <option value="true">
                  {operation === "favorite" ? "收藏" : "设为群管理员"}
                </option>
                <option value="false">
                  {operation === "favorite" ? "取消收藏" : "恢复普通成员"}
                </option>
              </select>
            </label>
          ) : null}
          {["rename", "create_group"].includes(operation) ? (
            <label>
              群名称
              <input
                maxLength={255}
                value={name}
                disabled={frozen}
                onChange={(e) => {
                  setName(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
          ) : null}
          {operation === "mark_read" ? (
            <label>
              标记到哪条消息
              <select
                value={messageId}
                disabled={frozen}
                onChange={(e) => {
                  setMessageId(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">明确选择已查看的消息位置</option>
                {messages
                  .filter(
                    (m) => !m.expiresAt || Date.parse(m.expiresAt) > Date.now(),
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.author} · {m.content.slice(0, 45)}
                    </option>
                  ))}
              </select>
              <small>
                仅提交所选消息 ID；并发来源客户端不提供原子版本比较。
              </small>
            </label>
          ) : null}
          {memberOperation ? (
            <label>
              当前群成员
              <select
                value={member}
                disabled={frozen}
                onChange={(e) => {
                  setMember(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">按身份选择</option>
                {people
                  .filter(
                    (p) => p.uid !== data?.actorUid && p.participantType !== 1,
                  )
                  .map((p) => (
                    <option
                      key={p.uid}
                      value={p.uid}
                      disabled={
                        operation === "remove_member" && p.participantType !== 3
                      }
                    >
                      {p.name} · UID {p.uid} ·{" "}
                      {p.participantType === 2 ? "管理员" : "成员"}
                    </option>
                  ))}
              </select>
              {chosen ? (
                <small>
                  成员实例 {chosen.attendeeId}
                  ；群管理员为来源角色，与产品管理员分开。
                </small>
              ) : null}
            </label>
          ) : null}
        </div>
        {invite ? (
          <fieldset disabled={frozen}>
            <legend>按企业 UID 明确选择员工（最多 20 人）</legend>
            <div className="room-management-search">
              <input
                aria-label="查找邀请联系人"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={200}
              />
              <button onClick={() => void search()}>查找员工</button>
            </div>
            {partial ? (
              <p>当前仅显示有限结果，请输入更精确的姓名或 UID。</p>
            ) : null}
            <div className="room-management-contacts">
              {contacts.map((p) => (
                <label key={p.uid}>
                  <input
                    type="checkbox"
                    checked={selected.includes(p.uid)}
                    disabled={
                      !selected.includes(p.uid) &&
                      ((operation !== "create_group" && selected.length >= 1) ||
                        selected.length >= 20)
                    }
                    onChange={(e) => {
                      setSelected((v) =>
                        e.target.checked
                          ? [...v, p.uid]
                          : v.filter((uid) => uid !== p.uid),
                      );
                      setConfirmed(false);
                    }}
                  />
                  {p.name} · UID {p.uid}
                </label>
              ))}
            </div>
            <p>已选 UID：{selected.join("、") || "尚未选择"}</p>
          </fieldset>
        ) : null}
        {["add_member", "remove_member", "leave", "delete"].includes(
          operation,
        ) ? (
          <p className="source-scope-note">
            {project
              ? "关联项目「" + project.name + "」的访问范围会随群成员变化。"
              : "当前未关联项目；群成员决定当前及以后关联项目的来源访问范围。"}{" "}
            移除或退出不撤回员工已下载的数据；删除私群可能删除来源讨论。
          </p>
        ) : null}
        {data?.participants?.unsupported ? (
          <p>
            包含不支持的成员类型，本页管理操作将由服务端拒绝；请到来源客户端处理。
          </p>
        ) : null}
        <div className="room-management-fields">
          <label>
            通信执行方式
            <select
              value={mode}
              disabled={frozen || operation === "read"}
              onChange={(e) => {
                setMode(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="direct">人工直接执行</option>
              <option value="ai">AI 执行</option>
            </select>
          </label>
          {mode === "ai" || operation === "read" ? (
            <>
              <label>
                通信执行服务
                <select
                  value={engine}
                  disabled={frozen}
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
                通信执行模型
                <select
                  value={model}
                  disabled={frozen}
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
            </>
          ) : null}
        </div>
        {operation !== "read" ? (
          <label className="room-management-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={frozen || !data}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我确认所选会话、UID、设置和访问范围变化；由服务端核对后执行。
          </label>
        ) : null}
        <div className="dialog-actions">
          <button
            disabled={frozen}
            onClick={() => {
              setConfirmed(false);
              void load();
            }}
          >
            重新读取来源
          </button>
          <button
            className="primary"
            disabled={
              frozen ||
              !ready ||
              ((mode === "ai" || operation === "read") &&
                !view.engines[engine]?.configured)
            }
            onClick={() => void submit()}
          >
            {operation === "read"
              ? "AI 查询会话"
              : mode === "ai"
                ? "AI 执行通信操作"
                : "执行通信操作"}
          </button>
          {uncertain ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              使用原请求核对回执
            </button>
          ) : null}
        </div>
        {uncertain ? (
          <p role="status">
            未取得完整回执，当前选择已冻结。仅按原请求键核对，避免重复建群或邀请。
          </p>
        ) : null}
        {pending ? (
          <div role="status">
            <p>AI 正在执行，操作结果以来源回执为准。</p>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const value = await mutation(
                    "/runs/" + run.id + "/cancel",
                    {},
                  );
                  setRun(value);
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              停止后续 AI 操作
            </button>
          </div>
        ) : null}
        <section aria-label="我的通信管理回执">
          <h3>最近操作</h3>
          {!commands.length ? (
            <p>暂无通信管理操作。</p>
          ) : (
            commands.map((c) => (
              <article key={c.id} className="room-command">
                <strong>
                  {labels[c.operation as keyof typeof labels] ?? c.operation}
                </strong>
                <span>
                  {c.state} · 已确认 {c.completedSteps}/{c.totalSteps} 步
                </span>
                {c.sourceRoomDisposition ? (
                  <small>
                    {c.sourceRoomDisposition === "existing"
                      ? "来源返回已有单聊，未重复创建。"
                      : "来源确认新建会话。"}
                  </small>
                ) : null}
                <code>{c.id}</code>
                {c.steps.length ? (
                  <details>
                    <summary>实际步骤</summary>
                    {c.steps.map((s) => (
                      <p key={s.sequence}>
                        {s.sequence + 1}.{" "}
                        {labels[s.operation as keyof typeof labels] ??
                          s.operation}{" "}
                        · {s.state}
                      </p>
                    ))}
                  </details>
                ) : null}
                {c.state === "dispatching" ? (
                  <button
                    disabled={controlBusy || pending || uncertain}
                    onClick={() => void control(c, "stop")}
                  >
                    停止此操作后续步骤
                  </button>
                ) : null}
                {c.state === "recovery_required" ? (
                  <>
                    <button
                      disabled={frozen}
                      onClick={() => void control(c, "reconcile")}
                    >
                      只读核对此回执
                    </button>
                    {!c.acknowledgedAt ? (
                      <label>
                        <input
                          type="checkbox"
                          disabled={frozen}
                          onChange={(e) => {
                            if (e.target.checked)
                              void control(c, "acknowledge");
                          }}
                        />
                        已人工核对来源，允许另行发起新操作（此未知结果保留，不重发旧步骤）
                      </label>
                    ) : (
                      <small>已人工确认；原未知结果仍保留。</small>
                    )}
                  </>
                ) : null}
              </article>
            ))
          )}
        </section>
      </div>
    </Dialog>
  );
}
