BEGIN;
ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'postgis';
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'postgis';
ALTER TYPE app.external_source_access_mode ADD VALUE IF NOT EXISTS 'server_mediated';
ALTER TYPE app.external_source_credential_mode ADD VALUE IF NOT EXISTS 'connection_reference';
ALTER TYPE app.external_source_verification_state ADD VALUE IF NOT EXISTS 'catalog_described';
COMMIT;

BEGIN;
-- Metadata-only registration and ephemeral preview reuse canonical Layer identity.
-- In particular, do not alter 0157's larger COG metadata allowance.
ALTER TABLE app.datasets DROP CONSTRAINT datasets_source_format_match;
ALTER TABLE app.datasets ADD CONSTRAINT datasets_source_format_match CHECK (
  (source_type IN ('upload', 'repository')
    AND format NOT IN ('xyz', 'wms', 'arcgis', 'wfs', 'imageserver', 'mapserver', 'postgis'))
  OR (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs', 'imageserver', 'mapserver', 'cog', 'postgis')
    AND source_type::text = format::text)
);
ALTER TABLE app.external_sources DROP CONSTRAINT external_sources_supported_type;
ALTER TABLE app.external_sources ADD CONSTRAINT external_sources_supported_type
  CHECK (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs', 'imageserver', 'mapserver', 'cog', 'postgis'));
ALTER TABLE app.external_sources ADD CONSTRAINT external_sources_connection_mode CHECK (
  (source_type = 'postgis' AND access_mode = 'server_mediated' AND credential_mode = 'connection_reference')
  OR (source_type <> 'postgis' AND access_mode = 'direct_browser' AND credential_mode = 'none')
);
ALTER TABLE app.external_source_revisions DROP CONSTRAINT external_source_revision_url_bounded;
ALTER TABLE app.external_source_revisions ADD CONSTRAINT external_source_revision_url_bounded CHECK (
  char_length(source_url) BETWEEN 9 AND 2048 AND source_url !~ '[[:cntrl:]\\]'
  AND (left(source_url, 8) = 'https://' OR source_url ~
    '^urn:opengeo:postgis:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,2}$')
);

CREATE TABLE app.external_connection_source_bindings (
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  schema_name text NOT NULL CHECK (octet_length(schema_name) BETWEEN 1 AND 63),
  relation_name text NOT NULL CHECK (octet_length(relation_name) BETWEEN 1 AND 63),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id),
  UNIQUE (organization_id, connection_id, schema_name, relation_name),
  FOREIGN KEY (organization_id, dataset_id) REFERENCES app.external_sources (organization_id, dataset_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id, project_id, connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id)
);
CREATE TABLE app.external_postgis_layer_registrations (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_definition jsonb NOT NULL CHECK (
    jsonb_typeof(request_definition) = 'object' AND octet_length(request_definition::text) <= 8192),
  dataset_id uuid NOT NULL,
  source_version bigint NOT NULL,
  created boolean NOT NULL,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, connection_id, request_key),
  FOREIGN KEY (organization_id, dataset_id, source_version)
    REFERENCES app.external_source_revisions (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.external_connections (organization_id, id)
);

-- This helper is private to the fixed functions. Unlike discovery authority it
-- accepts active owners, explicit Layer grants and any active linked-project role.
CREATE FUNCTION app.external_postgis_layer_readable(p_organization uuid, p_dataset uuid, p_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.datasets dataset
    JOIN app.organizations organization ON organization.id = dataset.organization_id AND organization.status = 'active'
    JOIN app.organization_memberships member ON member.organization_id = organization.id AND member.user_id = p_actor
    WHERE dataset.organization_id = p_organization AND dataset.id = p_dataset AND dataset.status = 'active'
      AND (member.role = 'admin' OR dataset.owner_user_id = p_actor
        OR EXISTS (SELECT 1 FROM app.dataset_permissions permission
          WHERE permission.organization_id = p_organization AND permission.dataset_id = p_dataset
            AND permission.user_id = p_actor AND permission.role IN ('manage', 'edit', 'view', 'download'))
        OR EXISTS (SELECT 1 FROM app.project_datasets link
          WHERE link.organization_id = p_organization AND link.dataset_id = p_dataset
            AND app.background_project_role(p_organization, link.project_id, p_actor) IS NOT NULL))
  )
$$;

