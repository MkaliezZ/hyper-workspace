-- P02/P04/P07/P08 C03/C05/C07 A01/A02/A06/A10 E01/E02/E04/E07/E09/E10 subsets.
ALTER TABLE cw_tasks ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE cw_tasks ADD CONSTRAINT cw_tasks_id_workspace UNIQUE(id,workspace_id);
CREATE TABLE cw_task_versions (
 task_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 actor_id uuid REFERENCES cw_users,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 source_run_id uuid REFERENCES cw_runs,
 channel text NOT NULL CHECK(channel IN ('legacy_snapshot','human','ai')),
 policy_version text NOT NULL DEFAULT '1.0.0',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,version),
 FOREIGN KEY(task_id,workspace_id) REFERENCES cw_tasks(id,workspace_id) ON DELETE CASCADE,
 CHECK((channel='legacy_snapshot' AND actor_id IS NULL AND source_run_id IS NULL)
 OR (channel='human' AND actor_id IS NOT NULL AND source_run_id IS NULL)
 OR (channel='ai' AND actor_id IS NOT NULL AND source_run_id IS NOT NULL))
);
-- A migration snapshot is the current authoritative state, not an invented edit history.
INSERT INTO cw_task_versions(task_id,workspace_id,version,snapshot,channel)
 SELECT id,workspace_id,1,jsonb_build_object('title',title,'assignee',assignee,'dueDate',due_date::text,'status',status),'legacy_snapshot'
 FROM cw_tasks;
ALTER TABLE cw_runs ADD COLUMN task_id uuid REFERENCES cw_tasks;
ALTER TABLE cw_runs ADD COLUMN expected_task_version integer;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_task_target CHECK(
 (workflow='revise_task' AND task_id IS NOT NULL AND expected_task_version IS NOT NULL AND expected_task_version>0)
 OR (workflow<>'revise_task' AND task_id IS NULL AND expected_task_version IS NULL)
);
