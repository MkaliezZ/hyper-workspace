import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function readLocalEmbeddingConfig(path) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Private owned service configuration required");
  if (stat.size > 4096) throw Error("Service configuration too large");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.credential) ||
    !/^[a-f0-9-]{36}$/.test(value.serviceId) ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535
  )
    throw Error("Invalid service configuration");
  return value;
}
export async function createLocalEmbeddingConfig(path, port = 3116) {
  try {
    return await readLocalEmbeddingConfig(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid local service port");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  const value = {
    version: 1,
    serviceId: randomUUID(),
    port,
    credential: randomBytes(32).toString("hex"),
  };
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  return value;
}
