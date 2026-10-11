BEGIN;

CREATE TYPE app.metadata_source_format AS ENUM ('dcat_3', 'stac_1_1');

CREATE TABLE app.governed_metadata_source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  source_format app.metadata_source_format NOT NULL,
  source_version text NOT NULL,
  source_namespace text NOT NULL,
  source_identifier text NOT NULL,
  document text NOT NULL,
  checksum_sha256 text NOT NULL,
  conversion_report jsonb NOT NULL,
  imported_by uuid NOT NULL REFERENCES app.users(id),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id,
    source_format,
    source_namespace,
    source_identifier
  ),
  UNIQUE (organization_id, resource_id, resource_version_id),
  CONSTRAINT governed_metadata_sources_version_bounded CHECK (
    char_length(source_version) BETWEEN 1 AND 100
  ),
  CONSTRAINT governed_metadata_sources_namespace_bounded CHECK (
    source_namespace ~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$'
  ),
  CONSTRAINT governed_metadata_sources_identifier_bounded CHECK (
    char_length(source_identifier) BETWEEN 1 AND 500
  ),
  CONSTRAINT governed_metadata_sources_document_bounded CHECK (
    jsonb_typeof(document::jsonb) = 'object'
    AND octet_length(document) BETWEEN 2 AND 49152
  ),
  CONSTRAINT governed_metadata_sources_checksum_valid CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT governed_metadata_sources_report_bounded CHECK (
    jsonb_typeof(conversion_report) = 'object'
    AND octet_length(conversion_report::text) BETWEEN 2 AND 16384
  ),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id)
);

CREATE INDEX governed_metadata_sources_resource_idx
  ON app.governed_metadata_source_documents (
    organization_id,
    resource_id,
    resource_version_id
  );

CREATE TRIGGER governed_metadata_source_documents_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_metadata_source_documents
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.governed_metadata_source_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_metadata_source_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY governed_metadata_source_documents_tenant_isolation
  ON app.governed_metadata_source_documents
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.governed_metadata_source_documents TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.governed_metadata_source_documents FROM opengeo_runtime;
REVOKE ALL ON app.governed_metadata_source_documents FROM opengeo_worker;

COMMENT ON TABLE app.governed_metadata_source_documents IS
  'Immutable bounded canonical DCAT 3 or STAC 1.1 source JSON text, exact resource-revision binding, checksum, and explicit conversion report.';
COMMENT ON COLUMN app.governed_metadata_source_documents.document IS
  'Exact UTF-8 canonical JSON text, stored separately from its report so each Data API result row remains below 64 KiB.';
COMMENT ON COLUMN app.governed_metadata_source_documents.checksum_sha256 IS
  'SHA-256 of UTF-8 canonical JSON with Unicode code-point key order, finite plain-decimal numbers, and no insignificant whitespace.';

COMMIT;
