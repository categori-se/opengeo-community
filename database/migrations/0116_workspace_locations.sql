BEGIN;
-- Independent geographic identities, not map bookmarks or access workspaces.
CREATE TABLE app.workspace_locations (
 organization_id uuid NOT NULL REFERENCES app.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES app.users(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,id)
);
CREATE TABLE app.workspace_location_revisions (
 organization_id uuid NOT NULL,
 location_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision > 0),
 document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND octet_length(document::text)<=400000),
 created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,location_id,revision),
 FOREIGN KEY (organization_id,location_id) REFERENCES app.workspace_locations(organization_id,id)
);
ALTER TABLE app.workspace_locations ADD CONSTRAINT location_current_revision
 FOREIGN KEY (organization_id,id,revision)
 REFERENCES app.workspace_location_revisions(organization_id,location_id,revision)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER workspace_location_history_is_immutable BEFORE UPDATE OR DELETE
 ON app.workspace_location_revisions FOR EACH ROW
 EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.workspace_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_locations_tenant ON app.workspace_locations
 USING (organization_id=app.current_organization_id())
 WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY workspace_location_revisions_tenant ON app.workspace_location_revisions
 USING (organization_id=app.current_organization_id())
 WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT,UPDATE ON app.workspace_locations TO opengeo_runtime;
GRANT SELECT,INSERT ON app.workspace_location_revisions TO opengeo_runtime;
REVOKE UPDATE,DELETE ON app.workspace_location_revisions FROM opengeo_runtime;
REVOKE ALL ON app.workspace_locations,app.workspace_location_revisions FROM opengeo_worker;
COMMIT;
