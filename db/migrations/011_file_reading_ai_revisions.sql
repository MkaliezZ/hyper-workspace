-- P02/P04/P05/P07 C02/C04/C05 A04/A08/A09/A10: private, optimistic AI revisions.
ALTER TABLE cw_runs ADD COLUMN source_file_reading_id uuid REFERENCES cw_file_readings(id);
ALTER TABLE cw_runs ADD COLUMN expected_reading_version integer;
ALTER TABLE cw_runs DROP CONSTRAINT cw_run_source_scope;
ALTER TABLE cw_runs ADD CONSTRAINT cw_run_source_scope CHECK (
 (workflow='read_file' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL
  AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
 OR (workflow='revise_file_reading' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL
  AND source_file_reading_id IS NOT NULL AND expected_reading_version IS NOT NULL AND expected_reading_version>0)
 OR (workflow NOT IN ('read_file','revise_file_reading') AND conversation_id IS NOT NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL
  AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
);
ALTER TABLE cw_file_reading_versions ADD COLUMN source_run_id uuid UNIQUE REFERENCES cw_runs(id);
UPDATE cw_file_reading_versions v SET source_run_id=f.source_run_id
 FROM cw_file_readings f WHERE v.reading_id=f.id AND v.version=1;
