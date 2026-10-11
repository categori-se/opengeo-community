BEGIN;

-- Archive the reusable head, never its immutable definitions or saved-map pins.
-- Existing tenant policies, edit authority and history protection remain unchanged.
ALTER TABLE app.governed_resource_styles
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT governed_resource_styles_archive_actor_check
    CHECK ((archived_at IS NULL) = (archived_by IS NULL));

COMMENT ON COLUMN app.governed_resource_styles.archived_at IS
  'Hidden from new Style selections; exact immutable revisions remain readable under existing access.';

COMMIT;
