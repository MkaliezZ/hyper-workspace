-- P02/P04/P07/P08 C00/C03/C05 A01/A02/A06/A10 E01/E02/E04/E07/E09/E10 subsets.
-- Membership removal must remain possible; the stable historical link references the person, not current membership.
ALTER TABLE cw_tasks ADD COLUMN assignee_id uuid REFERENCES cw_users;
CREATE INDEX cw_tasks_employee ON cw_tasks(workspace_id,assignee_id) WHERE assignee_id IS NOT NULL;
CREATE TABLE cw_task_assignment_actions (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 task_id uuid NOT NULL REFERENCES cw_tasks,
 source_run_id uuid REFERENCES cw_runs,
 evidence jsonb NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,actor_id,idempotency_key)
);
ALTER TABLE cw_runs ADD COLUMN task_assignment_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_assignment_plan CHECK((workflow='assign_task' AND task_assignment_plan IS NOT NULL) OR (workflow<>'assign_task' AND task_assignment_plan IS NULL));
