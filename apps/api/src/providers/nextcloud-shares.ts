import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { AttachmentSendPlan } from "@hyper/contracts";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";
/** OCS room sharing is a write. Even a 403 may follow a duplicate-share message event. */
export class NextcloudRoomShareProvider {
  constructor(
    private config: NextcloudConfig,
    private credentials: Pick<SourceCredentials, "loginName" | "appPassword">,
  ) {}
  async share(plan: AttachmentSendPlan, referenceId: string) {
    plan = AttachmentSendPlan.parse(plan);
    let response: Response;
    try {
      response = await fetch(
        this.config.transportUrl +
          "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Accept: "application/json",
            "OCS-APIRequest": "true",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Hyper Workspace/0.1",
            Authorization:
              "Basic " +
              Buffer.from(
                this.credentials.loginName + ":" + this.credentials.appPassword,
              ).toString("base64"),
          },
          body: new URLSearchParams({
            shareType: "10",
            shareWith: plan.roomId,
            path: "/" + plan.path.join("/"),
            permissions: "1",
            referenceId,
            talkMetaData: JSON.stringify({
              messageType: "comment",
              caption: plan.caption,
            }),
          }),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "附件分享响应无法确认，请核对来源，勿重复发送。",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceUnavailableException(
        "附件分享结果无法确认，请核对来源。",
      );
    }
    // Bound response bytes and retain only a non-secret share ID, never the public token/link.
    let size = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceUnavailableException("附件分享响应无效。");
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.length;
        if (size > 65536) throw new Error();
        chunks.push(p.value);
      }
    } catch {
      throw new ServiceUnavailableException("附件分享响应无效。");
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const code = value?.ocs?.meta?.statuscode;
      if (
        code !== 100 &&
        !(Number.isInteger(code) && code >= 200 && code < 300)
      )
        throw new Error();
      return z
        .union([
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          z.string().regex(/^(?:ocRoomShare:)?[1-9][0-9]{0,19}$/),
        ])
        .transform(String)
        .parse(value.ocs.data.id);
    } catch {
      throw new ServiceUnavailableException("附件分享响应无效，请核对来源。");
    }
  }
}
