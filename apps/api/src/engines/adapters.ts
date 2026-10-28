import type {
  EngineAdapter,
  EngineRequest,
  EngineResult,
  EngineId,
} from "@hyper/contracts";
import { JsonRpcProcess, runtimeCommand } from "./rpc.js";
import { z } from "zod";
const resultSchema = z.object({
  text: z.string().min(1),
  actions: z
    .array(
      z.object({
        tool: z.enum([
          "artifact.create",
          "artifact.revise",
          "task.create",
          "project.report",
          "follow_up.check",
        ]),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .max(30),
});
const instruction =
  'Return ONLY JSON: {"text":"brief result","actions":[{"tool":"artifact.create|artifact.revise|task.create|project.report|follow_up.check","args":{}}]}. Do not claim an action already happened. The host validates and executes it. Use title/content for artifact.create; artifactId/content for artifact.revise; title/assignee for task.create. Never invent project facts. No native shell or business tools are needed.';
function parseResult(text: string): EngineResult {
  const clean = text
    .trim()
    .replace(/^\x60\x60\x60(?:json)?\s*/, "")
    .replace(/\s*\x60\x60\x60$/, "");
  return { ...resultSchema.parse(JSON.parse(clean)), evidence: "runtime" };
}
export class FixtureAdapter implements EngineAdapter {
  readonly id = "fixture" as const;
  describeCapabilities() {
    return {
      configured: process.env.DEMO_MODE === "true",
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "follow_up",
        "chat",
      ],
      evidence: "deterministic-fixture",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    if (!r.subject.demo || process.env.DEMO_MODE !== "true")
      throw new Error(
        "Fixture execution is only available in an explicitly enabled demo session.",
      );
    r.signal.throwIfAborted();
    await r.onProgress("正在演示资料上验证业务流程；此步骤未调用真实模型。");
    const heading =
      r.workflow === "project_report" ? "项目进展周报" : "讨论纪要";
    if (r.workflow === "follow_up")
      return {
        text: "演示检查已完成。实际任务状态请查看待办列表；没有调用真实模型。",
        actions: [{ tool: "follow_up.check", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "chat")
      return {
        text: "已保存这条讨论。你可以通过“发起任务”生成纪要、周报或修改成果。当前为演示模式，未调用真实模型。",
        actions: [],
        evidence: "fixture",
      };
    if (r.workflow === "revise_artifact")
      return {
        text: "已根据反馈准备演示修订内容。",
        actions: [
          {
            tool: "artifact.revise",
            args: { content: r.context + "\n\n## 本次反馈\n" + r.instruction },
          },
        ],
        evidence: "fixture",
      };
    return {
      text: "已根据演示上下文准备" + heading + "，可查看和继续修改。",
      actions: [
        {
          tool: "artifact.create",
          args: {
            title: "产品共创 · " + heading,
            content:
              "# " +
              heading +
              "\n\n" +
              r.context +
              "\n\n## 本次要求\n" +
              r.instruction +
              "\n\n> 此成果由确定性演示流程生成，未调用真实模型。",
          },
        },
      ],
      evidence: "fixture",
    };
  }
}
export class DshAdapter implements EngineAdapter {
  readonly id = "dsh" as const;
  constructor(private command = runtimeCommand(process.env.DSH_COMMAND)) {}
  describeCapabilities() {
    return {
      configured: !!this.command,
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "follow_up",
        "chat",
      ],
      evidence: this.command ? "configured-unverified" : "not-configured",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    if (!this.command)
      throw new Error(
        "DSH 尚未配置。请在服务端设置 DSH_COMMAND 并验证运行时。",
      );
    const rpc = new JsonRpcProcess(this.command, r.workdir, {
      DSH_HOME: r.workdir,
    });
    let text = "";
    const abort = () => {
      void rpc.close();
    };
    r.signal.addEventListener("abort", abort, { once: true });
    rpc.onRequest = async (method) => {
      if (method === "approval/request") return { outcome: "rejected" };
      throw new Error("Runtime native tool is not authorized.");
    };
    rpc.onNotification = (method, p) => {
      if (method === "session.event") {
        const e = p?.event;
        if (e?.type === "assistant/message") {
          const content = e.data?.message?.content ?? e.message?.content;
          text = Array.isArray(content)
            ? content.map((x: any) => x.text ?? "").join("")
            : typeof content === "string"
              ? content
              : text;
        }
      }
    };
    try {
      await rpc.request("initialize", {
        cwd: r.workdir,
        approvalRequests: true,
      });
      const sessionId = r.runId;
      await rpc.request("session/prompt", {
        sessionId,
        content: [
          {
            type: "text",
            text:
              r.policy +
              "\n" +
              instruction +
              "\nContext:\n" +
              r.context +
              "\nTask:\n" +
              r.instruction,
          },
        ],
      });
      await rpc.request("session/wait", { sessionId });
      r.signal.throwIfAborted();
      if (!text)
        throw new Error(
          "DSH returned no supported structured output. Verify the pinned protocol version.",
        );
      return parseResult(text);
    } finally {
      r.signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
}
export class HermesAdapter implements EngineAdapter {
  readonly id = "hermes" as const;
  constructor(private command = runtimeCommand(process.env.HERMES_COMMAND)) {}
  describeCapabilities() {
    return {
      configured: !!this.command,
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "follow_up",
        "chat",
      ],
      evidence: this.command ? "configured-unverified" : "not-configured",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    if (!this.command)
      throw new Error(
        "Hermes 尚未配置。请在服务端设置 HERMES_COMMAND 并验证运行时。",
      );
    const rpc = new JsonRpcProcess(this.command, r.workdir, {
      HERMES_HOME: r.workdir,
    });
    let text = "";
    const abort = () => {
      void rpc.close();
    };
    r.signal.addEventListener("abort", abort, { once: true });
    rpc.onRequest = async (method) => {
      if (method === "approval") return { choice: "deny" };
      throw new Error("Native runtime request is not authorized.");
    };
    rpc.onNotification = (method, p) => {
      if (method === "message.complete") text = p?.content ?? p?.text ?? text;
    };
    try {
      await rpc.request("client.capabilities", { server_requests: true });
      const session = await rpc.request("session.create", {});
      const sessionId = session.session_id ?? session.id;
      if (!sessionId)
        throw new Error("Hermes session protocol did not return an ID.");
      const result = await rpc.request("prompt.submit", {
        session_id: sessionId,
        prompt:
          r.policy +
          "\n" +
          instruction +
          "\nContext:\n" +
          r.context +
          "\nTask:\n" +
          r.instruction,
      });
      if (typeof result?.text === "string") text = result.text;
      r.signal.throwIfAborted();
      if (!text)
        throw new Error(
          "Hermes returned no supported final output. Verify the pinned protocol version.",
        );
      return parseResult(text);
    } finally {
      r.signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
}
export function engineRegistry(): Map<EngineId, EngineAdapter> {
  return new Map<EngineId, EngineAdapter>([
    ["dsh", new DshAdapter()],
    ["hermes", new HermesAdapter()],
    ["fixture", new FixtureAdapter()],
  ]);
}
