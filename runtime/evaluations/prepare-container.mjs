import { mkdir, readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { verifyEmbeddingModel } from "./embedding-runtime.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        execute:
          "--execute copies only verified public model files into a separate Docker build context",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--execute")
    throw Error("Invalid arguments");
  const cache = resolve(root, ".runtime/embedding-eval"),
    output = resolve(root, ".runtime/embedding-build-source"),
    owner = output + ".owner.json";
  const lock = await verifyEmbeddingModel(cache);
  async function validateContext() {
    const expected = new Set(lock.files.map((file) => "model/" + file.path));
    async function walk(relative = "") {
      for (const name of await readdir(resolve(output, relative))) {
        const path = relative ? relative + "/" + name : name;
        const info = await lstat(resolve(output, path));
        if (info.isSymbolicLink())
          throw Error("Build context cannot contain symbolic links");
        if (info.isDirectory()) {
          if (![...expected].some((file) => file.startsWith(path + "/")))
            throw Error("Unexpected build context directory");
          await walk(path);
        } else if (!info.isFile() || !expected.has(path))
          throw Error("Unexpected build context file");
      }
    }
    await walk();
    await verifyEmbeddingModel(output);
  }
  try {
    await mkdir(output, { mode: 0o700 });
    await writeFile(owner, JSON.stringify({ checkout: root }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(output),
      ownership = JSON.parse(await readFile(owner, "utf8"));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) ||
      ownership.checkout !== root
    )
      throw Error("Existing build context belongs to another source");
    await validateContext();
    console.log("Verified public model build context already prepared.");
    return;
  }
  for (const file of lock.files) {
    const destination = resolve(output, "model", file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const bytes = await readFile(resolve(cache, "model", file.path));
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw Error("Public model changed before copying");
    await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  }
  await validateContext();
  console.log(
    "Prepared .runtime/embedding-build-source using only pinned public model files.",
  );
}
main().catch(() => {
  console.error(
    "Model build context preparation failed; existing configuration and credentials were not copied.",
  );
  process.exitCode = 1;
});
