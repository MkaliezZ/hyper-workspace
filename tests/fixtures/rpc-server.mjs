import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.stdout.write(
  JSON.stringify({ jsonrpc: "2.0", method: "fixture.ready", params: {} }) +
    "\n",
);
for await (const line of lines) {
  const m = JSON.parse(line);
  if (m.method === "hang") continue;
  if (m.method === "error")
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32000, message: "expected fixture error" },
      }) + "\n",
    );
  else if (m.id)
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        result:
          m.method === "env"
            ? { secretPresent: !!process.env.HYPER_TEST_SECRET }
            : { method: m.method, params: m.params },
      }) + "\n",
    );
}
