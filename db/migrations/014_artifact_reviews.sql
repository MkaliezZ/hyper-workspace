-- P04/P05/P07/P08 C04/C05 A01/A08/A09/A10 E04/E05/E07/E09/E10 subset.
ALTER TABLE cw_artifacts ADD COLUMN review_revision integer NOT NULL DEFAULT 0 CHECK(review_revision>=0);
ALTER TABLE cw_artifacts ADD COLUMN accepted_version integer;
ALTER TABLE cw_artifacts ADD CONSTRAINT cw_artifacts_id_workspace UNIQUE(id,workspace_id);
ALTER TABLE cw_artifacts ADD CONSTRAINT cw_artifacts_review_state CHECK(
 status IN ('draft','changes_requested','accepted') AND (
  (status='accepted' AND accepted_version IS NOT NULL AND accepted_version=current_version AND review_revision>0)
  OR (status<>'accepted' AND accepted_version IS NULL)
 )
);
ALTER TABLE cw_artifacts ADD CONSTRAINT cw_artifacts_accepted_version FOREIGN KEY(id,accepted_version) REFERENCES cw_artifact_versions(artifact_id,version);
CREATE TABLE cw_artifact_reviews (
 id uuid PRIMARY KEY,
 artifact_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 artifact_version integer NOT NULL,
 review_revision integer NOT NULL CHECK(review_revision>0),
 reviewer_id uuid NOT NULL REFERENCES cw_users,
 reviewer_authority text NOT NULL CHECK(reviewer_authority IN ('creator','workspace_admin')),
 identity_credential_id uuid REFERENCES cw_identity_credentials,
 policy_version text NOT NULL DEFAULT '1.0.0',
 decision text NOT NULL CHECK(decision IN ('accept','request_changes','reopen')),
 status_before text NOT NULL CHECK(status_before IN ('draft','changes_requested','accepted')),
 status_after text NOT NULL CHECK(status_after IN ('draft','changes_requested','accepted')),
 feedback text NOT NULL CHECK(length(feedback) BETWEEN 1 AND 4000),
 confirmed boolean NOT NULL CHECK(confirmed),
 channel text NOT NULL CHECK(channel IN ('human','ai_assisted')),
 source_run_id uuid REFERENCES cw_runs,
 idempotency_key text NOT NULL,
 input_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(artifact_id,workspace_id) REFERENCES cw_artifacts(id,workspace_id),
 FOREIGN KEY(artifact_id,artifact_version) REFERENCES cw_artifact_versions(artifact_id,version),
 UNIQUE(artifact_id,artifact_version,review_revision),
 UNIQUE(workspace_id,reviewer_id,idempotency_key),
 CHECK((channel='human' AND source_run_id IS NULL) OR (channel='ai_assisted' AND source_run_id IS NOT NULL))
);
ALTER TABLE cw_artifacts ADD CONSTRAINT cw_artifacts_accepted_review
 FOREIGN KEY(id,accepted_version,review_revision) REFERENCES cw_artifact_reviews(artifact_id,artifact_version,review_revision);
ALTER TABLE cw_runs ADD COLUMN artifact_review_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_runs_artifact_review_plan CHECK(
 (workflow='review_artifact')=(artifact_review_plan IS NOT NULL)
 AND (workflow<>'review_artifact' OR (artifact_id IS NOT NULL AND expected_artifact_version IS NOT NULL AND expected_artifact_version>0))
);
