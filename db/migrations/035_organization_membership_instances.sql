-- A01 / C00: role changes bind the current membership instance, including revoke/regrant ABA.
ALTER TABLE cw_members ADD COLUMN membership_id uuid NOT NULL DEFAULT gen_random_uuid();
