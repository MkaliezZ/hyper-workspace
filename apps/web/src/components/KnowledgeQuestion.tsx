import { useEffect, useRef, useState } from "react";
import type { WorkspaceView, KnowledgePlan } from "@hyper/contracts";
import type { ModelSummary } from "./ModelSettings";
import { api, ApiError, mutation } from "../api";
export type KnowledgeSelection = {
  type?: string;
  id: string;
  title: string;
  sourceVersion: string;
};
export function KnowledgeQuestion({
  view,
  run,
  onRun,
  selected,
  defaultQuery,
  mode,
  onLock,
  onDenied,
}: {
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
  selected: KnowledgeSelection[];
  defaultQuery: string;
  mode: string;
  onLock: (locked: boolean) => void;
  onDenied: () => void;
}) {
  const [question, setQuestion] = useState(defaultQuery),
    [engine, setEngine] = useState("dsh"),
    [chat, setChat] = useState(""),
    [embedding, setEmbedding] = useState(""),
    [models, setModels] = useState<ModelSummary[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [ownRun, setOwnRun] = useState(""),
    [answer, setAnswer] = useState<any>(),
    [excerpt, setExcerpt] = useState<any>(),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const alive = useRef(true),
    generation = useRef(0),
    pending = useRef<any>(null),
    intent = useRef<{ id: string; signature: string } | null>(null),
    sequence = useRef(0);
  const signature = JSON.stringify({
      selected: selected.map((row) => row.id + "@" + row.sourceVersion).sort(),
      question,
      mode,
      engine,
      chat,
      embedding,
    }),
    current = useRef(signature);
  current.current = signature;
  const active =
      run?.id === ownRun && ["queued", "running"].includes(run.state),
    locked = busy || uncertain;
  const chosenModel = models.find((model) => model.id === chat),
    unavailable = !view.engines[engine]?.configured,
    incompatible =
      !!chosenModel &&
      !view.engines[engine]?.modelProviders?.includes(chosenModel.provider);
  useEffect(() => {
    alive.current = true;
    void api<ModelSummary[]>("/models")
      .then((rows) => {
        if (alive.current) setModels(rows);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
      sequence.current++;
      onLock(false);
    };
  }, [view.user.id, view.project.id]);
  useEffect(() => {
    setQuestion(defaultQuery);
  }, [defaultQuery]);
  useEffect(() => {
    generation.current++;
    setConfirmed(false);
    setAnswer(undefined);
    setExcerpt(undefined);
    setNotice("");
  }, [signature]);
  useEffect(() => {
    onLock(locked);
  }, [locked]);
  function fail(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      generation.current++;
      setAnswer(undefined);
      setExcerpt(undefined);
      setQuestion("");
      setConfirmed(false);
      pending.current = null;
      setUncertain(false);
      onDenied();
      if (run?.id === ownRun)
        onRun({
          ...run,
          instruction: "",
          knowledgeAnswer: null,
          knowledgePlan: undefined,
          result: null,
          error: (e as Error).message,
        });
    }
  }
  async function readCitation(cite: any) {
    const g = generation.current;
    setExcerpt(undefined);
    try {
      const row = await mutation<any>("/knowledge/citation", {
        assetId: cite.assetId,
        sourceVersion: cite.sourceVersion,
        start: cite.start,
        end: cite.end,
      });
      if (
        alive.current &&
        g === generation.current &&
        row.reference === cite.reference
      )
        setExcerpt(row);
    } catch (e) {
      if (alive.current && g === generation.current) fail(e);
    }
  }
  async function readAnswer(id: string) {
    const seq = ++sequence.current,
      saved = intent.current;
    if (!saved || saved.id !== id || saved.signature !== current.current)
      return;
    try {
      const result = await api<any>("/runs/" + id);
      if (
        !alive.current ||
        seq !== sequence.current ||
        saved.signature !== current.current
      )
        return;
      if (result.knowledgeAnswer) {
        setAnswer({
          question: result.knowledgePlan.query,
          ...result.knowledgeAnswer,
        });
        setNotice("回答仅对本次已选片段负责，请逐条核对引用。");
      } else if (
        ["failed", "cancelled", "recovery_required"].includes(result.state)
      ) {
        setAnswer(undefined);
        setExcerpt(undefined);
        setNotice(result.error ?? "问答未完成，未生成可用回答。");
      }
    } catch (e) {
      if (
        alive.current &&
        seq === sequence.current &&
        saved.signature === current.current
      )
        fail(e);
    }
  }
  useEffect(() => {
    if (
      ownRun &&
      run?.id === ownRun &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      void readAnswer(ownRun);
  }, [run?.id, run?.state, ownRun]);
  useEffect(() => {
    if (!ownRun) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void readAnswer(ownRun);
    }, 8000);
    return () => clearInterval(timer);
  }, [ownRun]);
  async function submit(replay = false) {
    if (
      busy ||
      active ||
      (!replay &&
        (unavailable ||
          incompatible ||
          !confirmed ||
          !selected.length ||
          !question.trim()))
    )
      return;
    const g = generation.current,
      sig = signature;
    setBusy(true);
    setUncertain(false);
    setError("");
    setAnswer(undefined);
    setExcerpt(undefined);
    try {
      const body = replay
        ? pending.current
        : {
            conversationId: view.project.conversationId,
            workflow: "query_knowledge",
            engine,
            modelProfileId: chat || undefined,
            knowledgePlan: {
              query: question,
              mode: mode === "semantic" ? "semantic" : "keyword",
              assetRefs: selected.map(({ id, sourceVersion }) => ({
                id,
                sourceVersion,
              })),
              embeddingProfileId: embedding || undefined,
            } satisfies KnowledgePlan,
            instruction:
              "仅回答选定资料片段支持的内容，保留实际引用和不确定性，不发布到项目讨论。",
            idempotencyKey: crypto.randomUUID(),
          };
      if (!body) return;
      pending.current = body;
      const result = await mutation<any>("/runs", body);
      if (!alive.current || g !== generation.current) return;
      pending.current = null;
      intent.current = { id: result.id, signature: sig };
      setOwnRun(result.id);
      setConfirmed(false);
      setNotice("资料问答已排队，不表示已生成有依据的回答。");
      onRun(result);
    } catch (e) {
      if (alive.current && g === generation.current) {
        fail(e);
        if (!(e instanceof ApiError) || e.status >= 500) setUncertain(true);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="knowledge-question" aria-label="选定资料 AI 问答">
      <h3>对选定资料提问</h3>
      <p className="muted">
        已选 {selected.length}/10 份资料。使用当前可读的指定版本，最多 16000
        字符片段；不会默认读取整个企业知识库，也不会把回答发到项目讨论。
      </p>
      {selected.length ? (
        <ul>
          {selected.map((row) => (
            <li key={row.id}>{row.title} · 指定版本已固定</li>
          ))}
        </ul>
      ) : (
        <p>先在检索结果中勾选资料。</p>
      )}
      <div className="settings-form">
        <label>
          资料问题
          <textarea
            maxLength={4000}
            value={question}
            disabled={locked}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label>
          问答执行器
          <select
            value={engine}
            disabled={locked}
            onChange={(e) => setEngine(e.target.value)}
          >
            <option value="dsh">DSH</option>
            <option value="hermes">Hermes</option>
          </select>
        </label>
        <label>
          问答模型
          <select
            value={chat}
            disabled={locked}
            onChange={(e) => setChat(e.target.value)}
          >
            <option value="">默认对话连接</option>
            {models
              .filter((row) => row.purpose === "chat")
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        {mode === "semantic" ? (
          <label>
            片段检索模型
            <select
              value={embedding}
              disabled={locked}
              onChange={(e) => setEmbedding(e.target.value)}
            >
              <option value="">默认向量连接</option>
              {models
                .filter((row) => row.purpose === "embedding")
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>
      <label className="check-row attachment-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={locked || active || !selected.length}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        确认使用已选资料与此问题；本次对话
        {mode === "semantic" ? "及向量检索" : ""}可能产生模型费用
      </label>
      <button
        className="primary"
        disabled={
          locked ||
          active ||
          unavailable ||
          incompatible ||
          !confirmed ||
          !question.trim() ||
          !selected.length
        }
        onClick={() => void submit()}
      >
        让 AI 回答选定资料
      </button>
      {unavailable || incompatible ? (
        <p role="status">
          {unavailable
            ? "此执行器尚未配置，请先完成运行环境配置。"
            : "模型连接与执行器不兼容，请更换连接。"}
        </p>
      ) : null}
      {uncertain ? (
        <button disabled={busy} onClick={() => void submit(true)}>
          核对原问答请求
        </button>
      ) : null}
      {active ? (
        <button
          disabled={busy}
          onClick={() =>
            void mutation("/runs/" + ownRun + "/cancel", {})
              .then((result) => {
                if (alive.current) onRun({ ...run, ...result });
              })
              .catch(fail)
          }
        >
          停止资料问答
        </button>
      ) : null}
      {ownRun ? (
        <button disabled={busy} onClick={() => void readAnswer(ownRun)}>
          重新核对回答来源
        </button>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {answer ? (
        <article className="knowledge-answer">
          <h4>私人回答</h4>
          <p className="muted">问题：{answer.question} · 仅覆盖选定片段</p>
          <pre>{answer.content}</pre>
          <details>
            <summary>实际引用 · {answer.citations.length}</summary>
            {answer.citations.map((cite: any) => (
              <p key={cite.reference}>
                {cite.title} · 字符 {cite.start}–{cite.end}
                <small>{cite.reference}</small>
                <button onClick={() => void readCitation(cite)}>
                  查看此引用片段
                </button>
              </p>
            ))}
          </details>
          {excerpt ? (
            <aside aria-label="当前来源片段">
              <h4>{excerpt.title}</h4>
              <p>
                字符 {excerpt.start}–{excerpt.end} · 已重新核对来源版本与权限
              </p>
              <pre>{excerpt.content}</pre>
              <button onClick={() => setExcerpt(undefined)}>
                关闭来源片段
              </button>
            </aside>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
