BEGIN;

-- Deliberate metadata discovery uses the existing isolated connector principal.
-- Results stay in separate bounded rows: do not aggregate these through Data API.
CREATE TABLE app.external_connection_catalog_discoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision_number bigint NOT NULL CHECK (connection_revision_number > 0),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  request_key text NOT NULL CHECK (
    request_key = btrim(request_key) AND char_length(request_key) BETWEEN 1 AND 200),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  worker_token uuid,
  lease_expires_at timestamptz,
  relation_count integer NOT NULL DEFAULT 0 CHECK (relation_count BETWEEN 0 AND 100),
  truncated boolean NOT NULL DEFAULT false,
  sanitized_error_code text CHECK (sanitized_error_code IS NULL OR sanitized_error_code IN (
    'catalog_timeout', 'catalog_limits_invalid', 'catalog_description_invalid',
    'catalog_metadata_limit_exceeded', 'catalog_description_failed',
    'catalog_descriptor_limit_exceeded', 'catalog_cancelled', 'catalog_failed',
    'credentials_rejected', 'dns_resolution_failed', 'postgis_required',
    'tls_verification_failed', 'unsafe_network_target',
    'verification_cancelled', 'verification_failed', 'verification_timeout')),
  requested_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, connection_id, request_key),
  FOREIGN KEY (organization_id, project_id, connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id),
  FOREIGN KEY (organization_id, connection_id, connection_revision_number)
    REFERENCES app.external_connection_revisions
      (organization_id, connection_id, revision_number),
  CONSTRAINT external_connection_catalog_discoveries_lease_shape CHECK (
    (state = 'queued' AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NULL AND finished_at IS NULL AND sanitized_error_code IS NULL)
    OR (state = 'running' AND worker_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL AND sanitized_error_code IS NULL)
    OR (state = 'completed' AND worker_token IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL AND sanitized_error_code IS NULL)
    OR (state IN ('failed', 'cancelled') AND worker_token IS NULL AND lease_expires_at IS NULL
      AND finished_at IS NOT NULL AND sanitized_error_code IS NOT NULL)),
  CONSTRAINT external_connection_catalog_discoveries_result_shape CHECK (
    state = 'completed' OR (relation_count = 0 AND NOT truncated))
);

