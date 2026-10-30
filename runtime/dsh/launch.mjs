import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const cli = import.meta.resolve("@deepseek-ai/dsh/lib/bin.js");
const manifest = JSON.parse(
  await readFile(new URL("../package.json", cli), "utf8"),
);
if (manifest.version !== "0.2.1-rc.2")
  throw new Error(
    "Unsupported DSH version; update the adapter and its contract checks first.",
  );
const home = process.env.DSH_HOME;
if (!home || !isAbsolute(home))
  throw new Error("An isolated absolute DSH_HOME is required.");
const endpoint = new URL(process.env.HYPER_MODEL_ENDPOINT ?? "");
if (
  !["http:", "https:"].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Invalid model endpoint.");
const api =
  process.env.HYPER_MODEL_PROVIDER === "anthropic"
    ? "anthropic-messages"
    : "openai-completions";
const maxTokens = Number(process.env.HYPER_MODEL_MAX_TOKENS ?? 4096);
if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 4096)
  throw new Error("Invalid output token limit.");
const model = process.env.HYPER_MODEL_NAME;
if (!model) throw new Error("A per-run model is required.");
const profile = join(home, "profiles", "hyper");
await mkdir(profile, { recursive: true, mode: 0o700 });
await writeFile(
  join(profile, "package.json"),
  JSON.stringify({
    name: "dsh-profile-hyper",
    private: true,
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-sdk-minimal"] } },
  }),
  { mode: 0o600 },
);
// No model-controlled shell, filesystem, or working-directory tools. Business
// actions are structured proposals executed by the product's ToolGateway.
const disabled = [
  "llm-deepseek",
  "tool-fs",
  "tool-working-directory",
  "persistent-bash",
  "persistent-pwsh",
];
const patch = [
  ...disabled.map((id) => ({ id, disabled: true })),
  {
    insert: [
      {
        id: "hyper-model",
        name: import.meta.resolve("@deepseek-ai/dsh-llm-pi-ai"),
        config: {
          providers: {
            "hyper-model": {
              apiKeyEnv: "HYPER_MODEL_API_KEY",
              api,
              baseURL: endpoint.toString().replace(/\/$/, ""),
              defaultMaxTokens: maxTokens,
              retryPolicy: { mode: "normal", maxRetries: 0 },
              models: [
                { id: model, contextWindow: 65536, reasoningEfforts: false },
              ],
            },
          },
        },
      },
    ],
  },
];
await writeFile(join(profile, "cordis.patch.yml"), JSON.stringify(patch), {
  mode: 0o600,
});
process.argv = [process.execPath, fileURLToPath(cli), "--profile", "hyper"];
const { runCli } = await import(cli);
await runCli();
