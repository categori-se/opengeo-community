BEGIN;
-- Extend the exact request validator without changing compiler policy or legacy seals.
DO $$
DECLARE definition text; anchor text := '  IF v_project.id IS NULL'; addition text := $body$
  IF NEW.request->>'schemaVersion' = 'opengeo.observable-build-request.2.0.0' THEN
    IF NEW.purpose <> 'preview' OR NOT EXISTS (
      SELECT 1 FROM app.publication_artifact_inputs inputs
      WHERE inputs.organization_id = NEW.organization_id
        AND inputs.source_project_id = NEW.source_project_id
        AND inputs.source_revision_id = NEW.source_revision_id
        AND inputs.manifest_checksum_sha256 = NEW.request->>'artifactInputsChecksumSha256'
    ) THEN
      RAISE EXCEPTION 'publication Artifact build requires exact private preview inputs';
    END IF;
    v_expected := v_expected || jsonb_build_object(
      'schemaVersion', 'opengeo.observable-build-request.2.0.0',
      'artifactInputsChecksumSha256', NEW.request->>'artifactInputsChecksumSha256'
    );
  END IF;
$body$;
BEGIN
  definition := pg_get_functiondef('app.enforce_observable_build_job_insert()'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Observable request validation';
  END IF;
  EXECUTE replace(definition,anchor,addition || anchor);
END;
$$;

CREATE OR REPLACE FUNCTION app.require_publication_artifact_staging() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE v_refs jsonb;
BEGIN
  PERFORM 1 FROM app.observable_source_projects
    WHERE organization_id=NEW.organization_id AND id=NEW.source_project_id FOR SHARE;
  IF NEW.request->>'schemaVersion' = 'opengeo.observable-build-request.2.0.0' THEN
    -- The exact request validator checks the immutable input snapshot and preview purpose.
    RETURN NEW;
  END IF;
  SELECT references_json INTO v_refs FROM app.publication_artifact_reference_sets
    WHERE organization_id=NEW.organization_id AND source_project_id=NEW.source_project_id
    ORDER BY revision DESC LIMIT 1;
  IF jsonb_array_length(v_refs)>0 THEN
    RAISE EXCEPTION 'publication_artifact_staging_unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Only the trusted coordinator may obtain the actor envelope for its live lease.
-- This does not authorize storage access; the API rechecks actor and source permissions.
CREATE FUNCTION app.read_observable_artifact_lease(p_job uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_build_object('organizationId',job.organization_id,'userId',job.created_by,
    'projectId',job.project_id,'sourceProjectId',job.source_project_id,
    'inputId',inputs.id,'manifest',inputs.manifest)
  INTO v_result FROM app.observable_build_jobs job
  JOIN app.publication_artifact_inputs inputs ON inputs.organization_id=job.organization_id
    AND inputs.source_project_id=job.source_project_id AND inputs.source_revision_id=job.source_revision_id
    AND inputs.manifest_checksum_sha256=job.request->>'artifactInputsChecksumSha256'
  WHERE job.id=p_job AND job.coordinator_token=p_token AND p_token IS NOT NULL
    AND job.state='running' AND job.lease_expires_at>clock_timestamp()
    AND job.purpose='preview' AND job.request->>'schemaVersion'='opengeo.observable-build-request.2.0.0'
  FOR SHARE OF job;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'publication Artifact lease unavailable' USING ERRCODE='23514';
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION app.read_observable_artifact_lease(uuid,uuid)
  FROM PUBLIC,opengeo_runtime,opengeo_worker;
GRANT EXECUTE ON FUNCTION app.read_observable_artifact_lease(uuid,uuid)
  TO opengeo_observable_coordinator;

-- Require an unexpired Artifact lease and the complete input counts in its result seal.
DO $$
DECLARE definition text; anchor text := '  IF p_result IS NULL'; addition text := $body$
  IF v_job.request->>'schemaVersion' = 'opengeo.observable-build-request.2.0.0' THEN
    IF p_result#>>'{validationReport,inputFileCount}' IS DISTINCT FROM (
      jsonb_array_length(v_manifest->'files') +
      coalesce(jsonb_array_length(v_manifest->'dataAttachments'),0) +
      jsonb_array_length(app.read_observable_artifact_lease(p_job_id,p_coordinator_token)#>'{manifest,artifacts}')
    )::text OR p_result#>>'{validationReport,inputBytes}' IS DISTINCT FROM (
      (SELECT coalesce(sum((file->>'sizeBytes')::bigint),0)
         FROM jsonb_array_elements((v_manifest->'files') || coalesce(v_manifest->'dataAttachments','[]'::jsonb)) file) +
      (SELECT sum((pin#>>'{output,sizeBytes}')::bigint)
         FROM jsonb_array_elements(app.read_observable_artifact_lease(p_job_id,p_coordinator_token)#>'{manifest,artifacts}') pin)
    )::text THEN
      RAISE EXCEPTION 'publication Artifact result does not cover exact input snapshot';
    END IF;
  END IF;
$body$;
BEGIN
  definition := pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Observable result validation';
  END IF;
  EXECUTE replace(definition,anchor,addition || anchor);
END;
$$;

CREATE FUNCTION app.lock_observable_artifact_lease(p_org uuid,p_user uuid,p_job uuid,p_token uuid)
RETURNS TABLE(project_id uuid,source_project_id uuid,input_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
  SELECT job.project_id,job.source_project_id,inputs.id
  FROM app.observable_build_jobs job
  JOIN app.publication_artifact_inputs inputs ON inputs.organization_id=job.organization_id
    AND inputs.source_project_id=job.source_project_id AND inputs.source_revision_id=job.source_revision_id
    AND inputs.manifest_checksum_sha256=job.request->>'artifactInputsChecksumSha256'
  WHERE p_org=app.current_organization_id() AND p_user=app.current_user_id()
    AND job.organization_id=p_org AND job.created_by=p_user AND job.id=p_job
    AND job.coordinator_token=p_token AND job.state='running'
    AND job.lease_expires_at>clock_timestamp() AND job.purpose='preview'
    AND job.request->>'schemaVersion'='opengeo.observable-build-request.2.0.0'
  FOR SHARE OF job;
$$;
REVOKE ALL ON FUNCTION app.lock_observable_artifact_lease(uuid,uuid,uuid,uuid)
  FROM PUBLIC,opengeo_worker,opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.lock_observable_artifact_lease(uuid,uuid,uuid,uuid) TO opengeo_runtime;
COMMIT;
