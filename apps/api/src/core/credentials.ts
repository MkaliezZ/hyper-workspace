import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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
export function maskKey(secret: string) {
  return secret.length > 4 ? "••••" + secret.slice(-4) : "••••";
}
