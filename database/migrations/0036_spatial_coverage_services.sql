BEGIN;

CREATE TABLE app.spatial_service_coverages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  coverage_name text NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  data_object_id uuid NOT NULL,
  sealed_dataset_version_number bigint NOT NULL,
  sealed_crs text NOT NULL,
  sealed_extent jsonb NOT NULL,
  sealed_width integer NOT NULL,
  sealed_height integer NOT NULL,
  sealed_band_count integer NOT NULL,
  sealed_bands jsonb NOT NULL,
  sealed_bucket text NOT NULL,
  sealed_object_key text NOT NULL,
  sealed_storage_version_id text NOT NULL,
  sealed_content_type text NOT NULL,
  sealed_size_bytes bigint NOT NULL,
  sealed_checksum_sha256 text NOT NULL,
  title text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by uuid REFERENCES app.users(id),
  withdrawn_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT spatial_service_coverages_name_bounded CHECK (
    coverage_name ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT spatial_service_coverages_version_positive CHECK (
    sealed_dataset_version_number > 0
  ),
  CONSTRAINT spatial_service_coverages_crs_bounded CHECK (
    sealed_crs = btrim(sealed_crs) AND char_length(sealed_crs) BETWEEN 1 AND 2048
  ),
  CONSTRAINT spatial_service_coverages_extent_shape CHECK (
    jsonb_typeof(sealed_extent) = 'array'
    AND jsonb_array_length(sealed_extent) = 4
    AND jsonb_typeof(sealed_extent->0) = 'number'
    AND jsonb_typeof(sealed_extent->1) = 'number'
    AND jsonb_typeof(sealed_extent->2) = 'number'
    AND jsonb_typeof(sealed_extent->3) = 'number'
    AND (sealed_extent->>0)::numeric BETWEEN -1e100 AND 1e100
    AND (sealed_extent->>1)::numeric BETWEEN -1e100 AND 1e100
    AND (sealed_extent->>2)::numeric BETWEEN -1e100 AND 1e100
    AND (sealed_extent->>3)::numeric BETWEEN -1e100 AND 1e100
    AND (sealed_extent->>0)::numeric < (sealed_extent->>2)::numeric
    AND (sealed_extent->>1)::numeric < (sealed_extent->>3)::numeric
  ),
  CONSTRAINT spatial_service_coverages_grid_bounded CHECK (
    sealed_width BETWEEN 1 AND 1000000
    AND sealed_height BETWEEN 1 AND 1000000
    AND sealed_width::bigint * sealed_height::bigint <= 100000000000
    AND sealed_band_count BETWEEN 1 AND 64
  ),
  CONSTRAINT spatial_service_coverages_bands_shape CHECK (
    jsonb_typeof(sealed_bands) = 'array'
    AND jsonb_array_length(sealed_bands) = sealed_band_count
  ),
  CONSTRAINT spatial_service_coverages_object_shape CHECK (
    sealed_bucket <> ''
    AND sealed_object_key <> ''
    AND sealed_storage_version_id <> ''
    AND sealed_content_type IN ('image/tiff', 'image/geotiff')
    AND sealed_size_bytes > 0
    AND sealed_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT spatial_service_coverages_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT spatial_service_coverages_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT spatial_service_coverages_withdrawal_shape CHECK (
    (withdrawn_by IS NULL AND withdrawn_at IS NULL)
    OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawn_at >= created_at)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id),
  FOREIGN KEY (organization_id, project_id, dataset_id)
    REFERENCES app.project_datasets (organization_id, project_id, dataset_id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, data_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, dataset_version_id, data_object_id)
    REFERENCES app.dataset_version_objects (
      organization_id, dataset_version_id, data_object_id
    )
);

-- Coverage protocol identifiers remain reserved after withdrawal so an old WCS
-- bookmark can never resolve to different raster bytes.
CREATE UNIQUE INDEX spatial_service_coverages_name_identity_idx
  ON app.spatial_service_coverages (
    organization_id, service_id, lower(coverage_name)
  );
