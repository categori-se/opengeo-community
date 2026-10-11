BEGIN;
CREATE TABLE app.archive_upload_objects (
 organization_id uuid NOT NULL,
 project_id uuid NOT NULL,
 session_id uuid NOT NULL,
 ordinal integer NOT NULL,
 bucket text NOT NULL,
 object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
 object_prefix text NOT NULL,
 region text NOT NULL CHECK (region='us-east-1'),
 expected_bucket_owner text NOT NULL CHECK (expected_bucket_owner ~ '^[0-9]{12}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK (state IN
  ('prepared','creating','uploading','completing','complete','aborting','aborted')),
 upload_id text,
 receipt jsonb,
 PRIMARY KEY (organization_id,session_id,ordinal),
 UNIQUE (bucket,object_key),
 FOREIGN KEY (organization_id,project_id,session_id)
  REFERENCES app.archive_upload_sessions(organization_id,project_id,id),
 FOREIGN KEY (organization_id,session_id,ordinal)
  REFERENCES app.archive_upload_files(organization_id,session_id,ordinal)
);
CREATE TABLE app.archive_upload_parts (
 organization_id uuid NOT NULL,
 session_id uuid NOT NULL,
 ordinal integer NOT NULL,
 part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
 size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 5368709120),
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY (organization_id,session_id,ordinal,part_number),
 FOREIGN KEY (organization_id,session_id,ordinal)
  REFERENCES app.archive_upload_objects(organization_id,session_id,ordinal)
);
ALTER TABLE app.archive_upload_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_upload_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_objects_owner ON app.archive_upload_objects TO opengeo_runtime
 USING (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_objects.organization_id
   AND s.id=archive_upload_objects.session_id AND s.created_by=app.current_user_id()))
 WITH CHECK (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_objects.organization_id
   AND s.id=archive_upload_objects.session_id AND s.created_by=app.current_user_id()));
CREATE POLICY archive_parts_owner ON app.archive_upload_parts TO opengeo_runtime
 USING (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_parts.organization_id
   AND s.id=archive_upload_parts.session_id AND s.created_by=app.current_user_id()))
 WITH CHECK (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s WHERE s.organization_id=archive_upload_parts.organization_id
   AND s.id=archive_upload_parts.session_id AND s.created_by=app.current_user_id()));
GRANT SELECT,INSERT ON app.archive_upload_objects,app.archive_upload_parts TO opengeo_runtime;
GRANT UPDATE(state,upload_id,receipt) ON app.archive_upload_objects TO opengeo_runtime;
CREATE TRIGGER archive_part_plan_immutable BEFORE UPDATE OR DELETE ON app.archive_upload_parts
 FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
COMMIT;
