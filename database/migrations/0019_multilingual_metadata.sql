BEGIN;

DROP INDEX app.governed_resource_versions_search_idx;

ALTER TABLE app.governed_resource_versions
  DROP COLUMN search_document,
  ADD COLUMN localized_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT governed_resource_versions_localized_metadata_bounded CHECK (
    jsonb_typeof(localized_metadata) = 'object'
    AND octet_length(localized_metadata::text) <= 16384
  ),
  ADD COLUMN search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(abstract, ''))
    || jsonb_to_tsvector('simple', localized_metadata, '["string"]'::jsonb)
  ) STORED;

CREATE INDEX governed_resource_versions_search_idx
  ON app.governed_resource_versions USING gin (search_document);

COMMENT ON COLUMN app.governed_resource_versions.localized_metadata IS
  'Bounded alternate-language title, abstract, attribution, and keyword values frozen with one exact governed resource revision.';

COMMIT;
