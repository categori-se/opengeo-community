-- Original KML source preservation. Geometry and rendering are separate acceptance.
-- Keep this enum addition in its own forward migration transaction.
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'kml';
