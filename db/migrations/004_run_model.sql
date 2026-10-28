ALTER TABLE cw_runs ADD COLUMN IF NOT EXISTS model_profile_id uuid REFERENCES cw_model_profiles;
ALTER TABLE cw_runs ADD COLUMN IF NOT EXISTS expected_artifact_version integer;
