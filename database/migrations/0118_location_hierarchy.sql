BEGIN;
ALTER TABLE app.workspace_locations ADD COLUMN hierarchy_revision integer NOT NULL DEFAULT 0 CHECK (hierarchy_revision>=0);
ALTER TABLE app.workspace_locations ADD COLUMN parent_id uuid;
ALTER TABLE app.workspace_locations ADD CONSTRAINT location_parent_account FOREIGN KEY (organization_id,parent_id) REFERENCES app.workspace_locations(organization_id,id);
ALTER TABLE app.workspace_locations ADD CONSTRAINT location_parent_not_self CHECK (parent_id IS DISTINCT FROM id);
CREATE TABLE app.workspace_location_parent_revisions (
 organization_id uuid NOT NULL,
 location_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision>0),
 parent_id uuid,
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=16),
 confidence double precision CHECK (confidence>=0 AND confidence<=1),
 created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,location_id,revision),
 FOREIGN KEY (organization_id,location_id) REFERENCES app.workspace_locations(organization_id,id),
 FOREIGN KEY (organization_id,parent_id) REFERENCES app.workspace_locations(organization_id,id)
);
CREATE TRIGGER location_parent_history_immutable BEFORE UPDATE OR DELETE
 ON app.workspace_location_parent_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.workspace_location_parent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_parent_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY location_parent_history_tenant ON app.workspace_location_parent_revisions
 USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.workspace_location_parent_revisions TO opengeo_runtime;
REVOKE UPDATE,DELETE ON app.workspace_location_parent_revisions FROM opengeo_runtime;
REVOKE ALL ON app.workspace_location_parent_revisions FROM opengeo_worker;
COMMIT;
