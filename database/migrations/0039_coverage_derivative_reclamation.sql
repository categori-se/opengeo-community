BEGIN;

-- SERVICE-009 keeps cleanup explicit and activation-only. A confirmed plan
-- seals one generated COG version; no catalog read, timer, or resident process
-- can create reclamation work.
CREATE TABLE app.spatial_coverage_derivative_reclamations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  derivative_job_id uuid NOT NULL,
  output_object_id uuid NOT NULL,
  sealed_bucket text NOT NULL,
  sealed_object_key text NOT NULL,
  sealed_storage_version_id text NOT NULL,
  sealed_etag text NOT NULL,
  sealed_content_type text NOT NULL,
  sealed_size_bytes bigint NOT NULL,
  sealed_checksum_sha256 text NOT NULL,
  preview_checksum_sha256 text NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  error_code text,
  worker_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  delete_started_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, derivative_job_id)
    REFERENCES app.spatial_coverage_derivative_jobs (organization_id, id),
  CONSTRAINT spatial_coverage_derivative_reclamation_target_shape CHECK (
    sealed_bucket <> ''
    AND sealed_object_key ~ '^organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/datasets/[0-9a-f-]{36}/versions/[0-9a-f-]{36}/derivatives/coverages/[0-9a-f-]{36}\.tif$'
    AND sealed_storage_version_id NOT IN ('', 'null')
    AND sealed_etag ~ '^[A-Fa-f0-9]{16,128}$'
    AND sealed_content_type = 'image/tiff'
    AND sealed_size_bytes BETWEEN 1 AND 536870912
    AND sealed_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND preview_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND preview_expires_at > created_at
    AND preview_expires_at <= created_at + interval '15 minutes'
  ),
  CONSTRAINT spatial_coverage_derivative_reclamation_attempt_nonnegative CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT spatial_coverage_derivative_reclamation_state_shape CHECK (
    (state = 'queued' AND worker_token IS NULL AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL AND finished_at IS NULL)
    OR (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state = 'completed' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL
      AND delete_started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_code IS NULL)
    OR (state = 'failed' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL
      AND delete_started_at IS NULL AND finished_at IS NOT NULL
      AND error_code IS NOT NULL)
  ),
  CONSTRAINT spatial_coverage_derivative_reclamation_no_cancel CHECK (
    state <> 'cancelled'
  )
);

CREATE UNIQUE INDEX spatial_coverage_derivative_reclamation_one_live_idx
  ON app.spatial_coverage_derivative_reclamations
  (organization_id, derivative_job_id)
  WHERE state IN ('queued', 'running', 'completed');
CREATE INDEX spatial_coverage_derivative_reclamation_expired_idx
  ON app.spatial_coverage_derivative_reclamations (lease_expires_at, id)
  WHERE state = 'running';

-- The immutable derivative history retains the output UUID after its catalog
-- row is reclaimed. The reclamation row retains every exact storage fact.
DO $$
DECLARE
  v_constraint name;
BEGIN
  SELECT constraints.constraint_name INTO v_constraint
  FROM information_schema.table_constraints constraints
  JOIN information_schema.key_column_usage columns
    ON columns.constraint_schema = constraints.constraint_schema
   AND columns.constraint_name = constraints.constraint_name
   AND columns.table_schema = constraints.table_schema
   AND columns.table_name = constraints.table_name
  WHERE constraints.table_schema = 'app'
    AND constraints.table_name = 'spatial_coverage_derivative_jobs'
    AND constraints.constraint_type = 'FOREIGN KEY'
    AND columns.column_name = 'output_object_id'
  ORDER BY constraints.constraint_name
  LIMIT 1;
  IF v_constraint IS NULL THEN
    RAISE EXCEPTION 'coverage derivative output object constraint not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE app.spatial_coverage_derivative_jobs DROP CONSTRAINT %I',
    v_constraint
  );
END;
$$;

