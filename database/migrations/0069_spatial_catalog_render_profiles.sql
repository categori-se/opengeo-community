BEGIN;

-- GEOSERVER-006 makes catalog styles executable without weakening the
-- immutable render-profile boundary. A style advertisement may be retained
-- without a render profile, but every default style must seal one exact
-- current profile whose style revision is the advertised revision.

ALTER TABLE app.spatial_service_collection_styles
  ADD COLUMN render_profile_id uuid,
  ADD COLUMN sealed_profile_version_id uuid,
  ADD COLUMN sealed_profile_version_number bigint;

ALTER TABLE app.spatial_service_collection_styles
  DISABLE TRIGGER spatial_service_collection_styles_enforce_transition;

UPDATE app.spatial_service_collection_styles style_binding
SET render_profile_id = profile.id,
    sealed_profile_version_id = profile_version.id,
    sealed_profile_version_number = profile_version.version_number
FROM app.spatial_service_collections collection
JOIN app.map_render_profiles profile
  ON profile.organization_id = collection.organization_id
 AND profile.project_id = collection.project_id
 AND profile.resource_id = collection.resource_id
 AND profile.id = collection.default_profile_id
JOIN app.map_render_profile_versions profile_version
  ON profile_version.organization_id = profile.organization_id
 AND profile_version.profile_id = profile.id
 AND profile_version.id = profile.current_version_id
 AND profile_version.id = collection.sealed_profile_version_id
WHERE collection.organization_id = style_binding.organization_id
  AND collection.project_id = style_binding.project_id
  AND collection.service_id = style_binding.service_id
  AND collection.id = style_binding.collection_id
  AND profile_version.style_id = style_binding.style_id
  AND profile_version.style_version_id = style_binding.sealed_style_version_id;

WITH candidates AS (
  SELECT style_binding.organization_id,
         style_binding.id AS binding_id,
         profile.id AS profile_id,
         version.id AS version_id,
         version.version_number,
         count(*) OVER (
           PARTITION BY style_binding.organization_id, style_binding.id
         ) AS candidate_count
  FROM app.spatial_service_collection_styles style_binding
  JOIN app.spatial_service_collections collection
    ON collection.organization_id = style_binding.organization_id
   AND collection.project_id = style_binding.project_id
   AND collection.service_id = style_binding.service_id
   AND collection.id = style_binding.collection_id
  JOIN app.map_render_profiles profile
    ON profile.organization_id = collection.organization_id
   AND profile.project_id = collection.project_id
   AND profile.resource_id = collection.resource_id
  JOIN app.map_render_profile_versions version
    ON version.organization_id = profile.organization_id
   AND version.profile_id = profile.id
   AND version.id = profile.current_version_id
   AND version.style_id = style_binding.style_id
   AND version.style_version_id = style_binding.sealed_style_version_id
  WHERE style_binding.render_profile_id IS NULL
)
UPDATE app.spatial_service_collection_styles style_binding
SET render_profile_id = candidates.profile_id,
    sealed_profile_version_id = candidates.version_id,
    sealed_profile_version_number = candidates.version_number
FROM candidates
WHERE candidates.organization_id = style_binding.organization_id
  AND candidates.binding_id = style_binding.id
  AND candidates.candidate_count = 1;

ALTER TABLE app.spatial_service_collection_styles
  ENABLE TRIGGER spatial_service_collection_styles_enforce_transition;

ALTER TABLE app.spatial_service_collection_styles
  ADD CONSTRAINT spatial_service_collection_styles_profile_shape CHECK (
    (
      render_profile_id IS NULL
      AND sealed_profile_version_id IS NULL
      AND sealed_profile_version_number IS NULL
    )
    OR (
      render_profile_id IS NOT NULL
      AND sealed_profile_version_id IS NOT NULL
      AND sealed_profile_version_number > 0
    )
  ),
  ADD CONSTRAINT spatial_service_collection_styles_default_profile_required CHECK (
    NOT is_default OR withdrawn_at IS NOT NULL OR render_profile_id IS NOT NULL
  ),
  ADD CONSTRAINT spatial_service_collection_styles_profile_version_fk
    FOREIGN KEY (organization_id, render_profile_id, sealed_profile_version_id)
    REFERENCES app.map_render_profile_versions (organization_id, profile_id, id);

CREATE INDEX spatial_service_collection_styles_profile_idx
  ON app.spatial_service_collection_styles (
    organization_id, project_id, render_profile_id, withdrawn_at
  );

