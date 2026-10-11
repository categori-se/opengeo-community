BEGIN;

ALTER TABLE app.github_publication_connections
  ADD COLUMN build_workflow_id bigint CHECK (build_workflow_id > 0),
  ADD COLUMN runtime_sha text CHECK (runtime_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT github_runtime_configuration_pair CHECK (
    (build_workflow_id IS NULL) = (runtime_sha IS NULL)
  );

CREATE TABLE app.observable_github_dispatches (
  build_job_id uuid PRIMARY KEY REFERENCES app.observable_build_jobs(id),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  workflow_id bigint NOT NULL CHECK (workflow_id > 0),
  workflow_sha text NOT NULL CHECK (workflow_sha ~ '^[0-9a-f]{40}$'),
  source_commit text CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  stage text NOT NULL DEFAULT 'syncing' CHECK (stage IN ('syncing', 'ready', 'dispatching', 'dispatched', 'completed', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  run_id bigint CHECK (run_id > 0),
  run_attempt integer CHECK (run_attempt > 0),
  run_status text CHECK (run_status IN ('queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending')),
  run_conclusion text CHECK (run_conclusion IN ('success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure')),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, source_project_id, connection_id)
    REFERENCES app.observable_github_links (organization_id, project_id, source_project_id, connection_id),
  CHECK (stage = 'syncing' OR source_commit IS NOT NULL OR stage = 'failed'),
  CHECK (stage NOT IN ('dispatched', 'completed') OR (run_id IS NOT NULL AND run_attempt IS NOT NULL)),
  CHECK (stage NOT IN ('dispatching', 'dispatched', 'completed') OR dispatch_started_at IS NOT NULL),
  CHECK (stage <> 'completed' OR (run_status = 'completed' AND run_conclusion = 'success'))
);

ALTER TABLE app.observable_github_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_github_dispatches_tenant ON app.observable_github_dispatches
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT ON app.observable_github_dispatches TO opengeo_runtime;
REVOKE ALL ON app.observable_github_dispatches FROM PUBLIC, opengeo_worker,
  opengeo_connector, opengeo_observable_coordinator;

-- This queue entry point resolves an ID already staged by an authenticated
-- Studio build request. It never trusts tenant/actor identities in SQS payloads.
CREATE FUNCTION app.claim_github_build_dispatch(p_job uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  job app.observable_build_jobs%ROWTYPE;
  connection app.github_publication_connections%ROWTYPE;
  dispatch app.observable_github_dispatches%ROWTYPE;
BEGIN
  IF p_job IS NULL OR p_token IS NULL THEN RAISE EXCEPTION 'invalid GitHub dispatch claim'; END IF;
  SELECT * INTO job FROM app.observable_build_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.projects project
    JOIN app.organizations organization ON organization.id = project.organization_id AND organization.status = 'active'
    JOIN app.organization_memberships member ON member.organization_id = project.organization_id AND member.user_id = job.created_by
    WHERE project.id = job.project_id AND project.organization_id = job.organization_id AND project.status = 'active'
      AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'editor'))
  ) THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  SELECT c.* INTO connection FROM app.github_publication_connections c
  JOIN app.observable_github_links link ON link.organization_id = c.organization_id AND link.connection_id = c.id
  WHERE link.organization_id = job.organization_id AND link.project_id = job.project_id
    AND link.source_project_id = job.source_project_id AND c.enabled AND c.build_workflow_id IS NOT NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  SELECT * INTO dispatch FROM app.observable_github_dispatches WHERE build_job_id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    IF job.state <> 'pending' THEN RETURN jsonb_build_object('status', 'finished'); END IF;
    INSERT INTO app.observable_github_dispatches
      (build_job_id, organization_id, project_id, source_project_id, connection_id, workflow_id, workflow_sha)
    VALUES (job.id, job.organization_id, job.project_id, job.source_project_id, connection.id,
      connection.build_workflow_id, connection.runtime_sha) RETURNING * INTO dispatch;
  END IF;
  IF dispatch.stage IN ('completed', 'failed') THEN RETURN jsonb_build_object('status', dispatch.stage); END IF;
  IF dispatch.lease_expires_at > clock_timestamp() THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  IF dispatch.workflow_id <> connection.build_workflow_id OR dispatch.workflow_sha <> connection.runtime_sha THEN
    RETURN jsonb_build_object('status', 'configuration_changed');
  END IF;
  -- The Lambda is limited to 900 seconds; an abandoned claim cannot be taken
  -- over while that invocation can still run. Normal returns release immediately.
  UPDATE app.observable_github_dispatches SET lease_token = p_token,
    lease_expires_at = clock_timestamp() + interval '1000 seconds', updated_at = clock_timestamp()
    WHERE build_job_id = p_job;
  RETURN jsonb_build_object('status', 'claimed', 'build_job_id', job.id,
    'organization_id', job.organization_id, 'project_id', job.project_id, 'user_id', job.created_by,
    'source_project_id', job.source_project_id, 'source_revision_id', job.source_revision_id,
    'connection_id', connection.id, 'installation_id', connection.installation_id,
    'repository_id', connection.repository_id, 'repository', connection.repository,
    'workflow_id', dispatch.workflow_id, 'workflow_sha', dispatch.workflow_sha,
    'source_commit', dispatch.source_commit, 'stage', dispatch.stage,
    'run_id', dispatch.run_id, 'run_attempt', dispatch.run_attempt,
    'dispatch_started_at', dispatch.dispatch_started_at);
