BEGIN;

GRANT DELETE ON app.project_datasets TO opengeo_runtime;

REVOKE ALL ON app.project_datasets FROM
  opengeo_worker,
  opengeo_connector,
  opengeo_observable_coordinator,
  opengeo_dataset_verifier;

COMMENT ON TABLE app.project_datasets IS
  'Explicit reusable dataset references. API transactions authorize attach and detach, preserve referenced maps and publications, and record project activity.';

COMMIT;
