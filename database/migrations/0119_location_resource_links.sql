BEGIN;
ALTER TABLE app.workspace_locations ADD COLUMN links_revision integer NOT NULL DEFAULT 0 CHECK (links_revision>=0);
CREATE TABLE app.workspace_location_link_revisions (
 organization_id uuid NOT NULL,
 location_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision>0),
 created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,location_id,revision),
 FOREIGN KEY (organization_id,location_id) REFERENCES app.workspace_locations(organization_id,id)
);
CREATE TABLE app.workspace_location_link_entries (
 organization_id uuid NOT NULL,
 location_id uuid NOT NULL,
 revision integer NOT NULL,
 entry_id uuid NOT NULL,
 position integer NOT NULL CHECK (position>=0 AND position<200),
 dataset_id uuid, map_id uuid, site_id uuid, collection_id uuid,
 relationship text NOT NULL CHECK (length(relationship) BETWEEN 1 AND 2048),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=16),
 confidence double precision CHECK (confidence>=0 AND confidence<=1),
 PRIMARY KEY (organization_id,location_id,revision,entry_id),
 UNIQUE (organization_id,location_id,revision,position),
 FOREIGN KEY (organization_id,location_id,revision) REFERENCES app.workspace_location_link_revisions(organization_id,location_id,revision),
 FOREIGN KEY (organization_id,dataset_id) REFERENCES app.datasets(organization_id,id),
 FOREIGN KEY (organization_id,map_id) REFERENCES app.maps(organization_id,id),
 FOREIGN KEY (organization_id,site_id) REFERENCES app.project_sites(organization_id,id),
 FOREIGN KEY (organization_id,collection_id) REFERENCES app.workspace_collections(organization_id,id),
 CHECK (num_nonnulls(dataset_id,map_id,site_id,collection_id)=1)
);
ALTER TABLE app.workspace_location_link_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_link_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_link_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_location_link_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY location_link_revisions_tenant ON app.workspace_location_link_revisions USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY location_link_entries_tenant ON app.workspace_location_link_entries USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE TRIGGER location_link_revisions_immutable BEFORE UPDATE OR DELETE ON app.workspace_location_link_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER location_link_entries_immutable BEFORE UPDATE OR DELETE ON app.workspace_location_link_entries FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
GRANT SELECT,INSERT ON app.workspace_location_link_revisions,app.workspace_location_link_entries TO opengeo_runtime;
REVOKE UPDATE,DELETE ON app.workspace_location_link_revisions,app.workspace_location_link_entries FROM opengeo_runtime;
REVOKE ALL ON app.workspace_location_link_revisions,app.workspace_location_link_entries FROM opengeo_worker;
COMMIT;
