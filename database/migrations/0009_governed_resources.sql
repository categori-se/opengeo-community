BEGIN;

CREATE TYPE app.governed_resource_kind AS ENUM (
  'dataset',
  'map',
  'document',
  'story',
  'dashboard',
  'service'
);
CREATE TYPE app.governed_resource_visibility AS ENUM (
  'restricted',
  'organization',
  'public'
);
CREATE TYPE app.governed_resource_state AS ENUM (
  'draft',
  'review',
  'published',
  'archived'
);
CREATE TYPE app.governed_resource_relation AS ENUM (
  'references',
  'has_part',
  'is_part_of',
  'derived_from',
  'documents'
);

-- The additional key permits a tenant/project-safe FK from a resource to a map.
CREATE UNIQUE INDEX maps_governed_resource_binding_idx
  ON app.maps (organization_id, project_id, id);

CREATE TABLE app.governed_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  kind app.governed_resource_kind NOT NULL,
  slug text NOT NULL,
  dataset_id uuid,
  map_id uuid,
  visibility app.governed_resource_visibility NOT NULL DEFAULT 'restricted',
  state app.governed_resource_state NOT NULL DEFAULT 'draft',
  current_version_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, slug),
  CONSTRAINT governed_resources_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
  ),
  CONSTRAINT governed_resources_binding_shape CHECK (
    (dataset_id IS NULL OR kind IN ('dataset', 'service'))
    AND (map_id IS NULL OR kind = 'map')
    AND NOT (dataset_id IS NOT NULL AND map_id IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, dataset_id)
    REFERENCES app.project_datasets (organization_id, project_id, dataset_id),
  FOREIGN KEY (organization_id, project_id, map_id)
    REFERENCES app.maps (organization_id, project_id, id)
);

