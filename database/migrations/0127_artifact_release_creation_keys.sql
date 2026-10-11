BEGIN;
-- Existing clients remain compatible; new clients can recover an exact release.
ALTER TABLE app.project_artifact_releases ADD COLUMN creation_key uuid;
CREATE UNIQUE INDEX artifact_release_creation_identity
 ON app.project_artifact_releases(organization_id,created_by,creation_key)
 WHERE creation_key IS NOT NULL;
-- The existing immutable-history trigger protects this new column as well.
COMMIT;
