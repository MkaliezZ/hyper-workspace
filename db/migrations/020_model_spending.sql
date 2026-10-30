CREATE TABLE cw_model_spend_controls (
 model_profile_id uuid PRIMARY KEY REFERENCES cw_model_profiles,
 revision integer NOT NULL CHECK(revision>0),
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 daily_limit_picos numeric(40,0),
 reservation_picos numeric(40,0) NOT NULL CHECK(reservation_picos>=0),
 CHECK(daily_limit_picos IS NULL OR daily_limit_picos>=0)
);
CREATE TABLE cw_model_price_versions (
 model_profile_id uuid NOT NULL REFERENCES cw_model_profiles,
 version integer NOT NULL CHECK(version>0),
 currency text NOT NULL CHECK(currency IN ('CNY','USD')),
 input_rate numeric(40,0) NOT NULL CHECK(input_rate>=0),
 output_rate numeric(40,0) NOT NULL CHECK(output_rate>=0),
 cache_read_rate numeric(40,0) NOT NULL CHECK(cache_read_rate>=0),
 cache_write_rate numeric(40,0) NOT NULL CHECK(cache_write_rate>=0),
 source_note text NOT NULL,
 declared_by uuid NOT NULL REFERENCES cw_users,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(model_profile_id,version)
);
ALTER TABLE cw_model_requests ADD COLUMN price_version integer;
ALTER TABLE cw_model_requests ADD COLUMN cost_currency text CHECK(cost_currency IN ('CNY','USD'));
ALTER TABLE cw_model_requests ADD COLUMN cost_status text NOT NULL DEFAULT 'unpriced' CHECK(cost_status IN ('unpriced','unknown','estimated','upper_estimate','declared'));
ALTER TABLE cw_model_requests ADD COLUMN estimated_cost_picos numeric(40,0) CHECK(estimated_cost_picos>=0);
ALTER TABLE cw_model_requests ADD COLUMN declared_cost_picos numeric(40,0) CHECK(declared_cost_picos>=0);
ALTER TABLE cw_model_requests ADD COLUMN reserved_picos numeric(40,0) NOT NULL DEFAULT 0 CHECK(reserved_picos>=0);
ALTER TABLE cw_model_requests ADD COLUMN budget_revision integer;
ALTER TABLE cw_model_requests ADD COLUMN charge_revision integer NOT NULL DEFAULT 0 CHECK(charge_revision>=0);
ALTER TABLE cw_model_requests ADD COLUMN charge_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE cw_model_requests ADD CONSTRAINT cw_model_requests_price_ref FOREIGN KEY(model_profile_id,price_version) REFERENCES cw_model_price_versions(model_profile_id,version);
ALTER TABLE cw_runs ADD COLUMN spending_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_spending_plan CHECK((workflow='manage_spending' AND spending_plan IS NOT NULL) OR (workflow<>'manage_spending' AND spending_plan IS NULL));
CREATE TABLE cw_model_spend_actions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces,
 actor_id uuid NOT NULL REFERENCES cw_users,
 model_profile_id uuid NOT NULL REFERENCES cw_model_profiles,
 source_run_id uuid REFERENCES cw_runs,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 plan jsonb NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,idempotency_key)
);
