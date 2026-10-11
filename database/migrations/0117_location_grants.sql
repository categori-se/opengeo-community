BEGIN;
ALTER TABLE app.workspace_locations ADD COLUMN access_revision integer NOT NULL DEFAULT 1 CHECK (access_revision>0);
CREATE TABLE app.workspace_location_grants (
 organization_id uuid NOT NULL,
 location_id uuid NOT NULL,
 user_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('reader','editor')),
 PRIMARY KEY (organization_id,location_id,user_id),
 FOREIGN KEY (organization_id,location_id) REFERENCES app.workspace_locations(organization_id,id),
 FOREIGN KEY (organization_id,user_id) REFERENCES app.organization_memberships(organization_id,user_id) ON DELETE CASCADE
);
ALTER TABLE app.workspace_location_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_location_grants_tenant ON app.workspace_location_grants
 USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT,DELETE ON app.workspace_location_grants TO opengeo_runtime;
REVOKE ALL ON app.workspace_location_grants FROM opengeo_worker;
COMMIT;
