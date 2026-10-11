BEGIN;

CREATE TYPE app.basemap_connection_provider AS ENUM ('protomaps');
CREATE TYPE app.basemap_connection_status AS ENUM ('draft', 'configured', 'disabled');

CREATE FUNCTION app.basemap_connection_origins_are_safe(p_origins text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_origin text;
  v_port text;
  v_seen text[] := ARRAY[]::text[];
BEGIN
  IF cardinality(p_origins) < 1 OR cardinality(p_origins) > 16 THEN
    RETURN false;
  END IF;
  FOREACH v_origin IN ARRAY p_origins LOOP
    IF v_origin IS NULL
       OR octet_length(v_origin) > 512
       OR v_origin <> btrim(v_origin)
       OR v_origin !~ '^https?://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$'
       OR v_origin ~ '[[:cntrl:][:space:]]'
       OR lower(v_origin) = ANY(v_seen) THEN
      RETURN false;
    END IF;
    v_port := substring(v_origin FROM ':([0-9]{1,5})$');
    IF v_port IS NOT NULL AND (v_port::integer < 1 OR v_port::integer > 65535) THEN
      RETURN false;
    END IF;
    v_seen := array_append(v_seen, lower(v_origin));
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE app.user_basemap_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  provider app.basemap_connection_provider NOT NULL,
  display_name text NOT NULL,
  allowed_origins text[] NOT NULL,
  secret_arn text,
  configured_secret_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  credential_revision bigint NOT NULL DEFAULT 0,
  status app.basemap_connection_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES app.organization_memberships (organization_id, user_id),
  CONSTRAINT user_basemap_connections_name_bounded CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT user_basemap_connections_origins_safe CHECK (
    app.basemap_connection_origins_are_safe(allowed_origins)
  ),
  CONSTRAINT user_basemap_connections_secret_reference_safe CHECK (
    (
      secret_arn IS NULL
      AND configured_secret_fields = ARRAY[]::text[]
      AND credential_revision = 0
      AND status IN ('draft', 'disabled')
    )
    OR (
      secret_arn ~ '^arn:aws(?:-us-gov)?:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:opengeo/[A-Za-z0-9/_+=.@-]+$'
      AND configured_secret_fields = ARRAY['api_key']::text[]
      AND credential_revision > 0
      AND status IN ('configured', 'disabled')
    )
  )
);

CREATE INDEX user_basemap_connections_owner_idx
  ON app.user_basemap_connections
    (organization_id, owner_user_id, updated_at DESC, id);

CREATE TABLE app.project_basemap_connection_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  display_name text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, connection_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.user_basemap_connections (organization_id, id),
  FOREIGN KEY (organization_id, created_by)
    REFERENCES app.organization_memberships (organization_id, user_id),
  CONSTRAINT project_basemap_connection_bindings_name_bounded CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 200
  )
);

CREATE INDEX project_basemap_connection_bindings_connection_idx
  ON app.project_basemap_connection_bindings
    (organization_id, connection_id, project_id);

CREATE TRIGGER user_basemap_connections_set_updated_at
  BEFORE UPDATE ON app.user_basemap_connections
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.user_basemap_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_basemap_connection_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_basemap_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_basemap_connection_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY user_basemap_connections_select ON app.user_basemap_connections
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND (
      owner_user_id = app.current_user_id()
      OR app.current_user_is_organization_admin()
      OR EXISTS (
        SELECT 1
        FROM app.project_basemap_connection_bindings binding
        WHERE binding.organization_id = user_basemap_connections.organization_id
          AND binding.connection_id = user_basemap_connections.id
          AND app.effective_project_role(binding.project_id) IS NOT NULL
      )
    )
  );
CREATE POLICY user_basemap_connections_insert ON app.user_basemap_connections
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );
CREATE POLICY user_basemap_connections_update ON app.user_basemap_connections
  FOR UPDATE USING (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  ) WITH CHECK (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );
CREATE POLICY user_basemap_connections_delete ON app.user_basemap_connections
  FOR DELETE USING (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );

CREATE POLICY project_basemap_connection_bindings_select
  ON app.project_basemap_connection_bindings
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) IS NOT NULL
      OR app.current_user_is_organization_admin()
      OR created_by = app.current_user_id()
    )
  );
