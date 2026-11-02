BEGIN;

-- Preserve NITF and ERDAS Imagine source identities while the existing worker
-- normalizes admitted native drivers to a separately registered working COG.
-- This adds no remote source, object authority or coverage-service admission.
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'nitf';
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'img';

COMMIT;
