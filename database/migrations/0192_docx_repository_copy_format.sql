BEGIN;

-- Add the inspected format to the existing bounded copy-estimate metadata.
-- Existing one-object intent, rights, account and isolated copier gates remain.
ALTER TABLE app.repository_object_copy_estimates
  DROP CONSTRAINT repository_copy_estimate_output_supported,
  ADD CONSTRAINT repository_copy_estimate_output_supported CHECK (
    output_format IN (
      'geojson', 'csv', 'shapefile', 'geopackage', 'geoparquet', 'cog',
      'pmtiles', 'png', 'jpeg', 'pdf', 'odt', 'docx'
    )
  );

-- Preserve original filenames in both claim and completion seals.
CREATE OR REPLACE FUNCTION app.claim_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, organization_id uuid, project_id uuid,
  source_dataset_id uuid, source_owner_user_id uuid, connection_id uuid,
  connection_target_revision bigint, credential_revision bigint,
  credential_mode text, role_arn text, secret_arn text,
  source_bucket text, source_region text, source_object_key text,
  source_version_id text, source_etag text, source_checksum_sha256 text,
  output_format text, output_content_type text, maximum_output_bytes bigint,
  destination_dataset_id uuid, destination_bucket text,
  output_object_key text, request_checksum_sha256 text, attribution text,
  attempt_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900
  THEN RAISE EXCEPTION 'invalid repository copy claim'; END IF;
  SELECT job.*, estimate.output_format::text AS output_format,
         estimate.output_content_type, estimate.maximum_output_bytes,
         source.connection_id, source.connection_target_revision,
         source.bucket_name, source.region_name,
         source.object_prefix || source.relative_path AS source_object_key,
         source.provider_version_id, source.etag,
         source.provider_checksum_sha256, source.created_by AS source_owner_user_id,
         connection.credential_revision,
         connection.credential_mode::text AS credential_mode,
         connection.role_arn, connection.secret_arn,
         connection.status::text AS connection_status,
         connection.target_revision AS current_target_revision
  INTO v_job
  FROM app.repository_object_copy_jobs job
  JOIN app.repository_object_copy_estimates estimate
    ON estimate.organization_id = job.organization_id AND estimate.id = job.estimate_id
  JOIN app.repository_object_sources source
    ON source.organization_id = job.organization_id
   AND source.dataset_id = job.source_dataset_id
  JOIN app.user_dataset_connections connection
    ON connection.organization_id = source.organization_id
   AND connection.id = source.connection_id
   AND connection.owner_user_id = source.created_by
  WHERE job.id = p_job_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint,
      NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.connection_status <> 'verified'
    OR v_job.current_target_revision <> v_job.connection_target_revision
    OR (v_job.credential_mode <> 'workload_identity'
      AND (v_job.credential_revision <= 0 OR v_job.secret_arn IS NULL))
  THEN
    UPDATE app.repository_object_copy_jobs
    SET state = 'failed', error_code = 'source_connection_unavailable',
        worker_token = NULL, lease_expires_at = NULL,
        last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.repository_object_copy_jobs
    SET state = 'failed', error_code = 'retry_exhausted',
        worker_token = NULL, lease_expires_at = NULL,
        last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSE
    UPDATE app.repository_object_copy_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now, attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id
    RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  IF claim_status <> 'claimed' THEN
    RETURN QUERY SELECT claim_status, v_job.id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint,
      NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.organization_id,
    v_job.project_id, v_job.source_dataset_id, v_job.source_owner_user_id,
    v_job.connection_id, v_job.connection_target_revision,
    v_job.credential_revision, v_job.credential_mode, v_job.role_arn,
    v_job.secret_arn, v_job.bucket_name, v_job.region_name,
    v_job.source_object_key, v_job.provider_version_id, v_job.etag,
    v_job.provider_checksum_sha256, v_job.output_format,
    v_job.output_content_type, v_job.maximum_output_bytes,
    v_job.destination_dataset_id, v_job.destination_bucket,
    format(
      'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/source.%s',
      v_job.organization_id, v_job.project_id, v_job.destination_dataset_id, v_job.id,
      CASE v_job.output_format
        WHEN 'geojson' THEN 'geojson' WHEN 'csv' THEN 'csv'
        WHEN 'shapefile' THEN 'zip' WHEN 'geopackage' THEN 'gpkg'
        WHEN 'geoparquet' THEN 'parquet' WHEN 'cog' THEN 'tif'
        WHEN 'pmtiles' THEN 'pmtiles' WHEN 'png' THEN 'png'
        WHEN 'jpeg' THEN 'jpg' WHEN 'pdf' THEN 'pdf' WHEN 'odt' THEN 'odt'
        WHEN 'docx' THEN 'docx'
      END
    ), v_job.request_checksum_sha256, v_job.attribution, v_job.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job app.repository_object_copy_jobs%ROWTYPE;
  v_estimate app.repository_object_copy_estimates%ROWTYPE;
  v_object_id uuid;
  v_version_id uuid := gen_random_uuid();
  v_processing_job_id uuid := gen_random_uuid();
  v_expected_key text;
  v_filename text;
