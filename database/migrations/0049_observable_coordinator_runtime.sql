BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_observable_coordinator') THEN
    CREATE ROLE opengeo_observable_coordinator
      LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS
      CONNECTION LIMIT 20;
  END IF;
END;
$role$;

CREATE FUNCTION app.claim_observable_build_runtime(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  build_job_id uuid,
  organization_id uuid,
  project_id uuid,
  source_project_id uuid,
  source_revision_id uuid,
  source_revision_number bigint,
  purpose text,
  request jsonb,
  request_checksum_sha256 text,
  input_manifest jsonb,
  input_manifest_checksum_sha256 text,
  output_prefix text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_revision app.observable_source_revisions%ROWTYPE;
  v_failed boolean;
BEGIN
  IF p_job_id IS NULL OR p_coordinator_token IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900
  THEN
    RAISE EXCEPTION 'invalid Observable build runtime claim';
  END IF;
  SELECT * INTO v_job
  FROM app.observable_build_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF FOUND
    AND v_job.state = 'running'
    AND v_job.lease_expires_at <= clock_timestamp()
    AND v_job.attempt_count >= 3
  THEN
    SELECT * INTO v_revision
    FROM app.observable_source_revisions revision
    WHERE revision.organization_id = v_job.organization_id
      AND revision.source_project_id = v_job.source_project_id
      AND revision.id = v_job.source_revision_id;
    v_failed := app.fail_observable_build(
      v_job.id, v_job.coordinator_token, 'build_retry_exhausted'
    );
    IF NOT v_failed THEN
      RAISE EXCEPTION 'expired Observable build lease could not be sealed';
    END IF;
    RETURN QUERY SELECT
      'already_failed', v_job.id, v_job.organization_id, v_job.project_id,
      v_job.source_project_id, v_job.source_revision_id,
      v_job.source_revision_number, v_job.purpose::text, v_job.request,
      v_job.request_checksum_sha256,
      v_revision.manifest, v_revision.manifest_checksum_sha256,
      v_job.output_prefix, v_job.attempt_count;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT * FROM app.claim_observable_build(
      p_job_id, p_coordinator_token, p_lease_seconds
    );
END;
$$;

GRANT USAGE ON SCHEMA app TO opengeo_observable_coordinator;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM opengeo_observable_coordinator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM opengeo_observable_coordinator;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM opengeo_observable_coordinator;

REVOKE EXECUTE ON FUNCTION
  app.claim_observable_build_runtime(uuid, uuid, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker;

GRANT EXECUTE ON FUNCTION
  app.claim_observable_build_runtime(uuid, uuid, integer),
  app.heartbeat_observable_build(uuid, uuid, integer),
  app.complete_observable_build(uuid, uuid, jsonb),
  app.fail_observable_build(uuid, uuid, text),
  app.release_observable_build(uuid, uuid, text, integer)
TO opengeo_observable_coordinator;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM opengeo_observable_coordinator;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON TABLES FROM opengeo_observable_coordinator;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON SEQUENCES FROM opengeo_observable_coordinator;

COMMENT ON ROLE opengeo_observable_coordinator IS
  'Function-only trusted Observable coordinator. It has no table, tenant API, preview-capability, publication, or GIS worker authority.';

COMMENT ON FUNCTION app.claim_observable_build_runtime(uuid, uuid, integer) IS
  'Trusted host claim boundary. An expired third lease is sealed failed before another compiler execution can start.';

COMMIT;
