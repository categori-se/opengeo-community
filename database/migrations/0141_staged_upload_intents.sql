BEGIN;
ALTER TABLE app.upload_intents ADD COLUMN staged_base_version_id uuid,
  ADD CONSTRAINT upload_staged_base_same_layer FOREIGN KEY
    (organization_id, dataset_id, staged_base_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id);
CREATE FUNCTION app.preserve_upload_staging_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.staged_base_version_id IS DISTINCT FROM OLD.staged_base_version_id THEN
    RAISE EXCEPTION 'upload staging binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER upload_staging_binding_immutable BEFORE UPDATE ON app.upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.preserve_upload_staging_binding();
COMMENT ON COLUMN app.upload_intents.staged_base_version_id IS
 'Expected active Layer version for a staged replacement. Completion retains the current pointer and records this parent on the candidate; no promotion is authorized.';
COMMIT;
