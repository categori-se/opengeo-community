BEGIN;

CREATE TYPE app.project_discussion_target_kind AS ENUM ('project', 'feature');

ALTER TABLE app.maps
  ADD CONSTRAINT maps_organization_project_id_unique
  UNIQUE (organization_id, project_id, id);

ALTER TABLE app.project_discussions
  ADD COLUMN target_kind app.project_discussion_target_kind NOT NULL DEFAULT 'project',
  ADD COLUMN target_map_id uuid,
  ADD COLUMN target_map_version bigint,
  ADD COLUMN target_layer_id text,
  ADD COLUMN target_dataset_id uuid,
  ADD COLUMN target_feature_id uuid,
  ADD CONSTRAINT project_discussions_target_shape CHECK (
    (
      target_kind = 'project'
      AND target_map_id IS NULL
      AND target_map_version IS NULL
      AND target_layer_id IS NULL
      AND target_dataset_id IS NULL
      AND target_feature_id IS NULL
    )
    OR (
      target_kind = 'feature'
      AND target_map_id IS NOT NULL
      AND target_map_version IS NOT NULL
      AND target_layer_id IS NOT NULL
      AND target_dataset_id IS NOT NULL
      AND target_feature_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT project_discussions_target_map_version_positive CHECK (
    target_map_version IS NULL OR target_map_version > 0
  ),
  ADD CONSTRAINT project_discussions_target_layer_id_bounded CHECK (
    target_layer_id IS NULL
    OR (
      char_length(target_layer_id) BETWEEN 1 AND 160
      AND target_layer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  ),
  ADD CONSTRAINT project_discussions_target_map_fk
    FOREIGN KEY (organization_id, project_id, target_map_id)
    REFERENCES app.maps (organization_id, project_id, id),
  ADD CONSTRAINT project_discussions_target_map_version_fk
    FOREIGN KEY (organization_id, target_map_id, target_map_version)
    REFERENCES app.map_versions (organization_id, map_id, version),
  ADD CONSTRAINT project_discussions_target_project_dataset_fk
    FOREIGN KEY (organization_id, project_id, target_dataset_id)
    REFERENCES app.project_datasets (organization_id, project_id, dataset_id),
  ADD CONSTRAINT project_discussions_target_feature_fk
    FOREIGN KEY (organization_id, target_dataset_id, target_feature_id)
    REFERENCES app.dataset_features (organization_id, dataset_id, id);

CREATE INDEX project_discussions_feature_target_idx
  ON app.project_discussions (
    organization_id, project_id, target_dataset_id, target_feature_id,
    updated_at DESC, id
  )
  WHERE target_kind = 'feature';

CREATE FUNCTION app.validate_project_discussion_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_exists boolean;
BEGIN
  IF NEW.target_kind = 'project' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app.maps map
    JOIN app.map_versions map_version
      ON map_version.organization_id = map.organization_id
     AND map_version.map_id = map.id
     AND map_version.version = NEW.target_map_version
    JOIN app.project_datasets project_dataset
      ON project_dataset.organization_id = map.organization_id
     AND project_dataset.project_id = map.project_id
     AND project_dataset.dataset_id = NEW.target_dataset_id
    JOIN app.dataset_features feature
      ON feature.organization_id = project_dataset.organization_id
     AND feature.dataset_id = project_dataset.dataset_id
     AND feature.id = NEW.target_feature_id
     AND feature.deleted_at IS NULL
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(map_version.definition->'layers') = 'array'
          THEN map_version.definition->'layers'
        ELSE '[]'::jsonb
      END
    ) layer
    WHERE map.organization_id = NEW.organization_id
      AND map.project_id = NEW.project_id
      AND map.id = NEW.target_map_id
      AND map.status = 'active'
      AND layer->>'layerId' = NEW.target_layer_id
      AND layer->>'datasetId' = NEW.target_dataset_id::text
  ) INTO v_target_exists;

  IF NOT COALESCE(v_target_exists, false) THEN
    RAISE EXCEPTION
      'feature discussion target must reference one live feature through one exact project map layer version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_project_discussion_target_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project discussion target is immutable';
END;
$$;

CREATE TRIGGER project_discussions_validate_target
  BEFORE INSERT ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.validate_project_discussion_target();
CREATE TRIGGER project_discussions_target_is_immutable
  BEFORE UPDATE OF
    target_kind,
    target_map_id,
    target_map_version,
    target_layer_id,
    target_dataset_id,
    target_feature_id
  ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_target_change();

REVOKE EXECUTE ON FUNCTION
  app.validate_project_discussion_target(),
  app.reject_project_discussion_target_change()
FROM PUBLIC;

COMMENT ON TYPE app.project_discussion_target_kind IS
  'A discussion is either project-wide or permanently anchored to one exact map-layer-feature context.';
COMMENT ON COLUMN app.project_discussions.target_map_version IS
  'Immutable map version used to validate and explain the layer context when a feature discussion begins.';
COMMENT ON COLUMN app.project_discussions.target_layer_id IS
  'Exact layer identifier in the referenced immutable map definition; the layer must target target_dataset_id.';
COMMENT ON FUNCTION app.validate_project_discussion_target() IS
  'Rejects forged, stale, deleted, cross-project, or layer/dataset-mismatched feature discussion targets.';

COMMIT;
