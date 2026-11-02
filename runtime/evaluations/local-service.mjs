import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  embeddingRuntime,
  embeddingModel,
  inputCharacters,
  verifyEmbeddingModel,
} from "./embedding-runtime.mjs";
import {
  createLocalEmbeddingConfig,
  readLocalEmbeddingConfig,
} from "./local-config.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  directory = resolve(root, ".runtime/local-embedding");
const configPath = resolve(directory, "config.json"),
  label = "com.hyperworkspace.embedding";
const serviceHome = resolve(
    homedir(),
    "Library/Application Support/Hyper Workspace/embedding",
  ),
  deployedScript = resolve(
    serviceHome,
    "runtime/evaluations/local-service.mjs",
  );
const target = "gui/" + process.getuid?.() + "/" + label;
const plistPath = resolve(
  homedir(),
  "Library/LaunchAgents/" + label + ".plist",
);
const xml = (v) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
async function ownsPlist(plist) {
  if (
    plist.includes(xml(fileURLToPath(import.meta.url))) &&
    plist.includes(xml(root))
  )
    return true;
  if (!plist.includes(xml(deployedScript))) return false;
  const owner = JSON.parse(
    await readFile(resolve(serviceHome, "owner.json"), "utf8"),
  );
  return owner.checkout === root;
}
const loaded = () => {
  try {
    execFileSync("launchctl", ["print", target], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};
async function healthy(config) {
  try {
    const r = await fetch("http://127.0.0.1:" + config.port + "/health", {
      signal: AbortSignal.timeout(2000),
    });
    const body = await r.json();
    return (
      r.ok &&
      body.serviceId === config.serviceId &&
      body.model === embeddingModel &&
      body.inputCharacters === inputCharacters
    );
  } catch {
    return false;
  }
}
async function main() {
  const args = process.argv.slice(2),
    option = args[0];
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        model: embeddingModel,
        inputCharacters,
        configuration: ".runtime/local-embedding/config.json",
        operations: [
          "--init",
          "--serve",
          "--install",
          "--restart",
          "--status",
          "--stop",
        ],
      }),
    );
    return;
  }
  if (
    args.length !== 1 ||
    ![
      "--init",
      "--serve",
      "--install",
      "--restart",
      "--status",
      "--stop",
    ].includes(option)
  )
    throw Error("Invalid arguments");
  if (
    ["--install", "--restart", "--stop"].includes(option) &&
    process.platform !== "darwin"
  )
    throw Error("Use --serve on this platform");
  if (option === "--init") {
    const config = await createLocalEmbeddingConfig(configPath);
    console.log(
      JSON.stringify({
        status: "initialized",
        port: config.port,
        model: embeddingModel,
        inputCharacters,
      }),
    );
    return;
  }
  if (option === "--stop") {
    if (process.platform !== "darwin")
      throw Error("Use the foreground process lifecycle on this platform");
    const plist = await readFile(plistPath, "utf8");
    if (!(await ownsPlist(plist))) throw Error("Service ownership mismatch");
    if (loaded())
      execFileSync("launchctl", ["bootout", target], { stdio: "pipe" });
    console.log(
      JSON.stringify({ status: "stopped", configurationRetained: true }),
    );
    return;
  }
  const config =
    option === "--install"
      ? await createLocalEmbeddingConfig(configPath)
      : await readLocalEmbeddingConfig(configPath);
  if (option === "--status") {
    console.log(
      JSON.stringify({
        status: (await healthy(config)) ? "ready" : "not-ready",
        model: embeddingModel,
        port: config.port,
        inputCharacters,
        launchdLoaded: process.platform === "darwin" && loaded(),
      }),
    );
    return;
  }
  if (option === "--serve") {
    const runtime = await embeddingRuntime({
      cache: resolve(root, ".runtime/embedding-eval"),
      credential: config.credential,
      serviceId: config.serviceId,
      port: config.port,
    });
    await writeFile(
      resolve(directory, "server.json"),
      JSON.stringify({
        pid: process.pid,
        endpoint: runtime.endpoint,
        model: embeddingModel,
        inputCharacters,
        serviceId: config.serviceId,
      }) + "\n",
      { mode: 0o600 },
    );
    console.log("Hyper Workspace local embedding ready on loopback.");
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(
        signal,
        () =>
          void runtime.close().then(() => {
            process.exitCode = 0;
          }),
      );
    return;
  }
  if (process.platform !== "darwin")
    throw Error(
      "Login service installation currently supports macOS only; use --serve on other hosts",
    );
  await verifyEmbeddingModel(resolve(root, ".runtime/embedding-eval"));
  const dependency = JSON.parse(
    await readFile(
      resolve(
        root,
        "runtime/evaluations/node_modules/@huggingface/transformers/package.json",
      ),
      "utf8",
    ),
  );
  if (dependency.version !== "3.8.1")
    throw Error("Install locked local model dependencies");
  const old = await readFile(plistPath, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (old && !(await ownsPlist(old)))
    throw Error("Existing service belongs to another checkout");
  if (loaded()) {
    if (option === "--install" && (await healthy(config))) {
      console.log(
        JSON.stringify({
          status: "ready",
          model: embeddingModel,
          port: config.port,
          inputCharacters,
          startsAtLogin: true,
          update: "Use --restart to deploy changes",
        }),
      );
      return;
    }
    // Stop before replacing native libraries mapped by the deployed process.
    execFileSync("launchctl", ["bootout", target], { stdio: "pipe" });
    for (let n = 0; n < 40 && (await healthy(config)); n++)
      await new Promise((r) => setTimeout(r, 250));
    if (await healthy(config)) throw Error("Previous service did not stop");
  }
  // LaunchAgents cannot reliably access a checkout in macOS Documents. Deploy
  // an owned private runtime outside protected user folders, including weights.
  await mkdir(serviceHome, { recursive: true, mode: 0o700 });
  const deployedStat = await lstat(serviceHome);
  if (
    !deployedStat.isDirectory() ||
    deployedStat.isSymbolicLink() ||
    deployedStat.uid !== process.getuid() ||
    (deployedStat.mode & 0o077) !== 0
  )
    throw Error("Private owned deployment directory required");
  const ownerPath = resolve(serviceHome, "owner.json");
  const owner = await readFile(ownerPath, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (owner && JSON.parse(owner).checkout !== root)
    throw Error("Deployed service belongs to another checkout");
  await writeFile(ownerPath, JSON.stringify({ checkout: root }) + "\n", {
    mode: 0o600,
  });
  const deployedDirectory = resolve(serviceHome, ".runtime/local-embedding");
  await mkdir(deployedDirectory, { recursive: true, mode: 0o700 });
  const deployedConfigPath = resolve(deployedDirectory, "config.json");
  const existingConfig = await readLocalEmbeddingConfig(
    deployedConfigPath,
  ).catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (
    existingConfig &&
    (existingConfig.serviceId !== config.serviceId ||
      existingConfig.credential !== config.credential ||
      existingConfig.port !== config.port)
  )
    throw Error("Deployed service configuration mismatch");
  if (!existingConfig)
    await writeFile(deployedConfigPath, JSON.stringify(config) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const deployedRuntime = resolve(serviceHome, "runtime/evaluations");
  await mkdir(deployedRuntime, { recursive: true, mode: 0o700 });
  for (const file of [
    "local-service.mjs",
    "local-config.mjs",
    "embedding-runtime.mjs",
    "embedding-model.lock.json",
  ])
    await cp(new URL(file, import.meta.url), resolve(deployedRuntime, file));
  await cp(
    resolve(root, "runtime/evaluations/node_modules"),
    resolve(deployedRuntime, "node_modules"),
    { recursive: true },
  );
  await cp(
    resolve(root, ".runtime/embedding-eval/model"),
    resolve(serviceHome, ".runtime/embedding-eval/model"),
    { recursive: true },
  );
  await verifyEmbeddingModel(resolve(serviceHome, ".runtime/embedding-eval"));
  await mkdir(resolve(homedir(), "Library/LaunchAgents"), { recursive: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["stdout.log", "stderr.log"])
    await writeFile(resolve(deployedDirectory, name), "", {
      flag: "a",
      mode: 0o600,
    });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(deployedScript)}</string><string>--serve</string></array><key>WorkingDirectory</key><string>${xml(serviceHome)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(resolve(deployedDirectory, "stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(deployedDirectory, "stderr.log"))}</string></dict></plist>\n`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  execFileSync("plutil", ["-lint", plistPath], { stdio: "pipe" });
  if (!loaded())
    execFileSync(
      "launchctl",
      ["bootstrap", "gui/" + process.getuid(), plistPath],
      { stdio: "pipe" },
    );
  for (let n = 0; n < 40; n++) {
    if (await healthy(config)) {
      console.log(
        JSON.stringify({
          status: "ready",
          model: embeddingModel,
          port: config.port,
          inputCharacters,
          startsAtLogin: true,
        }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Service did not become ready; inspect its private log");
}
main().catch(() => {
  console.error(
    "Local embedding service operation did not complete; inspect owned private configuration and service health. Secrets are not printed.",
  );
  process.exitCode = 1;
});
