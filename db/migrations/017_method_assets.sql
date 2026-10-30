-- P04/P05/P06/P07 C02/C04/C06 A06/A07/A08/A09/A10 E01/E04/E05/E06/E07/E09/E10 subsets.
CREATE TABLE cw_methods (
 id uuid PRIMARY KEY REFERENCES cw_assets,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL REFERENCES cw_projects,
 maintainer_id uuid NOT NULL REFERENCES cw_users,
 source_artifact_id uuid NOT NULL,
 source_artifact_version integer NOT NULL,
 current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate','published','withdrawn')),
 verification text NOT NULL DEFAULT 'candidate' CHECK(verification IN ('candidate','employee_verified')),
 verification_evidence text NOT NULL DEFAULT '',
 publication_scope text NOT NULL DEFAULT 'project' CHECK(publication_scope IN ('project','workspace')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(source_artifact_id,source_artifact_version) REFERENCES cw_artifact_versions(artifact_id,version),
 CHECK(state<>'published' OR verification='employee_verified'),
 CHECK(verification<>'employee_verified' OR length(verification_evidence)>0)
);
CREATE INDEX cw_methods_workspace_project ON cw_methods(workspace_id,project_id);
CREATE TABLE cw_method_versions (
 method_id uuid NOT NULL REFERENCES cw_methods,
 version integer NOT NULL CHECK(version>0),
 title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('sop','template','case','rubric','glossary')),
 content text NOT NULL,
 actor_id uuid NOT NULL REFERENCES cw_users,
 source_run_id uuid REFERENCES cw_runs,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(method_id,version)
);
CREATE TABLE cw_method_actions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 method_id uuid NOT NULL REFERENCES cw_methods,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 source_run_id uuid REFERENCES cw_runs,
 operation text NOT NULL CHECK(operation IN ('create','revise','verify','publish','withdraw')),
 version integer NOT NULL,
 revision integer NOT NULL,
 policy_version text NOT NULL DEFAULT '1.0.0',
 input_hash text NOT NULL,
 idempotency_key text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key),
 UNIQUE(method_id,revision),
 FOREIGN KEY(method_id,version) REFERENCES cw_method_versions(method_id,version)
);
ALTER TABLE cw_runs ADD COLUMN method_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN method_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(method_refs)='array');
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_method_plan CHECK((workflow='manage_method' AND method_plan IS NOT NULL) OR (workflow<>'manage_method' AND method_plan IS NULL));
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_method_refs CHECK(method_refs='[]'::jsonb OR workflow IN ('discussion_to_minutes','project_report','revise_artifact'));
CREATE TABLE cw_method_uses (
 run_id uuid NOT NULL REFERENCES cw_runs,
 method_id uuid NOT NULL,
 method_version integer NOT NULL,
 method_revision integer NOT NULL,
 context_prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,method_id),
 FOREIGN KEY(method_id,method_version) REFERENCES cw_method_versions(method_id,version),
 FOREIGN KEY(method_id,method_revision) REFERENCES cw_method_actions(method_id,revision)
);
