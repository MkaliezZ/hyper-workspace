import { useEffect, useRef, useState } from "react";
import { Folder, Paperclip, RefreshCw } from "lucide-react";
import type {
  AttachmentSendPlan,
  AttachmentSendReceipt,
  CommunicationRoom,
  SourceFile,
  WorkspaceView,
} from "@hyper/contracts";
import { api, mutation, ApiError } from "../api";
import { Dialog } from "./Dialog";
import type { ModelSummary } from "./ModelSettings";
type Activity = {
  sends: AttachmentSendReceipt[];
  runs: {
    id: string;
    state: string;
    error: string | null;
    deliveryState?: string | null;
  }[];
  history?: AttachmentSendReceipt[];
};
export function AttachmentControls({
  room,
  view,
  disabled,
  onChange,
}: {
  room: CommunicationRoom;
  view: WorkspaceView;
  disabled: boolean;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false),
    [activity, setActivity] = useState<Activity>({ sends: [], runs: [] }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    sequence = useRef(0);
  const pending =
    activity.sends.length > 0 ||
    activity.runs.some((r) => ["queued", "running"].includes(r.state));
  async function load() {
    const seq = ++sequence.current;
    try {
      const data = await api<Activity>(
        "/talk/rooms/" + room.id + "/attachment-sends",
      );
      if (alive.current && seq === sequence.current) {
        setActivity(data);
        setReady(true);
        setError("");
      }
    } catch (e) {
      if (alive.current && seq === sequence.current) {
        setActivity({ sends: [], runs: [] });
        setReady(false);
        setOpen(false);
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      alive.current = false;
      sequence.current++;
      clearInterval(timer);
    };
  }, [room.id]);
  async function action(id: string, operation: "reconcile" | "acknowledge") {
    setBusy(true);
    try {
      const r = await mutation<AttachmentSendReceipt>(
        "/talk/attachment-sends/" + id + "/" + operation,
        {},
      );
      if (alive.current) {
        setNotice(
          r.state === "succeeded"
            ? "附件分享消息已回读。"
            : "附件结果仍未确认；人工继续不表示已送达或已撤销。",
        );
        await load();
        onChange();
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="attachment-controls" aria-label="我的附件发送">
      <div className="attachment-toolbar">
        <button
          disabled={
            disabled || busy || !ready || pending || room.readOnly || !!error
          }
          onClick={() => {
            setNotice("");
            setOpen(true);
          }}
        >
          <Paperclip size={16} />
          发送附件
        </button>
        <button
          className="icon-button"
          aria-label="刷新附件发送记录"
          onClick={() => void load()}
          disabled={busy}
        >
          <RefreshCw size={15} />
        </button>
        <small>分享当前源文件，不自动读取正文</small>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {activity.runs
        .filter((r) =>
          ["queued", "running", "recovery_required", "failed"].includes(
            r.state,
          ),
        )
        .slice(0, 3)
        .map((r) => (
          <div key={r.id} className="attachment-run">
            <span>
              AI 附件执行 ·{" "}
              {r.state === "queued"
                ? "排队中"
                : r.state === "running"
                  ? "执行中"
                  : r.state === "failed"
                    ? "未完成"
                    : r.deliveryState === "succeeded"
                      ? "投递已确认，执行记录需核对"
                      : "待核对"}
            </span>
            {r.error ? <small>{r.error}</small> : null}
            {["queued", "running"].includes(r.state) ? (
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void mutation("/runs/" + r.id + "/cancel", {})
                    .then(() => {
                      if (alive.current) {
                        void load();
                        setNotice("已请求停止；已发出的分享请核对回执。");
                      }
                    })
                    .catch((e) => {
                      if (alive.current) setError(e.message);
                    })
                    .finally(() => {
                      if (alive.current) setBusy(false);
                    });
                }}
              >
                停止附件执行
              </button>
            ) : null}
          </div>
        ))}
      {activity.sends.map((r) => (
        <div key={r.id} className="enterprise-recovery">
          <p>
            {r.name} · {r.state === "sending" ? "正在发送" : "发送结果待核对"}
          </p>
          <div>
            <button
              disabled={busy}
              onClick={() => void action(r.id, "reconcile")}
            >
              核对附件发送
            </button>
            {r.state === "recovery_required" ? (
              <button
                disabled={busy}
                onClick={() => void action(r.id, "acknowledge")}
              >
                已查看来源，继续发送
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {activity.history?.length ? (
        <details>
          <summary>最近附件回执 · {activity.history.length}</summary>
          {activity.history.map((r) => (
            <p key={r.id}>
              {r.name} ·{" "}
              {r.state === "succeeded"
                ? "来源已确认投递"
                : r.state === "failed"
                  ? "投递前被拒绝"
                  : r.state === "sending"
                    ? "发送中"
                    : "结果待核对"}
              {r.acknowledgedAt ? " · 已人工查看，结果未改写" : ""}
              {r.sourceMessageId ? " · 消息 " + r.sourceMessageId : ""}
            </p>
          ))}
        </details>
      ) : null}
      {open ? (
        <AttachmentComposer
          room={room}
          view={view}
          onClose={() => setOpen(false)}
          onDenied={(message) => {
            setOpen(false);
            setActivity({ sends: [], runs: [] });
            setReady(false);
            setError(message);
          }}
          onDone={(text) => {
            if (alive.current) {
              setOpen(false);
              setNotice(text);
              void load();
              onChange();
            }
          }}
        />
      ) : null}
    </section>
  );
}
function AttachmentComposer({
  room,
  view,
  onClose,
  onDone,
  onDenied,
}: {
  room: CommunicationRoom;
  view: WorkspaceView;
  onClose: () => void;
  onDone: (text: string) => void;
  onDenied: (message: string) => void;
}) {
  const [path, setPath] = useState<string[]>([]),
    [files, setFiles] = useState<SourceFile[]>([]),
    [selected, setSelected] = useState<SourceFile>(),
    [caption, setCaption] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const [project, setProject] = useState<{ conversationId: string } | null>(
      null,
    ),
    [models, setModels] = useState<ModelSummary[]>([]),
    [engine, setEngine] = useState("dsh"),
    [model, setModel] = useState(""),
    [mode, setMode] = useState("direct");
  const alive = useRef(true),
    seq = useRef(0);
  useEffect(() => {
    alive.current = true;
    let valid = true;
    Promise.all([
      api<{ project: { conversationId: string } | null }>(
        "/talk/rooms/" + room.id + "/project",
      ),
      api<ModelSummary[]>("/models"),
    ])
      .then(([p, m]) => {
        if (valid) {
          setProject(p.project);
          setModels(m.filter((v) => v.purpose === "chat"));
        }
      })
      .catch((e) => {
        if (valid) {
          setError(e.message);
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            onDenied(e.message);
        }
      });
    return () => {
      valid = false;
      alive.current = false;
      seq.current++;
    };
  }, [room.id]);
  useEffect(() => {
    const v = ++seq.current;
    setLoading(true);
    setFiles([]);
    setSelected(undefined);
    setConfirmed(false);
    void mutation<SourceFile[]>("/files/list", { path })
      .then((data) => {
        if (alive.current && v === seq.current) {
          setFiles(data);
          setError("");
        }
      })
      .catch((e) => {
        if (alive.current && v === seq.current) {
          setFiles([]);
          setSelected(undefined);
          setModels([]);
          setError(e.message);
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            onDenied(e.message);
        }
      })
      .finally(() => {
        if (alive.current && v === seq.current) setLoading(false);
      });
  }, [path]);
  function reset() {
    setConfirmed(false);
    setKey(crypto.randomUUID());
  }
  const canAi =
    !!project &&
    !!view.engines[engine]?.configured &&
    view.engines[engine]!.operations.includes("share_attachment");
  async function send() {
    if (!selected || !confirmed || busy || uncertain) return;
    setBusy(true);
    setError("");
    const plan: AttachmentSendPlan = {
      roomId: room.id,
      path: selected.path,
      expectedFileId: selected.id,
      expectedEtag: selected.etag,
      caption,
      confirmed: true,
    };
    try {
      if (mode === "ai") {
        if (!canAi) throw new Error("请关联项目并配置支持附件发送的执行器。");
        await mutation("/runs", {
          conversationId: project!.conversationId,
          engine,
          workflow: "share_attachment",
          attachmentPlan: plan,
          modelProfileId: model || undefined,
          instruction:
            "按员工确认的会话、源文件与说明发送附件；以实际回执报告结果，不读取文件正文。",
          idempotencyKey: key,
        });
        if (alive.current)
          onDone("AI 附件执行已创建；排队不表示已投递，请查看实际回执。");
      } else {
        const r = await mutation<AttachmentSendReceipt>(
          "/talk/rooms/" + room.id + "/attachments",
          { plan, idempotencyKey: key },
        );
        if (!alive.current) return;
        if (r.state === "failed") {
          setError("附件在投递前被拒绝，请重新读取文件后确认。");
          reset();
        } else
          onDone(
            r.state === "succeeded"
              ? "附件分享消息已回读；不表示收件人已阅读。"
              : "附件发送结果待核对，未自动重发。",
          );
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if (!(e instanceof ApiError) || e.status >= 500) {
          setUncertain(true);
          setConfirmed(false);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title="发送企业附件"
      dismissible={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
      error={error}
    >
      <p className="muted">
        目标会话：<strong>{room.name}</strong>
        。分享源文件的活引用；文件后续变化可见，既有更宽权限不会自动收紧。
      </p>
      {uncertain ? (
        <p role="status">
          请求结果未确认。请关闭窗口并核对附件发送记录，不要重复投递。
        </p>
      ) : null}
      <div className="attachment-file-browser">
        <div className="attachment-toolbar">
          <button
            disabled={busy || uncertain || !path.length}
            onClick={() => {
              reset();
              setPath((p) => p.slice(0, -1));
            }}
          >
            上一级
          </button>
          <button
            disabled={busy || uncertain || loading}
            onClick={() => {
              reset();
              setPath((p) => [...p]);
            }}
          >
            重新读取文件列表
          </button>
          <span>我的文件{path.length ? " / " + path.join(" / ") : ""}</span>
        </div>
        {loading ? <p>正在读取当前员工的文件…</p> : null}
        <ul>
          {files.map((f) => (
            <li key={JSON.stringify(f.path)}>
              <button
                className={selected?.id === f.id ? "selected" : ""}
                disabled={
                  busy ||
                  uncertain ||
                  (f.kind === "file" && f.size > 8 * 1024 * 1024)
                }
                onClick={() => {
                  reset();
                  if (f.kind === "directory") setPath(f.path);
                  else setSelected(f);
                }}
              >
                {f.kind === "directory" ? (
                  <Folder size={16} />
                ) : (
                  <Paperclip size={16} />
                )}
                <span>{f.name}</span>
                <small>
                  {f.kind === "directory"
                    ? "文件夹"
                    : (f.size / 1024).toFixed(1) + " KiB"}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected ? (
        <p>
          已选：<strong>{selected.name}</strong> · 文件 ID {selected.id} ·
          当前版本已固定用于发送前核验
        </p>
      ) : null}
      <div className="settings-form">
        <label>
          附件说明
          <textarea
            maxLength={2000}
            value={caption}
            disabled={busy || uncertain}
            onChange={(e) => {
              setCaption(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          附件执行方式
          <select
            disabled={busy || uncertain}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              reset();
            }}
          >
            <option value="direct">直接发送</option>
            <option value="ai" disabled={!project}>
              由 AI 执行
            </option>
          </select>
        </label>
        {mode === "ai" ? (
          <>
            <label>
              附件执行器
              <select
                disabled={busy || uncertain}
                value={engine}
                onChange={(e) => {
                  setEngine(e.target.value);
                  reset();
                }}
              >
                <option value="dsh">DSH</option>
                <option value="hermes">Hermes</option>
              </select>
            </label>
            <label>
              附件执行模型
              <select
                disabled={busy || uncertain}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  reset();
                }}
              >
                <option value="">可用默认对话连接</option>
                {models.map((m) => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={
                      !!view.engines[engine]?.modelProviders &&
                      !view.engines[engine]!.modelProviders!.includes(
                        m.provider,
                      )
                    }
                  >
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {!canAi ? (
              <small>当前执行器未配置或未声明附件发送能力。</small>
            ) : null}
          </>
        ) : null}
        {!project ? (
          <small>先通过“项目空间”关联此会话，可启用 AI 发送。</small>
        ) : null}
        <label className="check-row attachment-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || uncertain || !selected}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          确认向此会话分享所选文件，当前成员可按来源权限访问
        </label>
      </div>
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          关闭
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            loading ||
            uncertain ||
            !selected ||
            !confirmed ||
            (mode === "ai" && !canAi)
          }
          onClick={() => void send()}
        >
          {busy
            ? "正在处理…"
            : mode === "ai"
              ? "让 AI 发送附件"
              : "确认发送附件"}
        </button>
      </div>
    </Dialog>
  );
}
