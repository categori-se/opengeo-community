BEGIN;
-- Storage destinations are provisioned by administrators after private access and
-- writer permissions are verified. Browser requests cannot choose bucket/prefix.
CREATE TABLE app.archive_upload_destinations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  bucket text NOT NULL,
  region text NOT NULL,
  object_prefix text NOT NULL CHECK (object_prefix <> '' AND right(object_prefix,1) = '/'),
  expected_bucket_owner text NOT NULL CHECK (expected_bucket_owner ~ '^[0-9]{12}$'),
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.archive_upload_sessions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  creation_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'planning' CHECK (state IN ('planning','uploading','paused','complete','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,created_by,creation_key),
  UNIQUE (organization_id,project_id,id),
  FOREIGN KEY (organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.archive_upload_files (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99999),
  destination_id uuid NOT NULL,
  relative_path text NOT NULL CHECK (octet_length(relative_path) BETWEEN 1 AND 1024),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 5497558138880),
  modified_milliseconds bigint NOT NULL CHECK (modified_milliseconds BETWEEN 0 AND 9007199254740991),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id,session_id,ordinal),
  UNIQUE (organization_id,session_id,relative_path),
  FOREIGN KEY (organization_id,project_id,session_id) REFERENCES app.archive_upload_sessions(organization_id,project_id,id),
  FOREIGN KEY (organization_id,project_id,destination_id) REFERENCES app.archive_upload_destinations(organization_id,project_id,id)
);
ALTER TABLE app.archive_upload_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_files FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_destinations_tenant ON app.archive_upload_destinations
 FOR SELECT TO opengeo_runtime USING (organization_id = app.current_organization_id());
CREATE POLICY archive_sessions_owner ON app.archive_upload_sessions
 TO opengeo_runtime USING (organization_id = app.current_organization_id() AND created_by = app.current_user_id())
 WITH CHECK (organization_id = app.current_organization_id() AND created_by = app.current_user_id());
CREATE POLICY archive_files_owner ON app.archive_upload_files
 TO opengeo_runtime USING (organization_id = app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_files.organization_id
   AND s.id=archive_upload_files.session_id AND s.created_by=app.current_user_id()))
 WITH CHECK (organization_id = app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_files.organization_id
   AND s.id=archive_upload_files.session_id AND s.created_by=app.current_user_id()));
GRANT SELECT ON app.archive_upload_destinations TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.archive_upload_sessions TO opengeo_runtime;
GRANT SELECT, INSERT ON app.archive_upload_files TO opengeo_runtime;
CREATE TRIGGER archive_file_plan_immutable BEFORE UPDATE OR DELETE ON app.archive_upload_files
 FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
COMMENT ON TABLE app.archive_upload_sessions IS 'Private creator-scoped local folder upload intents; workspace edit authorization also checked on every API operation. No provider capture or automatic ingestion.';
COMMIT;
