BEGIN;
CREATE TABLE app.project_artifact_cleanup_attempts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started','observed','failed')),
  deleted_versions integer NOT NULL DEFAULT 0 CHECK (deleted_versions BETWEEN 0 AND 16),
  more_versions boolean,
  observed_empty boolean,
  error_code text CHECK (error_code IN ('storage_inventory_unavailable','storage_delete_unconfirmed')),
  finished_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,upload_id)
    REFERENCES app.project_artifact_upload_intents(organization_id,id),
  CHECK ((state = 'started' AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'observed' AND finished_at IS NOT NULL AND error_code IS NULL
        AND more_versions IS NOT NULL AND observed_empty IS NOT NULL)
    OR (state = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL))
);
ALTER TABLE app.project_artifact_cleanup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_cleanup_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_cleanup_tenant ON app.project_artifact_cleanup_attempts
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.project_artifact_cleanup_attempts TO opengeo_runtime;
GRANT UPDATE (state,deleted_versions,more_versions,observed_empty,error_code,finished_at)
  ON app.project_artifact_cleanup_attempts TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_cleanup_attempts FROM opengeo_worker;
CREATE FUNCTION app.check_artifact_cleanup_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  IF OLD.state <> 'started' OR NEW.state = 'started' THEN
    RAISE EXCEPTION 'cleanup receipt cannot be changed after observation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_cleanup_receipt_completion
  BEFORE UPDATE ON app.project_artifact_cleanup_attempts
  FOR EACH ROW EXECUTE FUNCTION app.check_artifact_cleanup_receipt();
CREATE INDEX artifact_cleanup_history ON app.project_artifact_cleanup_attempts
  (organization_id,upload_id,created_at DESC);
COMMIT;
