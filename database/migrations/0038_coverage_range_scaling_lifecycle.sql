BEGIN;

-- SERVICE-008 extends explicit coverage work without turning an ordinary read
-- into processing. Existing SERVICE-007 jobs retain schema 1 and all bands;
-- new requests use schema 2 and bind their range/scaling semantics explicitly.
ALTER TABLE app.spatial_coverage_derivative_jobs
  ADD COLUMN request_schema_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN band_indexes jsonb,
  ADD COLUMN scale_mode text NOT NULL DEFAULT 'size',
  ADD COLUMN requested_resolution jsonb;

UPDATE app.spatial_coverage_derivative_jobs job
SET band_indexes = bands.value
FROM app.spatial_service_coverages coverage
CROSS JOIN LATERAL (
  SELECT jsonb_agg(index ORDER BY index) AS value
  FROM generate_series(1, coverage.sealed_band_count) AS index
) bands
WHERE coverage.organization_id = job.organization_id
  AND coverage.id = job.coverage_id;

ALTER TABLE app.spatial_coverage_derivative_jobs
  ALTER COLUMN band_indexes SET NOT NULL,
  ALTER COLUMN request_schema_version DROP DEFAULT;

CREATE FUNCTION app.valid_coverage_band_indexes(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v_item jsonb;
  v_index integer;
  v_previous integer := 0;
  v_count integer := 0;
BEGIN
  IF jsonb_typeof(p_value) <> 'array'
    OR jsonb_array_length(p_value) NOT BETWEEN 1 AND 64
  THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value)
  LOOP
    IF jsonb_typeof(v_item) <> 'number'
      OR (v_item #>> '{}') !~ '^[1-9][0-9]?$'
    THEN
      RETURN false;
    END IF;
    v_index := (v_item #>> '{}')::integer;
    IF v_index > 64 OR v_index <= v_previous THEN
      RETURN false;
    END IF;
    v_previous := v_index;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count = jsonb_array_length(p_value);
END;
$$;

CREATE FUNCTION app.valid_coverage_resolution(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v_item jsonb;
  v_number numeric;
BEGIN
  IF jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) <> 2 THEN
    RETURN false;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value)
  LOOP
    IF jsonb_typeof(v_item) <> 'number' THEN RETURN false; END IF;
    BEGIN
      v_number := (v_item #>> '{}')::numeric;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN false;
    END;
    IF v_number <= 0 OR v_number > 1e100 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE app.spatial_coverage_derivative_jobs
  ADD CONSTRAINT spatial_coverage_derivatives_request_schema_known CHECK (
    request_schema_version IN (1, 2)
  ),
  ADD CONSTRAINT spatial_coverage_derivatives_band_indexes_valid CHECK (
    app.valid_coverage_band_indexes(band_indexes)
  ),
  ADD CONSTRAINT spatial_coverage_derivatives_scale_mode_valid CHECK (
    (scale_mode = 'size' AND requested_resolution IS NULL)
    OR (scale_mode = 'resolution'
      AND app.valid_coverage_resolution(requested_resolution))
  );

DO $$
DECLARE
  v_constraint name;
BEGIN
  SELECT constraint_name INTO v_constraint
  FROM information_schema.table_constraints
  WHERE table_schema = 'app'
    AND table_name = 'spatial_coverage_derivative_jobs'
    AND constraint_type = 'UNIQUE'
    AND constraint_name <> 'spatial_coverage_derivative_jobs_organization_id_id_key'
  ORDER BY constraint_name
  LIMIT 1;
  IF v_constraint IS NULL THEN
    RAISE EXCEPTION 'coverage derivative request identity constraint not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE app.spatial_coverage_derivative_jobs DROP CONSTRAINT %I',
    v_constraint
  );
END;
$$;

CREATE UNIQUE INDEX spatial_coverage_derivative_request_identity_idx
  ON app.spatial_coverage_derivative_jobs
  (organization_id, coverage_id, subset_extent, target_crs,
   target_width, target_height, resampling, band_indexes, scale_mode,
   COALESCE(requested_resolution, 'null'::jsonb));

CREATE INDEX spatial_coverage_derivative_active_quota_idx
  ON app.spatial_coverage_derivative_jobs (organization_id, coverage_id, state)
  WHERE state IN ('queued', 'running');

CREATE OR REPLACE FUNCTION app.enforce_spatial_coverage_derivative_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_coverage app.spatial_service_coverages%ROWTYPE;
  v_total integer;
  v_active integer;
  v_expected_width integer;
  v_expected_height integer;
  v_all_bands jsonb;
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL
    OR NEW.worker_token IS NOT NULL
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
   AND dataset.current_version_id = coverage.dataset_version_id
   AND dataset.status = 'active'
   AND dataset.format = 'cog'
  JOIN app.dataset_versions version
    ON version.organization_id = coverage.organization_id
   AND version.dataset_id = coverage.dataset_id
   AND version.id = coverage.dataset_version_id
   AND version.version_number = coverage.sealed_dataset_version_number
   AND version.state = 'active'
   AND version.geometry_type = 'raster'
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
    AND object.role = 'original'
    AND object.size_bytes <= 536870912
  FOR UPDATE OF coverage;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coverage derivative must target a fresh active exact COG seal';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE state IN ('queued', 'running'))::integer
  INTO v_total, v_active
  FROM app.spatial_coverage_derivative_jobs
  WHERE organization_id = NEW.organization_id AND coverage_id = NEW.coverage_id;
  IF v_total >= 64 THEN
    RAISE EXCEPTION 'coverage derivative retained-job quota exceeded';
  END IF;
  IF v_active >= 4 THEN
    RAISE EXCEPTION 'coverage derivative active-job quota exceeded';
  END IF;

  SELECT jsonb_agg(index ORDER BY index) INTO v_all_bands
  FROM generate_series(1, v_coverage.sealed_band_count) AS index;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.band_indexes) item
    WHERE item::integer > v_coverage.sealed_band_count
  ) OR (NEW.request_schema_version = 1 AND NEW.band_indexes <> v_all_bands)
  THEN
    RAISE EXCEPTION 'coverage derivative range subset is invalid';
  END IF;

  IF (NEW.subset_extent->>0)::numeric < (v_coverage.sealed_extent->>0)::numeric
    OR (NEW.subset_extent->>1)::numeric < (v_coverage.sealed_extent->>1)::numeric
    OR (NEW.subset_extent->>2)::numeric > (v_coverage.sealed_extent->>2)::numeric
    OR (NEW.subset_extent->>3)::numeric > (v_coverage.sealed_extent->>3)::numeric
    OR NEW.target_width::bigint * NEW.target_height::bigint
       * jsonb_array_length(NEW.band_indexes)::bigint > 67108864
  THEN
    RAISE EXCEPTION 'coverage derivative request exceeds the sealed raster bounds';
  END IF;

  IF NEW.scale_mode = 'resolution' THEN
    IF NEW.target_crs <> v_coverage.sealed_crs THEN
      RAISE EXCEPTION 'coverage derivative resolution scaling requires source CRS';
    END IF;
    v_expected_width := ceil(
      ((NEW.subset_extent->>2)::numeric - (NEW.subset_extent->>0)::numeric)
      / (NEW.requested_resolution->>0)::numeric
    )::integer;
    v_expected_height := ceil(
      ((NEW.subset_extent->>3)::numeric - (NEW.subset_extent->>1)::numeric)
      / (NEW.requested_resolution->>1)::numeric
    )::integer;
    IF v_expected_width <> NEW.target_width OR v_expected_height <> NEW.target_height THEN
      RAISE EXCEPTION 'coverage derivative resolution grid mismatch';
    END IF;
  END IF;

  IF NEW.subset_extent = v_coverage.sealed_extent
    AND NEW.target_crs = v_coverage.sealed_crs
    AND NEW.target_width = v_coverage.sealed_width
    AND NEW.target_height = v_coverage.sealed_height
    AND NEW.band_indexes = v_all_bands
  THEN
    RAISE EXCEPTION 'coverage derivative request is identical to the exact source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_spatial_coverage_derivative_transition()
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
    OR NEW.request_schema_version <> OLD.request_schema_version
    OR NEW.band_indexes <> OLD.band_indexes
    OR NEW.scale_mode <> OLD.scale_mode
    OR NEW.requested_resolution IS DISTINCT FROM OLD.requested_resolution
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR NEW.started_at IS DISTINCT FROM OLD.started_at AND OLD.started_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'coverage derivative request seal is immutable';
  END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'coverage derivative terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION app.claim_spatial_coverage_derivative(uuid, uuid, integer);
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
  request_schema_version smallint,
  band_indexes jsonb,
  scale_mode text,
  requested_resolution jsonb,
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
      NULL::integer, NULL::integer, NULL::jsonb, NULL::smallint, NULL::jsonb,
      NULL::text, NULL::jsonb, NULL::jsonb, NULL::text, NULL::integer,
      NULL::integer, NULL::text, NULL::text, NULL::integer, NULL::text;
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
    v_job.sealed_bands, v_job.request_schema_version, v_job.band_indexes,
    v_job.scale_mode, v_job.requested_resolution, v_job.subset_extent,
    v_job.target_crs, v_job.target_width, v_job.target_height, v_job.resampling,
    v_job.request_checksum_sha256, v_job.attempt_count,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
      v_job.organization_id, v_job.project_id, v_job.dataset_id,
      v_job.dataset_version_id
    );
