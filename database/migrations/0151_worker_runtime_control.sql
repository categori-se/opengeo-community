BEGIN;

-- Operator-configured control state, not tenant content or an application API.
-- Reuse the existing database and function-only worker credential. No parser
-- gets direct access to this row and no ordinary request can enable automation.
CREATE TABLE app.worker_runtime_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  configuration jsonb NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  window_state jsonb,
  budget_day date,
  starts_today integer NOT NULL DEFAULT 0,
  total_windows bigint NOT NULL DEFAULT 0,
  reserved_seconds bigint NOT NULL DEFAULT 0,
  last_result jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(configuration) = 'object'),
  CHECK (window_state IS NULL OR jsonb_typeof(window_state) = 'object'),
  CHECK (starts_today >= 0 AND total_windows >= 0 AND reserved_seconds >= 0)
);
INSERT INTO app.worker_runtime_control (singleton) VALUES (true);
REVOKE ALL ON app.worker_runtime_control FROM PUBLIC, opengeo_runtime,
  opengeo_worker, opengeo_connector, opengeo_observable_coordinator;

CREATE FUNCTION app.claim_worker_runtime(p_token uuid, p_scope_hash text, p_has_work boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  control app.worker_runtime_control%ROWTYPE;
  moment timestamptz := clock_timestamp();
  today date := (moment AT TIME ZONE 'UTC')::date;
  seconds integer;
  cleanup integer;
  daily_limit integer;
  total_limit integer;
  new_window jsonb;
BEGIN
  IF p_token IS NULL OR p_scope_hash IS NULL OR p_scope_hash !~ '^[0-9a-f]{64}$'
    OR p_has_work IS NULL THEN RAISE EXCEPTION 'invalid worker control claim'; END IF;
  SELECT * INTO STRICT control FROM app.worker_runtime_control WHERE singleton FOR UPDATE;
  IF control.configuration->>'scopeHash' IS DISTINCT FROM p_scope_hash THEN
    RETURN jsonb_build_object('status', 'configuration_changed');
  END IF;
  IF control.lease_until > moment THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  IF control.window_state IS NULL THEN
    IF control.configuration->>'enabled' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('status', 'disabled');
    END IF;
    IF NOT p_has_work THEN RETURN jsonb_build_object('status', 'idle'); END IF;
    seconds := (control.configuration->>'windowSeconds')::integer;
    cleanup := (control.configuration->>'cleanupSeconds')::integer;
    daily_limit := (control.configuration->>'dailyWindows')::integer;
    total_limit := (control.configuration->>'totalWindows')::integer;
    IF seconds IS NULL OR seconds NOT BETWEEN 300 AND 3600
      OR cleanup IS NULL OR cleanup NOT BETWEEN 300 AND 1800
      OR daily_limit IS NULL OR daily_limit NOT BETWEEN 1 AND 8
      OR total_limit IS NULL OR total_limit NOT BETWEEN 1 AND 1000
      OR control.configuration->>'endpointHash' IS NULL
      OR control.configuration->>'workerHash' IS NULL THEN
      RAISE EXCEPTION 'invalid worker control limits';
    END IF;
    IF control.total_windows >= total_limit OR
      (control.budget_day = today AND control.starts_today >= daily_limit) THEN
      RETURN jsonb_build_object('status', 'budget_exhausted');
    END IF;
    new_window := jsonb_build_object(
      'id', gen_random_uuid()::text,
      'started_at', floor(extract(epoch FROM moment))::bigint,
      'deadline', floor(extract(epoch FROM moment))::bigint + seconds,
      'cleanup_deadline', floor(extract(epoch FROM moment))::bigint + seconds + cleanup,
      'endpoint_hash', control.configuration->>'endpointHash',
      'worker_hash', control.configuration->>'workerHash',
      'shared_endpoint_id', control.configuration->>'sharedEndpointId',
      'shared_endpoint_hash', control.configuration->>'sharedEndpointHash',
      'phase', 'endpoints', 'endpoint_id', NULL, 'worker_id', NULL,
      'outcome', NULL, 'endpoint_requested', false, 'worker_requested', false,
      'worker_service_name', NULL);
    UPDATE app.worker_runtime_control SET
      window_state = new_window, budget_day = today,
      starts_today = CASE WHEN budget_day = today THEN starts_today + 1 ELSE 1 END,
      total_windows = total_windows + 1,
      reserved_seconds = reserved_seconds + seconds + cleanup
    WHERE singleton;
  END IF;
  UPDATE app.worker_runtime_control SET lease_token = p_token,
    lease_until = moment + interval '180 seconds', revision = revision + 1,
    updated_at = moment
  WHERE singleton RETURNING * INTO control;
  RETURN jsonb_build_object('status', 'claimed', 'window', control.window_state,
    'revision', control.revision, 'lease_expires_at', floor(extract(epoch FROM control.lease_until))::bigint,
    'total_windows', control.total_windows, 'reserved_seconds', control.reserved_seconds);
END;
$$;

CREATE FUNCTION app.advance_worker_runtime(p_token uuid, p_revision bigint, p_window jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  control app.worker_runtime_control%ROWTYPE;
  mutable text[] := ARRAY['phase','endpoint_id','worker_id','outcome','endpoint_requested','worker_requested','worker_service_name'];
BEGIN
  SELECT * INTO STRICT control FROM app.worker_runtime_control WHERE singleton FOR UPDATE;
  IF p_token IS NULL OR p_revision IS NULL
    OR control.lease_token IS DISTINCT FROM p_token OR control.revision <> p_revision
    OR control.lease_until <= clock_timestamp() OR control.window_state IS NULL THEN RETURN false; END IF;
  IF p_window IS NULL OR jsonb_typeof(p_window) <> 'object'
    OR (p_window - mutable) IS DISTINCT FROM (control.window_state - mutable)
    OR p_window->>'phase' IS NULL
    OR p_window->>'phase' NOT IN ('endpoints','worker','processing','remove-worker','remove-endpoints','complete')
    OR (control.window_state->>'endpoint_requested' = 'true' AND p_window->>'endpoint_requested' IS DISTINCT FROM 'true')
    OR (control.window_state->>'worker_requested' = 'true' AND p_window->>'worker_requested' IS DISTINCT FROM 'true')
    OR (control.window_state->>'worker_service_name' IS NOT NULL AND
      p_window->>'worker_service_name' IS DISTINCT FROM control.window_state->>'worker_service_name')
    OR (control.window_state->>'worker_id' IS NOT NULL AND
      p_window->>'worker_id' IS DISTINCT FROM control.window_state->>'worker_id')
    OR (control.window_state->>'endpoint_id' IS NOT NULL AND
      p_window->>'endpoint_id' IS DISTINCT FROM control.window_state->>'endpoint_id') THEN
    RAISE EXCEPTION 'worker window identity or bounds changed';
  END IF;
  UPDATE app.worker_runtime_control SET
    window_state = CASE WHEN p_window->>'phase' = 'complete' THEN NULL ELSE p_window END,
    last_result = CASE WHEN p_window->>'phase' = 'complete' THEN p_window ELSE last_result END,
    updated_at = clock_timestamp()
  WHERE singleton;
  -- Retain the lease through the invocation: intent is committed before the
  -- CloudFormation request, and another invocation must not overtake it.
  RETURN true;
END;
$$;

CREATE FUNCTION app.worker_runtime_unfinished()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT jsonb_object_agg(lane, unfinished) FROM (
    SELECT 'ingest' AS lane, count(*) AS unfinished FROM app.processing_jobs WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 'render', count(*) FROM app.map_render_jobs WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 'coverage', count(*) FROM app.spatial_coverage_derivative_jobs WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 'pmtiles', count(*) FROM app.pmtiles_derivative_jobs WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 'coverage-reclamation', count(*) FROM app.spatial_coverage_derivative_reclamations WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT 'tile-reclamation', count(*) FROM app.spatial_tile_cache_reclamations WHERE state NOT IN ('completed','failed','cancelled')
  ) lanes;
$$;

CREATE FUNCTION app.release_worker_runtime(p_token uuid, p_revision bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  UPDATE app.worker_runtime_control SET lease_until = clock_timestamp()
  WHERE singleton AND lease_token = p_token AND revision = p_revision
    AND lease_until > clock_timestamp();
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_worker_runtime(uuid,text,boolean),
  app.advance_worker_runtime(uuid,bigint,jsonb), app.worker_runtime_unfinished(),
  app.release_worker_runtime(uuid,bigint)
  FROM PUBLIC, opengeo_runtime, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.claim_worker_runtime(uuid,text,boolean),
  app.advance_worker_runtime(uuid,bigint,jsonb), app.worker_runtime_unfinished(),
  app.release_worker_runtime(uuid,bigint)
  TO opengeo_worker;
COMMIT;
