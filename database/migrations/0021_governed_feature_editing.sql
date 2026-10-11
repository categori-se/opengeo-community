BEGIN;

CREATE TYPE app.feature_geometry_type AS ENUM (
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon'
);

CREATE TYPE app.feature_revision_operation AS ENUM (
  'create',
  'update',
  'delete'
);

CREATE TABLE app.feature_collections (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  geometry_type app.feature_geometry_type NOT NULL,
  schema_definition jsonb NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  feature_count bigint NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id),
  CONSTRAINT feature_collections_generation_positive CHECK (generation > 0),
  CONSTRAINT feature_collections_count_nonnegative CHECK (feature_count >= 0),
  CONSTRAINT feature_collections_schema_object CHECK (
    jsonb_typeof(schema_definition) = 'object'
    AND schema_definition->>'schemaVersion' = '1.0.0'
    AND jsonb_typeof(schema_definition->'fields') = 'array'
    AND jsonb_array_length(schema_definition->'fields') <= 64
  ),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

CREATE TABLE app.dataset_features (
  id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  version_number bigint NOT NULL DEFAULT 1,
  geometry_type app.feature_geometry_type NOT NULL,
  properties jsonb NOT NULL,
  geometry_geojson jsonb NOT NULL,
  geometry geometry(Geometry, 4326) NOT NULL,
  bbox double precision[] GENERATED ALWAYS AS (
    ARRAY[
      ST_XMin(Box3D(geometry)),
      ST_YMin(Box3D(geometry)),
      ST_XMax(Box3D(geometry)),
      ST_YMax(Box3D(geometry))
    ]
  ) STORED,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_by uuid REFERENCES app.users(id),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, dataset_id, id),
  CONSTRAINT dataset_features_version_positive CHECK (version_number > 0),
  CONSTRAINT dataset_features_properties_object CHECK (
    jsonb_typeof(properties) = 'object' AND pg_column_size(properties) <= 32768
  ),
  CONSTRAINT dataset_features_geojson_object CHECK (
    jsonb_typeof(geometry_geojson) = 'object'
    AND geometry_geojson->>'type' = geometry_type::text
    AND jsonb_typeof(geometry_geojson->'coordinates') = 'array'
    AND pg_column_size(geometry_geojson) <= 262144
  ),
  CONSTRAINT dataset_features_geometry_type_match CHECK (
    lower(GeometryType(geometry)) = lower(geometry_type::text)
  ),
  CONSTRAINT dataset_features_geometry_safe CHECK (
    ST_SRID(geometry) = 4326
    AND ST_NDims(geometry) = 2
    AND NOT ST_IsEmpty(geometry)
    AND ST_IsValid(geometry)
  ),
  CONSTRAINT dataset_features_delete_shape CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.feature_collections (organization_id, dataset_id)
);

CREATE INDEX dataset_features_live_list_idx
  ON app.dataset_features (organization_id, dataset_id, id)
  WHERE deleted_at IS NULL;
CREATE INDEX dataset_features_geometry_idx
  ON app.dataset_features USING gist (geometry)
  WHERE deleted_at IS NULL;

CREATE TABLE app.dataset_feature_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  version_number bigint NOT NULL,
  operation app.feature_revision_operation NOT NULL,
  geometry_type app.feature_geometry_type NOT NULL,
  properties jsonb NOT NULL,
  geometry_geojson jsonb NOT NULL,
  geometry geometry(Geometry, 4326) NOT NULL,
  changed_by uuid NOT NULL REFERENCES app.users(id),
  change_message text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dataset_id, feature_id, version_number),
  CONSTRAINT dataset_feature_revisions_version_positive CHECK (version_number > 0),
  CONSTRAINT dataset_feature_revisions_properties_object CHECK (
    jsonb_typeof(properties) = 'object' AND pg_column_size(properties) <= 32768
  ),
  CONSTRAINT dataset_feature_revisions_geojson_object CHECK (
    jsonb_typeof(geometry_geojson) = 'object'
    AND geometry_geojson->>'type' = geometry_type::text
    AND jsonb_typeof(geometry_geojson->'coordinates') = 'array'
    AND pg_column_size(geometry_geojson) <= 262144
  ),
  CONSTRAINT dataset_feature_revisions_geometry_type_match CHECK (
    lower(GeometryType(geometry)) = lower(geometry_type::text)
  ),
  CONSTRAINT dataset_feature_revisions_geometry_safe CHECK (
    ST_SRID(geometry) = 4326
    AND ST_NDims(geometry) = 2
    AND NOT ST_IsEmpty(geometry)
    AND ST_IsValid(geometry)
  ),
  CONSTRAINT dataset_feature_revisions_message_bound CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  CONSTRAINT dataset_feature_revisions_request_id_bound CHECK (
    char_length(request_id) BETWEEN 1 AND 128
  ),
  FOREIGN KEY (organization_id, dataset_id, feature_id)
    REFERENCES app.dataset_features (organization_id, dataset_id, id)
);

