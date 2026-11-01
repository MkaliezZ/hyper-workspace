import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveNotifications,
  notificationDecision,
} from "../apps/api/src/core/notification-policy.js";
import {
  NotificationPlan,
  NotificationRules,
} from "@hyper/contracts/notifications";
test("Notification layers narrow publication and preserve explicitly inherited versus empty importance criteria", () => {
  const defaults = effectiveNotifications([]);
  assert.equal(defaults.mode, "all");
  assert.equal(defaults.minIntervalMinutes, 0);
  const layers: any[] = [
    {
      scope: "workspace",
      scopeId: "w",
      revision: 1,
      rules: {
        mode: "important",
        importantFields: ["status", "dueDate"],
        minIntervalMinutes: 30,
      },
    },
    {
      scope: "project",
      scopeId: "p",
      revision: 2,
      rules: {
        importantFields: ["status", "assignee"],
        minIntervalMinutes: 60,
      },
    },
    {
      scope: "personal",
      scopeId: "u",
      revision: 1,
      rules: { mode: "all", minIntervalMinutes: 0 },
    },
  ];
  const before = JSON.stringify(layers),
    result = effectiveNotifications(layers);
  assert.equal(result.mode, "important");
  assert.equal(result.minIntervalMinutes, 60);
  assert.deepEqual(result.importantFields, ["status"]);
  assert.equal(JSON.stringify(layers), before);
  assert.equal(
    effectiveNotifications([
      ...layers,
      {
        scope: "personal",
        scopeId: "u",
        revision: 2,
        rules: { mode: "quiet" },
      },
    ]).mode,
    "quiet",
  );
  assert.deepEqual(
    effectiveNotifications([
      {
        scope: "personal",
        scopeId: "u",
        revision: 1,
        rules: { importantFields: [] },
      },
    ]).importantFields,
    [],
  );
});
test("Importance is a host-defined trigger, with exact fields, explicit cooldown and no implicit new scheduled notification", () => {
  const effective = effectiveNotifications([
      {
        scope: "personal",
        scopeId: "u",
        revision: 1,
        rules: {
          mode: "important",
          importantFields: ["status", "assignee"],
          minIntervalMinutes: 30,
        },
      },
    ]),
    now = new Date("2026-11-01T10:00:00Z");
  assert.equal(
    notificationDecision(
      effective,
      [{ kind: "updated", fields: ["title"] }],
      null,
      now,
    ).reason,
    "not_important",
  );
  assert.equal(
    notificationDecision(
      effective,
      [{ kind: "updated", fields: ["assigneeId"] }],
      null,
      now,
    ).notify,
    true,
  );
  const held = notificationDecision(
    effective,
    [{ kind: "updated", fields: ["status"] }],
    "2026-11-01T09:45:00Z",
    now,
  );
  assert.equal(held.notify, false);
  assert.equal(held.reason, "rate_limited");
  assert.equal(held.nextEligibleAt, "2026-11-01T10:15:00.000Z");
  assert.equal(
    notificationDecision(
      effective,
      [{ kind: "updated", fields: ["status"] }],
      "2026-11-01T09:30:00Z",
      now,
    ).notify,
    true,
  );
  assert.equal(
    notificationDecision(effective, [], null, now).reason,
    "unchanged",
  );
  assert.throws(
    () =>
      notificationDecision(
        effective,
        [{ kind: "updated", fields: ["status"] }],
        "invalid-time",
        now,
      ),
    /时间无法核对/,
  );
});
test("Notification configuration rejects invented actors, unknown options, repeated criteria and unsafe intervals", () => {
  assert.equal(
    NotificationRules.safeParse({ minIntervalMinutes: 1441 }).success,
    false,
  );
  assert.equal(
    NotificationRules.safeParse({ importantFields: ["status", "status"] })
      .success,
    false,
  );
  assert.equal(
    NotificationRules.safeParse({ mode: "model_decides" }).success,
    false,
  );
  assert.equal(
    NotificationPlan.safeParse({
      operation: "configure",
      scope: "personal",
      scopeId: "another-user",
      expectedRevision: 0,
      rules: { mode: "quiet" },
      confirmed: true,
    }).success,
    false,
  );
  assert.equal(
    NotificationPlan.safeParse({
      operation: "configure",
      scope: "workspace",
      expectedRevision: 0,
      rules: { mode: "quiet" },
      confirmed: false,
    }).success,
    false,
  );
});
