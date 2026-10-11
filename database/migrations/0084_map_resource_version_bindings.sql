BEGIN;

CREATE TABLE app.map_resource_version_bindings (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  map_id uuid NOT NULL,
  map_version bigint NOT NULL CHECK (map_version > 0),
  PRIMARY KEY (organization_id, resource_id, resource_version_id),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, project_id, map_id)
    REFERENCES app.maps (organization_id, project_id, id),
  FOREIGN KEY (organization_id, map_id, map_version)
    REFERENCES app.map_versions (organization_id, map_id, version)
);

CREATE FUNCTION app.reject_map_resource_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  RAISE EXCEPTION 'saved map and resource binding history is immutable';
END;
$$;

CREATE TRIGGER map_resource_version_bindings_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_resource_version_bindings
  FOR EACH ROW EXECUTE FUNCTION app.reject_map_resource_history_mutation();
CREATE TRIGGER map_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_map_resource_history_mutation();

REVOKE UPDATE, DELETE ON app.map_versions FROM opengeo_runtime;
REVOKE EXECUTE ON FUNCTION app.reject_map_resource_history_mutation() FROM PUBLIC;

ALTER TABLE app.map_resource_version_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_resource_version_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY map_resource_version_bindings_tenant_read
  ON app.map_resource_version_bindings FOR SELECT
  USING (organization_id = app.current_organization_id());

REVOKE ALL ON app.map_resource_version_bindings FROM PUBLIC;
GRANT SELECT ON app.map_resource_version_bindings TO opengeo_runtime;

CREATE FUNCTION app.bind_map_resource_version(
  p_resource_id uuid,
  p_resource_version_id uuid,
  p_expected_map_version bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_organization_id uuid := app.current_organization_id();
  v_user_id uuid := app.current_user_id();
  v_resource app.governed_resources%ROWTYPE;
  v_resource_version_number bigint;
  v_map_version bigint;
BEGIN
  IF v_organization_id IS NULL OR v_user_id IS NULL
    OR p_resource_id IS NULL OR p_resource_version_id IS NULL
    OR (p_expected_map_version IS NOT NULL AND p_expected_map_version <= 0)
  THEN
    RETURN false;
  END IF;

  -- Serialize against resource updates and new version insertion. The API calls
  -- this after inserting its version, before advancing the resource head.
  SELECT resource.* INTO v_resource
  FROM app.governed_resources resource
  WHERE resource.organization_id = v_organization_id
    AND resource.id = p_resource_id
    AND resource.kind = 'map'
    AND resource.map_id IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT version.version_number INTO v_resource_version_number
  FROM app.governed_resource_versions version
  WHERE version.organization_id = v_organization_id
    AND version.resource_id = p_resource_id
    AND version.id = p_resource_version_id
    AND version.created_by = v_user_id
    AND NOT EXISTS (
      SELECT 1 FROM app.governed_resource_versions newer
      WHERE newer.organization_id = version.organization_id
        AND newer.resource_id = version.resource_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM app.map_resource_version_bindings binding
    WHERE binding.organization_id = v_organization_id
      AND binding.resource_id = p_resource_id
      AND binding.resource_version_id = p_resource_version_id
  ) THEN
    RETURN false;
  END IF;

  IF p_expected_map_version IS NULL AND v_resource_version_number > 1 THEN
    SELECT binding.map_version INTO v_map_version
    FROM app.map_resource_version_bindings binding
    JOIN app.governed_resource_versions previous
      ON previous.organization_id = binding.organization_id
     AND previous.resource_id = binding.resource_id
     AND previous.id = binding.resource_version_id
    WHERE binding.organization_id = v_organization_id
      AND binding.project_id = v_resource.project_id
      AND binding.resource_id = p_resource_id
      AND binding.map_id = v_resource.map_id
      AND previous.version_number < v_resource_version_number
    ORDER BY previous.version_number DESC
    LIMIT 1;
    IF NOT FOUND THEN
      -- Legacy content has no trustworthy saved-map association. An explicit
      -- current-version selection is required to create its first binding.
      RETURN false;
    END IF;
  ELSE
    SELECT map.version INTO v_map_version
    FROM app.maps map
    WHERE map.organization_id = v_organization_id
      AND map.project_id = v_resource.project_id
      AND map.id = v_resource.map_id
      AND map.status = 'active'
    FOR SHARE;
    IF NOT FOUND OR v_map_version <= 0
      OR (p_expected_map_version IS NOT NULL AND p_expected_map_version <> v_map_version)
    THEN
      RETURN false;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.map_versions history
    WHERE history.organization_id = v_organization_id
      AND history.map_id = v_resource.map_id
      AND history.version = v_map_version
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO app.map_resource_version_bindings
    (organization_id, project_id, resource_id, resource_version_id, map_id, map_version)
  VALUES
    (v_organization_id, v_resource.project_id, p_resource_id,
     p_resource_version_id, v_resource.map_id, v_map_version);
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.bind_map_resource_version(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bind_map_resource_version(uuid, uuid, bigint) TO opengeo_runtime;

COMMENT ON TABLE app.map_resource_version_bindings IS
  'Immutable, server-selected saved map revision for one exact governed resource version; metadata-only successors inherit the nearest preceding binding.';
COMMENT ON FUNCTION app.bind_map_resource_version(uuid, uuid, bigint) IS
  'Binds only the newest actor-created map resource version, before its head update; an explicit expected version pins the current saved map and omission preserves existing history.';

COMMIT;
