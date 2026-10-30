-- P02/P04/P05/P07/P08 C01/C02/C04/C05 A02/A06/A09/A10; product-owned clarification, no native checkpoint.
CREATE TABLE cw_work_briefs (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL,
 owner_id uuid NOT NULL REFERENCES cw_users,
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('draft','needs_input','confirmed')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array'),
 confirmed_by uuid REFERENCES cw_users,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id),
 CHECK((status='confirmed')=(confirmed_by IS NOT NULL))
);
CREATE INDEX cw_work_briefs_project ON cw_work_briefs(workspace_id,project_id,updated_at DESC);
CREATE TABLE cw_work_brief_versions (
 brief_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 version integer NOT NULL,
 snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES cw_users,
 source_run_id uuid REFERENCES cw_runs,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(brief_id,version),
 FOREIGN KEY(brief_id,workspace_id) REFERENCES cw_work_briefs(id,workspace_id)
);
CREATE TABLE cw_work_brief_actions (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 receipt jsonb NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,idempotency_key)
);
ALTER TABLE cw_runs ADD COLUMN brief_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN brief_ref jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_brief_plan CHECK((workflow='manage_brief' AND brief_plan IS NOT NULL) OR (workflow<>'manage_brief' AND brief_plan IS NULL));
