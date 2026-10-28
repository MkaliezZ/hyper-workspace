CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS cw_users (
 id uuid PRIMARY KEY, name text NOT NULL, nextcloud_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_workspaces (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS cw_members (
 workspace_id uuid REFERENCES cw_workspaces ON DELETE CASCADE, user_id uuid REFERENCES cw_users ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('admin','member')), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS cw_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE, demo boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_projects (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 name text NOT NULL, goal text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cw_conversations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, project_id uuid NOT NULL REFERENCES cw_projects,
 provider_id text, UNIQUE(project_id)
);
CREATE TABLE IF NOT EXISTS cw_messages (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, conversation_id uuid NOT NULL REFERENCES cw_conversations,
 author_id uuid REFERENCES cw_users, author text NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant','system')),
 content text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cw_messages_conversation ON cw_messages(conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS cw_tasks (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, project_id uuid NOT NULL REFERENCES cw_projects,
 title text NOT NULL, assignee text NOT NULL DEFAULT '待分配', due_date date,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')), created_by uuid NOT NULL REFERENCES cw_users,
 source_run_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_artifacts (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, project_id uuid NOT NULL REFERENCES cw_projects,
 title text NOT NULL, status text NOT NULL DEFAULT 'draft', current_version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES cw_users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_artifact_versions (
 artifact_id uuid NOT NULL REFERENCES cw_artifacts ON DELETE CASCADE, version integer NOT NULL,
 content text NOT NULL, feedback text NOT NULL DEFAULT '', source_message_ids jsonb NOT NULL DEFAULT '[]',
 created_by uuid NOT NULL REFERENCES cw_users, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(artifact_id,version)
);
CREATE TABLE IF NOT EXISTS cw_assets (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, project_id uuid REFERENCES cw_projects,
 owner_id uuid NOT NULL REFERENCES cw_users, visibility text NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private')),
 title text NOT NULL, content text NOT NULL, type text NOT NULL, source_ref text,
 source_version text NOT NULL, validity text NOT NULL DEFAULT 'active', deleted_at timestamptz,
 embedding vector, embedding_model text, embedding_version text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_asset_links (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 from_id uuid NOT NULL, to_id uuid NOT NULL, relation text NOT NULL, source_version text NOT NULL,
 UNIQUE(workspace_id,from_id,to_id,relation)
);
CREATE TABLE IF NOT EXISTS cw_model_profiles (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, owner_id uuid REFERENCES cw_users,
 name text NOT NULL, provider text NOT NULL, endpoint text NOT NULL, model text NOT NULL, purpose text NOT NULL,
 credential_enc text, key_hint text, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, actor_id uuid NOT NULL REFERENCES cw_users,
 conversation_id uuid NOT NULL REFERENCES cw_conversations, engine text NOT NULL,
 workflow text NOT NULL, instruction text NOT NULL, artifact_id uuid,
 state text NOT NULL DEFAULT 'queued', policy_version text NOT NULL DEFAULT '1.0.0', demo boolean NOT NULL DEFAULT false,
 lease_owner uuid, lease_expires_at timestamptz,
 idempotency_key text NOT NULL, input_hash text NOT NULL, result jsonb, error text,
 next_sequence integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS cw_run_events (
 event_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES cw_runs ON DELETE CASCADE,
 sequence integer NOT NULL, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS cw_actions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces, actor_id uuid NOT NULL REFERENCES cw_users,
 run_id uuid NOT NULL REFERENCES cw_runs, tool text NOT NULL, params_hash text NOT NULL,
 idempotency_key text NOT NULL UNIQUE, state text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cw_confirmations (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES cw_runs, actor_id uuid NOT NULL REFERENCES cw_users,
 args_hash text NOT NULL, proposal jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

