BEGIN;

CREATE TYPE app.user_dataset_verification_state AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_dataset_verifier'
  ) THEN
    EXECUTE 'CREATE ROLE opengeo_dataset_verifier LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_dataset_verifier SET search_path = app, public;

ALTER TABLE app.user_dataset_connections
  ADD COLUMN target_revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT user_dataset_connections_target_revision_positive CHECK (
    target_revision > 0
  );

CREATE FUNCTION app.bump_user_dataset_connection_target_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF ROW(
    NEW.provider, NEW.bucket_name, NEW.region_name, NEW.object_prefix,
    NEW.credential_mode, NEW.role_arn
  ) IS DISTINCT FROM ROW(
    OLD.provider, OLD.bucket_name, OLD.region_name, OLD.object_prefix,
    OLD.credential_mode, OLD.role_arn
  ) THEN
    NEW.target_revision := OLD.target_revision + 1;
    IF NEW.status <> 'disabled' THEN
      NEW.status := 'unverified';
    END IF;
    NEW.last_verified_at := NULL;
    NEW.sanitized_error_code := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_dataset_connections_bump_target_revision
  BEFORE UPDATE OF provider, bucket_name, region_name, object_prefix,
    credential_mode, role_arn
  ON app.user_dataset_connections
  FOR EACH ROW EXECUTE FUNCTION app.bump_user_dataset_connection_target_revision();

