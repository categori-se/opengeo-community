BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_runtime') THEN
    EXECUTE 'CREATE ROLE opengeo_runtime LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_runtime SET search_path = app, public;

CREATE TYPE app.organization_role AS ENUM ('admin', 'member', 'guest');
CREATE TYPE app.client_role AS ENUM ('client_admin', 'editor', 'viewer');
CREATE TYPE app.project_role AS ENUM ('owner', 'editor', 'reviewer', 'viewer');
CREATE TYPE app.record_status AS ENUM ('active', 'archived');

CREATE FUNCTION app.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'activity events are append-only';
END;
$$;

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT users_email_normalized CHECK (email = lower(email))
);

CREATE UNIQUE INDEX users_email_unique_ci ON app.users (lower(email));

CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status app.record_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organizations_slug_format
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE app.organization_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  role app.organization_role NOT NULL,
  invited_by uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_memberships_user_idx
  ON app.organization_memberships (user_id, organization_id);

CREATE TABLE app.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  name text NOT NULL,
  client_code text,
  description text,
  logo_object_id uuid,
  status app.record_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id)
);

CREATE INDEX clients_organization_status_idx
  ON app.clients (organization_id, status, updated_at DESC);
CREATE UNIQUE INDEX clients_organization_code_unique
  ON app.clients (organization_id, client_code)
  WHERE client_code IS NOT NULL;

CREATE TABLE app.client_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  client_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  role app.client_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, client_id, user_id),
  FOREIGN KEY (organization_id, client_id)
    REFERENCES app.clients (organization_id, id)
);

CREATE INDEX client_memberships_user_idx
  ON app.client_memberships (organization_id, user_id, client_id);

CREATE TABLE app.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  client_id uuid,
  name text NOT NULL,
  project_code text,
  description text,
  status app.record_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id)
    REFERENCES app.clients (organization_id, id)
);

CREATE INDEX projects_organization_client_status_idx
  ON app.projects (organization_id, client_id, status, updated_at DESC);
CREATE UNIQUE INDEX projects_organization_client_code_unique
  ON app.projects (
    organization_id,
    COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
    project_code
  )
  WHERE project_code IS NOT NULL;

CREATE TABLE app.project_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  role app.project_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, user_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE INDEX project_memberships_user_idx
  ON app.project_memberships (organization_id, user_id, project_id);

CREATE TABLE app.maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status app.record_status NOT NULL DEFAULT 'active',
  definition jsonb NOT NULL DEFAULT '{"layers": [], "bookmarks": []}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT maps_version_positive CHECK (version > 0),
  CONSTRAINT maps_definition_object
    CHECK (jsonb_typeof(definition) = 'object'),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE INDEX maps_project_status_idx
  ON app.maps (organization_id, project_id, status, updated_at DESC);

CREATE TABLE app.map_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  map_id uuid NOT NULL,
  version bigint NOT NULL,
  definition jsonb NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, map_id, version),
  CONSTRAINT map_versions_version_positive CHECK (version > 0),
  CONSTRAINT map_versions_definition_object
    CHECK (jsonb_typeof(definition) = 'object'),
  FOREIGN KEY (organization_id, map_id)
    REFERENCES app.maps (organization_id, id)
);

CREATE INDEX map_versions_history_idx
  ON app.map_versions (organization_id, map_id, version DESC);

CREATE TABLE app.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid,
  event_type text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  request_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT activity_event_type_format
    CHECK (event_type ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT activity_resource_type_format
    CHECK (resource_type ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT activity_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE INDEX activity_events_feed_idx
  ON app.activity_events (organization_id, project_id, occurred_at DESC, id);
CREATE INDEX activity_events_resource_idx
  ON app.activity_events (
    organization_id,
    resource_type,
    resource_id,
    occurred_at DESC
  );

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON app.organizations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER organization_memberships_set_updated_at
  BEFORE UPDATE ON app.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON app.clients
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER client_memberships_set_updated_at
  BEFORE UPDATE ON app.client_memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON app.projects
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER project_memberships_set_updated_at
  BEFORE UPDATE ON app.project_memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER maps_set_updated_at
  BEFORE UPDATE ON app.maps
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER activity_events_are_immutable
  BEFORE UPDATE OR DELETE ON app.activity_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.client_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.activity_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.clients FORCE ROW LEVEL SECURITY;
ALTER TABLE app.client_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.maps FORCE ROW LEVEL SECURITY;
ALTER TABLE app.map_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.activity_events FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_isolation ON app.organizations
  USING (id = app.current_organization_id())
  WITH CHECK (id = app.current_organization_id());

CREATE POLICY users_organization_read ON app.users
  FOR SELECT
  USING (
    id = app.current_user_id()
    OR EXISTS (
      SELECT 1
      FROM app.organization_memberships membership
      WHERE membership.organization_id = app.current_organization_id()
        AND membership.user_id = users.id
    )
  );

CREATE POLICY users_self_update ON app.users
  FOR UPDATE
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());

CREATE POLICY organization_memberships_tenant_isolation
  ON app.organization_memberships
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY clients_tenant_isolation ON app.clients
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY client_memberships_tenant_isolation ON app.client_memberships
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY projects_tenant_isolation ON app.projects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY project_memberships_tenant_isolation ON app.project_memberships
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY maps_tenant_isolation ON app.maps
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY map_versions_tenant_isolation ON app.map_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY activity_events_tenant_isolation ON app.activity_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.resolve_principal(p_cognito_subject text)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  organization_id uuid,
  organization_role app.organization_role
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT
    identity.id,
    identity.email,
    identity.display_name,
    membership.organization_id,
    membership.role
  FROM app.users identity
  LEFT JOIN app.organization_memberships membership
    ON membership.user_id = identity.id
  WHERE identity.cognito_subject = p_cognito_subject
  ORDER BY membership.organization_id
$$;

GRANT USAGE ON SCHEMA app TO opengeo_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_organization_id(),
  app.current_user_id(),
  app.resolve_principal(text)
TO opengeo_runtime;
GRANT SELECT ON app.users TO opengeo_runtime;
GRANT UPDATE (email, display_name) ON app.users TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.organizations,
  app.organization_memberships,
  app.clients,
  app.client_memberships,
  app.projects,
  app.project_memberships,
  app.maps,
  app.map_versions
TO opengeo_runtime;
GRANT SELECT, INSERT ON app.activity_events TO opengeo_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM opengeo_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON TABLES FROM opengeo_runtime;

COMMENT ON SCHEMA app IS
  'Authoritative OpenGeo records. API transactions set app.organization_id and app.user_id with SET LOCAL.';
COMMENT ON TABLE app.users IS
  'Global identity mapping; RLS exposes only the caller and users in the active organization.';
COMMENT ON FUNCTION app.resolve_principal(text) IS
  'Minimal SECURITY DEFINER lookup for a cryptographically verified Cognito subject; normal tenant queries remain under RLS.';
COMMENT ON TABLE app.activity_events IS
  'Append-only product activity and audit facts; infrastructure audit logs remain separate.';
COMMENT ON COLUMN app.maps.version IS
  'Optimistic concurrency token incremented by compare-and-swap API updates.';

COMMIT;
