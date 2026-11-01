-- Independent company accounting: personal price declarations never authorize this ledger.
ALTER TABLE cw_projects ADD CONSTRAINT cw_projects_budget_scope UNIQUE(id,workspace_id);
ALTER TABLE cw_model_requests ADD CONSTRAINT cw_model_requests_budget_scope UNIQUE(id,workspace_id);
CREATE TABLE cw_budget_price_versions (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 price_key text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 provider text NOT NULL CHECK(provider IN ('openai-compatible','deepseek','anthropic')),
 endpoint text NOT NULL, model text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('chat','embedding')),
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 input_rate numeric(40,0) NOT NULL CHECK(input_rate>=0),
 output_rate numeric(40,0) NOT NULL CHECK(output_rate>=0),
 cache_read_rate numeric(40,0) NOT NULL CHECK(cache_read_rate>=0),
 cache_write_rate numeric(40,0) NOT NULL CHECK(cache_write_rate>=0),
 source_note text NOT NULL, declared_by uuid NOT NULL REFERENCES cw_users,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,price_key,version)
);
CREATE TABLE cw_budget_controls (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 scope text NOT NULL CHECK(scope IN ('workspace','project')),
 scope_id uuid NOT NULL,
 project_id uuid REFERENCES cw_projects,
 revision integer NOT NULL CHECK(revision>0),
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 daily_limit_picos numeric(40,0) CHECK(daily_limit_picos>=0),
 reservation_picos numeric(40,0) NOT NULL CHECK(reservation_picos>=0),
 PRIMARY KEY(workspace_id,scope_id),
 CHECK((scope='workspace' AND scope_id=workspace_id AND project_id IS NULL) OR
       (scope='project' AND project_id IS NOT NULL AND project_id=scope_id)),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id)
);
CREATE TABLE cw_budget_charges (
 request_id uuid PRIMARY KEY REFERENCES cw_model_requests,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 project_id uuid REFERENCES cw_projects,
 started_at timestamptz NOT NULL,
 price_key text, price_version integer,
 currency text CHECK(currency IN ('CNY','USD')),
 status text NOT NULL DEFAULT 'unpriced' CHECK(status IN ('unpriced','unknown','estimated','upper_estimate','declared')),
 estimated_picos numeric(40,0) CHECK(estimated_picos>=0),
 declared_picos numeric(40,0) CHECK(declared_picos>=0),
 workspace_revision integer, project_revision integer,
 workspace_reserved numeric(40,0) NOT NULL DEFAULT 0 CHECK(workspace_reserved>=0),
 project_reserved numeric(40,0) NOT NULL DEFAULT 0 CHECK(project_reserved>=0),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 review_required boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,price_key,price_version) REFERENCES cw_budget_price_versions(workspace_id,price_key,version),
 CHECK((price_key IS NULL)=(price_version IS NULL)),
 CHECK(price_version IS NULL OR currency IS NOT NULL),
 CHECK(workspace_revision IS NULL OR workspace_revision>0),
 CHECK(project_revision IS NULL OR project_revision>0),
 FOREIGN KEY(request_id,workspace_id) REFERENCES cw_model_requests(id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES cw_projects(id,workspace_id)
);
CREATE INDEX cw_budget_charges_workspace_day ON cw_budget_charges(workspace_id,started_at DESC);
CREATE INDEX cw_budget_charges_project_day ON cw_budget_charges(workspace_id,project_id,started_at DESC) WHERE project_id IS NOT NULL;
CREATE TABLE cw_budget_actions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users, project_id uuid REFERENCES cw_projects,
 source_run_id uuid REFERENCES cw_runs, idempotency_key text NOT NULL,
 input_hash text NOT NULL, plan jsonb NOT NULL, receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
-- Old personal estimates are not approved company prices. Preserve historical unknowns,
-- including this UTC day, so enabling an aggregate budget cannot silently omit them.
INSERT INTO cw_budget_charges(request_id,workspace_id,project_id,started_at)
 SELECT m.id,m.workspace_id,c.project_id,m.started_at FROM cw_model_requests m
 LEFT JOIN cw_runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id
 LEFT JOIN cw_conversations c ON c.id=r.conversation_id AND c.workspace_id=m.workspace_id;
