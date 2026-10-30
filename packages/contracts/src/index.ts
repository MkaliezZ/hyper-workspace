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
  "task.updated",
  "method.updated",
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
  "revise_task",
  "manage_method",
  "review_artifact",
  "follow_up",
  "configure_follow_up",
  "configure_policy",
  "usage_report",
  "manage_spending",
  "chat",
  "draft_reply",
  "read_file",
  "revise_file_reading",
]);
export type Workflow = z.infer<typeof Workflow>;
export const MoneyAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/, "请输入最多六位小数的非负金额。");
export const ExactMoneyAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,12})?$/, "核对金额最多保留十二位小数。");
export const ModelSpendingPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("configure"),
      modelProfileId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      inputPerMillion: MoneyAmount,
      outputPerMillion: MoneyAmount,
      cacheReadPerMillion: MoneyAmount,
      cacheWritePerMillion: MoneyAmount,
      dailyLimit: MoneyAmount.nullable(),
      requestReservation: MoneyAmount,
      source: z.string().trim().min(1).max(1000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("reconcile"),
      requestId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      amount: ExactMoneyAmount,
      evidence: z.string().trim().min(1).max(2000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type ModelSpendingPlan = z.infer<typeof ModelSpendingPlan>;
export const ModelSpendingInput = z
  .object({ plan: ModelSpendingPlan, idempotencyKey: z.uuid() })
  .strict();
export const ExecutionRules = z
  .object({
    maxContextBytes: z.number().int().min(1024).max(100000).optional(),
    maxOutputTokens: z.number().int().min(64).max(4096).optional(),
    maxDurationSeconds: z.number().int().min(5).max(180).optional(),
    maxActions: z.number().int().min(0).max(30).optional(),
    engines: z.array(EngineId).max(3).optional(),
    workflows: z.array(Workflow).max(32).optional(),
    dailyRuns: z.number().int().min(0).max(10000).optional(),
    expression: z.enum(["concise", "balanced", "detailed"]).optional(),
  })
  .strict();
export type ExecutionRules = z.infer<typeof ExecutionRules>;
export const ExecutionPolicyPlan = z
  .object({
    scope: z.enum(["workspace", "project", "personal"]),
    expectedRevision: z.number().int().min(0),
    rules: ExecutionRules,
    confirmed: z.literal(true),
  })
  .strict();
export type ExecutionPolicyPlan = z.infer<typeof ExecutionPolicyPlan>;
export const ExecutionPolicyInput = ExecutionPolicyPlan.extend({
  idempotencyKey: z.uuid(),
}).strict();
export function isFileWorkflow(workflow: string) {
  return workflow === "read_file" || workflow === "revise_file_reading";
}
export const FollowUpPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      intervalMinutes: z.number().int().min(15).max(1440),
      maxChecks: z.number().int().min(1).max(96),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["pause", "resume", "cancel"]),
      scheduleId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type FollowUpPlan = z.infer<typeof FollowUpPlan>;
export const FollowUpConfiguration = z
  .object({
    plan: FollowUpPlan,
    engine: EngineId.default("dsh"),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const ArtifactReviewPlan = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedReviewRevision: z.number().int().min(0),
    decision: z.enum(["accept", "request_changes", "reopen"]),
    feedback: z.string().trim().min(1).max(4000),
    confirmed: z.literal(true),
  })
  .strict();
export type ArtifactReviewPlan = z.infer<typeof ArtifactReviewPlan>;
export const ArtifactReviewInput = ArtifactReviewPlan.extend({
  idempotencyKey: z.uuid(),
}).strict();
export type ArtifactReviewInput = z.infer<typeof ArtifactReviewInput>;
export const MethodDraft = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(["sop", "template", "case", "rubric", "glossary"]),
    content: z.string().trim().min(1).max(12000),
  })
  .strict();