-- Runtime reads stop exposing the object as soon as deletion is queued. This
-- also prevents a new governed/site reference from being created after queueing.
DROP POLICY data_objects_tenant_isolation ON app.data_objects;
CREATE POLICY data_objects_tenant_isolation ON app.data_objects
  USING (
    organization_id = app.current_organization_id()
    AND NOT EXISTS (
      SELECT 1
      FROM app.spatial_coverage_derivative_reclamations reclamation
      WHERE reclamation.organization_id = data_objects.organization_id
        AND reclamation.output_object_id = data_objects.id
        AND reclamation.state IN ('queued', 'running', 'completed')
    )
  )
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.coverage_derivative_object_is_referenced(
  p_organization_id uuid,
  p_object_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_referenced boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM app.governed_resource_versions version
    WHERE version.organization_id = p_organization_id
      AND version.content::text LIKE '%' || p_object_id::text || '%'
  ) INTO v_referenced;
  IF v_referenced OR to_regclass('app.project_site_editions') IS NULL THEN
    RETURN v_referenced;
  END IF;
  EXECUTE
    'SELECT EXISTS (
       SELECT 1 FROM app.project_site_editions edition
       WHERE edition.organization_id = $1
         AND edition.manifest::text LIKE ''%'' || $2::text || ''%''
     )'
  INTO v_referenced
  USING p_organization_id, p_object_id;
  RETURN v_referenced;
END;
$$;

CREATE FUNCTION app.queue_spatial_coverage_derivative_reclamation(
  p_organization_id uuid,
  p_project_id uuid,
  p_service_id uuid,
  p_coverage_id uuid,
  p_derivative_job_id uuid,
  p_preview_checksum_sha256 text,
  p_preview_expires_at timestamptz,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_target record;
  v_existing app.spatial_coverage_derivative_reclamations%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR p_preview_checksum_sha256 !~ '^[0-9a-f]{64}$'
    OR p_preview_expires_at <= v_now
    OR p_preview_expires_at > v_now + interval '15 minutes'
    OR p_request_id IS NULL OR char_length(p_request_id) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'invalid coverage derivative reclamation confirmation';
  END IF;

  SELECT reclamation.* INTO v_existing
  FROM app.spatial_coverage_derivative_reclamations reclamation
  WHERE reclamation.organization_id = p_organization_id
    AND reclamation.derivative_job_id = p_derivative_job_id
    AND reclamation.state IN ('queued', 'running', 'completed')
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.preview_checksum_sha256 <> p_preview_checksum_sha256 THEN
      RAISE EXCEPTION 'coverage derivative reclamation preview changed';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT job.organization_id, job.project_id, job.service_id, job.coverage_id,
         job.finished_at, job.output_object_id, object.bucket, object.object_key,
         object.s3_version_id, object.etag, object.content_type,
         object.size_bytes, object.checksum_sha256, object.role::text
  INTO v_target
  FROM app.spatial_coverage_derivative_jobs job
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.output_object_id
  WHERE job.organization_id = p_organization_id
    AND job.project_id = p_project_id
    AND job.service_id = p_service_id
    AND job.coverage_id = p_coverage_id
    AND job.id = p_derivative_job_id
    AND job.state = 'completed'
  FOR UPDATE OF job, object;
  IF NOT FOUND
    OR v_target.finished_at > v_now - interval '24 hours'
    OR v_target.role <> 'derived'
    OR v_target.object_key <> format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/coverages/%s.tif',
      v_target.organization_id, v_target.project_id,
      (SELECT coverage.dataset_id FROM app.spatial_service_coverages coverage
       WHERE coverage.organization_id = p_organization_id
         AND coverage.id = p_coverage_id),
      (SELECT coverage.dataset_version_id FROM app.spatial_service_coverages coverage
       WHERE coverage.organization_id = p_organization_id
         AND coverage.id = p_coverage_id),
      p_derivative_job_id
    )
  THEN
    RAISE EXCEPTION 'coverage derivative is not reclaimable';
  END IF;
  IF app.coverage_derivative_object_is_referenced(
    p_organization_id, v_target.output_object_id
  ) THEN
    RAISE EXCEPTION 'coverage derivative object is still referenced';
  END IF;

  INSERT INTO app.spatial_coverage_derivative_reclamations
    (id, organization_id, project_id, service_id, coverage_id,
     derivative_job_id, output_object_id, sealed_bucket, sealed_object_key,
     sealed_storage_version_id, sealed_etag, sealed_content_type,
     sealed_size_bytes, sealed_checksum_sha256, preview_checksum_sha256,
     preview_expires_at, created_by, created_at)
  VALUES
    (v_id, p_organization_id, p_project_id, p_service_id, p_coverage_id,
     p_derivative_job_id, v_target.output_object_id, v_target.bucket,
     v_target.object_key, v_target.s3_version_id, lower(v_target.etag),
     v_target.content_type, v_target.size_bytes, v_target.checksum_sha256,
     p_preview_checksum_sha256, p_preview_expires_at, p_actor_user_id, v_now);

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'spatial_service.coverage.derivative.reclamation.requested',
     'spatial_service', p_service_id, p_request_id,
     jsonb_build_object(
       'reclamation_id', v_id, 'derivative_job_id', p_derivative_job_id,
       'coverage_id', p_coverage_id, 'output_object_id', v_target.output_object_id,
       'size_bytes', v_target.size_bytes,
       'checksum_sha256', v_target.checksum_sha256
     ));
  RETURN v_id;
