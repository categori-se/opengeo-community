BEGIN;

-- A dataset's knowledge follows its reusable identity across project links.
-- Metadata revisions do not change dataset content versions or build inputs.
CREATE TABLE app.dataset_knowledge_revisions (
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 49152
    AND document->>'schemaVersion' = '1.0.0'
  ),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, dataset_id) REFERENCES app.datasets(organization_id, id)
);

CREATE TRIGGER dataset_knowledge_history_is_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.dataset_knowledge_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_knowledge_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_knowledge_tenant_isolation ON app.dataset_knowledge_revisions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.dataset_knowledge_revisions TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.dataset_knowledge_revisions FROM opengeo_runtime;
REVOKE ALL ON app.dataset_knowledge_revisions FROM opengeo_worker;
COMMENT ON TABLE app.dataset_knowledge_revisions IS
  'Immutable resource knowledge, with exact source text and separately attributed normalized, curated and inferred assertions. Distribution rights are never inherited implicitly.';

COMMIT;
