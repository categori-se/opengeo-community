BEGIN;
-- A creation receipt is committed with its map. Retry never invents another map.
CREATE TABLE app.map_creation_requests (
 organization_id uuid NOT NULL REFERENCES app.organizations(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 creation_key uuid NOT NULL,
 project_id uuid NOT NULL,
 map_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id, created_by, creation_key),
 FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY (organization_id, map_id) REFERENCES app.maps(organization_id,id)
);
ALTER TABLE app.map_creation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_creation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY map_creation_tenant ON app.map_creation_requests
 USING (organization_id=app.current_organization_id())
 WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.map_creation_requests TO opengeo_runtime;
REVOKE ALL ON app.map_creation_requests FROM opengeo_worker;
COMMIT;
