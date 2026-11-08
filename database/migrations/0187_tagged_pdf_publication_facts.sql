BEGIN;

CREATE OR REPLACE FUNCTION app.pdf_document_publication_facts_valid_v1(
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
    AND document->>'reading_order' = 'heuristic'
    AND jsonb_typeof(document->'ocr_performed') = 'boolean'
    AND document->>'ocr_performed' = 'false'
  THEN
    is_ocr := false;
  ELSIF document->>'accessible_preview_schema' = 'opengeo.document-preview.2.0.0'
    AND document->>'text_extraction' = 'pypdf_tagged_actualtext'
    AND document->>'reading_order' = 'source-tags'
    AND document->'ocr_performed' = 'false'::jsonb
    AND document->'tagged' = 'true'::jsonb
    AND document->'text_available' = 'true'::jsonb
    AND jsonb_typeof(document->'text_block_count') = 'number'
    AND jsonb_typeof(document->'text_characters') = 'number'
    AND (document->>'text_block_count')::integer > 0
  THEN
    is_ocr := false;
  ELSIF document->>'accessible_preview_schema' = 'opengeo.document-preview.3.0.0'
    AND document->>'text_extraction' = 'poppler_pdftotext_tesseract'
    AND document->>'reading_order' = 'heuristic'
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

COMMENT ON FUNCTION app.pdf_document_publication_facts_valid_v1(jsonb, text, bigint) IS
  'Validates bounded legacy, validated tagged ActualText, or OCR PDF facts without changing asset identity, scan, rights or seal guards.';

COMMIT;
