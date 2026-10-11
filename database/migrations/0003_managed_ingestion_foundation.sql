BEGIN;

CREATE TYPE app.dataset_status AS ENUM (
  'draft',
  'processing',
  'active',
  'failed',
  'archived'
);
CREATE TYPE app.dataset_classification AS ENUM (
  'public',
  'internal',
  'confidential',
  'restricted'
);
CREATE TYPE app.dataset_source_type AS ENUM ('upload', 'xyz', 'wms');
CREATE TYPE app.dataset_format AS ENUM (
  'geojson',
  'csv',
  'shapefile',
  'geopackage',
  'geoparquet',
  'cog',
  'pmtiles',
  'xyz',
  'wms'
);
CREATE TYPE app.upload_intent_state AS ENUM ('pending', 'completed');
CREATE TYPE app.data_object_role AS ENUM (
  'original',
  'working',
  'published',
  'tile',
  'derived',
  'thumbnail'
);
CREATE TYPE app.dataset_version_state AS ENUM (
  'queued',
  'processing',
  'active',
  'failed'
);
CREATE TYPE app.processing_job_state AS ENUM (
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE app.datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  name text NOT NULL,
  description text,
  classification app.dataset_classification NOT NULL DEFAULT 'internal',
  source_type app.dataset_source_type NOT NULL DEFAULT 'upload',
  format app.dataset_format NOT NULL,
  status app.dataset_status NOT NULL DEFAULT 'draft',
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  current_version_id uuid,
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT datasets_name_not_blank CHECK (name <> ''),
  CONSTRAINT datasets_source_format_match CHECK (
    (source_type = 'upload' AND format NOT IN ('xyz', 'wms'))
    OR (source_type = 'xyz' AND format = 'xyz')
    OR (source_type = 'wms' AND format = 'wms')
  )
);

CREATE INDEX datasets_catalog_idx
  ON app.datasets (organization_id, status, updated_at DESC, id);
CREATE INDEX datasets_owner_idx
  ON app.datasets (organization_id, owner_user_id, updated_at DESC, id);

CREATE TABLE app.project_datasets (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  linked_by uuid NOT NULL REFERENCES app.users(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, dataset_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

CREATE INDEX project_datasets_dataset_idx
  ON app.project_datasets (organization_id, dataset_id, project_id);

CREATE TABLE app.tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name),
  CONSTRAINT tags_normalized CHECK (
    name = lower(btrim(name))
    AND char_length(name) BETWEEN 1 AND 64
  )
);

CREATE TABLE app.dataset_tags (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  tagged_by uuid NOT NULL REFERENCES app.users(id),
  tagged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, tag_id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, tag_id)
    REFERENCES app.tags (organization_id, id)
);

CREATE TABLE app.upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  original_filename text NOT NULL,
  content_type text NOT NULL,
  expected_size_bytes bigint NOT NULL,
  expected_sha256 text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  state app.upload_intent_state NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_object_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (bucket, object_key),
  CONSTRAINT upload_intents_filename_is_basename CHECK (
    original_filename <> ''
    AND original_filename NOT LIKE '%/%'
    AND original_filename NOT LIKE '%\\%'
  ),
  CONSTRAINT upload_intents_content_type_normalized CHECK (
    content_type = lower(content_type)
    AND content_type NOT LIKE '%;%'
  ),
  CONSTRAINT upload_intents_size_bounded CHECK (
    expected_size_bytes BETWEEN 1 AND 5368709120
  ),
  CONSTRAINT upload_intents_sha256_hex CHECK (
    expected_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT upload_intents_expiry CHECK (expires_at > created_at),
  CONSTRAINT upload_intents_state_shape CHECK (
    (state = 'pending' AND completed_at IS NULL AND completed_object_id IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND completed_object_id IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

CREATE INDEX upload_intents_pending_idx
  ON app.upload_intents (organization_id, state, expires_at, id);

CREATE TABLE app.data_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  role app.data_object_role NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  s3_version_id text NOT NULL,
  etag text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (bucket, object_key, s3_version_id),
  CONSTRAINT data_objects_size_positive CHECK (size_bytes > 0),
  CONSTRAINT data_objects_sha256_hex CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

ALTER TABLE app.upload_intents
  ADD CONSTRAINT upload_intents_completed_object_fk
  FOREIGN KEY (organization_id, completed_object_id)
  REFERENCES app.data_objects (organization_id, id);

CREATE INDEX data_objects_dataset_idx
  ON app.data_objects (organization_id, dataset_id, created_at DESC, id);

CREATE TABLE app.dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  version_number bigint NOT NULL,
  parent_version_id uuid,
  original_object_id uuid NOT NULL,
  state app.dataset_version_state NOT NULL DEFAULT 'queued',
  change_message text,
  feature_count bigint,
  extent jsonb,
  crs text,
  geometry_type text,
  schema_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dataset_id, version_number),
  UNIQUE (organization_id, dataset_id, id),
  CONSTRAINT dataset_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT dataset_versions_feature_count_nonnegative CHECK (
    feature_count IS NULL OR feature_count >= 0
  ),
  CONSTRAINT dataset_versions_extent_shape CHECK (
    extent IS NULL
    OR (
      jsonb_typeof(extent) = 'array'
      AND jsonb_array_length(extent) = 4
    )
  ),
  CONSTRAINT dataset_versions_schema_object CHECK (
    jsonb_typeof(schema_definition) = 'object'
  ),
  CONSTRAINT dataset_versions_quality_object CHECK (
    jsonb_typeof(quality_results) = 'object'
  ),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id, parent_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, original_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

ALTER TABLE app.datasets
  ADD CONSTRAINT datasets_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.dataset_versions (organization_id, dataset_id, id);

CREATE INDEX dataset_versions_history_idx
  ON app.dataset_versions (organization_id, dataset_id, version_number DESC);

CREATE TABLE app.processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  job_type text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  engine text NOT NULL DEFAULT 'ecs',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dataset_version_id, job_type),
  CONSTRAINT processing_jobs_type_format CHECK (
    job_type ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
  ),
  CONSTRAINT processing_jobs_engine_known CHECK (engine IN ('ecs', 'lambda')),
  CONSTRAINT processing_jobs_parameters_object CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT processing_jobs_result_object CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT processing_jobs_attempt_nonnegative CHECK (attempt_count >= 0),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id)
);

