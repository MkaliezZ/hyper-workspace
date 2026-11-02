import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import { MessageSearchInput } from "@hyper/contracts/room-management";
import type { Database } from "../db/database.js";
import { sourceConnection } from "./source-connection.js";
import { stableDigest } from "./credentials.js";
import {
  NextcloudTalkProvider,
  TalkToken,
} from "../providers/nextcloud-talk.js";
import { z } from "zod";
export function communicationBinding(
  source: Awaited<ReturnType<typeof sourceConnection>>,
) {
  const directoryBinding = stableDigest({
    provider: source.config.providerKey,
    transportUrl: source.config.transportUrl,
    workspaceId: source.config.workspaceId,
    group: source.config.memberGroup,
  });
  return stableDigest({ directoryBinding, uid: source.remoteUid });
}

/** Live employee-scoped history search; no message index or cached result store. */
export class CommunicationSearchService {
  constructor(private db: Database) {}
  async search(s: Subject, roomId: string, raw: unknown, bindingRef: string) {
    const input = MessageSearchInput.parse(raw);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(bindingRef);
    TalkToken.parse(roomId);
    if (process.env.NEXTCLOUD_TALK_ENABLED !== "true")
      throw new ServiceUnavailableException("企业消息搜索尚未启用。");
    const source = await sourceConnection(this.db, s);
    if (communicationBinding(source) !== bindingRef)
      throw new ConflictException("搜索来源已变化，请重新读取会话。");
    const binding = (value: typeof source) =>
      stableDigest({
        config: value.config,
        uid: value.remoteUid,
        login: value.credentials.loginName,
      });
    const result = await new NextcloudTalkProvider(
      source.config,
      source.credentials,
      source.remoteUid,
    ).search(roomId, input);
    const current = await sourceConnection(this.db, s);
    if (binding(current) !== binding(source))
      throw new ConflictException("搜索来源已变化，未返回先前内容。");
    await new NextcloudTalkProvider(
      current.config,
      current.credentials,
      current.remoteUid,
    ).room(roomId);
    return result;
  }
}
