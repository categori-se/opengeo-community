BEGIN;

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
            AND version.schema_definition #>> '{document,kind}' = 'pdf'
            AND version.schema_definition #>> '{document,source_format}' = 'pdf'
            AND version.schema_definition #>> '{document,accessible_preview_schema}' =
              'opengeo.document-preview.2.0.0'
            AND version.schema_definition #>> '{document,text_extraction}' =
              'poppler_pdftotext'
            AND version.schema_definition #>> '{document,reading_order}' = 'heuristic'
            AND jsonb_typeof(
              version.schema_definition #> '{document,ocr_performed}'
            ) = 'boolean'
            AND version.schema_definition #>> '{document,ocr_performed}' = 'false'
            AND jsonb_typeof(version.schema_definition #> '{document,tagged}') = 'boolean'
            AND jsonb_typeof(
              version.schema_definition #> '{document,text_available}'
            ) = 'boolean'
            AND CASE
              WHEN version.schema_definition #>> '{document,text_block_count}' ~
                '^(0|[1-9][0-9]{0,3})$'
              THEN (version.schema_definition #>> '{document,text_block_count}')::integer
                BETWEEN 0 AND 2000
              ELSE false
            END
            AND CASE
              WHEN version.schema_definition #>> '{document,text_characters}' ~
                '^(0|[1-9][0-9]{0,5})$'
              THEN (version.schema_definition #>> '{document,text_characters}')::integer
                BETWEEN 0 AND 200000
              ELSE false
            END
            AND CASE
              WHEN version.schema_definition #>> '{document,text_characters}' ~
                '^(0|[1-9][0-9]{0,5})$'
                AND jsonb_typeof(
                  version.schema_definition #> '{document,text_available}'
                ) = 'boolean'
              THEN (
                (version.schema_definition #>> '{document,text_characters}')::integer > 0
              ) = (
                (version.schema_definition #>> '{document,text_available}')::boolean
              )
              ELSE false
            END
            AND (
              (
                object.object_key LIKE '%/document/accessible-preview.json'
                AND object.size_bytes BETWEEN 1 AND 524288
              ) OR (
                object.object_key LIKE '%/document/visual-presentation.json'
                AND object.size_bytes BETWEEN 1 AND 4194304
                AND version.schema_definition #>>
                  '{document,visual_presentation_schema}' =
                  'opengeo.pdf-visual-presentation.1.0.0'
                AND version.schema_definition #>> '{document,visual_renderer}' =
                  'poppler_pdftoppm'
                AND version.schema_definition #>> '{document,visual_media_type}' =
                  'image/jpeg'
                AND jsonb_typeof(
                  version.schema_definition #> '{document,visual_annotations_hidden}'
                ) = 'boolean'
                AND version.schema_definition #>>
                  '{document,visual_annotations_hidden}' = 'true'
                AND CASE
                  WHEN version.schema_definition #>> '{document,page_count}' ~
                    '^[1-9][0-9]{0,2}$'
                    AND version.schema_definition #>> '{document,visual_page_count}' ~
                    '^[1-9][0-9]{0,2}$'
                  THEN (version.schema_definition #>> '{document,page_count}')::integer
                    BETWEEN 1 AND 200
                    AND (version.schema_definition #>>
                      '{document,visual_page_count}')::integer =
                      (version.schema_definition #>> '{document,page_count}')::integer
                  ELSE false
                END
                AND CASE
                  WHEN version.schema_definition #>>
                    '{document,visual_target_max_dimension}' ~ '^[1-9][0-9]{1,3}$'
                  THEN (version.schema_definition #>>
                    '{document,visual_target_max_dimension}')::integer BETWEEN 64 AND 1000
                  ELSE false
                END
                AND CASE
                  WHEN version.schema_definition #>> '{document,visual_total_pixels}' ~
                    '^[1-9][0-9]{0,7}$'
                  THEN (version.schema_definition #>>
                    '{document,visual_total_pixels}')::integer BETWEEN 1 AND 20000000
                  ELSE false
                END
                AND CASE
                  WHEN version.schema_definition #>>
                    '{document,visual_total_image_bytes}' ~ '^[1-9][0-9]{0,6}$'
                  THEN (version.schema_definition #>>
                    '{document,visual_total_image_bytes}')::integer BETWEEN 1 AND 2400000
                  ELSE false
                END
              )
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
  'Seals exact governed page assets and permits scan-evidenced ODT semantics or bounded PDF semantic and visual presentations.';

COMMIT;
