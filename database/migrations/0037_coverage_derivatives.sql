BEGIN;

-- One OGC API collection identifier must never identify different resource
-- kinds. Reservations survive withdrawal so old links cannot be rebound.
CREATE TABLE app.spatial_service_collection_ids (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  collection_id text NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  reserved_by uuid NOT NULL REFERENCES app.users(id),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, service_id, collection_id),
  UNIQUE (organization_id, resource_kind, resource_id),
  CONSTRAINT spatial_service_collection_ids_name_bounded CHECK (
    collection_id = lower(collection_id)
    AND collection_id ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_collection_ids_kind_known CHECK (
    resource_kind IN ('feature', 'coverage')
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id)
);

INSERT INTO app.spatial_service_collection_ids
  (organization_id, project_id, service_id, collection_id,
   resource_kind, resource_id, reserved_by, reserved_at)
SELECT organization_id, project_id, service_id, lower(collection_name),
       'feature', id, created_by, created_at
FROM app.spatial_service_collections;

INSERT INTO app.spatial_service_collection_ids
  (organization_id, project_id, service_id, collection_id,
   resource_kind, resource_id, reserved_by, reserved_at)
SELECT organization_id, project_id, service_id, lower(coverage_name),
       'coverage', id, created_by, created_at
FROM app.spatial_service_coverages;

CREATE FUNCTION app.reserve_spatial_service_collection_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_identifier text;
  v_kind text;
