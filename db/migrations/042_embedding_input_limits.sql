-- Character limits are explicit provider configuration; they never silently
-- truncate source documents or alter the default preprocessing of old indexes.
ALTER TABLE cw_model_profiles ADD COLUMN embedding_input_chars integer NOT NULL DEFAULT 4000
 CHECK(embedding_input_chars BETWEEN 200 AND 4000);