CREATE UNIQUE INDEX external_connection_catalog_discoveries_one_active_idx
  ON app.external_connection_catalog_discoveries (organization_id, connection_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX external_connection_catalog_discoveries_project_idx
  ON app.external_connection_catalog_discoveries
    (organization_id, project_id, connection_id, created_at DESC, id);

CREATE TABLE app.external_connection_catalog_relations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  discovery_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  schema_name text NOT NULL CHECK (octet_length(schema_name) BETWEEN 1 AND 63),
  relation_name text NOT NULL CHECK (octet_length(relation_name) BETWEEN 1 AND 63),
  schema_fingerprint_sha256 text NOT NULL CHECK (schema_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  descriptor jsonb NOT NULL CHECK (
    jsonb_typeof(descriptor) = 'object' AND octet_length(descriptor::text) <= 49152
    AND descriptor->>'schema' = schema_name AND descriptor->>'name' = relation_name
    AND descriptor->>'schema_fingerprint_sha256' = schema_fingerprint_sha256),
  PRIMARY KEY (discovery_id, ordinal),
  UNIQUE (discovery_id, schema_name, relation_name),
  FOREIGN KEY (organization_id, project_id, discovery_id)
    REFERENCES app.external_connection_catalog_discoveries (organization_id, project_id, id)
);

ALTER TABLE app.external_connection_catalog_discoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_catalog_discoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_catalog_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_catalog_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY external_connection_catalog_discoveries_read
  ON app.external_connection_catalog_discoveries FOR SELECT
  USING (organization_id = app.current_organization_id() AND EXISTS (
    SELECT 1 FROM app.organization_memberships member
    WHERE member.organization_id = external_connection_catalog_discoveries.organization_id
      AND member.user_id = app.current_user_id()
      AND (member.role = 'admin' OR app.effective_project_role(project_id) IS NOT NULL)));
CREATE POLICY external_connection_catalog_relations_read
  ON app.external_connection_catalog_relations FOR SELECT
  USING (organization_id = app.current_organization_id() AND EXISTS (
    SELECT 1 FROM app.organization_memberships member
    WHERE member.organization_id = external_connection_catalog_relations.organization_id
      AND member.user_id = app.current_user_id()
      AND (member.role = 'admin' OR app.effective_project_role(project_id) IS NOT NULL)));

CREATE FUNCTION app.request_external_connection_catalog_discovery(
  p_connection_id uuid, p_expected_revision integer, p_request_key text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_connection app.external_connections%ROWTYPE;
  v_job app.external_connection_catalog_discoveries%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_connection_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1
    OR p_request_key IS NULL OR p_request_key <> btrim(p_request_key)
    OR char_length(p_request_key) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'invalid connection catalog request'; END IF;

  SELECT connection.* INTO v_connection FROM app.external_connections connection
  WHERE connection.organization_id = app.current_organization_id()
    AND connection.id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'external connection not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.organization_memberships member
    JOIN app.organizations organization ON organization.id = member.organization_id
    JOIN app.projects project ON project.organization_id = organization.id
      AND project.id = v_connection.project_id
    WHERE member.organization_id = v_connection.organization_id
      AND member.user_id = app.current_user_id()
      AND organization.status = 'active' AND project.status = 'active'
      AND (member.role = 'admin' OR app.effective_project_role(project.id)::text = 'owner')
  ) THEN RAISE EXCEPTION 'connection catalog requires connection manage authority'; END IF;

  -- A committed request key remains idempotent after completion, rotation or disable.
  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.organization_id = v_connection.organization_id
    AND discovery.connection_id = v_connection.id AND discovery.request_key = p_request_key;
  IF FOUND THEN
    IF v_job.connection_revision_number <> p_expected_revision THEN
      RAISE EXCEPTION 'connection catalog request key revision conflict';
    END IF;
    RETURN v_job.id;
  END IF;
  IF v_connection.current_revision_number <> p_expected_revision THEN
    RAISE EXCEPTION 'connection catalog revision conflict';
  END IF;
  IF v_connection.status <> 'credentials_verified' OR v_connection.last_verified_at IS NULL
    OR NOT v_connection.read_only OR v_connection.provider <> 'postgresql'
    OR v_connection.tls_mode <> 'verify_full' OR v_connection.network_mode <> 'public_internet'
  THEN RAISE EXCEPTION 'external connection is not catalog discoverable'; END IF;

  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.organization_id = v_connection.organization_id
    AND discovery.connection_id = v_connection.id AND discovery.state IN ('queued', 'running');
  IF FOUND THEN
    IF v_job.connection_revision_number = p_expected_revision THEN
      RAISE EXCEPTION 'connection catalog discovery already active' USING ERRCODE = '23505';
    END IF;
    UPDATE app.external_connection_catalog_discoveries
    SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'catalog_cancelled', finished_at = clock_timestamp()
    WHERE id = v_job.id;
  END IF;

  INSERT INTO app.external_connection_catalog_discoveries
    (organization_id, project_id, connection_id, connection_revision_number, request_key, requested_by)
  VALUES (v_connection.organization_id, v_connection.project_id, v_connection.id,
    p_expected_revision, p_request_key, app.current_user_id()) RETURNING id INTO v_id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_connection.organization_id, app.current_user_id(), v_connection.project_id,
    'connection.catalog.requested', 'connection', v_connection.id, p_request_key,
    jsonb_build_object('discovery_id', v_id, 'connection_revision_number', p_expected_revision));
  RETURN v_id;
END;
$$;

CREATE FUNCTION app.cancel_external_connection_catalog_discovery(p_discovery_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE v_job app.external_connection_catalog_discoveries%ROWTYPE;
BEGIN
  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.organization_id = app.current_organization_id()
    AND discovery.id = p_discovery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.organization_memberships member
    JOIN app.organizations organization ON organization.id = member.organization_id
    JOIN app.projects project ON project.organization_id = organization.id AND project.id = v_job.project_id
    WHERE member.organization_id = v_job.organization_id AND member.user_id = app.current_user_id()
      AND organization.status = 'active' AND project.status = 'active'
      AND (member.role = 'admin' OR app.effective_project_role(project.id)::text = 'owner')
  ) THEN RAISE EXCEPTION 'connection catalog cancellation requires connection manage authority'; END IF;
  IF v_job.state NOT IN ('queued', 'running') THEN RETURN false; END IF;
  UPDATE app.external_connection_catalog_discoveries
  SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'catalog_cancelled', finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, app.current_user_id(), v_job.project_id,
    'connection.catalog.cancelled', 'connection', v_job.connection_id,
    'catalog:' || v_job.id::text, jsonb_build_object('discovery_id', v_job.id));
  RETURN true;
