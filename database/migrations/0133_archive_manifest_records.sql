BEGIN;
-- Bounded reconstruction pages stay inside their original destination boundary.
CREATE TABLE app.archive_manifest_records (
 organization_id uuid NOT NULL,
 project_id uuid NOT NULL,
 session_id uuid NOT NULL,
 destination_id uuid NOT NULL,
 first_ordinal integer NOT NULL CHECK (first_ordinal BETWEEN 0 AND 99999),
 bucket text NOT NULL,
 object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
 object_prefix text NOT NULL,
 expected_bucket_owner text NOT NULL CHECK (expected_bucket_owner ~ '^[0-9]{12}$'),
 body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 262144),
 receipt jsonb,
 PRIMARY KEY (organization_id,session_id,destination_id,first_ordinal),
 UNIQUE (bucket,object_key),
 FOREIGN KEY (organization_id,project_id,session_id)
  REFERENCES app.archive_upload_sessions(organization_id,project_id,id),
 FOREIGN KEY (organization_id,destination_id)
  REFERENCES app.archive_upload_destinations(organization_id,id)
);
ALTER TABLE app.archive_manifest_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.archive_manifest_records FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_manifest_owner ON app.archive_manifest_records TO opengeo_runtime
 USING (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s
  WHERE s.organization_id=archive_manifest_records.organization_id
   AND s.id=archive_manifest_records.session_id AND s.created_by=app.current_user_id()))
 WITH CHECK (organization_id=app.current_organization_id() AND EXISTS (
  SELECT 1 FROM app.archive_upload_sessions s
  WHERE s.organization_id=archive_manifest_records.organization_id
   AND s.id=archive_manifest_records.session_id AND s.created_by=app.current_user_id()));
GRANT SELECT,INSERT ON app.archive_manifest_records TO opengeo_runtime;
GRANT UPDATE(receipt) ON app.archive_manifest_records TO opengeo_runtime;
COMMIT;
