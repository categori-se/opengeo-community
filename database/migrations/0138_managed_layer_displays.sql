BEGIN;
-- Reviewed displays may represent an exact managed version or a provider revision.
-- Keep the existing table, grants, default-disabled admission and workspace RLS.
ALTER TABLE app.layer_archive_distributions
 ALTER COLUMN source_version DROP NOT NULL,
 ADD COLUMN dataset_version_id uuid,
 ADD CONSTRAINT layer_archive_exact_origin CHECK (
   (source_version IS NOT NULL AND dataset_version_id IS NULL) OR
   (source_version IS NULL AND dataset_version_id IS NOT NULL)),
 ADD CONSTRAINT layer_archive_managed_version FOREIGN KEY
   (organization_id,dataset_id,dataset_version_id)
   REFERENCES app.dataset_versions(organization_id,dataset_id,id);
COMMENT ON COLUMN app.layer_archive_distributions.dataset_version_id IS
 'Exact managed source version for an independently reviewed display. Mutually exclusive with external source_version. Runtime cannot create or admit displays.';
COMMIT;
