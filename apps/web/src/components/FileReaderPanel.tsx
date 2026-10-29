import { useEffect, useRef, useState } from "react";
import type { EngineCapabilities } from "@hyper/contracts";
import { api, mutation } from "../api";
type Reading = {
  id: string;
  content: string;
  version: number;
  sourceVersion: string;
  question: string;
  versions: { version: number; content: string }[];
};
type Library = {
  readings: { id: string; version: number; engine: string }[];
  runs: { id: string; state: string }[];
};
type Model = { id: string; name: string; provider: string; purpose: string };
export function FileReaderPanel({
  file,
  engines,
  busy,
  act,
}: {
  file: { id: string; sourceVersion: string };
  engines: Record<string, EngineCapabilities>;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [models, setModels] = useState<Model[]>([]),
    [question, setQuestion] = useState(
      "请概括文件要点，区分明确事实与需要确认的信息。",
    ),
    [items, setItems] = useState<Library["readings"]>([]),
    [runId, setRunId] = useState<string>(),
    [reading, setReading] = useState<Reading>(),
    [draft, setDraft] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    selection = useRef(0),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  async function library() {
    const value = await api<Library>("/files/imports/" + file.id + "/readings");
    if (!alive.current) return;
    setItems(Array.isArray(value.readings) ? value.readings : []);
    if (value.runs?.length) setRunId((current) => current ?? value.runs[0]!.id);
  }
  async function select(id: string) {
    const token = ++selection.current;
    const value = await api<Reading>("/files/readings/" + id);
    if (
      alive.current &&
      token === selection.current &&
      value.sourceVersion === file.sourceVersion
    ) {
      setReading(value);
      setDraft(value.content);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (open)
      void Promise.all([api<Model[]>("/models"), library()])
        .then(([values]) => {
          if (alive.current)
            setModels(values.filter((v) => v.purpose === "chat"));
        })
        .catch(() => {
          if (alive.current) {
            setItems([]);
            setReading(undefined);
            setDraft("");
            setNotice("来源或模型列表暂时无法验证，请重新打开。");
          }
        });
    return () => {
      alive.current = false;
      selection.current++;
    };
  }, [open, file.id, file.sourceVersion]);
  useEffect(() => {
    if (!runId) return;
    let stopped = false,
      inFlight = false;
    async function poll() {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const r = await api<{
          state: string;
          error?: string;
          result?: { receipts: { tool: string; id: string }[] };
        }>("/runs/" + runId);
        if (stopped || !alive.current) return;
        if (
          ["succeeded", "failed", "cancelled", "recovery_required"].includes(
            r.state,
          )
        ) {
          setRunId(undefined);
          setNotice(
            r.state === "succeeded"
              ? "个人解读已保存，请核对内容后使用。"
              : (r.error ?? "已停止；可检查已保存的个人解读。"),
          );
          await library();
          const saved = r.result?.receipts.find(
            (v) => v.tool === "file.reading.save",
          );
          if (saved) await select(saved.id);
        }
      } catch {
        if (!stopped && alive.current) {
          selection.current++;
          setRunId(undefined);
          setItems([]);
          setReading(undefined);
          setDraft("");
          setNotice("无法验证当前来源，已关闭解读内容。");
        }
      } finally {
        inFlight = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, file.sourceVersion]);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        AI 阅读此文件
      </button>
    );
  const providers = engines[engine]?.modelProviders;
  const compatible = models.filter(
    (v) => !providers || providers.includes(v.provider),
  );
  return (
    <section className="file-reader" aria-label="个人 AI 文件阅读">
      <h4>用 AI 阅读当前版本</h4>
      <p className="muted small">
        仅发送这份文件和你的问题给所选模型。解读仅本人可见，可人工修改；沿用源权限和版本。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const input = {
              engine,
              instruction: question,
              expectedSourceVersion: file.sourceVersion,
              modelProfileId: model || undefined,
            };
            const hash = JSON.stringify(input);
            if (attempt.current?.hash !== hash)
              attempt.current = { hash, key: crypto.randomUUID() };
            const r = await mutation<{ id: string }>(
              "/files/imports/" + file.id + "/readings",
              { ...input, idempotencyKey: attempt.current.key },
            );
            if (alive.current) {
              setRunId(r.id);
              setNotice("正在阅读所选文件…");
              attempt.current = undefined;
            }
          });
        }}
      >
        <label>
          执行器
          <select
            value={engine}
            disabled={busy || !!runId}
            onChange={(e) => {
              setEngine(e.target.value);
              setModel("");
            }}
          >
            {["dsh", "hermes"].map((id) => (
              <option key={id} value={id} disabled={!engines[id]?.configured}>
                {id === "dsh" ? "DSH" : "Hermes"}
                {engines[id]?.configured ? "" : "（未配置）"}
              </option>
            ))}
          </select>
        </label>
        <label>
          阅读模型
          <select
            value={model}
            disabled={busy || !!runId}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">自动选择个人/工作区连接</option>
            {compatible.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="file-reading-question">
          阅读问题
          <textarea
            required
            maxLength={4000}
            value={question}
            disabled={!!runId}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !!runId || !engines[engine]?.configured}
        >
          开始个人阅读
        </button>
        {runId ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await mutation("/runs/" + runId + "/cancel", {});
                if (alive.current) {
                  setRunId(undefined);
                  setNotice("已停止后续阅读，已保存结果可从记录查看。");
                  await library();
                }
              })
            }
          >
            停止阅读
          </button>
        ) : null}
      </form>
      {notice ? <p role="status">{notice}</p> : null}
      <div className="file-reading-history">
        {items.map((item) => (
          <button
            key={item.id}
            disabled={busy}
            onClick={() => void act(() => select(item.id))}
          >
            {item.engine.toUpperCase()} · 解读 v{item.version}
          </button>
        ))}
      </div>
      {reading ? (
        <div aria-label="个人文件解读">
          <p className="muted small">
            问题：{reading.question} · 当前修订 v{reading.version}
          </p>
          <label>
            修改解读
            <textarea
              value={draft}
              maxLength={20000}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !draft.trim()}
            onClick={() =>
              void act(async () => {
                const id = reading.id;
                await mutation(
                  "/files/readings/" + id,
                  { content: draft, expectedVersion: reading.version },
                  "PATCH",
                );
                if (alive.current) {
                  await select(id);
                  await library();
                  setNotice("已保存个人解读修订。");
                }
              })
            }
          >
            保存解读修订
          </button>
          <button
            disabled={busy}
            onClick={() => void act(() => select(reading.id))}
          >
            重新读取解读
          </button>
          <details>
            <summary>查看版本记录（{reading.versions.length}）</summary>
            {reading.versions.map((v) => (
              <div key={v.version}>
                <strong>v{v.version}</strong>
                <pre>{v.content}</pre>
              </div>
            ))}
          </details>
        </div>
      ) : null}
    </section>
  );
}
