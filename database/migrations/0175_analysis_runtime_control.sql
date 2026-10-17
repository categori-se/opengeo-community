BEGIN;

-- Analysis reserves a window only in the authenticated explicit-Run submission
-- transaction (0174). The controller may lease/reconcile it, never buy another.
CREATE FUNCTION app.claim_analysis_runtime(p_token uuid, p_scope_hash text, p_has_work boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE control app.analysis_runtime_control%ROWTYPE; moment timestamptz := clock_timestamp();
BEGIN
  IF p_token IS NULL OR p_scope_hash IS NULL OR p_scope_hash !~ '^[0-9a-f]{64}$'
    OR p_has_work IS NULL THEN RAISE EXCEPTION 'invalid analysis control claim'; END IF;
  SELECT * INTO STRICT control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
  IF control.configuration->>'scopeHash' IS DISTINCT FROM p_scope_hash THEN
    RETURN jsonb_build_object('status','configuration_changed');
  END IF;
  IF control.lease_until > moment THEN RETURN jsonb_build_object('status','busy'); END IF;
  -- Even an empty row receives a short lease so a failed schedule-disable can
  -- be retried without overtaking a new Run reservation. Counters stay intact.
  UPDATE app.analysis_runtime_control SET lease_token=p_token,
    lease_until=moment+interval '180 seconds', revision=revision+1, updated_at=moment
  WHERE singleton RETURNING * INTO control;
  RETURN jsonb_build_object('status','claimed','window',control.window_state,
    'revision',control.revision,'lease_expires_at',floor(extract(epoch FROM control.lease_until))::bigint,
    'total_windows',control.total_windows,'reserved_seconds',control.reserved_seconds);
END;
$$;

CREATE FUNCTION app.advance_analysis_runtime(p_token uuid, p_revision bigint, p_window jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE control app.analysis_runtime_control%ROWTYPE;
  mutable text[] := ARRAY['phase','endpoint_id','worker_id','outcome','endpoint_requested','worker_requested','worker_service_name'];
BEGIN
  SELECT * INTO STRICT control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
  IF p_token IS NULL OR p_revision IS NULL OR control.lease_token IS DISTINCT FROM p_token
    OR control.revision<>p_revision OR control.lease_until<=clock_timestamp()
    OR control.window_state IS NULL THEN RETURN false; END IF;
  IF p_window IS NULL OR jsonb_typeof(p_window)<>'object'
    OR (p_window-mutable) IS DISTINCT FROM (control.window_state-mutable)
    OR p_window->>'phase' IS NULL OR p_window->>'phase' NOT IN
      ('endpoints','worker','processing','remove-worker','remove-endpoints','complete')
    OR p_window->>'shared_endpoint_id' IS NULL
    OR p_window->>'shared_endpoint_hash' IS DISTINCT FROM p_window->>'endpoint_hash'
    OR (control.window_state->>'endpoint_requested'='true' AND p_window->>'endpoint_requested' IS DISTINCT FROM 'true')
    OR (control.window_state->>'worker_requested'='true' AND p_window->>'worker_requested' IS DISTINCT FROM 'true')
    OR (control.window_state->>'worker_id' IS NOT NULL AND p_window->>'worker_id' IS DISTINCT FROM control.window_state->>'worker_id')
    OR (control.window_state->>'endpoint_id' IS NOT NULL AND p_window->>'endpoint_id' IS DISTINCT FROM control.window_state->>'endpoint_id')
    OR p_window->>'endpoint_requested' IS DISTINCT FROM 'false'
    OR p_window->>'worker_service_name' IS NOT NULL THEN
    RAISE EXCEPTION 'analysis window identity or bounds changed';
  END IF;
  IF p_window->>'phase'='complete' AND control.window_state->>'phase'<>'remove-endpoints' THEN
    RAISE EXCEPTION 'analysis cleanup must finish before completion';
  END IF;
  UPDATE app.analysis_runtime_control SET
    window_state=CASE WHEN p_window->>'phase'='complete' THEN NULL ELSE p_window END,
    last_result=CASE WHEN p_window->>'phase'='complete' THEN p_window ELSE last_result END,
    updated_at=clock_timestamp() WHERE singleton;
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_analysis_runtime(p_token uuid,p_revision bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  UPDATE app.analysis_runtime_control SET lease_until=clock_timestamp()
  WHERE singleton AND lease_token=p_token AND revision=p_revision AND lease_until>clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.analysis_runtime_unfinished()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT jsonb_build_object('analysis',count(*)) FROM app.analysis_jobs
  WHERE window_id IS NOT NULL AND (state IN ('dispatch_pending','pending','running','cancel_requested')
    OR cleanup->>'cleanup_required'='true');
$$;

-- A consumer may finish before its reserved budget expires. Serialize retirement
-- with submit's control-row lock so a successful daemon exit never leaves an
-- advertised window with no consumer. This function cannot adopt a stack, extend
-- a window, clear uncertain cleanup, replace configuration or buy another window.
CREATE FUNCTION app.close_analysis_host_window(p_window uuid,p_stack text,p_profiles text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE control app.analysis_runtime_control%ROWTYPE; moment timestamptz:=clock_timestamp();
BEGIN
  IF p_window IS NULL OR p_stack IS NULL
    OR p_stack !~ '^arn:aws:cloudformation:[a-z0-9-]+:[0-9]{12}:stack/OpenGeo-(dev|staging|demo|production)-AnalysisRuntime/[0-9a-f-]{36}$'
    OR COALESCE(p_profiles,'') !~ '^[0-9a-f]{64}$'
    OR p_reason IS NULL OR p_reason NOT IN ('idle','job_limit','signal','failure') THEN
    RETURN jsonb_build_object('state','binding_changed'); END IF;
  SELECT * INTO STRICT control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app.analysis_jobs WHERE window_id=p_window AND profiles_sha256=p_profiles)
    OR EXISTS(SELECT 1 FROM app.analysis_jobs WHERE window_id=p_window AND profiles_sha256 IS DISTINCT FROM p_profiles) THEN
    RETURN jsonb_build_object('state','binding_changed'); END IF;
  IF control.window_state IS NULL THEN
    IF control.last_result->>'id'=p_window::text AND control.last_result->>'worker_id'=p_stack THEN
      RETURN jsonb_build_object('state','closed'); END IF;
    RETURN jsonb_build_object('state','binding_changed');
  END IF;
  IF control.window_state->>'id' IS DISTINCT FROM p_window::text
    OR split_part(p_stack,':',4) IS DISTINCT FROM split_part(control.window_state->>'shared_endpoint_id',':',4)
    OR split_part(p_stack,':',5) IS DISTINCT FROM split_part(control.window_state->>'shared_endpoint_id',':',5)
    OR split_part(p_stack,'/',2) IS DISTINCT FROM replace(split_part(control.window_state->>'shared_endpoint_id','/',2),
      '-PrivateRuntimeEndpoints','-AnalysisRuntime')
    OR control.window_state->'worker_requested' IS DISTINCT FROM 'true'::jsonb
    OR (control.window_state->>'worker_id' IS NOT NULL
      AND control.window_state->>'worker_id' IS DISTINCT FROM p_stack) THEN
    RETURN jsonb_build_object('state','binding_changed'); END IF;
  IF control.window_state->>'phase' IN ('remove-worker','remove-endpoints') THEN
    RETURN jsonb_build_object('state','closed'); END IF;
  IF p_reason IN ('idle','job_limit') AND EXISTS(SELECT 1 FROM app.analysis_jobs WHERE window_id=p_window
      AND (state IN ('dispatch_pending','pending','running','cancel_requested') OR cleanup->>'cleanup_required'='true')) THEN
    RETURN jsonb_build_object('state','busy'); END IF;
  -- A timed-out/failed consumer retires pending work. Active/uncertain cleanup
  -- stays quarantined until the controller proves this exact host is absent.
  UPDATE app.analysis_jobs SET
    state=CASE WHEN state IN ('dispatch_pending','pending') THEN 'cancelled' ELSE 'cancel_requested' END,
    error_code='analysis_window_closed',
    cleanup=CASE WHEN state IN ('dispatch_pending','pending')
      THEN '{"cleanup_required":false,"container_removed":true,"staging_removed":true}'::jsonb ELSE cleanup END,
    updated_at=moment WHERE window_id=p_window AND state IN ('dispatch_pending','pending','running');
  -- Before adoption worker_id remains null: the controller must independently
  -- discover and validate the actual tagged stack before issuing any deletion.
  UPDATE app.analysis_runtime_control SET
    window_state=window_state||jsonb_build_object('phase','remove-worker','outcome','host-'||p_reason),
    revision=revision+1,lease_token=NULL,lease_until=moment,updated_at=moment WHERE singleton;
  RETURN jsonb_build_object('state','closed');
END;
$$;

REVOKE ALL ON FUNCTION app.claim_analysis_runtime(uuid,text,boolean),
  app.advance_analysis_runtime(uuid,bigint,jsonb),app.release_analysis_runtime(uuid,bigint),
  app.analysis_runtime_unfinished() FROM PUBLIC,opengeo_runtime,opengeo_worker,
  opengeo_connector,opengeo_observable_coordinator,opengeo_analysis_runtime;
GRANT EXECUTE ON FUNCTION app.claim_analysis_runtime(uuid,text,boolean),
  app.advance_analysis_runtime(uuid,bigint,jsonb),app.release_analysis_runtime(uuid,bigint),
  app.analysis_runtime_unfinished() TO opengeo_analysis_controller;
REVOKE ALL ON FUNCTION app.close_analysis_host_window(uuid,text,text,text)
  FROM PUBLIC,opengeo_runtime,opengeo_worker,opengeo_connector,opengeo_observable_coordinator,opengeo_analysis_controller;
GRANT EXECUTE ON FUNCTION app.close_analysis_host_window(uuid,text,text,text) TO opengeo_analysis_runtime;
COMMIT;