END;
$$;

CREATE FUNCTION app.claim_external_connection_catalog_discovery(
  p_discovery_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, discovery_id uuid, organization_id uuid, project_id uuid,
  connection_id uuid, connection_revision_number bigint, provider text,
  endpoint_host text, endpoint_port integer, database_name text, allowed_schemas text[],
  tls_mode text, network_mode text, secret_arn text, attempt_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_connection_catalog_discoveries%ROWTYPE;
  v_connection app.external_connections%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_discovery_id IS NULL OR p_worker_token IS NULL OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 10 AND 60
  THEN RAISE EXCEPTION 'invalid connection catalog claim'; END IF;
  discovery_id := p_discovery_id;
  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.id = p_discovery_id FOR UPDATE;
  IF NOT FOUND THEN claim_status := 'not_found'; RETURN NEXT; RETURN; END IF;
  organization_id := v_job.organization_id;
  project_id := v_job.project_id;
  connection_id := v_job.connection_id;
  connection_revision_number := v_job.connection_revision_number;
  attempt_count := v_job.attempt_count;
  IF v_job.state IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state; RETURN NEXT; RETURN;
  END IF;
  IF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy'; RETURN NEXT; RETURN;
  END IF;
  SELECT connection.* INTO v_connection FROM app.external_connections connection
  JOIN app.organizations organization ON organization.id = connection.organization_id AND organization.status = 'active'
  JOIN app.projects project ON project.organization_id = connection.organization_id
    AND project.id = connection.project_id AND project.status = 'active'
  WHERE connection.organization_id = v_job.organization_id AND connection.project_id = v_job.project_id
    AND connection.id = v_job.connection_id AND connection.current_revision_number = v_job.connection_revision_number
    AND connection.status = 'credentials_verified' AND connection.last_verified_at IS NOT NULL
    AND connection.read_only AND connection.tls_mode = 'verify_full' AND connection.network_mode = 'public_internet'
    AND EXISTS (
      SELECT 1 FROM app.organization_memberships member
      WHERE member.organization_id = connection.organization_id AND member.user_id = v_job.requested_by
        AND (member.role = 'admin' OR app.background_project_role(
          connection.organization_id, connection.project_id, v_job.requested_by)::text = 'owner'))
  FOR SHARE OF connection;
  IF NOT FOUND THEN
    UPDATE app.external_connection_catalog_discoveries discovery
    SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'catalog_cancelled', finished_at = v_now WHERE discovery.id = v_job.id;
    claim_status := 'not_discoverable'; RETURN NEXT; RETURN;
  END IF;
  IF v_job.attempt_count >= 3 THEN
    UPDATE app.external_connection_catalog_discoveries discovery
    SET state = 'failed', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'catalog_failed', finished_at = v_now WHERE discovery.id = v_job.id;
    claim_status := 'attempts_exhausted'; RETURN NEXT; RETURN;
  END IF;
  UPDATE app.external_connection_catalog_discoveries discovery
  SET state = 'running', worker_token = p_worker_token,
    lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    attempt_count = discovery.attempt_count + 1, started_at = COALESCE(discovery.started_at, v_now)
  WHERE discovery.id = v_job.id;
  claim_status := 'claimed';
  provider := v_connection.provider::text;
  endpoint_host := v_connection.endpoint_host;
  endpoint_port := v_connection.endpoint_port;
  database_name := v_connection.database_name;
  allowed_schemas := v_connection.allowed_schemas;
  tls_mode := v_connection.tls_mode::text;
  network_mode := v_connection.network_mode::text;
  secret_arn := v_connection.secret_arn;
  attempt_count := v_job.attempt_count + 1;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION app.complete_external_connection_catalog_discovery(
  p_discovery_id uuid, p_worker_token uuid, p_catalog jsonb, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.external_connection_catalog_discoveries%ROWTYPE;
  v_connection app.external_connections%ROWTYPE;
  v_descriptor jsonb;
  v_column jsonb;
  v_ordinal integer := 1;
  v_count integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.id = p_discovery_id FOR UPDATE;
  IF NOT FOUND OR p_worker_token IS NULL OR v_job.state <> 'running'
    OR v_job.worker_token IS DISTINCT FROM p_worker_token OR v_job.lease_expires_at <= v_now
  THEN RETURN false; END IF;
  SELECT connection.* INTO v_connection FROM app.external_connections connection
  JOIN app.organizations organization ON organization.id = connection.organization_id AND organization.status = 'active'
  JOIN app.projects project ON project.organization_id = connection.organization_id
    AND project.id = connection.project_id AND project.status = 'active'
  WHERE connection.organization_id = v_job.organization_id AND connection.project_id = v_job.project_id
    AND connection.id = v_job.connection_id AND connection.current_revision_number = v_job.connection_revision_number
    AND connection.status = 'credentials_verified' AND connection.last_verified_at IS NOT NULL
    AND connection.read_only AND connection.tls_mode = 'verify_full' AND connection.network_mode = 'public_internet'
    AND EXISTS (
      SELECT 1 FROM app.organization_memberships member
      WHERE member.organization_id = connection.organization_id AND member.user_id = v_job.requested_by
        AND (member.role = 'admin' OR app.background_project_role(
          connection.organization_id, connection.project_id, v_job.requested_by)::text = 'owner'))
  FOR SHARE OF connection;
  IF NOT FOUND THEN
    UPDATE app.external_connection_catalog_discoveries
    SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'catalog_cancelled', finished_at = v_now WHERE id = v_job.id;
    RETURN false;
  END IF;
  IF p_error_code IS NOT NULL THEN
    IF p_catalog IS NOT NULL OR p_error_code NOT IN (
      'catalog_timeout', 'catalog_limits_invalid', 'catalog_description_invalid',
      'catalog_metadata_limit_exceeded', 'catalog_description_failed',
      'catalog_descriptor_limit_exceeded', 'catalog_cancelled', 'catalog_failed',
      'credentials_rejected', 'dns_resolution_failed', 'postgis_required',
      'tls_verification_failed', 'unsafe_network_target',
      'verification_cancelled', 'verification_failed', 'verification_timeout')
    THEN RAISE EXCEPTION 'invalid connection catalog error'; END IF;
  ELSE
    IF p_catalog IS NULL OR jsonb_typeof(p_catalog) IS DISTINCT FROM 'object'
      OR p_catalog->>'schemaVersion' IS DISTINCT FROM 'opengeo.postgis-catalog.1.0.0'
      OR jsonb_typeof(p_catalog->'relations') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_catalog->'truncated') IS DISTINCT FROM 'boolean'
      OR p_catalog - ARRAY['schemaVersion', 'relations', 'truncated'] <> '{}'::jsonb
      OR octet_length(p_catalog::text) > 1048576
    THEN RAISE EXCEPTION 'invalid connection catalog result'; END IF;
    v_count := jsonb_array_length(p_catalog->'relations');
    IF v_count > 100 THEN RAISE EXCEPTION 'connection catalog relation limit exceeded'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_catalog->'relations') item
      GROUP BY item->>'schema', item->>'name' HAVING count(*) > 1)
    THEN RAISE EXCEPTION 'duplicate connection catalog relation'; END IF;
    FOR v_descriptor IN SELECT value FROM jsonb_array_elements(p_catalog->'relations') LOOP
      IF jsonb_typeof(v_descriptor) IS DISTINCT FROM 'object'
        OR NOT (v_descriptor ?& ARRAY['schema', 'name', 'kind', 'columns', 'stable_key',
          'unsupported_reasons', 'schema_fingerprint_sha256'])
        OR v_descriptor - ARRAY['schema', 'name', 'kind', 'columns', 'stable_key',
          'unsupported_reasons', 'schema_fingerprint_sha256'] <> '{}'::jsonb
        OR octet_length(v_descriptor::text) > 49152
        OR jsonb_typeof(v_descriptor->'schema') IS DISTINCT FROM 'string'
        OR NOT COALESCE(v_descriptor->>'schema' = ANY(v_connection.allowed_schemas), false)
        OR jsonb_typeof(v_descriptor->'name') IS DISTINCT FROM 'string'
        OR octet_length(v_descriptor->>'name') NOT BETWEEN 1 AND 63
        OR v_descriptor->>'kind' NOT IN ('r', 'm', 'v', 'p', 'f')
        OR jsonb_typeof(v_descriptor->'kind') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_descriptor->'columns') IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_descriptor->'unsupported_reasons') IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_descriptor->'stable_key') NOT IN ('string', 'null')
        OR jsonb_typeof(v_descriptor->'schema_fingerprint_sha256') IS DISTINCT FROM 'string'
        OR v_descriptor->>'schema_fingerprint_sha256' !~ '^[0-9a-f]{64}$'
      THEN RAISE EXCEPTION 'invalid connection catalog descriptor'; END IF;
      IF jsonb_array_length(v_descriptor->'columns') > 256
        OR jsonb_array_length(v_descriptor->'unsupported_reasons') > 6
        OR (jsonb_typeof(v_descriptor->'stable_key') = 'string'
          AND octet_length(v_descriptor->>'stable_key') NOT BETWEEN 1 AND 63)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_descriptor->'unsupported_reasons') reason
          WHERE jsonb_typeof(reason) IS DISTINCT FROM 'string'
            OR reason #>> '{}' NOT IN ('relation_kind_unsupported', 'inherited_relation_unsupported',
            'column_limit_exceeded', 'stable_key_ambiguous', 'stable_key_unavailable', 'geometry_unavailable'))
      THEN RAISE EXCEPTION 'invalid connection catalog descriptor'; END IF;
      FOR v_column IN SELECT value FROM jsonb_array_elements(v_descriptor->'columns') LOOP
        IF jsonb_typeof(v_column) IS DISTINCT FROM 'object'
          OR NOT (v_column ?& ARRAY['name', 'type_schema', 'type_name', 'not_null', 'type_modifier',
            'geometry', 'unique_key', 'primary_key'])
          OR v_column - ARRAY['name', 'type_schema', 'type_name', 'not_null', 'type_modifier',
            'geometry', 'unique_key', 'primary_key'] <> '{}'::jsonb
          OR jsonb_typeof(v_column->'name') IS DISTINCT FROM 'string'
          OR octet_length(v_column->>'name') NOT BETWEEN 1 AND 63
          OR jsonb_typeof(v_column->'type_schema') IS DISTINCT FROM 'string'
          OR octet_length(v_column->>'type_schema') NOT BETWEEN 1 AND 63
          OR jsonb_typeof(v_column->'type_name') IS DISTINCT FROM 'string'
          OR octet_length(v_column->>'type_name') NOT BETWEEN 1 AND 63
          OR jsonb_typeof(v_column->'not_null') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(v_column->'unique_key') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(v_column->'primary_key') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(v_column->'type_modifier') IS DISTINCT FROM 'number'
          OR (v_column->>'type_modifier') !~ '^-?[0-9]{1,10}$'
          OR jsonb_typeof(v_column->'geometry') NOT IN ('object', 'null')
        THEN RAISE EXCEPTION 'invalid connection catalog column'; END IF;
        IF jsonb_typeof(v_column->'geometry') = 'object' AND (
          NOT (v_column->'geometry' ?& ARRAY['geometry_type', 'srid', 'postgis_schema'])
          OR (v_column->'geometry') - ARRAY['geometry_type', 'srid', 'postgis_schema'] <> '{}'::jsonb
          OR jsonb_typeof(v_column->'geometry'->'postgis_schema') IS DISTINCT FROM 'string'
          OR octet_length(v_column->'geometry'->>'postgis_schema') NOT BETWEEN 1 AND 63
          OR jsonb_typeof(v_column->'geometry'->'geometry_type') NOT IN ('string', 'null')
          OR (jsonb_typeof(v_column->'geometry'->'geometry_type') = 'string'
            AND (v_column->'geometry'->>'geometry_type') !~ '^[A-Z]{1,40}$')
          OR jsonb_typeof(v_column->'geometry'->'srid') NOT IN ('number', 'null')
          OR (jsonb_typeof(v_column->'geometry'->'srid') = 'number'
            AND (v_column->'geometry'->>'srid') !~ '^[0-9]{1,10}$')
        ) THEN RAISE EXCEPTION 'invalid connection catalog geometry'; END IF;
      END LOOP;
      INSERT INTO app.external_connection_catalog_relations
        (organization_id, project_id, discovery_id, ordinal, schema_name,
         relation_name, schema_fingerprint_sha256, descriptor)
      VALUES (v_job.organization_id, v_job.project_id, v_job.id, v_ordinal,
        v_descriptor->>'schema', v_descriptor->>'name',
        v_descriptor->>'schema_fingerprint_sha256', v_descriptor);
      v_ordinal := v_ordinal + 1;
    END LOOP;
  END IF;
  UPDATE app.external_connection_catalog_discoveries
  SET state = CASE WHEN p_error_code IS NULL THEN 'completed' ELSE 'failed' END,
    worker_token = NULL, lease_expires_at = NULL, relation_count = v_count,
    truncated = CASE WHEN p_error_code IS NULL THEN (p_catalog->>'truncated')::boolean ELSE false END,
    sanitized_error_code = p_error_code, finished_at = v_now WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, v_job.requested_by, v_job.project_id,
    CASE WHEN p_error_code IS NULL THEN 'connection.catalog.completed' ELSE 'connection.catalog.failed' END,
    'connection', v_job.connection_id, 'catalog:' || v_job.id::text,
    jsonb_build_object('discovery_id', v_job.id, 'connection_revision_number', v_job.connection_revision_number,
      'relation_count', v_count, 'error_code', p_error_code, 'attempt_count', v_job.attempt_count));
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_external_connection_catalog_discovery(
  p_discovery_id uuid, p_worker_token uuid, p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE v_job app.external_connection_catalog_discoveries%ROWTYPE;
BEGIN
  IF p_discovery_id IS NULL OR p_worker_token IS NULL OR p_max_attempts IS NULL
    OR p_max_attempts NOT BETWEEN 1 AND 3
  THEN RAISE EXCEPTION 'invalid connection catalog release'; END IF;
  SELECT discovery.* INTO v_job FROM app.external_connection_catalog_discoveries discovery
  WHERE discovery.id = p_discovery_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token IS DISTINCT FROM p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN 'lost'; END IF;
  IF v_job.attempt_count >= p_max_attempts THEN
    RETURN CASE WHEN app.complete_external_connection_catalog_discovery(
      p_discovery_id, p_worker_token, NULL, 'catalog_failed') THEN 'failed' ELSE 'lost' END;
  END IF;
  UPDATE app.external_connection_catalog_discoveries
  SET state = 'queued', worker_token = NULL, lease_expires_at = NULL, started_at = NULL
  WHERE id = v_job.id;
  RETURN 'queued';
END;
$$;

GRANT SELECT ON app.external_connection_catalog_discoveries,
  app.external_connection_catalog_relations TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.external_connection_catalog_discoveries,
  app.external_connection_catalog_relations FROM opengeo_runtime;
REVOKE ALL ON app.external_connection_catalog_discoveries,
  app.external_connection_catalog_relations FROM opengeo_worker, opengeo_connector;
REVOKE EXECUTE ON FUNCTION
  app.request_external_connection_catalog_discovery(uuid, integer, text),
  app.cancel_external_connection_catalog_discovery(uuid),
  app.claim_external_connection_catalog_discovery(uuid, uuid, integer),
  app.complete_external_connection_catalog_discovery(uuid, uuid, jsonb, text),
  app.release_external_connection_catalog_discovery(uuid, uuid, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector;
GRANT EXECUTE ON FUNCTION
  app.request_external_connection_catalog_discovery(uuid, integer, text),
  app.cancel_external_connection_catalog_discovery(uuid)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_external_connection_catalog_discovery(uuid, uuid, integer),
  app.complete_external_connection_catalog_discovery(uuid, uuid, jsonb, text),
  app.release_external_connection_catalog_discovery(uuid, uuid, integer)
TO opengeo_connector;

COMMENT ON TABLE app.external_connection_catalog_discoveries IS
  'Revision-pinned, tenant/project-visible secret-free PostGIS discovery history; queue messages contain only the discovery ID. Prior successful jobs remain intact.';
COMMENT ON TABLE app.external_connection_catalog_relations IS
  'Immutable discovery result descriptors, each bounded to 48 KiB; read with an ordinal cursor and bounded page size for Data API limits. Metadata does not register a Layer or copy source data.';
COMMENT ON FUNCTION app.claim_external_connection_catalog_discovery(uuid, uuid, integer) IS
  'Connector-only leased catalog claim; credentials remain unavailable to the API runtime and GIS worker.';

COMMIT;
