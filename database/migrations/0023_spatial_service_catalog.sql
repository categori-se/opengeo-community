BEGIN;

CREATE TABLE app.spatial_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_by uuid REFERENCES app.users(id),
  disabled_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT spatial_services_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_services_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 200
  ),
  CONSTRAINT spatial_services_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT spatial_services_disable_shape CHECK (
    (disabled_by IS NULL AND disabled_at IS NULL)
    OR (disabled_by IS NOT NULL AND disabled_at IS NOT NULL AND disabled_at >= created_at)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

-- Protocol identifiers are reserved forever, including case-folded spellings.
-- Disabling a service cannot make an old bookmark identify a new service.
CREATE UNIQUE INDEX spatial_services_slug_identity_idx
  ON app.spatial_services (organization_id, project_id, lower(slug));
CREATE INDEX spatial_services_project_idx
  ON app.spatial_services (organization_id, project_id, disabled_at, lower(slug), id);

CREATE TABLE app.spatial_service_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  collection_name text NOT NULL,
  dataset_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  default_profile_id uuid NOT NULL,
  sealed_feature_generation bigint NOT NULL,
  sealed_profile_version_id uuid NOT NULL,
  sealed_profile_version_number bigint NOT NULL,
  title text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by uuid REFERENCES app.users(id),
  withdrawn_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT spatial_service_collections_name_bounded CHECK (
    collection_name ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_collections_generation_positive CHECK (
    sealed_feature_generation > 0
  ),
  CONSTRAINT spatial_service_collections_profile_version_positive CHECK (
    sealed_profile_version_number > 0
  ),
  CONSTRAINT spatial_service_collections_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT spatial_service_collections_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT spatial_service_collections_withdrawal_shape CHECK (
    (withdrawn_by IS NULL AND withdrawn_at IS NULL)
    OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_at >= created_at)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id),
  FOREIGN KEY (organization_id, project_id, dataset_id)
    REFERENCES app.project_datasets (organization_id, project_id, dataset_id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.feature_collections (organization_id, dataset_id),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, default_profile_id)
    REFERENCES app.map_render_profiles (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, default_profile_id, sealed_profile_version_id)
    REFERENCES app.map_render_profile_versions (organization_id, profile_id, id)
);

CREATE UNIQUE INDEX spatial_service_collections_name_identity_idx
  ON app.spatial_service_collections (
    organization_id, service_id, lower(collection_name)
  );
CREATE UNIQUE INDEX spatial_service_collections_one_active_dataset_idx
  ON app.spatial_service_collections (organization_id, service_id, dataset_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX spatial_service_collections_catalog_idx
  ON app.spatial_service_collections (
    organization_id, project_id, service_id, withdrawn_at,
    lower(collection_name), id
  );

CREATE FUNCTION app.enforce_spatial_service_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.disabled_by IS NOT NULL
    OR NEW.disabled_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service creator mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.slug <> OLD.slug
    OR NEW.title <> OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service identity and description are immutable';
  END IF;
  IF OLD.disabled_at IS NOT NULL
    OR NEW.disabled_at IS NULL
    OR NEW.disabled_by IS NULL
    OR NEW.disabled_by <> app.current_user_id()
    OR NEW.disabled_at < OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service disable is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_collection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.withdrawn_by IS NOT NULL
    OR NEW.withdrawn_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service collection creator mismatch';
  END IF;

  PERFORM 1
  FROM app.spatial_services service
  JOIN app.datasets dataset
    ON dataset.organization_id = service.organization_id
   AND dataset.id = NEW.dataset_id
  JOIN app.feature_collections feature_collection
    ON feature_collection.organization_id = dataset.organization_id
   AND feature_collection.dataset_id = dataset.id
  JOIN app.governed_resources resource
    ON resource.organization_id = service.organization_id
   AND resource.project_id = service.project_id
   AND resource.id = NEW.resource_id
   AND resource.dataset_id = dataset.id
  JOIN app.map_render_profiles profile
    ON profile.organization_id = resource.organization_id
   AND profile.project_id = resource.project_id
   AND profile.resource_id = resource.id
   AND profile.id = NEW.default_profile_id
  JOIN app.map_render_profile_versions profile_version
    ON profile_version.organization_id = profile.organization_id
   AND profile_version.profile_id = profile.id
   AND profile_version.id = profile.current_version_id
   AND profile_version.id = NEW.sealed_profile_version_id
   AND profile_version.version_number = NEW.sealed_profile_version_number
   AND profile_version.dataset_id = dataset.id
   AND profile_version.dataset_version_id = dataset.current_version_id
  WHERE service.organization_id = NEW.organization_id
    AND service.project_id = NEW.project_id
    AND service.id = NEW.service_id
    AND service.disabled_at IS NULL
    AND dataset.status = 'active'
    AND dataset.format IN ('geojson', 'shapefile', 'geopackage', 'geoparquet')
    AND feature_collection.generation = NEW.sealed_feature_generation
    AND resource.kind IN ('dataset', 'service')
    AND resource.state = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service collection must seal current governed targets';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_collection_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.service_id <> OLD.service_id
    OR NEW.collection_name <> OLD.collection_name
    OR NEW.dataset_id <> OLD.dataset_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.default_profile_id <> OLD.default_profile_id
    OR NEW.sealed_feature_generation <> OLD.sealed_feature_generation
    OR NEW.sealed_profile_version_id <> OLD.sealed_profile_version_id
    OR NEW.sealed_profile_version_number <> OLD.sealed_profile_version_number
    OR NEW.title <> OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service collection seal is immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
    OR NEW.withdrawn_at IS NULL
    OR NEW.withdrawn_by IS NULL
    OR NEW.withdrawn_by <> app.current_user_id()
    OR NEW.withdrawn_at < OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service collection withdrawal is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spatial_services_validate_insert
  BEFORE INSERT ON app.spatial_services
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_insert();
CREATE TRIGGER spatial_services_enforce_transition
  BEFORE UPDATE ON app.spatial_services
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_transition();
CREATE TRIGGER spatial_service_collections_validate_insert
  BEFORE INSERT ON app.spatial_service_collections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_collection_insert();
CREATE TRIGGER spatial_service_collections_enforce_transition
  BEFORE UPDATE ON app.spatial_service_collections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_collection_transition();

ALTER TABLE app.spatial_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_services FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_collections FORCE ROW LEVEL SECURITY;

CREATE POLICY spatial_services_tenant_isolation ON app.spatial_services
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_service_collections_tenant_isolation
  ON app.spatial_service_collections
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON
  app.spatial_services,
  app.spatial_service_collections
TO opengeo_runtime;
REVOKE DELETE ON
  app.spatial_services,
  app.spatial_service_collections
FROM opengeo_runtime;
REVOKE ALL ON
  app.spatial_services,
  app.spatial_service_collections
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_spatial_service_insert(),
  app.enforce_spatial_service_transition(),
  app.enforce_spatial_service_collection_insert(),
  app.enforce_spatial_service_collection_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.spatial_services IS
  'Project-scoped administered OGC compatibility catalogs with immutable protocol identifiers and irreversible disablement.';
COMMENT ON TABLE app.spatial_service_collections IS
  'Immutable feature-generation/render-profile seals used by authenticated feature, map, and tile discovery; stale seals fail closed and are replaced, never rewritten.';

COMMIT;
