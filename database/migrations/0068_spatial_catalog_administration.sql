BEGIN;

-- GEOSERVER-005 adds the native administration plane around the existing
-- project-scoped service namespace, immutable collection seals, and governed
-- resource styles. It does not add a GeoServer process or another data plane.

CREATE TYPE app.spatial_service_store_kind AS ENUM (
  'managed_project',
  'external_source',
  'postgresql_connection'
);

CREATE TYPE app.spatial_service_layer_group_mode AS ENUM (
  'single',
  'opaque_container',
  'named',
  'container',
  'earth_observation'
);

CREATE FUNCTION app.spatial_catalog_text_array_is_unique(p_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT count(*) = count(DISTINCT value) FROM unnest(p_values) value
$$;

CREATE FUNCTION app.spatial_catalog_uuid_array_is_unique(p_values uuid[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT count(*) = count(DISTINCT value) FROM unnest(p_values) value
$$;

ALTER TABLE app.spatial_services
  ADD CONSTRAINT spatial_services_project_identity_unique
  UNIQUE (organization_id, project_id, id);

CREATE TABLE app.spatial_service_metadata_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  abstract text,
  namespace_uri text,
  keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  fees text,
  access_constraints text[] NOT NULL DEFAULT ARRAY[]::text[],
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled_protocols text[] NOT NULL DEFAULT ARRAY['ogc_api_features', 'wfs_2_0', 'wms_1_3', 'wmts_1_0']::text[],
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, service_id, id),
  UNIQUE (organization_id, service_id, version_number),
  FOREIGN KEY (organization_id, project_id, service_id)
    REFERENCES app.spatial_services (organization_id, project_id, id),
  CONSTRAINT spatial_service_metadata_version_positive CHECK (version_number > 0),
  CONSTRAINT spatial_service_metadata_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 200
  ),
  CONSTRAINT spatial_service_metadata_abstract_bounded CHECK (
    abstract IS NULL
    OR (abstract = btrim(abstract) AND char_length(abstract) BETWEEN 1 AND 8000)
  ),
  CONSTRAINT spatial_service_metadata_namespace_bounded CHECK (
    namespace_uri IS NULL
    OR (
      namespace_uri = btrim(namespace_uri)
      AND char_length(namespace_uri) BETWEEN 9 AND 2048
      AND namespace_uri ~ '^https?://[^[:space:][:cntrl:]]+$'
    )
  ),
  CONSTRAINT spatial_service_metadata_keywords_bounded CHECK (
    cardinality(keywords) <= 32
    AND array_position(keywords, NULL) IS NULL
  ),
  CONSTRAINT spatial_service_metadata_fees_bounded CHECK (
    fees IS NULL OR (fees = btrim(fees) AND char_length(fees) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT spatial_service_metadata_constraints_bounded CHECK (
    cardinality(access_constraints) <= 16
    AND array_position(access_constraints, NULL) IS NULL
  ),
  CONSTRAINT spatial_service_metadata_contact_bounded CHECK (
    jsonb_typeof(contact) = 'object'
    AND octet_length(contact::text) <= 4096
  ),
  CONSTRAINT spatial_service_metadata_protocols_known CHECK (
    cardinality(enabled_protocols) BETWEEN 1 AND 8
    AND enabled_protocols <@ ARRAY[
      'ogc_api_features', 'wfs_2_0', 'wms_1_1', 'wms_1_3',
      'wmts_1_0', 'wcs_2_0', 'arcgis_features'
    ]::text[]
    AND app.spatial_catalog_text_array_is_unique(enabled_protocols)
  ),
  CONSTRAINT spatial_service_metadata_change_bounded CHECK (
    change_message IS NULL
    OR (change_message = btrim(change_message) AND char_length(change_message) BETWEEN 1 AND 500)
  )
);

ALTER TABLE app.spatial_services
  ADD COLUMN current_metadata_version_id uuid,
  ADD COLUMN current_metadata_version_number bigint,
  ADD COLUMN updated_by uuid REFERENCES app.users(id),
  ADD COLUMN updated_at timestamptz;

ALTER TABLE app.spatial_services DISABLE TRIGGER spatial_services_enforce_transition;

INSERT INTO app.spatial_service_metadata_versions
  (id, organization_id, project_id, service_id, version_number, title,
   abstract, created_by, created_at)
SELECT gen_random_uuid(), organization_id, project_id, id, 1, title,
       description, created_by, created_at
FROM app.spatial_services;

UPDATE app.spatial_services service
SET current_metadata_version_id = version.id,
    current_metadata_version_number = 1,
    updated_by = service.created_by,
    updated_at = service.created_at
FROM app.spatial_service_metadata_versions version
WHERE version.organization_id = service.organization_id
  AND version.service_id = service.id
  AND version.version_number = 1;

ALTER TABLE app.spatial_services
  ALTER COLUMN current_metadata_version_id SET NOT NULL,
  ALTER COLUMN current_metadata_version_number SET NOT NULL,
  ALTER COLUMN updated_by SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT spatial_services_metadata_version_positive
    CHECK (current_metadata_version_number > 0),
  ADD CONSTRAINT spatial_services_current_metadata_fk
    FOREIGN KEY (organization_id, id, current_metadata_version_id)
    REFERENCES app.spatial_service_metadata_versions (organization_id, service_id, id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app.spatial_services ENABLE TRIGGER spatial_services_enforce_transition;

CREATE TABLE app.spatial_service_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  kind app.spatial_service_store_kind NOT NULL,
  dataset_id uuid,
  external_connection_id uuid,
  sealed_source_revision_number bigint,
  sealed_connection_revision_number bigint,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_by uuid REFERENCES app.users(id),
  disabled_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, service_id, id),
  FOREIGN KEY (organization_id, project_id, service_id)
    REFERENCES app.spatial_services (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, dataset_id)
    REFERENCES app.project_datasets (organization_id, project_id, dataset_id),
  FOREIGN KEY (organization_id, project_id, external_connection_id)
    REFERENCES app.external_connections (organization_id, project_id, id),
  CONSTRAINT spatial_service_stores_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_stores_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 200
  ),
  CONSTRAINT spatial_service_stores_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT spatial_service_stores_binding_shape CHECK (
    (kind = 'managed_project'
      AND dataset_id IS NULL AND external_connection_id IS NULL
      AND sealed_source_revision_number IS NULL
      AND sealed_connection_revision_number IS NULL)
    OR (kind = 'external_source'
      AND dataset_id IS NOT NULL AND external_connection_id IS NULL
      AND sealed_source_revision_number > 0
      AND sealed_connection_revision_number IS NULL)
    OR (kind = 'postgresql_connection'
      AND dataset_id IS NULL AND external_connection_id IS NOT NULL
      AND sealed_source_revision_number IS NULL
      AND sealed_connection_revision_number > 0)
  ),
  CONSTRAINT spatial_service_stores_configuration_bounded CHECK (
    jsonb_typeof(configuration) = 'object'
    AND octet_length(configuration::text) <= 8192
  ),
  CONSTRAINT spatial_service_stores_disable_shape CHECK (
    (disabled_by IS NULL AND disabled_at IS NULL)
    OR (disabled_by IS NOT NULL AND disabled_at IS NOT NULL AND disabled_at >= created_at)
  )
);

