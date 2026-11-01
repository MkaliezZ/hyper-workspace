import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function main() {
  const lock = JSON.parse(
    await readFile(
      new URL("./embedding-model.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        repository: lock.repository,
        revision: lock.revision,
        bytes: lock.files.reduce((n, f) => n + f.bytes, 0),
        execute:
          "--execute downloads only the pinned, separately cached evaluation weights",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--execute")
    throw Error("Invalid arguments");
  for (const file of lock.files) {
    const target = resolve(".runtime/embedding-eval/model", file.path);
    const valid = (data) =>
      data.length === file.bytes &&
      createHash("sha256").update(data).digest("hex") === file.sha256;
    const existing = await readFile(target).catch(() => null);
    if (existing && valid(existing)) continue;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(
        `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${file.path}`,
        { signal: controller.signal },
      );
      if (!response.ok || !response.body)
        throw Error("Pinned model download unavailable");
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > file.bytes) {
          controller.abort();
          throw Error("Model exceeds pinned byte count");
        }
        parts.push(part);
      }
      const data = Buffer.concat(parts);
      if (!valid(data)) throw Error("Pinned model digest mismatch");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const partial = target + ".partial";
      try {
        await writeFile(partial, data, { mode: 0o600 });
        await rename(partial, target);
      } finally {
        await rm(partial, { force: true });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(
    JSON.stringify({
      status: "verified",
      revision: lock.revision,
      files: lock.files.length,
    }),
  );
}
main().catch(() => {
  console.error(
    "Embedding model preparation failed; pinned sizes and digests remain required.",
  );
  process.exitCode = 1;
});
