-- P02/P04/P05/P07 C02/C04/C05 A04/A06/A08/A10: private source-bound readings.
ALTER TABLE cw_runs ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE cw_runs ADD COLUMN source_file_asset_id uuid REFERENCES cw_source_files(asset_id);
ALTER TABLE cw_runs ADD COLUMN expected_file_version text;
ALTER TABLE cw_runs ADD COLUMN runtime_cleaned_at timestamptz;
ALTER TABLE cw_runs ADD CONSTRAINT cw_run_source_scope CHECK (
 (workflow='read_file' AND conversation_id IS NULL AND artifact_id IS NULL AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL)
 OR (workflow<>'read_file' AND conversation_id IS NOT NULL AND source_file_asset_id IS NULL AND expected_file_version IS NULL)
);
CREATE INDEX cw_runs_file ON cw_runs(source_file_asset_id,expected_file_version) WHERE source_file_asset_id IS NOT NULL;
CREATE TABLE cw_file_readings (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 source_asset_id uuid NOT NULL REFERENCES cw_source_files(asset_id),
 source_version text NOT NULL,
 source_run_id uuid NOT NULL UNIQUE REFERENCES cw_runs,
 current_version integer NOT NULL DEFAULT 1,
 invalidated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cw_file_reading_versions (
 reading_id uuid NOT NULL REFERENCES cw_file_readings ON DELETE CASCADE,
 version integer NOT NULL,
 content text NOT NULL,
 created_by uuid NOT NULL REFERENCES cw_users,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(reading_id,version)
);
CREATE INDEX cw_file_readings_owner ON cw_file_readings(workspace_id,actor_id,source_asset_id,created_at DESC);
