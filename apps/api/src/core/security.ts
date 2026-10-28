import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function stableDigest(value: unknown) {
  return digest(JSON.stringify(value));
}
export class Vault {
  private key: Buffer;
  constructor(hex = process.env.CREDENTIAL_MASTER_KEY) {
    if (!hex || !/^[a-fA-F0-9]{64}$/.test(hex))
      throw new Error(
        "Configure a 32-byte CREDENTIAL_MASTER_KEY before saving credentials.",
      );
    this.key = Buffer.from(hex, "hex");
  }
  encrypt(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }
  decrypt(encoded: string) {
    const b = Buffer.from(encoded, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      b.subarray(0, 12),
    );
    decipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([
      decipher.update(b.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
}
export async function assertMember(db: Database, s: Subject) {
  const r = await db.pool.query(
    "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [s.workspaceId, s.id],
  );
  if (!r.rowCount)
    throw new ForbiddenException("Workspace access has been revoked.");
  return r.rows[0].role as Subject["role"];
}
export async function authenticate(
  db: Database,
  token?: string,
): Promise<Subject> {
  if (!token) throw new UnauthorizedException("请先登录工作区。");
  const r = await db.pool.query(
    'SELECT u.id,u.name,s.workspace_id AS "workspaceId",m.role,s.demo FROM cw_sessions s JOIN cw_users u ON u.id=s.user_id JOIN cw_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [digest(token)],
  );
  if (!r.rowCount) throw new UnauthorizedException("登录已过期或权限已撤销。");
  return r.rows[0] as Subject;
}
export async function issueSession(
  db: Database,
  userId: string,
  workspaceId: string,
  demo: boolean,
) {
  const token = randomBytes(32).toString("base64url");
  await db.pool.query(
    "INSERT INTO cw_sessions(token_hash,user_id,workspace_id,demo,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",
    [digest(token), userId, workspaceId, demo],
  );
  return token;
}
export function maskKey(secret: string) {
  return secret.length > 4 ? "••••" + secret.slice(-4) : "••••";
}
