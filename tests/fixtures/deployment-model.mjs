// Synthetic model protocol service, available only in the isolated deployment CI network.
import { createServer } from "node:http";
let calls = 0,
  interrupted = 0,
  violations = 0;
createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/stats") {
    res.end(JSON.stringify({ calls, interrupted, violations }));
    return;
  }
  if (req.method === "GET") {
    res.end(
      JSON.stringify({ data: [{ id: "compose-model", object: "model" }] }),
    );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw),
    input = JSON.stringify(body.messages);
  const cap = body.max_tokens ?? body.max_completion_tokens;
  if (
    req.url !== "/v1/chat/completions" ||
    req.headers.authorization !== "Bearer synthetic-compose-model-key" ||
    body.tools?.length ||
    !cap ||
    cap > 4096
  ) {
    violations++;
    res.writeHead(400);
    res.end("{}");
    return;
  }
  calls++;
  if (input.includes("compose-interrupt")) {
    interrupted++;
    await new Promise((resolve) => setTimeout(resolve, 90000));
    if (res.destroyed) return;
  }
  const revision = input.includes("compose-revise");
  const followUp = input.includes(
    "Check only this authorized project's current product tasks.",
  );
  const review = input.includes("Host-bound artifact review decision.");
  if (review && /synthetic-container-version/.test(input)) violations++;
  const text = JSON.stringify({
    text: "Synthetic container model result.",
    actions: [
      review
        ? { tool: "artifact.review", args: {} }
        : followUp
          ? { tool: "follow_up.check", args: {} }
          : revision
            ? {
                tool: "artifact.revise",
                args: { content: "synthetic-container-version-two" },
              }
            : {
                tool: "artifact.create",
                args: {
                  title: "Container native artifact",
                  content: "synthetic-container-version-one",
                },
              },
    ],
  });
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: "stop" },
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "compose-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [choice],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  } else
    res.end(
      JSON.stringify({
        id: "compose-fixture",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
}).listen(8100, "0.0.0.0");
