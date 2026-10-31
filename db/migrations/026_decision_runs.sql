ALTER TABLE cw_runs ADD COLUMN decision_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_decision_plan CHECK ((workflow='manage_decision' AND decision_plan IS NOT NULL) OR (workflow<>'manage_decision' AND decision_plan IS NULL));
