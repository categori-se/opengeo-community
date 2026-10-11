BEGIN;

CREATE TYPE app.field_submission_state AS ENUM (
  'submitted',
  'in_review',
  'changes_requested',
  'rejected',
  'accepted'
);

CREATE TABLE app.field_forms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  current_version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, id),
  CONSTRAINT field_forms_version_positive CHECK (current_version > 0),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.feature_collections (organization_id, dataset_id)
);

CREATE TABLE app.field_form_versions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  form_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  instructions text,
  collection_generation bigint NOT NULL,
  geometry_type app.feature_geometry_type NOT NULL,
  schema_definition jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, form_id, version_number),
  CONSTRAINT field_form_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT field_form_versions_generation_positive CHECK (collection_generation > 0),
  CONSTRAINT field_form_versions_title_bound CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT field_form_versions_instructions_bound CHECK (
    instructions IS NULL OR char_length(instructions) BETWEEN 1 AND 4000
  ),
  CONSTRAINT field_form_versions_schema_object CHECK (
    jsonb_typeof(schema_definition) = 'object'
    AND schema_definition->>'schemaVersion' = '1.0.0'
    AND jsonb_typeof(schema_definition->'fields') = 'array'
    AND jsonb_array_length(schema_definition->'fields') <= 64
  ),
  FOREIGN KEY (organization_id, dataset_id, form_id)
    REFERENCES app.field_forms (organization_id, dataset_id, id)
);