END;
$$;

CREATE FUNCTION app.cancel_spatial_coverage_derivative(
  p_organization_id uuid,
  p_project_id uuid,
  p_service_id uuid,
  p_coverage_id uuid,
  p_job_id uuid,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN
    RETURN false;
  END IF;
  UPDATE app.spatial_coverage_derivative_jobs
  SET state = 'cancelled', error_code = 'cancelled_by_user',
      finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND service_id = p_service_id
    AND coverage_id = p_coverage_id
    AND id = p_job_id
    AND state = 'queued';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'spatial_service.coverage.derivative.cancelled', 'spatial_service',
     p_service_id, p_request_id,
     jsonb_build_object(
       'derivative_job_id', p_job_id, 'coverage_id', p_coverage_id
     ));
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.valid_coverage_band_indexes(jsonb),
  app.valid_coverage_resolution(jsonb),
  app.claim_spatial_coverage_derivative(uuid, uuid, integer),
  app.cancel_spatial_coverage_derivative(uuid, uuid, uuid, uuid, uuid, uuid, text)
FROM PUBLIC, opengeo_runtime, opengeo_worker;

GRANT EXECUTE ON FUNCTION
  app.valid_coverage_band_indexes(jsonb),
  app.valid_coverage_resolution(jsonb)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_spatial_coverage_derivative(uuid, uuid, integer)
TO opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.cancel_spatial_coverage_derivative(uuid, uuid, uuid, uuid, uuid, uuid, text)
TO opengeo_runtime;

COMMENT ON COLUMN app.spatial_coverage_derivative_jobs.band_indexes IS
  'Strictly increasing one-based source-band indexes; range selection is explicit work.';
COMMENT ON COLUMN app.spatial_coverage_derivative_jobs.requested_resolution IS
  'Maximum source-CRS x/y units per pixel; the sealed grid uses ceil(extent/resolution).';
COMMENT ON FUNCTION app.cancel_spatial_coverage_derivative(uuid, uuid, uuid, uuid, uuid, uuid, text) IS
  'One-way audited cancellation for queued work only; running or terminal work is immutable.';

COMMIT;
