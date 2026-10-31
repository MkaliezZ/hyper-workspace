-- Multiple product-owned clarification/model phases within one Run; no private checkpoint reuse.
ALTER TABLE cw_run_wait_periods DROP CONSTRAINT cw_run_wait_periods_pkey;
ALTER TABLE cw_run_wait_periods ADD COLUMN id bigserial PRIMARY KEY;
CREATE INDEX cw_run_wait_periods_run ON cw_run_wait_periods(run_id);
CREATE UNIQUE INDEX cw_run_wait_periods_open ON cw_run_wait_periods(run_id) WHERE ended_at IS NULL;