ALTER TABLE app.field_forms
  ADD CONSTRAINT field_forms_current_version_fk
  FOREIGN KEY (organization_id, dataset_id, id, current_version)
  REFERENCES app.field_form_versions (
    organization_id, dataset_id, form_id, version_number
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.field_submissions (
  id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  form_id uuid NOT NULL,
  form_version bigint NOT NULL,
  supersedes_submission_id uuid,
  payload_sha256 text NOT NULL,
  geometry_type app.feature_geometry_type NOT NULL,
  properties jsonb NOT NULL,
  geometry_geojson jsonb NOT NULL,
  geometry geometry(Geometry, 4326) NOT NULL,
  state app.field_submission_state NOT NULL DEFAULT 'submitted',
  review_version bigint NOT NULL DEFAULT 1,
  submitted_by uuid NOT NULL REFERENCES app.users(id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_by uuid REFERENCES app.users(id),
  reviewed_at timestamptz,
  review_message text,
  promoted_feature_id uuid,
  PRIMARY KEY (organization_id, dataset_id, id),
  UNIQUE (organization_id, dataset_id, supersedes_submission_id),
  CONSTRAINT field_submissions_review_version_positive CHECK (review_version > 0),
  CONSTRAINT field_submissions_payload_sha256 CHECK (
    payload_sha256 = lower(payload_sha256)
    AND payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT field_submissions_properties_object CHECK (
    jsonb_typeof(properties) = 'object' AND pg_column_size(properties) <= 32768
  ),
  CONSTRAINT field_submissions_geojson_object CHECK (
    jsonb_typeof(geometry_geojson) = 'object'
    AND geometry_geojson->>'type' = geometry_type::text
    AND jsonb_typeof(geometry_geojson->'coordinates') = 'array'
    AND pg_column_size(geometry_geojson) <= 262144
  ),
  CONSTRAINT field_submissions_geometry_type_match CHECK (
    lower(GeometryType(geometry)) = lower(geometry_type::text)
  ),
  CONSTRAINT field_submissions_geometry_safe CHECK (
    ST_SRID(geometry) = 4326
    AND ST_NDims(geometry) = 2
    AND NOT ST_IsEmpty(geometry)
    AND ST_IsValid(geometry)
  ),
  CONSTRAINT field_submissions_review_message_bound CHECK (
    review_message IS NULL OR char_length(review_message) BETWEEN 1 AND 2000
  ),
  CONSTRAINT field_submissions_review_shape CHECK (
    (state = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_message IS NULL AND promoted_feature_id IS NULL)
    OR (state = 'in_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_message IS NULL AND promoted_feature_id IS NULL)
    OR (state IN ('changes_requested', 'rejected')
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_message IS NOT NULL AND promoted_feature_id IS NULL)
    OR (state = 'accepted' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND promoted_feature_id = id)
  ),
  FOREIGN KEY (organization_id, dataset_id, form_id, form_version)
    REFERENCES app.field_form_versions (
      organization_id, dataset_id, form_id, version_number
    ),
  FOREIGN KEY (organization_id, dataset_id, supersedes_submission_id)
    REFERENCES app.field_submissions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, dataset_id, promoted_feature_id)
    REFERENCES app.dataset_features (organization_id, dataset_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX field_submissions_review_queue_idx
  ON app.field_submissions (organization_id, dataset_id, state, submitted_at, id);

CREATE TABLE app.field_submission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  submission_version bigint NOT NULL,
  from_state app.field_submission_state,
  to_state app.field_submission_state NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  message text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dataset_id, submission_id, submission_version),
  CONSTRAINT field_submission_events_version_positive CHECK (submission_version > 0),
  CONSTRAINT field_submission_events_message_bound CHECK (
    message IS NULL OR char_length(message) BETWEEN 1 AND 2000
  ),
  CONSTRAINT field_submission_events_request_id_bound CHECK (
    char_length(request_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT field_submission_events_initial_shape CHECK (
    (submission_version = 1 AND from_state IS NULL AND to_state = 'submitted')
    OR (submission_version > 1 AND from_state IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, dataset_id, submission_id)
    REFERENCES app.field_submissions (organization_id, dataset_id, id)
);

CREATE FUNCTION app.enforce_field_form_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'field form identity and creation attribution are immutable';
  END IF;
  IF NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'field form version must increase exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_field_submission_review()
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

CREATE FUNCTION app.ensure_field_submission_has_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.field_submission_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.dataset_id = NEW.dataset_id
      AND event.submission_id = NEW.id
      AND event.submission_version = NEW.review_version
      AND event.from_state IS NOT DISTINCT FROM (
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END
      )
      AND event.to_state = NEW.state
      AND event.actor_user_id = (
        CASE WHEN TG_OP = 'INSERT' THEN NEW.submitted_by ELSE NEW.reviewed_by END
      )
  ) THEN
    RAISE EXCEPTION 'field submission mutation requires one matching immutable event';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER field_forms_enforce_version
  BEFORE UPDATE ON app.field_forms
  FOR EACH ROW EXECUTE FUNCTION app.enforce_field_form_version();
CREATE TRIGGER field_forms_set_updated_at
  BEFORE UPDATE ON app.field_forms
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER field_form_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.field_form_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
CREATE TRIGGER field_submissions_enforce_review
  BEFORE UPDATE ON app.field_submissions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_field_submission_review();
CREATE CONSTRAINT TRIGGER field_submissions_require_event
  AFTER INSERT OR UPDATE ON app.field_submissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.ensure_field_submission_has_event();
CREATE TRIGGER field_submission_events_are_immutable
  BEFORE UPDATE OR DELETE ON app.field_submission_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

ALTER TABLE app.field_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_submission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_forms FORCE ROW LEVEL SECURITY;
ALTER TABLE app.field_form_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.field_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.field_submission_events FORCE ROW LEVEL SECURITY;

CREATE POLICY field_forms_tenant_isolation ON app.field_forms
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY field_form_versions_tenant_isolation ON app.field_form_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY field_submissions_tenant_isolation ON app.field_submissions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY field_submission_events_tenant_isolation ON app.field_submission_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

REVOKE ALL ON
  app.field_forms,
  app.field_form_versions,
  app.field_submissions,
  app.field_submission_events
FROM opengeo_worker;
GRANT SELECT, INSERT, UPDATE ON app.field_forms TO opengeo_runtime;
GRANT SELECT, INSERT ON app.field_form_versions TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.field_submissions TO opengeo_runtime;
GRANT SELECT, INSERT ON app.field_submission_events TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION
  app.enforce_field_form_version(),
  app.enforce_field_submission_review(),
  app.ensure_field_submission_has_event()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.field_forms IS
  'Tenant-scoped field form identities whose current version advances exactly once.';
COMMENT ON TABLE app.field_form_versions IS
  'Immutable form instructions and authoritative feature-schema snapshots.';
COMMENT ON TABLE app.field_submissions IS
  'Idempotent quarantined field observations; only accepted rows become authoritative features.';
COMMENT ON TABLE app.field_submission_events IS
  'Append-only field submission review transitions and attribution.';

COMMIT;
