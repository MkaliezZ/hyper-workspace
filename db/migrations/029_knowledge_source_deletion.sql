ALTER TABLE cw_run_knowledge_sources DROP CONSTRAINT cw_run_knowledge_sources_asset_id_fkey;
ALTER TABLE cw_run_knowledge_sources ADD CONSTRAINT cw_run_knowledge_sources_asset_id_fkey FOREIGN KEY(asset_id) REFERENCES cw_assets ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION cw_redact_knowledge_for_asset(changed_asset uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE cw_runs SET knowledge_answer=NULL,instruction='',result=NULL,
   knowledge_plan=jsonb_set(knowledge_plan,'{query}','""'::jsonb),
   state=CASE WHEN state IN ('queued','running','waiting_input','waiting_confirmation') THEN 'failed' ELSE state END,
   error='检索来源已变化或失效，私人回答已清理。',updated_at=clock_timestamp()
 WHERE id IN (SELECT run_id FROM cw_run_knowledge_sources WHERE asset_id=changed_asset) AND knowledge_plan IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION cw_redact_changed_knowledge_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM cw_redact_knowledge_for_asset(OLD.id); RETURN OLD; END IF;
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
  PERFORM cw_redact_knowledge_for_asset(OLD.id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER cw_redact_changed_knowledge_answers ON cw_assets;
CREATE TRIGGER cw_redact_changed_knowledge_answers BEFORE UPDATE OR DELETE ON cw_assets FOR EACH ROW EXECUTE FUNCTION cw_redact_changed_knowledge_answers();
