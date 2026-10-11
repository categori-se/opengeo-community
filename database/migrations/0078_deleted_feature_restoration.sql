BEGIN;

ALTER TYPE app.feature_revision_operation ADD VALUE IF NOT EXISTS 'restore';

COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION app.enforce_feature_head_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.geometry_type IS DISTINCT FROM NEW.geometry_type
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'feature identity, type, and creation attribution are immutable';
  END IF;

  IF NEW.version_number <> OLD.version_number + 1 THEN
    RAISE EXCEPTION 'feature version must increase exactly once';
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NOT (NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL)
  THEN
    RAISE EXCEPTION 'a deleted feature head can only transition to a live restored version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.ensure_feature_head_has_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_required_operation app.feature_revision_operation;
BEGIN
  v_required_operation := CASE
    WHEN TG_OP = 'INSERT' THEN 'create'::app.feature_revision_operation
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
      THEN 'delete'::app.feature_revision_operation
    WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
      THEN 'restore'::app.feature_revision_operation
    ELSE 'update'::app.feature_revision_operation
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM app.dataset_feature_revisions revision
    WHERE revision.organization_id = NEW.organization_id
      AND revision.dataset_id = NEW.dataset_id
      AND revision.feature_id = NEW.id
      AND revision.version_number = NEW.version_number
      AND revision.operation = v_required_operation
      AND revision.geometry_type = NEW.geometry_type
      AND revision.properties = NEW.properties
      AND revision.geometry_geojson = NEW.geometry_geojson
      AND ST_Equals(revision.geometry, NEW.geometry)
  ) THEN
    RAISE EXCEPTION 'feature head mutation requires one matching immutable revision';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.enforce_feature_head_revision(),
  app.ensure_feature_head_has_revision()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.dataset_features IS
  'Stable feature heads in EPSG:4326 with optimistic versions, auditable tombstones, and explicit restoration.';
COMMENT ON TABLE app.dataset_feature_revisions IS
  'Append-only full feature snapshots for create, update, delete, and restore operations.';
COMMENT ON FUNCTION app.enforce_feature_head_revision() IS
  'Allows exact one-version live edits, tombstones, or explicit tombstone restoration while preserving feature identity.';
COMMENT ON FUNCTION app.ensure_feature_head_has_revision() IS
  'Requires the exact create, update, delete, or restore revision matching each feature-head transition.';

COMMIT;
