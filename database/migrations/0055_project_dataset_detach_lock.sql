BEGIN;

GRANT UPDATE (linked_at) ON app.project_datasets TO opengeo_runtime;

REVOKE UPDATE (linked_at) ON app.project_datasets FROM
  opengeo_worker,
  opengeo_connector,
  opengeo_observable_coordinator,
  opengeo_dataset_verifier;

COMMENT ON COLUMN app.project_datasets.linked_at IS
  'Reference creation time. The API runtime has column-scoped UPDATE authority solely to satisfy PostgreSQL row-lock authorization during guarded detach.';

COMMIT;
