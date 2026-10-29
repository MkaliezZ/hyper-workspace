-- P04/P07 C00/C04/C05 A03/A10: employee-owned AI message drafts, never a source send.
CREATE TABLE cw_communication_drafts (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES cw_users,
 source_run_id uuid NOT NULL UNIQUE REFERENCES cw_runs,
 content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 20000),
 source_message_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id),
 FOREIGN KEY(project_id) REFERENCES cw_project_sources(project_id)
);
CREATE INDEX cw_communication_drafts_owner ON cw_communication_drafts(workspace_id,actor_id,project_id,created_at DESC);
ALTER TABLE cw_communication_sends ADD COLUMN draft_id uuid REFERENCES cw_communication_drafts;
ALTER TABLE cw_communication_sends ADD COLUMN draft_modified boolean;
CREATE UNIQUE INDEX cw_communication_draft_delivery ON cw_communication_sends(draft_id)
 WHERE draft_id IS NOT NULL AND state IN ('sending','succeeded','recovery_required');
