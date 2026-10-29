import { useEffect, useRef, useState } from "react";
import {
  artifactStatusLabel,
  type Artifact,
  type ArtifactReviewPlan,
  type WorkspaceView,
} from "@hyper/contracts";
import { api, mutation } from "../api";
import type { ModelSummary } from "./ModelSettings";
interface Review {
  id: string;
  version: number;
  reviewRevision: number;
  reviewerName: string;
  reviewerAuthority: string;
  decision: string;
  status: string;
  feedback: string;
  channel: string;
  createdAt: string;
}
interface Detail {
  current: Artifact;
  canReview: boolean;
  reviews: Review[];
}
const decisionLabels = {
  accept: "接受此版本",
  request_changes: "要求修改",
  reopen: "撤销验收并重开",
};
export function ArtifactReviewPanel({
  artifact,
  dirty,
  view,
  run,
  onRun,
  onMetadata,
  onReload,
}: {
  artifact: Artifact;
  dirty: boolean;
  view: WorkspaceView;
  run: any;
  onRun: (value: any) => void;
  onMetadata: (value: Artifact) => void;
  onReload: (value: Artifact) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [decision, setDecision] =
      useState<ArtifactReviewPlan["decision"]>("accept"),
    [feedback, setFeedback] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState("human"),
    [engine, setEngine] = useState("dsh"),
    [modelId, setModelId] = useState(""),
    [models, setModels] = useState<ModelSummary[]>([]),
    [busy, setBusy] = useState(false);
  const alive = useRef(false),
    generation = useRef(0),
    revision = useRef(""),
    attempt = useRef<{ hash: string; key: string } | undefined>(undefined);
  const reviewing =
    run?.workflow === "review_artifact" && run.artifactId === artifact.id;
  async function load(clearError = false) {
    const current = ++generation.current;
    if (clearError) setError("");
    try {
      const data = await api<Detail>("/artifacts/" + artifact.id);
      if (!alive.current || generation.current !== current) return;
      const key =
        data.current.version + ":" + (data.current.reviewRevision ?? 0);
      if (revision.current !== key) {
        revision.current = key;
        setConfirmed(false);
      }
      setDetail({ ...data, reviews: data.reviews ?? [] });
      onMetadata(data.current);
      return data;
    } catch (e) {
      if (alive.current && generation.current === current) {
        setDetail(null);
        setConfirmed(false);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [artifact.id, artifact.version]);
  useEffect(() => {
    if (mode !== "ai") return;
    let current = true;
    void api<ModelSummary[]>("/models")
      .then((values) => {
        if (current) setModels(values.filter((m) => m.purpose === "chat"));
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [mode, view.user.id]);
  useEffect(() => {
    if (
      reviewing &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    ) {
      setNotice(
        run.state === "succeeded" ? "指定版本的员工验收决定已记录。" : "",
      );
      if (run.error) setError(run.error);
      void load();
    }
  }, [run?.id, run?.state]);
  const stale = detail && detail.current.version !== artifact.version;
  const pending =
    reviewing &&
    ["queued", "running", "waiting_input", "waiting_confirmation"].includes(
      run.state,
    );
  const invalid =
    (decision === "accept" && detail?.current.status === "accepted") ||
    (decision === "reopen" && detail?.current.status === "draft");
  const selected = models.find((m) => m.id === modelId);
  const incompatible =
    mode === "ai" &&
    engine !== "fixture" &&
    selected &&
    view.engines[engine]?.modelProviders &&
    !view.engines[engine]!.modelProviders!.includes(selected.provider);
  async function submit() {
    if (
      busy ||
      pending ||
      dirty ||
      stale ||
      !detail?.canReview ||
      !confirmed ||
      !feedback.trim() ||
      invalid ||
      incompatible
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    const plan = {
      expectedVersion: artifact.version,
      expectedReviewRevision: detail.current.reviewRevision ?? 0,
      decision,
      feedback: feedback.trim(),
      confirmed: true,
    } as const;
    const hash = JSON.stringify({
      artifactId: artifact.id,
      mode,
      engine,
      modelId,
      plan,
    });
    if (attempt.current?.hash !== hash)
      attempt.current = { hash, key: crypto.randomUUID() };
    try {
      if (mode === "ai") {
        const started = await mutation("/runs", {
          conversationId: view.project.conversationId,
          workflow: "review_artifact",
          artifactId: artifact.id,
          artifactReviewPlan: plan,
          engine,
          instruction: "仅记录我已确认的指定版本验收决定，不自行评判质量。",
          ...(engine !== "fixture" && modelId
            ? { modelProfileId: modelId }
            : {}),
          idempotencyKey: attempt.current!.key,
        });
        if (!alive.current) return;
        onRun({
          ...started,
          engine,
          workflow: "review_artifact",
          artifactId: artifact.id,
        });
        setNotice("AI 正在代执行员工已确认的决定。编辑框内容会保留。");
      } else {
        await mutation("/artifacts/" + artifact.id + "/reviews", {
          ...plan,
          idempotencyKey: attempt.current!.key,
        });
        if (!alive.current) return;
        setNotice("指定版本的员工验收决定已记录。");
        await load();
      }
      attempt.current = undefined;
      setConfirmed(false);
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        await load();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="artifact-review-panel" aria-label="成果验收">
      <div className="artifact-review-heading">
        <h3>成果验收</h3>
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => {
            void load(true).then((data) => {
              if (data && alive.current) onReload(data.current);
            });
          }}
        >
          重新读取成果
        </button>
      </div>
      <p className="muted small">
        验收只针对已保存的确切版本。意见对项目成员可见；AI
        仅代执行员工决定，不代表模型验证了内容质量。新版本重新作为草稿。
      </p>
      {error ? (
        <p role="alert" className="error-banner">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="muted small">
          {notice}
        </p>
      ) : null}
      {detail ? (
        <>
          <p className="artifact-review-current" role="status">
            已保存版本 v{detail.current.version} ·{" "}
            {artifactStatusLabel(detail.current.status)} · 验收修订{" "}
            {detail.current.reviewRevision ?? 0}
          </p>
          {dirty ? (
            <p className="muted small">
              编辑框有未保存内容，不属于上述验收。请先保存后再发起决定；重新读取会替换编辑框，请先保留未保存文字。
            </p>
          ) : null}
          {stale ? (
            <p role="status" className="muted small">
              成果已有新版。当前编辑内容已保留，重新读取后再验收。
            </p>
          ) : null}
          {detail.canReview ? (
            <form
              className="artifact-review-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label>
                验收决定
                <select
                  aria-label="验收决定"
                  value={decision}
                  onChange={(e) => {
                    setDecision(
                      e.target.value as ArtifactReviewPlan["decision"],
                    );
                    setConfirmed(false);
                  }}
                >
                  {Object.entries(decisionLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                记录方式
                <select
                  aria-label="验收记录方式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="human">员工直接记录</option>
                  <option value="ai">AI 代执行</option>
                </select>
              </label>
              <label className="artifact-review-feedback">
                验收意见
                <textarea
                  aria-label="验收意见"
                  required
                  maxLength={4000}
                  value={feedback}
                  onChange={(e) => {
                    setFeedback(e.target.value);
                    setConfirmed(false);
                  }}
                  placeholder="记录核对依据、需修改内容或重开的原因"
                />
              </label>
              {mode === "ai" ? (
                <>
                  <label>
                    执行器
                    <select
                      aria-label="验收执行器"
                      value={engine}
                      onChange={(e) => setEngine(e.target.value)}
                    >
                      <option value="dsh">DSH</option>
                      <option value="hermes">Hermes</option>
                      {view.user.demo ? (
                        <option value="fixture">演示代执行 · 不调用模型</option>
                      ) : null}
                    </select>
                  </label>
                  {engine !== "fixture" ? (
                    <label>
                      模型连接
                      <select
                        aria-label="验收模型连接"
                        value={modelId}
                        onChange={(e) => setModelId(e.target.value)}
                      >
                        <option value="">当前默认连接</option>
                        {models.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <p className="muted small">
                    仅将选定决定和手工意见交给模型，不自动发送成果正文；本次可能产生模型费用。
                  </p>
                </>
              ) : null}
              <label className="artifact-review-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已检查已保存的 v{artifact.version}，并确认上述决定与意见
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  pending ||
                  dirty ||
                  !!stale ||
                  !confirmed ||
                  !feedback.trim() ||
                  invalid ||
                  !!incompatible
                }
              >
                {mode === "ai" ? "让 AI 记录决定" : "记录验收决定"}
              </button>
            </form>
          ) : (
            <p className="muted small">
              仅成果创建人或有项目访问权限的工作区管理员可记录验收决定。
            </p>
          )}
          <h4>最近验收记录（最多 50 条）</h4>
          {detail.reviews.length ? (
            <ol className="artifact-review-history">
              {detail.reviews.map((r) => (
                <li key={r.id}>
                  <strong>
                    v{r.version} · {artifactStatusLabel(r.status)}
                  </strong>
                  <span>
                    {r.reviewerName} ·{" "}
                    {r.reviewerAuthority === "creator" ? "创建人" : "管理员"} ·{" "}
                    {r.channel === "human"
                      ? "员工直接记录"
                      : "AI 代执行，员工确认"}
                  </span>
                  <p>{r.feedback}</p>
                  <small>{new Date(r.createdAt).toLocaleString("zh-CN")}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">此成果尚无验收记录。</p>
          )}
        </>
      ) : null}
    </section>
  );
}
