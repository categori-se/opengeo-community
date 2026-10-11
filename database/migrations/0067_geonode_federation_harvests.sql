BEGIN;

-- GEONODE-001F registers one exact anonymous GeoNode 5.1.0 catalog and
-- reconciles bounded snapshots through the existing outbound-only source
-- archiver. Queue commands and logs carry only the harvest job UUID.

CREATE TABLE app.geonode_federation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  display_name text NOT NULL,
  remote_url text NOT NULL,
  source_fingerprint_sha256 text NOT NULL,
  source_version text NOT NULL DEFAULT '5.1.0',
  scheduling_enabled boolean NOT NULL DEFAULT false,
  refresh_interval_minutes integer NOT NULL DEFAULT 1440,
  maximum_resources integer NOT NULL DEFAULT 100,
  credential_mode text NOT NULL DEFAULT 'anonymous',
  configuration_checksum_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, source_fingerprint_sha256),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  CONSTRAINT geonode_federation_name_bounded CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 100
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT geonode_federation_url_bounded CHECK (
    remote_url = btrim(remote_url)
    AND char_length(remote_url) BETWEEN 12 AND 2048
    AND remote_url ~ '^https://[a-z0-9]'
    AND remote_url !~ '[?#@[:space:][:cntrl:]]'
    AND remote_url !~ '/$'
    AND remote_url !~ '^https://localhost(?::[0-9]+)?(?:/|$)'
    AND remote_url !~ '^https://[^/]+\.local(?::[0-9]+)?(?:/|$)'
  ),
  CONSTRAINT geonode_federation_fingerprint_valid CHECK (
    source_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_federation_version_exact CHECK (source_version = '5.1.0'),
  CONSTRAINT geonode_federation_refresh_bounded CHECK (
    refresh_interval_minutes BETWEEN 60 AND 10080
  ),
  CONSTRAINT geonode_federation_resources_bounded CHECK (
    maximum_resources BETWEEN 1 AND 100
  ),
  CONSTRAINT geonode_federation_anonymous_only CHECK (
    credential_mode = 'anonymous'
  ),
  CONSTRAINT geonode_federation_configuration_checksum_valid CHECK (
    configuration_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_federation_status_known CHECK (
    status IN ('active', 'disabled')
  ),
  CONSTRAINT geonode_federation_disabled_shape CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE TABLE app.geonode_harvest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_configuration_checksum_sha256 text NOT NULL,
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
  FOREIGN KEY (organization_id, source_id)
    REFERENCES app.geonode_federation_sources (organization_id, id),
  CONSTRAINT geonode_harvest_configuration_checksum_valid CHECK (
    source_configuration_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_harvest_request_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_harvest_request_id_bounded CHECK (
    request_id = btrim(request_id)
    AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT geonode_harvest_attempt_bounded CHECK (attempt_count BETWEEN 0 AND 3),
  CONSTRAINT geonode_harvest_error_known CHECK (
    error_code IS NULL OR error_code IN (
      'cancelled_by_user', 'dns_resolution_failed',
      'geonode_harvest_identity_collision',
      'geonode_harvest_identity_invalid',
      'geonode_harvest_local_identity_collision',
      'geonode_harvest_response_invalid',
      'geonode_harvest_response_too_large',
      'geonode_harvest_response_unsafe',
      'geonode_harvest_timestamp_invalid',
      'geonode_harvest_total_invalid',
      'geonode_harvest_type_unsupported',
      'geonode_harvest_upstream_unavailable',
      'response_media_rejected', 'retry_exhausted',
      'tls_verification_failed', 'unsafe_network_target', 'upstream_rejected'
    )
  ),
  CONSTRAINT geonode_harvest_result_shape CHECK (
    (state = 'completed' AND result IS NOT NULL AND error_code IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state <> 'completed' AND result IS NULL)
  ),
  CONSTRAINT geonode_harvest_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL
      AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT geonode_harvest_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE TABLE app.geonode_federated_identities (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_id uuid NOT NULL,
  remote_identifier text NOT NULL,
  resource_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'current',
  current_version_number integer NOT NULL DEFAULT 1,
  current_payload_sha256 text NOT NULL,
  remote_modified_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_refreshed_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  PRIMARY KEY (organization_id, remote_identifier),
  UNIQUE (organization_id, source_id, remote_identifier),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, source_id)
    REFERENCES app.geonode_federation_sources (organization_id, id),
  CONSTRAINT geonode_federated_remote_identifier_uuid CHECK (
    remote_identifier ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT geonode_federated_type_known CHECK (
    resource_type IN ('dataset', 'document', 'map', 'geoapp', 'service')
  ),
  CONSTRAINT geonode_federated_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 500
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT geonode_federated_status_known CHECK (
    status IN ('current', 'withdrawn')
  ),
  CONSTRAINT geonode_federated_version_positive CHECK (current_version_number > 0),
  CONSTRAINT geonode_federated_payload_checksum_valid CHECK (
    current_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_federated_freshness_ordered CHECK (
    last_refreshed_at >= first_seen_at
  ),
  CONSTRAINT geonode_federated_withdrawn_shape CHECK (
    (status = 'current' AND withdrawn_at IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL)
  )
);

CREATE TABLE app.geonode_federated_identity_versions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  source_id uuid NOT NULL,
  remote_identifier text NOT NULL,
  version_number integer NOT NULL,
  harvest_job_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  title text NOT NULL,
  payload_sha256 text NOT NULL,
  payload jsonb,
  remote_modified_at timestamptz,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, remote_identifier, version_number),
  UNIQUE (organization_id, harvest_job_id, remote_identifier),
  FOREIGN KEY (organization_id, source_id, remote_identifier)
    REFERENCES app.geonode_federated_identities
      (organization_id, source_id, remote_identifier),
  FOREIGN KEY (organization_id, harvest_job_id)
    REFERENCES app.geonode_harvest_jobs (organization_id, id),
  CONSTRAINT geonode_federated_history_action_known CHECK (
    action IN ('added', 'updated', 'withdrawn')
  ),
  CONSTRAINT geonode_federated_history_version_positive CHECK (version_number > 0),
  CONSTRAINT geonode_federated_history_payload_checksum_valid CHECK (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT geonode_federated_history_payload_shape CHECK (
    (action IN ('added', 'updated') AND jsonb_typeof(payload) = 'object')
    OR (action = 'withdrawn' AND payload IS NULL)
  )
);

CREATE INDEX geonode_harvest_jobs_source_idx
  ON app.geonode_harvest_jobs
    (organization_id, project_id, source_id, created_at DESC, id);
CREATE INDEX geonode_harvest_jobs_expired_idx
  ON app.geonode_harvest_jobs (lease_expires_at, id) WHERE state = 'running';
CREATE INDEX geonode_federated_identities_source_idx
  ON app.geonode_federated_identities
    (organization_id, project_id, source_id, status, title, remote_identifier);

CREATE FUNCTION app.enforce_geonode_federation_source_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_expected text;
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR COALESCE(app.effective_project_role(NEW.project_id, NEW.created_by)::text, '')
      NOT IN ('owner', 'editor')
  THEN RAISE EXCEPTION 'GeoNode federation source requires project edit access'; END IF;
  IF NEW.source_fingerprint_sha256 <> encode(public.digest(
    convert_to(NEW.remote_url, 'UTF8'), 'sha256'), 'hex')
  THEN RAISE EXCEPTION 'GeoNode federation source fingerprint mismatch'; END IF;
  v_expected := encode(public.digest(convert_to(
    NEW.display_name || chr(31) || NEW.remote_url || chr(31)
      || lower(NEW.scheduling_enabled::text) || chr(31)
      || NEW.refresh_interval_minutes::text || chr(31)
      || NEW.maximum_resources::text || chr(31) || NEW.credential_mode,
    'UTF8'), 'sha256'), 'hex');
  IF NEW.configuration_checksum_sha256 <> v_expected
  THEN RAISE EXCEPTION 'GeoNode federation configuration checksum mismatch'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_geonode_federation_source_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.display_name <> OLD.display_name
    OR NEW.remote_url <> OLD.remote_url
    OR NEW.source_fingerprint_sha256 <> OLD.source_fingerprint_sha256
    OR NEW.source_version <> OLD.source_version
    OR NEW.scheduling_enabled <> OLD.scheduling_enabled
    OR NEW.refresh_interval_minutes <> OLD.refresh_interval_minutes
    OR NEW.maximum_resources <> OLD.maximum_resources
    OR NEW.credential_mode <> OLD.credential_mode
    OR NEW.configuration_checksum_sha256 <> OLD.configuration_checksum_sha256
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR OLD.status = 'disabled' OR NEW.status <> 'disabled'
  THEN RAISE EXCEPTION 'GeoNode federation source identity is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.record_geonode_federation_source_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (NEW.organization_id, NEW.created_by, NEW.project_id,
    'federation.geonode.source.registered', 'geonode_federation_source', NEW.id,
    'geonode-source:' || NEW.id::text, jsonb_build_object(
      'source_fingerprint_sha256', NEW.source_fingerprint_sha256,
      'configuration_checksum_sha256', NEW.configuration_checksum_sha256,
      'source_version', NEW.source_version,
      'credential_mode', NEW.credential_mode,
      'scheduling_enabled', NEW.scheduling_enabled,
      'refresh_interval_minutes', NEW.refresh_interval_minutes,
      'maximum_resources', NEW.maximum_resources));
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_geonode_harvest_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source app.geonode_federation_sources%ROWTYPE; v_expected text;
BEGIN
  SELECT * INTO v_source FROM app.geonode_federation_sources
  WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id
    AND id = NEW.source_id;
  IF NEW.created_by <> app.current_user_id() OR v_source.id IS NULL
    OR v_source.status <> 'active'
    OR v_source.configuration_checksum_sha256
      <> NEW.source_configuration_checksum_sha256
    OR COALESCE(app.effective_project_role(NEW.project_id, NEW.created_by)::text, '')
      NOT IN ('owner', 'editor')
    OR NEW.state <> 'queued' OR NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.worker_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
  THEN RAISE EXCEPTION 'GeoNode harvest initial state mismatch'; END IF;
  v_expected := encode(public.digest(convert_to(
    NEW.source_id::text || chr(31) || NEW.source_configuration_checksum_sha256,
    'UTF8'), 'sha256'), 'hex');
  IF NEW.request_checksum_sha256 <> v_expected
  THEN RAISE EXCEPTION 'GeoNode harvest checksum mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:geonode-harvest-quota:' || NEW.organization_id::text, 0));
  IF (SELECT count(*) FROM app.geonode_harvest_jobs job
      WHERE job.organization_id = NEW.organization_id
        AND job.state IN ('queued', 'running')) >= 4
    OR (SELECT count(*) FROM app.geonode_harvest_jobs job
        WHERE job.organization_id = NEW.organization_id
          AND job.project_id = NEW.project_id AND job.created_by = NEW.created_by
          AND job.created_at >= clock_timestamp() - interval '24 hours') >= 64
  THEN RAISE EXCEPTION 'GeoNode harvest quota exceeded'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_geonode_harvest_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.source_id <> OLD.source_id
    OR NEW.source_configuration_checksum_sha256
      <> OLD.source_configuration_checksum_sha256
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_id <> OLD.request_id
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR OLD.state IN ('completed', 'failed', 'cancelled')
  THEN RAISE EXCEPTION 'GeoNode harvest request seal is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_geonode_federated_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GeoNode federated identity history is immutable'; END;
$$;

CREATE TRIGGER geonode_federation_sources_validate_insert
  BEFORE INSERT ON app.geonode_federation_sources FOR EACH ROW
  EXECUTE FUNCTION app.enforce_geonode_federation_source_insert();
CREATE TRIGGER geonode_federation_sources_validate_transition
  BEFORE UPDATE ON app.geonode_federation_sources FOR EACH ROW
  EXECUTE FUNCTION app.enforce_geonode_federation_source_transition();
CREATE TRIGGER geonode_federation_sources_record_insert
  AFTER INSERT ON app.geonode_federation_sources FOR EACH ROW
  EXECUTE FUNCTION app.record_geonode_federation_source_insert();
CREATE TRIGGER geonode_harvest_jobs_validate_insert
  BEFORE INSERT ON app.geonode_harvest_jobs FOR EACH ROW
  EXECUTE FUNCTION app.enforce_geonode_harvest_insert();
CREATE TRIGGER geonode_harvest_jobs_validate_transition
  BEFORE UPDATE ON app.geonode_harvest_jobs FOR EACH ROW
  EXECUTE FUNCTION app.enforce_geonode_harvest_transition();
CREATE TRIGGER geonode_federated_identity_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.geonode_federated_identity_versions FOR EACH ROW
  EXECUTE FUNCTION app.reject_geonode_federated_history_mutation();

CREATE FUNCTION app.claim_geonode_harvest(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, display_name text, remote_url text,
  source_fingerprint_sha256 text, source_version text,
  scheduling_enabled boolean, refresh_interval_minutes integer,
  maximum_resources integer, credential_mode text, attempt_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE v_job app.geonode_harvest_jobs%ROWTYPE;
  v_source app.geonode_federation_sources%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 120
  THEN RAISE EXCEPTION 'invalid GeoNode harvest claim'; END IF;
  SELECT * INTO v_job FROM app.geonode_harvest_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::boolean, NULL::integer, NULL::integer,
      NULL::text, NULL::integer; RETURN;
  END IF;
  SELECT * INTO v_source FROM app.geonode_federation_sources
  WHERE organization_id = v_job.organization_id AND id = v_job.source_id;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_source.status <> 'active'
    OR v_source.configuration_checksum_sha256
      <> v_job.source_configuration_checksum_sha256 THEN
    UPDATE app.geonode_harvest_jobs SET state = 'failed',
      error_code = 'geonode_harvest_upstream_unavailable', worker_token = NULL,
      lease_expires_at = NULL, finished_at = v_now WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.geonode_harvest_jobs SET state = 'failed', error_code = 'retry_exhausted',
      worker_token = NULL, lease_expires_at = NULL, finished_at = v_now
    WHERE id = v_job.id; claim_status := 'already_failed';
  ELSE
    UPDATE app.geonode_harvest_jobs target SET state = 'running',
      worker_token = p_worker_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      attempt_count = target.attempt_count + 1,
      started_at = COALESCE(target.started_at, v_now), error_code = NULL
    WHERE target.id = v_job.id RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id,
    CASE WHEN claim_status = 'claimed' THEN v_source.display_name ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.remote_url ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.source_fingerprint_sha256 ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.source_version ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.scheduling_enabled ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.refresh_interval_minutes ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.maximum_resources ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_source.credential_mode ELSE NULL END,
    CASE WHEN claim_status = 'claimed' THEN v_job.attempt_count ELSE NULL END;
END;
$$;

CREATE FUNCTION app.complete_geonode_harvest(
  p_job_id uuid, p_worker_token uuid, p_snapshot jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE v_job app.geonode_harvest_jobs%ROWTYPE;
  v_source app.geonode_federation_sources%ROWTYPE;
  v_resource jsonb; v_prior app.geonode_federated_identities%ROWTYPE;
  v_observed timestamptz; v_fresh_until timestamptz; v_identifier text;
  v_type text; v_title text; v_checksum text; v_modified timestamptz;
  v_version integer; v_added integer := 0; v_updated integer := 0;
  v_unchanged integer := 0; v_withdrawn integer := 0;
BEGIN
  SELECT * INTO v_job FROM app.geonode_harvest_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  SELECT * INTO v_source FROM app.geonode_federation_sources
  WHERE organization_id = v_job.organization_id AND id = v_job.source_id;
  IF v_source.status <> 'active'
    OR v_source.configuration_checksum_sha256
      <> v_job.source_configuration_checksum_sha256
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
    OR octet_length(p_snapshot::text) > 2097152
    OR p_snapshot - ARRAY['schema_version','source','observed_at','fresh_until',
      'remote_total','truncated','resources','snapshot_sha256'] <> '{}'::jsonb
    OR (SELECT count(*) FROM jsonb_object_keys(p_snapshot)) <> 8
    OR p_snapshot->>'schema_version' <> 'opengeo.geonode-harvest-snapshot.1.0.0'
    OR jsonb_typeof(p_snapshot->'source') <> 'object'
    OR (p_snapshot->'source') - ARRAY['product','version','commit','url',
      'fingerprint_sha256'] <> '{}'::jsonb
    OR (SELECT count(*) FROM jsonb_object_keys(p_snapshot->'source')) <> 5
    OR p_snapshot->'source'->>'product' <> 'geonode'
    OR p_snapshot->'source'->>'version' <> '5.1.0'
    OR p_snapshot->'source'->>'commit'
      <> 'a1db97e81dfc26c16bb4ee1a5d2b408877af66c9'
    OR p_snapshot->'source'->>'url' <> v_source.remote_url
    OR p_snapshot->'source'->>'fingerprint_sha256'
      <> v_source.source_fingerprint_sha256
    OR jsonb_typeof(p_snapshot->'resources') <> 'array'
    OR jsonb_array_length(p_snapshot->'resources') NOT BETWEEN 0 AND v_source.maximum_resources
    OR jsonb_typeof(p_snapshot->'remote_total') <> 'number'
    OR (p_snapshot->>'remote_total')::bigint < jsonb_array_length(p_snapshot->'resources')
    OR (p_snapshot->>'remote_total')::bigint > 1000000000
    OR jsonb_typeof(p_snapshot->'truncated') <> 'boolean'
    OR (p_snapshot->>'truncated')::boolean
      <> ((p_snapshot->>'remote_total')::bigint > jsonb_array_length(p_snapshot->'resources'))
    OR p_snapshot->>'snapshot_sha256' !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid GeoNode harvest snapshot'; END IF;
  BEGIN
    v_observed := (p_snapshot->>'observed_at')::timestamptz;
    v_fresh_until := (p_snapshot->>'fresh_until')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid GeoNode harvest timestamps'; END;
  IF v_observed > clock_timestamp() + interval '5 minutes'
    OR v_fresh_until <> v_observed
      + make_interval(mins => v_source.refresh_interval_minutes)
  THEN RAISE EXCEPTION 'invalid GeoNode harvest freshness'; END IF;

  FOR v_resource IN SELECT value FROM jsonb_array_elements(p_snapshot->'resources') LOOP
    IF jsonb_typeof(v_resource) <> 'object'
      OR v_resource - ARRAY['remote_identifier','resource_type','title',
        'remote_modified_at','payload_sha256','payload'] <> '{}'::jsonb
      OR (SELECT count(*) FROM jsonb_object_keys(v_resource)) <> 6
      OR jsonb_typeof(v_resource->'payload') <> 'object'
      OR octet_length((v_resource->'payload')::text) > 131072
      OR v_resource->>'payload_sha256' !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid GeoNode harvest resource'; END IF;
    v_identifier := v_resource->>'remote_identifier';
    BEGIN
      IF v_identifier::uuid::text <> v_identifier
      THEN RAISE EXCEPTION 'invalid GeoNode remote identity'; END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid GeoNode remote identity';
    END;
    v_type := v_resource->>'resource_type'; v_title := v_resource->>'title';
    v_checksum := v_resource->>'payload_sha256';
    IF v_type NOT IN ('dataset','document','map','geoapp','service')
      OR char_length(v_title) NOT BETWEEN 1 AND 500 OR v_title <> btrim(v_title)
      OR v_title ~ '[[:cntrl:]]'
      OR v_resource->'payload'->>'uuid' <> v_identifier
      OR lower(v_resource->'payload'->>'resource_type') <> v_type
      OR v_resource->'payload'->>'title' <> v_title
    THEN RAISE EXCEPTION 'invalid GeoNode harvest resource identity'; END IF;
    v_modified := NULL;
    IF jsonb_typeof(v_resource->'remote_modified_at') = 'string' THEN
      BEGIN v_modified := (v_resource->>'remote_modified_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid GeoNode modified time'; END;
    ELSIF jsonb_typeof(v_resource->'remote_modified_at') <> 'null' THEN
      RAISE EXCEPTION 'invalid GeoNode modified time';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.governed_resource_external_identifiers identifier
      WHERE identifier.organization_id = v_job.organization_id
        AND identifier.namespace = 'geonode' AND identifier.identifier = v_identifier
        AND identifier.source_url IS DISTINCT FROM v_source.remote_url
    ) THEN RAISE EXCEPTION 'GeoNode local identity collision'; END IF;
    SELECT * INTO v_prior FROM app.geonode_federated_identities identity
    WHERE identity.organization_id = v_job.organization_id
      AND identity.remote_identifier = v_identifier FOR UPDATE;
    IF v_prior.remote_identifier IS NOT NULL AND v_prior.source_id <> v_source.id
    THEN RAISE EXCEPTION 'GeoNode source identity collision'; END IF;
    IF v_prior.remote_identifier IS NULL THEN
      INSERT INTO app.geonode_federated_identities
        (organization_id, project_id, source_id, remote_identifier, resource_type,
         title, status, current_version_number, current_payload_sha256,
         remote_modified_at, first_seen_at, last_refreshed_at)
      VALUES (v_job.organization_id, v_job.project_id, v_source.id, v_identifier,
        v_type, v_title, 'current', 1, v_checksum, v_modified,
        v_observed, v_observed);
      INSERT INTO app.geonode_federated_identity_versions
        (organization_id, source_id, remote_identifier, version_number,
         harvest_job_id, action, resource_type, title, payload_sha256,
         payload, remote_modified_at, observed_at)
      VALUES (v_job.organization_id, v_source.id, v_identifier, 1, v_job.id,
        'added', v_type, v_title, v_checksum, v_resource->'payload',
        v_modified, v_observed); v_added := v_added + 1;
    ELSIF v_prior.current_payload_sha256 = v_checksum AND v_prior.status = 'current' THEN
      UPDATE app.geonode_federated_identities SET last_refreshed_at = v_observed,
        remote_modified_at = v_modified WHERE organization_id = v_job.organization_id
        AND remote_identifier = v_identifier; v_unchanged := v_unchanged + 1;
    ELSE
      v_version := v_prior.current_version_number + 1;
      UPDATE app.geonode_federated_identities SET resource_type = v_type,
        title = v_title, status = 'current', current_version_number = v_version,
        current_payload_sha256 = v_checksum, remote_modified_at = v_modified,
        last_refreshed_at = v_observed, withdrawn_at = NULL
      WHERE organization_id = v_job.organization_id AND remote_identifier = v_identifier;
      INSERT INTO app.geonode_federated_identity_versions
        (organization_id, source_id, remote_identifier, version_number,
         harvest_job_id, action, resource_type, title, payload_sha256,
         payload, remote_modified_at, observed_at)
      VALUES (v_job.organization_id, v_source.id, v_identifier, v_version, v_job.id,
        CASE WHEN v_prior.status = 'withdrawn' THEN 'added' ELSE 'updated' END,
        v_type, v_title, v_checksum, v_resource->'payload', v_modified, v_observed);
      IF v_prior.status = 'withdrawn' THEN v_added := v_added + 1;
      ELSE v_updated := v_updated + 1; END IF;
    END IF;
  END LOOP;

  FOR v_prior IN SELECT * FROM app.geonode_federated_identities identity
    WHERE identity.organization_id = v_job.organization_id
      AND identity.source_id = v_source.id AND identity.status = 'current'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'resources') resource
        WHERE resource->>'remote_identifier' = identity.remote_identifier)
    FOR UPDATE
  LOOP
    v_version := v_prior.current_version_number + 1;
    UPDATE app.geonode_federated_identities SET status = 'withdrawn',
      current_version_number = v_version, last_refreshed_at = v_observed,
      withdrawn_at = v_observed WHERE organization_id = v_job.organization_id
      AND remote_identifier = v_prior.remote_identifier;
    INSERT INTO app.geonode_federated_identity_versions
      (organization_id, source_id, remote_identifier, version_number,
       harvest_job_id, action, resource_type, title, payload_sha256,
       payload, remote_modified_at, observed_at)
    VALUES (v_job.organization_id, v_source.id, v_prior.remote_identifier, v_version,
      v_job.id, 'withdrawn', v_prior.resource_type, v_prior.title,
      v_prior.current_payload_sha256, NULL, v_prior.remote_modified_at, v_observed);
    v_withdrawn := v_withdrawn + 1;
  END LOOP;

  UPDATE app.geonode_harvest_jobs SET state = 'completed', error_code = NULL,
    worker_token = NULL, lease_expires_at = NULL, finished_at = clock_timestamp(),
    result = p_snapshot || jsonb_build_object('reconciliation', jsonb_build_object(
      'added', v_added, 'updated', v_updated, 'unchanged', v_unchanged,
      'withdrawn', v_withdrawn)) WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, v_job.created_by, v_job.project_id,
    'federation.geonode.harvest.completed', 'project', v_job.project_id,
    'source-archiver:' || v_job.id::text, jsonb_build_object(
      'source_id', v_source.id, 'harvest_job_id', v_job.id,
      'snapshot_sha256', p_snapshot->>'snapshot_sha256',
      'added', v_added, 'updated', v_updated, 'unchanged', v_unchanged,
      'withdrawn', v_withdrawn));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_geonode_harvest(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  IF p_error_code NOT IN (
    'geonode_harvest_identity_collision','geonode_harvest_identity_invalid',
    'geonode_harvest_local_identity_collision','geonode_harvest_response_invalid',
    'geonode_harvest_response_too_large','geonode_harvest_response_unsafe',
    'geonode_harvest_timestamp_invalid','geonode_harvest_total_invalid',
    'geonode_harvest_type_unsupported','response_media_rejected',
    'unsafe_network_target','upstream_rejected'
  ) THEN RETURN false; END IF;
  UPDATE app.geonode_harvest_jobs SET state = 'failed', error_code = p_error_code,
    worker_token = NULL, lease_expires_at = NULL, finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_geonode_harvest(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE v_attempt integer; v_state text;
BEGIN
  IF p_error_code NOT IN ('dns_resolution_failed','geonode_harvest_upstream_unavailable',
    'tls_verification_failed') THEN RETURN 'lost'; END IF;
  SELECT attempt_count INTO v_attempt FROM app.geonode_harvest_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE WHEN v_attempt >= 3 THEN 'failed' ELSE 'queued' END;
  UPDATE app.geonode_harvest_jobs SET state = v_state::app.processing_job_state,
    error_code = CASE WHEN v_state = 'failed' THEN 'retry_exhausted' ELSE p_error_code END,
    worker_token = NULL, lease_expires_at = NULL,
    finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id; RETURN v_state;
END;
$$;

CREATE FUNCTION app.cancel_geonode_harvest(
  p_organization_id uuid, p_project_id uuid, p_job_id uuid,
  p_actor_user_id uuid, p_request_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE v_job app.geonode_harvest_jobs%ROWTYPE;
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR COALESCE(app.effective_project_role(p_project_id, p_actor_user_id)::text, '')
      NOT IN ('owner', 'editor')
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.geonode_harvest_jobs SET state = 'cancelled',
    error_code = 'cancelled_by_user', worker_token = NULL,
    lease_expires_at = NULL, finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND id = p_job_id AND state IN ('queued', 'running')
  RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, p_actor_user_id, v_job.project_id,
    'federation.geonode.harvest.cancelled', 'geonode_harvest', v_job.id,
    p_request_id, jsonb_build_object('source_id', v_job.source_id,
      'harvest_job_id', v_job.id));
  RETURN true;
END;
$$;

CREATE FUNCTION app.disable_geonode_federation_source(
  p_organization_id uuid, p_project_id uuid, p_source_id uuid,
  p_actor_user_id uuid, p_request_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE v_source app.geonode_federation_sources%ROWTYPE; v_cancelled integer := 0;
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR COALESCE(app.effective_project_role(p_project_id, p_actor_user_id)::text, '')
      NOT IN ('owner', 'editor')
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.geonode_federation_sources SET status = 'disabled',
    disabled_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND id = p_source_id AND status = 'active'
  RETURNING * INTO v_source;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM app.geonode_federation_sources source
      WHERE source.organization_id = p_organization_id
        AND source.project_id = p_project_id AND source.id = p_source_id
        AND source.status = 'disabled');
  END IF;
  UPDATE app.geonode_harvest_jobs SET state = 'cancelled',
    error_code = 'cancelled_by_user', worker_token = NULL,
    lease_expires_at = NULL, finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND source_id = p_source_id AND state IN ('queued', 'running');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_source.organization_id, p_actor_user_id, v_source.project_id,
    'federation.geonode.source.disabled', 'geonode_federation_source', v_source.id,
    p_request_id, jsonb_build_object(
      'source_fingerprint_sha256', v_source.source_fingerprint_sha256,
      'cancelled_harvest_jobs', v_cancelled));
  RETURN true;
END;
$$;

ALTER TABLE app.geonode_federation_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_harvest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_federated_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_federated_identity_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_federation_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_harvest_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_federated_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE app.geonode_federated_identity_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY geonode_federation_sources_select ON app.geonode_federation_sources
  FOR SELECT TO opengeo_runtime USING (
    organization_id = app.current_organization_id()
    AND app.effective_project_role(project_id, app.current_user_id()) IS NOT NULL);
CREATE POLICY geonode_federation_sources_insert ON app.geonode_federation_sources
  FOR INSERT TO opengeo_runtime WITH CHECK (
    organization_id = app.current_organization_id() AND created_by = app.current_user_id()
    AND COALESCE(app.effective_project_role(project_id, app.current_user_id())::text, '')
      IN ('owner', 'editor'));
CREATE POLICY geonode_harvest_jobs_select ON app.geonode_harvest_jobs
  FOR SELECT TO opengeo_runtime USING (
    organization_id = app.current_organization_id()
    AND app.effective_project_role(project_id, app.current_user_id()) IS NOT NULL);
CREATE POLICY geonode_harvest_jobs_insert ON app.geonode_harvest_jobs
  FOR INSERT TO opengeo_runtime WITH CHECK (
    organization_id = app.current_organization_id() AND created_by = app.current_user_id()
    AND COALESCE(app.effective_project_role(project_id, app.current_user_id())::text, '')
      IN ('owner', 'editor'));
CREATE POLICY geonode_federated_identities_select ON app.geonode_federated_identities
  FOR SELECT TO opengeo_runtime USING (
    organization_id = app.current_organization_id()
    AND app.effective_project_role(project_id, app.current_user_id()) IS NOT NULL);
CREATE POLICY geonode_federated_versions_select
  ON app.geonode_federated_identity_versions FOR SELECT TO opengeo_runtime USING (
    organization_id = app.current_organization_id() AND EXISTS (
      SELECT 1 FROM app.geonode_federated_identities identity
      WHERE identity.organization_id = geonode_federated_identity_versions.organization_id
        AND identity.source_id = geonode_federated_identity_versions.source_id
        AND identity.remote_identifier
          = geonode_federated_identity_versions.remote_identifier
        AND app.effective_project_role(identity.project_id, app.current_user_id()) IS NOT NULL));

GRANT SELECT, INSERT ON app.geonode_federation_sources,
  app.geonode_harvest_jobs TO opengeo_runtime;
GRANT SELECT ON app.geonode_federated_identities,
  app.geonode_federated_identity_versions TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.geonode_federation_sources,
  app.geonode_harvest_jobs, app.geonode_federated_identities,
  app.geonode_federated_identity_versions FROM opengeo_runtime;
GRANT USAGE ON SCHEMA app TO opengeo_source_archiver;
REVOKE ALL ON app.geonode_federation_sources, app.geonode_harvest_jobs,
  app.geonode_federated_identities, app.geonode_federated_identity_versions
FROM opengeo_worker, opengeo_connector, opengeo_dataset_verifier,
  opengeo_observable_coordinator, opengeo_source_archiver;

REVOKE EXECUTE ON FUNCTION app.enforce_geonode_federation_source_insert(),
  app.enforce_geonode_federation_source_transition(),
  app.record_geonode_federation_source_insert(),
  app.enforce_geonode_harvest_insert(), app.enforce_geonode_harvest_transition(),
  app.reject_geonode_federated_history_mutation(),
  app.claim_geonode_harvest(uuid,uuid,integer),
  app.complete_geonode_harvest(uuid,uuid,jsonb),
  app.fail_geonode_harvest(uuid,uuid,text),
  app.release_geonode_harvest(uuid,uuid,text),
  app.cancel_geonode_harvest(uuid,uuid,uuid,uuid,text),
  app.disable_geonode_federation_source(uuid,uuid,uuid,uuid,text)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_dataset_verifier, opengeo_observable_coordinator, opengeo_source_archiver;
GRANT EXECUTE ON FUNCTION app.claim_geonode_harvest(uuid,uuid,integer),
  app.complete_geonode_harvest(uuid,uuid,jsonb),
  app.fail_geonode_harvest(uuid,uuid,text),
  app.release_geonode_harvest(uuid,uuid,text) TO opengeo_source_archiver;
GRANT EXECUTE ON FUNCTION app.cancel_geonode_harvest(uuid,uuid,uuid,uuid,text)
  TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.disable_geonode_federation_source(
  uuid,uuid,uuid,uuid,text) TO opengeo_runtime;

COMMENT ON TABLE app.geonode_federation_sources IS
  'Exact anonymous GeoNode 5.1.0 catalog identity; import creates no timer, credential, or always-on compute.';
COMMENT ON TABLE app.geonode_harvest_jobs IS
  'Bounded idempotent GeoNode snapshot/reconciliation job dispatched by UUID only.';
COMMENT ON TABLE app.geonode_federated_identity_versions IS
  'Append-only added, updated, withdrawn remote identity history; unchanged refreshes create no duplicate version.';

COMMIT;
