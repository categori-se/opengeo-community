BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_worker') THEN
    EXECUTE 'CREATE ROLE opengeo_worker LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_worker SET search_path = app, public;

ALTER TABLE app.processing_jobs
  ADD COLUMN worker_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD CONSTRAINT processing_jobs_worker_lease_shape CHECK (
    (state = 'running'
      AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL)
    OR
    (state <> 'running'
      AND worker_token IS NULL
      AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL)
  );

CREATE INDEX processing_jobs_expired_lease_idx
  ON app.processing_jobs (lease_expires_at, id)
  WHERE state = 'running';

REVOKE UPDATE ON app.dataset_versions, app.processing_jobs FROM opengeo_runtime;

CREATE FUNCTION app.claim_dataset_ingest(
  p_bucket text,
  p_object_key text,
  p_s3_version_id text,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  job_id uuid,
  organization_id uuid,
  project_id uuid,
  dataset_id uuid,
  dataset_version_id uuid,
  original_object_id uuid,
  original_filename text,
  dataset_format text,
  content_type text,
  size_bytes bigint,
  checksum_sha256 text,
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
  IF p_bucket IS NULL OR p_bucket = '' OR char_length(p_bucket) > 63
    OR p_object_key IS NULL OR p_object_key = '' OR char_length(p_object_key) > 1024
    OR p_s3_version_id IS NULL OR p_s3_version_id IN ('', 'null')
    OR char_length(p_s3_version_id) > 1024
    OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'invalid ingestion claim';
  END IF;

  SELECT
    job.id,
    job.organization_id,
    job.project_id,
    job.dataset_id,
    job.dataset_version_id,
    job.state::text AS job_state,
    job.attempt_count,
    job.lease_expires_at,
    version.original_object_id,
    object.content_type,
    object.size_bytes,
    object.checksum_sha256,
    dataset.format::text AS dataset_format,
    intent.original_filename
  INTO v_job
  FROM app.data_objects object
  JOIN app.dataset_versions version
    ON version.organization_id = object.organization_id
   AND version.dataset_id = object.dataset_id
   AND version.original_object_id = object.id
  JOIN app.datasets dataset
    ON dataset.organization_id = version.organization_id
   AND dataset.id = version.dataset_id
  JOIN app.processing_jobs job
    ON job.organization_id = version.organization_id
   AND job.dataset_id = version.dataset_id
   AND job.dataset_version_id = version.id
   AND job.job_type = 'dataset.ingest'
  JOIN app.upload_intents intent
    ON intent.organization_id = object.organization_id
   AND intent.completed_object_id = object.id
   AND intent.state = 'completed'
  WHERE object.bucket = p_bucket
    AND object.object_key = p_object_key
    AND object.s3_version_id = p_s3_version_id
    AND object.role = 'original'
  FOR UPDATE OF job;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_ready', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text,
      NULL::integer, NULL::text;
    RETURN;
  END IF;

  IF v_job.job_state IN ('completed', 'failed', 'cancelled') THEN
    RETURN QUERY SELECT
      'already_' || v_job.job_state,
      v_job.id,
      v_job.organization_id,
      v_job.project_id,
      v_job.dataset_id,
      v_job.dataset_version_id,
      v_job.original_object_id,
      v_job.original_filename,
      v_job.dataset_format,
      v_job.content_type,
      v_job.size_bytes,
      v_job.checksum_sha256,
      v_job.attempt_count,
      format(
        'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
        v_job.organization_id,
        v_job.project_id,
        v_job.dataset_id,
        v_job.dataset_version_id
      );
    RETURN;
  END IF;

  IF v_job.job_state = 'running' AND v_job.lease_expires_at > v_now THEN
    RETURN QUERY SELECT
      'busy',
      v_job.id,
      v_job.organization_id,
      v_job.project_id,
      v_job.dataset_id,
      v_job.dataset_version_id,
      v_job.original_object_id,
      v_job.original_filename,
      v_job.dataset_format,
      v_job.content_type,
      v_job.size_bytes,
      v_job.checksum_sha256,
      v_job.attempt_count,
      format(
        'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
        v_job.organization_id,
        v_job.project_id,
        v_job.dataset_id,
        v_job.dataset_version_id
      );
    RETURN;
  END IF;

  UPDATE app.processing_jobs AS target
  SET state = 'running',
      worker_token = p_worker_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = v_now,
      attempt_count = target.attempt_count + 1,
      started_at = COALESCE(target.started_at, v_now),
      finished_at = NULL,
      error_code = NULL
  WHERE target.id = v_job.id;

  RETURN QUERY SELECT
    'claimed',
    v_job.id,
    v_job.organization_id,
    v_job.project_id,
    v_job.dataset_id,
    v_job.dataset_version_id,
    v_job.original_object_id,
    v_job.original_filename,
    v_job.dataset_format,
    v_job.content_type,
    v_job.size_bytes,
    v_job.checksum_sha256,
    v_job.attempt_count + 1,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
      v_job.organization_id,
      v_job.project_id,
      v_job.dataset_id,
      v_job.dataset_version_id
    );