CREATE INDEX dataset_feature_revisions_history_idx
  ON app.dataset_feature_revisions (
    organization_id,
    dataset_id,
    feature_id,
    version_number DESC
  );

CREATE FUNCTION app.enforce_feature_collection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.geometry_type IS DISTINCT FROM NEW.geometry_type
    OR OLD.schema_definition IS DISTINCT FROM NEW.schema_definition
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'feature collection identity and schema are immutable';
  END IF;

  IF NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'feature collection generation must increase exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_feature_head_revision()
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
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deleted feature heads are immutable';
  END IF;
  IF NEW.version_number <> OLD.version_number + 1 THEN
    RAISE EXCEPTION 'feature version must increase exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.ensure_feature_head_has_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.dataset_feature_revisions revision
    WHERE revision.organization_id = NEW.organization_id
      AND revision.dataset_id = NEW.dataset_id
      AND revision.feature_id = NEW.id
      AND revision.version_number = NEW.version_number
      AND revision.geometry_type = NEW.geometry_type
      AND revision.properties = NEW.properties
      AND revision.geometry_geojson = NEW.geometry_geojson
      AND ST_Equals(revision.geometry, NEW.geometry)
      AND (
        (NEW.deleted_at IS NULL AND revision.operation IN ('create', 'update'))
        OR (NEW.deleted_at IS NOT NULL AND revision.operation = 'delete')
      )
  ) THEN
    RAISE EXCEPTION 'feature head mutation requires one matching immutable revision';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER feature_collections_enforce_revision
  BEFORE UPDATE ON app.feature_collections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_feature_collection_revision();
CREATE TRIGGER feature_collections_set_updated_at
  BEFORE UPDATE ON app.feature_collections
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER dataset_features_enforce_revision
  BEFORE UPDATE ON app.dataset_features
  FOR EACH ROW EXECUTE FUNCTION app.enforce_feature_head_revision();
CREATE TRIGGER dataset_features_set_updated_at
  BEFORE UPDATE ON app.dataset_features
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE CONSTRAINT TRIGGER dataset_features_require_history
  AFTER INSERT OR UPDATE ON app.dataset_features
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.ensure_feature_head_has_revision();
CREATE TRIGGER dataset_feature_revisions_are_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_feature_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

ALTER TABLE app.feature_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_feature_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feature_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_features FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_feature_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY feature_collections_tenant_isolation ON app.feature_collections
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_features_tenant_isolation ON app.dataset_features
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_feature_revisions_tenant_isolation
  ON app.dataset_feature_revisions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

REVOKE ALL ON
  app.feature_collections,
  app.dataset_features,
  app.dataset_feature_revisions
FROM opengeo_worker;
GRANT SELECT, INSERT, UPDATE ON app.feature_collections TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.dataset_features TO opengeo_runtime;
GRANT SELECT, INSERT ON app.dataset_feature_revisions TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION
  app.enforce_feature_collection_revision(),
  app.enforce_feature_head_revision(),
  app.ensure_feature_head_has_revision()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.feature_collections IS
  'Authoritative editable vector collections with one immutable field schema and monotonically increasing generation.';
COMMENT ON TABLE app.dataset_features IS
  'Stable feature heads in EPSG:4326 with optimistic versions and forward-only tombstones.';
COMMENT ON TABLE app.dataset_feature_revisions IS
  'Append-only full feature snapshots for create, update, and delete operations.';

COMMIT;