CREATE TABLE app.governed_resource_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  resource_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  abstract text,
  language text NOT NULL DEFAULT 'en',
  license text,
  attribution text,
  keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  spatial_extent jsonb,
  temporal_start timestamptz,
  temporal_end timestamptz,
  metadata_profile text NOT NULL DEFAULT 'opengeo.core.v1',
  metadata_extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  content jsonb NOT NULL DEFAULT '{"blocks":[]}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_message text,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(abstract, ''))
  ) STORED,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, resource_id, id),
  UNIQUE (organization_id, resource_id, version_number),
  CONSTRAINT governed_resource_versions_positive CHECK (version_number > 0),
  CONSTRAINT governed_resource_versions_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT governed_resource_versions_abstract_bounded CHECK (
    abstract IS NULL OR char_length(abstract) BETWEEN 1 AND 8000
  ),
  CONSTRAINT governed_resource_versions_language_bounded CHECK (
    language ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$'
  ),
  CONSTRAINT governed_resource_versions_rights_bounded CHECK (
    (license IS NULL OR char_length(license) BETWEEN 1 AND 1000)
    AND (attribution IS NULL OR char_length(attribution) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT governed_resource_versions_keywords_bounded CHECK (
    cardinality(keywords) <= 64
  ),
  CONSTRAINT governed_resource_versions_extent_shape CHECK (
    spatial_extent IS NULL
    OR (jsonb_typeof(spatial_extent) = 'array' AND jsonb_array_length(spatial_extent) = 4)
  ),
  CONSTRAINT governed_resource_versions_temporal_order CHECK (
    temporal_start IS NULL OR temporal_end IS NULL OR temporal_start <= temporal_end
  ),
  CONSTRAINT governed_resource_versions_profile_bounded CHECK (
    metadata_profile ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  CONSTRAINT governed_resource_versions_documents_bounded CHECK (
    jsonb_typeof(metadata_extensions) = 'object'
    AND octet_length(metadata_extensions::text) <= 8192
    AND jsonb_typeof(content) = 'object'
    AND octet_length(content::text) <= 16384
    AND jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 4096
  ),
  CONSTRAINT governed_resource_versions_change_bounded CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, resource_id)
    REFERENCES app.governed_resources (organization_id, id)
);

ALTER TABLE app.governed_resources
  ADD CONSTRAINT governed_resources_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.governed_resource_versions (organization_id, resource_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.governed_resource_external_identifiers (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  resource_id uuid NOT NULL,
  namespace text NOT NULL,
  identifier text NOT NULL,
  source_url text NOT NULL,
  source_version text NOT NULL,
  source_payload_sha256 text NOT NULL,
  imported_by uuid NOT NULL REFERENCES app.users(id),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, namespace, identifier),
  UNIQUE (organization_id, resource_id, namespace),
  CONSTRAINT governed_resource_external_namespace_bounded CHECK (
    namespace ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT governed_resource_external_identifier_bounded CHECK (
    char_length(identifier) BETWEEN 1 AND 300
  ),
  CONSTRAINT governed_resource_external_source_bounded CHECK (
    char_length(source_url) BETWEEN 9 AND 2048
    AND char_length(source_version) BETWEEN 1 AND 40
    AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  FOREIGN KEY (organization_id, resource_id)
    REFERENCES app.governed_resources (organization_id, id)
);

CREATE TABLE app.governed_resource_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_resource_id uuid NOT NULL,
  target_resource_id uuid NOT NULL,
  relation app.governed_resource_relation NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id,
    project_id,
    source_resource_id,
    target_resource_id,
    relation
  ),
  CONSTRAINT governed_resource_relationship_not_self CHECK (
    source_resource_id <> target_resource_id
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, source_resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, target_resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE INDEX governed_resources_catalog_idx
  ON app.governed_resources (
    organization_id,
    project_id,
    state,
    visibility,
    kind,
    updated_at DESC,
    id
  );
CREATE INDEX governed_resource_versions_history_idx
  ON app.governed_resource_versions (
    organization_id,
    resource_id,
    version_number DESC
  );
CREATE INDEX governed_resource_versions_search_idx
  ON app.governed_resource_versions USING gin (search_document);
CREATE INDEX governed_resource_relationships_target_idx
  ON app.governed_resource_relationships (
    organization_id,
    project_id,
    target_resource_id,
    relation
  );

CREATE FUNCTION app.enforce_governed_resource_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.kind <> OLD.kind
    OR NEW.slug <> OLD.slug
    OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
    OR NEW.map_id IS DISTINCT FROM OLD.map_id
    OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'governed resource identity and binding are immutable';
  END IF;
  IF OLD.state = 'archived' OR NEW.state < OLD.state THEN
    RAISE EXCEPTION 'governed resource state transitions are forward-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_governed_resource_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governed resource history is immutable';
END;
$$;

CREATE TRIGGER governed_resources_enforce_transition
  BEFORE UPDATE ON app.governed_resources
  FOR EACH ROW EXECUTE FUNCTION app.enforce_governed_resource_transition();
CREATE TRIGGER governed_resources_set_updated_at
  BEFORE UPDATE ON app.governed_resources
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER governed_resource_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER governed_resource_external_identifiers_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_external_identifiers
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER governed_resource_relationships_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_relationships
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.governed_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_external_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_external_identifiers FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_relationships FORCE ROW LEVEL SECURITY;

CREATE POLICY governed_resources_tenant_isolation ON app.governed_resources
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_versions_tenant_isolation ON app.governed_resource_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_external_identifiers_tenant_isolation
  ON app.governed_resource_external_identifiers
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY governed_resource_relationships_tenant_isolation
  ON app.governed_resource_relationships
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.governed_resources TO opengeo_runtime;
GRANT SELECT, INSERT ON
  app.governed_resource_versions,
  app.governed_resource_external_identifiers,
  app.governed_resource_relationships
TO opengeo_runtime;
REVOKE DELETE ON
  app.governed_resources,
  app.governed_resource_versions,
  app.governed_resource_external_identifiers,
  app.governed_resource_relationships
FROM opengeo_runtime;
REVOKE ALL ON
  app.governed_resources,
  app.governed_resource_versions,
  app.governed_resource_external_identifiers,
  app.governed_resource_relationships
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_governed_resource_transition(),
  app.reject_governed_resource_history_mutation()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.governed_resources IS
  'First-class tenant/project resources with stable OpenGeo identities and optional governed data/map bindings.';
COMMENT ON TABLE app.governed_resource_versions IS
  'Immutable descriptive, rights, extent, content, provenance, and extension snapshots for governed resources.';
COMMENT ON TABLE app.governed_resource_external_identifiers IS
  'Collision-safe provenance for imported GeoNode and future external catalog identities.';
COMMENT ON TABLE app.governed_resource_relationships IS
  'Immutable directed relationships between first-class resources in one governed project.';

COMMIT;
