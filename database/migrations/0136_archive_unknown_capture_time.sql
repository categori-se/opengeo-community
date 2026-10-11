BEGIN;
-- Historical preservation often establishes storage time, not capture time.
-- Keep unknown dates unknown rather than substituting upload or review time.
ALTER TABLE app.layer_archive_distributions ALTER COLUMN captured_at DROP NOT NULL;
COMMENT ON COLUMN app.layer_archive_distributions.captured_at IS
 'Known source capture time, otherwise NULL. Preservation, upload and review times are distinct facts recorded in provenance; they are not substitutes.';
COMMIT;
