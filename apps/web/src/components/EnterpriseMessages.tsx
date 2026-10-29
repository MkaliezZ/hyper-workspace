import { useEffect, useRef, useState } from "react";
import { MessageSquare, RefreshCw, Send } from "lucide-react";
import type {
  CommunicationMessage,
  CommunicationReceipt,
  CommunicationRoom,
} from "@hyper/contracts";
import { api, mutation, ApiError } from "../api";
interface Draft {
  text: string;
  key: string;
}
export function EnterpriseMessages({
  demo,
  query,
  onLogout,
}: {
  demo: boolean;
  query: string;
  onLogout: () => void;
}) {
  const [rooms, setRooms] = useState<CommunicationRoom[]>([]),
    [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<CommunicationMessage[]>([]),
    [pending, setPending] = useState<CommunicationReceipt[]>([]);
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
  current.current = selected;
  const room = rooms.find((r) => r.id === selected),
    draft = drafts[selected] ?? { text: "", key: "" };
  async function loadRooms() {
    if (demo) return;
    try {
      const values = await api<CommunicationRoom[]>("/talk/rooms");
      setRooms(values);
      setError("");
      if (!values.some((r) => r.id === current.current)) {
        setSelected(values[0]?.id ?? "");
        setMessages([]);
        setBefore(null);
      }
      setRefresh((value) => value + 1);
    } catch (e) {
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
        const [page, receipts] = await Promise.all([
          api<{ messages: CommunicationMessage[]; before: string | null }>(
            path + "/messages" + (before ? "?before=" + before : ""),
          ),
          api<CommunicationReceipt[]>(path + "/sends"),
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
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        paused = true;
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
      [selected]: { text, key: crypto.randomUUID() },
    }));
  }
  async function send() {
    if (!room || !draft.text.trim() || busy || pending.length || loading)
      return;
    const id = selected,
      intent = { text: draft.text, key: draft.key || crypto.randomUUID() };
    setDrafts((values) => ({ ...values, [id]: intent }));
    setBusy(true);
    setError("");
    try {
      const receipt = await mutation<CommunicationReceipt>(
        "/talk/rooms/" + id + "/messages",
        { content: intent.text, idempotencyKey: intent.key },
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
                setSelected(item.id);
                setBefore(null);
                setMessages([]);
                setPending([]);
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
                  </article>
                ))}
              {!loading && !messages.length ? (
                <p className="enterprise-hint">这里还没有消息。</p>
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