CREATE FUNCTION app.external_postgis_configuration_valid(
  p_organization uuid, p_dataset uuid, p_source_url text, p_configuration jsonb
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT COALESCE(jsonb_typeof(p_configuration) = 'object'
    AND p_configuration ?& ARRAY['service_kind', 'connection_id', 'connection_revision_number',
      'catalog_discovery_id', 'catalog_relation_ordinal', 'schema_name', 'relation_name',
      'schema_fingerprint_sha256', 'geometry_column', 'stable_key']
    AND p_configuration - ARRAY['service_kind', 'connection_id', 'connection_revision_number',
      'catalog_discovery_id', 'catalog_relation_ordinal', 'schema_name', 'relation_name',
      'schema_fingerprint_sha256', 'geometry_column', 'stable_key'] = '{}'::jsonb
    AND EXISTS (
      SELECT 1 FROM app.external_connection_source_bindings binding
      JOIN app.external_connection_catalog_discoveries discovery ON discovery.organization_id = binding.organization_id
        AND discovery.project_id = binding.project_id AND discovery.connection_id = binding.connection_id
        AND discovery.id::text = p_configuration->>'catalog_discovery_id' AND discovery.state = 'completed'
      JOIN app.external_connection_catalog_relations relation ON relation.discovery_id = discovery.id
        AND relation.organization_id = binding.organization_id AND relation.project_id = binding.project_id
        AND relation.ordinal::text = p_configuration->>'catalog_relation_ordinal'
        AND relation.schema_name = binding.schema_name AND relation.relation_name = binding.relation_name
      WHERE binding.organization_id = p_organization AND binding.dataset_id = p_dataset
        AND p_configuration->>'service_kind' = 'postgis'
        AND p_configuration->>'connection_id' = binding.connection_id::text
        AND p_configuration->'connection_revision_number' = to_jsonb(discovery.connection_revision_number)
        AND p_configuration->'catalog_relation_ordinal' = to_jsonb(relation.ordinal)
        AND p_configuration->>'schema_name' = binding.schema_name
        AND p_configuration->>'relation_name' = binding.relation_name
        AND p_configuration->>'schema_fingerprint_sha256' = relation.schema_fingerprint_sha256
        AND p_configuration->>'stable_key' = relation.descriptor->>'stable_key'
        AND relation.descriptor->>'kind' = 'r'
        AND relation.descriptor->'unsupported_reasons' = '[]'::jsonb
        AND jsonb_array_length(relation.descriptor->'columns') BETWEEN 1 AND 64
        AND (SELECT count(*) FROM jsonb_array_elements(relation.descriptor->'columns') column_definition
          WHERE jsonb_typeof(column_definition->'geometry') = 'object') = 1
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(relation.descriptor->'columns') column_definition
          WHERE jsonb_typeof(column_definition->'geometry') <> 'object' AND (
            column_definition->>'type_schema' <> 'pg_catalog' OR column_definition->>'type_name' NOT IN (
              'bool', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'text', 'varchar', 'bpchar',
              'uuid', 'date', 'timestamp', 'timestamptz')))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(relation.descriptor->'columns') column_definition
          WHERE column_definition->>'name' = p_configuration->>'stable_key'
            AND column_definition->>'type_schema' = 'pg_catalog'
            AND column_definition->>'type_name' IN ('int2', 'int4', 'int8', 'text', 'varchar', 'uuid')
            AND column_definition->'not_null' = 'true'::jsonb AND column_definition->'unique_key' = 'true'::jsonb)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(relation.descriptor->'columns') column_definition
          WHERE column_definition->>'name' = p_configuration->>'geometry_column'
            AND column_definition->'geometry'->'srid' = '4326'::jsonb
            AND column_definition->'geometry'->>'geometry_type' IN
              ('POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON'))
        AND p_source_url = 'urn:opengeo:postgis:' || binding.connection_id::text || ':' || discovery.id::text || ':' || relation.ordinal::text
    ), false)
$$;

CREATE FUNCTION app.enforce_external_postgis_source()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE v_type text;
BEGIN
  IF TG_TABLE_NAME = 'external_sources' THEN
    IF NEW.source_type = 'postgis' AND NOT EXISTS (
      SELECT 1 FROM app.external_connection_source_bindings binding
      WHERE binding.organization_id = NEW.organization_id AND binding.dataset_id = NEW.dataset_id)
    THEN RAISE EXCEPTION 'PostGIS sources require a registered connection binding'; END IF;
  ELSE
    SELECT source_type::text INTO v_type FROM app.external_sources
    WHERE organization_id = NEW.organization_id AND dataset_id = NEW.dataset_id;
    IF v_type = 'postgis' THEN
      IF NEW.verification_state <> 'catalog_described' OR NOT app.external_postgis_configuration_valid(
        NEW.organization_id, NEW.dataset_id, NEW.source_url, NEW.configuration)
      THEN RAISE EXCEPTION 'invalid registered PostGIS source definition'; END IF;
    ELSIF left(NEW.source_url, 8) <> 'https://' OR NEW.verification_state <> 'syntax_only'
      OR NEW.configuration->>'service_kind' = 'postgis'
    THEN RAISE EXCEPTION 'ordinary external sources require HTTPS and syntax verification'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_sources_postgis_binding BEFORE INSERT ON app.external_sources
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_postgis_source();
CREATE TRIGGER external_source_revisions_postgis_binding BEFORE INSERT ON app.external_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_postgis_source();
CREATE TRIGGER external_connection_source_bindings_immutable BEFORE UPDATE OR DELETE ON app.external_connection_source_bindings
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_mutation();
CREATE TRIGGER external_postgis_layer_registrations_immutable BEFORE UPDATE OR DELETE ON app.external_postgis_layer_registrations
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_mutation();

