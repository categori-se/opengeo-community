BEGIN;

ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'pmtiles';

COMMIT;

BEGIN;

ALTER TABLE app.datasets DROP CONSTRAINT datasets_source_format_match;
ALTER TABLE app.datasets ADD CONSTRAINT datasets_source_format_match CHECK (
  (source_type = 'upload' AND format NOT IN ('xyz', 'wms'))
  OR (source_type IN ('xyz', 'wms', 'pmtiles') AND source_type::text = format::text)
);

ALTER TABLE app.external_sources DROP CONSTRAINT external_sources_supported_type;
ALTER TABLE app.external_sources ADD CONSTRAINT external_sources_supported_type
  CHECK (source_type IN ('xyz', 'wms', 'pmtiles'));

CREATE OR REPLACE FUNCTION app.enforce_external_source_dataset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dataset_source_type app.dataset_source_type;
  dataset_format app.dataset_format;
BEGIN
  SELECT source_type, format
  INTO dataset_source_type, dataset_format
  FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.dataset_id;

  IF dataset_source_type IS NULL
    OR dataset_source_type <> NEW.source_type
    OR dataset_format::text <> NEW.source_type::text
  THEN
    RAISE EXCEPTION 'external source identity must match an XYZ, WMS, or PMTiles dataset';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.enforce_external_source_dataset()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TYPE app.dataset_source_type IS
  'Dataset acquisition mode; pmtiles denotes an anonymous browser-direct archive reference, while upload+pmtiles denotes a managed object.';

COMMIT;