BEGIN
  IF TG_TABLE_NAME = 'spatial_service_collections' THEN
    v_identifier := lower(NEW.collection_name);
    v_kind := 'feature';
  ELSIF TG_TABLE_NAME = 'spatial_service_coverages' THEN
    v_identifier := lower(NEW.coverage_name);
    v_kind := 'coverage';
  ELSE
    RAISE EXCEPTION 'unsupported spatial service collection registry source';
  END IF;
  INSERT INTO app.spatial_service_collection_ids
    (organization_id, project_id, service_id, collection_id,
     resource_kind, resource_id, reserved_by, reserved_at)
  VALUES
    (NEW.organization_id, NEW.project_id, NEW.service_id, v_identifier,
     v_kind, NEW.id, NEW.created_by, NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER spatial_service_collections_reserve_collection_id
  AFTER INSERT ON app.spatial_service_collections
  FOR EACH ROW EXECUTE FUNCTION app.reserve_spatial_service_collection_id();
CREATE TRIGGER spatial_service_coverages_reserve_collection_id
  AFTER INSERT ON app.spatial_service_coverages
  FOR EACH ROW EXECUTE FUNCTION app.reserve_spatial_service_collection_id();

CREATE TABLE app.spatial_coverage_derivative_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  subset_extent jsonb NOT NULL,
  target_crs text NOT NULL,
  target_width integer NOT NULL,
  target_height integer NOT NULL,
  resampling text NOT NULL,
  request_checksum_sha256 text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  output_object_id uuid,
  output_crs text,
  output_extent jsonb,
  output_width integer,
  output_height integer,
  output_band_count integer,
  output_bands jsonb,
  output_content_type text,
  output_size_bytes bigint,
  output_checksum_sha256 text,
  error_code text,
  worker_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id, coverage_id, subset_extent, target_crs,
    target_width, target_height, resampling
  ),
  CONSTRAINT spatial_coverage_derivatives_subset_shape CHECK (
    jsonb_typeof(subset_extent) = 'array'
    AND jsonb_array_length(subset_extent) = 4
    AND jsonb_typeof(subset_extent->0) = 'number'
    AND jsonb_typeof(subset_extent->1) = 'number'
    AND jsonb_typeof(subset_extent->2) = 'number'
    AND jsonb_typeof(subset_extent->3) = 'number'
    AND (subset_extent->>0)::numeric BETWEEN -1e100 AND 1e100
    AND (subset_extent->>1)::numeric BETWEEN -1e100 AND 1e100
    AND (subset_extent->>2)::numeric BETWEEN -1e100 AND 1e100
    AND (subset_extent->>3)::numeric BETWEEN -1e100 AND 1e100
    AND (subset_extent->>0)::numeric < (subset_extent->>2)::numeric
    AND (subset_extent->>1)::numeric < (subset_extent->>3)::numeric
  ),
  CONSTRAINT spatial_coverage_derivatives_crs_bounded CHECK (
    target_crs ~ '^EPSG:[1-9][0-9]{2,7}$'
  ),
  CONSTRAINT spatial_coverage_derivatives_grid_bounded CHECK (
    target_width BETWEEN 1 AND 8192
    AND target_height BETWEEN 1 AND 8192
    AND target_width::bigint * target_height::bigint <= 16777216
  ),
  CONSTRAINT spatial_coverage_derivatives_resampling_known CHECK (
    resampling IN ('nearest', 'bilinear', 'cubic')
  ),
  CONSTRAINT spatial_coverage_derivatives_request_checksum CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT spatial_coverage_derivatives_attempt_nonnegative CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT spatial_coverage_derivatives_result_shape CHECK (
    (
      state = 'completed'
      AND output_object_id IS NOT NULL
      AND output_crs = target_crs
      AND jsonb_typeof(output_extent) = 'array'
      AND jsonb_array_length(output_extent) = 4
      AND output_width = target_width
      AND output_height = target_height
      AND output_band_count BETWEEN 1 AND 64
      AND jsonb_typeof(output_bands) = 'array'
      AND jsonb_array_length(output_bands) = output_band_count
      AND output_content_type = 'image/tiff'
      AND output_size_bytes BETWEEN 1 AND 536870912
      AND output_checksum_sha256 ~ '^[0-9a-f]{64}$'
      AND error_code IS NULL
      AND worker_token IS NULL
      AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
    ) OR (
      state <> 'completed'
      AND output_object_id IS NULL
      AND output_crs IS NULL
      AND output_extent IS NULL
      AND output_width IS NULL
      AND output_height IS NULL
      AND output_band_count IS NULL
      AND output_bands IS NULL
      AND output_content_type IS NULL
      AND output_size_bytes IS NULL
      AND output_checksum_sha256 IS NULL
    )
  ),
  CONSTRAINT spatial_coverage_derivatives_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
  ),
  CONSTRAINT spatial_coverage_derivatives_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled') AND finished_at IS NOT NULL
      AND error_code IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id),
  FOREIGN KEY (organization_id, coverage_id)
    REFERENCES app.spatial_service_coverages (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

CREATE INDEX spatial_coverage_derivative_jobs_catalog_idx
  ON app.spatial_coverage_derivative_jobs
  (organization_id, project_id, service_id, coverage_id, created_at DESC, id);
CREATE INDEX spatial_coverage_derivative_jobs_expired_idx
  ON app.spatial_coverage_derivative_jobs (lease_expires_at, id)
  WHERE state = 'running';

CREATE FUNCTION app.enforce_spatial_coverage_derivative_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_coverage app.spatial_service_coverages%ROWTYPE;
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL
    OR NEW.error_code IS NOT NULL
    OR NEW.worker_token IS NOT NULL
    OR NEW.attempt_count <> 0
    OR NEW.started_at IS NOT NULL
    OR NEW.finished_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'coverage derivative creator or initial state mismatch';
  END IF;

  SELECT coverage.* INTO v_coverage
  FROM app.spatial_service_coverages coverage
  JOIN app.spatial_services service
    ON service.organization_id = coverage.organization_id
   AND service.project_id = coverage.project_id
   AND service.id = coverage.service_id
  JOIN app.datasets dataset
    ON dataset.organization_id = coverage.organization_id
   AND dataset.id = coverage.dataset_id
  JOIN app.dataset_versions version
    ON version.organization_id = dataset.organization_id
   AND version.dataset_id = dataset.id
   AND version.id = coverage.dataset_version_id
   AND version.id = dataset.current_version_id
   AND version.version_number = coverage.sealed_dataset_version_number
  JOIN app.data_objects object
    ON object.organization_id = coverage.organization_id
   AND object.dataset_id = coverage.dataset_id
   AND object.id = coverage.data_object_id
   AND object.bucket = coverage.sealed_bucket
   AND object.object_key = coverage.sealed_object_key
   AND object.s3_version_id = coverage.sealed_storage_version_id
   AND object.content_type = coverage.sealed_content_type
   AND object.size_bytes = coverage.sealed_size_bytes
   AND object.checksum_sha256 = coverage.sealed_checksum_sha256
  WHERE coverage.organization_id = NEW.organization_id
    AND coverage.project_id = NEW.project_id
    AND coverage.service_id = NEW.service_id
    AND coverage.id = NEW.coverage_id
    AND coverage.withdrawn_at IS NULL
    AND service.disabled_at IS NULL
    AND dataset.status = 'active'
    AND version.state = 'active'
    AND object.role = 'original'
    AND object.size_bytes <= 536870912;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coverage derivative must target a fresh active exact COG seal';
  END IF;

  IF (NEW.subset_extent->>0)::numeric < (v_coverage.sealed_extent->>0)::numeric
    OR (NEW.subset_extent->>1)::numeric < (v_coverage.sealed_extent->>1)::numeric
    OR (NEW.subset_extent->>2)::numeric > (v_coverage.sealed_extent->>2)::numeric
    OR (NEW.subset_extent->>3)::numeric > (v_coverage.sealed_extent->>3)::numeric
    OR NEW.target_width::bigint * NEW.target_height::bigint
       * v_coverage.sealed_band_count::bigint > 67108864
  THEN
    RAISE EXCEPTION 'coverage derivative request exceeds the sealed raster bounds';
  END IF;

  IF NEW.subset_extent = v_coverage.sealed_extent
    AND NEW.target_crs = v_coverage.sealed_crs
    AND NEW.target_width = v_coverage.sealed_width
    AND NEW.target_height = v_coverage.sealed_height
  THEN
    RAISE EXCEPTION 'coverage derivative request is identical to the exact source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_coverage_derivative_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.service_id <> OLD.service_id
    OR NEW.coverage_id <> OLD.coverage_id
    OR NEW.subset_extent <> OLD.subset_extent
    OR NEW.target_crs <> OLD.target_crs
    OR NEW.target_width <> OLD.target_width
    OR NEW.target_height <> OLD.target_height
    OR NEW.resampling <> OLD.resampling
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
       AND OLD.started_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'coverage derivative request seal is immutable';
  END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'coverage derivative terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spatial_coverage_derivative_validate_insert
  BEFORE INSERT ON app.spatial_coverage_derivative_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_coverage_derivative_insert();
CREATE TRIGGER spatial_coverage_derivative_enforce_transition
  BEFORE UPDATE ON app.spatial_coverage_derivative_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_coverage_derivative_transition();

CREATE FUNCTION app.claim_spatial_coverage_derivative(
  p_job_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  job_id uuid,
  organization_id uuid,
  project_id uuid,
  service_id uuid,
  coverage_id uuid,
  dataset_id uuid,
  dataset_version_id uuid,
  source_object_id uuid,
  source_bucket text,
  source_object_key text,
  source_s3_version_id text,
  source_etag text,
  source_content_type text,
  source_size_bytes bigint,
  source_checksum_sha256 text,
  source_crs text,
  source_extent jsonb,
  source_width integer,
  source_height integer,
  source_band_count integer,
  source_bands jsonb,
  subset_extent jsonb,
  target_crs text,
  target_width integer,
  target_height integer,
  resampling text,
  request_checksum_sha256 text,
  attempt_count integer,
  output_prefix text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'invalid coverage derivative claim';
  END IF;
  SELECT job.*, coverage.dataset_id, coverage.dataset_version_id,
         coverage.data_object_id, coverage.sealed_bucket,
         coverage.sealed_object_key, coverage.sealed_storage_version_id,
         object.etag, coverage.sealed_content_type, coverage.sealed_size_bytes,
         coverage.sealed_checksum_sha256, coverage.sealed_crs,
         coverage.sealed_extent, coverage.sealed_width,
         coverage.sealed_height, coverage.sealed_band_count,
         coverage.sealed_bands
  INTO v_job
  FROM app.spatial_coverage_derivative_jobs job
  JOIN app.spatial_service_coverages coverage
    ON coverage.organization_id = job.organization_id
   AND coverage.id = job.coverage_id
  JOIN app.data_objects object
    ON object.organization_id = coverage.organization_id
   AND object.id = coverage.data_object_id
  WHERE job.id = p_job_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::bigint, NULL::text, NULL::text, NULL::jsonb, NULL::integer,
      NULL::integer, NULL::integer, NULL::jsonb, NULL::jsonb, NULL::text,
      NULL::integer, NULL::integer, NULL::text, NULL::text, NULL::integer,
      NULL::text;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSE
    UPDATE app.spatial_coverage_derivative_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now,
        attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id;
    claim_status := 'claimed';
    v_job.attempt_count := v_job.attempt_count + 1;
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.organization_id,
    v_job.project_id, v_job.service_id, v_job.coverage_id, v_job.dataset_id,
    v_job.dataset_version_id, v_job.data_object_id, v_job.sealed_bucket,
    v_job.sealed_object_key, v_job.sealed_storage_version_id, v_job.etag,
    v_job.sealed_content_type, v_job.sealed_size_bytes,
    v_job.sealed_checksum_sha256, v_job.sealed_crs, v_job.sealed_extent,
    v_job.sealed_width, v_job.sealed_height, v_job.sealed_band_count,
    v_job.sealed_bands, v_job.subset_extent, v_job.target_crs,
    v_job.target_width, v_job.target_height, v_job.resampling,
    v_job.request_checksum_sha256, v_job.attempt_count,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
      v_job.organization_id, v_job.project_id, v_job.dataset_id,
      v_job.dataset_version_id
    );
END;
$$;

CREATE FUNCTION app.heartbeat_spatial_coverage_derivative(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RETURN false;
  END IF;
  UPDATE app.spatial_coverage_derivative_jobs
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running'
    AND worker_token = p_worker_token AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.complete_spatial_coverage_derivative(
  p_job_id uuid,
  p_worker_token uuid,
  p_artifact jsonb,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.spatial_coverage_derivative_jobs%ROWTYPE;
  v_coverage app.spatial_service_coverages%ROWTYPE;
  v_expected_key text;
BEGIN
  SELECT * INTO v_job FROM app.spatial_coverage_derivative_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN
    RETURN false;
  END IF;
  SELECT * INTO v_coverage FROM app.spatial_service_coverages
  WHERE organization_id = v_job.organization_id AND id = v_job.coverage_id;
  v_expected_key := format(
    'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/coverages/%s.tif',
    v_job.organization_id, v_job.project_id, v_coverage.dataset_id,
    v_coverage.dataset_version_id, v_job.id
  );
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192
    OR (p_artifact->>'role') <> 'derived'
    OR (p_artifact->>'bucket') <> v_coverage.sealed_bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'s3_version_id') IN ('', 'null')
    OR (p_artifact->>'etag') !~ '^[A-Fa-f0-9]{16,128}$'
    OR (p_artifact->>'content_type') <> 'image/tiff'
    OR (p_artifact->>'size_bytes')::bigint NOT BETWEEN 1 AND 536870912
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
    OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
    OR octet_length(p_metadata::text) > 65536
    OR (p_metadata->>'cog_layout_verified')::boolean IS NOT TRUE
    OR (p_metadata->>'crs') <> v_job.target_crs
    OR (p_metadata->>'width')::integer <> v_job.target_width
    OR (p_metadata->>'height')::integer <> v_job.target_height
    OR (p_metadata->>'band_count')::integer <> v_coverage.sealed_band_count
    OR jsonb_typeof(p_metadata->'extent') <> 'array'
    OR jsonb_array_length(p_metadata->'extent') <> 4
    OR jsonb_typeof(p_metadata->'bands') <> 'array'
    OR jsonb_array_length(p_metadata->'bands') <> v_coverage.sealed_band_count
  THEN
    RAISE EXCEPTION 'invalid coverage derivative artifact';
  END IF;

  INSERT INTO app.data_objects
    (id, organization_id, dataset_id, role, bucket, object_key,
     s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
  VALUES
    ((p_artifact->>'id')::uuid, v_job.organization_id, v_coverage.dataset_id,
     'derived', p_artifact->>'bucket', p_artifact->>'object_key',
     p_artifact->>'s3_version_id', lower(p_artifact->>'etag'),
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', v_job.created_by);
  INSERT INTO app.dataset_version_objects
    (organization_id, dataset_id, dataset_version_id, data_object_id)
  VALUES
    (v_job.organization_id, v_coverage.dataset_id,
     v_coverage.dataset_version_id, (p_artifact->>'id')::uuid);

  UPDATE app.spatial_coverage_derivative_jobs
  SET state = 'completed', output_object_id = (p_artifact->>'id')::uuid,
      output_crs = p_metadata->>'crs', output_extent = p_metadata->'extent',
      output_width = (p_metadata->>'width')::integer,
      output_height = (p_metadata->>'height')::integer,
      output_band_count = (p_metadata->>'band_count')::integer,
      output_bands = p_metadata->'bands', output_content_type = 'image/tiff',
      output_size_bytes = (p_artifact->>'size_bytes')::bigint,
      output_checksum_sha256 = p_artifact->>'checksum_sha256',
      error_code = NULL, worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_job.id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'spatial_service.coverage.derivative.completed', 'spatial_service',
     v_job.service_id, 'worker:' || v_job.id::text,
     jsonb_build_object(
       'derivative_job_id', v_job.id, 'coverage_id', v_job.coverage_id,
       'output_object_id', (p_artifact->>'id')::uuid,
       'output_checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_spatial_coverage_derivative(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200
  THEN
    RETURN false;
  END IF;
  UPDATE app.spatial_coverage_derivative_jobs
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_spatial_coverage_derivative(
  p_job_id uuid, p_worker_token uuid, p_error_code text, p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_attempt integer;
  v_state text;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200 OR p_max_attempts NOT BETWEEN 1 AND 10
  THEN
    RETURN 'lost';
  END IF;
  SELECT attempt_count INTO v_attempt
  FROM app.spatial_coverage_derivative_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE WHEN v_attempt >= p_max_attempts THEN 'failed' ELSE 'queued' END;
  UPDATE app.spatial_coverage_derivative_jobs
  SET state = v_state::app.processing_job_state, error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id;
  RETURN v_state;
END;
$$;

ALTER TABLE app.spatial_service_collection_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_collection_ids FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_coverage_derivative_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_coverage_derivative_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY spatial_service_collection_ids_tenant_isolation
  ON app.spatial_service_collection_ids
  USING (organization_id = app.current_organization_id());
CREATE POLICY spatial_coverage_derivative_jobs_tenant_isolation
  ON app.spatial_coverage_derivative_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT ON app.spatial_service_collection_ids TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.spatial_service_collection_ids FROM opengeo_runtime;
GRANT SELECT, INSERT ON app.spatial_coverage_derivative_jobs TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.spatial_coverage_derivative_jobs FROM opengeo_runtime;
REVOKE ALL ON app.spatial_service_collection_ids,
  app.spatial_coverage_derivative_jobs FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.reserve_spatial_service_collection_id(),
  app.enforce_spatial_coverage_derivative_insert(),
  app.enforce_spatial_coverage_derivative_transition(),
  app.claim_spatial_coverage_derivative(uuid, uuid, integer),
  app.heartbeat_spatial_coverage_derivative(uuid, uuid, integer),
  app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb),
  app.fail_spatial_coverage_derivative(uuid, uuid, text),
  app.release_spatial_coverage_derivative(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker;

GRANT EXECUTE ON FUNCTION
  app.claim_spatial_coverage_derivative(uuid, uuid, integer),
  app.heartbeat_spatial_coverage_derivative(uuid, uuid, integer),
  app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb),
  app.fail_spatial_coverage_derivative(uuid, uuid, text),
  app.release_spatial_coverage_derivative(uuid, uuid, text, integer)
TO opengeo_worker;

COMMENT ON TABLE app.spatial_service_collection_ids IS
  'Permanent cross-resource OGC collection identifier reservations for one project service.';
COMMENT ON TABLE app.spatial_coverage_derivative_jobs IS
  'Explicit bounded immutable COG subset/scale/reprojection requests; discovery and reads never create jobs.';

COMMIT;