CREATE UNIQUE INDEX spatial_service_stores_slug_identity_idx
  ON app.spatial_service_stores (organization_id, service_id, lower(slug));
CREATE INDEX spatial_service_stores_catalog_idx
  ON app.spatial_service_stores (
    organization_id, project_id, service_id, disabled_at, lower(slug), id
  );

INSERT INTO app.spatial_service_stores
  (id, organization_id, project_id, service_id, slug, title, description,
   kind, created_by, created_at)
SELECT gen_random_uuid(), organization_id, project_id, id, 'managed',
       'Managed project datasets',
       'Governed datasets already linked to this project.',
       'managed_project', created_by, created_at
FROM app.spatial_services;

ALTER TABLE app.spatial_service_collections
  DISABLE TRIGGER spatial_service_collections_enforce_transition;

ALTER TABLE app.spatial_service_collections ADD COLUMN store_id uuid;

UPDATE app.spatial_service_collections binding
SET store_id = store.id
FROM app.spatial_service_stores store
WHERE store.organization_id = binding.organization_id
  AND store.service_id = binding.service_id
  AND store.kind = 'managed_project'
  AND store.slug = 'managed';

ALTER TABLE app.spatial_service_collections
  ALTER COLUMN store_id SET NOT NULL,
  ADD CONSTRAINT spatial_service_collections_service_identity_unique
    UNIQUE (organization_id, service_id, id),
  ADD CONSTRAINT spatial_service_collections_store_fk
    FOREIGN KEY (organization_id, service_id, store_id)
    REFERENCES app.spatial_service_stores (organization_id, service_id, id);

