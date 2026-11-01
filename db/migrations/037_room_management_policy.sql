-- Source provider is server-bound; standalone room Runs inherit the actual linked project's current Policy.
ALTER TABLE cw_runs ADD COLUMN room_management_provider_key text;
