BEGIN;

-- CONNECT-001G discovers only one reviewed ArcGIS or WFS service catalog, then
-- one selected collection. Queue commands carry only the job id; the service
-- URL, collection selection, bounds, result, and retry state stay in PostgreSQL.

CREATE TABLE app.external_source_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_type text NOT NULL,
  discovery_kind text NOT NULL,
  service_url text NOT NULL,
  collection_ref text,
  request_checksum_sha256 text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_id text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  result jsonb,
  error_code text,
  worker_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  CONSTRAINT external_source_discovery_source_known CHECK (
    source_type IN ('arcgis', 'wfs')
  ),
  CONSTRAINT external_source_discovery_kind_known CHECK (
    discovery_kind IN ('catalog', 'collection')
  ),
  CONSTRAINT external_source_discovery_url_bounded CHECK (
    service_url = btrim(service_url)
    AND char_length(service_url) BETWEEN 12 AND 2048
    AND service_url ~ '^https://[A-Za-z0-9]'
    AND service_url !~ '[?#@[:cntrl:]]'
    AND (source_type <> 'arcgis'
      OR service_url ~ '/(FeatureServer|MapServer)/?$')
  ),
  CONSTRAINT external_source_discovery_collection_shape CHECK (
    (discovery_kind = 'catalog' AND collection_ref IS NULL)
    OR (discovery_kind = 'collection'
      AND collection_ref ~ '^[A-Za-z0-9_.:-]{1,200}$'
      AND (source_type <> 'arcgis' OR collection_ref ~ '^(0|[1-9][0-9]{0,4})$'))
  ),
  CONSTRAINT external_source_discovery_request_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT external_source_discovery_request_id_bounded CHECK (
    request_id = btrim(request_id)
    AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT external_source_discovery_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT external_source_discovery_error_known CHECK (
    error_code IS NULL OR error_code IN (
      'archive_cancelled', 'archive_timeout', 'destination_unavailable',
      'discovery_collection_missing', 'discovery_collection_unsupported',
      'discovery_geometry_unsupported', 'discovery_identity_unsupported',
      'discovery_no_collections', 'discovery_response_invalid',
      'discovery_response_too_large', 'discovery_schema_unsupported',
      'discovery_upstream_rejected', 'discovery_version_unsupported',
      'dns_resolution_failed', 'redirect_rejected', 'response_invalid',
      'response_media_rejected', 'response_too_large', 'retry_exhausted',
      'source_contract_invalid', 'tls_verification_failed',
      'unsafe_network_target', 'upstream_rejected', 'upstream_unavailable',
      'cancelled_by_user'
    )
  ),
  CONSTRAINT external_source_discovery_result_shape CHECK (
    (state = 'completed' AND result IS NOT NULL AND error_code IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state <> 'completed' AND result IS NULL)
  ),
  CONSTRAINT external_source_discovery_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL
      AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT external_source_discovery_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX external_source_discovery_jobs_project_idx
  ON app.external_source_discovery_jobs
    (organization_id, project_id, created_at DESC, id);
CREATE INDEX external_source_discovery_jobs_expired_idx
  ON app.external_source_discovery_jobs (lease_expires_at, id)
  WHERE state = 'running';

CREATE FUNCTION app.enforce_external_source_discovery_insert()
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
  ) NOT IN ('owner', 'editor') THEN
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

CREATE FUNCTION app.enforce_external_source_discovery_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.source_type <> OLD.source_type
    OR NEW.discovery_kind <> OLD.discovery_kind
    OR NEW.service_url <> OLD.service_url
    OR NEW.collection_ref IS DISTINCT FROM OLD.collection_ref
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  THEN RAISE EXCEPTION 'source discovery request seal is immutable'; END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'source discovery terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_source_discovery_jobs_validate_insert
  BEFORE INSERT ON app.external_source_discovery_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_discovery_insert();
CREATE TRIGGER external_source_discovery_jobs_validate_transition
  BEFORE UPDATE ON app.external_source_discovery_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_discovery_transition();

