-- P02/P04/P07 C02/C03/C05 A03/A06/A08: one immutable source scope per new project.
ALTER TABLE cw_projects ADD CONSTRAINT cw_projects_id_workspace UNIQUE(id,workspace_id);
CREATE TABLE cw_project_sources (
 project_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 provider_key text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind='nextcloud-talk'),
 conversation_ref text NOT NULL CHECK(conversation_ref ~ '^[a-z0-9]{4,30}$'),
 created_by uuid NOT NULL REFERENCES cw_users,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id) ON DELETE CASCADE,
 UNIQUE(workspace_id,provider_key,source_kind,conversation_ref)
);

ALTER TABLE cw_runs ADD COLUMN context_refs jsonb NOT NULL DEFAULT '[]';
