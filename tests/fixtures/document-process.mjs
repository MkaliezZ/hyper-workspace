// Trusted process-boundary fixture; never used by product extraction.
import { once } from "node:events";
let input = "";
process.stdin.on("data", (b) => (input += b));
await once(process.stdin, "end");
if (input === "hang") await new Promise(() => setInterval(() => {}, 1000));
else if (input === "stdout") process.stdout.write("x".repeat(600000));
else if (input === "stderr")
  process.stderr.write("private-diagnostic".repeat(2000));
else if (input === "environment") {
  if (
    Object.keys(process.env).some((k) =>
      /SECRET|KEY|PASSWORD|DATABASE|HOME/.test(k),
    )
  )
    process.exit(5);
  process.stdout.write(
    JSON.stringify({
      parserVersion: "document-text-v1",
      format: process.argv[2],
      text: "[page1]\nfixture",
      sections: [{ locator: "page1", text: "fixture" }],
      warnings: [],
    }),
  );
} else if (input === "invalid")
  process.stdout.write(JSON.stringify({ text: "partial" }));
else if (input === "mismatch")
  process.stdout.write(
    JSON.stringify({
      parserVersion: "document-text-v1",
      format: "docx",
      text: "[page1]\nfixture",
      sections: [{ locator: "page1", text: "fixture" }],
      warnings: [],
    }),
  );
else process.exit(3);
