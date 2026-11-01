-- P02/P04/P07 / C00,C03,C07 / A01,A06,A10. Product organization metadata, never source permissions.
CREATE TABLE cw_organization_states (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 binding_key text NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(workspace_id,binding_key)
);
CREATE TABLE cw_departments (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 binding_key text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 parent_id uuid REFERENCES cw_departments ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES cw_users,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,binding_key,id)
);
CREATE INDEX cw_departments_scope ON cw_departments(workspace_id,binding_key);
CREATE TABLE cw_department_people (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 binding_key text NOT NULL,
 remote_uid text NOT NULL,
 department_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,binding_key,remote_uid),
 FOREIGN KEY(workspace_id,binding_key,department_id) REFERENCES cw_departments(workspace_id,binding_key,id) ON DELETE RESTRICT
);
CREATE INDEX cw_department_people_department ON cw_department_people(workspace_id,binding_key,department_id);
ALTER TABLE cw_members ADD COLUMN role_revision integer NOT NULL DEFAULT 1 CHECK(role_revision>0);
CREATE TABLE cw_organization_changes (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 binding_key text NOT NULL,
 actor_id uuid NOT NULL REFERENCES cw_users,
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 revision integer NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create_department','update_department','delete_department','assign_department','change_role')),
 source_run_id uuid REFERENCES cw_runs,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
CREATE INDEX cw_organization_changes_scope ON cw_organization_changes(workspace_id,binding_key,created_at DESC);
ALTER TABLE cw_runs ADD COLUMN organization_plan jsonb;
