BEGIN;

-- Ordinary GeoTIFF is an upload format, separate from a validated COG original.
-- Existing source/format constraints already admit uploaded and repository files.
-- Working COG metadata and objects use the existing version/artifact contract;
-- coverage services remain restricted to validated original COG datasets (0036).
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'geotiff';

COMMIT;
