BEGIN;
ALTER TABLE app.workspace_collections ADD COLUMN visibility text NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private','account'));
COMMIT;
