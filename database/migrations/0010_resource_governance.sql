BEGIN;

CREATE TYPE app.governed_resource_permission_role AS ENUM (
  'manage',
  'edit',
  'publish',
  'view'
);
CREATE TYPE app.governed_style_format AS ENUM (
  'maplibre',
  'geostyler',
  'sld_1_0',
  'sld_1_1',
  'mapserver_mapfile'
);

CREATE TABLE app.governed_resource_permissions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  resource_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role app.governed_resource_permission_role NOT NULL,
  granted_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, resource_id, user_id),
  FOREIGN KEY (organization_id, resource_id)
    REFERENCES app.governed_resources (organization_id, id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES app.organization_memberships (organization_id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX governed_resource_permissions_user_idx
  ON app.governed_resource_permissions (
    organization_id,
    user_id,
    resource_id,
    role
  );

CREATE TABLE app.governed_resource_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  slug text NOT NULL,
  format app.governed_style_format NOT NULL,
  current_version_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, resource_id, slug),
  CONSTRAINT governed_resource_styles_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE TABLE app.governed_resource_style_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  style_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  media_type text NOT NULL,
  definition text NOT NULL,
  checksum_sha256 text NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, style_id, id),
  UNIQUE (organization_id, style_id, version_number),
  CONSTRAINT governed_resource_style_versions_positive CHECK (version_number > 0),
  CONSTRAINT governed_resource_style_versions_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT governed_resource_style_versions_media_type_bounded CHECK (
    media_type ~ '^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$'
  ),
  CONSTRAINT governed_resource_style_versions_definition_bounded CHECK (
    octet_length(definition) BETWEEN 2 AND 49152
  ),
  CONSTRAINT governed_resource_style_versions_checksum_valid CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT governed_resource_style_versions_change_bounded CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, style_id)
    REFERENCES app.governed_resource_styles (organization_id, id)
);

ALTER TABLE app.governed_resource_styles
  ADD CONSTRAINT governed_resource_styles_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.governed_resource_style_versions (organization_id, style_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.governed_resource_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  source_state app.governed_resource_state NOT NULL,
  target_state app.governed_resource_state NOT NULL,
  reason text,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT governed_resource_workflow_transition_valid CHECK (
    (source_state = 'draft' AND target_state = 'review')
    OR (source_state = 'review' AND target_state = 'published')
    OR (source_state = 'published' AND target_state = 'archived')
  ),
  CONSTRAINT governed_resource_workflow_reason_bounded CHECK (
    reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE INDEX governed_resource_styles_resource_idx
  ON app.governed_resource_styles (
    organization_id,
    project_id,
    resource_id,
    slug
  );
CREATE INDEX governed_resource_style_versions_history_idx
  ON app.governed_resource_style_versions (
    organization_id,
    style_id,
    version_number DESC
  );
CREATE INDEX governed_resource_workflow_history_idx
  ON app.governed_resource_workflow_events (
    organization_id,
    project_id,
    resource_id,
    created_at,
    id
  );

-- An imported catalog record may be staged before its local data/map exists. Permit
-- exactly one null-to-value binding; every identity and established binding remains
-- immutable, and the existing tenant/project foreign keys validate the target.
CREATE OR REPLACE FUNCTION app.enforce_governed_resource_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.kind <> OLD.kind
    OR NEW.slug <> OLD.slug
    OR (
      NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
      AND NOT (OLD.dataset_id IS NULL AND NEW.dataset_id IS NOT NULL)
    )
    OR (
      NEW.map_id IS DISTINCT FROM OLD.map_id
      AND NOT (OLD.map_id IS NULL AND NEW.map_id IS NOT NULL)
    )
    OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'governed resource identity and established binding are immutable';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'draft' AND NEW.state = 'review')
    OR (OLD.state = 'review' AND NEW.state = 'published')
    OR (OLD.state = 'published' AND NEW.state = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid governed resource state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_governed_style_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.slug <> OLD.slug
    OR NEW.format <> OLD.format
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'governed style identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER governed_resource_permissions_set_updated_at
  BEFORE UPDATE ON app.governed_resource_permissions
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER governed_resource_styles_enforce_transition
  BEFORE UPDATE ON app.governed_resource_styles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_governed_style_transition();
CREATE TRIGGER governed_resource_styles_set_updated_at
  BEFORE UPDATE ON app.governed_resource_styles
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER governed_resource_style_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_style_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER governed_resource_workflow_events_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_workflow_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.governed_resource_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_styles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_style_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_styles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_style_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_workflow_events FORCE ROW LEVEL SECURITY;

CREATE POLICY governed_resource_permissions_tenant_isolation
  ON app.governed_resource_permissions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_styles_tenant_isolation
  ON app.governed_resource_styles
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_style_versions_tenant_isolation
  ON app.governed_resource_style_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_workflow_events_tenant_isolation
  ON app.governed_resource_workflow_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.governed_resource_permissions TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE
  ON app.governed_resource_styles TO opengeo_runtime;
GRANT SELECT, INSERT
  ON app.governed_resource_style_versions,
     app.governed_resource_workflow_events
  TO opengeo_runtime;
REVOKE DELETE ON
  app.governed_resource_styles,
  app.governed_resource_style_versions,
  app.governed_resource_workflow_events
FROM opengeo_runtime;
REVOKE ALL ON
  app.governed_resource_permissions,
  app.governed_resource_styles,
  app.governed_resource_style_versions,
  app.governed_resource_workflow_events
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION app.enforce_governed_style_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.governed_resource_permissions IS
  'Per-user view, edit, publish, or management grants for one first-class resource.';
COMMENT ON TABLE app.governed_resource_styles IS
  'Stable portable style identities attached to governed resources.';
COMMENT ON TABLE app.governed_resource_style_versions IS
  'Immutable, checksummed MapLibre, GeoStyler, SLD, or MapServer style revisions.';
COMMENT ON TABLE app.governed_resource_workflow_events IS
  'Append-only editorial submission, publication, and archival decisions.';

COMMIT;
