import { useEffect, useRef, useState } from "react";
import { MessageSquare, RefreshCw, Send } from "lucide-react";
import type {
  CommunicationMessage,
  CommunicationReceipt,
  CommunicationRoom,
  ReplyDraft,
  ReplyDraftSummary,
} from "@hyper/contracts";
import { api, mutation, ApiError } from "../api";
import { MessageAttachments } from "./MessageAttachments";
import { AttachmentControls } from "./AttachmentComposer";
import type { WorkspaceView } from "@hyper/contracts";
interface Draft {
  text: string;
  key: string;
  draftId?: string;
}
export function EnterpriseMessages({
  demo,
  query,
  onLogout,
  initialRoomId,
  onProject,
  onDraft,
  initialReplyDraft,
  filesEnabled = false,
  view,
}: {
  demo: boolean;
  query: string;
  onLogout: () => void;
  initialRoomId?: string;
  onProject?: (room: CommunicationRoom) => Promise<void>;
  onDraft?: (room: CommunicationRoom) => Promise<void>;
  initialReplyDraft?: ReplyDraft;
  filesEnabled?: boolean;
  view?: WorkspaceView;
}) {
  const [rooms, setRooms] = useState<CommunicationRoom[]>([]),
    [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<CommunicationMessage[]>([]),
    [pending, setPending] = useState<CommunicationReceipt[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<ReplyDraftSummary[]>([]);
  const [proposal, setProposal] = useState<ReplyDraft>();
  const [before, setBefore] = useState<string | null>(null),
    [nextBefore, setNextBefore] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const current = useRef(selected),
    scroll = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const scopeEpoch = useRef(0),
    initialSeen = useRef("");
  current.current = selected;
  const room = rooms.find((r) => r.id === selected),
    draft = drafts[selected] ?? { text: "", key: "" };
  const proposalState =
    replyDrafts.find((value) => value.id === proposal?.id)?.sendState ??
    proposal?.sendState;
  useEffect(() => {
    if (
      initialReplyDraft &&
      initialReplyDraft.roomId === selected &&
      initialSeen.current !== initialReplyDraft.id
    ) {
      initialSeen.current = initialReplyDraft.id;
      setProposal(initialReplyDraft);
    }
  }, [selected, initialReplyDraft]);
  async function loadRooms() {
    if (demo) return;
    try {
      const values = await api<CommunicationRoom[]>("/talk/rooms");
      setRooms(values);
      setError("");
      if (!values.some((r) => r.id === current.current)) {
        scopeEpoch.current++;
        setProposal(undefined);
        setReplyDrafts([]);
        setSelected(
          values.some((room) => room.id === initialRoomId)
            ? initialRoomId!
            : (values[0]?.id ?? ""),
        );
        setMessages([]);
        setBefore(null);
      }
      setRefresh((value) => value + 1);
    } catch (e) {
      scopeEpoch.current++;
      setDrafts({});
      setProposal(undefined);
      setReplyDrafts([]);
      setRooms([]);
      setSelected("");
      setMessages([]);
      setPending([]);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadRooms();
  }, [demo]);
  useEffect(() => {
    if (!selected || demo) return;
    let alive = true,
      inFlight = false,
      paused = false;
    const load = async () => {
      if (inFlight || paused) return;
      inFlight = true;
      try {
        const path = "/talk/rooms/" + selected;
        const [page, receipts, savedDrafts] = await Promise.all([
          api<{ messages: CommunicationMessage[]; before: string | null }>(
            path + "/messages" + (before ? "?before=" + before : ""),
          ),
          api<CommunicationReceipt[]>(path + "/sends"),
          api<ReplyDraftSummary[]>(path + "/drafts"),
        ]);
        if (!alive) return;
        const atBottom =
          !scroll.current ||
          scroll.current.scrollHeight -
            scroll.current.scrollTop -
            scroll.current.clientHeight <
            100;
        stick.current = stick.current || (!before && atBottom);
        setMessages(page.messages);
        setNextBefore(page.before);
        setPending(receipts);
        setReplyDrafts(savedDrafts);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        paused = true;
        scopeEpoch.current++;
        setDrafts((values) => ({
          ...values,
          [selected]: { text: "", key: "" },
        }));
        setProposal(undefined);
        setReplyDrafts([]);
        setMessages([]);
        setPending([]);
        setError((e as Error).message);
        setLoading(false);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setRooms((items) => items.filter((r) => r.id !== selected));
          setSelected("");
        }
      } finally {
        inFlight = false;
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected, before, refresh, demo]);
  useEffect(() => {
    if (stick.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      stick.current = false;
    }
  }, [messages]);
  function edit(text: string) {
    setDrafts((values) => ({
      ...values,
      [selected]: { ...values[selected], text, key: crypto.randomUUID() },
    }));
  }
  async function preview(id: string) {
    const roomId = selected,
      epoch = scopeEpoch.current;
    try {
      const value = await api<ReplyDraft>("/talk/drafts/" + id);
      if (
        current.current === roomId &&
        scopeEpoch.current === epoch &&
        value.roomId === roomId
      )
        setProposal(value);
    } catch (e) {
      if (current.current === roomId) setError((e as Error).message);
    }
  }
  async function send() {
    if (!room || !draft.text.trim() || busy || pending.length || loading)
      return;
    const id = selected,
      intent = {
        text: draft.text,
        key: draft.key || crypto.randomUUID(),
        ...(draft.draftId ? { draftId: draft.draftId } : {}),
      };
    setDrafts((values) => ({ ...values, [id]: intent }));
    setBusy(true);
    setError("");
    try {
      const receipt = await mutation<CommunicationReceipt>(
        "/talk/rooms/" + id + "/messages",
        {
          content: intent.text,
          idempotencyKey: intent.key,
          ...(intent.draftId ? { draftId: intent.draftId } : {}),
        },
      );
      if (receipt.state === "succeeded") {
        setDrafts((values) => ({ ...values, [id]: { text: "", key: "" } }));
        stick.current = true;
        setBefore(null);
      } else if (receipt.state === "failed") {
        setError("来源拒绝了这条消息，草稿已保留。");
        setDrafts((values) => ({
          ...values,
          [id]: { ...intent, key: crypto.randomUUID() },
        }));
      } else setPending([receipt]);
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
      setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  async function receiptAction(
    id: string,
    action: "reconcile" | "acknowledge",
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await mutation<CommunicationReceipt>(
        "/talk/sends/" + id + "/" + action,
        {},
      );
      if (result.state === "succeeded") {
        setDrafts((values) => ({
          ...values,
          [selected]: { text: "", key: "" },
        }));
        stick.current = true;
      }
      if (action === "acknowledge")
        setDrafts((values) => ({
          ...values,
          [selected]: {
            ...values[selected],
            text: values[selected]?.text ?? "",
            key: crypto.randomUUID(),
            draftId: undefined,
          },
        }));
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (demo)
    return (
      <div className="enterprise-empty">
        <MessageSquare size={32} />
        <h3>使用企业账号查看消息</h3>
        <p>退出演示后，登录企业账号即可查看和回复你有权限访问的会话。</p>
        <button className="primary" onClick={onLogout}>
          退出演示
        </button>
      </div>
    );
  return (
    <section className="enterprise-panel" aria-label="企业会话">
      <aside className="enterprise-rooms">
        <div className="enterprise-room-heading">
          <h3>我的会话</h3>
          <button
            className="icon-button"
            aria-label="刷新企业会话"
            disabled={busy}
            onClick={() => void loadRooms()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <div role="list" aria-label="企业会话列表">
          {rooms.map((item) => (
            <button
              key={item.id}
              className={
                selected === item.id
                  ? "enterprise-room selected"
                  : "enterprise-room"
              }
              disabled={busy}
              onClick={() => {
                scopeEpoch.current++;
                setSelected(item.id);
                setBefore(null);
                setMessages([]);
                setPending([]);
                setReplyDrafts([]);
                setProposal(undefined);
                setError("");
                stick.current = true;
              }}
            >
              <MessageSquare size={18} />
              <span>{item.name}</span>
              {item.readOnly ? <small>只读</small> : null}
            </button>
          ))}
        </div>
        {!rooms.length && !loading ? (
          <p className="enterprise-hint">暂无可访问会话。</p>
        ) : null}
      </aside>
      <div className="enterprise-chat">
        {error ? (
          <p role="alert" className="error-banner">
            {error}
          </p>
        ) : null}
        {room ? (
          <>
            <header className="enterprise-chat-heading">
              <div>
                <h3>{room.name}</h3>
                <small>
                  来源：企业通信 · {before ? "历史消息" : "最近 100 条消息"}
                </small>
              </div>
              <div className="enterprise-history-buttons">
                {onDraft ? (
                  <button
                    disabled={
                      busy || loading || room.readOnly || !!pending.length
                    }
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      void onDraft(room)
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    AI 起草回复
                  </button>
                ) : null}
                {onProject ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      void onProject(room)
                        .catch((error) => setError(error.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    项目空间
                  </button>
                ) : null}
                {before ? (
                  <button
                    onClick={() => {
                      setBefore(null);
                      stick.current = true;
                    }}
                  >
                    返回最新
                  </button>
                ) : null}
                <button
                  disabled={!nextBefore || !messages.length || loading}
                  onClick={() => {
                    setBefore(nextBefore);
                    stick.current = false;
                  }}
                >
                  更早消息
                </button>
              </div>
            </header>
            <div className="enterprise-message-scroll" ref={scroll}>
              {loading && !messages.length ? (
                <p className="enterprise-hint">正在读取消息…</p>
              ) : null}
              {messages
                .filter(
                  (m) =>
                    (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()) &&
                    (!query ||
                      m.content.includes(query) ||
                      m.author.includes(query)),
                )
                .map((message) => (
                  <article
                    className={"enterprise-message " + message.kind}
                    key={message.id}
                  >
                    <div className="message-meta">
                      <strong>{message.author}</strong>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleString("zh-CN", {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p>{message.content}</p>
                    {message.attachments?.length ? (
                      <MessageAttachments
                        roomId={selected}
                        messageId={message.id}
                        attachments={message.attachments}
                        filesEnabled={filesEnabled}
                      />
                    ) : null}
                  </article>
                ))}
              {!loading && !messages.length ? (
                <p className="enterprise-hint">这里还没有消息。</p>
              ) : null}
              {replyDrafts.length ? (
                <details className="reply-draft-history">
                  <summary>我的 AI 草稿 · 最近 {replyDrafts.length} 份</summary>
                  {replyDrafts.map((value) => (
                    <div key={value.id}>
                      <span>
                        {value.engine.toUpperCase()} ·{" "}
                        {new Date(value.createdAt).toLocaleString("zh-CN")} ·{" "}
                        {value.sendState === "succeeded"
                          ? "已发送"
                          : value.sendState === "sending" ||
                              value.sendState === "recovery_required"
                            ? "发送待核对"
                            : "未发送"}
                      </span>
                      <button
                        disabled={
                          busy ||
                          loading ||
                          !!pending.length ||
                          (!!value.sendState && value.sendState !== "failed")
                        }
                        onClick={() => void preview(value.id)}
                      >
                        预览草稿
                      </button>
                    </div>
                  ))}
                </details>
              ) : null}
              {proposal && proposal.roomId === selected ? (
                <section
                  className="reply-draft-preview"
                  aria-label="AI 回复草稿"
                >
                  <strong>
                    AI 回复草稿 · 仅你可见 ·{" "}
                    {proposalState === "succeeded"
                      ? "已发送"
                      : proposalState === "sending" ||
                          proposalState === "recovery_required"
                        ? "发送待核对"
                        : "尚未发送"}
                  </strong>
                  <p>{proposal.content}</p>
                  <small>
                    生成于{" "}
                    {new Date(proposal.createdAt).toLocaleString("zh-CN")}
                    ，请检查内容与当前会话，再发送。
                  </small>
                  <div>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        loading ||
                        !!pending.length ||
                        room.readOnly ||
                        (!!proposalState && proposalState !== "failed")
                      }
                      onClick={() => {
                        setDrafts((values) => ({
                          ...values,
                          [selected]: {
                            text: proposal.content,
                            key: crypto.randomUUID(),
                            draftId: proposal.id,
                          },
                        }));
                        setProposal(undefined);
                      }}
                    >
                      {draft.text ? "替换当前草稿" : "放入发送框"}
                    </button>
                    <button onClick={() => setProposal(undefined)}>
                      关闭预览
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
            {pending.map((receipt) => (
              <div
                className="enterprise-recovery"
                key={receipt.id}
                role="status"
              >
                <p>
                  {receipt.state === "sending"
                    ? "上一条消息正在发送。"
                    : "上一条消息的发送结果尚未确认，请核对会话中的实际消息。"}
                </p>
                <div>
                  <button
                    disabled={busy}
                    onClick={() => void receiptAction(receipt.id, "reconcile")}
                  >
                    核对发送结果
                  </button>
                  {receipt.state === "recovery_required" ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void receiptAction(receipt.id, "acknowledge")
                      }
                    >
                      已查看来源，继续
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {filesEnabled && view ? <AttachmentControls key={selected} room={room} view={view} disabled={busy||loading} onChange={()=>setRefresh(v=>v+1)}/> : null}
            {draft.draftId ? (
              <p className="reply-draft-notice">
                AI 起草的回复，可修改后发送。发送结果以会话回执为准。
              </p>
            ) : null}
            <form
              className="enterprise-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="enterprise-message">
                企业消息内容
              </label>
              <textarea
                id="enterprise-message"
                value={draft.text}
                maxLength={20000}
                onChange={(e) => edit(e.target.value)}
                disabled={busy || !!pending.length || room.readOnly}
                placeholder={room.readOnly ? "此会话只读" : "给当前会话发消息…"}
              />
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  loading ||
                  !!pending.length ||
                  room.readOnly ||
                  !draft.text.trim()
                }
              >
                <Send size={17} />
                发送消息
              </button>
            </form>
          </>
        ) : (
          <div className="enterprise-empty">
            <MessageSquare size={32} />
            <p>选择一个会话，查看企业消息。</p>
          </div>
        )}
      </div>
    </section>
  );
}
