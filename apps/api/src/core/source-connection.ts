import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { Vault } from "./credentials.js";
import { requireNextcloud } from "../providers/nextcloud.js";
/** Backend-only employee connection, revalidated against source and product membership. */
export async function sourceConnection(db: Database, subject: Subject) {
  if (subject.demo || !subject.identityCredentialId)
    throw new ForbiddenException("请使用企业账号登录后访问企业消息。");
  await assertMember(db, subject);
  const config = requireNextcloud();
  const row = (
    await db.pool.query(
      "SELECT c.login_name,c.credential_enc,i.remote_uid,i.provider_key FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND c.disabled_at IS NULL",
      [subject.identityCredentialId, subject.id, subject.workspaceId],
    )
  ).rows[0];
  if (
    !row ||
    row.provider_key !== config.providerKey ||
    subject.workspaceId !== config.workspaceId
  )
    throw new UnauthorizedException("来源身份已失效，请重新登录。");
  return {
    config,
    remoteUid: row.remote_uid as string,
    credentials: {
      loginName: row.login_name as string,
      appPassword: new Vault().decrypt(row.credential_enc),
    },
  };
}
