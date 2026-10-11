BEGIN;
CREATE TABLE app.authored_resource_knowledge_revisions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  map_id uuid,
  site_id uuid,
  collection_id uuid,
  kind text GENERATED ALWAYS AS (CASE WHEN map_id IS NOT NULL THEN 'project'
    WHEN site_id IS NOT NULL THEN 'publication' ELSE 'collection' END) STORED,
  resource_id uuid GENERATED ALWAYS AS (coalesce(map_id,site_id,collection_id)) STORED,
  version_number integer NOT NULL CHECK (version_number > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'
    AND octet_length(document::text)<=49152 AND document->>'schemaVersion'='1.0.0'),
  place_uris text[] GENERATED ALWAYS AS (app.catalog_place_uris(document)) STORED,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(map_id,site_id,collection_id)=1),
  PRIMARY KEY (organization_id,kind,resource_id,version_number),
  FOREIGN KEY (organization_id,map_id) REFERENCES app.maps(organization_id,id),
  FOREIGN KEY (organization_id,site_id) REFERENCES app.project_sites(organization_id,id),
  FOREIGN KEY (organization_id,collection_id) REFERENCES app.workspace_collections(organization_id,id)
);
CREATE TRIGGER authored_knowledge_is_immutable BEFORE UPDATE OR DELETE
  ON app.authored_resource_knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.authored_resource_knowledge_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.authored_resource_knowledge_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY authored_knowledge_tenant ON app.authored_resource_knowledge_revisions
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.authored_resource_knowledge_revisions TO opengeo_runtime;
REVOKE UPDATE,DELETE ON app.authored_resource_knowledge_revisions FROM opengeo_runtime;
REVOKE ALL ON app.authored_resource_knowledge_revisions FROM opengeo_worker;
COMMENT ON TABLE app.authored_resource_knowledge_revisions IS
  'Descriptive knowledge for canonical maps, sites and Collections. Independent revisions; no build invalidation or permission inheritance.';
COMMIT;