END;
$$;

CREATE FUNCTION app.advance_github_build_dispatch(
  p_job uuid, p_token uuid, p_stage text, p_commit text DEFAULT NULL,
  p_run bigint DEFAULT NULL, p_attempt integer DEFAULT NULL, p_error text DEFAULT NULL,
  p_run_status text DEFAULT NULL, p_conclusion text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE d app.observable_github_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO d FROM app.observable_github_dispatches WHERE build_job_id = p_job FOR UPDATE;
  IF NOT FOUND OR d.lease_token IS DISTINCT FROM p_token OR d.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  IF p_stage = 'release' THEN
    UPDATE app.observable_github_dispatches SET lease_token = NULL, lease_expires_at = NULL,
      updated_at = clock_timestamp() WHERE build_job_id = p_job;
    RETURN true;
  END IF;
  IF NOT ((d.stage = 'syncing' AND p_stage = 'ready') OR (d.stage = 'ready' AND p_stage = 'dispatching')
      OR (d.stage = 'dispatching' AND p_stage = 'dispatched')
      OR (d.stage = 'dispatched' AND p_stage IN ('dispatched', 'completed'))
      OR (d.stage IN ('syncing','ready','dispatching','dispatched') AND p_stage = 'failed')) THEN
    RAISE EXCEPTION 'invalid GitHub dispatch transition';
  END IF;
  IF p_stage = 'ready' AND NOT EXISTS (
    SELECT 1 FROM app.observable_github_revision_receipts receipt
    JOIN app.observable_build_jobs job ON job.source_revision_id = receipt.source_revision_id
      AND job.organization_id = receipt.organization_id
    WHERE job.id = p_job AND receipt.connection_id = d.connection_id AND receipt.commit_sha = p_commit
  ) THEN RAISE EXCEPTION 'verified GitHub revision receipt required'; END IF;
  IF p_stage = 'dispatching' AND (
    NOT EXISTS (SELECT 1 FROM app.observable_build_jobs WHERE id = p_job AND state = 'pending')
    OR NOT EXISTS (SELECT 1 FROM app.github_publication_connections WHERE id = d.connection_id AND enabled
      AND build_workflow_id = d.workflow_id AND runtime_sha = d.workflow_sha)
    OR NOT EXISTS (
      SELECT 1 FROM app.observable_build_jobs job
      JOIN app.projects project ON project.id = job.project_id AND project.organization_id = job.organization_id
      JOIN app.organizations organization ON organization.id = job.organization_id AND organization.status = 'active'
      JOIN app.organization_memberships member ON member.organization_id = job.organization_id AND member.user_id = job.created_by
      WHERE job.id = p_job AND project.status = 'active'
        AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'editor'))
    )
  ) THEN RETURN false; END IF;
  IF d.run_id IS NOT NULL AND (p_run IS NOT NULL AND p_run <> d.run_id
      OR p_attempt IS NOT NULL AND p_attempt <> d.run_attempt) THEN
    RAISE EXCEPTION 'GitHub run identity is immutable';
  END IF;
  UPDATE app.observable_github_dispatches SET stage = p_stage,
    source_commit = CASE WHEN p_stage = 'ready' THEN p_commit ELSE source_commit END,
    dispatch_started_at = CASE WHEN p_stage = 'dispatching' THEN clock_timestamp() ELSE dispatch_started_at END,
    run_id = coalesce(run_id, p_run), run_attempt = coalesce(run_attempt, p_attempt),
    run_status = coalesce(p_run_status, run_status), run_conclusion = coalesce(p_conclusion, run_conclusion),
    error_code = p_error, updated_at = clock_timestamp()
  WHERE build_job_id = p_job;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_github_build_dispatch(uuid, uuid),
  app.advance_github_build_dispatch(uuid, uuid, text, text, bigint, integer, text, text, text)
FROM PUBLIC, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.claim_github_build_dispatch(uuid, uuid),
  app.advance_github_build_dispatch(uuid, uuid, text, text, bigint, integer, text, text, text)
TO opengeo_runtime;
COMMIT;
