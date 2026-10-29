-- P02/P04/P07 C02/C04/C07 A04/A08/A10 E02/E04/E05/E07/E09 subsets.
ALTER TABLE cw_source_files ADD COLUMN extraction_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cw_source_files ADD CONSTRAINT cw_source_files_extraction_object CHECK(jsonb_typeof(extraction_metadata)='object');
