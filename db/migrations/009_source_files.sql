-- P02/P04/P07 C02/C07 A04/A06/A10: employee-selected, personal file snapshots.
CREATE TABLE cw_source_files (
 asset_id uuid PRIMARY KEY REFERENCES cw_assets ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 provider_key text NOT NULL,
 remote_file_id text NOT NULL,
 path jsonb NOT NULL,
 source_etag text NOT NULL,
 size_bytes bigint NOT NULL,
 content_mime text NOT NULL,
 content_sha256 text NOT NULL,
 parser_version text NOT NULL DEFAULT 'utf8-text-v1',
 imported_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,provider_key,remote_file_id)
);
CREATE INDEX cw_source_files_owner ON cw_source_files(workspace_id,actor_id);
