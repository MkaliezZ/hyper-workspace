-- P03/P04/P07/P08 C03/C05 A02/A06/A10 E03/E04/E09/E10 subset.
-- Product-owned observation; one shared baseline per authorized project.
CREATE TABLE cw_follow_up_baselines (
 project_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='array'),
 last_run_id uuid NOT NULL REFERENCES cw_runs,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX cw_tasks_workspace_project_id ON cw_tasks(workspace_id,project_id,id);
