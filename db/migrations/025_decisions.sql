-- Product-owned decisions, separate from messages, tasks and artifact review opinions.
CREATE TABLE cw_decisions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL REFERENCES cw_projects,
 created_by uuid NOT NULL REFERENCES cw_users,
 current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),
 state text NOT NULL CHECK(state IN ('proposed','confirmed','withdrawn','superseded')),
 confirmed_by uuid REFERENCES cw_users,
 confirmed_at timestamptz,
 supersedes_id uuid REFERENCES cw_decisions,
 superseded_by uuid REFERENCES cw_decisions,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(supersedes_id IS NULL OR supersedes_id<>id),
 CHECK(superseded_by IS NULL OR superseded_by<>id),
 CHECK((state='superseded')=(superseded_by IS NOT NULL))
);
CREATE INDEX cw_decisions_project ON cw_decisions(workspace_id,project_id,state,updated_at);
CREATE TABLE cw_decision_versions (
 decision_id uuid NOT NULL REFERENCES cw_decisions,
 version integer NOT NULL CHECK(version>0),
 snapshot jsonb NOT NULL,
 source_refs jsonb NOT NULL DEFAULT '[]',
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 source_run_id uuid REFERENCES cw_runs,
 channel text NOT NULL CHECK(channel IN ('human','ai_assisted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(decision_id,version)
);
CREATE TABLE cw_decision_actions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL REFERENCES cw_projects,
 actor_id uuid NOT NULL REFERENCES cw_users,
 idempotency_key text NOT NULL,
 params_hash text NOT NULL,
 result jsonb NOT NULL,
 source_run_id uuid REFERENCES cw_runs,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
