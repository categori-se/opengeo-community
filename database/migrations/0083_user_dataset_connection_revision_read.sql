BEGIN;

-- Connection lists, bindings, and write responses include the exact target
-- revision introduced in 0052. Keep the runtime projection column-scoped;
-- secret references and revision writes retain their existing boundaries.
GRANT SELECT (target_revision)
  ON app.user_dataset_connections TO opengeo_runtime;

COMMIT;
