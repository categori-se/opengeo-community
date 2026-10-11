BEGIN;
ALTER TABLE app.workspace_collections DROP CONSTRAINT workspace_collections_visibility_check;
ALTER TABLE app.workspace_collections ADD CONSTRAINT workspace_collections_visibility_check
  CHECK (visibility IN ('private','account','public'));
COMMIT;
