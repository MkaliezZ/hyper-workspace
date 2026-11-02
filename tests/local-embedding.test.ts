import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalEmbeddingConfig,
  readLocalEmbeddingConfig,
} from "../runtime/evaluations/local-config.mjs";

test("Local model configuration creates a private random capability and repeated initialization preserves it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-local-model-")),
    file = join(dir, "config.json");
  try {
    const first = await createLocalEmbeddingConfig(file),
      second = await createLocalEmbeddingConfig(file);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.ok(/^[a-f0-9]{64}$/.test(first.credential));
    assert.ok(
      first.credential === second.credential &&
        first.serviceId === second.serviceId,
    );
    assert.equal(first.port, 3116);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Local model configuration rejects permissive files and symbolic links without overwriting existing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-local-model-")),
    file = join(dir, "config.json");
  try {
    await createLocalEmbeddingConfig(file);
    const before = await readFile(file, "utf8");
    await chmod(file, 0o644);
    await assert.rejects(createLocalEmbeddingConfig(file), /Private owned/);
    assert.ok((await readFile(file, "utf8")) === before);
    await chmod(file, 0o600);
    const link = join(dir, "link.json");
    await symlink(file, link);
    await assert.rejects(readLocalEmbeddingConfig(link), /Private owned/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Local model configuration rejects privileged or invalid ports and malformed capability data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-local-model-")),
    file = join(dir, "config.json");
  try {
    await assert.rejects(
      createLocalEmbeddingConfig(file, 80),
      /Invalid local service port/,
    );
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        port: 0,
        serviceId: "invalid",
        credential: "invalid",
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      readLocalEmbeddingConfig(file),
      /Invalid service configuration/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