CREATE FUNCTION app.claim_external_source_discovery(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, source_type text, discovery_kind text,
  service_url text, collection_ref text, attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_source_discovery_jobs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 120
  THEN RAISE EXCEPTION 'invalid source discovery claim'; END IF;
  SELECT * INTO v_job FROM app.external_source_discovery_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.external_source_discovery_jobs
    SET state = 'failed', error_code = 'retry_exhausted', worker_token = NULL,
        lease_expires_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSE
    UPDATE app.external_source_discovery_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id
    RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.source_type,
    v_job.discovery_kind, v_job.service_url, v_job.collection_ref,
    v_job.attempt_count;
END;
$$;

CREATE FUNCTION app.complete_external_source_discovery(
  p_job_id uuid, p_worker_token uuid, p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_source_discovery_jobs%ROWTYPE;
  v_collection jsonb;
  v_limitation jsonb;
BEGIN
  SELECT * INTO v_job FROM app.external_source_discovery_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object'
    OR octet_length(p_result::text) > 524288
    OR (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 7
    OR p_result - ARRAY[
      'schema_version', 'source_type', 'kind', 'service_url', 'collections',
      'source_definition', 'limitations'
    ] <> '{}'::jsonb
    OR p_result->>'schema_version'
      <> 'opengeo.external-source-discovery-result.1.0.0'
    OR p_result->>'source_type' <> v_job.source_type
    OR p_result->>'kind' <> v_job.discovery_kind
    OR p_result->>'service_url' <> v_job.service_url
    OR jsonb_typeof(p_result->'collections') <> 'array'
    OR jsonb_array_length(p_result->'collections') NOT BETWEEN 1 AND 100
    OR jsonb_typeof(p_result->'limitations') <> 'array'
    OR jsonb_array_length(p_result->'limitations') NOT BETWEEN 1 AND 10
    OR (v_job.discovery_kind = 'catalog'
      AND jsonb_typeof(p_result->'source_definition') <> 'null')
    OR (v_job.discovery_kind = 'collection'
      AND (jsonb_typeof(p_result->'source_definition') <> 'object'
        OR jsonb_array_length(p_result->'collections') <> 1
        OR p_result->'collections'->0->>'ref' <> v_job.collection_ref))
  THEN RAISE EXCEPTION 'invalid source discovery result'; END IF;
  FOR v_collection IN SELECT value FROM jsonb_array_elements(p_result->'collections')
  LOOP
    IF jsonb_typeof(v_collection) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(v_collection)) <> 5
      OR v_collection - ARRAY['ref', 'name', 'title', 'geometry_type', 'bounds']
        <> '{}'::jsonb
      OR v_collection->>'ref' !~ '^[A-Za-z0-9_.:-]{1,200}$'
      OR char_length(v_collection->>'name') NOT BETWEEN 1 AND 200
      OR char_length(v_collection->>'title') NOT BETWEEN 1 AND 500
      OR v_collection->>'name' ~ '[[:cntrl:]]'
      OR v_collection->>'title' ~ '[[:cntrl:]]'
      OR jsonb_typeof(v_collection->'geometry_type') NOT IN ('null', 'string')
      OR (jsonb_typeof(v_collection->'geometry_type') = 'string'
        AND v_collection->>'geometry_type' NOT IN (
          'Point', 'MultiPoint', 'LineString', 'MultiLineString',
          'Polygon', 'MultiPolygon'
        ))
      OR jsonb_typeof(v_collection->'bounds') NOT IN ('null', 'array')
      OR (jsonb_typeof(v_collection->'bounds') = 'array'
        AND jsonb_array_length(v_collection->'bounds') <> 4)
    THEN RAISE EXCEPTION 'invalid source discovery collection'; END IF;
    IF jsonb_typeof(v_collection->'bounds') = 'array' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_collection->'bounds') coordinate
        WHERE jsonb_typeof(coordinate) <> 'number'
      ) OR (v_collection->'bounds'->>0)::numeric NOT BETWEEN -180 AND 180
        OR (v_collection->'bounds'->>2)::numeric NOT BETWEEN -180 AND 180
        OR (v_collection->'bounds'->>1)::numeric NOT BETWEEN -90 AND 90
        OR (v_collection->'bounds'->>3)::numeric NOT BETWEEN -90 AND 90
        OR (v_collection->'bounds'->>0)::numeric
          >= (v_collection->'bounds'->>2)::numeric
        OR (v_collection->'bounds'->>1)::numeric
          >= (v_collection->'bounds'->>3)::numeric
      THEN RAISE EXCEPTION 'invalid source discovery bounds'; END IF;
    END IF;
  END LOOP;
  FOR v_limitation IN SELECT value FROM jsonb_array_elements(p_result->'limitations')
  LOOP
    IF jsonb_typeof(v_limitation) <> 'string'
      OR char_length(v_limitation #>> '{}') NOT BETWEEN 1 AND 500
      OR v_limitation #>> '{}' ~ '[[:cntrl:]]'
    THEN RAISE EXCEPTION 'invalid source discovery limitation'; END IF;
  END LOOP;
  UPDATE app.external_source_discovery_jobs
  SET state = 'completed', result = p_result, error_code = NULL,
      worker_token = NULL, lease_expires_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.source.discovery.completed', 'project', v_job.project_id,
     'worker:' || v_job.id::text,
     jsonb_build_object(
       'discovery_job_id', v_job.id,
       'source_type', v_job.source_type,
       'discovery_kind', v_job.discovery_kind,
       'collection_count', jsonb_array_length(p_result->'collections')
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_external_source_discovery(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_error_code NOT IN (
    'destination_unavailable', 'discovery_collection_missing',
    'discovery_collection_unsupported', 'discovery_geometry_unsupported',
    'discovery_identity_unsupported', 'discovery_no_collections',
    'discovery_response_invalid', 'discovery_response_too_large',
    'discovery_schema_unsupported', 'discovery_upstream_rejected',
    'discovery_version_unsupported', 'redirect_rejected', 'response_invalid',
    'response_media_rejected', 'response_too_large', 'source_contract_invalid',
    'tls_verification_failed', 'unsafe_network_target', 'upstream_rejected'
  ) THEN RETURN false; END IF;
  UPDATE app.external_source_discovery_jobs
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_external_source_discovery(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE v_attempt integer; v_state text;
BEGIN
  IF p_error_code NOT IN (
    'archive_cancelled', 'archive_timeout', 'destination_unavailable',
    'dns_resolution_failed', 'tls_verification_failed',
    'upstream_unavailable'
  ) THEN RETURN 'lost'; END IF;
  SELECT attempt_count INTO v_attempt FROM app.external_source_discovery_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE WHEN v_attempt >= 3 THEN 'failed' ELSE 'queued' END;
  UPDATE app.external_source_discovery_jobs
  SET state = v_state::app.processing_job_state,
      error_code = CASE WHEN v_state = 'failed' THEN 'retry_exhausted'
        ELSE p_error_code END,
      worker_token = NULL, lease_expires_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id;
  RETURN v_state;
END;
$$;

CREATE FUNCTION app.cancel_external_source_discovery(
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
    OR COALESCE(
      app.effective_project_role(p_project_id, p_actor_user_id)::text,
      ''
    ) NOT IN ('owner', 'editor')
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

ALTER TABLE app.external_source_discovery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_discovery_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY external_source_discovery_jobs_select
  ON app.external_source_discovery_jobs FOR SELECT TO opengeo_runtime
  USING (
    organization_id = app.current_organization_id()
    AND app.effective_project_role(project_id, app.current_user_id()) IS NOT NULL
  );
CREATE POLICY external_source_discovery_jobs_insert
  ON app.external_source_discovery_jobs FOR INSERT TO opengeo_runtime
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND created_by = app.current_user_id()
    AND COALESCE(
      app.effective_project_role(project_id, app.current_user_id())::text,
      ''
    ) IN ('owner', 'editor')
  );

GRANT SELECT, INSERT ON app.external_source_discovery_jobs TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.external_source_discovery_jobs FROM opengeo_runtime;
REVOKE ALL ON app.external_source_discovery_jobs
FROM opengeo_worker, opengeo_connector, opengeo_dataset_verifier,
  opengeo_observable_coordinator, opengeo_source_archiver;

REVOKE EXECUTE ON FUNCTION
  app.enforce_external_source_discovery_insert(),
  app.enforce_external_source_discovery_transition(),
  app.claim_external_source_discovery(uuid, uuid, integer),
  app.complete_external_source_discovery(uuid, uuid, jsonb),
  app.fail_external_source_discovery(uuid, uuid, text),
  app.release_external_source_discovery(uuid, uuid, text),
  app.cancel_external_source_discovery(uuid, uuid, uuid, uuid, text)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_dataset_verifier, opengeo_observable_coordinator,
  opengeo_source_archiver;

GRANT EXECUTE ON FUNCTION
  app.claim_external_source_discovery(uuid, uuid, integer),
  app.complete_external_source_discovery(uuid, uuid, jsonb),
  app.fail_external_source_discovery(uuid, uuid, text),
  app.release_external_source_discovery(uuid, uuid, text)
TO opengeo_source_archiver;
GRANT EXECUTE ON FUNCTION
  app.cancel_external_source_discovery(uuid, uuid, uuid, uuid, text)
TO opengeo_runtime;

COMMENT ON TABLE app.external_source_discovery_jobs IS
  'Tenant-authorized bounded ArcGIS/WFS catalog or selected-collection discovery executed by the outbound-only source archiver.';
COMMENT ON FUNCTION app.claim_external_source_discovery(uuid, uuid, integer) IS
  'Claims one id-only bounded discovery job without granting the archiver table access.';

COMMIT;
