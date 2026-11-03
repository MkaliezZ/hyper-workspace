-- Owner-scoped project history uses keyset pagination; no instruction or result is listed.
CREATE INDEX cw_runs_actor_project_history
ON cw_runs(workspace_id,actor_id,conversation_id,created_at DESC,id DESC);
