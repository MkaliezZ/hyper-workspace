-- P04/P07 C00/C05 A03/A10: external send intent and observed receipt, not a chat mirror.
CREATE TABLE cw_communication_sends (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid NOT NULL REFERENCES cw_identity_credentials,
 provider_key text NOT NULL,
 conversation_ref text NOT NULL,
 idempotency_key text NOT NULL,
 params_hash text NOT NULL,
 reference_id text NOT NULL UNIQUE,
 state text NOT NULL CHECK (state IN ('sending','succeeded','failed','recovery_required')),
 source_message_id text,
 source_content_hash text,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
ALTER TABLE cw_communication_sends ADD COLUMN acknowledged_at timestamptz;
