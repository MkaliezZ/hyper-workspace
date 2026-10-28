import { useEffect, useRef, useState } from "react";
import { FileText, Eye, PlusCircle, Paperclip, Send, Info } from "lucide-react";
import type { Artifact, Message } from "@hyper/contracts";
export function Discussion({
  messages,
  artifacts,
  onArtifact,
  onTask,
  onSend,
  busy,
  demo,
  query,
}: {
  messages: Message[];
  artifacts: Artifact[];
  onArtifact: (a: Artifact) => void;
  onTask: (title?: string) => void;
  onSend: (text: string) => Promise<boolean>;
  busy: boolean;
  demo: boolean;
  query: string;
}) {
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollOnNextMessage = useRef(false);
  useEffect(() => {
    if (scrollOnNextMessage.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      scrollOnNextMessage.current = false;
    }
  }, [messages.length]);
  const filtered = messages.filter(
    (m) => !query || m.content.includes(query) || m.author.includes(query),
  );
  async function send() {
    if (!text.trim() || busy) return;
    const value = text;
    scrollOnNextMessage.current = true;
    const sent = await onSend(value);
    if (sent) setText("");
    else scrollOnNextMessage.current = false;
  }
  return (
    <>
      <div className="discussion-scroll" ref={scroll}>
        {filtered.length ? (
          filtered.map((m) => {
            const artifact = artifacts.find(
              (a) =>
                a.id === m.metadata.artifactId ||
                (m.metadata.receipts as any[])?.some((r) => r.id === a.id),
            );
            return (
              <article className="message-row" key={m.id}>
                <div
                  className={
                    "avatar " +
                    (m.role === "assistant"
                      ? "ai"
                      : m.author === "陈远"
                        ? "green"
                        : "")
                  }
                >
                  {m.role === "assistant" ? "AI" : m.author.slice(0, 1)}
                </div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>{m.author}</strong>
                    <time>
                      {new Intl.DateTimeFormat("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      }).format(new Date(m.createdAt))}
                    </time>
                  </div>
                  <div
                    className={
                      "message-bubble " + (artifact ? "has-document" : "")
                    }
                  >
                    <p>{m.content}</p>
                    {artifact ? (
                      <div className="document-preview">
                        <header>
                          <FileText size={28} />
                          <strong>{artifact.title}</strong>
                        </header>
                        <div className="document-excerpt">
                          {artifact.content
                            .split("\n")
                            .filter(
                              (x) =>
                                x.trim() &&
                                !x.startsWith("#") &&
                                !x.startsWith(">"),
                            )
                            .slice(0, 3)
                            .map((x, i) => (
                              <div key={i}>
                                {x.startsWith("- ") ? "• " + x.slice(2) : x}
                              </div>
                            ))}
                        </div>
                        <footer>
                          <button onClick={() => onArtifact(artifact)}>
                            <Eye size={19} />
                            查看成果
                          </button>
                          <button
                            onClick={() => onTask("跟进：" + artifact.title)}
                          >
                            <PlusCircle size={19} />
                            创建待办
                          </button>
                        </footer>
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <div className="empty-state">
            {query
              ? "没有匹配的讨论。"
              : "开始一段讨论，让目标与行动逐渐清晰。"}
          </div>
        )}
      </div>
      <div className="composer-area">
        {demo ? (
          <p className="demo-note">
            <Info size={16} />
            演示内容，尚未连接企业数据
          </p>
        ) : null}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <button
            type="button"
            className="icon-button attachment-button"
            aria-label="附加文本文件"
            onClick={() => file.current?.click()}
          >
            <Paperclip size={23} />
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept=".txt,.md"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                if (f.size > 100000) {
                  setText("文件过大，请选择 100 KB 以内的文本或 Markdown。");
                  return;
                }
                const content = await f.text();
                setText(
                  (t) => t + (t ? "\n" : "") + "[" + f.name + "]\n" + content,
                );
              }
              e.target.value = "";
            }}
          />
          <textarea
            aria-label="讨论内容"
            placeholder="和团队讨论，或让 AI 帮你推进工作…"
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="primary send-button"
            type="submit"
            disabled={!text.trim() || busy}
          >
            <Send size={19} />
            <span>发送</span>
          </button>
        </form>
      </div>
    </>
  );
}
