BEGIN;
ALTER TABLE app.observable_github_dispatches ADD COLUMN retained_logs jsonb
  CHECK (jsonb_typeof(retained_logs) = 'object' AND octet_length(retained_logs::text) <= 60000);

CREATE FUNCTION app.retain_github_build_logs(p_job uuid, p_token uuid, p_run bigint, p_attempt integer, p_logs jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE d app.observable_github_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO d FROM app.observable_github_dispatches WHERE build_job_id = p_job FOR UPDATE;
  IF NOT FOUND OR d.lease_token IS DISTINCT FROM p_token OR d.lease_expires_at <= clock_timestamp()
    OR d.stage <> 'dispatched' OR d.run_id IS DISTINCT FROM p_run OR d.run_attempt IS DISTINCT FROM p_attempt
  THEN RETURN false; END IF;
  IF d.retained_logs IS NOT NULL THEN RETURN true; END IF;
  IF jsonb_typeof(p_logs) IS DISTINCT FROM 'object' OR octet_length(p_logs::text) > 60000
    OR p_logs->>'state' IS NULL OR p_logs->>'state' NOT IN ('retained', 'unavailable')
    OR jsonb_typeof(p_logs->'text') IS DISTINCT FROM 'string' OR octet_length(p_logs->>'text') > 24000
    OR jsonb_typeof(p_logs->'truncated') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_logs->'captured_at') IS DISTINCT FROM 'string'
    OR (p_logs->>'state' = 'retained' AND (p_logs->>'checksum_sha256' IS NULL OR p_logs->>'checksum_sha256' !~ '^[0-9a-f]{64}$'))
  THEN RAISE EXCEPTION 'Invalid retained GitHub log excerpt'; END IF;
  UPDATE app.observable_github_dispatches SET retained_logs = p_logs, updated_at = clock_timestamp()
    WHERE build_job_id = p_job;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.retain_github_build_logs(uuid, uuid, bigint, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retain_github_build_logs(uuid, uuid, bigint, integer, jsonb) TO opengeo_runtime;
COMMIT;
