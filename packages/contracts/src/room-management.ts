import { z } from "zod";
import { EngineId, ExecutionRules } from "./index.js";
const Uid = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const Binding = { bindingRef: z.string().regex(/^[a-f0-9]{64}$/) };
export const MessageSearchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,7})$/)
      .optional(),
  })
  .strict();
export type MessageSearchInput = z.infer<typeof MessageSearchInput>;
const Target = {
  ...Binding,
  roomId: z.string().regex(/^[a-z0-9]{4,30}$/),
  expected: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
};
const Attendee = {
  uid: Uid,
  attendeeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const RoomManagementPlan = z.discriminatedUnion("operation", [
  z
    .object({
      ...Binding,
      operation: z.literal("read"),
      roomId: z
        .string()
        .regex(/^[a-z0-9]{4,30}$/)
        .optional(),
      search: MessageSearchInput.optional(),
    })
    .strict()
    .refine((v) => !v.search || !!v.roomId, "历史消息搜索必须选择一个会话。"),
  z
    .object({
      ...Binding,
      operation: z.literal("create_direct"),
      uid: Uid,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...Binding,
      operation: z.literal("create_group"),
      name: z.string().trim().min(1).max(255),
      uids: z
        .array(Uid)
        .min(1)
        .max(20)
        .refine(
          (uids) => new Set(uids).size === uids.length,
          "群成员不能重复。",
        ),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...Target,
      operation: z.literal("notify"),
      level: z.number().int().min(0).max(3),
    })
    .strict(),
  z
    .object({
      ...Target,
      operation: z.literal("favorite"),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...Target,
      operation: z.literal("mark_read"),
      messageId: z
        .string()
        .regex(/^[1-9][0-9]{0,15}$/)
        .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
    })
    .strict(),
  z.object({ ...Target, operation: z.literal("mark_unread") }).strict(),
  z
    .object({
      ...Target,
      operation: z.literal("rename"),
      name: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({ ...Target, operation: z.literal("add_member"), uid: Uid })
    .strict(),
  z
    .object({ ...Target, ...Attendee, operation: z.literal("remove_member") })
    .strict(),
  z
    .object({
      ...Target,
      ...Attendee,
      operation: z.literal("moderator"),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ ...Target, operation: z.literal("leave") }).strict(),
  z.object({ ...Target, operation: z.literal("delete") }).strict(),
]);
export type RoomManagementPlan = z.infer<typeof RoomManagementPlan>;

export const RoomManagementInput = z
  .object({
    plan: RoomManagementPlan,
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
export const RoomManagementRunInput = RoomManagementInput.extend({
  engine: EngineId,
  modelProfileId: z.uuid().optional(),
  taskRules: ExecutionRules.optional(),
}).strict();
export type RoomManagementRunInput = z.infer<typeof RoomManagementRunInput>;
