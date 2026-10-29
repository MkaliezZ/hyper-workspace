import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { ApiError, mutation } from "../api";
interface LoginFlow {
  flowId: string;
  loginUrl: string;
  expiresAt: string;
}
export function Login({
  ready,
  status,
  error: parentError,
  onAuthenticated,
}: {
  ready: boolean;
  status?: { demoEnabled: boolean; nextcloudConfigured: boolean };
  error: string;
  onAuthenticated: () => Promise<void>;
}) {
  const [flow, setFlow] = useState<LoginFlow | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [paused, setPaused] = useState(false);
  const popup = useRef<Window | null>(null);
  const onSuccess = useRef(onAuthenticated);
  onSuccess.current = onAuthenticated;
  useEffect(() => {
    if (!flow || paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await mutation<{ state: "pending" | "complete" }>(
          "/auth/nextcloud/poll",
          { flowId: flow.flowId },
        );
        if (!alive) return;
        if (result.state === "complete") {
          popup.current?.close();
          setPaused(true);
          await onSuccess.current();
        } else timer = setTimeout(() => void poll(), 2000);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setPaused(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [flow, paused]);
  async function start() {
    setError("");
    setBusy(true);
    const opened = window.open("about:blank", "_blank");
    if (opened) opened.opener = null;
    popup.current = opened;
    try {
      const next = await mutation<LoginFlow>("/auth/nextcloud/start", {});
      setFlow(next);
      setPaused(false);
      if (opened) opened.location.replace(next.loginUrl);
    } catch (e) {
      opened?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!flow) return;
    setBusy(true);
    setPaused(true);
    setError("");
    try {
      await mutation("/auth/nextcloud/cancel", { flowId: flow.flowId });
      setFlow(null);
      popup.current?.close();
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        setFlow(null);
        popup.current?.close();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-brand">H</div>
      <h1>Hyper Workspace</h1>
      <p>让讨论有沉淀，让工作持续向前。</p>
      {error || parentError ? (
        <p className="error-text" role="alert">
          {error || parentError}
        </p>
      ) : null}
      {!ready ? (
        <p>正在连接工作区…</p>
      ) : (
        <div className="login-actions">
          {status?.nextcloudConfigured && !flow ? (
            <button
              className="primary login-button"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? <LoaderCircle size={18} /> : null}使用企业账号登录
              <ArrowRight size={18} />
            </button>
          ) : null}
          {flow ? (
            <>
              <p role="status">请在企业登录页面完成授权，然后回到这里。</p>
              <a
                className="login-link"
                href={flow.loginUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开企业登录页面
              </a>
              <div className="login-flow-buttons">
                {paused ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setPaused(false);
                    }}
                  >
                    重试查询
                  </button>
                ) : (
                  <span>
                    <LoaderCircle size={16} />
                    等待授权…
                  </span>
                )}
                <button disabled={busy} onClick={() => void cancel()}>
                  取消登录
                </button>
              </div>
              <small>登录有效期 10 分钟，账号密码在企业身份服务中输入。</small>
            </>
          ) : null}
          {status?.demoEnabled ? (
            <>
              <button
                className={
                  status.nextcloudConfigured
                    ? "login-button"
                    : "primary login-button"
                }
                disabled={busy || !!flow}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void mutation("/auth/demo", {})
                    .then(onAuthenticated)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                进入演示工作区
                <ArrowRight size={18} />
              </button>
              <small>使用独立演示资料，未连接企业数据。</small>
            </>
          ) : !status?.nextcloudConfigured ? (
            <small>工作区登录尚未配置，请联系管理员。</small>
          ) : null}
        </div>
      )}
    </div>
  );
}
