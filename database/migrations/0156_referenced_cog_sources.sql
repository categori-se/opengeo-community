BEGIN;
ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'cog';
COMMIT;

BEGIN;
-- Referenced rasters retain the existing governed source/revision and tenant
-- boundaries. Managed COG uploads/repository objects are unchanged. No copy,
-- processing job, new permission or imagery body is created by registration.
ALTER TABLE app.datasets DROP CONSTRAINT datasets_source_format_match;
ALTER TABLE app.datasets ADD CONSTRAINT datasets_source_format_match CHECK (
  (source_type IN ('upload', 'repository')
    AND format NOT IN ('xyz', 'wms', 'arcgis', 'wfs', 'imageserver', 'mapserver'))
  OR (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs', 'imageserver', 'mapserver', 'cog')
    AND source_type::text = format::text)
);
ALTER TABLE app.external_sources DROP CONSTRAINT external_sources_supported_type;
ALTER TABLE app.external_sources ADD CONSTRAINT external_sources_supported_type
  CHECK (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs', 'imageserver', 'mapserver', 'cog'));
COMMIT;
