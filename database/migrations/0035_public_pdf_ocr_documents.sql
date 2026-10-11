BEGIN;

CREATE FUNCTION app.pdf_document_publication_facts_valid_v1(
  schema_definition jsonb,
  object_key text,
  object_size bigint
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  document jsonb := schema_definition->'document';
  is_ocr boolean := false;
  page_count integer;
  ocr_page_count integer;
  ocr_pages integer[] := ARRAY[]::integer[];
  raw_page text;
BEGIN
  IF jsonb_typeof(document) IS DISTINCT FROM 'object'
    OR document->>'kind' IS DISTINCT FROM 'pdf'
    OR document->>'source_format' IS DISTINCT FROM 'pdf'
    OR document->>'reading_order' IS DISTINCT FROM 'heuristic'
    OR jsonb_typeof(document->'tagged') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(document->'text_available') IS DISTINCT FROM 'boolean'
    OR coalesce(document->>'text_block_count', '') !~ '^(0|[1-9][0-9]{0,3})$'
    OR coalesce(document->>'text_characters', '') !~ '^(0|[1-9][0-9]{0,5})$'
  THEN
    RETURN false;
  END IF;
  IF (document->>'text_block_count')::integer NOT BETWEEN 0 AND 2000
    OR (document->>'text_characters')::integer NOT BETWEEN 0 AND 200000
    OR ((document->>'text_characters')::integer > 0)
      IS DISTINCT FROM (document->>'text_available')::boolean
  THEN
    RETURN false;
  END IF;

  IF document->>'accessible_preview_schema' = 'opengeo.document-preview.2.0.0'
    AND document->>'text_extraction' = 'poppler_pdftotext'
    AND jsonb_typeof(document->'ocr_performed') = 'boolean'
    AND document->>'ocr_performed' = 'false'
  THEN
    is_ocr := false;
  ELSIF document->>'accessible_preview_schema' = 'opengeo.document-preview.3.0.0'
    AND document->>'text_extraction' = 'poppler_pdftotext_tesseract'
    AND jsonb_typeof(document->'ocr_performed') = 'boolean'
    AND document->>'ocr_performed' = 'true'
    AND document->>'ocr_engine' = 'tesseract'
    AND coalesce(document->>'ocr_engine_version', '') ~
      '^[0-9]+\.[0-9]+\.[0-9]+[-+._A-Za-z0-9]{0,24}$'
    AND document->>'ocr_model' = ANY (ARRAY[
      'eng',
      'Arabic',
      'Bengali',
      'Cyrillic',
      'Devanagari',
      'Ethiopic',
      'Greek',
      'Hangul',
      'HanS',
      'HanT',
      'Hebrew',
      'Japanese',
      'Latin',
      'Thai'
    ])
    AND document->>'ocr_page_limit' = '32'
    AND document->>'ocr_pixel_limit' = '32000000'
    AND jsonb_typeof(document->'ocr_truncated') = 'boolean'
    AND jsonb_typeof(document->'ocr_pages') = 'array'
    AND coalesce(document->>'page_count', '') ~ '^[1-9][0-9]{0,2}$'
    AND coalesce(document->>'ocr_page_count', '') ~ '^[1-9][0-9]?$'
    AND coalesce(document->>'ocr_maximum_dimension', '') ~ '^[1-9][0-9]{2,3}$'
    AND coalesce(document->>'ocr_total_pixels', '') ~ '^[1-9][0-9]{0,7}$'
  THEN
    is_ocr := true;
    page_count := (document->>'page_count')::integer;
    ocr_page_count := (document->>'ocr_page_count')::integer;
    IF page_count NOT BETWEEN 1 AND 200
      OR ocr_page_count NOT BETWEEN 1 AND 32
      OR jsonb_array_length(document->'ocr_pages') <> ocr_page_count
      OR (document->>'ocr_maximum_dimension')::integer NOT BETWEEN 300 AND 1600
      OR (document->>'ocr_total_pixels')::integer NOT BETWEEN 1 AND 32000000
      OR (
        (document->>'ocr_truncated')::boolean
        AND (ocr_page_count <> 32 OR page_count <= 32)
      )
    THEN
      RETURN false;
    END IF;
    FOR raw_page IN
      SELECT value
      FROM jsonb_array_elements_text(document->'ocr_pages') AS pages(value)
    LOOP
      IF raw_page !~ '^[1-9][0-9]{0,2}$'
        OR raw_page::integer > page_count
      THEN
        RETURN false;
      END IF;
      ocr_pages := array_append(ocr_pages, raw_page::integer);
    END LOOP;
    IF ocr_pages IS DISTINCT FROM (
      SELECT array_agg(page ORDER BY page) FROM unnest(ocr_pages) AS items(page)
    ) OR cardinality(ocr_pages) <> (
      SELECT count(DISTINCT page) FROM unnest(ocr_pages) AS items(page)
    ) THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;

  IF object_key LIKE '%/document/accessible-preview.json' THEN
    RETURN object_size BETWEEN 1 AND 524288;
  END IF;
  IF object_key NOT LIKE '%/document/visual-presentation.json'
    OR object_size NOT BETWEEN 1 AND 4194304
    OR document->>'visual_presentation_schema' IS DISTINCT FROM (
      CASE WHEN is_ocr
        THEN 'opengeo.pdf-visual-presentation.2.0.0'
        ELSE 'opengeo.pdf-visual-presentation.1.0.0'
      END
    )
    OR document->>'visual_renderer' IS DISTINCT FROM 'poppler_pdftoppm'
    OR document->>'visual_media_type' IS DISTINCT FROM 'image/jpeg'
    OR jsonb_typeof(document->'visual_annotations_hidden') IS DISTINCT FROM 'boolean'
    OR document->>'visual_annotations_hidden' IS DISTINCT FROM 'true'
    OR coalesce(document->>'page_count', '') !~ '^[1-9][0-9]{0,2}$'
    OR coalesce(document->>'visual_page_count', '') !~ '^[1-9][0-9]{0,2}$'
    OR coalesce(document->>'visual_target_max_dimension', '') !~ '^[1-9][0-9]{1,3}$'
    OR coalesce(document->>'visual_total_pixels', '') !~ '^[1-9][0-9]{0,7}$'
    OR coalesce(document->>'visual_total_image_bytes', '') !~ '^[1-9][0-9]{0,6}$'
  THEN
    RETURN false;
  END IF;
  IF (document->>'page_count')::integer NOT BETWEEN 1 AND 200
    OR (document->>'visual_page_count')::integer <>
      (document->>'page_count')::integer
    OR (document->>'visual_target_max_dimension')::integer NOT BETWEEN 64 AND 1000
    OR (document->>'visual_total_pixels')::integer NOT BETWEEN 1 AND 20000000
    OR (document->>'visual_total_image_bytes')::integer NOT BETWEEN 1 AND 2400000
  THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.pdf_document_publication_facts_valid_v1(
  jsonb, text, bigint
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.pdf_document_publication_facts_valid_v1(
  jsonb, text, bigint
) TO opengeo_runtime, opengeo_worker;

COMMENT ON FUNCTION app.pdf_document_publication_facts_valid_v1(jsonb, text, bigint) IS
  'Validates closed bounded legacy or OCR PDF publication facts and semantic or visual object limits.';


CREATE OR REPLACE FUNCTION app.enforce_project_site_asset_seal_v14()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count bigint;
  sealed_count bigint;
  sealed_print_layout jsonb;
BEGIN
  IF NEW.manifest->>'schemaVersion' <> 'opengeo.site-edition.1.4.0' THEN
    IF EXISTS (
      SELECT 1
      FROM app.project_site_pages page
      JOIN app.governed_resource_versions version
        ON version.organization_id = page.organization_id
       AND version.resource_id = page.resource_id
       AND version.id = page.resource_version_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(version.content->'blocks') = 'array'
          THEN version.content->'blocks' ELSE '[]'::jsonb END
      ) block
      WHERE page.organization_id = NEW.organization_id
        AND page.project_id = NEW.project_id
        AND page.site_id = NEW.site_id
        AND page.site_version_id = NEW.site_version_id
        AND block->>'type' = 'document'
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(NEW.manifest->'assets') = 'array'
          THEN NEW.manifest->'assets' ELSE '[]'::jsonb END
      ) asset
      WHERE asset->>'kind' = 'document'
    ) THEN
      RAISE EXCEPTION 'public document blocks require site edition schema 1.4';
    END IF;
    RETURN NEW;
  END IF;

  SELECT version.print_layout INTO sealed_print_layout
  FROM app.project_site_versions version
  WHERE version.organization_id = NEW.organization_id
    AND version.project_id = NEW.project_id
    AND version.site_id = NEW.site_id
    AND version.id = NEW.site_version_id;
  IF NEW.manifest->'printLayout' IS DISTINCT FROM sealed_print_layout THEN
    RAISE EXCEPTION 'project site edition print layout seal mismatch';
  END IF;

  IF jsonb_typeof(NEW.manifest->'assets') <> 'array'
    OR jsonb_array_length(NEW.manifest->'assets') > 16
  THEN
    RAISE EXCEPTION 'project site edition asset manifest is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.manifest->'assets') asset
    WHERE asset->>'kind' NOT IN ('image', 'file', 'document')
      OR asset->>'datasetId' !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR asset->>'datasetVersionId' !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR asset->>'objectId' !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR asset->>'storageVersionId' IS NULL
      OR asset->>'checksumSha256' !~ '^[0-9a-f]{64}$'
      OR asset->>'sizeBytes' !~ '^[1-9][0-9]{0,7}$'
      OR asset->>'contentType' IS NULL
      OR asset->>'filename' IS NULL
  ) THEN
    RAISE EXCEPTION 'project site edition asset identity is invalid';
  END IF;

  SELECT count(*), count(DISTINCT asset->>'objectId')
  INTO sealed_count, expected_count
  FROM jsonb_array_elements(NEW.manifest->'assets') asset;
  IF sealed_count <> expected_count THEN
    RAISE EXCEPTION 'project site edition asset identities must be unique';
  END IF;

  WITH expected_asset AS (
    SELECT DISTINCT
      block->>'type' AS kind,
      block->>'dataset_id' AS dataset_id,
      block->>'dataset_version_id' AS dataset_version_id,
      block->>'object_id' AS object_id
    FROM app.project_site_pages page
    JOIN app.governed_resource_versions version
      ON version.organization_id = page.organization_id
     AND version.resource_id = page.resource_id
     AND version.id = page.resource_version_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(version.content->'blocks') = 'array'
        THEN version.content->'blocks' ELSE '[]'::jsonb END
    ) block
    WHERE page.organization_id = NEW.organization_id
      AND page.project_id = NEW.project_id
      AND page.site_id = NEW.site_id
      AND page.site_version_id = NEW.site_version_id
      AND block->>'type' IN ('image', 'file', 'document')
  )
  SELECT count(*) INTO expected_count FROM expected_asset;
  IF expected_count <> sealed_count OR EXISTS (
    WITH expected_asset AS (
      SELECT DISTINCT
        block->>'type' AS kind,
        block->>'dataset_id' AS dataset_id,
        block->>'dataset_version_id' AS dataset_version_id,
        block->>'object_id' AS object_id
      FROM app.project_site_pages page
      JOIN app.governed_resource_versions version
        ON version.organization_id = page.organization_id
       AND version.resource_id = page.resource_id
       AND version.id = page.resource_version_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(version.content->'blocks') = 'array'
          THEN version.content->'blocks' ELSE '[]'::jsonb END
      ) block
      WHERE page.organization_id = NEW.organization_id
        AND page.project_id = NEW.project_id
        AND page.site_id = NEW.site_id
        AND page.site_version_id = NEW.site_version_id
        AND block->>'type' IN ('image', 'file', 'document')
    )
    SELECT 1
    FROM expected_asset expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.manifest->'assets') asset
      WHERE asset->>'kind' = expected.kind
        AND asset->>'datasetId' = expected.dataset_id
        AND asset->>'datasetVersionId' = expected.dataset_version_id
        AND asset->>'objectId' = expected.object_id
    )
  ) THEN
    RAISE EXCEPTION 'project site edition content asset seal mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.manifest->'assets') asset
    LEFT JOIN app.datasets dataset
      ON dataset.organization_id = NEW.organization_id
     AND dataset.id = (asset->>'datasetId')::uuid
    LEFT JOIN app.project_datasets project_dataset
      ON project_dataset.organization_id = dataset.organization_id
     AND project_dataset.dataset_id = dataset.id
     AND project_dataset.project_id = NEW.project_id
    LEFT JOIN app.dataset_versions version
      ON version.organization_id = dataset.organization_id
     AND version.dataset_id = dataset.id
     AND version.id = (asset->>'datasetVersionId')::uuid
    LEFT JOIN app.dataset_version_objects link
      ON link.organization_id = version.organization_id
     AND link.dataset_id = version.dataset_id
     AND link.dataset_version_id = version.id
     AND link.data_object_id = (asset->>'objectId')::uuid
    LEFT JOIN app.data_objects object
      ON object.organization_id = link.organization_id
     AND object.dataset_id = link.dataset_id
     AND object.id = link.data_object_id
    WHERE project_dataset.dataset_id IS NULL
      OR dataset.classification <> 'public'
      OR dataset.status <> 'active'
      OR version.state <> 'active'
      OR object.id IS NULL
      OR object.s3_version_id IS DISTINCT FROM asset->>'storageVersionId'
      OR object.content_type IS DISTINCT FROM asset->>'contentType'
      OR object.size_bytes::text IS DISTINCT FROM asset->>'sizeBytes'
      OR object.checksum_sha256 IS DISTINCT FROM asset->>'checksumSha256'
      OR (asset->>'kind' = 'image' AND (
        object.content_type <> 'image/png'
        OR object.role::text NOT IN ('derived', 'published', 'thumbnail')
        OR object.size_bytes NOT BETWEEN 1 AND 4194304
      ))
      OR (asset->>'kind' = 'document' AND (
        version.geometry_type IS DISTINCT FROM 'document'
        OR object.role::text IS DISTINCT FROM 'derived'
        OR object.content_type IS DISTINCT FROM 'application/json'
        OR NOT coalesce(
          (
            dataset.format::text = 'odt'
            AND object.object_key LIKE '%/document/accessible-preview.json'
            AND object.size_bytes BETWEEN 1 AND 524288
            AND version.schema_definition #>> '{document,kind}' = 'odf_text'
            AND version.schema_definition #>> '{document,source_format}' = 'odt'
            AND version.schema_definition #>> '{document,accessible_preview_schema}' =
              'opengeo.document-preview.1.0.0'
          ) OR (
            dataset.format::text = 'pdf'
            AND app.pdf_document_publication_facts_valid_v1(
              version.schema_definition,
              object.object_key,
              object.size_bytes
            )
          ),
          false
        )
        OR version.quality_results #>> '{safety_scan,status}' IS DISTINCT FROM 'passed'
        OR version.quality_results #>> '{safety_scan,engine}' IS DISTINCT FROM 'ClamAV'
        OR version.quality_results #>> '{safety_scan,comprehensive_malware_scan}'
          IS DISTINCT FROM 'true'
        OR coalesce(version.quality_results #>> '{safety_scan,engine_version}', '') = ''
        OR coalesce(version.quality_results #>> '{safety_scan,signature_version}', '')
          !~ '^[1-9][0-9]*$'
      ))
  ) THEN
    RAISE EXCEPTION 'project site edition governed asset is invalid';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.enforce_project_site_asset_seal_v14() IS
  'Seals exact governed page assets and permits scan-evidenced ODT or bounded PDF semantic, OCR, and visual presentations.';


COMMIT;