CREATE UNIQUE INDEX spatial_service_coverages_one_active_dataset_idx
  ON app.spatial_service_coverages (organization_id, service_id, dataset_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX spatial_service_coverages_catalog_idx
  ON app.spatial_service_coverages (
    organization_id, project_id, service_id, withdrawn_at,
    lower(coverage_name), id
  );

CREATE FUNCTION app.enforce_spatial_service_coverage_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.withdrawn_by IS NOT NULL
    OR NEW.withdrawn_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'spatial service coverage creator mismatch';
  END IF;

  PERFORM 1
  FROM app.spatial_services service
  JOIN app.datasets dataset
    ON dataset.organization_id = service.organization_id
   AND dataset.id = NEW.dataset_id
  JOIN app.dataset_versions version
    ON version.organization_id = dataset.organization_id
   AND version.dataset_id = dataset.id
   AND version.id = dataset.current_version_id
   AND version.id = NEW.dataset_version_id
  JOIN app.dataset_version_objects link
    ON link.organization_id = version.organization_id
   AND link.dataset_id = version.dataset_id
   AND link.dataset_version_id = version.id
   AND link.data_object_id = NEW.data_object_id
  JOIN app.data_objects object
    ON object.organization_id = link.organization_id
   AND object.dataset_id = link.dataset_id
   AND object.id = link.data_object_id
  WHERE service.organization_id = NEW.organization_id
    AND service.project_id = NEW.project_id
    AND service.id = NEW.service_id
    AND service.disabled_at IS NULL
    AND dataset.status = 'active'
    AND dataset.source_type = 'upload'
    AND dataset.format = 'cog'
    AND version.state = 'active'
    AND version.version_number = NEW.sealed_dataset_version_number
    AND version.original_object_id = object.id
    AND version.geometry_type = 'raster'
    AND version.crs = NEW.sealed_crs
    AND version.extent = NEW.sealed_extent
    AND jsonb_typeof(version.extent) = 'array'
    AND jsonb_array_length(version.extent) = 4
    AND version.schema_definition #>> '{raster,width}' = NEW.sealed_width::text
    AND version.schema_definition #>> '{raster,height}' = NEW.sealed_height::text
    AND version.schema_definition #>> '{raster,band_count}' = NEW.sealed_band_count::text
    AND version.schema_definition #> '{raster,bands}' = NEW.sealed_bands
    AND version.quality_results @> '{"valid":true,"checks":[{"code":"cog_layout_verified","status":"passed"}]}'::jsonb
    AND object.role = 'original'
    AND object.bucket = NEW.sealed_bucket
    AND object.object_key = NEW.sealed_object_key
    AND object.s3_version_id = NEW.sealed_storage_version_id
    AND object.content_type = NEW.sealed_content_type
    AND object.content_type IN ('image/tiff', 'image/geotiff')
    AND object.size_bytes = NEW.sealed_size_bytes
    AND object.checksum_sha256 = NEW.sealed_checksum_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial service coverage must seal current validated COG original';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_service_coverage_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.service_id <> OLD.service_id
    OR NEW.coverage_name <> OLD.coverage_name
    OR NEW.dataset_id <> OLD.dataset_id
    OR NEW.dataset_version_id <> OLD.dataset_version_id
    OR NEW.data_object_id <> OLD.data_object_id
    OR NEW.sealed_dataset_version_number <> OLD.sealed_dataset_version_number
    OR NEW.sealed_crs <> OLD.sealed_crs
    OR NEW.sealed_extent <> OLD.sealed_extent
    OR NEW.sealed_width <> OLD.sealed_width
    OR NEW.sealed_height <> OLD.sealed_height
    OR NEW.sealed_band_count <> OLD.sealed_band_count
    OR NEW.sealed_bands <> OLD.sealed_bands
    OR NEW.sealed_bucket <> OLD.sealed_bucket
    OR NEW.sealed_object_key <> OLD.sealed_object_key
    OR NEW.sealed_storage_version_id <> OLD.sealed_storage_version_id
    OR NEW.sealed_content_type <> OLD.sealed_content_type
    OR NEW.sealed_size_bytes <> OLD.sealed_size_bytes
    OR NEW.sealed_checksum_sha256 <> OLD.sealed_checksum_sha256
    OR NEW.title <> OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service coverage seal is immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
    OR NEW.withdrawn_at IS NULL
    OR NEW.withdrawn_by IS NULL
    OR NEW.withdrawn_by <> app.current_user_id()
    OR NEW.withdrawn_at < OLD.created_at
  THEN
    RAISE EXCEPTION 'spatial service coverage withdrawal is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spatial_service_coverages_validate_insert
  BEFORE INSERT ON app.spatial_service_coverages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_coverage_insert();
CREATE TRIGGER spatial_service_coverages_enforce_transition
  BEFORE UPDATE ON app.spatial_service_coverages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_service_coverage_transition();

ALTER TABLE app.spatial_service_coverages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_service_coverages FORCE ROW LEVEL SECURITY;

CREATE POLICY spatial_service_coverages_tenant_isolation
  ON app.spatial_service_coverages
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.spatial_service_coverages TO opengeo_runtime;
REVOKE DELETE ON app.spatial_service_coverages FROM opengeo_runtime;
REVOKE ALL ON app.spatial_service_coverages FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_spatial_service_coverage_insert(),
  app.enforce_spatial_service_coverage_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.spatial_service_coverages IS
  'Immutable exact-object seals for authenticated WCS 2.0.1 whole-coverage COG publication; reads never dispatch processing and stale seals fail closed.';

COMMIT;
