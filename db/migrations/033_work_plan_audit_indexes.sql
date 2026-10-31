-- Current-device provenance on each employee response/edit, separate from the original Run.
ALTER TABLE cw_work_plan_actions ADD COLUMN identity_credential_id uuid REFERENCES cw_identity_credentials;
ALTER TABLE cw_work_plan_versions ADD COLUMN identity_credential_id uuid REFERENCES cw_identity_credentials;
CREATE INDEX cw_work_plans_actor_project ON cw_work_plans(workspace_id,project_id,actor_id,created_at DESC);
CREATE INDEX cw_work_plan_actions_run ON cw_work_plan_actions(run_id);
