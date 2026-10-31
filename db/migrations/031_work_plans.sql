-- P01/P02/P04/P05/P07/P08 C01/C03/C04/C05 A01/A02/A03/A06/A08/A10.
CREATE TABLE cw_work_plans (
 run_id uuid PRIMARY KEY REFERENCES cw_runs,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL REFERENCES cw_projects,
 actor_id uuid NOT NULL REFERENCES cw_users,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 proposal jsonb NOT NULL,
 answers jsonb NOT NULL DEFAULT '{}',
 selections jsonb NOT NULL DEFAULT '{}',
 source_refs jsonb NOT NULL,
 binding_hash text NOT NULL,
 context_refs jsonb NOT NULL,
 context_bytes integer NOT NULL,
 evidence text NOT NULL CHECK(evidence IN ('fixture','runtime')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cw_work_plan_actions (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 idempotency_key uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES cw_work_plans,
 input_hash text NOT NULL,
 receipt jsonb NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,idempotency_key)
);
CREATE TABLE cw_run_wait_periods (
 run_id uuid PRIMARY KEY REFERENCES cw_runs,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ended_at timestamptz,
 CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE TABLE cw_work_plan_versions (
 run_id uuid NOT NULL REFERENCES cw_work_plans,
 revision integer NOT NULL,
 proposal jsonb NOT NULL,
 answers jsonb NOT NULL,
 selections jsonb NOT NULL,
 channel text NOT NULL CHECK(channel IN ('ai','human_response','human_edit','confirmation')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,revision)
);
