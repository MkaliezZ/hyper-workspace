import { randomBytes, randomUUID } from "node:crypto";
import {
  ForbiddenException,
  GoneException,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { DEMO, type Database } from "../db/database.js";
import { digest, Vault } from "./credentials.js";
import { revokeMappedMembership } from "./identity-access.js";
import { issueSession } from "./security.js";
import {
  requireNextcloud,
  NextcloudIdentityProvider,
  type SourceCredentials,
} from "../providers/nextcloud.js";

class SourceMembershipDenied extends ForbiddenException {
  constructor(readonly remoteUid: string) {
    super("此账号不在工作区允许的企业群组内。");
  }
}

export class IdentityService {
  constructor(private db: Database) {}
  async start(existingBinding?: string) {
    const config = requireNextcloud();
    if (config.workspaceId === DEMO.workspace)
      throw new ServiceUnavailableException(
        "企业登录必须使用独立工作区，不能连接演示资料。",
      );
    const binding =
      existingBinding && /^[\w-]{43}$/.test(existingBinding)
        ? existingBinding
        : randomBytes(32).toString("base64url");
    const vault = new Vault();
    const result = await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(246813580)");
      await c.query("DELETE FROM cw_login_flows WHERE expires_at<=now()");
      const count = (
        await c.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE binding_hash=$1)::int AS browser FROM cw_login_flows WHERE session_token_enc IS NULL",
          [digest(binding)],
        )
      ).rows[0];
      if (count.total >= 100 || count.browser >= 5)
        throw new HttpException(
          "待完成登录过多，请关闭旧登录或稍后重试。",
          429,
        );
      const workspace = await c.query(
        "SELECT id FROM cw_workspaces WHERE id=$1",
        [config.workspaceId],
      );
      if (!workspace.rowCount)
        throw new ServiceUnavailableException(
          "企业工作区尚未初始化，请联系管理员。",
        );
      const flow = await new NextcloudIdentityProvider(config).start();
      const id = randomUUID();
      const row = (
        await c.query(
          "INSERT INTO cw_login_flows(id,binding_hash,provider_key,workspace_id,poll_token_enc) VALUES($1,$2,$3,$4,$5) RETURNING expires_at",
          [
            id,
            digest(binding),
            config.providerKey,
            config.workspaceId,
            vault.encrypt(flow.pollToken),
          ],
        )
      ).rows[0];
      return { flowId: id, loginUrl: flow.loginUrl, expiresAt: row.expires_at };
    });
    return { ...result, binding };
  }
  private async flow(
    c: import("pg").PoolClient,
    id: string,
    binding: string | undefined,
  ) {
    if (!binding)
      throw new ForbiddenException("此登录不属于当前浏览器，请重新发起。");
    const flow = (
      await c.query(
        "SELECT * FROM cw_login_flows WHERE id=$1 AND binding_hash=$2 AND expires_at>now() FOR UPDATE",
        [id, digest(binding)],
      )
    ).rows[0];
    if (!flow) throw new GoneException("登录已过期或已取消，请重新发起。");
    const config = requireNextcloud();
    if (
      flow.provider_key !== config.providerKey ||
      flow.workspace_id !== config.workspaceId
    )
      throw new GoneException("工作区登录配置已更改，请重新发起。");
    return flow;
  }
  async poll(
    id: string,
    binding?: string,
  ): Promise<{ state: "pending" } | { state: "complete"; session: string }> {
    const config = requireNextcloud(),
      provider = new NextcloudIdentityProvider(config),
      vault = new Vault();
    // Commit a consumed one-shot poll response before querying source membership. A transient
    // source error can then be retried without losing the issued app password.
    const ready = await this.db.tx(async (c) => {
      const flow = await this.flow(c, id, binding);
      if (flow.session_token_enc || flow.upstream_credentials_enc) return true;
      if (new Date(flow.next_poll_at).getTime() > Date.now()) return false;
      const credentials = await provider.poll(
        vault.decrypt(flow.poll_token_enc),
      );
      await c.query(
        "UPDATE cw_login_flows SET next_poll_at=now()+interval '2 seconds',upstream_credentials_enc=$2,poll_token_enc=CASE WHEN $2::text IS NULL THEN poll_token_enc ELSE NULL END WHERE id=$1",
        [id, credentials ? vault.encrypt(JSON.stringify(credentials)) : null],
      );
      return !!credentials;
    });
    if (!ready) return { state: "pending" };
    try {
      return await this.db.tx(async (c) => {
        const flow = await this.flow(c, id, binding);
        if (flow.session_token_enc) {
          const session = vault.decrypt(flow.session_token_enc);
          const live = await c.query(
            "SELECT token_hash FROM cw_sessions WHERE token_hash=$1 AND expires_at>now()",
            [digest(session)],
          );
          if (!live.rowCount)
            throw new GoneException("此登录已注销，请重新发起。");
          return { state: "complete" as const, session };
        }
        const credentials = JSON.parse(
          vault.decrypt(flow.upstream_credentials_enc),
        ) as SourceCredentials;
        provider.validateServer(credentials.server);
        const remote = await provider.current(credentials);
        if (!remote.groups.includes(config.memberGroup))
          throw new SourceMembershipDenied(remote.uid);
        // All concurrent first logins for this source identity share one product user.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          config.providerKey + config.workspaceId + remote.uid,
        ]);
        let identity = (
          await c.query(
            "SELECT * FROM cw_external_identities WHERE provider_key=$1 AND workspace_id=$2 AND remote_uid=$3",
            [config.providerKey, config.workspaceId, remote.uid],
          )
        ).rows[0];
        if (!identity) {
          const userId = randomUUID(),
            identityId = randomUUID();
          await c.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
            userId,
            remote.name,
          ]);
          await c.query(
            "INSERT INTO cw_external_identities(id,provider_key,workspace_id,remote_uid,user_id) VALUES($1,$2,$3,$4,$5)",
            [
              identityId,
              config.providerKey,
              config.workspaceId,
              remote.uid,
              userId,
            ],
          );
          await c.query(
            "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
            [
              config.workspaceId,
              userId,
              config.bootstrapAdminIds.includes(remote.uid)
                ? "admin"
                : "member",
            ],
          );
          identity = { id: identityId, user_id: userId };
        }
        const member = await c.query(
          "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [config.workspaceId, identity.user_id],
        );
        if (!member.rowCount)
          throw new ForbiddenException(
            "此账号的产品权限已撤销，请联系管理员恢复。",
          );
        await c.query("UPDATE cw_users SET name=$2 WHERE id=$1", [
          identity.user_id,
          remote.name,
        ]);
        await c.query(
          "UPDATE cw_external_identities SET verified_at=now() WHERE id=$1",
          [identity.id],
        );
        const credentialId = randomUUID();
        await c.query(
          "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc) VALUES($1,$2,$3,$4)",
          [
            credentialId,
            identity.id,
            credentials.loginName,
            vault.encrypt(credentials.appPassword),
          ],
        );
        const session = await issueSession(
          this.db,
          identity.user_id,
          config.workspaceId,
          false,
          credentialId,
          c,
        );
        await c.query(
          "UPDATE cw_login_flows SET session_token_enc=$2,identity_credential_id=$3,upstream_credentials_enc=NULL,poll_token_enc=NULL WHERE id=$1",
          [id, vault.encrypt(session), credentialId],
        );
        return { state: "complete" as const, session };
      });
    } catch (error) {
      // Persist revocation after the failed login transaction rolls back. This also handles
      // group removal first observed on a new device, before any old device makes a request.
      if (error instanceof SourceMembershipDenied)
        await revokeMappedMembership(this.db, config, error.remoteUid);
      throw error;
    }
  }
  async cancel(id: string, binding?: string) {
    return this.db.tx(async (c) => {
      const flow = await this.flow(c, id, binding);
      let sessionHash: string | undefined;
      if (flow.session_token_enc) {
        sessionHash = digest(new Vault().decrypt(flow.session_token_enc));
        await c.query("DELETE FROM cw_sessions WHERE token_hash=$1", [
          sessionHash,
        ]);
        if (flow.identity_credential_id)
          await c.query(
            "UPDATE cw_identity_credentials SET disabled_at=now(),credential_enc='' WHERE id=$1",
            [flow.identity_credential_id],
          );
      }
      await c.query("DELETE FROM cw_login_flows WHERE id=$1", [id]);
      return sessionHash;
    });
  }
}
