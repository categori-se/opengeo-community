BEGIN;

ALTER TABLE app.page_source_objects
  ALTER COLUMN compiler_version SET DEFAULT 'opengeo-page-renderer-1.1.0';

ALTER TABLE app.page_source_objects
  DROP CONSTRAINT page_source_objects_compiler_identity;

ALTER TABLE app.page_source_objects
  ADD CONSTRAINT page_source_objects_compiler_identity CHECK (
    dialect = 'opengeo-markdown'
    AND dialect_version = '1.0.0'
    AND compiler_version IN (
      'opengeo-page-renderer-1.0.0',
      'opengeo-page-renderer-1.1.0'
    )
  );

CREATE OR REPLACE FUNCTION app.enforce_page_renderer_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_page jsonb;
  v_source app.page_source_objects%ROWTYPE;
  v_expected jsonb;
BEGIN
  IF NEW.manifest->>'rendererVersion'
    IS DISTINCT FROM 'opengeo-page-renderer-1.1.0'
  THEN
    RAISE EXCEPTION 'site edition renderer identity is missing or unsupported';
  END IF;

  FOR v_page IN
    SELECT value FROM jsonb_array_elements(COALESCE(NEW.manifest->'pages', '[]'::jsonb))
  LOOP
    SELECT * INTO v_source
    FROM app.page_source_objects source
    WHERE source.organization_id = NEW.organization_id
      AND source.resource_id = (v_page->>'resourceId')::uuid
      AND source.resource_version_id = (v_page->>'resourceVersionId')::uuid;
    IF FOUND THEN
      v_expected := jsonb_build_object(
        'sourceId', v_source.id,
        'sourceBlockId', v_source.source_block_id,
        's3VersionId', v_source.s3_version_id,
        'etag', v_source.etag,
        'contentType', v_source.content_type,
        'sizeBytes', v_source.size_bytes,
        'checksumSha256', v_source.checksum_sha256,
        'dialect', v_source.dialect,
        'dialectVersion', v_source.dialect_version,
        'compilerVersion', v_source.compiler_version
      );
      IF v_page->'pageSource' IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'site edition page source seal is missing or mismatched';
      END IF;
    ELSIF COALESCE(v_page->'pageSource', 'null'::jsonb) <> 'null'::jsonb THEN
      RAISE EXCEPTION 'site edition page source seal has no governed source';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.enforce_page_renderer_identity()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON CONSTRAINT page_source_objects_compiler_identity
  ON app.page_source_objects IS
  'Retains exact historical renderer 1.0 seals while new structural page blocks use renderer 1.1.';

COMMIT;
