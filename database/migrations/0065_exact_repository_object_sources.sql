BEGIN;

ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'repository';

COMMIT;

BEGIN;

ALTER TABLE app.datasets DROP CONSTRAINT datasets_source_format_match;
ALTER TABLE app.datasets ADD CONSTRAINT datasets_source_format_match CHECK (
  (source_type = 'upload' AND format NOT IN ('xyz', 'wms', 'arcgis', 'wfs'))
  OR (source_type = 'repository'
      AND format NOT IN ('xyz', 'wms', 'arcgis', 'wfs'))
  OR (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs')
      AND source_type::text = format::text)
);

CREATE TABLE app.repository_object_sources (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_target_revision bigint NOT NULL,
  provider app.dataset_connection_provider NOT NULL,
  bucket_name text NOT NULL,
  region_name text NOT NULL,
  object_prefix text NOT NULL,
  relative_path text NOT NULL,
  provider_version_id text NOT NULL,
  size_bytes bigint NOT NULL,
  last_modified timestamptz NOT NULL,
  content_type text,
  etag text NOT NULL,
  storage_class text,
  provider_checksum_sha256 text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id),
  UNIQUE (
    organization_id, connection_id, connection_target_revision,
    relative_path, provider_version_id
  ),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.user_dataset_connections (organization_id, id),
  CONSTRAINT repository_object_sources_target_revision_positive CHECK (
    connection_target_revision > 0
  ),
  CONSTRAINT repository_object_sources_s3_only CHECK (provider = 's3'),
  CONSTRAINT repository_object_sources_bucket_snapshot_safe CHECK (
    bucket_name = lower(bucket_name)
    AND char_length(bucket_name) BETWEEN 3 AND 63
    AND bucket_name ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
    AND bucket_name !~ '(\.\.|\.-|-\.)'
    AND bucket_name !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
  ),
  CONSTRAINT repository_object_sources_region_snapshot_safe CHECK (
    region_name = lower(region_name)
    AND char_length(region_name) BETWEEN 3 AND 32
    AND region_name ~ '^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$'
  ),
  CONSTRAINT repository_object_sources_prefix_snapshot_safe CHECK (
    octet_length(object_prefix) <= 1024
    AND object_prefix !~ '^[\\/]'
    AND object_prefix !~ '[\\[:cntrl:]]'
  ),
  CONSTRAINT repository_object_sources_relative_path_safe CHECK (
    octet_length(relative_path) BETWEEN 1 AND 1024
    AND relative_path !~ '^[\\/]'
    AND relative_path !~ '[\\[:cntrl:]]'
    AND relative_path !~ '(^|/)\.\.?(/|$)'
    AND right(relative_path, 1) <> '/'
    AND octet_length(object_prefix || relative_path) <= 1024
  ),
  CONSTRAINT repository_object_sources_exact_version_required CHECK (
    octet_length(provider_version_id) BETWEEN 1 AND 1024
    AND provider_version_id <> 'null'
    AND provider_version_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT repository_object_sources_object_nonempty CHECK (
    size_bytes BETWEEN 1 AND 5497558138880
  ),
  CONSTRAINT repository_object_sources_content_type_bounded CHECK (
    content_type IS NULL OR (
      octet_length(content_type) BETWEEN 1 AND 255
      AND content_type !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT repository_object_sources_etag_bounded CHECK (
    octet_length(etag) BETWEEN 1 AND 1024
    AND etag !~ '[[:cntrl:]]'
  ),
  CONSTRAINT repository_object_sources_storage_class_bounded CHECK (
    storage_class IS NULL OR (
      octet_length(storage_class) BETWEEN 1 AND 100
      AND storage_class ~ '^[A-Z0-9_-]+$'
    )
  ),
  CONSTRAINT repository_object_sources_checksum_sha256_valid CHECK (
    provider_checksum_sha256 IS NULL
    OR provider_checksum_sha256 ~ '^[A-Za-z0-9+/]{43}=$'
  )
);

CREATE INDEX repository_object_sources_connection_idx
  ON app.repository_object_sources
    (organization_id, connection_id, connection_target_revision, created_at DESC);

CREATE FUNCTION app.enforce_repository_object_source_dataset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type text;
BEGIN
  SELECT source_type::text INTO v_source_type
  FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.dataset_id;

  IF v_source_type IS NULL OR v_source_type <> 'repository' THEN
    RAISE EXCEPTION 'repository object source must identify a repository dataset';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_repository_object_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'exact repository object source records are immutable';
END;
$$;

CREATE TRIGGER repository_object_sources_match_dataset
  BEFORE INSERT ON app.repository_object_sources
  FOR EACH ROW EXECUTE FUNCTION app.enforce_repository_object_source_dataset();
CREATE TRIGGER repository_object_sources_are_immutable
  BEFORE UPDATE OR DELETE ON app.repository_object_sources
  FOR EACH ROW EXECUTE FUNCTION app.reject_repository_object_source_mutation();

ALTER TABLE app.repository_object_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repository_object_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY repository_object_sources_tenant_isolation
  ON app.repository_object_sources
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.repository_object_sources TO opengeo_runtime;

REVOKE ALL ON app.repository_object_sources
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator,
  opengeo_dataset_verifier;

REVOKE EXECUTE ON FUNCTION
  app.enforce_repository_object_source_dataset(),
  app.reject_repository_object_source_mutation()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_dataset_verifier;

COMMENT ON TYPE app.dataset_source_type IS
  'Dataset acquisition mode; repository identifies one exact versioned object selected through a verified user connection.';
COMMENT ON TABLE app.repository_object_sources IS
  'Immutable exact-version metadata for a governed S3 object. Target facts are snapshotted without credentials; object bytes remain at the provider until a separate import or protected-copy action.';
COMMENT ON COLUMN app.repository_object_sources.provider_version_id IS
  'An exact non-null S3 VersionId. The mutable S3 null version is deliberately ineligible for immutable registration.';

COMMIT;