DROP INDEX app.spatial_service_collection_styles_name_identity_idx;
CREATE UNIQUE INDEX spatial_service_collection_styles_active_name_idx
  ON app.spatial_service_collection_styles (
    organization_id, collection_id, lower(style_name)
  )
  WHERE withdrawn_at IS NULL;

CREATE OR REPLACE FUNCTION app.enforce_spatial_service_collection_style_insert()
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
  FROM app.spatial_service_collections collection
  JOIN app.governed_resource_styles style
    ON style.organization_id = collection.organization_id
   AND style.project_id = collection.project_id
   AND style.resource_id = collection.resource_id
   AND style.id = NEW.style_id
  JOIN app.governed_resource_style_versions style_version
    ON style_version.organization_id = style.organization_id
   AND style_version.style_id = style.id
   AND style_version.id = style.current_version_id
   AND style_version.id = NEW.sealed_style_version_id
   AND style_version.version_number = NEW.sealed_style_version_number
  LEFT JOIN app.map_render_profiles profile
    ON profile.organization_id = collection.organization_id
   AND profile.project_id = collection.project_id
   AND profile.resource_id = collection.resource_id
   AND profile.id = NEW.render_profile_id
  LEFT JOIN app.map_render_profile_versions profile_version
    ON profile_version.organization_id = profile.organization_id
   AND profile_version.profile_id = profile.id
   AND profile_version.id = profile.current_version_id
   AND profile_version.id = NEW.sealed_profile_version_id
   AND profile_version.version_number = NEW.sealed_profile_version_number
   AND profile_version.style_id = NEW.style_id
   AND profile_version.style_version_id = NEW.sealed_style_version_id
  WHERE collection.organization_id = NEW.organization_id
    AND collection.project_id = NEW.project_id
    AND collection.service_id = NEW.service_id
    AND collection.id = NEW.collection_id
    AND collection.withdrawn_at IS NULL
    AND (
      (NEW.render_profile_id IS NULL AND NOT NEW.is_default)
      OR profile_version.id IS NOT NULL
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service collection style must seal current same-resource style and profile revisions';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_spatial_service_collection_style_transition()
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
    OR NEW.render_profile_id IS DISTINCT FROM OLD.render_profile_id
    OR NEW.sealed_profile_version_id IS DISTINCT FROM OLD.sealed_profile_version_id
    OR NEW.sealed_profile_version_number IS DISTINCT FROM OLD.sealed_profile_version_number
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

CREATE OR REPLACE FUNCTION app.add_spatial_service_default_style()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  style_record record;
BEGIN
  SELECT style.id, style.slug, style_version.id AS style_version_id,
         style_version.version_number AS style_version_number,
         profile.id AS profile_id, profile_version.id AS profile_version_id,
         profile_version.version_number AS profile_version_number
  INTO style_record
  FROM app.map_render_profiles profile
  JOIN app.map_render_profile_versions profile_version
    ON profile_version.organization_id = profile.organization_id
   AND profile_version.profile_id = profile.id
   AND profile_version.id = profile.current_version_id
  JOIN app.governed_resource_styles style
    ON style.organization_id = profile_version.organization_id
   AND style.id = profile_version.style_id
  JOIN app.governed_resource_style_versions style_version
    ON style_version.organization_id = style.organization_id
   AND style_version.style_id = style.id
   AND style_version.id = profile_version.style_version_id
  WHERE profile.organization_id = NEW.organization_id
    AND profile.id = NEW.default_profile_id
    AND profile_version.id = NEW.sealed_profile_version_id;
  IF style_record.id IS NULL THEN
    RAISE EXCEPTION 'spatial service collection default style seal is missing';
  END IF;
  INSERT INTO app.spatial_service_collection_styles
    (organization_id, project_id, service_id, collection_id, style_name,
     style_id, sealed_style_version_id, sealed_style_version_number,
     render_profile_id, sealed_profile_version_id,
     sealed_profile_version_number, is_default, created_by, created_at)
  VALUES (NEW.organization_id, NEW.project_id, NEW.service_id, NEW.id,
          style_record.slug, style_record.id, style_record.style_version_id,
          style_record.style_version_number, style_record.profile_id,
          style_record.profile_version_id, style_record.profile_version_number,
          true, NEW.created_by, NEW.created_at);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.enforce_spatial_service_collection_style_insert(),
  app.enforce_spatial_service_collection_style_transition(),
  app.add_spatial_service_default_style()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
     opengeo_source_archiver;

COMMIT;