CREATE FUNCTION app.register_external_postgis_layer(
  p_connection_id uuid, p_discovery_id uuid, p_ordinal integer,
  p_expected_connection_revision bigint, p_schema_fingerprint_sha256 text,
  p_geometry_column text, p_name text, p_description text,
  p_expected_source_version bigint, p_request_key uuid
)
RETURNS TABLE (dataset_id uuid, source_version bigint, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_connection app.external_connections%ROWTYPE;
  v_relation app.external_connection_catalog_relations%ROWTYPE;
  v_binding app.external_connection_source_bindings%ROWTYPE;
  v_receipt app.external_postgis_layer_registrations%ROWTYPE;
  v_previous app.external_source_revisions%ROWTYPE;
  v_request jsonb;
  v_configuration jsonb;
  v_url text;
BEGIN
  IF p_connection_id IS NULL OR p_discovery_id IS NULL OR p_ordinal IS NULL OR p_ordinal NOT BETWEEN 1 AND 100
    OR p_expected_connection_revision IS NULL OR p_expected_connection_revision < 1 OR p_request_key IS NULL
    OR p_schema_fingerprint_sha256 IS NULL OR p_schema_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
    OR p_geometry_column IS NULL OR octet_length(p_geometry_column) NOT BETWEEN 1 AND 63
    OR p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 200
    OR (p_description IS NOT NULL AND octet_length(p_description) > 4000)
    OR (p_expected_source_version IS NOT NULL AND p_expected_source_version < 1)
  THEN RAISE EXCEPTION 'invalid PostGIS registration request'; END IF;
  SELECT connection.* INTO v_connection FROM app.external_connections connection
  WHERE connection.organization_id = app.current_organization_id() AND connection.id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'external connection not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.organization_memberships member
    JOIN app.organizations organization ON organization.id = member.organization_id AND organization.status = 'active'
    JOIN app.projects project ON project.organization_id = organization.id AND project.id = v_connection.project_id AND project.status = 'active'
    WHERE member.organization_id = v_connection.organization_id AND member.user_id = app.current_user_id()
      AND (member.role = 'admin' OR app.background_project_role(organization.id, project.id, member.user_id)::text = 'owner'))
  THEN RAISE EXCEPTION 'PostGIS registration requires connection manage and source create authority'; END IF;
  v_request := jsonb_build_object('discovery_id', p_discovery_id, 'ordinal', p_ordinal,
    'connection_revision', p_expected_connection_revision, 'fingerprint', p_schema_fingerprint_sha256,
    'geometry_column', p_geometry_column, 'name', p_name, 'description', p_description,
    'expected_source_version', p_expected_source_version);
  SELECT receipt.* INTO v_receipt FROM app.external_postgis_layer_registrations receipt
  WHERE receipt.organization_id = v_connection.organization_id AND receipt.connection_id = v_connection.id AND receipt.request_key = p_request_key;
  IF FOUND THEN
    IF v_receipt.request_definition <> v_request THEN
      RAISE EXCEPTION 'PostGIS registration request key conflict' USING ERRCODE = '23505'; END IF;
    dataset_id := v_receipt.dataset_id; source_version := v_receipt.source_version; created := v_receipt.created;
    RETURN NEXT; RETURN;
  END IF;
  IF v_connection.current_revision_number <> p_expected_connection_revision THEN
    RAISE EXCEPTION 'PostGIS connection revision conflict' USING ERRCODE = '23505'; END IF;
  IF v_connection.status <> 'credentials_verified' OR v_connection.last_verified_at IS NULL
    OR v_connection.provider <> 'postgresql' OR NOT v_connection.read_only
    OR v_connection.tls_mode <> 'verify_full' OR v_connection.network_mode <> 'public_internet'
  THEN RAISE EXCEPTION 'external connection is not previewable'; END IF;
  SELECT relation.* INTO v_relation FROM app.external_connection_catalog_relations relation
  JOIN app.external_connection_catalog_discoveries discovery ON discovery.id = relation.discovery_id
    AND discovery.organization_id = relation.organization_id AND discovery.project_id = relation.project_id
  WHERE relation.organization_id = v_connection.organization_id AND relation.project_id = v_connection.project_id
    AND relation.discovery_id = p_discovery_id AND relation.ordinal = p_ordinal
    AND discovery.connection_id = v_connection.id AND discovery.connection_revision_number = p_expected_connection_revision
    AND discovery.state = 'completed' AND relation.schema_fingerprint_sha256 = p_schema_fingerprint_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'PostGIS catalog selection conflict' USING ERRCODE = '23505'; END IF;
  IF NOT (v_relation.schema_name = ANY(v_connection.allowed_schemas)) THEN
    RAISE EXCEPTION 'PostGIS catalog selection conflict' USING ERRCODE = '23505'; END IF;
  v_configuration := jsonb_build_object('service_kind', 'postgis', 'connection_id', v_connection.id,
    'connection_revision_number', p_expected_connection_revision, 'catalog_discovery_id', p_discovery_id,
    'catalog_relation_ordinal', p_ordinal, 'schema_name', v_relation.schema_name,
    'relation_name', v_relation.relation_name, 'schema_fingerprint_sha256', p_schema_fingerprint_sha256,
    'geometry_column', p_geometry_column, 'stable_key', v_relation.descriptor->>'stable_key');
  v_url := 'urn:opengeo:postgis:' || v_connection.id::text || ':' || p_discovery_id::text || ':' || p_ordinal::text;
  SELECT binding.* INTO v_binding FROM app.external_connection_source_bindings binding
  WHERE binding.organization_id = v_connection.organization_id AND binding.connection_id = v_connection.id
    AND binding.schema_name = v_relation.schema_name AND binding.relation_name = v_relation.relation_name;
  created := NOT FOUND;
  dataset_id := CASE WHEN created THEN gen_random_uuid() ELSE v_binding.dataset_id END;
  IF created THEN
    IF p_expected_source_version IS NOT NULL THEN
      RAISE EXCEPTION 'PostGIS source version conflict' USING ERRCODE = '23505'; END IF;
    INSERT INTO app.datasets (id, organization_id, name, description, classification, source_type, format,
      status, owner_user_id, created_by, updated_by)
    VALUES (dataset_id, v_connection.organization_id, p_name, p_description, 'internal', 'postgis', 'postgis',
      'active', app.current_user_id(), app.current_user_id(), app.current_user_id());
    INSERT INTO app.external_connection_source_bindings
      (organization_id, dataset_id, project_id, connection_id, schema_name, relation_name, created_by)
    VALUES (v_connection.organization_id, dataset_id, v_connection.project_id, v_connection.id,
      v_relation.schema_name, v_relation.relation_name, app.current_user_id());
    INSERT INTO app.external_sources (organization_id, dataset_id, source_type, access_mode, credential_mode, created_by)
    VALUES (v_connection.organization_id, dataset_id, 'postgis', 'server_mediated', 'connection_reference', app.current_user_id());
    INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
    VALUES (v_connection.organization_id, v_connection.project_id, dataset_id, app.current_user_id());
    source_version := 1;
  ELSE
    -- Re-registering preserves edited metadata, existing grants and every map pin.
    IF NOT app.external_postgis_layer_readable(v_connection.organization_id, dataset_id, app.current_user_id())
    THEN RAISE EXCEPTION 'PostGIS Layer not available'; END IF;
    SELECT revision.* INTO v_previous FROM app.external_source_revisions revision
    WHERE revision.organization_id = v_connection.organization_id AND revision.dataset_id = v_binding.dataset_id
    ORDER BY revision.version_number DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'PostGIS source history unavailable'; END IF;
    source_version := v_previous.version_number;
    IF p_expected_source_version IS NOT NULL AND p_expected_source_version <> source_version THEN
      RAISE EXCEPTION 'PostGIS source version conflict' USING ERRCODE = '23505'; END IF;
    IF v_previous.configuration <> v_configuration OR v_previous.source_url <> v_url THEN
      IF p_expected_source_version IS NULL THEN
        RAISE EXCEPTION 'PostGIS changed selection requires source version' USING ERRCODE = '23505'; END IF;
      source_version := source_version + 1;
    END IF;
  END IF;
  IF created OR source_version <> v_previous.version_number THEN
    INSERT INTO app.external_source_revisions
      (organization_id, dataset_id, version_number, source_url, configuration, verification_state, change_message, created_by)
    VALUES (v_connection.organization_id, dataset_id, source_version, v_url, v_configuration, 'catalog_described',
      CASE WHEN created THEN 'Registered selected PostGIS relation' ELSE 'Updated selected PostGIS relation' END, app.current_user_id());
    IF NOT created THEN
      UPDATE app.datasets dataset SET updated_by = app.current_user_id()
      WHERE dataset.organization_id = v_connection.organization_id AND dataset.id = v_binding.dataset_id;
    END IF;
  END IF;
  INSERT INTO app.external_postgis_layer_registrations
    (organization_id, connection_id, request_key, request_definition, dataset_id, source_version, created, requested_by)
  VALUES (v_connection.organization_id, v_connection.id, p_request_key, v_request,
    dataset_id, source_version, created, app.current_user_id());
  INSERT INTO app.activity_events (organization_id, actor_user_id, project_id, event_type, resource_type, resource_id, request_id, payload)
  VALUES (v_connection.organization_id, app.current_user_id(), v_connection.project_id, 'dataset.postgis.registered',
    'dataset', dataset_id, p_request_key::text, jsonb_build_object('connection_id', v_connection.id,
      'discovery_id', p_discovery_id, 'relation_ordinal', p_ordinal, 'source_version', source_version, 'created', created));
  RETURN NEXT;
