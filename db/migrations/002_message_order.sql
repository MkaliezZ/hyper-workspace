ALTER TABLE cw_messages ADD COLUMN IF NOT EXISTS position bigserial;
CREATE UNIQUE INDEX IF NOT EXISTS cw_messages_position ON cw_messages(position);
ALTER TABLE cw_messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE cw_tasks ALTER COLUMN created_at SET DEFAULT clock_timestamp();
