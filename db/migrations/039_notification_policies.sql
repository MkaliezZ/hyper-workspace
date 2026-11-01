-- P03/P04/P07/P08 C00/C05/C07 A01/A02/A10: notification judgments remain product-owned and versioned.
CREATE TABLE cw_notification_policies (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 scope text NOT NULL CHECK(scope IN ('workspace','project','personal')),
 scope_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object'),
 updated_by uuid NOT NULL REFERENCES cw_users,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,scope,scope_id)
);
CREATE TABLE cw_notification_policy_changes (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 scope text NOT NULL CHECK(scope IN ('workspace','project','personal')),
 scope_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 rules jsonb NOT NULL,
 source_run_id uuid REFERENCES cw_runs,
 idempotency_key text NOT NULL,
 params_hash text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key),
 UNIQUE(workspace_id,scope,scope_id,revision)
);
CREATE INDEX cw_notification_changes_actor ON cw_notification_policy_changes(workspace_id,actor_id,created_at DESC);
ALTER TABLE cw_follow_up_baselines ADD COLUMN last_notification_at timestamptz;
-- A prior quiet check is not a delivered notification. Recover actual prior delivery dates only.
UPDATE cw_follow_up_baselines b SET last_notification_at=x.at
FROM (
 SELECT v.workspace_id,v.project_id,max(m.created_at) AS at
 FROM cw_messages m JOIN cw_conversations v ON v.id=m.conversation_id AND v.workspace_id=m.workspace_id
 WHERE m.metadata->'receipts' @> '[{"tool":"follow_up.check"}]'::jsonb
 GROUP BY v.workspace_id,v.project_id
) x WHERE b.workspace_id=x.workspace_id AND b.project_id=x.project_id;
ALTER TABLE cw_runs ADD COLUMN notification_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_notification_plan_scope CHECK(
 (workflow='manage_notifications' AND notification_plan IS NOT NULL)
 OR (workflow<>'manage_notifications' AND notification_plan IS NULL)
);
