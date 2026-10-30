import { useEffect, useState } from "react";
import { FileText, Search } from "lucide-react";
import { api, mutation } from "../api";
import { SourceFilesPanel } from "./SourceFilesPanel";
import { MethodsPanel } from "./MethodsPanel";
import type { WorkspaceView } from "@hyper/contracts";
import { usePageTransition } from "../hooks/usePageTransition";
interface KnowledgeResult {
  id: string;
  title: string;
  content: string;
  sourceRef?: string;
  sourceVersion: string;
  type?: string;
}
export function KnowledgePanel({
  busy,
  act,
  demo,
  filesEnabled,
  engines,
  view,
  run,
  onRun,
}: {
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<boolean>;
  demo: boolean;
  filesEnabled: boolean;
  engines: Record<string, import("@hyper/contracts").EngineCapabilities>;
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
}) {
  const [query, setQuery] = useState(""),
    [mode, setMode] = useState("keyword");
  const [tab, setTab] = useState<"search" | "files" | "methods">("search");
  const [results, setResults] = useState<KnowledgeResult[]>([]),
    [notice, setNotice] = useState("");
  const surface = usePageTransition<HTMLDivElement>(tab);
  const hasFileResults = results.some((row) => row.type === "source_file");
  useEffect(() => {
    if (!hasFileResults) return;
    let alive = true,
      inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const values =
          await api<{ id: string; state: string; sourceVersion?: string }[]>(
            "/files/imports",
          );
        if (alive)
          setResults((rows) =>
            rows.filter(
              (row) =>
                row.type !== "source_file" ||
                values.some(
                  (file) =>
                    file.id === row.id &&
                    file.state === "ready" &&
                    file.sourceVersion === row.sourceVersion,
                ),
            ),
          );
      } catch {
        if (alive)
          setResults((rows) =>
            rows.filter((row) => row.type !== "source_file"),
          );
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hasFileResults]);
  return (
    <div className="work-panel" ref={surface}>
      <div className="tabs" role="tablist" aria-label="资料操作">
        <button
          role="tab"
          className={tab === "search" ? "active" : ""}
          aria-selected={tab === "search"}
          onClick={() => setTab("search")}
        >
          知识检索
        </button>
        <button
          role="tab"
          className={tab === "files" ? "active" : ""}
          aria-selected={tab === "files"}
          onClick={() => {
            setResults([]);
            setTab("files");
          }}
        >
          企业文件
        </button>
        <button
          role="tab"
          className={tab === "methods" ? "active" : ""}
          aria-selected={tab === "methods"}
          onClick={() => {
            setResults([]);
            setTab("methods");
          }}
        >
          方法与模板
        </button>
      </div>
      {tab === "methods" ? (
        <MethodsPanel
          key={view.user.id + ":" + view.project.id}
          view={view}
          run={run}
          onRun={onRun}
        />
      ) : tab === "files" ? (
        <SourceFilesPanel
          enabled={filesEnabled}
          demo={demo}
          busy={busy}
          act={act}
          engines={engines}
        />
      ) : (
        <>
          <h3>从企业资料中找到依据</h3>
          <p className="muted">
            文字检索直接查询可见资料；按含义查找需要在设置中配置向量模型，并为资料建立索引。
          </p>
          <form
            className="knowledge-search"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setNotice("");
                setResults(
                  mode === "keyword"
                    ? await api("/knowledge?q=" + encodeURIComponent(query))
                    : await mutation("/knowledge/semantic", { query }),
                );
              });
            }}
          >
            <input
              required
              aria-label="检索资料"
              placeholder="输入问题或关键词"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="检索方式"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setResults([]);
              }}
            >
              <option value="keyword">文字匹配</option>
              <option value="semantic">按含义查找</option>
            </select>
            <button className="primary" disabled={busy}>
              <Search size={17} />
              检索
            </button>
          </form>
          {notice ? <p role="status">{notice}</p> : null}
          {results.map((a) => (
            <article className="knowledge-result" key={a.id}>
              <h4>
                <FileText size={20} />
                {a.title}
              </h4>
              <p>{a.content}</p>
              <small>
                来源：{a.sourceRef ?? "产品资产"} · 版本 {a.sourceVersion}
              </small>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await mutation<{ indexed: string[] }>(
                      "/knowledge/index",
                      { assetIds: [a.id] },
                    );
                    setNotice(
                      result.indexed.length
                        ? "资料已建立语义索引。"
                        : "资料已变化，请刷新后重建索引。",
                    );
                  })
                }
              >
                建立语义索引
              </button>
            </article>
          ))}
          {!results.length ? (
            <div className="empty-state">
              检索结果会显示在这里。语义索引和检索会调用已配置的向量模型。
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