CREATE TABLE app.spatial_service_layer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  slug text NOT NULL,
  current_version_id uuid NOT NULL,
  current_version_number bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_by uuid REFERENCES app.users(id),
  disabled_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, service_id, id),
  FOREIGN KEY (organization_id, project_id, service_id)
    REFERENCES app.spatial_services (organization_id, project_id, id),
  CONSTRAINT spatial_service_layer_groups_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_layer_groups_version_positive CHECK (
    current_version_number > 0
  ),
  CONSTRAINT spatial_service_layer_groups_disable_shape CHECK (
    (disabled_by IS NULL AND disabled_at IS NULL)
    OR (disabled_by IS NOT NULL AND disabled_at IS NOT NULL AND disabled_at >= created_at)
  )
);

CREATE TABLE app.spatial_service_layer_group_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  group_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  description text,
  mode app.spatial_service_layer_group_mode NOT NULL,
  member_collection_ids uuid[] NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, group_id, id),
  UNIQUE (organization_id, group_id, version_number),
  FOREIGN KEY (organization_id, service_id, group_id)
    REFERENCES app.spatial_service_layer_groups (organization_id, service_id, id),
  CONSTRAINT spatial_service_layer_group_versions_positive CHECK (version_number > 0),
  CONSTRAINT spatial_service_layer_group_versions_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT spatial_service_layer_group_versions_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT spatial_service_layer_group_members_bounded CHECK (
    cardinality(member_collection_ids) BETWEEN 1 AND 64
    AND array_position(member_collection_ids, NULL) IS NULL
    AND app.spatial_catalog_uuid_array_is_unique(member_collection_ids)
  ),
  CONSTRAINT spatial_service_layer_group_change_bounded CHECK (
    change_message IS NULL
    OR (change_message = btrim(change_message) AND char_length(change_message) BETWEEN 1 AND 500)
  )
);

ALTER TABLE app.spatial_service_layer_groups
  ADD CONSTRAINT spatial_service_layer_groups_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.spatial_service_layer_group_versions (organization_id, group_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX spatial_service_layer_groups_slug_identity_idx
  ON app.spatial_service_layer_groups (organization_id, service_id, lower(slug));
CREATE INDEX spatial_service_layer_groups_catalog_idx
  ON app.spatial_service_layer_groups (
    organization_id, project_id, service_id, disabled_at, lower(slug), id
  );
CREATE INDEX spatial_service_layer_group_versions_history_idx
  ON app.spatial_service_layer_group_versions (
    organization_id, group_id, version_number DESC
  );

CREATE TABLE app.spatial_service_collection_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  style_name text NOT NULL,
  style_id uuid NOT NULL,
  sealed_style_version_id uuid NOT NULL,
  sealed_style_version_number bigint NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by uuid REFERENCES app.users(id),
  withdrawn_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, service_id, collection_id)
    REFERENCES app.spatial_service_collections (organization_id, service_id, id),
  FOREIGN KEY (organization_id, style_id, sealed_style_version_id)
    REFERENCES app.governed_resource_style_versions (organization_id, style_id, id),
  CONSTRAINT spatial_service_collection_styles_name_bounded CHECK (
    style_name ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_collection_styles_version_positive CHECK (
    sealed_style_version_number > 0
  ),
  CONSTRAINT spatial_service_collection_styles_withdrawal_shape CHECK (
    (withdrawn_by IS NULL AND withdrawn_at IS NULL)
    OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_at >= created_at)
  )
);

CREATE UNIQUE INDEX spatial_service_collection_styles_name_identity_idx
  ON app.spatial_service_collection_styles (
    organization_id, collection_id, lower(style_name)
  );
CREATE UNIQUE INDEX spatial_service_collection_styles_one_active_default_idx
  ON app.spatial_service_collection_styles (organization_id, collection_id)
  WHERE is_default AND withdrawn_at IS NULL;
