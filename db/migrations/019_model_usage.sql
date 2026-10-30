CREATE TABLE cw_model_requests (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 model_profile_id uuid NOT NULL REFERENCES cw_model_profiles,
 run_id uuid REFERENCES cw_runs,
 purpose text NOT NULL CHECK(purpose IN ('run','chat','embedding','verification')),
 model text NOT NULL,
 provider text NOT NULL,
 transport text NOT NULL DEFAULT 'unknown' CHECK(transport IN ('unknown','completed','rejected')),
 usage_status text NOT NULL DEFAULT 'unknown' CHECK(usage_status IN ('unknown','partial','reported','invalid')),
 input_tokens bigint CHECK(input_tokens>=0),
 output_tokens bigint CHECK(output_tokens>=0),
 cache_read_tokens bigint CHECK(cache_read_tokens>=0),
 cache_write_tokens bigint CHECK(cache_write_tokens>=0),
 reasoning_tokens bigint CHECK(reasoning_tokens>=0),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz
);
CREATE INDEX cw_model_requests_actor_time ON cw_model_requests(workspace_id,actor_id,started_at DESC);
CREATE INDEX cw_model_requests_run ON cw_model_requests(run_id) WHERE run_id IS NOT NULL;