BEGIN
  SELECT * INTO v_job FROM app.repository_object_copy_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
  SELECT * INTO v_estimate FROM app.repository_object_copy_estimates
  WHERE organization_id = v_job.organization_id AND id = v_job.estimate_id;
  v_filename := 'source.' || CASE v_estimate.output_format::text
    WHEN 'geojson' THEN 'geojson' WHEN 'csv' THEN 'csv'
    WHEN 'shapefile' THEN 'zip' WHEN 'geopackage' THEN 'gpkg'
    WHEN 'geoparquet' THEN 'parquet' WHEN 'cog' THEN 'tif'
    WHEN 'pmtiles' THEN 'pmtiles' WHEN 'png' THEN 'png'
    WHEN 'jpeg' THEN 'jpg' WHEN 'pdf' THEN 'pdf' WHEN 'odt' THEN 'odt'
        WHEN 'docx' THEN 'docx'
  END;
  v_expected_key := format(
    'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
    v_job.organization_id, v_job.project_id, v_job.destination_dataset_id,
    v_job.id, v_filename
  );
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192
    OR (p_artifact->>'role') <> 'original'
    OR (p_artifact->>'bucket') <> v_job.destination_bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'s3_version_id') IN ('', 'null')
    OR char_length(p_artifact->>'s3_version_id') > 1024
    OR (p_artifact->>'etag') !~ '^[A-Fa-f0-9]{16,128}$'
    OR (p_artifact->>'content_type') <> v_estimate.output_content_type
    OR (p_artifact->>'size_bytes')::bigint <> v_estimate.maximum_output_bytes
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid repository copy artifact'; END IF;
  v_object_id := (p_artifact->>'id')::uuid;
  INSERT INTO app.data_objects
    (id, organization_id, dataset_id, role, bucket, object_key,
     s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
  VALUES
    (v_object_id, v_job.organization_id, v_job.destination_dataset_id,
     'original', p_artifact->>'bucket', p_artifact->>'object_key',
     p_artifact->>'s3_version_id', lower(p_artifact->>'etag'),
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', v_job.created_by);
  INSERT INTO app.upload_intents
    (id, organization_id, project_id, dataset_id, created_by,
     original_filename, content_type, expected_size_bytes, expected_sha256,
     bucket, object_key, state, expires_at, completed_at, completed_object_id)
  VALUES
    (v_job.id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_job.created_by, v_filename,
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', p_artifact->>'bucket',
     p_artifact->>'object_key', 'completed', clock_timestamp() + interval '1 day',
     clock_timestamp(), v_object_id);
  INSERT INTO app.dataset_versions
    (id, organization_id, dataset_id, version_number, parent_version_id,
     original_object_id, state, change_message, created_by)
  VALUES
    (v_version_id, v_job.organization_id, v_job.destination_dataset_id, 1, NULL,
     v_object_id, 'queued', 'Protected copy of exact repository object version',
     v_job.created_by);
  UPDATE app.datasets
  SET status = 'processing', current_version_id = v_version_id,
      updated_by = v_job.created_by, updated_at = clock_timestamp()
  WHERE organization_id = v_job.organization_id
    AND id = v_job.destination_dataset_id AND status = 'draft'
    AND current_version_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'repository copy destination changed'; END IF;
  INSERT INTO app.processing_jobs
    (id, organization_id, project_id, dataset_id, dataset_version_id,
     job_type, parameters, created_by)
  VALUES
    (v_processing_job_id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_version_id, 'dataset.ingest',
     jsonb_build_object(
       'upload_id', v_job.id, 'object_id', v_object_id,
       's3_version_id', p_artifact->>'s3_version_id',
       'repository_object_copy_job_id', v_job.id
     ), v_job.created_by);
  INSERT INTO app.dataset_version_repository_object_lineage
    (organization_id, destination_dataset_id, destination_dataset_version_id,
     source_dataset_id, copy_job_id, retrieved_at)
  VALUES
    (v_job.organization_id, v_job.destination_dataset_id, v_version_id,
     v_job.source_dataset_id, v_job.id, clock_timestamp());
  UPDATE app.repository_object_copy_jobs
  SET state = 'completed', output_object_id = v_object_id,
      output_dataset_version_id = v_version_id, error_code = NULL,
      worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.repository.copy.completed', 'dataset', v_job.destination_dataset_id,
     v_job.request_id, jsonb_build_object(
       'copy_job_id', v_job.id, 'source_dataset_id', v_job.source_dataset_id,
       'destination_dataset_version_id', v_version_id,
       'output_checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

COMMIT;
