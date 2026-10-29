-- P03/P04/P07/P08 C03/C05/C07 A01/A02/A06/A10 E03/E04/E09/E10 subset.
CREATE TABLE cw_follow_up_schedules (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 project_id uuid NOT NULL,
 conversation_id uuid NOT NULL REFERENCES cw_conversations,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 demo boolean NOT NULL,
 engine text NOT NULL CHECK(engine IN ('dsh','hermes','fixture')),
 model_profile_id uuid REFERENCES cw_model_profiles,
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 15 AND 1440),
 max_checks integer NOT NULL CHECK(max_checks BETWEEN 1 AND 96),
 checks_started integer NOT NULL DEFAULT 0 CHECK(checks_started>=0 AND checks_started<=max_checks),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','cancelled','completed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 next_check_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '30 days'),
 last_run_id uuid REFERENCES cw_runs,
 last_error text,
 lease_owner uuid,
 lease_expires_at timestamptz,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 source_run_id uuid REFERENCES cw_runs,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id),
 UNIQUE(workspace_id,actor_id,idempotency_key),
 CHECK((state='active')=(next_check_at IS NOT NULL)),
 CHECK((engine='fixture' AND demo AND model_profile_id IS NULL) OR (engine IN ('dsh','hermes') AND model_profile_id IS NOT NULL))
);
CREATE UNIQUE INDEX cw_follow_up_schedule_active ON cw_follow_up_schedules(workspace_id,actor_id,project_id) WHERE state IN ('active','paused');
CREATE INDEX cw_follow_up_schedule_due ON cw_follow_up_schedules(next_check_at,id) WHERE state='active';
ALTER TABLE cw_runs ADD COLUMN follow_up_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN follow_up_schedule_id uuid REFERENCES cw_follow_up_schedules;
ALTER TABLE cw_runs ADD COLUMN follow_up_schedule_version integer;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_schedule_binding CHECK(
 (follow_up_schedule_id IS NULL AND follow_up_schedule_version IS NULL)
 OR (workflow='follow_up' AND follow_up_schedule_id IS NOT NULL AND follow_up_schedule_version IS NOT NULL AND follow_up_schedule_version>0)
);
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_follow_up_plan CHECK((workflow='configure_follow_up')=(follow_up_plan IS NOT NULL));
CREATE INDEX cw_runs_follow_up_schedule ON cw_runs(follow_up_schedule_id,created_at) WHERE follow_up_schedule_id IS NOT NULL;
CREATE TABLE cw_follow_up_configuration_receipts (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id,idempotency_key)
);
