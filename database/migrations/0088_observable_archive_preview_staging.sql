BEGIN;

-- Resolve only pins belonging to the caller's live build lease. Storage
-- coordinates never enter the credential-free compiler invocation.
CREATE FUNCTION app.resolve_observable_build_data(p_job_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_manifest jsonb;
  v_pins jsonb;
  v_result jsonb;
  v_prior_org text := current_setting('app.organization_id', true);
  v_prior_user text := current_setting('app.user_id', true);
BEGIN
  SELECT * INTO v_job FROM app.observable_build_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v_job.state <> 'running'
    OR v_job.coordinator_token IS DISTINCT FROM p_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'archive resolution requires a live build lease' USING ERRCODE = '23514';
  END IF;
  SELECT manifest INTO v_manifest FROM app.observable_source_revisions
  WHERE organization_id = v_job.organization_id AND source_project_id = v_job.source_project_id
    AND id = v_job.source_revision_id;
  IF v_manifest->>'schemaVersion' = 'opengeo.observable-source-revision.1.0.0' THEN
    RETURN '[]'::jsonb;
  END IF;
  IF v_job.purpose <> 'preview' THEN
    RAISE EXCEPTION 'archive publication rights are not implemented' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('app.organization_id', v_job.organization_id::text, true);
  PERFORM set_config('app.user_id', v_job.created_by::text, true);
  v_pins := app.validate_observable_revision_data_bindings(
    v_job.organization_id, v_job.project_id, v_job.source_project_id, v_manifest
  );
  SELECT jsonb_agg(pin.value || jsonb_build_object(
      'bucket', object.bucket, 'objectKey', object.object_key, 'etag', object.etag
    ) ORDER BY pin.ordinality)
  INTO v_result
  FROM jsonb_array_elements(v_pins) WITH ORDINALITY AS pin(value, ordinality)
  JOIN app.data_objects object ON object.organization_id = v_job.organization_id
    AND object.id::text = pin.value->>'dataObjectId';
  PERFORM set_config('app.organization_id', coalesce(v_prior_org, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prior_user, ''), true);
  IF jsonb_array_length(v_result) IS DISTINCT FROM jsonb_array_length(v_pins) THEN
    RAISE EXCEPTION 'archive resolution is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION app.resolve_observable_build_data(uuid, uuid)
  FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.resolve_observable_build_data(uuid, uuid)
  TO opengeo_observable_coordinator;

CREATE OR REPLACE FUNCTION app.require_observable_staging_manifest_support()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_manifest jsonb;
BEGIN
  SELECT manifest INTO v_manifest FROM app.observable_source_revisions
  WHERE organization_id = NEW.organization_id AND source_project_id = NEW.source_project_id
    AND id = NEW.source_revision_id;
  IF v_manifest->>'schemaVersion' = 'opengeo.observable-source-revision.2.0.0' THEN
    IF NEW.purpose <> 'preview' THEN
      RAISE EXCEPTION 'archive publication rights are not implemented' USING ERRCODE = '23514';
    END IF;
    PERFORM app.validate_observable_revision_data_bindings(
      NEW.organization_id, NEW.project_id, NEW.source_project_id, v_manifest
    );
  ELSIF v_manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-source-revision.1.0.0' THEN
    RAISE EXCEPTION 'unsupported source staging manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- A successful private build is not a permanent grant to its archived data.
-- Recheck when issuing the one-use link and again when exchanging it for the
-- existing short-lived preview cookie. Already issued cookies retain their TTL.
CREATE FUNCTION app.require_observable_preview_archive_access()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_build app.observable_build_jobs%ROWTYPE;
  v_manifest jsonb;
BEGIN
  SELECT * INTO v_build FROM app.observable_build_jobs
  WHERE organization_id = NEW.organization_id AND id = NEW.build_job_id;
  SELECT manifest INTO v_manifest FROM app.observable_source_revisions
  WHERE organization_id = v_build.organization_id AND id = v_build.source_revision_id;
  IF v_manifest->>'schemaVersion' = 'opengeo.observable-source-revision.2.0.0' THEN
    IF NEW.requested_by IS DISTINCT FROM app.current_user_id()
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    THEN
      RAISE EXCEPTION 'archive preview requires its current requester' USING ERRCODE = '23514';
    END IF;
    PERFORM app.validate_observable_revision_data_bindings(
      v_build.organization_id, v_build.project_id, v_build.source_project_id, v_manifest
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.require_observable_preview_archive_access()
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_observable_coordinator;
CREATE TRIGGER observable_preview_archive_access
  BEFORE INSERT OR UPDATE ON app.observable_preview_capabilities
  FOR EACH ROW EXECUTE FUNCTION app.require_observable_preview_archive_access();

CREATE OR REPLACE FUNCTION app.complete_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, public
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_file jsonb;
  v_file_count integer := 0;
  v_total_bytes bigint := 0;
  v_case_count integer;
  v_expected_bucket text;
  v_maximum_file_bytes bigint := 16777216;
  v_manifest jsonb;
BEGIN
  SELECT * INTO v_job
  FROM app.observable_build_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running'
    OR v_job.coordinator_token <> p_coordinator_token
  THEN
    RETURN false;
  END IF;
  SELECT manifest INTO v_manifest FROM app.observable_source_revisions
  WHERE organization_id = v_job.organization_id AND id = v_job.source_revision_id;
  IF v_manifest->>'schemaVersion' = 'opengeo.observable-source-revision.2.0.0' THEN
    PERFORM app.resolve_observable_build_data(p_job_id, p_coordinator_token);
    v_maximum_file_bytes := 33554432;
  END IF;
  SELECT object.bucket INTO v_expected_bucket
  FROM app.observable_source_revision_files file
  JOIN app.observable_source_objects object
    ON object.organization_id = file.organization_id
   AND object.source_project_id = file.source_project_id
   AND object.id = file.source_object_id
  WHERE file.organization_id = v_job.organization_id
    AND file.source_revision_id = v_job.source_revision_id
  ORDER BY file.position
  LIMIT 1;
  IF p_result IS NULL
    OR jsonb_typeof(p_result) <> 'object'
    OR octet_length(p_result::text) > 262144
    OR p_result->>'schemaVersion' <> 'opengeo.observable-build-result.1.0.0'
    OR p_result->>'buildJobId' <> v_job.id::text
    OR p_result->>'requestChecksumSha256' <> v_job.request_checksum_sha256
    OR p_result->>'compilerImageDigest' <> v_job.request->>'compilerImageDigest'
    OR p_result->>'inputManifestChecksumSha256'
      <> v_job.request->>'sourceManifestChecksumSha256'
    OR p_result->>'outputPrefix' <> v_job.output_prefix
    OR p_result->>'outputTreeChecksumSha256' !~ '^[0-9a-f]{64}$'
    OR p_result->'sandbox' IS DISTINCT FROM jsonb_build_object(
      'credentialMode', 'none',
      'networkPolicy', 'deny_all',
      'readOnlyInputs', true,
      'readOnlyBaseImage', true,
      'unprivilegedUser', true,
      'dockerSocket', false
    )
    OR p_result->'networkRequests' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_typeof(p_result->'validationReport') <> 'object'
    OR octet_length((p_result->'validationReport')::text) > 65536
    OR jsonb_typeof(p_result->'routeManifest') <> 'array'
    OR jsonb_array_length(p_result->'routeManifest') > 128
    OR jsonb_typeof(p_result->'outputManifest') <> 'object'
    OR jsonb_typeof(p_result->'outputManifest'->'files') <> 'array'
    OR jsonb_array_length(p_result->'outputManifest'->'files') NOT BETWEEN 1 AND 512
  THEN
    RAISE EXCEPTION 'invalid Observable build result envelope';
  END IF;

  FOR v_file IN
    SELECT value FROM jsonb_array_elements(p_result->'outputManifest'->'files')
  LOOP
    v_file_count := v_file_count + 1;
    IF NOT app.observable_output_path_is_safe(v_file->>'path')
      OR (v_file->>'contentType') NOT IN (
        'text/html', 'text/css', 'text/javascript', 'application/json',
        'text/plain', 'text/csv', 'application/geo+json',
        'image/svg+xml', 'image/png', 'image/jpeg',
        'application/octet-stream', 'application/zip'
      )
      OR (v_file->>'sizeBytes')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes
      OR (v_file->>'checksumSha256') !~ '^[0-9a-f]{64}$'
      OR v_file->>'bucket' IS DISTINCT FROM v_expected_bucket
      OR v_file->>'objectKey'
        <> v_job.output_prefix || substring(v_file->>'path' FROM 6)
      OR (v_file->>'s3VersionId') IS NULL
      OR char_length(v_file->>'s3VersionId') NOT BETWEEN 1 AND 1024
      OR (v_file->>'etag') IS NULL
      OR char_length(v_file->>'etag') NOT BETWEEN 1 AND 512
    THEN
      RAISE EXCEPTION 'invalid Observable build output file';
    END IF;
    v_total_bytes := v_total_bytes + (v_file->>'sizeBytes')::bigint;
  END LOOP;
  SELECT count(DISTINCT lower(value->>'path'))::integer INTO v_case_count
  FROM jsonb_array_elements(p_result->'outputManifest'->'files');
  IF v_file_count <> v_case_count OR v_total_bytes > 33554432 THEN
    RAISE EXCEPTION 'Observable build output exceeds file or size limits';
  END IF;

  UPDATE app.observable_build_jobs
  SET state = 'succeeded', result = p_result, error_code = NULL,
      coordinator_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_job.id;
  RETURN true;
END;
$$;

COMMIT;
