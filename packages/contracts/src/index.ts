import { z } from "zod";

export const EngineId = z.enum(["dsh", "hermes", "fixture"]);
export type EngineId = z.infer<typeof EngineId>;
export const RunState = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_confirmation",
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
]);
export type RunState = z.infer<typeof RunState>;
export const EventKind = z.enum([
  "run.started",
  "message.delta",
  "progress.updated",
  "input.required",
  "action.proposed",
  "action.completed",
  "artifact.updated",
  "usage.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.recovery_required",
]);
export type EventKind = z.infer<typeof EventKind>;
export const Workflow = z.enum([
  "discussion_to_minutes",
  "project_report",
  "revise_artifact",
  "follow_up",
  "chat",
]);
export type Workflow = z.infer<typeof Workflow>;
export const RunInput = z
  .object({
    conversationId: z.uuid(),
    workflow: Workflow,
    engine: EngineId.default("dsh"),
    instruction: z.string().trim().min(1).max(20000),
    artifactId: z.uuid().optional(),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export type RunInput = z.infer<typeof RunInput>;
export const NewMessage = z
  .object({ content: z.string().trim().min(1).max(20000) })
  .strict();
export const TaskInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    assignee: z.string().max(100).default("待分配"),
    dueDate: z.string().date().nullable().default(null),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInput>;
export const TaskPatch = z
  .object({
    status: z.enum(["open", "done"]).optional(),
    title: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export const ArtifactRevision = z
  .object({
    content: z.string().trim().min(1).max(100000),
    expectedVersion: z.number().int().positive(),
    feedback: z.string().trim().max(20000).default(""),
  })
  .strict();
export type ArtifactRevision = z.infer<typeof ArtifactRevision>;
export const ModelInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(["openai-compatible", "deepseek", "anthropic"]),
    endpoint: z.url(),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().min(1).max(4096).optional(),
    purpose: z.enum(["chat", "embedding"]).default("chat"),
    scope: z.enum(["personal", "workspace"]).default("personal"),
  })
  .strict();
export const DecisionInput = z
  .object({ requestId: z.uuid(), approved: z.boolean() })
  .strict();
export const TerminalStates = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
]);
const transitions: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled", "failed"],
  running: [
    "waiting_input",
    "waiting_confirmation",
    "succeeded",
    "failed",
    "cancelled",
    "recovery_required",
  ],
  waiting_input: ["queued", "running", "cancelled", "failed"],
  waiting_confirmation: [
    "queued",
    "running",
    "cancelled",
    "failed",
    "recovery_required",
  ],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: ["failed", "succeeded"],
};
export function assertTransition(from: RunState, to: RunState) {
  if (!transitions[from].includes(to))
    throw new Error("Invalid run transition: " + from + " -> " + to);
}
export interface Subject {
  id: string;
  name: string;
  workspaceId: string;
  role: "admin" | "member";
  demo: boolean;
  /** Server-owned source credential reference. Never accepted from client input. */
  identityCredentialId?: string;
}
export interface RunEvent {
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  schemaVersion: "1.0.0";
  kind: EventKind;
  data: Record<string, unknown>;
}
export interface PlannedAction {
  tool:
    | "artifact.create"
    | "artifact.revise"
    | "task.create"
    | "project.report"
    | "follow_up.check";
  args: Record<string, unknown>;
}
export interface EngineRequest {
  runId: string;
  subject: Subject;
  instruction: string;
  workflow: Workflow;
  context: string;
  policy: string;
  workdir: string;
  /** Backend-only connection. Never serialize credentials into product events. */
  model?: {
    id: string;
    provider: string;
    endpoint: string;
    model: string;
    apiKey?: string;
  };
  signal: AbortSignal;
  onProgress: (text: string) => Promise<void>;
}
export function toolsForWorkflow(
  workflow: Workflow,
): readonly PlannedAction["tool"][] {
  switch (workflow) {
    case "discussion_to_minutes":
      return ["artifact.create", "task.create"];
    case "project_report":
      return ["artifact.create", "project.report"];
    case "revise_artifact":
      return ["artifact.revise"];
    case "follow_up":
      return ["follow_up.check"];
    case "chat":
      return [];
  }
}
export interface EngineResult {
  text: string;
  actions: PlannedAction[];
  evidence: "fixture" | "runtime";
  usage?: { inputTokens: number; outputTokens: number };
}
export interface EngineCapabilities {
  configured: boolean;
  operations: string[];
  evidence: string;
  modelProviders?: string[];
}
export interface EngineAdapter {
  id: EngineId;
  describeCapabilities(): EngineCapabilities;
  execute(request: EngineRequest): Promise<EngineResult>;
}
export interface Message {
  id: string;
  author: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}
export interface Task {
  id: string;
  title: string;
  assignee: string;
  status: "open" | "done";
  dueDate: string | null;
}
export interface Artifact {
  id: string;
  title: string;
  version: number;
  content: string;
  status: string;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  goal: string;
  conversationId: string;
}
export interface WorkspaceView {
  user: Subject;
  projects: Project[];
  project: Project;
  messages: Message[];
  tasks: Task[];
  artifacts: Artifact[];
  engines: Record<string, EngineCapabilities>;
}

export interface CommunicationRoom {
  id: string;
  name: string;
  readOnly: boolean;
}
export interface CommunicationMessage {
  id: string;
  authorId: string;
  author: string;
  content: string;
  createdAt: string;
  kind: "comment" | "system" | "deleted" | "unsupported";
  referenceId: string;
  version: string;
  expiresAt: string | null;
}

export const CommunicationSendInput = z
  .object({
    content: z.string().trim().min(1).max(20000),
    idempotencyKey: z.uuid(),
  })
  .strict();
export interface CommunicationReceipt {
  id: string;
  state: "sending" | "succeeded" | "failed" | "recovery_required";
  sourceMessageId: string | null;
  error: string | null;
  acknowledgedAt: string | null;
}
