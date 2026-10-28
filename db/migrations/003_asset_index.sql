ALTER TABLE cw_assets ADD COLUMN IF NOT EXISTS embedding_profile_id uuid REFERENCES cw_model_profiles;
ALTER TABLE cw_assets ADD COLUMN IF NOT EXISTS embedding_dimensions integer;
ALTER TABLE cw_assets ADD COLUMN IF NOT EXISTS embedding_source_version text;
ALTER TABLE cw_assets ADD COLUMN IF NOT EXISTS indexed_at timestamptz;
ALTER TABLE cw_assets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS cw_assets_source ON cw_assets(workspace_id,source_ref);

-- Product-owned artifact copies follow the current artifact version.
UPDATE cw_assets x SET content=v.content,source_version=v.version::text,
 embedding=NULL,embedding_model=NULL,embedding_version=NULL,updated_at=clock_timestamp()
FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
WHERE x.workspace_id=a.workspace_id AND x.source_ref='artifact:'||a.id::text
 AND (x.source_version<>v.version::text OR x.content<>v.content);
