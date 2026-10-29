import { randomBytes } from "node:crypto";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import type { PoolClient } from "pg";
import { digest } from "./credentials.js";
import { verifySourceAccess } from "./identity-access.js";
export async function assertMember(db: Database, s: Subject) {
  const r = await db.pool.query(
    "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [s.workspaceId, s.id],
  );
  if (!r.rowCount)
    throw new ForbiddenException("Workspace access has been revoked.");
  if (s.identityCredentialId) await verifySourceAccess(db, s);
  const current = await db.pool.query(
    "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [s.workspaceId, s.id],
  );
  if (!current.rowCount)
    throw new ForbiddenException(
      "工作区权限已撤销。开发者或管理员需重新授权。",
    );
  return current.rows[0].role as Subject["role"];
}
export async function authenticate(
  db: Database,
  token?: string,
): Promise<Subject> {
  if (!token) throw new UnauthorizedException("请先登录工作区。");
  const r = await db.pool.query(
    'SELECT u.id,u.name,s.workspace_id AS "workspaceId",m.role,s.demo,s.identity_credential_id AS "identityCredentialId" FROM cw_sessions s JOIN cw_users u ON u.id=s.user_id JOIN cw_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [digest(token)],
  );
  if (!r.rowCount) throw new UnauthorizedException("登录已过期或权限已撤销。");
  const s = r.rows[0] as Subject;
  s.role = await assertMember(db, s);
  return s;
}
export async function issueSession(
  db: Database,
  userId: string,
  workspaceId: string,
  demo: boolean,
  identityCredentialId?: string,
  client?: PoolClient,
) {
  const token = randomBytes(32).toString("base64url");
  await (client ?? db.pool).query(
    "INSERT INTO cw_sessions(token_hash,user_id,workspace_id,demo,identity_credential_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '12 hours')",
    [digest(token), userId, workspaceId, demo, identityCredentialId ?? null],
  );
  return token;
}
