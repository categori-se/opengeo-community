BEGIN;
-- Operator-reviewed renderable copies. Original upload sessions remain separate.
CREATE TABLE app.layer_archive_distributions (
 organization_id uuid NOT NULL,
 project_id uuid NOT NULL,
 dataset_id uuid NOT NULL,
 source_version bigint NOT NULL,
 id uuid NOT NULL,
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 captured_at timestamptz NOT NULL,
 descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor)='object' AND octet_length(descriptor::text)<=262144),
 enabled boolean NOT NULL DEFAULT false,
 reviewed_by uuid NOT NULL REFERENCES app.users(id),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,id),
 FOREIGN KEY (organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY (organization_id,dataset_id,source_version)
  REFERENCES app.external_source_revisions(organization_id,dataset_id,version_number)
);
ALTER TABLE app.layer_archive_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.layer_archive_distributions FORCE ROW LEVEL SECURITY;
CREATE POLICY layer_archive_workspace_read ON app.layer_archive_distributions
 TO opengeo_runtime USING (organization_id=app.current_organization_id()
  AND enabled AND app.effective_project_role(project_id) IS NOT NULL);
GRANT SELECT ON app.layer_archive_distributions TO opengeo_runtime;
REVOKE ALL ON app.layer_archive_distributions FROM opengeo_worker;
COMMENT ON TABLE app.layer_archive_distributions IS
 'Reviewed exact-version map copies with separate workspace access. Runtime cannot register or enable copies. Layer read authorization is additionally required by the API. Listing never reads S3.';
COMMIT;