CREATE POLICY project_basemap_connection_bindings_insert
  ON app.project_basemap_connection_bindings
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND created_by = app.current_user_id()
    AND (
      app.effective_project_role(project_id) = 'owner'
      OR app.current_user_is_organization_admin()
    )
    AND EXISTS (
      SELECT 1 FROM app.user_basemap_connections connection
      WHERE connection.organization_id = project_basemap_connection_bindings.organization_id
        AND connection.id = project_basemap_connection_bindings.connection_id
        AND connection.owner_user_id = app.current_user_id()
    )
  );
CREATE POLICY project_basemap_connection_bindings_delete
  ON app.project_basemap_connection_bindings
  FOR DELETE USING (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) = 'owner'
      OR app.current_user_is_organization_admin()
      OR created_by = app.current_user_id()
    )
  );

CREATE FUNCTION app.prepare_user_basemap_connection_credential_rotation(
  p_connection_id uuid
)
RETURNS TABLE (
  current_secret_arn text,
  credential_revision bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT connection.secret_arn, connection.credential_revision
  FROM app.user_basemap_connections connection
  WHERE connection.organization_id = app.current_organization_id()
    AND connection.owner_user_id = app.current_user_id()
    AND connection.id = p_connection_id
    AND connection.status <> 'disabled'
$$;

CREATE FUNCTION app.commit_user_basemap_connection_credential_rotation(
  p_connection_id uuid,
  p_expected_revision bigint,
  p_secret_arn text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  UPDATE app.user_basemap_connections connection
  SET secret_arn = p_secret_arn,
      configured_secret_fields = ARRAY['api_key']::text[],
      credential_revision = p_expected_revision + 1,
      status = 'configured'
  WHERE connection.organization_id = app.current_organization_id()
    AND connection.owner_user_id = app.current_user_id()
    AND connection.id = p_connection_id
    AND connection.credential_revision = p_expected_revision
    AND connection.status <> 'disabled';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.prepare_project_basemap_style_resolution(
  p_project_id uuid,
  p_binding_id uuid
)
RETURNS TABLE (
  provider app.basemap_connection_provider,
  connection_id uuid,
  connection_name text,
  secret_arn text,
  credential_revision bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT connection.provider, connection.id, connection.display_name,
         connection.secret_arn, connection.credential_revision
  FROM app.project_basemap_connection_bindings binding
  JOIN app.user_basemap_connections connection
    ON connection.organization_id = binding.organization_id
   AND connection.id = binding.connection_id
  WHERE binding.organization_id = app.current_organization_id()
    AND binding.project_id = p_project_id
    AND binding.id = p_binding_id
    AND connection.status = 'configured'
    AND connection.secret_arn IS NOT NULL
    AND app.effective_project_role(binding.project_id) IS NOT NULL
$$;

GRANT SELECT (
  id, organization_id, owner_user_id, provider, display_name, allowed_origins,
  configured_secret_fields, credential_revision, status, created_at, updated_at
) ON app.user_basemap_connections TO opengeo_runtime;
GRANT INSERT (
  id, organization_id, owner_user_id, provider, display_name, allowed_origins,
  status
) ON app.user_basemap_connections TO opengeo_runtime;
GRANT UPDATE (
  display_name, allowed_origins, status
) ON app.user_basemap_connections TO opengeo_runtime;
GRANT SELECT, DELETE ON app.project_basemap_connection_bindings TO opengeo_runtime;
GRANT INSERT (
  id, organization_id, project_id, connection_id, display_name, created_by
) ON app.project_basemap_connection_bindings TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION
  app.basemap_connection_origins_are_safe(text[]),
  app.prepare_user_basemap_connection_credential_rotation(uuid),
  app.commit_user_basemap_connection_credential_rotation(uuid, bigint, text),
  app.prepare_project_basemap_style_resolution(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.basemap_connection_origins_are_safe(text[]),
  app.prepare_user_basemap_connection_credential_rotation(uuid),
  app.commit_user_basemap_connection_credential_rotation(uuid, bigint, text),
  app.prepare_project_basemap_style_resolution(uuid, uuid)
TO opengeo_runtime;

REVOKE ALL ON
  app.user_basemap_connections,
  app.project_basemap_connection_bindings
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator,
     opengeo_dataset_verifier;

COMMENT ON TABLE app.user_basemap_connections IS
  'Reusable user-owned browser basemap provider metadata. API keys are stored in Secrets Manager and disclosed only by an authorized project style resolution.';
COMMENT ON TABLE app.project_basemap_connection_bindings IS
  'Explicit project references to reusable browser basemap provider connections.';
COMMENT ON FUNCTION app.prepare_project_basemap_style_resolution(uuid, uuid) IS
  'Returns an opaque secret reference only for an authorized configured project binding.';

COMMIT;
