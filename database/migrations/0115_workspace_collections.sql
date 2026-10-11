BEGIN;
-- Product Collections are independent of access workspaces and OGC collections.
CREATE TABLE app.workspace_collections (
 organization_id uuid NOT NULL REFERENCES app.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
 owner_user_id uuid NOT NULL REFERENCES app.users(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,id)
);
CREATE TABLE app.workspace_collection_entries (
 organization_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 position integer NOT NULL CHECK (position BETWEEN 0 AND 199),
 map_id uuid,
 site_id uuid,
 PRIMARY KEY (organization_id,collection_id,id),
 UNIQUE (organization_id,collection_id,position),
 FOREIGN KEY (organization_id,collection_id) REFERENCES app.workspace_collections(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY (organization_id,map_id) REFERENCES app.maps(organization_id,id),
 FOREIGN KEY (organization_id,site_id) REFERENCES app.project_sites(organization_id,id),
 CHECK ((map_id IS NULL) <> (site_id IS NULL))
);
CREATE UNIQUE INDEX workspace_collection_map_unique ON app.workspace_collection_entries(organization_id,collection_id,map_id) WHERE map_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_collection_site_unique ON app.workspace_collection_entries(organization_id,collection_id,site_id) WHERE site_id IS NOT NULL;
CREATE TABLE app.workspace_collection_grants (
 organization_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 user_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('reader','editor')),
 PRIMARY KEY (organization_id,collection_id,user_id),
 FOREIGN KEY (organization_id,collection_id) REFERENCES app.workspace_collections(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY (organization_id,user_id) REFERENCES app.organization_memberships(organization_id,user_id) ON DELETE CASCADE
);
ALTER TABLE app.workspace_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_collection_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_collection_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_collection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_collection_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_collections_tenant ON app.workspace_collections USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY workspace_collection_entries_tenant ON app.workspace_collection_entries USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY workspace_collection_grants_tenant ON app.workspace_collection_grants USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT,UPDATE ON app.workspace_collections TO opengeo_runtime;
GRANT SELECT,INSERT,DELETE ON app.workspace_collection_entries,app.workspace_collection_grants TO opengeo_runtime;
REVOKE ALL ON app.workspace_collections,app.workspace_collection_entries,app.workspace_collection_grants FROM opengeo_worker;
COMMIT;