export type MethodDraft = z.infer<typeof MethodDraft>;
const methodTarget = {
  methodId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
};
export const MethodPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      sourceArtifactId: z.uuid(),
      expectedSourceVersion: z.number().int().positive(),
    })
    .strict(),
  z.object({ operation: z.literal("revise"), ...methodTarget }).strict(),
  z
    .object({
      operation: z.literal("verify"),
      ...methodTarget,
      evidence: z.string().trim().min(1).max(4000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("publish"),
      ...methodTarget,
      scope: z.enum(["project", "workspace"]),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("withdraw"),
      ...methodTarget,
      reason: z.string().trim().min(1).max(4000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type MethodPlan = z.infer<typeof MethodPlan>;
export const MethodActionInput = z
  .object({
    plan: MethodPlan,
    draft: MethodDraft.optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type MethodActionInput = z.infer<typeof MethodActionInput>;
export const MethodReference = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
export type MethodReference = z.infer<typeof MethodReference>;
export interface MethodAsset {
  id: string;
  projectId: string;
  projectName: string;
  maintainerId: string;
  maintainerName: string;
  sourceArtifactId: string;
  sourceTitle: string;
  sourceVersion: number;
  version: number;
  revision: number;
  state: "candidate" | "published" | "withdrawn";
  verification: "candidate" | "employee_verified";
  evidence: string;
  scope: "project" | "workspace";
  title: string;
  kind: MethodDraft["kind"];
  content: string;
  canManage: boolean;
  canPublishWorkspace: boolean;
}
export function artifactStatusLabel(status: string) {
  return (
    (
      {
        draft: "草稿",
        changes_requested: "待修改",
        accepted: "已验收",
      } as Record<string, string>
    )[status] ?? "状态未知"
  );
}
export const RunInput = z
  .object({
    conversationId: z.uuid(),
    workflow: Workflow,
    engine: EngineId.default("dsh"),
    instruction: z.string().trim().min(1).max(20000),
    artifactId: z.uuid().optional(),
    modelProfileId: z.uuid().optional(),
    followUpPlan: FollowUpPlan.optional(),
    artifactReviewPlan: ArtifactReviewPlan.optional(),
    taskId: z.uuid().optional(),
    expectedTaskVersion: z.number().int().positive().optional(),
    methodPlan: MethodPlan.optional(),
    methodRefs: z.array(MethodReference).max(3).optional(),
    policyPlan: ExecutionPolicyPlan.optional(),
    spendingPlan: ModelSpendingPlan.optional(),
    taskRules: ExecutionRules.omit({ dailyRuns: true }).optional(),
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
    assignee: z.string().trim().min(1).max(100).optional(),
    dueDate: z.string().date().nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, item]) => key !== "expectedVersion" && item !== undefined,
      ),
    "请指定需要修改的待办字段。",
  );
export type TaskPatch = z.infer<typeof TaskPatch>;
export const TaskRewrite = z
  .object({
    status: z.enum(["open", "done"]).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    assignee: z.string().trim().min(1).max(100).optional(),
    dueDate: z.string().date().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    "没有提出待办修改字段。",
  );
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
    | "artifact.review"
    | "task.create"
    | "task.update"
    | "method.write"
    | "method.manage"
    | "policy.configure"
    | "usage.report"
    | "spending.manage"
    | "project.report"
    | "follow_up.check"
    | "follow_up.configure"
    | "communication.draft"
    | "file.reading.save";
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
  limits?: { maxOutputTokens: number; maxDurationSeconds: number };
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
    case "revise_task":
      return ["task.update"];
    case "manage_method":
      return ["method.write", "method.manage"];
    case "review_artifact":
      return ["artifact.review"];
    case "follow_up":
      return ["follow_up.check"];
    case "configure_follow_up":
      return ["follow_up.configure"];
    case "configure_policy":
      return ["policy.configure"];
    case "usage_report":
      return ["usage.report"];
    case "manage_spending":
      return ["spending.manage"];
    case "chat":
      return [];
    case "draft_reply":
      return ["communication.draft"];
    case "read_file":
    case "revise_file_reading":
      return ["file.reading.save"];
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
  version?: number;
}
export interface Artifact {
  id: string;
  title: string;
  version: number;
  content: string;
  status: string;
  reviewRevision?: number;
  acceptedVersion?: number | null;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  goal: string;
  conversationId: string;
  source?: { kind: "nextcloud-talk"; roomId: string; name: string };
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
    draftId: z.uuid().optional(),
  })
  .strict();
export interface CommunicationReceipt {
  id: string;
  state: "sending" | "succeeded" | "failed" | "recovery_required";
  sourceMessageId: string | null;
  error: string | null;
  acknowledgedAt: string | null;
}
export interface ReplyDraftSummary {
  id: string;
  runId: string;
  createdAt: string;
  engine: string;
  sendState: CommunicationReceipt["state"] | null;
  sendId: string | null;
}
export interface ReplyDraft {
  id: string;
  runId: string;
  createdAt: string;
  roomId: string;
  roomName: string;
  content: string;
  sourceMessageIds: string[];
  sendState: CommunicationReceipt["state"] | null;
  sendId: string | null;
}

export const FilePath = z
  .array(
    z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          value !== "." &&
          value !== ".." &&
          !/[\\/\u0000-\u001f\u007f]/.test(value),
        "Invalid path segment",
      ),
  )
  .max(20);
export interface SourceFile {
  path: string[];
  id: string;
  name: string;
  kind: "file" | "directory";
  etag: string;
  size: number;
  mime: string;
  importable: boolean;
}

export const FileReadingInput = z
  .object({
    engine: z.enum(["dsh", "hermes"]).default("dsh"),
    instruction: z.string().trim().min(1).max(4000),
    expectedSourceVersion: z.string().min(1).max(512),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type FileReadingInput = z.infer<typeof FileReadingInput>;
export const FileReadingRevisionInput = FileReadingInput.omit({
  expectedSourceVersion: true,
})
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
export type FileReadingRevisionInput = z.infer<typeof FileReadingRevisionInput>;
export const FileReadingRevision = z
  .object({
    content: z.string().trim().min(1).max(20000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
