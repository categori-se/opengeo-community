BEGIN;

-- Keep the uploaded MapInfo companion archive as the original source while the
-- existing worker validates one TAB or MIF/MID set and normalizes its vector data.
-- This adds no remote source, object authority or protected-copy permission.
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'mapinfo';

COMMIT;
