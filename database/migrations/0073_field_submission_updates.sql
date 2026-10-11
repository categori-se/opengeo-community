BEGIN;

CREATE TYPE app.field_submission_operation AS ENUM ('create', 'update');

ALTER TABLE app.field_submissions
  ADD COLUMN operation app.field_submission_operation NOT NULL DEFAULT 'create',
  ADD COLUMN target_feature_id uuid,
  ADD COLUMN target_feature_version bigint,
  ADD CONSTRAINT field_submissions_target_version_positive CHECK (
    target_feature_version IS NULL OR target_feature_version > 0
  ),
  ADD CONSTRAINT field_submissions_operation_shape CHECK (
    (operation = 'create'
      AND target_feature_id IS NULL
      AND target_feature_version IS NULL)
    OR (operation = 'update'
      AND target_feature_id IS NOT NULL
      AND target_feature_version IS NOT NULL)
  ),
  ADD CONSTRAINT field_submissions_target_feature_fk
  FOREIGN KEY (organization_id, dataset_id, target_feature_id)
  REFERENCES app.dataset_features (organization_id, dataset_id, id);

ALTER TABLE app.field_submissions
  DROP CONSTRAINT field_submissions_review_shape,
  ADD CONSTRAINT field_submissions_review_shape CHECK (
    (state = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_message IS NULL AND promoted_feature_id IS NULL)
    OR (state = 'in_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_message IS NULL AND promoted_feature_id IS NULL)
    OR (state IN ('changes_requested', 'rejected')
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_message IS NOT NULL AND promoted_feature_id IS NULL)
    OR (state = 'accepted' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND promoted_feature_id = CASE
        WHEN operation = 'create' THEN id
        ELSE target_feature_id
      END)
  );

CREATE INDEX field_submissions_target_feature_idx
  ON app.field_submissions (
    organization_id, dataset_id, target_feature_id, submitted_at, id
  )
  WHERE target_feature_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_field_submission_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.form_id IS DISTINCT FROM NEW.form_id
    OR OLD.form_version IS DISTINCT FROM NEW.form_version
    OR OLD.supersedes_submission_id IS DISTINCT FROM NEW.supersedes_submission_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.target_feature_id IS DISTINCT FROM NEW.target_feature_id
    OR OLD.target_feature_version IS DISTINCT FROM NEW.target_feature_version
    OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
    OR OLD.geometry_type IS DISTINCT FROM NEW.geometry_type
    OR OLD.properties IS DISTINCT FROM NEW.properties
    OR OLD.geometry_geojson IS DISTINCT FROM NEW.geometry_geojson
    OR NOT ST_Equals(OLD.geometry, NEW.geometry)
    OR OLD.submitted_by IS DISTINCT FROM NEW.submitted_by
    OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
  THEN
    RAISE EXCEPTION 'field submission identity and payload are immutable';
  END IF;
  IF NEW.review_version <> OLD.review_version + 1 THEN
    RAISE EXCEPTION 'field submission review version must increase exactly once';
  END IF;
  IF NOT (
    (OLD.state = 'submitted' AND NEW.state = 'in_review')
    OR (OLD.state = 'in_review' AND NEW.state IN ('changes_requested', 'rejected', 'accepted'))
  ) THEN
    RAISE EXCEPTION 'invalid field submission review transition';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TYPE app.field_submission_operation IS
  'Whether review creates a new stable feature or replaces one exact existing feature version.';
COMMENT ON COLUMN app.field_submissions.target_feature_id IS
  'Immutable authoritative feature identity for an update submission; null for create.';
COMMENT ON COLUMN app.field_submissions.target_feature_version IS
  'Immutable offline base version that must still be current when an update is accepted.';
COMMENT ON TABLE app.field_submissions IS
  'Idempotent quarantined create or exact-base update observations; acceptance alone mutates authoritative features.';

COMMIT;
