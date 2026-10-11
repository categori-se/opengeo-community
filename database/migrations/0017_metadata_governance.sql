BEGIN;

CREATE TABLE app.metadata_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  current_version_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, slug),
  CONSTRAINT metadata_profiles_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT metadata_profiles_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT metadata_profiles_description_bounded CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 4000
  )
);

CREATE TABLE app.metadata_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  profile_id uuid NOT NULL,
  version_number bigint NOT NULL,
  definition jsonb NOT NULL,
  checksum_sha256 text NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, profile_id, id),
  UNIQUE (organization_id, profile_id, version_number),
  CONSTRAINT metadata_profile_versions_positive CHECK (version_number > 0),
  CONSTRAINT metadata_profile_versions_definition_bounded CHECK (
    jsonb_typeof(definition) = 'object'
    AND octet_length(definition::text) BETWEEN 2 AND 32768
  ),
  CONSTRAINT metadata_profile_versions_checksum_valid CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT metadata_profile_versions_change_bounded CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES app.metadata_profiles (organization_id, id)
);

ALTER TABLE app.metadata_profiles
  ADD CONSTRAINT metadata_profiles_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.metadata_profile_versions (organization_id, profile_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app.governed_resource_versions
  ADD COLUMN metadata_profile_id uuid,
  ADD COLUMN metadata_profile_version_id uuid,
  ADD COLUMN metadata_validation jsonb,
  ADD CONSTRAINT governed_resource_versions_managed_profile_shape CHECK (
    (
      metadata_profile_id IS NULL
      AND metadata_profile_version_id IS NULL
      AND metadata_validation IS NULL
    )
    OR (
      metadata_profile_id IS NOT NULL
      AND metadata_profile_version_id IS NOT NULL
      AND metadata_validation IS NOT NULL
      AND jsonb_typeof(metadata_validation) = 'object'
      AND octet_length(metadata_validation::text) <= 16384
    )
  ),
  ADD CONSTRAINT governed_resource_versions_managed_profile_fk
  FOREIGN KEY (organization_id, metadata_profile_id, metadata_profile_version_id)
  REFERENCES app.metadata_profile_versions (organization_id, profile_id, id);

CREATE INDEX metadata_profiles_catalog_idx
  ON app.metadata_profiles (organization_id, lower(title), id);
CREATE INDEX metadata_profile_versions_history_idx
  ON app.metadata_profile_versions (
    organization_id,
    profile_id,
    version_number DESC
  );
CREATE INDEX governed_resource_versions_managed_profile_idx
  ON app.governed_resource_versions (
    organization_id,
    metadata_profile_id,
    metadata_profile_version_id
  )
  WHERE metadata_profile_id IS NOT NULL;

CREATE FUNCTION app.enforce_metadata_profile_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.slug <> OLD.slug
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'metadata profile identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER metadata_profiles_enforce_transition
  BEFORE UPDATE ON app.metadata_profiles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_metadata_profile_transition();
CREATE TRIGGER metadata_profiles_set_updated_at
  BEFORE UPDATE ON app.metadata_profiles
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER metadata_profile_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.metadata_profile_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.metadata_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.metadata_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.metadata_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.metadata_profile_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY metadata_profiles_tenant_isolation ON app.metadata_profiles
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY metadata_profile_versions_tenant_isolation
  ON app.metadata_profile_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.metadata_profiles TO opengeo_runtime;
GRANT SELECT, INSERT ON app.metadata_profile_versions TO opengeo_runtime;
REVOKE DELETE ON app.metadata_profiles, app.metadata_profile_versions
FROM opengeo_runtime;
REVOKE ALL ON app.metadata_profiles, app.metadata_profile_versions
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION app.enforce_metadata_profile_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.metadata_profiles IS
  'Organization-owned reusable metadata profile identities with immutable slugs and version pointers.';
COMMENT ON TABLE app.metadata_profile_versions IS
  'Immutable bounded metadata field dictionaries, requirements, vocabularies, and extension contracts.';
COMMENT ON COLUMN app.governed_resource_versions.metadata_validation IS
  'Immutable validation snapshot for the exact managed metadata profile version bound to this resource version.';

COMMIT;
