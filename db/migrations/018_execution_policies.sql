CREATE TABLE cw_execution_policies (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 scope text NOT NULL CHECK(scope IN ('workspace','project','personal')),
 scope_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object'),
 updated_by uuid NOT NULL REFERENCES cw_users,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,scope,scope_id)
);
CREATE TABLE cw_execution_policy_changes (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 scope text NOT NULL,
 scope_id uuid NOT NULL,
 revision integer NOT NULL,
 rules jsonb NOT NULL,
 source_run_id uuid REFERENCES cw_runs,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key),
 UNIQUE(workspace_id,scope,scope_id,revision)
);
ALTER TABLE cw_runs ADD COLUMN policy_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN task_rules jsonb NOT NULL DEFAULT '{}';
ALTER TABLE cw_runs ADD COLUMN execution_policy_snapshot jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_policy_plan CHECK((workflow='configure_policy' AND policy_plan IS NOT NULL) OR (workflow<>'configure_policy' AND policy_plan IS NULL));
CREATE TABLE cw_policy_admissions (
 run_id uuid PRIMARY KEY REFERENCES cw_runs,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid REFERENCES cw_projects,
 actor_id uuid NOT NULL REFERENCES cw_users,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cw_policy_admissions_scope ON cw_policy_admissions(workspace_id,admitted_at);
