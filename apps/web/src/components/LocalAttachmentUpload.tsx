import { useEffect, useRef, useState } from "react";
import type { AttachmentUploadReceipt, SourceFile } from "@hyper/contracts";
import { api, ApiError, mutation } from "../api";
export function LocalAttachmentUpload({
  roomId,
  disabled,
  onBusy,
  onSelected,
  onInputChange,
  onDenied,
}: {
  roomId: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSelected: (file: SourceFile) => void;
  onInputChange: () => void;
  onDenied: (message: string) => void;
}) {
  const [file, setFile] = useState<File>(),
    [confirmed, setConfirmed] = useState(false),
    [records, setRecords] = useState<AttachmentUploadReceipt[]>([]),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    sequence = useRef(0),
    key = useRef(crypto.randomUUID()),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file && input.current) input.current.value = "";
  }, [file]);
  const pending = records.some(
    (r) =>
      ["prepared", "uploading", "recovery_required"].includes(r.state) &&
      !r.acknowledgedAt,
  );
  async function load() {
    const seq = ++sequence.current;
    try {
      const data = await api<AttachmentUploadReceipt[]>(
        "/talk/rooms/" + roomId + "/attachment-uploads",
      );
      if (alive.current && seq === sequence.current) {
        setRecords(data);
        setReady(true);
        setUncertain(false);
      }
    } catch (e) {
      if (alive.current && seq === sequence.current) {
        setRecords([]);
        setReady(false);
        setFile(undefined);
        setConfirmed(false);
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          onDenied(e.message);
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
  }, [roomId]);
  function working(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  function accept(r: AttachmentUploadReceipt) {
    setConfirmed(false);
    if (r.state === "succeeded" && r.file) {
      onSelected(r.file);
      setFile(undefined);
      setConfirmed(false);
      setNotice(
        "文件已保存到你的企业 Files 并选中；尚未分享到会话，请在下方确认发送。",
      );
    } else
      setNotice(
        r.state === "succeeded"
          ? "上传曾成功，但原件已变化或不可读，请重新选择当前文件。"
          : r.state === "failed"
            ? "上传未完成；未分享到会话。"
            : "上传结果待核对；没有自动重传，也未分享到会话。",
      );
  }
  async function upload() {
    if (
      !file ||
      busy ||
      disabled ||
      !confirmed ||
      !ready ||
      pending ||
      uncertain
    )
      return;
    working(true);
    setError("");
    setNotice("");
    try {
      if (file.size < 1 || file.size > 8 * 1024 * 1024)
        throw new Error("请选择 1 字节至 8 MiB 的文件。");
      const bytes = await file.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      if (!alive.current) return;
      const intent = await mutation<AttachmentUploadReceipt>(
        "/talk/attachment-uploads",
        {
          roomId,
          name: file.name,
          size: file.size,
          sha256: hash,
          confirmed: true,
          idempotencyKey: key.current,
        },
      );
      if (!alive.current) return;
      const result =
        intent.state === "prepared"
          ? await api<AttachmentUploadReceipt>(
              "/talk/attachment-uploads/" + intent.id + "/content",
              {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: bytes,
              },
            )
          : intent;
      if (alive.current) {
        accept(result);
        key.current = crypto.randomUUID();
        await load();
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        setConfirmed(false);
        if (!(e instanceof ApiError) || e.status >= 500) setUncertain(true);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          onDenied(e.message);
        // Refresh is a GET only. Even after a transport error, never issue another PUT automatically.
        await load();
      }
    } finally {
      if (alive.current) working(false);
    }
  }
  async function action(
    id: string,
    operation: "reconcile" | "release" | "select",
  ) {
    working(true);
    setError("");
    try {
      const r =
        operation === "select"
          ? await api<AttachmentUploadReceipt>("/talk/attachment-uploads/" + id)
          : await mutation<AttachmentUploadReceipt>(
              "/talk/attachment-uploads/" + id + "/" + operation,
              {},
            );
      if (alive.current) {
        accept(r);
        setFile(undefined);
        setConfirmed(false);
        await load();
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          onDenied(e.message);
      }
    } finally {
      if (alive.current) working(false);
    }
  }
  return (
    <section className="local-attachment-upload" aria-label="本机文件上传">
      <h3>从本机上传</h3>
      <p className="muted">
        先保存到你自己的企业 Files
        根目录，添加唯一编号避免覆盖同名文件。不会自动分享到会话或将正文交给模型。
      </p>
      <label>
        选择本机附件
        <input
          type="file"
          ref={input}
          disabled={disabled || busy || !ready || pending || uncertain}
          onChange={(e) => {
            onInputChange();
            const picked = e.target.files?.[0];
            setConfirmed(false);
            setNotice("");
            setError("");
            key.current = crypto.randomUUID();
            if (picked && (picked.size < 1 || picked.size > 8 * 1024 * 1024)) {
              setFile(undefined);
              setError("请选择 1 字节至 8 MiB 的文件。");
            } else setFile(picked);
          }}
        />
      </label>
      {file ? (
        <p>
          待上传：{file.name} · {(file.size / 1024).toFixed(1)} KiB
        </p>
      ) : null}
      <label className="check-row attachment-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || busy || !file || pending || uncertain}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        确认将此文件保存到我的企业 Files
      </label>
      <div className="attachment-toolbar">
        <button
          className="primary"
          disabled={
            disabled ||
            busy ||
            !file ||
            !confirmed ||
            !ready ||
            pending ||
            uncertain
          }
          onClick={() => void upload()}
        >
          {busy ? "正在处理上传…" : "上传并选中"}
        </button>
        <button disabled={disabled || busy} onClick={() => void load()}>
          核对上传记录
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {uncertain ? <p>请求未确认，请先读取上传记录；不会自动重传。</p> : null}
      {records
        .filter((r) => !["failed"].includes(r.state))
        .slice(0, 4)
        .map((r) => (
          <div key={r.id} className="enterprise-recovery">
            <p>
              {r.name} ·{" "}
              {r.state === "prepared"
                ? "已准备，尚未上传"
                : r.state === "uploading"
                  ? "上传中"
                  : r.state === "succeeded"
                    ? "已保存到企业 Files"
                    : "上传结果待核对"}
              {r.acknowledgedAt ? " · 已人工查看，结果未改写" : ""}
            </p>
            {r.state === "prepared" ? (
              <button
                disabled={disabled || busy}
                onClick={() => void action(r.id, "release")}
              >
                放弃未开始的上传
              </button>
            ) : null}
            {r.state === "recovery_required" ? (
              <>
                <button
                  disabled={disabled || busy}
                  onClick={() => void action(r.id, "reconcile")}
                >
                  核对原件，不重传
                </button>
                {!r.acknowledgedAt ? (
                  <button
                    disabled={disabled || busy}
                    onClick={() => void action(r.id, "release")}
                  >
                    已查看来源，允许新上传
                  </button>
                ) : null}
              </>
            ) : null}
            {r.state === "succeeded" ? (
              <button
                disabled={disabled || busy}
                onClick={() => void action(r.id, "select")}
              >
                选中此上传文件
              </button>
            ) : null}
          </div>
        ))}
    </section>
  );
}
