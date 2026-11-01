-- Private current-project reminder recovery does not scan other workflows or employees.
CREATE INDEX cw_runs_notification_history
ON cw_runs(workspace_id,actor_id,conversation_id,created_at DESC,id DESC)
WHERE workflow='manage_notifications';