CREATE TABLE app.user_dataset_connection_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  connection_id uuid NOT NULL,
  target_revision bigint NOT NULL,
  credential_revision bigint NOT NULL,
  state app.user_dataset_verification_state NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  worker_token uuid,
  lease_expires_at timestamptz,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  request_id text NOT NULL,
  bucket_access_confirmed boolean NOT NULL DEFAULT false,
  object_access_confirmed boolean NOT NULL DEFAULT false,
  deny_canaries_confirmed boolean NOT NULL DEFAULT false,
  objects_observed integer NOT NULL DEFAULT 0,
  sanitized_error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.user_dataset_connections (organization_id, id),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES app.organization_memberships (organization_id, user_id),
  CONSTRAINT user_dataset_connection_verifications_revision_shape CHECK (
    target_revision > 0 AND credential_revision >= 0
  ),
  CONSTRAINT user_dataset_connection_verifications_request_bounded CHECK (
    request_id = btrim(request_id)
    AND char_length(request_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT user_dataset_connection_verifications_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT user_dataset_connection_verifications_objects_bounded CHECK (
    objects_observed BETWEEN 0 AND 1
  ),
  CONSTRAINT user_dataset_connection_verifications_duration_bounded CHECK (
    duration_ms IS NULL OR duration_ms BETWEEN 0 AND 25000
  ),
  CONSTRAINT user_dataset_connection_verifications_error_allowlist CHECK (
    sanitized_error_code IS NULL OR sanitized_error_code IN (
      'assume_role_denied',
      'bucket_access_denied',
      'credentials_rejected',
      'deny_canary_failed',
      'object_access_denied',
      'region_mismatch',
      'secret_invalid',
      'verification_cancelled',
      'verification_failed',
      'verification_timeout'
    )
  ),
  CONSTRAINT user_dataset_connection_verifications_result_shape CHECK (
    (state = 'queued'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NULL AND finished_at IS NULL
      AND sanitized_error_code IS NULL AND duration_ms IS NULL
      AND NOT bucket_access_confirmed AND NOT object_access_confirmed
      AND NOT deny_canaries_confirmed AND objects_observed = 0)
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
      AND bucket_access_confirmed AND deny_canaries_confirmed
      AND object_access_confirmed AND objects_observed = 1)
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

CREATE UNIQUE INDEX user_dataset_connection_verifications_one_active_idx
  ON app.user_dataset_connection_verifications (organization_id, connection_id)
  WHERE state IN ('queued', 'running');

CREATE INDEX user_dataset_connection_verifications_owner_idx
  ON app.user_dataset_connection_verifications
    (organization_id, owner_user_id, connection_id, created_at DESC, id);

ALTER TABLE app.user_dataset_connection_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_dataset_connection_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY user_dataset_connection_verifications_owner_read
  ON app.user_dataset_connection_verifications
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );

CREATE FUNCTION app.request_user_dataset_connection_verification(
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
  v_connection app.user_dataset_connections%ROWTYPE;
  v_existing uuid;
  v_verification_id uuid;
BEGIN
  IF p_connection_id IS NULL OR p_actor_user_id IS NULL OR p_request_id IS NULL
    OR p_actor_user_id IS DISTINCT FROM app.current_user_id()
    OR p_request_id <> btrim(p_request_id)
    OR char_length(p_request_id) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'invalid user dataset verification request';
  END IF;

  SELECT connection.* INTO v_connection
  FROM app.user_dataset_connections connection
  WHERE connection.organization_id = app.current_organization_id()
    AND connection.owner_user_id = p_actor_user_id
    AND connection.id = p_connection_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user dataset connection not found';
  END IF;
  IF v_connection.status IN ('draft', 'disabled')
    OR (v_connection.credential_mode = 'assume_role'
      AND (v_connection.secret_arn IS NULL
        OR v_connection.configured_secret_fields <> ARRAY['external_id']::text[]))
    OR (v_connection.credential_mode = 'access_key'
      AND (v_connection.secret_arn IS NULL OR v_connection.credential_revision = 0))
  THEN
    RAISE EXCEPTION 'user dataset connection is not verifiable';
  END IF;

  SELECT verification.id INTO v_existing
  FROM app.user_dataset_connection_verifications verification
  WHERE verification.organization_id = v_connection.organization_id
    AND verification.connection_id = v_connection.id
    AND verification.state IN ('queued', 'running')
  ORDER BY verification.created_at DESC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT v_existing, false;
    RETURN;
  END IF;

  INSERT INTO app.user_dataset_connection_verifications
    (organization_id, owner_user_id, connection_id, target_revision,
     credential_revision, requested_by, request_id)
  VALUES
    (v_connection.organization_id, v_connection.owner_user_id,
     v_connection.id, v_connection.target_revision,
     v_connection.credential_revision, p_actor_user_id, p_request_id)
  RETURNING id INTO v_verification_id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type, resource_type,
     resource_id, request_id, payload)
  VALUES
    (v_connection.organization_id, p_actor_user_id, NULL,
     'dataset_connection.verification.requested', 'dataset_connection',
     v_connection.id, p_request_id,
     jsonb_build_object(
       'verification_id', v_verification_id,
       'target_revision', v_connection.target_revision,
       'credential_revision', v_connection.credential_revision
     ));

  RETURN QUERY SELECT v_verification_id, true;
END;
$$;

CREATE FUNCTION app.claim_user_dataset_connection_verification(
  p_verification_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  verification_id uuid,
  organization_id uuid,
  owner_user_id uuid,
  connection_id uuid,
  target_revision bigint,
  credential_revision bigint,
  bucket_name text,
  region_name text,
  object_prefix text,
  credential_mode text,
  role_arn text,
  secret_arn text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.user_dataset_connection_verifications%ROWTYPE;
  v_connection app.user_dataset_connections%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_verification_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 10 AND 60
  THEN
    RAISE EXCEPTION 'invalid user dataset verification claim';
  END IF;

  SELECT verification.* INTO v_job
  FROM app.user_dataset_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', p_verification_id,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_job.state IN ('succeeded', 'failed', 'cancelled') THEN
    RETURN QUERY SELECT 'already_' || v_job.state::text, v_job.id,
      v_job.organization_id, v_job.owner_user_id, v_job.connection_id,
      v_job.target_revision, v_job.credential_revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, v_job.attempt_count;
    RETURN;
  END IF;
  IF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    RETURN QUERY SELECT 'busy', v_job.id,
      v_job.organization_id, v_job.owner_user_id, v_job.connection_id,
      v_job.target_revision, v_job.credential_revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, v_job.attempt_count;
    RETURN;
  END IF;

  SELECT connection.* INTO v_connection
  FROM app.user_dataset_connections connection
  WHERE connection.organization_id = v_job.organization_id
    AND connection.owner_user_id = v_job.owner_user_id
    AND connection.id = v_job.connection_id
    AND connection.target_revision = v_job.target_revision
    AND connection.credential_revision = v_job.credential_revision
    AND connection.status NOT IN ('draft', 'disabled');

  IF NOT FOUND THEN
    UPDATE app.user_dataset_connection_verifications
    SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
        sanitized_error_code = 'verification_cancelled', finished_at = v_now
    WHERE id = v_job.id;
    RETURN QUERY SELECT 'not_verifiable', v_job.id,
      v_job.organization_id, v_job.owner_user_id, v_job.connection_id,
      v_job.target_revision, v_job.credential_revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, v_job.attempt_count;
    RETURN;
  END IF;

  IF v_job.attempt_count >= 3 THEN
    UPDATE app.user_dataset_connection_verifications
    SET state = 'failed', worker_token = NULL, lease_expires_at = NULL,
        sanitized_error_code = 'verification_failed', duration_ms = 0,
        started_at = COALESCE(started_at, v_now), finished_at = v_now
    WHERE id = v_job.id;
    UPDATE app.user_dataset_connections
    SET status = 'error', sanitized_error_code = 'verification_failed'
    WHERE organization_id = v_job.organization_id
      AND owner_user_id = v_job.owner_user_id
      AND id = v_job.connection_id
      AND target_revision = v_job.target_revision
      AND credential_revision = v_job.credential_revision
      AND status <> 'disabled';
    RETURN QUERY SELECT 'attempts_exhausted', v_job.id,
      v_job.organization_id, v_job.owner_user_id, v_job.connection_id,
      v_job.target_revision, v_job.credential_revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, v_job.attempt_count;
    RETURN;
  END IF;

  UPDATE app.user_dataset_connection_verifications verification
  SET state = 'running', worker_token = p_worker_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      attempt_count = verification.attempt_count + 1,
      started_at = COALESCE(verification.started_at, v_now)
  WHERE verification.id = v_job.id;

  RETURN QUERY SELECT 'claimed', v_job.id,
    v_job.organization_id, v_job.owner_user_id, v_job.connection_id,
    v_job.target_revision, v_job.credential_revision,
    v_connection.bucket_name, v_connection.region_name,
    v_connection.object_prefix, v_connection.credential_mode::text,
    v_connection.role_arn, v_connection.secret_arn,
    v_job.attempt_count + 1;
END;
$$;

CREATE FUNCTION app.complete_user_dataset_connection_verification(
  p_verification_id uuid,
  p_worker_token uuid,
  p_bucket_access_confirmed boolean,
  p_object_access_confirmed boolean,
  p_deny_canaries_confirmed boolean,
  p_objects_observed integer,
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
  v_job app.user_dataset_connection_verifications%ROWTYPE;
  v_succeeded boolean := p_sanitized_error_code IS NULL;
BEGIN
  IF p_duration_ms NOT BETWEEN 0 AND 25000
    OR p_objects_observed NOT BETWEEN 0 AND 1
    OR (v_succeeded AND NOT (
      p_bucket_access_confirmed AND p_object_access_confirmed
      AND p_deny_canaries_confirmed AND p_objects_observed = 1
    ))
    OR (NOT v_succeeded AND p_sanitized_error_code NOT IN (
      'assume_role_denied', 'bucket_access_denied', 'credentials_rejected',
      'deny_canary_failed', 'object_access_denied', 'region_mismatch',
      'secret_invalid', 'verification_cancelled', 'verification_failed',
      'verification_timeout'
    ))
  THEN
    RAISE EXCEPTION 'invalid user dataset verification result';
  END IF;

  SELECT verification.* INTO v_job
  FROM app.user_dataset_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN false;
  END IF;

  UPDATE app.user_dataset_connection_verifications
  SET state = CASE WHEN v_succeeded
      THEN 'succeeded'::app.user_dataset_verification_state
      ELSE 'failed'::app.user_dataset_verification_state END,
      worker_token = NULL, lease_expires_at = NULL,
      bucket_access_confirmed = p_bucket_access_confirmed,
      object_access_confirmed = p_object_access_confirmed,
      deny_canaries_confirmed = p_deny_canaries_confirmed,
      objects_observed = p_objects_observed,
      sanitized_error_code = p_sanitized_error_code,
      duration_ms = p_duration_ms,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;

  UPDATE app.user_dataset_connections
  SET status = CASE WHEN v_succeeded
      THEN 'verified'::app.dataset_connection_status
      ELSE 'error'::app.dataset_connection_status END,
      last_verified_at = CASE WHEN v_succeeded THEN clock_timestamp() ELSE NULL END,
      sanitized_error_code = p_sanitized_error_code
  WHERE organization_id = v_job.organization_id
    AND owner_user_id = v_job.owner_user_id
    AND id = v_job.connection_id
    AND target_revision = v_job.target_revision
    AND credential_revision = v_job.credential_revision
    AND status <> 'disabled';

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type, resource_type,
     resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.requested_by, NULL,
     CASE WHEN v_succeeded
       THEN 'dataset_connection.verification.succeeded'
       ELSE 'dataset_connection.verification.failed' END,
     'dataset_connection', v_job.connection_id,
     'dataset-verifier:' || v_job.id::text,
     jsonb_build_object(
       'verification_id', v_job.id,
       'target_revision', v_job.target_revision,
       'credential_revision', v_job.credential_revision,
       'attempt_count', v_job.attempt_count,
       'duration_ms', p_duration_ms,
       'bucket_access_confirmed', p_bucket_access_confirmed,
       'object_access_confirmed', p_object_access_confirmed,
       'deny_canaries_confirmed', p_deny_canaries_confirmed,
       'objects_observed', p_objects_observed,
       'error_code', p_sanitized_error_code
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_user_dataset_connection_verification(
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
  v_job app.user_dataset_connection_verifications%ROWTYPE;
BEGIN
  IF p_max_attempts <> 3 THEN
    RAISE EXCEPTION 'invalid user dataset verification release';
  END IF;
  SELECT verification.* INTO v_job
  FROM app.user_dataset_connection_verifications verification
  WHERE verification.id = p_verification_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN 'unchanged';
  END IF;
  IF v_job.attempt_count < p_max_attempts THEN
    UPDATE app.user_dataset_connection_verifications
    SET state = 'queued', worker_token = NULL, lease_expires_at = NULL,
        started_at = NULL
    WHERE id = v_job.id;
    RETURN 'queued';
  END IF;
  PERFORM app.complete_user_dataset_connection_verification(
    v_job.id, p_worker_token, false, false, false, 0,
    'verification_failed', 0
  );
  RETURN 'failed';
END;
$$;

GRANT SELECT (
  id, organization_id, owner_user_id, connection_id, target_revision,
  credential_revision, state, attempt_count, bucket_access_confirmed,
  object_access_confirmed, deny_canaries_confirmed, objects_observed,
  sanitized_error_code, duration_ms, requested_by, created_at, started_at,
  finished_at
) ON app.user_dataset_connection_verifications TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION
  app.bump_user_dataset_connection_target_revision(),
  app.request_user_dataset_connection_verification(uuid, uuid, text),
  app.claim_user_dataset_connection_verification(uuid, uuid, integer),
  app.complete_user_dataset_connection_verification(
    uuid, uuid, boolean, boolean, boolean, integer, text, integer
  ),
  app.release_user_dataset_connection_verification(uuid, uuid, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.request_user_dataset_connection_verification(uuid, uuid, text)
TO opengeo_runtime;

GRANT EXECUTE ON FUNCTION
  app.claim_user_dataset_connection_verification(uuid, uuid, integer),
  app.complete_user_dataset_connection_verification(
    uuid, uuid, boolean, boolean, boolean, integer, text, integer
  ),
  app.release_user_dataset_connection_verification(uuid, uuid, integer)
TO opengeo_dataset_verifier;

GRANT USAGE ON SCHEMA app TO opengeo_dataset_verifier;

REVOKE ALL ON
  app.user_dataset_connections,
  app.project_dataset_connection_bindings,
  app.user_dataset_connection_verifications
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator,
  opengeo_dataset_verifier;

COMMENT ON TABLE app.user_dataset_connection_verifications IS
  'Secret-free leased S3 connection verification attempts; object keys and credentials are never persisted.';
COMMENT ON ROLE opengeo_dataset_verifier IS
  'Function-only user dataset verifier; no table privileges and no tenant runtime authority.';

COMMIT;
