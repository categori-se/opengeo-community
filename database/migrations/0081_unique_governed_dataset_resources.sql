BEGIN;

-- A managed dataset has one canonical dataset resource per project. Service
-- resources may still bind the same dataset independently, but competing
-- catalog identities would split metadata, style, discussion, and publication
-- history for one logical asset.
CREATE UNIQUE INDEX governed_resources_dataset_binding_idx
  ON app.governed_resources (organization_id, project_id, dataset_id)
  WHERE kind = 'dataset' AND dataset_id IS NOT NULL;

COMMENT ON INDEX app.governed_resources_dataset_binding_idx IS
  'Prevents concurrent creation of competing governed catalog identities for one project dataset.';

COMMIT;
