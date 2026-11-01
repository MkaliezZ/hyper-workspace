import { z } from "zod";
export const NotificationField = z.enum([
  "added",
  "removed",
  "title",
  "assignee",
  "status",
  "dueDate",
]);
export type NotificationField = z.infer<typeof NotificationField>;
export const NotificationRules = z
  .object({
    mode: z.enum(["all", "important", "quiet"]).optional(),
    importantFields: z
      .array(NotificationField)
      .max(6)
      .refine(
        (items) => new Set(items).size === items.length,
        "重要变化条件不能重复。",
      )
      .optional(),
    minIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .strict();
export type NotificationRules = z.infer<typeof NotificationRules>;
export const NotificationPlan = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("configure"),
      scope: z.enum(["workspace", "project", "personal"]),
      expectedRevision: z.number().int().nonnegative(),
      rules: NotificationRules,
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type NotificationPlan = z.infer<typeof NotificationPlan>;
export const NotificationInput = z
  .object({
    plan: NotificationPlan,
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
