BEGIN;

CREATE TABLE app.wms_layer_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  wms_name text NOT NULL,
  default_profile_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by uuid REFERENCES app.users(id),
  withdrawn_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT wms_layer_publications_name_bounded CHECK (
    char_length(wms_name) BETWEEN 1 AND 127
    AND wms_name ~ '^[A-Za-z][A-Za-z0-9._-]{0,62}(:[A-Za-z][A-Za-z0-9._-]{0,62})?$'
  ),
  CONSTRAINT wms_layer_publications_withdrawal_shape CHECK (
    (withdrawn_by IS NULL AND withdrawn_at IS NULL)
    OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_at >= created_at)
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, default_profile_id)
    REFERENCES app.map_render_profiles (organization_id, resource_id, id)
);

-- WMS names are protocol identifiers, not display labels. Preserve exact case in
-- responses while reserving every case-folded spelling forever so a retired name
-- cannot later identify a different resource.
CREATE UNIQUE INDEX wms_layer_publications_name_identity_idx
  ON app.wms_layer_publications (organization_id, project_id, lower(wms_name));
CREATE UNIQUE INDEX wms_layer_publications_one_active_resource_idx
  ON app.wms_layer_publications (organization_id, project_id, resource_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX wms_layer_publications_catalog_idx
  ON app.wms_layer_publications (
    organization_id,
    project_id,
    withdrawn_at,
    lower(wms_name),
    id
  );

CREATE FUNCTION app.enforce_wms_layer_publication_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.withdrawn_by IS NOT NULL
    OR NEW.withdrawn_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'WMS publication creator mismatch';
  END IF;

  PERFORM 1
  FROM app.governed_resources resource
  JOIN app.map_render_profiles profile
    ON profile.organization_id = resource.organization_id
   AND profile.project_id = resource.project_id
   AND profile.resource_id = resource.id
   AND profile.id = NEW.default_profile_id
  WHERE resource.organization_id = NEW.organization_id
    AND resource.project_id = NEW.project_id
    AND resource.id = NEW.resource_id
    AND resource.kind IN ('dataset', 'service')
    AND resource.state = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WMS publication target must be a published map resource';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_wms_layer_publication_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.wms_name <> OLD.wms_name
    OR NEW.default_profile_id <> OLD.default_profile_id
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'WMS publication identity is immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
    OR NEW.withdrawn_at IS NULL
    OR NEW.withdrawn_by IS NULL
    OR NEW.withdrawn_by <> app.current_user_id()
    OR NEW.withdrawn_at < OLD.created_at
  THEN
    RAISE EXCEPTION 'WMS publication withdrawal is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wms_layer_publications_validate_insert
  BEFORE INSERT ON app.wms_layer_publications
  FOR EACH ROW EXECUTE FUNCTION app.enforce_wms_layer_publication_insert();
CREATE TRIGGER wms_layer_publications_enforce_transition
  BEFORE UPDATE ON app.wms_layer_publications
  FOR EACH ROW EXECUTE FUNCTION app.enforce_wms_layer_publication_transition();

ALTER TABLE app.wms_layer_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wms_layer_publications FORCE ROW LEVEL SECURITY;

CREATE POLICY wms_layer_publications_tenant_isolation
  ON app.wms_layer_publications
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.wms_layer_publications TO opengeo_runtime;
REVOKE DELETE ON app.wms_layer_publications FROM opengeo_runtime;
REVOKE ALL ON app.wms_layer_publications FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_wms_layer_publication_insert(),
  app.enforce_wms_layer_publication_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.wms_layer_publications IS
  'Tenant-scoped, stable WMS layer names bound to one published governed resource and default render profile; withdrawal is irreversible and names are never reused.';

COMMIT;
