BEGIN;

-- Saving or selecting an optional repository must not disclose publication
-- source. Retain old links, receipts and queued work; explicit source-sync
-- requests keep their existing authorization and fenced outbox.
DROP TRIGGER observable_revision_github_outbox ON app.observable_source_revisions;
DROP TRIGGER observable_connection_github_outbox ON app.observable_github_links;

-- Canonical publication files stay in private OpenGeo S3. Historical dispatches
-- retain their exact GitHub source receipts; only newly claimed jobs use S3.
ALTER TABLE app.observable_github_dispatches
  ADD COLUMN source_mode text NOT NULL DEFAULT 'github'
    CHECK (source_mode IN ('github', 'opengeo'));

-- Replace only the old source-link FK and commit-required stage check. Keep
-- tenant/project/source and operator connection identities independently bound.
DO $$
DECLARE item record; removed_fk integer := 0; removed_check integer := 0;
BEGIN
  FOR item IN SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app.observable_github_dispatches'::regclass AND contype = 'f'
      AND confrelid = 'app.observable_github_links'::regclass
  LOOP
    EXECUTE format('ALTER TABLE app.observable_github_dispatches DROP CONSTRAINT %I', item.conname);
    removed_fk := removed_fk + 1;
  END LOOP;
  FOR item IN SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app.observable_github_dispatches'::regclass AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%source_commit IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE app.observable_github_dispatches DROP CONSTRAINT %I', item.conname);
    removed_check := removed_check + 1;
  END LOOP;
  IF removed_fk <> 1 OR removed_check <> 1 THEN
    RAISE EXCEPTION 'Unexpected GitHub dispatch source constraints';
  END IF;
END;
$$;

ALTER TABLE app.observable_github_dispatches
  ADD CONSTRAINT github_dispatch_source_identity FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  ADD CONSTRAINT github_dispatch_connection_identity FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.github_publication_connections (organization_id, id),
  ADD CONSTRAINT github_dispatch_source_policy CHECK (
    (source_mode = 'github' AND (stage = 'syncing' OR source_commit IS NOT NULL OR stage = 'failed'))
    OR (source_mode = 'opengeo' AND source_commit IS NULL AND stage <> 'syncing')
  );

CREATE OR REPLACE FUNCTION app.claim_github_build_dispatch(p_job uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  job app.observable_build_jobs%ROWTYPE;
  connection app.github_publication_connections%ROWTYPE;
  connection_ids uuid[];
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
      AND (member.role = 'admin' OR app.background_project_role(project.organization_id, project.id, member.user_id)::text IN ('owner', 'editor'))
  ) THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  SELECT * INTO dispatch FROM app.observable_github_dispatches WHERE build_job_id = p_job FOR UPDATE;
  IF FOUND THEN
    SELECT c.* INTO connection FROM app.github_publication_connections c
    WHERE c.organization_id = job.organization_id AND c.id = dispatch.connection_id
      AND c.enabled AND c.build_workflow_id IS NOT NULL AND c.runtime_sha IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
    IF dispatch.source_mode = 'github' AND NOT EXISTS (
      SELECT 1 FROM app.observable_github_links link
      WHERE link.organization_id = job.organization_id AND link.project_id = job.project_id
        AND link.source_project_id = job.source_project_id AND link.connection_id = connection.id
    ) THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  ELSE
    IF job.state <> 'pending' THEN RETURN jsonb_build_object('status', 'finished'); END IF;
    -- A build grant configures the trusted compiler repository, not publication
    -- source retention. Ambiguous account configuration fails closed.
    SELECT array_agg(candidate.id) INTO connection_ids FROM (
      SELECT c.id FROM app.github_publication_connections c
      WHERE c.organization_id = job.organization_id AND c.enabled
        AND c.build_workflow_id IS NOT NULL AND c.runtime_sha IS NOT NULL
      ORDER BY c.id LIMIT 2
    ) candidate;
    IF coalesce(cardinality(connection_ids), 0) <> 1
    THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
    SELECT c.* INTO connection FROM app.github_publication_connections c
    WHERE c.organization_id = job.organization_id AND c.id = connection_ids[1] AND c.enabled
      AND c.build_workflow_id IS NOT NULL AND c.runtime_sha IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
    INSERT INTO app.observable_github_dispatches
      (build_job_id, organization_id, project_id, source_project_id, connection_id,
       workflow_id, workflow_sha, source_mode, stage)
    VALUES (job.id, job.organization_id, job.project_id, job.source_project_id, connection.id,
      connection.build_workflow_id, connection.runtime_sha, 'opengeo', 'ready')
    RETURNING * INTO dispatch;
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
    'source_mode', dispatch.source_mode, 'source_commit', dispatch.source_commit, 'stage', dispatch.stage,
    'run_id', dispatch.run_id, 'run_attempt', dispatch.run_attempt,
    'dispatch_started_at', dispatch.dispatch_started_at);
END;
$$;

CREATE OR REPLACE FUNCTION app.advance_github_build_dispatch(
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
  IF p_stage = 'ready' AND (d.source_mode <> 'github' OR NOT EXISTS (
    SELECT 1 FROM app.observable_github_revision_receipts receipt
    JOIN app.observable_build_jobs job ON job.source_revision_id = receipt.source_revision_id
      AND job.organization_id = receipt.organization_id
    WHERE job.id = p_job AND receipt.connection_id = d.connection_id AND receipt.commit_sha = p_commit
  )) THEN RAISE EXCEPTION 'verified GitHub revision receipt required'; END IF;
  IF p_stage = 'dispatching' AND (
    NOT EXISTS (SELECT 1 FROM app.observable_build_jobs WHERE id = p_job AND state = 'pending')
    OR NOT EXISTS (SELECT 1 FROM app.github_publication_connections WHERE organization_id = d.organization_id AND id = d.connection_id AND enabled
      AND build_workflow_id = d.workflow_id AND runtime_sha = d.workflow_sha)
    OR NOT EXISTS (
      SELECT 1 FROM app.observable_build_jobs job
      JOIN app.projects project ON project.id = job.project_id AND project.organization_id = job.organization_id
      JOIN app.organizations organization ON organization.id = job.organization_id AND organization.status = 'active'
      JOIN app.organization_memberships member ON member.organization_id = job.organization_id AND member.user_id = job.created_by
      WHERE job.id = p_job AND project.status = 'active'
        AND (member.role = 'admin' OR app.background_project_role(project.organization_id, project.id, member.user_id)::text IN ('owner', 'editor'))
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

-- CREATE OR REPLACE preserves the existing function identities and grants.
-- No source objects, links, receipts, job inputs or publication releases change.
COMMENT ON COLUMN app.observable_github_dispatches.source_mode IS
  'opengeo: compile canonical private S3 input; github: historical explicitly mirrored source receipt. New claims use opengeo without creating repository source links.';
COMMIT;
