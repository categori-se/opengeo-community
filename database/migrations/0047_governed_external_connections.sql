BEGIN;

CREATE TYPE app.external_connection_provider AS ENUM ('postgresql');
CREATE TYPE app.external_connection_tls_mode AS ENUM ('verify_full');
CREATE TYPE app.external_connection_network_mode AS ENUM ('public_internet');
CREATE TYPE app.external_connection_status AS ENUM (
  'configuration_valid',
  'network_reachable',
  'credentials_verified',
  'catalog_verified',
  'degraded',
  'disabled',
  'revoked'
);

CREATE FUNCTION app.external_connection_schemas_are_safe(p_schemas text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  schema_name text;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF p_schemas IS NULL OR cardinality(p_schemas) NOT BETWEEN 1 AND 16 THEN
    RETURN false;
  END IF;
  FOREACH schema_name IN ARRAY p_schemas LOOP
    IF schema_name IS NULL
      OR schema_name !~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$'
      OR schema_name = ANY(seen)
    THEN
      RETURN false;
    END IF;
    seen := array_append(seen, schema_name);
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE app.external_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  provider app.external_connection_provider NOT NULL,
  display_name text NOT NULL,
  endpoint_host text NOT NULL,
  endpoint_port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  allowed_schemas text[] NOT NULL,
  read_only boolean NOT NULL DEFAULT true,
  tls_mode app.external_connection_tls_mode NOT NULL DEFAULT 'verify_full',
  network_mode app.external_connection_network_mode NOT NULL DEFAULT 'public_internet',
  secret_arn text NOT NULL,
  configured_secret_fields text[] NOT NULL,
  status app.external_connection_status NOT NULL DEFAULT 'configuration_valid',
  current_revision_number bigint NOT NULL DEFAULT 1,
  last_verified_at timestamptz,
  schema_fingerprint_sha256 text,
  sanitized_error_code text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  CONSTRAINT external_connections_display_name_bounded CHECK (
    display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT external_connections_endpoint_public_dns_shape CHECK (
    endpoint_host = lower(endpoint_host)
    AND char_length(endpoint_host) BETWEEN 4 AND 253
    AND endpoint_host ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND endpoint_host !~ '(^localhost$|\.localhost$|\.local$|\.internal$|\.home\.arpa$)'
    AND endpoint_host !~ '^[0-9.]+$'
    AND endpoint_port BETWEEN 1 AND 65535
  ),
  CONSTRAINT external_connections_database_name_safe CHECK (
    database_name ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$'
  ),
  CONSTRAINT external_connections_schemas_safe CHECK (
    app.external_connection_schemas_are_safe(allowed_schemas)
  ),
  CONSTRAINT external_connections_read_only CHECK (read_only),
  CONSTRAINT external_connections_initial_boundary CHECK (
    tls_mode = 'verify_full'
    AND network_mode = 'public_internet'
    AND status = 'configuration_valid'
    AND current_revision_number = 1
    AND last_verified_at IS NULL
    AND schema_fingerprint_sha256 IS NULL
    AND sanitized_error_code IS NULL
  ),
  CONSTRAINT external_connections_secret_reference_bounded CHECK (
    char_length(secret_arn) BETWEEN 40 AND 512
    AND secret_arn ~ '^arn:aws(?:-us-gov)?:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:opengeo/[A-Za-z0-9/_+=.@-]+$'
    AND configured_secret_fields = ARRAY['password', 'username']::text[]
  )
);

CREATE TABLE app.external_connection_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  configuration jsonb NOT NULL,
  change_summary text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, connection_id, revision_number),
  FOREIGN KEY (organization_id, project_id, connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id),
  CONSTRAINT external_connection_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT external_connection_revisions_configuration_bounded CHECK (
    jsonb_typeof(configuration) = 'object'
    AND octet_length(configuration::text) <= 8192
    AND configuration ?& ARRAY[
      'provider', 'endpointHost', 'endpointPort', 'databaseName',
      'allowedSchemas', 'readOnly', 'tlsMode', 'networkMode'
    ]
    AND configuration - ARRAY[
      'provider', 'endpointHost', 'endpointPort', 'databaseName',
      'allowedSchemas', 'readOnly', 'tlsMode', 'networkMode'
    ] = '{}'::jsonb
    AND configuration->>'provider' = 'postgresql'
    AND configuration->>'readOnly' = 'true'
    AND configuration->>'tlsMode' = 'verify_full'
    AND configuration->>'networkMode' = 'public_internet'
  ),
  CONSTRAINT external_connection_revisions_change_bounded CHECK (
    change_summary = btrim(change_summary)
    AND char_length(change_summary) BETWEEN 1 AND 500
  )
);

CREATE FUNCTION app.reject_external_connection_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external connection revisions are append-only';
END;
$$;

CREATE FUNCTION app.enforce_external_connection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_configuration jsonb;
  expected_revision bigint;
BEGIN
  SELECT
    jsonb_build_object(
      'provider', connection.provider::text,
      'endpointHost', connection.endpoint_host,
      'endpointPort', connection.endpoint_port,
      'databaseName', connection.database_name,
      'allowedSchemas', to_jsonb(connection.allowed_schemas),
      'readOnly', connection.read_only,
      'tlsMode', connection.tls_mode::text,
      'networkMode', connection.network_mode::text
    ),
    connection.current_revision_number
  INTO expected_configuration, expected_revision
  FROM app.external_connections connection
  WHERE connection.organization_id = NEW.organization_id
    AND connection.project_id = NEW.project_id
    AND connection.id = NEW.connection_id;

  IF expected_configuration IS NULL
    OR NEW.revision_number <> expected_revision
    OR NEW.configuration <> expected_configuration
  THEN
    RAISE EXCEPTION 'external connection revision must match its governed connection';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_connection_revisions_are_immutable
  BEFORE UPDATE OR DELETE ON app.external_connection_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_connection_revision_mutation();
CREATE TRIGGER external_connection_revisions_match_connection
  BEFORE INSERT ON app.external_connection_revisions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_connection_revision();

ALTER TABLE app.external_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_connection_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY external_connections_tenant_isolation ON app.external_connections
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY external_connection_revisions_tenant_isolation
  ON app.external_connection_revisions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT (
  id, organization_id, project_id, provider, display_name, endpoint_host,
  endpoint_port, database_name, allowed_schemas, read_only, tls_mode,
  network_mode, configured_secret_fields, status, current_revision_number,
  last_verified_at, schema_fingerprint_sha256, sanitized_error_code,
  created_by, created_at, updated_by, updated_at
) ON app.external_connections TO opengeo_runtime;
GRANT INSERT ON app.external_connections TO opengeo_runtime;
GRANT SELECT, INSERT ON app.external_connection_revisions TO opengeo_runtime;

REVOKE ALL ON app.external_connections, app.external_connection_revisions
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.external_connection_schemas_are_safe(text[]),
  app.enforce_external_connection_revision(),
  app.reject_external_connection_revision_mutation()
FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.external_connection_schemas_are_safe(text[])
TO opengeo_runtime;

COMMENT ON TABLE app.external_connections IS
  'Tenant/project-scoped credentialed connection identity. Secret references are database-private and never part of the public API.';
COMMENT ON TABLE app.external_connection_revisions IS
  'Append-only non-secret connection configurations. A revision does not assert network, credential, catalog, or query verification.';

COMMIT;
