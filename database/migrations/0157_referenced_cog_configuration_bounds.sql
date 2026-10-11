BEGIN;

-- The COG API preserves up to 256 KiB of original Item/assets/terms metadata.
-- JSONB text includes whitespace and configuration fields beyond that metadata.
-- Keep a finite storage ceiling without truncating provenance or changing the
-- established 16 KiB limit for other source representations.
ALTER TABLE app.external_source_revisions
  DROP CONSTRAINT external_source_revision_configuration_object;
ALTER TABLE app.external_source_revisions
  ADD CONSTRAINT external_source_revision_configuration_object CHECK (
    jsonb_typeof(configuration) = 'object'
    AND octet_length(configuration::text) <= CASE
      WHEN configuration->>'service_kind' = 'cog' THEN 1048576
      ELSE 16384
    END
  );

COMMIT;
