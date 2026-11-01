-- P03/P04/P07 / C00/C03/C05 / A01/A03/A06/A10. Source operations have durable, non-replayed dispatch evidence.
CREATE TABLE cw_room_commands (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid NOT NULL REFERENCES cw_identity_credentials,
 provider_key text NOT NULL,
 binding_ref text NOT NULL,
 remote_uid text NOT NULL,
 source_run_id uuid REFERENCES cw_runs,
 operation text NOT NULL CHECK(operation IN ('create_direct','create_group','notify','favorite','mark_read','mark_unread','rename','add_member','remove_member','moderator','leave','delete')),
 plan jsonb NOT NULL,
 params_hash text NOT NULL,
 idempotency_key text NOT NULL,
 source_room_ref text,
 state text NOT NULL CHECK(state IN ('dispatching','succeeded','failed','recovery_required')),
 outcome text,
 acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
CREATE INDEX cw_room_commands_actor_time ON cw_room_commands(workspace_id,actor_id,created_at DESC);
CREATE INDEX cw_room_commands_scope_pending ON cw_room_commands(workspace_id,actor_id,provider_key,source_room_ref) WHERE state IN ('dispatching','recovery_required') AND acknowledged_at IS NULL;
CREATE INDEX cw_room_commands_run ON cw_room_commands(source_run_id) WHERE source_run_id IS NOT NULL;
CREATE TABLE cw_room_command_steps (
 command_id uuid NOT NULL REFERENCES cw_room_commands,
 sequence integer NOT NULL CHECK(sequence>=0 AND sequence<=20),
 operation text NOT NULL,
 target_ref text,
 state text NOT NULL CHECK(state IN ('ready','dispatching','acknowledged','observed','rejected','unknown')),
 source_ref text,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 dispatched_at timestamptz,
 settled_at timestamptz,
 PRIMARY KEY(command_id,sequence)
);
ALTER TABLE cw_runs ADD COLUMN room_management_plan jsonb;
