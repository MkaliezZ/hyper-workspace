ALTER TABLE cw_runs ADD COLUMN knowledge_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN knowledge_answer jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_knowledge_plan CHECK ((workflow='query_knowledge' AND knowledge_plan IS NOT NULL) OR (workflow<>'query_knowledge' AND knowledge_plan IS NULL));
CREATE TABLE cw_run_knowledge_sources (
 run_id uuid NOT NULL REFERENCES cw_runs ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES cw_assets,
 source_version text NOT NULL,
 PRIMARY KEY(run_id,asset_id)
);
CREATE INDEX cw_run_knowledge_sources_asset ON cw_run_knowledge_sources(asset_id,source_version);
CREATE FUNCTION cw_redact_changed_knowledge_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
  NEW.embedding=NULL; NEW.embedding_profile_id=NULL; NEW.embedding_dimensions=NULL;
  NEW.embedding_source_version=NULL; NEW.embedding_model=NULL; NEW.embedding_version=NULL; NEW.indexed_at=NULL;
  NEW.updated_at=clock_timestamp(); DELETE FROM cw_asset_chunks WHERE asset_id=OLD.id;
 END IF;
 IF NEW.content IS DISTINCT FROM OLD.content OR NEW.title IS DISTINCT FROM OLD.title
 OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.source_version IS DISTINCT FROM OLD.source_version
 OR NEW.validity IS DISTINCT FROM OLD.validity OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
 OR NEW.visibility IS DISTINCT FROM OLD.visibility OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
 OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  UPDATE cw_runs SET knowledge_answer=NULL,instruction='',result=NULL,
   knowledge_plan=jsonb_set(knowledge_plan,'{query}','""'::jsonb),
   state=CASE WHEN state IN ('queued','running','waiting_input','waiting_confirmation') THEN 'failed' ELSE state END,
   error='检索来源已变化或失效，私人回答已清理。',updated_at=clock_timestamp()
  WHERE id IN (SELECT run_id FROM cw_run_knowledge_sources WHERE asset_id=OLD.id) AND knowledge_plan IS NOT NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cw_redact_changed_knowledge_answers BEFORE UPDATE ON cw_assets FOR EACH ROW EXECUTE FUNCTION cw_redact_changed_knowledge_answers();
