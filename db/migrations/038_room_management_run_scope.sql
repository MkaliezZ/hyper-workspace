-- Extend the existing file/project partition with a source-bound private communication Run.
ALTER TABLE cw_runs DROP CONSTRAINT cw_run_source_scope;
ALTER TABLE cw_runs ADD CONSTRAINT cw_run_source_scope CHECK (
 (workflow='read_file' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL
  AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
 OR (workflow='revise_file_reading' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL
  AND source_file_reading_id IS NOT NULL AND expected_reading_version IS NOT NULL AND expected_reading_version>0)
 OR (workflow='manage_communication' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL
  AND source_file_reading_id IS NULL AND expected_reading_version IS NULL
  AND room_management_plan IS NOT NULL AND room_management_provider_key IS NOT NULL AND NOT demo)
 OR (workflow NOT IN ('read_file','revise_file_reading','manage_communication') AND conversation_id IS NOT NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL
  AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
);
ALTER TABLE cw_runs ADD CONSTRAINT cw_room_plan_scope CHECK (
 (workflow='manage_communication' AND room_management_plan IS NOT NULL AND room_management_provider_key IS NOT NULL)
 OR (workflow<>'manage_communication' AND room_management_plan IS NULL AND room_management_provider_key IS NULL)
);