END;
$$;

CREATE FUNCTION app.claim_spatial_coverage_derivative_reclamation(
  p_reclamation_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  reclamation_id uuid,
  derivative_job_id uuid,
  output_object_id uuid,
  bucket text,
  object_key text,
  storage_version_id text,
  etag text,
  content_type text,
  size_bytes bigint,
  checksum_sha256 text,
  delete_started_at timestamptz,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_coverage_derivative_reclamations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_reclamation_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'invalid coverage derivative reclamation claim';
  END IF;
  SELECT * INTO v_plan
  FROM app.spatial_coverage_derivative_reclamations
  WHERE id = p_reclamation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_reclamation_id, NULL::uuid, NULL::uuid,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::bigint, NULL::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  IF v_plan.state IN ('completed', 'failed') THEN
    claim_status := 'already_' || v_plan.state::text;
  ELSIF v_plan.state = 'running' AND v_plan.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF app.coverage_derivative_object_is_referenced(
    v_plan.organization_id, v_plan.output_object_id
  ) THEN
    UPDATE app.spatial_coverage_derivative_reclamations
    SET state = 'failed', error_code = 'coverage_derivative_object_referenced',
        worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
        finished_at = v_now
    WHERE id = v_plan.id;
    INSERT INTO app.activity_events
      (organization_id, actor_user_id, project_id, event_type,
       resource_type, resource_id, request_id, payload)
    VALUES
      (v_plan.organization_id, v_plan.created_by, v_plan.project_id,
       'spatial_service.coverage.derivative.reclamation.failed',
       'spatial_service', v_plan.service_id, 'worker:' || v_plan.id::text,
       jsonb_build_object(
         'reclamation_id', v_plan.id,
         'derivative_job_id', v_plan.derivative_job_id,
         'coverage_id', v_plan.coverage_id,
         'output_object_id', v_plan.output_object_id,
         'error_code', 'coverage_derivative_object_referenced'
       ));
    claim_status := 'already_failed';
  ELSE
    UPDATE app.spatial_coverage_derivative_reclamations target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now,
        attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_plan.id;
    claim_status := 'claimed';
    v_plan.attempt_count := v_plan.attempt_count + 1;
  END IF;
  RETURN QUERY SELECT claim_status, v_plan.id, v_plan.derivative_job_id,
    v_plan.output_object_id, v_plan.sealed_bucket, v_plan.sealed_object_key,
    v_plan.sealed_storage_version_id, v_plan.sealed_etag,
    v_plan.sealed_content_type, v_plan.sealed_size_bytes,
    v_plan.sealed_checksum_sha256, v_plan.delete_started_at,
    v_plan.attempt_count;
END;
$$;

CREATE FUNCTION app.heartbeat_spatial_coverage_derivative_reclamation(
  p_reclamation_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN RETURN false; END IF;
  UPDATE app.spatial_coverage_derivative_reclamations
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.start_spatial_coverage_derivative_delete(
  p_reclamation_id uuid, p_worker_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  UPDATE app.spatial_coverage_derivative_reclamations
  SET delete_started_at = COALESCE(delete_started_at, clock_timestamp()),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token AND lease_expires_at > clock_timestamp()
    AND NOT app.coverage_derivative_object_is_referenced(
      organization_id, output_object_id
    );
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.complete_spatial_coverage_derivative_reclamation(
  p_reclamation_id uuid, p_worker_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_coverage_derivative_reclamations%ROWTYPE;
  v_deleted integer;
BEGIN
  SELECT * INTO v_plan
  FROM app.spatial_coverage_derivative_reclamations
  WHERE id = p_reclamation_id FOR UPDATE;
  IF NOT FOUND OR v_plan.state <> 'running'
    OR v_plan.worker_token <> p_worker_token
    OR v_plan.lease_expires_at <= clock_timestamp()
    OR v_plan.delete_started_at IS NULL
    OR app.coverage_derivative_object_is_referenced(
      v_plan.organization_id, v_plan.output_object_id
    )
  THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM app.data_objects
  WHERE organization_id = v_plan.organization_id
    AND id = v_plan.output_object_id
    AND bucket = v_plan.sealed_bucket
    AND object_key = v_plan.sealed_object_key
    AND s3_version_id = v_plan.sealed_storage_version_id
    AND lower(etag) = v_plan.sealed_etag
    AND content_type = v_plan.sealed_content_type
    AND size_bytes = v_plan.sealed_size_bytes
    AND checksum_sha256 = v_plan.sealed_checksum_sha256
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM app.dataset_version_objects
  WHERE organization_id = v_plan.organization_id
    AND data_object_id = v_plan.output_object_id;
  DELETE FROM app.data_objects
  WHERE organization_id = v_plan.organization_id
    AND id = v_plan.output_object_id
    AND bucket = v_plan.sealed_bucket
    AND object_key = v_plan.sealed_object_key
    AND s3_version_id = v_plan.sealed_storage_version_id
    AND lower(etag) = v_plan.sealed_etag
    AND content_type = v_plan.sealed_content_type
    AND size_bytes = v_plan.sealed_size_bytes
    AND checksum_sha256 = v_plan.sealed_checksum_sha256;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN RETURN false; END IF;
  UPDATE app.spatial_coverage_derivative_reclamations
  SET state = 'completed', error_code = NULL, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_plan.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_plan.organization_id, v_plan.created_by, v_plan.project_id,
     'spatial_service.coverage.derivative.reclamation.completed',
     'spatial_service', v_plan.service_id, 'worker:' || v_plan.id::text,
     jsonb_build_object(
       'reclamation_id', v_plan.id,
       'derivative_job_id', v_plan.derivative_job_id,
       'coverage_id', v_plan.coverage_id,
       'output_object_id', v_plan.output_object_id,
       'size_bytes', v_plan.sealed_size_bytes,
       'checksum_sha256', v_plan.sealed_checksum_sha256
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_spatial_coverage_derivative_reclamation(
  p_reclamation_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_coverage_derivative_reclamations%ROWTYPE;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200
  THEN RETURN false; END IF;
  SELECT * INTO v_plan
  FROM app.spatial_coverage_derivative_reclamations
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token AND delete_started_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.spatial_coverage_derivative_reclamations
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_plan.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_plan.organization_id, v_plan.created_by, v_plan.project_id,
     'spatial_service.coverage.derivative.reclamation.failed',
     'spatial_service', v_plan.service_id, 'worker:' || v_plan.id::text,
     jsonb_build_object(
       'reclamation_id', v_plan.id,
       'derivative_job_id', v_plan.derivative_job_id,
       'coverage_id', v_plan.coverage_id,
       'output_object_id', v_plan.output_object_id,
       'error_code', p_error_code
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_spatial_coverage_derivative_reclamation(
  p_reclamation_id uuid, p_worker_token uuid, p_error_code text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_coverage_derivative_reclamations%ROWTYPE;
  v_state text;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200 OR p_max_attempts NOT BETWEEN 1 AND 10
  THEN RETURN 'lost'; END IF;
  SELECT * INTO v_plan FROM app.spatial_coverage_derivative_reclamations
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE
    WHEN v_plan.delete_started_at IS NOT NULL THEN 'queued'
    WHEN v_plan.attempt_count >= p_max_attempts THEN 'failed'
    ELSE 'queued'
  END;
  UPDATE app.spatial_coverage_derivative_reclamations
  SET state = v_state::app.processing_job_state, error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = v_plan.id;
  IF v_state = 'failed' THEN
    INSERT INTO app.activity_events
      (organization_id, actor_user_id, project_id, event_type,
       resource_type, resource_id, request_id, payload)
    VALUES
      (v_plan.organization_id, v_plan.created_by, v_plan.project_id,
       'spatial_service.coverage.derivative.reclamation.failed',
       'spatial_service', v_plan.service_id, 'worker:' || v_plan.id::text,
       jsonb_build_object(
         'reclamation_id', v_plan.id,
         'derivative_job_id', v_plan.derivative_job_id,
         'coverage_id', v_plan.coverage_id,
         'output_object_id', v_plan.output_object_id,
         'error_code', p_error_code
       ));
  END IF;
  RETURN v_state;
END;
$$;

-- SERVICE-008 selected-band jobs must be accepted using the sealed request
-- range, not the source's full band count.
CREATE OR REPLACE FUNCTION app.complete_spatial_coverage_derivative(
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
  v_position integer;
  v_source_index integer;
BEGIN
  SELECT * INTO v_job FROM app.spatial_coverage_derivative_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
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
    OR (p_metadata->>'band_count')::integer <> jsonb_array_length(v_job.band_indexes)
    OR jsonb_typeof(p_metadata->'extent') <> 'array'
    OR jsonb_array_length(p_metadata->'extent') <> 4
    OR jsonb_typeof(p_metadata->'bands') <> 'array'
    OR jsonb_array_length(p_metadata->'bands') <> jsonb_array_length(v_job.band_indexes)
  THEN RAISE EXCEPTION 'invalid coverage derivative artifact'; END IF;
  FOR v_position IN 0..jsonb_array_length(v_job.band_indexes) - 1 LOOP
    v_source_index := (v_job.band_indexes->>v_position)::integer;
    IF jsonb_typeof(p_metadata->'bands'->v_position) <> 'object'
      OR (p_metadata->'bands'->v_position->>'index')::integer
         IS DISTINCT FROM v_position + 1
      OR (p_metadata->'bands'->v_position->>'source_index')::integer
         IS DISTINCT FROM v_source_index
      OR (p_metadata->'bands'->v_position->>'data_type')
         IS DISTINCT FROM
         (v_coverage.sealed_bands->(v_source_index - 1)->>'data_type')
    THEN RAISE EXCEPTION 'invalid coverage derivative range lineage'; END IF;
  END LOOP;
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

-- A completed reclamation releases one retained-job quota slot while keeping
-- the derivative and reclamation history queryable.
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
  IF NEW.created_by <> app.current_user_id() OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL OR NEW.worker_token IS NOT NULL
  THEN RAISE EXCEPTION 'coverage derivative creator or initial state mismatch'; END IF;
  SELECT coverage.* INTO v_coverage
  FROM app.spatial_service_coverages coverage
  JOIN app.spatial_services service ON service.organization_id = coverage.organization_id
    AND service.project_id = coverage.project_id AND service.id = coverage.service_id
  JOIN app.datasets dataset ON dataset.organization_id = coverage.organization_id
    AND dataset.id = coverage.dataset_id AND dataset.current_version_id = coverage.dataset_version_id
    AND dataset.status = 'active' AND dataset.format = 'cog'
  JOIN app.dataset_versions version ON version.organization_id = coverage.organization_id
    AND version.dataset_id = coverage.dataset_id AND version.id = coverage.dataset_version_id
    AND version.version_number = coverage.sealed_dataset_version_number
    AND version.state = 'active' AND version.geometry_type = 'raster'
  JOIN app.data_objects object ON object.organization_id = coverage.organization_id
    AND object.dataset_id = coverage.dataset_id AND object.id = coverage.data_object_id
    AND object.bucket = coverage.sealed_bucket AND object.object_key = coverage.sealed_object_key
    AND object.s3_version_id = coverage.sealed_storage_version_id
    AND object.content_type = coverage.sealed_content_type
    AND object.size_bytes = coverage.sealed_size_bytes
    AND object.checksum_sha256 = coverage.sealed_checksum_sha256
  WHERE coverage.organization_id = NEW.organization_id
    AND coverage.project_id = NEW.project_id AND coverage.service_id = NEW.service_id
    AND coverage.id = NEW.coverage_id AND coverage.withdrawn_at IS NULL
    AND service.disabled_at IS NULL AND object.role = 'original'
    AND object.size_bytes <= 536870912
  FOR UPDATE OF coverage;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coverage derivative must target a fresh active exact COG seal';
  END IF;
  SELECT count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM app.spatial_coverage_derivative_reclamations reclamation
           WHERE reclamation.organization_id = job.organization_id
             AND reclamation.derivative_job_id = job.id
             AND reclamation.state = 'completed'))::integer,
         count(*) FILTER (WHERE job.state IN ('queued', 'running'))::integer
  INTO v_total, v_active
  FROM app.spatial_coverage_derivative_jobs job
  WHERE job.organization_id = NEW.organization_id AND job.coverage_id = NEW.coverage_id;
  IF v_total >= 64 THEN RAISE EXCEPTION 'coverage derivative retained-job quota exceeded'; END IF;
  IF v_active >= 4 THEN RAISE EXCEPTION 'coverage derivative active-job quota exceeded'; END IF;
  SELECT jsonb_agg(index ORDER BY index) INTO v_all_bands
  FROM generate_series(1, v_coverage.sealed_band_count) AS index;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.band_indexes) item
             WHERE item::integer > v_coverage.sealed_band_count)
    OR (NEW.request_schema_version = 1 AND NEW.band_indexes <> v_all_bands)
  THEN RAISE EXCEPTION 'coverage derivative range subset is invalid'; END IF;
  IF (NEW.subset_extent->>0)::numeric < (v_coverage.sealed_extent->>0)::numeric
    OR (NEW.subset_extent->>1)::numeric < (v_coverage.sealed_extent->>1)::numeric
    OR (NEW.subset_extent->>2)::numeric > (v_coverage.sealed_extent->>2)::numeric
    OR (NEW.subset_extent->>3)::numeric > (v_coverage.sealed_extent->>3)::numeric
    OR NEW.target_width::bigint * NEW.target_height::bigint
       * jsonb_array_length(NEW.band_indexes)::bigint > 67108864
  THEN RAISE EXCEPTION 'coverage derivative request exceeds the sealed raster bounds'; END IF;
  IF NEW.scale_mode = 'resolution' THEN
    IF NEW.target_crs <> v_coverage.sealed_crs THEN
      RAISE EXCEPTION 'coverage derivative resolution scaling requires source CRS';
    END IF;
    v_expected_width := ceil(((NEW.subset_extent->>2)::numeric
      - (NEW.subset_extent->>0)::numeric) / (NEW.requested_resolution->>0)::numeric)::integer;
    v_expected_height := ceil(((NEW.subset_extent->>3)::numeric
      - (NEW.subset_extent->>1)::numeric) / (NEW.requested_resolution->>1)::numeric)::integer;
    IF v_expected_width <> NEW.target_width OR v_expected_height <> NEW.target_height THEN
      RAISE EXCEPTION 'coverage derivative resolution grid mismatch';
    END IF;
  END IF;
  IF NEW.subset_extent = v_coverage.sealed_extent
    AND NEW.target_crs = v_coverage.sealed_crs
    AND NEW.target_width = v_coverage.sealed_width
    AND NEW.target_height = v_coverage.sealed_height
    AND NEW.band_indexes = v_all_bands
  THEN RAISE EXCEPTION 'coverage derivative request is identical to the exact source'; END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE app.spatial_coverage_derivative_reclamations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_coverage_derivative_reclamations FORCE ROW LEVEL SECURITY;
CREATE POLICY spatial_coverage_derivative_reclamations_tenant_isolation
  ON app.spatial_coverage_derivative_reclamations
  USING (organization_id = app.current_organization_id());

GRANT SELECT ON app.spatial_coverage_derivative_reclamations TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.spatial_coverage_derivative_reclamations
  FROM opengeo_runtime;
REVOKE ALL ON app.spatial_coverage_derivative_reclamations FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.coverage_derivative_object_is_referenced(uuid, uuid),
  app.queue_spatial_coverage_derivative_reclamation(
    uuid, uuid, uuid, uuid, uuid, text, timestamptz, uuid, text
  ),
  app.claim_spatial_coverage_derivative_reclamation(uuid, uuid, integer),
  app.heartbeat_spatial_coverage_derivative_reclamation(uuid, uuid, integer),
  app.start_spatial_coverage_derivative_delete(uuid, uuid),
  app.complete_spatial_coverage_derivative_reclamation(uuid, uuid),
  app.fail_spatial_coverage_derivative_reclamation(uuid, uuid, text),
  app.release_spatial_coverage_derivative_reclamation(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.queue_spatial_coverage_derivative_reclamation(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz, uuid, text
) TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_spatial_coverage_derivative_reclamation(uuid, uuid, integer),
  app.heartbeat_spatial_coverage_derivative_reclamation(uuid, uuid, integer),
  app.start_spatial_coverage_derivative_delete(uuid, uuid),
  app.complete_spatial_coverage_derivative_reclamation(uuid, uuid),
  app.fail_spatial_coverage_derivative_reclamation(uuid, uuid, text),
  app.release_spatial_coverage_derivative_reclamation(uuid, uuid, text, integer)
TO opengeo_worker;

COMMENT ON TABLE app.spatial_coverage_derivative_reclamations IS
  'Explicit preview-confirmed exact-version COG deletion plans; reads and timers never create work.';

COMMIT;
