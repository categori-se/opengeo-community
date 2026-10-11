BEGIN;

CREATE OR REPLACE FUNCTION app.enforce_project_site_edition_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_site app.project_sites%ROWTYPE;
  page_count bigint;
  home_count bigint;
  sealed_theme_options jsonb;
BEGIN
  IF NEW.published_by <> app.current_user_id()
    OR NEW.revoked_by IS NOT NULL
    OR NEW.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'project site edition publisher mismatch';
  END IF;
  SELECT * INTO current_site
  FROM app.project_sites site
  WHERE site.organization_id = NEW.organization_id
    AND site.project_id = NEW.project_id
    AND site.id = NEW.site_id
  FOR UPDATE;
  IF NOT FOUND
    OR current_site.state <> 'review'
    OR current_site.current_version_id <> NEW.site_version_id
    OR current_site.current_version_number <> NEW.site_version_number
  THEN
    RAISE EXCEPTION 'project site edition must publish the reviewed head';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE page.is_home)
  INTO page_count, home_count
  FROM app.project_site_pages page
  WHERE page.organization_id = NEW.organization_id
    AND page.project_id = NEW.project_id
    AND page.site_id = NEW.site_id
    AND page.site_version_id = NEW.site_version_id;
  IF page_count NOT BETWEEN 1 AND 64 OR home_count <> 1 THEN
    RAISE EXCEPTION 'project site edition requires one to 64 pages and exactly one home page';
  END IF;
  SELECT version.theme_options INTO sealed_theme_options
  FROM app.project_site_versions version
  WHERE version.organization_id = NEW.organization_id
    AND version.project_id = NEW.project_id
    AND version.site_id = NEW.site_id
    AND version.id = NEW.site_version_id;
  IF NEW.manifest->>'schemaVersion' NOT IN (
       'opengeo.site-edition.1.0.0',
       'opengeo.site-edition.1.1.0',
       'opengeo.site-edition.1.2.0',
       'opengeo.site-edition.1.3.0',
       'opengeo.site-edition.1.4.0'
     )
    OR (
      NEW.manifest->>'schemaVersion' IN (
        'opengeo.site-edition.1.3.0', 'opengeo.site-edition.1.4.0'
      )
      AND NEW.manifest->'themeOptions' IS DISTINCT FROM sealed_theme_options
    )
    OR NEW.manifest->>'organizationId' <> NEW.organization_id::text
    OR NEW.manifest->>'projectId' <> NEW.project_id::text
    OR NEW.manifest->>'siteId' <> NEW.site_id::text
    OR NEW.manifest->>'siteVersionId' <> NEW.site_version_id::text
    OR NEW.manifest->>'siteVersionNumber' <> NEW.site_version_number::text
    OR NEW.manifest->>'editionId' <> NEW.id::text
    OR NEW.manifest->>'editionNumber' <> NEW.edition_number::text
    OR jsonb_typeof(NEW.manifest->'pages') <> 'array'
    OR jsonb_array_length(NEW.manifest->'pages') <> page_count
    OR jsonb_typeof(NEW.manifest->'references') <> 'array'
  THEN
    RAISE EXCEPTION 'project site edition manifest identity or shape mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.manifest->'pages') manifest_page
        WHERE manifest_page->>'slug' = page.page_slug
          AND manifest_page->>'navigationLabel' = page.navigation_label
          AND manifest_page->>'position' = page.position::text
          AND manifest_page->>'home' = lower(page.is_home::text)
          AND manifest_page->>'resourceId' = page.resource_id::text
          AND manifest_page->>'resourceVersionId' = page.resource_version_id::text
          AND manifest_page->>'resourceVersionNumber' = page.resource_version_number::text
      )
  ) THEN
    RAISE EXCEPTION 'project site edition manifest page seal mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    JOIN app.governed_resources resource
      ON resource.organization_id = page.organization_id
     AND resource.project_id = page.project_id
     AND resource.id = page.resource_id
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND (resource.state <> 'published' OR resource.visibility <> 'public')
  ) THEN
    RAISE EXCEPTION 'project site edition pages must be published and public';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    JOIN app.governed_resource_versions version
      ON version.organization_id = page.organization_id
     AND version.resource_id = page.resource_id
     AND version.id = page.resource_version_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(version.content->'blocks') = 'array'
          THEN version.content->'blocks'
        ELSE '[]'::jsonb
      END
    ) block
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND block->>'type' IN ('map', 'dataset')
      AND NOT EXISTS (
        SELECT 1
        FROM app.governed_resources referenced
        WHERE referenced.organization_id = NEW.organization_id
          AND referenced.project_id = NEW.project_id
          AND referenced.id = CASE
            WHEN block->>'resource_id' ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              THEN (block->>'resource_id')::uuid
            ELSE NULL
          END
          AND referenced.state = 'published'
          AND referenced.visibility = 'public'
      )
  ) THEN
    RAISE EXCEPTION 'project site edition references must be published and public';
  END IF;
  IF (
    WITH expected_reference AS (
      SELECT page.resource_id
      FROM app.project_site_pages page
      JOIN app.governed_resources resource
        ON resource.organization_id = page.organization_id
       AND resource.project_id = page.project_id
       AND resource.id = page.resource_id
      WHERE page.organization_id = NEW.organization_id
        AND page.site_version_id = NEW.site_version_id
        AND resource.kind = 'map'
      UNION
      SELECT CASE
        WHEN block->>'resource_id' ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          THEN (block->>'resource_id')::uuid
        ELSE NULL
      END
      FROM app.project_site_pages page
      JOIN app.governed_resource_versions version
        ON version.organization_id = page.organization_id
       AND version.resource_id = page.resource_id
       AND version.id = page.resource_version_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(version.content->'blocks') = 'array'
            THEN version.content->'blocks'
          ELSE '[]'::jsonb
        END
      ) block
      WHERE page.organization_id = NEW.organization_id
        AND page.site_version_id = NEW.site_version_id
        AND block->>'type' IN ('map', 'dataset')
    )
    SELECT count(*) FROM expected_reference
  ) <> jsonb_array_length(NEW.manifest->'references')
    OR EXISTS (
      WITH expected_reference AS (
        SELECT page.resource_id
        FROM app.project_site_pages page
        JOIN app.governed_resources resource
          ON resource.organization_id = page.organization_id
         AND resource.project_id = page.project_id
         AND resource.id = page.resource_id
        WHERE page.organization_id = NEW.organization_id
          AND page.site_version_id = NEW.site_version_id
          AND resource.kind = 'map'
        UNION
        SELECT CASE
          WHEN block->>'resource_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
            THEN (block->>'resource_id')::uuid
          ELSE NULL
        END
        FROM app.project_site_pages page
        JOIN app.governed_resource_versions version
          ON version.organization_id = page.organization_id
         AND version.resource_id = page.resource_id
         AND version.id = page.resource_version_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(version.content->'blocks') = 'array'
              THEN version.content->'blocks'
            ELSE '[]'::jsonb
          END
        ) block
        WHERE page.organization_id = NEW.organization_id
          AND page.site_version_id = NEW.site_version_id
          AND block->>'type' IN ('map', 'dataset')
      )
      SELECT 1
      FROM expected_reference expected
      JOIN app.governed_resources resource
        ON resource.organization_id = NEW.organization_id
       AND resource.project_id = NEW.project_id
       AND resource.id = expected.resource_id
      JOIN app.governed_resource_versions version
        ON version.organization_id = resource.organization_id
       AND version.resource_id = resource.id
       AND version.id = resource.current_version_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.manifest->'references') manifest_reference
        WHERE manifest_reference->>'resourceId' = resource.id::text
          AND manifest_reference->>'versionId' = version.id::text
          AND manifest_reference->>'versionNumber' = version.version_number::text
          AND manifest_reference->>'kind' = resource.kind::text
      )
    )
  THEN
    RAISE EXCEPTION 'project site edition manifest reference seal mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_asset_seal_v14()
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
        dataset.format::text <> 'odt'
        OR version.geometry_type <> 'document'
        OR version.schema_definition #>> '{document,kind}' <> 'odf_text'
        OR version.schema_definition #>> '{document,source_format}' <> 'odt'
        OR version.schema_definition #>> '{document,accessible_preview_schema}' <>
          'opengeo.document-preview.1.0.0'
        OR object.role::text <> 'derived'
        OR object.content_type <> 'application/json'
        OR object.object_key NOT LIKE '%/document/accessible-preview.json'
        OR object.size_bytes NOT BETWEEN 1 AND 524288
        OR version.quality_results #>> '{safety_scan,status}' <> 'passed'
        OR version.quality_results #>> '{safety_scan,engine}' <> 'ClamAV'
        OR version.quality_results #>> '{safety_scan,comprehensive_malware_scan}' <> 'true'
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

CREATE TRIGGER project_site_editions_asset_seal_v14
BEFORE INSERT ON app.project_site_editions
FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_asset_seal_v14();

REVOKE EXECUTE ON FUNCTION app.enforce_project_site_asset_seal_v14()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON FUNCTION app.enforce_project_site_asset_seal_v14() IS
  'Seals exact governed page assets and permits only post-scan ODT semantic previews as public document blocks.';

COMMIT;
