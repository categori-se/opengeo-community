BEGIN;
-- Match PROJECT_DATASETS_MANAGE: account admins or project owners/editors.
CREATE OR REPLACE FUNCTION app.enforce_external_source_discovery_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_expected_checksum text;
BEGIN
  IF NEW.created_by <> app.current_user_id() OR NEW.state <> 'queued'
    OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.worker_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.started_at IS NOT NULL
    OR NEW.finished_at IS NOT NULL
  THEN RAISE EXCEPTION 'source discovery creator or initial state mismatch'; END IF;
  IF COALESCE(
    app.effective_project_role(NEW.project_id, NEW.created_by)::text,
    ''
  ) NOT IN ('owner', 'editor') AND NOT EXISTS (
    SELECT 1 FROM app.organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_id = NEW.created_by AND membership.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'source discovery requires project edit access';
  END IF;
  v_expected_checksum := encode(public.digest(convert_to(
    NEW.source_type || chr(31) || NEW.discovery_kind || chr(31)
      || NEW.service_url || chr(31) || COALESCE(NEW.collection_ref, ''),
    'UTF8'
  ), 'sha256'), 'hex');
  IF NEW.request_checksum_sha256 <> v_expected_checksum THEN
    RAISE EXCEPTION 'source discovery checksum mismatch';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:source-discovery-quota:' || NEW.organization_id::text, 0
  ));
  IF (SELECT count(*) FROM app.external_source_discovery_jobs job
      WHERE job.organization_id = NEW.organization_id
        AND job.state IN ('queued', 'running')) >= 4
    OR (SELECT count(*) FROM app.external_source_discovery_jobs job
        WHERE job.organization_id = NEW.organization_id
          AND job.project_id = NEW.project_id
          AND job.created_by = NEW.created_by
          AND job.created_at >= clock_timestamp() - interval '24 hours') >= 64
  THEN RAISE EXCEPTION 'source discovery quota exceeded'; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION app.cancel_external_source_discovery(
  p_organization_id uuid, p_project_id uuid, p_job_id uuid,
  p_actor_user_id uuid, p_request_id text
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
    OR (COALESCE(
      app.effective_project_role(p_project_id, p_actor_user_id)::text,
      ''
    ) NOT IN ('owner', 'editor') AND NOT EXISTS (
      SELECT 1 FROM app.organization_memberships membership
      WHERE membership.organization_id = p_organization_id
        AND membership.user_id = p_actor_user_id AND membership.role = 'admin'
    ))
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.external_source_discovery_jobs
  SET state = 'cancelled', error_code = 'cancelled_by_user',
      finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND id = p_job_id AND state = 'queued';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'dataset.source.discovery.cancelled', 'project', p_project_id,
     p_request_id, jsonb_build_object('discovery_job_id', p_job_id));
  RETURN true;
END;
$$;


ALTER POLICY external_source_discovery_jobs_select ON app.external_source_discovery_jobs
  USING (organization_id = app.current_organization_id() AND (
    app.effective_project_role(project_id, app.current_user_id()) IS NOT NULL
    OR EXISTS (SELECT 1 FROM app.organization_memberships membership
      WHERE membership.organization_id = external_source_discovery_jobs.organization_id
        AND membership.user_id = app.current_user_id() AND membership.role = 'admin')
  ));
ALTER POLICY external_source_discovery_jobs_insert ON app.external_source_discovery_jobs
  WITH CHECK (organization_id = app.current_organization_id()
    AND created_by = app.current_user_id() AND (
      COALESCE(app.effective_project_role(project_id, app.current_user_id())::text, '')
        IN ('owner', 'editor')
      OR EXISTS (SELECT 1 FROM app.organization_memberships membership
        WHERE membership.organization_id = external_source_discovery_jobs.organization_id
          AND membership.user_id = app.current_user_id() AND membership.role = 'admin')
  ));
COMMIT;