CREATE INDEX processing_jobs_queue_idx
  ON app.processing_jobs (state, created_at, id);
CREATE INDEX processing_jobs_dataset_idx
  ON app.processing_jobs (organization_id, dataset_id, created_at DESC, id);

CREATE FUNCTION app.enforce_upload_intent_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.original_filename IS DISTINCT FROM NEW.original_filename
    OR OLD.content_type IS DISTINCT FROM NEW.content_type
    OR OLD.expected_size_bytes IS DISTINCT FROM NEW.expected_size_bytes
    OR OLD.expected_sha256 IS DISTINCT FROM NEW.expected_sha256
    OR OLD.bucket IS DISTINCT FROM NEW.bucket
    OR OLD.object_key IS DISTINCT FROM NEW.object_key
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'upload intent identity, scope, object, and expectations are immutable';
  END IF;

  IF OLD.state <> 'pending' OR NEW.state <> 'completed' THEN
    RAISE EXCEPTION 'upload intent transitions are forward-only';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER datasets_set_updated_at
  BEFORE UPDATE ON app.datasets
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER upload_intents_enforce_transition
  BEFORE UPDATE ON app.upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_upload_intent_transition();
CREATE TRIGGER upload_intents_set_updated_at
  BEFORE UPDATE ON app.upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER dataset_versions_set_updated_at
  BEFORE UPDATE ON app.dataset_versions
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER processing_jobs_set_updated_at
  BEFORE UPDATE ON app.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.data_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.processing_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tags FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_tags FORCE ROW LEVEL SECURITY;
ALTER TABLE app.upload_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.data_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.processing_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY datasets_tenant_isolation ON app.datasets
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_datasets_tenant_isolation ON app.project_datasets
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY tags_tenant_isolation ON app.tags
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_tags_tenant_isolation ON app.dataset_tags
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY upload_intents_tenant_isolation ON app.upload_intents
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY data_objects_tenant_isolation ON app.data_objects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_versions_tenant_isolation ON app.dataset_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY processing_jobs_tenant_isolation ON app.processing_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.datasets TO opengeo_runtime;
GRANT SELECT, INSERT ON
  app.project_datasets,
  app.tags,
  app.dataset_tags,
  app.data_objects
TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON
  app.upload_intents,
  app.dataset_versions,
  app.processing_jobs
TO opengeo_runtime;

COMMENT ON TABLE app.datasets IS
  'Authoritative catalog assets; storage objects and logical versions are separate records.';
COMMENT ON TABLE app.upload_intents IS
  'Single-use, exact-key upload expectations; expiry is evaluated at completion time.';
COMMENT ON TABLE app.data_objects IS
  'Immutable facts for one exact S3 object version and verified SHA-256 checksum.';
COMMENT ON TABLE app.dataset_versions IS
  'Logical dataset revisions independent from S3 object version identifiers.';
COMMENT ON TABLE app.processing_jobs IS
  'Idempotent ingestion work keyed by logical dataset version and job type.';

COMMIT;