END;
$$;

CREATE TABLE app.external_postgis_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  source_version bigint NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision_number bigint NOT NULL,
  request_key uuid NOT NULL,
  bbox jsonb NOT NULL CHECK (jsonb_typeof(bbox) = 'array' AND jsonb_array_length(bbox) = 4 AND octet_length(bbox::text) <= 1024),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  worker_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 seconds',
  returned_count integer CHECK (returned_count BETWEEN 0 AND 100),
  truncated boolean,
  sanitized_error_code text CHECK (sanitized_error_code IN ('preview_failed', 'preview_timeout', 'preview_limits_exceeded',
    'preview_schema_changed', 'preview_representation_unsupported', 'preview_geometry_unsupported', 'preview_row_too_large')),
  requested_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, dataset_id, requested_by, request_key),
  FOREIGN KEY (organization_id, dataset_id, source_version)
    REFERENCES app.external_source_revisions (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, project_id, connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id),
  FOREIGN KEY (organization_id, connection_id, connection_revision_number)
    REFERENCES app.external_connection_revisions (organization_id, connection_id, revision_number),
  CONSTRAINT external_postgis_preview_shape CHECK (
    (state = 'queued' AND worker_token IS NULL AND lease_expires_at IS NULL AND started_at IS NULL
      AND finished_at IS NULL AND returned_count IS NULL AND truncated IS NULL AND sanitized_error_code IS NULL)
    OR (state = 'running' AND worker_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL
      AND finished_at IS NULL AND returned_count IS NULL AND truncated IS NULL AND sanitized_error_code IS NULL)
    OR (state = 'completed' AND worker_token IS NULL AND lease_expires_at IS NULL AND started_at IS NOT NULL
      AND finished_at IS NOT NULL AND returned_count IS NOT NULL AND truncated IS NOT NULL AND sanitized_error_code IS NULL)
    OR (state IN ('failed', 'cancelled') AND worker_token IS NULL AND lease_expires_at IS NULL AND finished_at IS NOT NULL
      AND returned_count IS NULL AND truncated IS NULL AND sanitized_error_code IS NOT NULL))
);
CREATE UNIQUE INDEX external_postgis_previews_one_active_idx
  ON app.external_postgis_previews (organization_id, dataset_id, requested_by) WHERE state IN ('queued', 'running');

