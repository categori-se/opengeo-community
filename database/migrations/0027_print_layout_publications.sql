BEGIN;

CREATE FUNCTION app.project_site_theme_options_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(value)) <= 8
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(value) option_name
      WHERE option_name NOT IN (
        'accentColor',
        'footerText',
        'printPageSize',
        'printOrientation',
        'printLayout',
        'printLegend',
        'printNorthArrow',
        'printScaleBar'
      )
    )
    AND (
      NOT value ? 'accentColor'
      OR (
        jsonb_typeof(value->'accentColor') = 'string'
        AND value->>'accentColor' ~ '^#[0-9a-fA-F]{6}$'
      )
    )
    AND (
      NOT value ? 'footerText'
      OR (
        jsonb_typeof(value->'footerText') = 'string'
        AND value->>'footerText' = btrim(value->>'footerText')
        AND char_length(value->>'footerText') BETWEEN 1 AND 500
      )
    )
    AND (
      NOT value ? 'printPageSize'
      OR (
        jsonb_typeof(value->'printPageSize') = 'string'
        AND value->>'printPageSize' IN (
          'letter', 'legal', 'tabloid', 'a4', 'a3', 'a2', 'a1', 'a0'
        )
      )
    )
    AND (
      NOT value ? 'printOrientation'
      OR (
        jsonb_typeof(value->'printOrientation') = 'string'
        AND value->>'printOrientation' IN ('portrait', 'landscape')
      )
    )
    AND (
      NOT value ? 'printLayout'
      OR (
        jsonb_typeof(value->'printLayout') = 'string'
        AND value->>'printLayout' IN ('flow', 'map-sheet')
      )
    )
    AND (
      NOT value ? 'printLegend'
      OR (
        jsonb_typeof(value->'printLegend') = 'string'
        AND value->>'printLegend' IN ('true', 'false')
      )
    )
    AND (
      NOT value ? 'printNorthArrow'
      OR (
        jsonb_typeof(value->'printNorthArrow') = 'string'
        AND value->>'printNorthArrow' IN ('true', 'false')
      )
    )
    AND (
      NOT value ? 'printScaleBar'
      OR (
        jsonb_typeof(value->'printScaleBar') = 'string'
        AND value->>'printScaleBar' IN ('true', 'false')
      )
    );
$$;

ALTER TABLE app.project_site_versions
  ADD CONSTRAINT project_site_versions_theme_options_contract
  CHECK (app.project_site_theme_options_valid(theme_options));

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
       'opengeo.site-edition.1.3.0'
     )
    OR (
      NEW.manifest->>'schemaVersion' = 'opengeo.site-edition.1.3.0'
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
    ), sealed_reference AS (
      SELECT manifest_reference
      FROM jsonb_array_elements(NEW.manifest->'references') manifest_reference
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

REVOKE EXECUTE ON FUNCTION app.project_site_theme_options_valid(jsonb)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.project_site_theme_options_valid(jsonb)
TO opengeo_runtime;

COMMENT ON FUNCTION app.project_site_theme_options_valid(jsonb) IS
  'Validates the closed, bounded, dependency-free site theme and print option contract.';

COMMENT ON CONSTRAINT project_site_versions_theme_options_contract
  ON app.project_site_versions IS
  'Pins paper size, orientation, layout, and cartographic furniture into an immutable site revision.';

COMMIT;
