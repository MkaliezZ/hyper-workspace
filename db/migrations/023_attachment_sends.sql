-- P04/P07 C00/C05 A03/A04/A10: durable external file-share intent, never engine-local state.
ALTER TABLE cw_runs ADD COLUMN attachment_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_attachment_plan CHECK ((workflow='share_attachment' AND attachment_plan IS NOT NULL) OR (workflow<>'share_attachment' AND attachment_plan IS NULL));
CREATE TABLE cw_attachment_sends (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid NOT NULL REFERENCES cw_identity_credentials,
 provider_key text NOT NULL,
 source_actor_id text NOT NULL,
 conversation_ref text NOT NULL,
 idempotency_key text NOT NULL,
 params_hash text NOT NULL,
 plan jsonb NOT NULL,
 file_name text NOT NULL,
 reference_id text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN ('sending','succeeded','failed','recovery_required')),
 source_run_id uuid REFERENCES cw_runs,
 source_share_id text,
 source_message_id text,
 error text,
 attempted_at timestamptz,
 acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
CREATE INDEX cw_attachment_sends_pending ON cw_attachment_sends(workspace_id,actor_id,provider_key,conversation_ref) WHERE state IN ('sending','recovery_required') AND acknowledged_at IS NULL;
