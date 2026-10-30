import { Download, ExternalLink, FileText } from "lucide-react";
import type { CommunicationAttachment } from "@hyper/contracts";

export function MessageAttachments({
  roomId,
  messageId,
  attachments,
  filesEnabled,
}: {
  roomId: string;
  messageId: string;
  attachments: CommunicationAttachment[];
  filesEnabled: boolean;
}) {
  return (
    <ul className="message-attachments" aria-label="消息附件">
      {attachments.map((file) => {
        const base =
          "/api/talk/rooms/" +
          encodeURIComponent(roomId) +
          "/messages/" +
          encodeURIComponent(messageId) +
          "/attachments/" +
          encodeURIComponent(file.id);
        const query = "?etag=" + encodeURIComponent(file.etag);
        return (
          <li key={file.id}>
            <FileText size={22} aria-hidden="true" />
            <div className="attachment-details">
              <strong>{file.name}</strong>
              <small>
                {file.size < 1024
                  ? file.size + " B"
                  : file.size < 1024 * 1024
                    ? (file.size / 1024).toFixed(1) + " KiB"
                    : (file.size / 1024 / 1024).toFixed(1) + " MiB"}{" "}
                · {file.mime}
              </small>
              <div className="attachment-actions">
                <a
                  href={base + "/open" + query}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={"在来源中查看 " + file.name}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  在来源中查看
                </a>
                {filesEnabled && file.downloadable ? (
                  <a
                    href={base + "/download" + query}
                    aria-label={"下载 " + file.name}
                  >
                    <Download size={14} aria-hidden="true" />
                    下载
                  </a>
                ) : (
                  <span>请在来源中查看下载选项</span>
                )}
              </div>
            </div>
          </li>
        );
      })}
      <li className="attachment-note">
        附件指向源文件的当前版本；AI 尚未读取附件正文。
      </li>
    </ul>
  );
}
