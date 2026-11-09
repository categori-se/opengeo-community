BEGIN;

-- Shape frames are opt-in. Existing documents, defaults and seals stay intact.
CREATE FUNCTION app.project_site_print_layout_v12_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  layout_page jsonb;
  element jsonb;
  converted_elements jsonb;
  converted_pages jsonb := '[]'::jsonb;
  required_strings text[];
  field_name text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value->>'schemaVersion' IS DISTINCT FROM 'opengeo.print-layout.1.2.0'
    OR jsonb_typeof(value->'pages') IS DISTINCT FROM 'array'
    OR jsonb_array_length(value->'pages') > 64
    OR octet_length(value::text) > 32768
  THEN
    RETURN false;
  END IF;

  FOR layout_page IN SELECT item FROM jsonb_array_elements(value->'pages') item LOOP
    IF jsonb_typeof(layout_page) IS DISTINCT FROM 'object'
      OR jsonb_typeof(layout_page->'sitePageSlug') IS DISTINCT FROM 'string'
      OR jsonb_typeof(layout_page->'elements') IS DISTINCT FROM 'array'
      OR jsonb_array_length(layout_page->'elements') NOT BETWEEN 1 AND 32
    THEN
      RETURN false;
    END IF;
    converted_elements := '[]'::jsonb;
    FOR element IN SELECT item FROM jsonb_array_elements(layout_page->'elements') item LOOP
      IF jsonb_typeof(element) IS DISTINCT FROM 'object'
        OR jsonb_typeof(element->'id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(element->'type') IS DISTINCT FROM 'string'
      THEN
        RETURN false;
      END IF;
      -- The 1.1 regex predicates alone do not reject JSON null string fields.
      -- Close that ambiguity for every frame admitted by this new schema.
      required_strings := CASE element->>'type'
        WHEN 'map_frame' THEN ARRAY['resourceId', 'fit']
        WHEN 'text' THEN ARRAY['text', 'style']
        WHEN 'image_frame' THEN ARRAY['blockId', 'fit']
        WHEN 'table_frame' THEN ARRAY['blockId']
        WHEN 'chart_frame' THEN ARRAY['blockId']
        WHEN 'source_panel' THEN ARRAY['mapFrameId']
        WHEN 'north_arrow' THEN ARRAY['mapFrameId']
        WHEN 'scale_bar' THEN ARRAY['mapFrameId']
        WHEN 'legend_frame' THEN ARRAY['mapFrameId']
        ELSE ARRAY[]::text[]
      END;
      FOREACH field_name IN ARRAY required_strings LOOP
        IF jsonb_typeof(element->field_name) IS DISTINCT FROM 'string' THEN
          RETURN false;
        END IF;
      END LOOP;
      IF element->>'type' = 'shape_frame' THEN
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 12
          OR NOT element ?& ARRAY[
            'id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'clip',
            'shape', 'stroke', 'fill', 'strokeWidth'
          ]
          OR jsonb_typeof(element->'shape') IS DISTINCT FROM 'string'
          OR element->>'shape' NOT IN ('line', 'rectangle', 'ellipse')
          OR NOT (CASE jsonb_typeof(element->'stroke')
            WHEN 'null' THEN true
            WHEN 'string' THEN element->>'stroke' ~ '^#[0-9a-fA-F]{6}$'
            ELSE false END)
          OR NOT (CASE jsonb_typeof(element->'fill')
            WHEN 'null' THEN true
            WHEN 'string' THEN element->>'fill' ~ '^#[0-9a-fA-F]{6}$'
            ELSE false END)
          OR (element->'stroke' = 'null'::jsonb AND element->'fill' = 'null'::jsonb)
          OR (element->>'shape' = 'line' AND (
            element->'stroke' = 'null'::jsonb OR element->'fill' <> 'null'::jsonb
          ))
          OR jsonb_typeof(element->'strokeWidth') IS DISTINCT FROM 'number'
          OR element->>'strokeWidth' !~ '^([1-9]|1[0-2])$'
        THEN
          RETURN false;
        END IF;
        -- Reuse the complete 1.1 geometry, identity, count, size and map-binding
        -- checks. An inert text surrogate cannot acquire a map/resource binding.
        element := (element - ARRAY['shape', 'stroke', 'fill', 'strokeWidth'])
          || '{"type":"text","text":"Shape","style":"body"}'::jsonb;
      END IF;
      converted_elements := converted_elements || jsonb_build_array(element);
    END LOOP;
    converted_pages := converted_pages || jsonb_build_array(
      jsonb_set(layout_page, '{elements}', converted_elements)
    );
  END LOOP;
  RETURN app.project_site_print_layout_v11_valid(
    jsonb_set(
      jsonb_set(value, '{schemaVersion}', '"opengeo.print-layout.1.1.0"'::jsonb),
      '{pages}', converted_pages
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION app.project_site_print_layout_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE value->>'schemaVersion'
    WHEN 'opengeo.print-layout.1.0.0' THEN app.project_site_print_layout_v1_valid(value)
    WHEN 'opengeo.print-layout.1.1.0' THEN app.project_site_print_layout_v11_valid(value)
    WHEN 'opengeo.print-layout.1.2.0' THEN app.project_site_print_layout_v12_valid(value)
    ELSE false
  END;
$$;

-- New layouts must keep all existing exact-edition media and legend checks.
CREATE OR REPLACE FUNCTION app.enforce_project_site_rich_print_layout_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sealed_print_layout jsonb;
  layout_page jsonb;
  element jsonb;
  map_element jsonb;
  content_block jsonb;
  page_content jsonb;
BEGIN
  SELECT version.print_layout INTO sealed_print_layout
  FROM app.project_site_versions version
  WHERE version.organization_id = NEW.organization_id
    AND version.project_id = NEW.project_id
    AND version.site_id = NEW.site_id
    AND version.id = NEW.site_version_id;

  IF sealed_print_layout->>'schemaVersion' NOT IN (
    'opengeo.print-layout.1.1.0', 'opengeo.print-layout.1.2.0'
  ) THEN
    RETURN NEW;
  END IF;

  FOR layout_page IN
    SELECT item FROM jsonb_array_elements(sealed_print_layout->'pages') item
  LOOP
    SELECT resource_version.content INTO page_content
    FROM app.project_site_pages page
    JOIN app.governed_resource_versions resource_version
      ON resource_version.organization_id = page.organization_id
     AND resource_version.resource_id = page.resource_id
     AND resource_version.id = page.resource_version_id
    WHERE page.organization_id = NEW.organization_id
      AND page.project_id = NEW.project_id
      AND page.site_id = NEW.site_id
      AND page.site_version_id = NEW.site_version_id
      AND page.page_slug = layout_page->>'sitePageSlug';
    IF page_content IS NULL THEN
      RAISE EXCEPTION 'project site edition rich layout page seal mismatch';
    END IF;

    FOR element IN SELECT item FROM jsonb_array_elements(layout_page->'elements') item LOOP
      IF element->>'type' = 'legend_frame' THEN
        SELECT item INTO map_element
        FROM jsonb_array_elements(layout_page->'elements') item
        WHERE item->>'type' = 'map_frame'
          AND item->>'id' = element->>'mapFrameId';
        IF map_element IS NULL OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(NEW.manifest->'references') = 'array'
              THEN NEW.manifest->'references' ELSE '[]'::jsonb END
          ) reference
          WHERE reference->>'resourceId' = map_element->>'resourceId'
            AND jsonb_typeof(reference->'snapshot'->'legend') = 'object'
            AND jsonb_typeof(reference->'snapshot'->'legend'->'items') = 'array'
            AND jsonb_array_length(reference->'snapshot'->'legend'->'items') BETWEEN 1 AND 17
            AND reference->'snapshot'->'legend'->>'profileChecksumSha256' ~ '^[0-9a-f]{64}$'
        ) THEN
          RAISE EXCEPTION 'project site edition style legend seal mismatch';
        END IF;
      ELSIF element->>'type' IN ('image_frame', 'table_frame', 'chart_frame') THEN
        SELECT item INTO content_block
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(page_content->'blocks') = 'array'
            THEN page_content->'blocks' ELSE '[]'::jsonb END
        ) item
        WHERE item->>'id' = element->>'blockId';
        IF content_block IS NULL OR content_block->>'type' <>
          (CASE element->>'type'
            WHEN 'image_frame' THEN 'image'
            WHEN 'table_frame' THEN 'table'
            ELSE 'chart'
          END)
        THEN
          RAISE EXCEPTION 'project site edition content frame seal mismatch';
        END IF;
        IF element->>'type' = 'image_frame' AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(NEW.manifest->'assets') = 'array'
              THEN NEW.manifest->'assets' ELSE '[]'::jsonb END
          ) asset
          WHERE asset->>'kind' = 'image'
            AND asset->>'objectId' = content_block->>'object_id'
            AND asset->>'contentType' = 'image/png'
        ) THEN
          RAISE EXCEPTION 'project site edition image frame seal mismatch';
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.project_site_print_layout_v12_valid(jsonb)
FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.project_site_print_layout_v12_valid(jsonb)
TO opengeo_runtime;

COMMENT ON FUNCTION app.project_site_print_layout_v12_valid(jsonb) IS
  'Validates opt-in line, rectangle and ellipse frames; retains all prior layout and edition sealing boundaries.';

COMMIT;