CREATE INDEX spatial_service_collection_styles_catalog_idx
  ON app.spatial_service_collection_styles (
    organization_id, project_id, service_id, collection_id,
    withdrawn_at, is_default DESC, lower(style_name), id
  );

CREATE FUNCTION app.reject_spatial_catalog_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'spatial catalog history is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_spatial_service_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  metadata_changed boolean;
  disable_changed boolean;
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
    RAISE EXCEPTION 'spatial service identity and initial description are immutable';
  END IF;

  metadata_changed :=
    NEW.current_metadata_version_id <> OLD.current_metadata_version_id
    OR NEW.current_metadata_version_number <> OLD.current_metadata_version_number;
  disable_changed :=
    NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
    OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at;

  IF metadata_changed THEN
    IF disable_changed
      OR OLD.disabled_at IS NOT NULL
      OR NEW.current_metadata_version_number <> OLD.current_metadata_version_number + 1
      OR NEW.updated_by <> app.current_user_id()
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'spatial service metadata head transition is invalid';
    END IF;
  ELSIF disable_changed THEN
    IF OLD.disabled_at IS NOT NULL
      OR NEW.disabled_at IS NULL
      OR NEW.disabled_by IS NULL
      OR NEW.disabled_by <> app.current_user_id()
      OR NEW.disabled_at < OLD.created_at
      OR NEW.current_metadata_version_id <> OLD.current_metadata_version_id
      OR NEW.current_metadata_version_number <> OLD.current_metadata_version_number
      OR NEW.updated_by <> OLD.updated_by
      OR NEW.updated_at <> OLD.updated_at
    THEN
      RAISE EXCEPTION 'spatial service disable is one-way and actor-bound';
    END IF;
  ELSE
    IF NEW.updated_by <> OLD.updated_by OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'spatial service update has no valid transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_store_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_store_count bigint;
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.disabled_by IS NOT NULL OR NEW.disabled_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service store creator mismatch';
  END IF;
  PERFORM 1 FROM app.spatial_services service
  WHERE service.organization_id = NEW.organization_id
    AND service.project_id = NEW.project_id
    AND service.id = NEW.service_id
    AND service.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service store requires an active service';
  END IF;
  SELECT count(*) INTO active_store_count
  FROM app.spatial_service_stores store
  WHERE store.organization_id = NEW.organization_id
    AND store.service_id = NEW.service_id
    AND store.disabled_at IS NULL;
  IF active_store_count >= 16 THEN
    RAISE EXCEPTION 'spatial service store limit reached';
  END IF;
  IF NEW.kind = 'external_source' THEN
    PERFORM 1
    FROM app.external_sources source
    JOIN app.external_source_revisions revision
      ON revision.organization_id = source.organization_id
     AND revision.dataset_id = source.dataset_id
     AND revision.version_number = NEW.sealed_source_revision_number
    JOIN app.datasets dataset
      ON dataset.organization_id = source.organization_id
     AND dataset.id = source.dataset_id
     AND dataset.status = 'active'
    WHERE source.organization_id = NEW.organization_id
      AND source.dataset_id = NEW.dataset_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'external source store must seal an active source revision';
    END IF;
  ELSIF NEW.kind = 'postgresql_connection' THEN
    PERFORM 1
    FROM app.external_connections connection
    JOIN app.external_connection_verifications verification
      ON verification.organization_id = connection.organization_id
     AND verification.project_id = connection.project_id
     AND verification.connection_id = connection.id
     AND verification.connection_revision_number = connection.current_revision_number
     AND verification.state = 'succeeded'
     AND verification.network_reachable
     AND verification.tls_verified
     AND verification.credentials_verified
     AND verification.postgis_verified
    WHERE connection.organization_id = NEW.organization_id
      AND connection.project_id = NEW.project_id
      AND connection.id = NEW.external_connection_id
      AND connection.provider = 'postgresql'
      AND connection.read_only
      AND connection.status = 'credentials_verified'
      AND connection.current_revision_number = NEW.sealed_connection_revision_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PostgreSQL store must seal a verified read-only PostGIS connection';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_store_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.service_id <> OLD.service_id
    OR NEW.slug <> OLD.slug OR NEW.title <> OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description OR NEW.kind <> OLD.kind
    OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
    OR NEW.external_connection_id IS DISTINCT FROM OLD.external_connection_id
    OR NEW.sealed_source_revision_number IS DISTINCT FROM OLD.sealed_source_revision_number
    OR NEW.sealed_connection_revision_number IS DISTINCT FROM OLD.sealed_connection_revision_number
    OR NEW.configuration <> OLD.configuration OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service store identity and seal are immutable';
  END IF;
  IF OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL
    OR NEW.disabled_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial service store disable is one-way and actor-bound';
  END IF;
  PERFORM 1 FROM app.spatial_service_collections binding
  WHERE binding.organization_id = OLD.organization_id
    AND binding.project_id = OLD.project_id
    AND binding.service_id = OLD.service_id
    AND binding.store_id = OLD.id
    AND binding.withdrawn_at IS NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'spatial service store with active collections cannot be disabled';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_spatial_service_collection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.withdrawn_by IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service collection creator mismatch';
  END IF;

  IF NEW.store_id IS NULL THEN
    SELECT store.id INTO NEW.store_id
    FROM app.spatial_service_stores store
    WHERE store.organization_id = NEW.organization_id
      AND store.service_id = NEW.service_id
      AND store.kind = 'managed_project'
      AND store.disabled_at IS NULL
    ORDER BY store.created_at, store.id
    LIMIT 1;
  END IF;

  PERFORM 1
  FROM app.spatial_services service
  JOIN app.spatial_service_stores store
    ON store.organization_id = service.organization_id
   AND store.project_id = service.project_id
   AND store.service_id = service.id
   AND store.id = NEW.store_id
   AND store.disabled_at IS NULL
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
    AND service.project_id = NEW.project_id AND service.id = NEW.service_id
    AND service.disabled_at IS NULL AND dataset.status = 'active'
    AND dataset.format IN ('geojson', 'shapefile', 'geopackage', 'geoparquet')
    AND feature_collection.generation = NEW.sealed_feature_generation
    AND resource.kind IN ('dataset', 'service') AND resource.state = 'published'
    AND (
      store.kind = 'managed_project'
      OR (store.kind = 'external_source' AND store.dataset_id = dataset.id)
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service collection must seal current governed targets in an active compatible store';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_spatial_service_collection_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.service_id <> OLD.service_id
    OR NEW.store_id <> OLD.store_id OR NEW.collection_name <> OLD.collection_name
    OR NEW.dataset_id <> OLD.dataset_id OR NEW.resource_id <> OLD.resource_id
    OR NEW.default_profile_id <> OLD.default_profile_id
    OR NEW.sealed_feature_generation <> OLD.sealed_feature_generation
    OR NEW.sealed_profile_version_id <> OLD.sealed_profile_version_id
    OR NEW.sealed_profile_version_number <> OLD.sealed_profile_version_number
    OR NEW.title <> OLD.title OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service collection seal is immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
    OR NEW.withdrawn_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial service collection withdrawal is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE app.spatial_service_collections
  ENABLE TRIGGER spatial_service_collections_enforce_transition;

CREATE FUNCTION app.enforce_spatial_service_layer_group_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  member_id uuid;
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'spatial service layer group revision creator mismatch';
  END IF;
  FOREACH member_id IN ARRAY NEW.member_collection_ids LOOP
    PERFORM 1 FROM app.spatial_service_collections binding
    WHERE binding.organization_id = NEW.organization_id
      AND binding.project_id = NEW.project_id
      AND binding.service_id = NEW.service_id
      AND binding.id = member_id
      AND binding.withdrawn_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'spatial service layer group member is not an active same-service collection';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_layer_group_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_changed boolean;
  disable_changed boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.service_id <> OLD.service_id
    OR NEW.slug <> OLD.slug OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service layer group identity is immutable';
  END IF;
  version_changed := NEW.current_version_id <> OLD.current_version_id
    OR NEW.current_version_number <> OLD.current_version_number;
  disable_changed := NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
    OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at;
  IF version_changed THEN
    IF disable_changed OR OLD.disabled_at IS NOT NULL
      OR NEW.current_version_number <> OLD.current_version_number + 1
      OR NEW.updated_by <> app.current_user_id() OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'spatial service layer group head transition is invalid';
    END IF;
  ELSIF disable_changed THEN
    IF OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL
      OR NEW.disabled_by <> app.current_user_id()
      OR NEW.updated_by <> OLD.updated_by OR NEW.updated_at <> OLD.updated_at
    THEN
      RAISE EXCEPTION 'spatial service layer group disable is one-way and actor-bound';
    END IF;
  ELSE
    RAISE EXCEPTION 'spatial service layer group update has no valid transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_collection_style_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.withdrawn_by IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service collection style creator mismatch';
  END IF;
  PERFORM 1
  FROM app.spatial_service_collections binding
  JOIN app.governed_resource_styles style
    ON style.organization_id = binding.organization_id
   AND style.project_id = binding.project_id
   AND style.resource_id = binding.resource_id
   AND style.id = NEW.style_id
  JOIN app.governed_resource_style_versions version
    ON version.organization_id = style.organization_id
   AND version.style_id = style.id
   AND version.id = style.current_version_id
   AND version.id = NEW.sealed_style_version_id
   AND version.version_number = NEW.sealed_style_version_number
  WHERE binding.organization_id = NEW.organization_id
    AND binding.project_id = NEW.project_id
    AND binding.service_id = NEW.service_id
    AND binding.id = NEW.collection_id
    AND binding.withdrawn_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service collection style must seal a current same-resource style';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_collection_style_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.service_id <> OLD.service_id
    OR NEW.collection_id <> OLD.collection_id OR NEW.style_name <> OLD.style_name
    OR NEW.style_id <> OLD.style_id
    OR NEW.sealed_style_version_id <> OLD.sealed_style_version_id
    OR NEW.sealed_style_version_number <> OLD.sealed_style_version_number
    OR NEW.is_default <> OLD.is_default OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service collection style seal is immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
    OR NEW.withdrawn_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial service collection style withdrawal is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.add_spatial_service_default_style()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  style_record record;
BEGIN
  SELECT style.id, style.slug, version.id AS version_id, version.version_number
  INTO style_record
  FROM app.map_render_profile_versions profile_version
  JOIN app.governed_resource_styles style
    ON style.organization_id = profile_version.organization_id
   AND style.id = profile_version.style_id
  JOIN app.governed_resource_style_versions version
    ON version.organization_id = style.organization_id
   AND version.style_id = style.id
   AND version.id = profile_version.style_version_id
  WHERE profile_version.organization_id = NEW.organization_id
    AND profile_version.profile_id = NEW.default_profile_id
    AND profile_version.id = NEW.sealed_profile_version_id;
  IF style_record.id IS NULL THEN
    RAISE EXCEPTION 'spatial service collection default style seal is missing';
  END IF;
  INSERT INTO app.spatial_service_collection_styles
    (organization_id, project_id, service_id, collection_id, style_name,
     style_id, sealed_style_version_id, sealed_style_version_number,
     is_default, created_by, created_at)
  VALUES (NEW.organization_id, NEW.project_id, NEW.service_id, NEW.id,
          style_record.slug, style_record.id, style_record.version_id,
          style_record.version_number, true, NEW.created_by, NEW.created_at);
  RETURN NEW;
END;
$$;

INSERT INTO app.spatial_service_collection_styles
  (organization_id, project_id, service_id, collection_id, style_name,
   style_id, sealed_style_version_id, sealed_style_version_number,
   is_default, created_by, created_at)
SELECT binding.organization_id, binding.project_id, binding.service_id, binding.id,
       style.slug, style.id, style_version.id, style_version.version_number,
       true, binding.created_by, binding.created_at
FROM app.spatial_service_collections binding
JOIN app.map_render_profile_versions profile_version
  ON profile_version.organization_id = binding.organization_id
 AND profile_version.profile_id = binding.default_profile_id
 AND profile_version.id = binding.sealed_profile_version_id
JOIN app.governed_resource_styles style
  ON style.organization_id = profile_version.organization_id
 AND style.id = profile_version.style_id
JOIN app.governed_resource_style_versions style_version
  ON style_version.organization_id = style.organization_id
 AND style_version.style_id = style.id
 AND style_version.id = profile_version.style_version_id;

CREATE TRIGGER spatial_service_metadata_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.spatial_service_metadata_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_spatial_catalog_history_mutation();
CREATE TRIGGER spatial_service_stores_validate_insert
  BEFORE INSERT ON app.spatial_service_stores
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_store_insert();
CREATE TRIGGER spatial_service_stores_enforce_transition
  BEFORE UPDATE ON app.spatial_service_stores
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_store_transition();
CREATE TRIGGER spatial_service_layer_group_versions_validate_insert
  BEFORE INSERT ON app.spatial_service_layer_group_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_layer_group_version();
CREATE TRIGGER spatial_service_layer_group_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.spatial_service_layer_group_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_spatial_catalog_history_mutation();
CREATE TRIGGER spatial_service_layer_groups_enforce_transition
  BEFORE UPDATE ON app.spatial_service_layer_groups
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_layer_group_transition();
CREATE TRIGGER spatial_service_collection_styles_validate_insert
  BEFORE INSERT ON app.spatial_service_collection_styles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_collection_style_insert();
CREATE TRIGGER spatial_service_collection_styles_enforce_transition
  BEFORE UPDATE ON app.spatial_service_collection_styles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_collection_style_transition();
CREATE TRIGGER spatial_service_collections_add_default_style
  AFTER INSERT ON app.spatial_service_collections
  FOR EACH ROW EXECUTE FUNCTION app.add_spatial_service_default_style();

ALTER TABLE app.spatial_service_metadata_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_layer_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_layer_group_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_collection_styles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_metadata_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_stores FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_layer_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_layer_group_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_collection_styles FORCE ROW LEVEL SECURITY;

CREATE POLICY spatial_service_metadata_versions_tenant_isolation
  ON app.spatial_service_metadata_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_service_stores_tenant_isolation
  ON app.spatial_service_stores
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_service_layer_groups_tenant_isolation
  ON app.spatial_service_layer_groups
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_service_layer_group_versions_tenant_isolation
  ON app.spatial_service_layer_group_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_service_collection_styles_tenant_isolation
  ON app.spatial_service_collection_styles
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.spatial_service_metadata_versions TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON
  app.spatial_service_stores,
  app.spatial_service_layer_groups,
  app.spatial_service_collection_styles
TO opengeo_runtime;
GRANT SELECT, INSERT ON app.spatial_service_layer_group_versions TO opengeo_runtime;
REVOKE DELETE ON
  app.spatial_service_metadata_versions,
  app.spatial_service_stores,
  app.spatial_service_layer_groups,
  app.spatial_service_layer_group_versions,
  app.spatial_service_collection_styles
FROM opengeo_runtime;
REVOKE ALL ON
  app.spatial_service_metadata_versions,
  app.spatial_service_stores,
  app.spatial_service_layer_groups,
  app.spatial_service_layer_group_versions,
  app.spatial_service_collection_styles
FROM opengeo_worker, opengeo_connector, opengeo_source_archiver;

REVOKE EXECUTE ON FUNCTION
  app.spatial_catalog_text_array_is_unique(text[]),
  app.spatial_catalog_uuid_array_is_unique(uuid[]),
  app.reject_spatial_catalog_history_mutation(),
  app.enforce_spatial_service_store_insert(),
  app.enforce_spatial_service_store_transition(),
  app.enforce_spatial_service_layer_group_version(),
  app.enforce_spatial_service_layer_group_transition(),
  app.enforce_spatial_service_collection_style_insert(),
  app.enforce_spatial_service_collection_style_transition(),
  app.add_spatial_service_default_style()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_source_archiver;

-- Runtime needs only the two immutable predicates because its INSERT checks
-- evaluate them; mutation triggers remain non-callable.
GRANT EXECUTE ON FUNCTION
  app.spatial_catalog_text_array_is_unique(text[]),
  app.spatial_catalog_uuid_array_is_unique(uuid[])
TO opengeo_runtime;

COMMENT ON TABLE app.spatial_service_metadata_versions IS
  'Immutable service metadata revisions; mutable service heads use exact compare-and-swap updates.';
COMMENT ON TABLE app.spatial_service_stores IS
  'Tenant/project/service-scoped store identities sealing managed, anonymous external, or verified read-only PostgreSQL sources.';
COMMENT ON TABLE app.spatial_service_layer_groups IS
  'Stable layer-group identities with immutable ordered collection revisions; first member draws on top.';
COMMENT ON TABLE app.spatial_service_collection_styles IS
  'Immutable default and alternate governed-style seals for one administered collection.';

COMMIT;
