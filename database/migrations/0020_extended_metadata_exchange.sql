BEGIN;

CREATE TYPE app.metadata_source_format_v2 AS ENUM (
  'dcat_3',
  'stac_1_1',
  'iso_19115_3',
  'schema_org_dataset',
  'datacite_4_7',
  'geodcat_ap_3_1'
);

ALTER TABLE app.governed_metadata_source_documents
  ALTER COLUMN source_format TYPE app.metadata_source_format_v2
  USING source_format::text::app.metadata_source_format_v2;

DROP TYPE app.metadata_source_format;
ALTER TYPE app.metadata_source_format_v2 RENAME TO metadata_source_format;

ALTER TABLE app.governed_metadata_source_documents
  DROP CONSTRAINT governed_metadata_sources_document_bounded,
  ADD CONSTRAINT governed_metadata_sources_document_bounded CHECK (
    octet_length(document) BETWEEN 2 AND 49152
    AND CASE
      WHEN source_format = 'iso_19115_3'::app.metadata_source_format
        THEN btrim(document) ~ '^<'
      ELSE jsonb_typeof(document::jsonb) = 'object'
    END
  );

COMMENT ON TABLE app.governed_metadata_source_documents IS
  'Immutable bounded canonical JSON or exact UTF-8 ISO XML metadata source, exact resource-revision binding, checksum, and explicit conversion report.';
COMMENT ON COLUMN app.governed_metadata_source_documents.document IS
  'Canonical JSON for JSON formats or exact caller-supplied UTF-8 XML for ISO 19115-3; stored separately so each Data API result row remains below 64 KiB.';
COMMENT ON COLUMN app.governed_metadata_source_documents.checksum_sha256 IS
  'SHA-256 of canonical JSON UTF-8 bytes for JSON formats or exact UTF-8 source bytes for ISO 19115-3 XML.';

COMMIT;