CREATE FUNCTION app.external_postgis_source_current(p_organization uuid, p_dataset uuid, p_actor uuid, p_version bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, app
AS $$
  SELECT app.external_postgis_layer_readable(p_organization, p_dataset, p_actor) AND EXISTS (
    SELECT 1 FROM app.external_connection_source_bindings binding
    JOIN app.external_connections connection ON connection.organization_id = binding.organization_id
      AND connection.project_id = binding.project_id AND connection.id = binding.connection_id
    JOIN app.projects project ON project.organization_id = connection.organization_id AND project.id = connection.project_id AND project.status = 'active'
    JOIN app.external_sources source ON source.organization_id = binding.organization_id AND source.dataset_id = binding.dataset_id
      AND source.source_type = 'postgis' AND source.access_mode = 'server_mediated' AND source.credential_mode = 'connection_reference'
    JOIN app.external_source_revisions revision ON revision.organization_id = source.organization_id AND revision.dataset_id = source.dataset_id
      AND revision.version_number = p_version AND revision.verification_state = 'catalog_described'
    WHERE binding.organization_id = p_organization AND binding.dataset_id = p_dataset
      AND connection.provider = 'postgresql' AND connection.status = 'credentials_verified' AND connection.last_verified_at IS NOT NULL
      AND connection.read_only AND connection.tls_mode = 'verify_full' AND connection.network_mode = 'public_internet'
      AND binding.schema_name = ANY(connection.allowed_schemas)
      AND revision.configuration->>'connection_revision_number' = connection.current_revision_number::text
      AND revision.version_number = (SELECT max(latest.version_number) FROM app.external_source_revisions latest
        WHERE latest.organization_id = p_organization AND latest.dataset_id = p_dataset)
      AND app.external_postgis_configuration_valid(p_organization, p_dataset, revision.source_url, revision.configuration)
  )
$$;

CREATE FUNCTION app.prepare_external_postgis_preview(
  p_dataset_id uuid, p_expected_source_version bigint, p_request_key uuid, p_bbox jsonb
)
RETURNS TABLE (preview_id uuid, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_job app.external_postgis_previews%ROWTYPE; v_binding app.external_connection_source_bindings%ROWTYPE;
  v_revision app.external_source_revisions%ROWTYPE; v_bbox numeric[];
BEGIN
  IF p_dataset_id IS NULL OR p_expected_source_version IS NULL OR p_expected_source_version < 1 OR p_request_key IS NULL
    OR p_bbox IS NULL OR jsonb_typeof(p_bbox) <> 'array' OR jsonb_array_length(p_bbox) <> 4 OR octet_length(p_bbox::text) > 1024
  THEN RAISE EXCEPTION 'invalid PostGIS preview request'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_bbox) value WHERE jsonb_typeof(value) <> 'number')
  THEN RAISE EXCEPTION 'invalid PostGIS preview bounds'; END IF;
  SELECT array_agg((value #>> '{}')::numeric ORDER BY ordinal) INTO v_bbox
  FROM jsonb_array_elements(p_bbox) WITH ORDINALITY bounds(value, ordinal);
  IF v_bbox[1] < -180 OR v_bbox[3] > 180 OR v_bbox[2] < -90 OR v_bbox[4] > 90
    OR v_bbox[1] >= v_bbox[3] OR v_bbox[2] >= v_bbox[4]
  THEN RAISE EXCEPTION 'invalid PostGIS preview bounds'; END IF;
  PERFORM 1 FROM app.datasets dataset WHERE dataset.organization_id = app.current_organization_id()
    AND dataset.id = p_dataset_id FOR UPDATE;
  IF NOT FOUND OR NOT app.external_postgis_source_current(app.current_organization_id(), p_dataset_id,
    app.current_user_id(), p_expected_source_version)
  THEN RAISE EXCEPTION 'PostGIS preview source unavailable or stale' USING ERRCODE = '23505'; END IF;
  SELECT preview.* INTO v_job FROM app.external_postgis_previews preview
  WHERE preview.organization_id = app.current_organization_id() AND preview.dataset_id = p_dataset_id
    AND preview.requested_by = app.current_user_id() AND preview.request_key = p_request_key;
  IF FOUND THEN
    IF v_job.source_version <> p_expected_source_version OR v_job.bbox <> p_bbox THEN
      RAISE EXCEPTION 'PostGIS preview request key conflict' USING ERRCODE = '23505'; END IF;
    preview_id := v_job.id; state := v_job.state; RETURN NEXT; RETURN;
  END IF;
  UPDATE app.external_postgis_previews preview SET state = 'failed', worker_token = NULL, lease_expires_at = NULL,
    sanitized_error_code = 'preview_timeout', finished_at = clock_timestamp()
  WHERE preview.organization_id = app.current_organization_id() AND preview.dataset_id = p_dataset_id
    AND preview.requested_by = app.current_user_id() AND preview.state IN ('queued', 'running')
    AND (preview.expires_at <= clock_timestamp() OR (preview.state = 'running' AND preview.lease_expires_at <= clock_timestamp()));
  IF EXISTS (SELECT 1 FROM app.external_postgis_previews preview
    WHERE preview.organization_id = app.current_organization_id() AND preview.dataset_id = p_dataset_id
      AND preview.requested_by = app.current_user_id() AND preview.state IN ('queued', 'running'))
  THEN RAISE EXCEPTION 'PostGIS preview already active' USING ERRCODE = '23505'; END IF;
  SELECT binding.* INTO v_binding FROM app.external_connection_source_bindings binding
  WHERE binding.organization_id = app.current_organization_id() AND binding.dataset_id = p_dataset_id;
  SELECT revision.* INTO v_revision FROM app.external_source_revisions revision
  WHERE revision.organization_id = v_binding.organization_id AND revision.dataset_id = p_dataset_id
    AND revision.version_number = p_expected_source_version;
  INSERT INTO app.external_postgis_previews (organization_id, project_id, dataset_id, source_version, connection_id,
    connection_revision_number, request_key, bbox, requested_by)
  VALUES (v_binding.organization_id, v_binding.project_id, p_dataset_id, p_expected_source_version, v_binding.connection_id,
    (v_revision.configuration->>'connection_revision_number')::bigint, p_request_key, p_bbox, app.current_user_id())
  RETURNING id INTO preview_id;
  state := 'queued'; RETURN NEXT;
END;
$$;

CREATE FUNCTION app.claim_external_postgis_preview(p_preview_id uuid, p_worker_token uuid, p_lease_seconds integer)
RETURNS TABLE (claim_status text, preview_id uuid, organization_id uuid, project_id uuid,
  dataset_id uuid, source_version bigint, connection_id uuid, connection_revision_number bigint,
  provider text, endpoint_host text, endpoint_port integer, database_name text, allowed_schemas text[],
  tls_mode text, network_mode text, secret_arn text, source_configuration jsonb, bbox jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_job app.external_postgis_previews%ROWTYPE; v_connection app.external_connections%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_preview_id IS NULL OR p_worker_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 20
  THEN RAISE EXCEPTION 'invalid PostGIS preview claim'; END IF;
  preview_id := p_preview_id;
  SELECT preview.* INTO v_job FROM app.external_postgis_previews preview WHERE preview.id = p_preview_id FOR UPDATE;
  IF NOT FOUND THEN claim_status := 'not_found'; RETURN NEXT; RETURN; END IF;
  IF v_job.state <> 'queued' THEN claim_status := 'already_' || v_job.state; RETURN NEXT; RETURN; END IF;
  IF v_job.expires_at <= v_now OR NOT app.external_postgis_source_current(v_job.organization_id,
    v_job.dataset_id, v_job.requested_by, v_job.source_version)
  THEN
    UPDATE app.external_postgis_previews SET state = 'cancelled', sanitized_error_code = 'preview_failed', finished_at = v_now WHERE id = v_job.id;
    claim_status := 'not_previewable'; RETURN NEXT; RETURN;
  END IF;
  -- Hold the selected connection through claim commit; rotation/disable cannot
  -- slip between its current-state check and exposure of the secret locator.
  SELECT connection.* INTO v_connection FROM app.external_connections connection
  JOIN app.external_connection_source_bindings binding ON binding.organization_id = connection.organization_id
    AND binding.project_id = connection.project_id AND binding.connection_id = connection.id
    AND binding.dataset_id = v_job.dataset_id
  WHERE connection.organization_id = v_job.organization_id AND connection.project_id = v_job.project_id
    AND connection.id = v_job.connection_id AND connection.current_revision_number = v_job.connection_revision_number
  FOR SHARE OF connection;
  IF NOT FOUND OR NOT app.external_postgis_source_current(v_job.organization_id,
    v_job.dataset_id, v_job.requested_by, v_job.source_version)
  THEN
    UPDATE app.external_postgis_previews SET state = 'cancelled', sanitized_error_code = 'preview_failed', finished_at = v_now WHERE id = v_job.id;
    claim_status := 'not_previewable'; RETURN NEXT; RETURN;
  END IF;
  UPDATE app.external_postgis_previews SET state = 'running', worker_token = p_worker_token,
    lease_expires_at = LEAST(v_now + make_interval(secs => p_lease_seconds), expires_at), started_at = v_now WHERE id = v_job.id;
  organization_id := v_job.organization_id; project_id := v_job.project_id; dataset_id := v_job.dataset_id;
  source_version := v_job.source_version; connection_id := v_job.connection_id; connection_revision_number := v_job.connection_revision_number;
  provider := v_connection.provider::text; endpoint_host := v_connection.endpoint_host; endpoint_port := v_connection.endpoint_port;
  database_name := v_connection.database_name; allowed_schemas := v_connection.allowed_schemas;
  tls_mode := v_connection.tls_mode::text; network_mode := v_connection.network_mode::text; secret_arn := v_connection.secret_arn;
  SELECT revision.configuration INTO source_configuration FROM app.external_source_revisions revision
  WHERE revision.organization_id = v_job.organization_id AND revision.dataset_id = v_job.dataset_id AND revision.version_number = v_job.source_version;
  bbox := v_job.bbox; claim_status := 'claimed'; RETURN NEXT;
END;
$$;

CREATE FUNCTION app.complete_external_postgis_preview(
  p_preview_id uuid, p_worker_token uuid, p_returned integer, p_truncated boolean, p_error_code text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_job app.external_postgis_previews%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT preview.* INTO v_job FROM app.external_postgis_previews preview WHERE preview.id = p_preview_id FOR UPDATE;
  IF NOT FOUND OR p_worker_token IS NULL OR v_job.state <> 'running' OR v_job.worker_token IS DISTINCT FROM p_worker_token
    OR v_job.lease_expires_at <= v_now OR v_job.expires_at <= v_now
  THEN RETURN false; END IF;
  PERFORM 1 FROM app.external_connections connection
  WHERE connection.organization_id = v_job.organization_id AND connection.project_id = v_job.project_id
    AND connection.id = v_job.connection_id FOR SHARE;
  IF NOT app.external_postgis_source_current(v_job.organization_id, v_job.dataset_id, v_job.requested_by, v_job.source_version)
    OR NOT EXISTS (SELECT 1 FROM app.external_connection_source_bindings binding
      JOIN app.external_connections connection ON connection.organization_id = binding.organization_id
        AND connection.project_id = binding.project_id AND connection.id = binding.connection_id
      WHERE binding.organization_id = v_job.organization_id AND binding.dataset_id = v_job.dataset_id
        AND binding.project_id = v_job.project_id AND binding.connection_id = v_job.connection_id
        AND connection.current_revision_number = v_job.connection_revision_number)
  THEN
    UPDATE app.external_postgis_previews SET state = 'cancelled', worker_token = NULL, lease_expires_at = NULL,
      sanitized_error_code = 'preview_failed', finished_at = v_now WHERE id = v_job.id;
    RETURN false;
  END IF;
  IF (p_error_code IS NULL AND (p_returned IS NULL OR p_returned NOT BETWEEN 0 AND 100 OR p_truncated IS NULL))
    OR (p_error_code IS NOT NULL AND (p_returned IS NOT NULL OR p_truncated IS NOT NULL OR p_error_code NOT IN (
      'preview_failed', 'preview_timeout', 'preview_limits_exceeded', 'preview_schema_changed',
      'preview_representation_unsupported', 'preview_geometry_unsupported', 'preview_row_too_large')))
  THEN RAISE EXCEPTION 'invalid PostGIS preview completion'; END IF;
  UPDATE app.external_postgis_previews SET state = CASE WHEN p_error_code IS NULL THEN 'completed' ELSE 'failed' END,
    worker_token = NULL, lease_expires_at = NULL, returned_count = p_returned, truncated = p_truncated,
    sanitized_error_code = p_error_code, finished_at = v_now WHERE id = v_job.id;
  INSERT INTO app.activity_events (organization_id, actor_user_id, project_id, event_type, resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, v_job.requested_by, v_job.project_id,
    CASE WHEN p_error_code IS NULL THEN 'dataset.postgis.previewed' ELSE 'dataset.postgis.preview_failed' END,
    'dataset', v_job.dataset_id, v_job.request_key::text, jsonb_build_object('preview_id', v_job.id,
      'source_version', v_job.source_version, 'returned', p_returned, 'truncated', p_truncated, 'error_code', p_error_code));
  RETURN true;
END;
$$;

ALTER TABLE app.external_connection_source_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_source_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_postgis_layer_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_postgis_layer_registrations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_postgis_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_postgis_previews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.external_connection_source_bindings, app.external_postgis_layer_registrations, app.external_postgis_previews
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector;
REVOKE EXECUTE ON FUNCTION
  app.external_postgis_layer_readable(uuid, uuid, uuid),
  app.external_postgis_configuration_valid(uuid, uuid, text, jsonb),
  app.external_postgis_source_current(uuid, uuid, uuid, bigint),
  app.enforce_external_postgis_source(),
  app.register_external_postgis_layer(uuid, uuid, integer, bigint, text, text, text, text, bigint, uuid),
  app.prepare_external_postgis_preview(uuid, bigint, uuid, jsonb),
  app.claim_external_postgis_preview(uuid, uuid, integer),
  app.complete_external_postgis_preview(uuid, uuid, integer, boolean, text)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector;
GRANT EXECUTE ON FUNCTION
  app.register_external_postgis_layer(uuid, uuid, integer, bigint, text, text, text, text, bigint, uuid),
  app.prepare_external_postgis_preview(uuid, bigint, uuid, jsonb)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_external_postgis_preview(uuid, uuid, integer),
  app.complete_external_postgis_preview(uuid, uuid, integer, boolean, text)
TO opengeo_connector;

COMMENT ON TABLE app.external_connection_source_bindings IS
  'Immutable credential-free identity linking one existing canonical Layer to a connection/schema/relation; source revisions pin each selected catalog descriptor.';
COMMENT ON TABLE app.external_postgis_previews IS
  'Short-lived request/lease metadata and bounded counts only. No source feature bytes or preview result are retained; completed requests cannot re-execute.';
COMMIT;
