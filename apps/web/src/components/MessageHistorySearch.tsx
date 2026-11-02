import { useEffect, useRef, useState } from "react";
import type { CommunicationMessage } from "@hyper/contracts";
import { api, ApiError } from "../api";
type Page = {
  roomId: string;
  messages: (CommunicationMessage & { sourceUrl?: string })[];
  cursor: string | null;
  complete: boolean;
  scope: "source-history";
};
/** Search text/results stay in this actor/room/binding-keyed view, not in AI logs. */
export function MessageHistorySearch({
  roomId,
  bindingRef,
  query,
  onQuery,
  disabled,
  completedRun,
  onDenied,
}: {
  roomId: string;
  bindingRef: string;
  query: string;
  onQuery: (v: string) => void;
  disabled: boolean;
  completedRun?: string;
  onDenied: (message: string) => void;
}) {
  const [result, setResult] = useState<Page>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0),
    controller = useRef<AbortController | undefined>(undefined),
    latestQuery = useRef(query);
  latestQuery.current = query;
  function clear() {
    epoch.current++;
    controller.current?.abort();
    setResult(undefined);
    setError("");
    setBusy(false);
  }
  useEffect(
    () => () => {
      epoch.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    clear();
  }, [query]);
  useEffect(() => {
    if (completedRun && query.trim()) void search();
  }, [completedRun]);
  async function search(cursor?: string) {
    if (!query.trim()) return;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    const generation = ++epoch.current,
      term = query.trim();
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({
        q: term,
        bindingRef,
        ...(cursor ? { cursor } : {}),
      });
      const page = await api<Page>(`/talk/rooms/${roomId}/search?${params}`, {
        signal: c.signal,
      });
      if (
        c.signal.aborted ||
        generation !== epoch.current ||
        latestQuery.current.trim() !== term
      )
        return;
      if (page.roomId !== roomId || page.scope !== "source-history")
        throw Error("搜索结果范围不匹配。");
      setResult((old) => ({
        ...page,
        messages: cursor
          ? [
              ...(old?.messages ?? []).filter(
                (m) => !page.messages.some((n) => n.id === m.id),
              ),
              ...page.messages,
            ]
          : page.messages,
      }));
    } catch (e) {
      if (c.signal.aborted || generation !== epoch.current) return;
      setResult(undefined);
      setError((e as Error).message);
      if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status))
        onDenied((e as Error).message);
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label="当前会话历史搜索" className="message-history-search">
      <p className="muted">
        查询来源中的历史消息，不限于已加载页面；不改变已读位置或消息通知。AI
        只获得搜索范围和数量回执，消息内容在本页按当前权限回读。
      </p>
      <label>
        历史消息关键词
        <input
          aria-label="历史消息关键词"
          value={query}
          maxLength={200}
          disabled={disabled || busy}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <button
        disabled={disabled || busy || !query.trim()}
        onClick={() => void search()}
      >
        直接搜索历史
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p role="status">正在查询历史消息…</p> : null}
      {result ? (
        <>
          <p role="status">
            已读取 {result.messages.length} 条当前可见结果。
            {result.complete
              ? "已到来源结果末尾。"
              : "还有来源结果可继续读取。"}
          </p>
          <ol>
            {result.messages.map((message) => (
              <li key={message.id}>
                <strong>{message.author}</strong> ·{" "}
                <time>{new Date(message.createdAt).toLocaleString()}</time>
                <p>{message.content}</p>
                {message.sourceUrl ? (
                  <a
                    href={message.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    在来源中查看
                  </a>
                ) : null}
                <small>
                  来源消息 {message.id} · 版本 {message.version}
                </small>
              </li>
            ))}
          </ol>
          {result.cursor && result.messages.length < 200 ? (
            <button
              disabled={disabled || busy}
              onClick={() => void search(result.cursor!)}
            >
              继续读取搜索结果
            </button>
          ) : result.cursor ? (
            <p>本页最多保留 200 条结果，请缩小关键词范围后重新搜索。</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
