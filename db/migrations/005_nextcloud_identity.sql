-- A01 / C00 / E04,E09: stable source identity, independently revocable device credentials.
CREATE TABLE cw_external_identities (
 id uuid PRIMARY KEY,
 provider_key text NOT NULL,
 remote_uid text NOT NULL,
 user_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider_key,workspace_id,remote_uid),
 UNIQUE(provider_key,workspace_id,user_id)
);
CREATE TABLE cw_identity_credentials (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES cw_external_identities ON DELETE CASCADE,
 login_name text NOT NULL,
 credential_enc text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),
 disabled_at timestamptz
);
ALTER TABLE cw_sessions ADD COLUMN identity_credential_id uuid REFERENCES cw_identity_credentials ON DELETE CASCADE;
ALTER TABLE cw_runs ADD COLUMN identity_credential_id uuid REFERENCES cw_identity_credentials;
CREATE INDEX cw_identity_credentials_identity ON cw_identity_credentials(identity_id);
CREATE TABLE cw_login_flows (
 id uuid PRIMARY KEY,
 binding_hash text NOT NULL,
 provider_key text NOT NULL,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 poll_token_enc text,
 upstream_credentials_enc text,
 session_token_enc text,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 next_poll_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cw_login_flows_expiry ON cw_login_flows(expires_at);
