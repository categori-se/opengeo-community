BEGIN;
CREATE TABLE app.project_artifact_upload_intents (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 49152),
  expected_revision integer NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483646),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 4194304),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 3 AND 63),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  completed_object_id uuid,
  completed_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (bucket, object_key),
  FOREIGN KEY (organization_id, artifact_id) REFERENCES app.project_artifacts(organization_id, id),
  FOREIGN KEY (organization_id, artifact_id, completed_object_id)
    REFERENCES app.project_artifact_objects(organization_id, artifact_id, id),
  CHECK ((completed_object_id IS NULL) = (completed_at IS NULL))
);
ALTER TABLE app.project_artifact_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_upload_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_upload_tenant ON app.project_artifact_upload_intents
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.project_artifact_upload_intents TO opengeo_runtime;
GRANT UPDATE (completed_object_id, completed_at) ON app.project_artifact_upload_intents TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_upload_intents FROM opengeo_worker;
CREATE FUNCTION app.check_artifact_upload_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.completed_object_id IS NOT NULL OR NEW.completed_object_id IS NULL
    OR NEW.completed_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM app.project_artifact_objects output
      WHERE output.organization_id = NEW.organization_id AND output.artifact_id = NEW.artifact_id
        AND output.id = NEW.completed_object_id AND output.bucket = NEW.bucket
        AND output.object_key = NEW.object_key AND output.size_bytes = NEW.expected_size_bytes
        AND output.checksum_sha256 = NEW.expected_sha256
  ) THEN
    RAISE EXCEPTION 'artifact upload completion does not match retained output';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_upload_completion BEFORE UPDATE ON app.project_artifact_upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.check_artifact_upload_completion();
CREATE INDEX artifact_pending_uploads ON app.project_artifact_upload_intents
  (organization_id, artifact_id, created_by, expires_at) WHERE completed_object_id IS NULL;
COMMIT;
