CREATE TABLE cw_asset_chunks (
 asset_id uuid NOT NULL REFERENCES cw_assets ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal>=0),
 char_start integer NOT NULL CHECK(char_start>=0),
 char_end integer NOT NULL CHECK(char_end>char_start),
 content text NOT NULL,
 source_version text NOT NULL,
 model_profile_id uuid NOT NULL REFERENCES cw_model_profiles,
 embedding_model text NOT NULL,
 embedding_dimensions integer NOT NULL,
 embedding_space_hash text NOT NULL,
 index_version text NOT NULL,
 embedding vector NOT NULL,
 indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(asset_id,ordinal)
);
CREATE INDEX cw_asset_chunks_model ON cw_asset_chunks(model_profile_id,embedding_dimensions,index_version);
-- Derived text must not survive a source mutation, withdrawal, removal or cleared index.
CREATE FUNCTION cw_clear_changed_asset_chunks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.content IS DISTINCT FROM OLD.content OR NEW.title IS DISTINCT FROM OLD.title
 OR NEW.source_version IS DISTINCT FROM OLD.source_version OR NEW.validity IS DISTINCT FROM OLD.validity
 OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.visibility IS DISTINCT FROM OLD.visibility
 OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
 OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  NEW.embedding=NULL; NEW.embedding_profile_id=NULL; NEW.embedding_dimensions=NULL;
  NEW.embedding_source_version=NULL; NEW.embedding_model=NULL; NEW.embedding_version=NULL; NEW.indexed_at=NULL;
  NEW.updated_at=clock_timestamp();
  DELETE FROM cw_asset_chunks WHERE asset_id=OLD.id;
 ELSIF NEW.embedding IS NULL OR NEW.validity<>'active' OR NEW.deleted_at IS NOT NULL THEN
  DELETE FROM cw_asset_chunks WHERE asset_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cw_clear_changed_asset_chunks BEFORE UPDATE ON cw_assets FOR EACH ROW EXECUTE FUNCTION cw_clear_changed_asset_chunks();
