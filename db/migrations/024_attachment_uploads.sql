-- Local bytes are bounded request input; Nextcloud remains the original-file authority.
CREATE TABLE cw_attachment_uploads (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid NOT NULL REFERENCES cw_identity_credentials,
 provider_key text NOT NULL,
 source_actor_id text NOT NULL,
 conversation_ref text NOT NULL,
 idempotency_key text NOT NULL,
 params_hash text NOT NULL,
 file_name text NOT NULL,
 source_path jsonb NOT NULL,
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('prepared','uploading','succeeded','failed','recovery_required')),
 source_file jsonb,
 error text,
 attempted_at timestamptz,
 acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
CREATE INDEX cw_attachment_uploads_pending ON cw_attachment_uploads(workspace_id,actor_id,provider_key,conversation_ref) WHERE state IN ('prepared','uploading','recovery_required') AND acknowledged_at IS NULL;