END;
$$;

CREATE FUNCTION app.heartbeat_dataset_ingest(
  p_job_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  WITH heartbeat AS (
    UPDATE app.processing_jobs
    SET last_heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE id = p_job_id
      AND state = 'running'
      AND worker_token = p_worker_token
      AND p_lease_seconds BETWEEN 60 AND 3600
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM heartbeat)
$$;

CREATE FUNCTION app.complete_dataset_ingest(
  p_job_id uuid,
  p_worker_token uuid,
  p_metadata jsonb,
  p_artifacts jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.processing_jobs%ROWTYPE;
  v_original app.data_objects%ROWTYPE;
  v_artifact jsonb;
  v_prefix text;
  v_feature_count bigint;
  v_extent jsonb;
  v_crs text;
  v_geometry_type text;
  v_schema jsonb;
  v_quality jsonb;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
    OR octet_length(p_metadata::text) > 1048576
    OR p_artifacts IS NULL OR jsonb_typeof(p_artifacts) <> 'array'
    OR jsonb_array_length(p_artifacts) NOT BETWEEN 1 AND 16
    OR octet_length(p_artifacts::text) > 1048576
  THEN
    RAISE EXCEPTION 'invalid ingestion result';
  END IF;

  SELECT * INTO v_job
  FROM app.processing_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.job_type <> 'dataset.ingest'
    OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
  THEN
    RETURN false;
  END IF;

  SELECT object.* INTO v_original
  FROM app.data_objects object
  JOIN app.dataset_versions version
    ON version.organization_id = object.organization_id
   AND version.original_object_id = object.id
  WHERE version.organization_id = v_job.organization_id
    AND version.dataset_id = v_job.dataset_id
    AND version.id = v_job.dataset_version_id
    AND object.role = 'original';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingestion original object is missing';
  END IF;

  v_feature_count := NULLIF(p_metadata->>'feature_count', '')::bigint;
  v_extent := p_metadata->'extent';
  v_crs := NULLIF(p_metadata->>'crs', '');
  v_geometry_type := NULLIF(p_metadata->>'geometry_type', '');
  v_schema := COALESCE(p_metadata->'schema_definition', '{}'::jsonb);
  v_quality := COALESCE(p_metadata->'quality_results', '{}'::jsonb);

  IF (v_feature_count IS NOT NULL AND v_feature_count < 0)
    OR (v_extent IS NOT NULL AND v_extent <> 'null'::jsonb AND (
      jsonb_typeof(v_extent) <> 'array' OR jsonb_array_length(v_extent) <> 4
    ))
    OR (v_crs IS NOT NULL AND char_length(v_crs) > 1024)
    OR (v_geometry_type IS NOT NULL AND char_length(v_geometry_type) > 200)
    OR jsonb_typeof(v_schema) <> 'object'
    OR jsonb_typeof(v_quality) <> 'object'
  THEN
    RAISE EXCEPTION 'invalid ingestion metadata';
  END IF;

  v_prefix := format(
    'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
    v_job.organization_id,
    v_job.project_id,
    v_job.dataset_id,
    v_job.dataset_version_id
  );

  FOR v_artifact IN SELECT value FROM jsonb_array_elements(p_artifacts)
  LOOP
    IF jsonb_typeof(v_artifact) <> 'object'
      OR (v_artifact->>'bucket') <> v_original.bucket
      OR (v_artifact->>'object_key') NOT LIKE v_prefix || '%'
      OR (v_artifact->>'object_key') LIKE '%/../%'
      OR (v_artifact->>'object_key') LIKE '%//%'
      OR (v_artifact->>'s3_version_id') IN ('', 'null')
      OR (v_artifact->>'etag') = ''
      OR (v_artifact->>'content_type') = ''
      OR (v_artifact->>'size_bytes')::bigint <= 0
      OR (v_artifact->>'size_bytes')::bigint > 5368709120
      OR (v_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
      OR (v_artifact->>'role') NOT IN ('working', 'tile', 'derived', 'thumbnail')
    THEN
      RAISE EXCEPTION 'invalid ingestion artifact';
    END IF;

    INSERT INTO app.data_objects
      (id, organization_id, dataset_id, role, bucket, object_key,
       s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
    VALUES
      ((v_artifact->>'id')::uuid,
       v_job.organization_id,
       v_job.dataset_id,
       (v_artifact->>'role')::app.data_object_role,
       v_artifact->>'bucket',
       v_artifact->>'object_key',
       v_artifact->>'s3_version_id',
       v_artifact->>'etag',
       lower(v_artifact->>'content_type'),
       (v_artifact->>'size_bytes')::bigint,
       v_artifact->>'checksum_sha256',
       v_job.created_by);
  END LOOP;

  UPDATE app.dataset_versions
  SET state = 'active',
      feature_count = v_feature_count,
      extent = CASE WHEN v_extent = 'null'::jsonb THEN NULL ELSE v_extent END,
      crs = v_crs,
      geometry_type = v_geometry_type,
      schema_definition = v_schema,
      quality_results = v_quality
  WHERE organization_id = v_job.organization_id
    AND dataset_id = v_job.dataset_id
    AND id = v_job.dataset_version_id;

  UPDATE app.datasets
  SET status = 'active', updated_by = v_job.created_by
  WHERE organization_id = v_job.organization_id
    AND id = v_job.dataset_id
    AND current_version_id = v_job.dataset_version_id;

  UPDATE app.processing_jobs
  SET state = 'completed',
      result = p_metadata || jsonb_build_object('artifacts', p_artifacts),
      error_code = NULL,
      worker_token = NULL,
      lease_expires_at = NULL,
      last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.ingest.completed', 'dataset', v_job.dataset_id,
     'worker:' || v_job.id::text,
     jsonb_build_object(
       'processing_job_id', v_job.id,
       'dataset_version_id', v_job.dataset_version_id,
       'artifact_count', jsonb_array_length(p_artifacts)
     ));

  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_dataset_ingest(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_code text,
  p_quality_results jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.processing_jobs%ROWTYPE;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
    OR p_quality_results IS NULL OR jsonb_typeof(p_quality_results) <> 'object'
    OR octet_length(p_quality_results::text) > 262144
  THEN
    RAISE EXCEPTION 'invalid ingestion failure';
  END IF;

  SELECT * INTO v_job
  FROM app.processing_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.job_type <> 'dataset.ingest'
    OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
  THEN
    RETURN false;
  END IF;

  UPDATE app.dataset_versions
  SET state = 'failed', quality_results = p_quality_results
  WHERE organization_id = v_job.organization_id
    AND dataset_id = v_job.dataset_id
    AND id = v_job.dataset_version_id;

  UPDATE app.datasets
  SET status = 'failed', updated_by = v_job.created_by
  WHERE organization_id = v_job.organization_id
    AND id = v_job.dataset_id
    AND current_version_id = v_job.dataset_version_id;

  UPDATE app.processing_jobs
  SET state = 'failed',
      result = jsonb_build_object('quality_results', p_quality_results),
      error_code = p_error_code,
      worker_token = NULL,
      lease_expires_at = NULL,
      last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.ingest.failed', 'dataset', v_job.dataset_id,
     'worker:' || v_job.id::text,
     jsonb_build_object(
       'processing_job_id', v_job.id,
       'dataset_version_id', v_job.dataset_version_id,
       'error_code', p_error_code
     ));

  RETURN true;
END;
$$;

CREATE FUNCTION app.release_dataset_ingest(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_code text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.processing_jobs%ROWTYPE;
  v_failed boolean;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
    OR p_max_attempts NOT BETWEEN 1 AND 10
  THEN
    RAISE EXCEPTION 'invalid ingestion release';
  END IF;

  SELECT * INTO v_job
  FROM app.processing_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.job_type <> 'dataset.ingest'
    OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
  THEN
    RETURN 'lost';
  END IF;

  IF v_job.attempt_count >= p_max_attempts THEN
    v_failed := app.fail_dataset_ingest(
      p_job_id,
      p_worker_token,
      'processing_retry_exhausted',
      jsonb_build_object(
        'errors', jsonb_build_array(jsonb_build_object('code', p_error_code)),
        'attempt_count', v_job.attempt_count
      )
    );
    RETURN CASE WHEN v_failed THEN 'failed' ELSE 'lost' END;
  END IF;

  UPDATE app.processing_jobs
  SET state = 'queued',
      result = jsonb_build_object('last_transient_error', p_error_code),
      error_code = p_error_code,
      worker_token = NULL,
      lease_expires_at = NULL,
      last_heartbeat_at = NULL
  WHERE id = v_job.id;

  RETURN 'queued';
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.claim_dataset_ingest(text, text, text, uuid, integer),
  app.heartbeat_dataset_ingest(uuid, uuid, integer),
  app.complete_dataset_ingest(uuid, uuid, jsonb, jsonb),
  app.fail_dataset_ingest(uuid, uuid, text, jsonb),
  app.release_dataset_ingest(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime;

GRANT USAGE ON SCHEMA app TO opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.claim_dataset_ingest(text, text, text, uuid, integer),
  app.heartbeat_dataset_ingest(uuid, uuid, integer),
  app.complete_dataset_ingest(uuid, uuid, jsonb, jsonb),
  app.fail_dataset_ingest(uuid, uuid, text, jsonb),
  app.release_dataset_ingest(uuid, uuid, text, integer)
TO opengeo_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM opengeo_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON TABLES FROM opengeo_worker;

COMMENT ON FUNCTION app.claim_dataset_ingest(text, text, text, uuid, integer) IS
  'Claim only a completed exact S3 object/version job; duplicate and early events return safe status.';
COMMENT ON FUNCTION app.complete_dataset_ingest(uuid, uuid, jsonb, jsonb) IS
  'Atomically record bounded derivative facts and advance one leased dataset ingestion to active.';
COMMENT ON ROLE opengeo_worker IS
  'GIS worker login with function-only ingestion authority and no direct tenant-table grants.';

COMMIT;
