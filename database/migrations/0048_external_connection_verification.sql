BEGIN;

CREATE TYPE app.external_connection_verification_state AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_connector') THEN
    EXECUTE 'CREATE ROLE opengeo_connector LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_connector SET search_path = app, public;

ALTER TABLE app.external_connections
  DROP CONSTRAINT external_connections_initial_boundary,
  ADD CONSTRAINT external_connections_operational_boundary CHECK (
    tls_mode = 'verify_full'
    AND network_mode = 'public_internet'
    AND current_revision_number >= 1
    AND (
      (status = 'configuration_valid'
        AND last_verified_at IS NULL
        AND schema_fingerprint_sha256 IS NULL
        AND sanitized_error_code IS NULL)
      OR
      (status = 'credentials_verified'
        AND last_verified_at IS NOT NULL
        AND schema_fingerprint_sha256 IS NULL
        AND sanitized_error_code IS NULL)
      OR
      (status = 'degraded'
        AND schema_fingerprint_sha256 IS NULL
        AND sanitized_error_code IS NOT NULL)
      OR status IN ('disabled', 'revoked')
    )
  );

CREATE TABLE app.external_connection_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision_number bigint NOT NULL,
  state app.external_connection_verification_state NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  worker_token uuid,
  lease_expires_at timestamptz,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  request_id text NOT NULL,
  network_reachable boolean NOT NULL DEFAULT false,
  tls_verified boolean NOT NULL DEFAULT false,
  credentials_verified boolean NOT NULL DEFAULT false,
  postgis_verified boolean NOT NULL DEFAULT false,
  sanitized_error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id, connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id),
  CONSTRAINT external_connection_verifications_revision_positive CHECK (
    connection_revision_number > 0
  ),
  CONSTRAINT external_connection_verifications_request_bounded CHECK (
    request_id = btrim(request_id) AND char_length(request_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT external_connection_verifications_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT external_connection_verifications_error_allowlist CHECK (
    sanitized_error_code IS NULL OR sanitized_error_code IN (
      'credentials_rejected',
      'dns_resolution_failed',
      'postgis_required',
      'tls_verification_failed',
      'unsafe_network_target',
      'verification_cancelled',
      'verification_failed',
      'verification_timeout'
    )
  ),
  CONSTRAINT external_connection_verifications_result_shape CHECK (
    duration_ms IS NULL OR duration_ms BETWEEN 0 AND 20000
  ),
  CONSTRAINT external_connection_verifications_lease_shape CHECK (
    (state = 'queued'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NULL AND finished_at IS NULL
      AND sanitized_error_code IS NULL AND duration_ms IS NULL
      AND NOT network_reachable AND NOT tls_verified
      AND NOT credentials_verified AND NOT postgis_verified)
    OR
    (state = 'running'
      AND worker_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND sanitized_error_code IS NULL AND duration_ms IS NULL)
    OR
    (state = 'succeeded'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND sanitized_error_code IS NULL AND duration_ms IS NOT NULL
      AND network_reachable AND tls_verified
      AND credentials_verified AND postgis_verified)
    OR
    (state = 'failed'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND sanitized_error_code IS NOT NULL AND duration_ms IS NOT NULL)
    OR
    (state = 'cancelled'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND finished_at IS NOT NULL
      AND sanitized_error_code = 'verification_cancelled')
  )
);

CREATE UNIQUE INDEX external_connection_verifications_one_active_idx
  ON app.external_connection_verifications (organization_id, connection_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX external_connection_verifications_project_idx
  ON app.external_connection_verifications
    (organization_id, project_id, connection_id, created_at DESC);

ALTER TABLE app.external_connection_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY external_connection_verifications_tenant_isolation
  ON app.external_connection_verifications
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.request_external_connection_verification(
  p_organization_id uuid,
  p_project_id uuid,
  p_connection_id uuid,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS TABLE (verification_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_connection app.external_connections%ROWTYPE;
  v_existing uuid;
  v_verification_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL OR p_connection_id IS NULL
    OR p_actor_user_id IS NULL OR p_request_id IS NULL
    OR p_request_id <> btrim(p_request_id)
    OR char_length(p_request_id) NOT BETWEEN 1 AND 200
    OR p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR p_actor_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'invalid connection verification request';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.organization_memberships membership
    JOIN app.project_memberships project_membership
      ON project_membership.organization_id = membership.organization_id
     AND project_membership.user_id = membership.user_id
     AND project_membership.project_id = p_project_id
    JOIN app.projects project
      ON project.organization_id = project_membership.organization_id
     AND project.id = project_membership.project_id
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_actor_user_id
      AND project_membership.role = 'owner'
      AND project.status = 'active'
  ) THEN
    RAISE EXCEPTION 'connection verification requires project owner';
  END IF;

  SELECT connection.* INTO v_connection
  FROM app.external_connections connection
  WHERE connection.organization_id = p_organization_id
    AND connection.project_id = p_project_id
    AND connection.id = p_connection_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'external connection not found';
  END IF;
  IF v_connection.status IN ('disabled', 'revoked') THEN
    RAISE EXCEPTION 'external connection is not verifiable';
  END IF;

  SELECT verification.id INTO v_existing
  FROM app.external_connection_verifications verification
  WHERE verification.organization_id = p_organization_id
    AND verification.connection_id = p_connection_id
    AND verification.state IN ('queued', 'running')
  ORDER BY verification.created_at DESC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT v_existing, false;
    RETURN;
  END IF;

  INSERT INTO app.external_connection_verifications
    (organization_id, project_id, connection_id, connection_revision_number,
     requested_by, request_id)
  VALUES
    (p_organization_id, p_project_id, p_connection_id,
     v_connection.current_revision_number, p_actor_user_id, p_request_id)
  RETURNING id INTO v_verification_id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'connection.verification.requested', 'connection', p_connection_id,
     p_request_id,
     jsonb_build_object(
       'verification_id', v_verification_id,
       'provider', v_connection.provider::text,
       'connection_revision_number', v_connection.current_revision_number
     ));

  RETURN QUERY SELECT v_verification_id, true;
END;
$$;

CREATE FUNCTION app.cancel_external_connection_verification(
  p_organization_id uuid,
  p_project_id uuid,
  p_connection_id uuid,
  p_verification_id uuid,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_cancelled boolean;
BEGIN
  IF p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR p_actor_user_id IS DISTINCT FROM app.current_user_id()
    OR p_request_id IS NULL OR p_request_id <> btrim(p_request_id)
    OR char_length(p_request_id) NOT BETWEEN 1 AND 200
    OR NOT EXISTS (
      SELECT 1
      FROM app.project_memberships membership
      JOIN app.projects project
        ON project.organization_id = membership.organization_id
       AND project.id = membership.project_id
      WHERE membership.organization_id = p_organization_id
        AND membership.project_id = p_project_id
        AND membership.user_id = p_actor_user_id
        AND membership.role = 'owner'
        AND project.status = 'active'
    )
  THEN
    RAISE EXCEPTION 'connection verification cancellation requires project owner';
  END IF;

  UPDATE app.external_connection_verifications verification
  SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'verification_cancelled',
      duration_ms = CASE
        WHEN verification.started_at IS NULL THEN NULL
        ELSE LEAST(20000, GREATEST(0,
          floor(extract(epoch FROM (clock_timestamp() - verification.started_at)) * 1000)::integer))
      END,
      finished_at = clock_timestamp()
  WHERE verification.organization_id = p_organization_id
    AND verification.project_id = p_project_id
    AND verification.connection_id = p_connection_id
    AND verification.id = p_verification_id
    AND verification.state IN ('queued', 'running')
  RETURNING true INTO v_cancelled;

  IF COALESCE(v_cancelled, false) THEN
    INSERT INTO app.activity_events
      (organization_id, actor_user_id, project_id, event_type,
       resource_type, resource_id, request_id, payload)
    VALUES
      (p_organization_id, p_actor_user_id, p_project_id,
       'connection.verification.cancelled', 'connection', p_connection_id,
       p_request_id, jsonb_build_object('verification_id', p_verification_id));
  END IF;
  RETURN COALESCE(v_cancelled, false);
END;
$$;

CREATE FUNCTION app.claim_external_connection_verification(
  p_verification_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  verification_id uuid,
  organization_id uuid,
  project_id uuid,
  connection_id uuid,
  connection_revision_number bigint,
  provider text,
  endpoint_host text,
  endpoint_port integer,
  database_name text,
  tls_mode text,
  network_mode text,
  secret_arn text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_connection_verifications%ROWTYPE;
  v_connection app.external_connections%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_verification_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 10 AND 60
  THEN
    RAISE EXCEPTION 'invalid connection verification claim';
  END IF;

  SELECT verification.* INTO v_job
  FROM app.external_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', p_verification_id,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint,
      NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_job.state IN ('succeeded', 'failed', 'cancelled') THEN
    RETURN QUERY SELECT 'already_' || v_job.state::text, v_job.id,
      v_job.organization_id, v_job.project_id, v_job.connection_id,
      v_job.connection_revision_number, NULL::text, NULL::text, NULL::integer,
      NULL::text, NULL::text, NULL::text, NULL::text, v_job.attempt_count;
    RETURN;
  END IF;
  IF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    RETURN QUERY SELECT 'busy', v_job.id,
      v_job.organization_id, v_job.project_id, v_job.connection_id,
      v_job.connection_revision_number, NULL::text, NULL::text, NULL::integer,
      NULL::text, NULL::text, NULL::text, NULL::text, v_job.attempt_count;
    RETURN;
  END IF;
  IF v_job.attempt_count >= 3 THEN
    UPDATE app.external_connection_verifications
    SET state = 'failed', worker_token = NULL, lease_expires_at = NULL,
        sanitized_error_code = 'verification_failed', duration_ms = 0,
        started_at = COALESCE(started_at, v_now), finished_at = v_now
    WHERE id = v_job.id;
    UPDATE app.external_connections AS connection
    SET status = 'degraded', sanitized_error_code = 'verification_failed',
        updated_at = v_now
    WHERE connection.organization_id = v_job.organization_id
      AND connection.project_id = v_job.project_id
      AND connection.id = v_job.connection_id
      AND connection.current_revision_number = v_job.connection_revision_number
      AND connection.status NOT IN ('disabled', 'revoked');
    INSERT INTO app.activity_events
      (organization_id, actor_user_id, project_id, event_type,
       resource_type, resource_id, request_id, payload)
    VALUES
      (v_job.organization_id, v_job.requested_by, v_job.project_id,
       'connection.verification.failed', 'connection', v_job.connection_id,
       'connector:' || v_job.id::text,
       jsonb_build_object(
         'verification_id', v_job.id,
         'connection_revision_number', v_job.connection_revision_number,
         'attempt_count', v_job.attempt_count,
         'duration_ms', 0,
         'network_reachable', false,
         'tls_verified', false,
         'credentials_verified', false,
         'postgis_verified', false,
         'error_code', 'verification_failed'
       ));
    RETURN QUERY SELECT 'attempts_exhausted', v_job.id,
      v_job.organization_id, v_job.project_id, v_job.connection_id,
      v_job.connection_revision_number, NULL::text, NULL::text, NULL::integer,
      NULL::text, NULL::text, NULL::text, NULL::text, v_job.attempt_count;
    RETURN;
  END IF;

  SELECT connection.* INTO v_connection
  FROM app.external_connections connection
  WHERE connection.organization_id = v_job.organization_id
    AND connection.project_id = v_job.project_id
    AND connection.id = v_job.connection_id
    AND connection.current_revision_number = v_job.connection_revision_number
    AND connection.status NOT IN ('disabled', 'revoked');
  IF NOT FOUND THEN
    UPDATE app.external_connection_verifications
    SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
        sanitized_error_code = 'verification_cancelled', finished_at = v_now
    WHERE id = v_job.id;
    RETURN QUERY SELECT 'not_verifiable', v_job.id,
      v_job.organization_id, v_job.project_id, v_job.connection_id,
      v_job.connection_revision_number, NULL::text, NULL::text, NULL::integer,
      NULL::text, NULL::text, NULL::text, NULL::text, v_job.attempt_count;
    RETURN;
  END IF;

  UPDATE app.external_connection_verifications AS verification
  SET state = 'running', worker_token = p_worker_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      attempt_count = verification.attempt_count + 1,
      started_at = COALESCE(verification.started_at, v_now)
  WHERE verification.id = v_job.id;

  RETURN QUERY SELECT 'claimed', v_job.id,
    v_job.organization_id, v_job.project_id, v_job.connection_id,
    v_job.connection_revision_number, v_connection.provider::text,
    v_connection.endpoint_host, v_connection.endpoint_port,
    v_connection.database_name, v_connection.tls_mode::text,
    v_connection.network_mode::text, v_connection.secret_arn,
    v_job.attempt_count + 1;
END;
$$;

CREATE FUNCTION app.complete_external_connection_verification(
  p_verification_id uuid,
  p_worker_token uuid,
  p_network_reachable boolean,
  p_tls_verified boolean,
  p_credentials_verified boolean,
  p_postgis_verified boolean,
  p_sanitized_error_code text,
  p_duration_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_connection_verifications%ROWTYPE;
  v_succeeded boolean := p_sanitized_error_code IS NULL;
BEGIN
  IF p_duration_ms NOT BETWEEN 0 AND 20000
    OR (v_succeeded AND NOT (
      p_network_reachable AND p_tls_verified
      AND p_credentials_verified AND p_postgis_verified
    ))
    OR (NOT v_succeeded AND p_sanitized_error_code NOT IN (
      'credentials_rejected', 'dns_resolution_failed', 'postgis_required',
      'tls_verification_failed', 'unsafe_network_target',
      'verification_cancelled', 'verification_failed', 'verification_timeout'
    ))
  THEN
    RAISE EXCEPTION 'invalid connection verification result';
  END IF;

  SELECT verification.* INTO v_job
  FROM app.external_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN false;
  END IF;

  UPDATE app.external_connection_verifications
  SET state = CASE WHEN v_succeeded
      THEN 'succeeded'::app.external_connection_verification_state
      ELSE 'failed'::app.external_connection_verification_state END,
      worker_token = NULL, lease_expires_at = NULL,
      network_reachable = p_network_reachable,
      tls_verified = p_tls_verified,
      credentials_verified = p_credentials_verified,
      postgis_verified = p_postgis_verified,
      sanitized_error_code = p_sanitized_error_code,
      duration_ms = p_duration_ms,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;

  UPDATE app.external_connections
  SET status = CASE WHEN v_succeeded
      THEN 'credentials_verified'::app.external_connection_status
      ELSE 'degraded'::app.external_connection_status END,
      last_verified_at = CASE WHEN v_succeeded THEN clock_timestamp() ELSE last_verified_at END,
      sanitized_error_code = p_sanitized_error_code,
      updated_at = clock_timestamp()
  WHERE organization_id = v_job.organization_id
    AND project_id = v_job.project_id
    AND id = v_job.connection_id
    AND current_revision_number = v_job.connection_revision_number
    AND status NOT IN ('disabled', 'revoked');

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.requested_by, v_job.project_id,
     CASE WHEN v_succeeded THEN 'connection.verification.succeeded'
          ELSE 'connection.verification.failed' END,
     'connection', v_job.connection_id, 'connector:' || v_job.id::text,
     jsonb_build_object(
       'verification_id', v_job.id,
       'connection_revision_number', v_job.connection_revision_number,
       'attempt_count', v_job.attempt_count,
       'duration_ms', p_duration_ms,
       'network_reachable', p_network_reachable,
       'tls_verified', p_tls_verified,
       'credentials_verified', p_credentials_verified,
       'postgis_verified', p_postgis_verified,
       'error_code', p_sanitized_error_code
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_external_connection_verification(
  p_verification_id uuid,
  p_worker_token uuid,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_connection_verifications%ROWTYPE;
  v_duration_ms integer;
  v_completed boolean;
BEGIN
  IF p_verification_id IS NULL OR p_worker_token IS NULL
    OR p_max_attempts NOT BETWEEN 1 AND 3
  THEN
    RAISE EXCEPTION 'invalid connection verification release';
  END IF;
  SELECT verification.* INTO v_job
  FROM app.external_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN 'lost';
  END IF;

  IF v_job.attempt_count >= p_max_attempts THEN
    v_duration_ms := LEAST(20000, GREATEST(0,
      floor(extract(epoch FROM (clock_timestamp() - v_job.started_at)) * 1000)::integer));
    v_completed := app.complete_external_connection_verification(
      p_verification_id, p_worker_token,
      false, false, false, false, 'verification_failed', v_duration_ms
    );
    RETURN CASE WHEN v_completed THEN 'failed' ELSE 'lost' END;
  END IF;

  UPDATE app.external_connection_verifications
  SET state = 'queued', worker_token = NULL, lease_expires_at = NULL,
      started_at = NULL
  WHERE id = v_job.id;
  RETURN 'queued';
END;
$$;

GRANT SELECT ON app.external_connection_verifications TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.external_connection_verifications
FROM opengeo_runtime;
REVOKE ALL ON app.external_connections, app.external_connection_revisions,
  app.external_connection_verifications FROM opengeo_worker, opengeo_connector;

REVOKE EXECUTE ON FUNCTION
  app.request_external_connection_verification(uuid, uuid, uuid, uuid, text),
  app.cancel_external_connection_verification(uuid, uuid, uuid, uuid, uuid, text),
  app.claim_external_connection_verification(uuid, uuid, integer),
  app.complete_external_connection_verification(
    uuid, uuid, boolean, boolean, boolean, boolean, text, integer
  ),
  app.release_external_connection_verification(uuid, uuid, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector;

GRANT EXECUTE ON FUNCTION
  app.request_external_connection_verification(uuid, uuid, uuid, uuid, text),
  app.cancel_external_connection_verification(uuid, uuid, uuid, uuid, uuid, text)
TO opengeo_runtime;
GRANT USAGE ON SCHEMA app TO opengeo_connector;
GRANT EXECUTE ON FUNCTION
  app.claim_external_connection_verification(uuid, uuid, integer),
  app.complete_external_connection_verification(
    uuid, uuid, boolean, boolean, boolean, boolean, text, integer
  ),
  app.release_external_connection_verification(uuid, uuid, integer)
TO opengeo_connector;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM opengeo_connector;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON TABLES FROM opengeo_connector;

COMMENT ON TABLE app.external_connection_verifications IS
  'Tenant-visible, secret-free verification attempt history. Queue messages carry only this row ID.';
COMMENT ON FUNCTION app.claim_external_connection_verification(uuid, uuid, integer) IS
  'Connector-only leased claim; the secret ARN is disclosed only to the isolated verifier principal.';
COMMENT ON ROLE opengeo_connector IS
  'External-connection verifier login with function-only claim/completion authority and no table grants.';

COMMIT;
