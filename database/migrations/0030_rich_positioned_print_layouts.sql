BEGIN;

ALTER FUNCTION app.project_site_print_layout_valid(jsonb)
  RENAME TO project_site_print_layout_v1_valid;

CREATE FUNCTION app.project_site_print_layout_v11_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  layout_page jsonb;
  element jsonb;
  kind text;
  x_value integer;
  y_value integer;
  width_value integer;
  height_value integer;
  rotation_value integer;
  page_slugs text[] := ARRAY[]::text[];
  element_ids text[];
  map_frame_ids text[];
  map_resource_ids uuid[] := ARRAY[]::uuid[];
  element_total integer := 0;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 2
    OR value->>'schemaVersion' <> 'opengeo.print-layout.1.1.0'
    OR jsonb_typeof(value->'pages') <> 'array'
    OR jsonb_array_length(value->'pages') > 64
    OR octet_length(value::text) > 32768
  THEN
    RETURN false;
  END IF;

  FOR layout_page IN SELECT item FROM jsonb_array_elements(value->'pages') item LOOP
    IF jsonb_typeof(layout_page) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(layout_page)) <> 2
      OR NOT layout_page ?& ARRAY['sitePageSlug', 'elements']
      OR layout_page->>'sitePageSlug' !~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
      OR layout_page->>'sitePageSlug' = ANY(page_slugs)
      OR jsonb_typeof(layout_page->'elements') <> 'array'
      OR jsonb_array_length(layout_page->'elements') NOT BETWEEN 1 AND 32
    THEN
      RETURN false;
    END IF;
    page_slugs := array_append(page_slugs, layout_page->>'sitePageSlug');
    element_total := element_total + jsonb_array_length(layout_page->'elements');
    IF element_total > 256 THEN
      RETURN false;
    END IF;
    element_ids := ARRAY[]::text[];
    map_frame_ids := ARRAY[]::text[];

    FOR element IN SELECT item FROM jsonb_array_elements(layout_page->'elements') item LOOP
      kind := element->>'type';
      IF jsonb_typeof(element) <> 'object'
        OR kind NOT IN (
          'map_frame', 'text', 'source_panel', 'north_arrow', 'scale_bar',
          'legend_frame', 'image_frame', 'table_frame', 'chart_frame'
        )
        OR NOT element ?& ARRAY[
          'id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'clip'
        ]
        OR element->>'id' !~ '^[a-z][a-z0-9_-]{0,63}$'
        OR element->>'id' = ANY(element_ids)
        OR jsonb_typeof(element->'x') <> 'number'
        OR jsonb_typeof(element->'y') <> 'number'
        OR jsonb_typeof(element->'width') <> 'number'
        OR jsonb_typeof(element->'height') <> 'number'
        OR jsonb_typeof(element->'rotation') <> 'number'
        OR jsonb_typeof(element->'clip') <> 'boolean'
        OR element->>'x' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'y' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'width' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'height' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'rotation' !~ '^-?(0|[1-9][0-9]{0,2})$'
      THEN
        RETURN false;
      END IF;
      x_value := (element->>'x')::integer;
      y_value := (element->>'y')::integer;
      width_value := (element->>'width')::integer;
      height_value := (element->>'height')::integer;
      rotation_value := (element->>'rotation')::integer;
      IF x_value > 1000 OR y_value > 1000
        OR width_value NOT BETWEEN 10 AND 1000
        OR height_value NOT BETWEEN 10 AND 1000
        OR x_value + width_value > 1000
        OR y_value + height_value > 1000
        OR rotation_value NOT BETWEEN -180 AND 180
      THEN
        RETURN false;
      END IF;
      element_ids := array_append(element_ids, element->>'id');

      IF kind = 'map_frame' THEN
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 10
          OR NOT element ?& ARRAY['resourceId', 'fit']
          OR element->>'resourceId' !~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          OR element->>'fit' NOT IN ('contain', 'cover')
        THEN
          RETURN false;
        END IF;
        map_frame_ids := array_append(map_frame_ids, element->>'id');
        IF NOT ((element->>'resourceId')::uuid = ANY(map_resource_ids)) THEN
          map_resource_ids := array_append(map_resource_ids, (element->>'resourceId')::uuid);
          IF cardinality(map_resource_ids) > 16 THEN
            RETURN false;
          END IF;
        END IF;
      ELSIF kind = 'text' THEN
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 10
          OR NOT element ?& ARRAY['text', 'style']
          OR jsonb_typeof(element->'text') <> 'string'
          OR element->>'text' <> btrim(element->>'text')
          OR char_length(element->>'text') NOT BETWEEN 1 AND 1000
          OR element->>'style' NOT IN ('title', 'heading', 'body', 'note', 'attribution')
        THEN
          RETURN false;
        END IF;
      ELSIF kind IN ('image_frame', 'table_frame', 'chart_frame') THEN
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <>
             (CASE WHEN kind = 'image_frame' THEN 10 ELSE 9 END)
          OR NOT element ? 'blockId'
          OR element->>'blockId' !~ '^[a-z][a-z0-9_-]{0,63}$'
          OR (kind = 'image_frame' AND (
            NOT element ? 'fit' OR element->>'fit' NOT IN ('contain', 'cover')
          ))
        THEN
          RETURN false;
        END IF;
      ELSE
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 9
          OR NOT element ? 'mapFrameId'
          OR element->>'mapFrameId' !~ '^[a-z][a-z0-9_-]{0,63}$'
        THEN
          RETURN false;
        END IF;
      END IF;
    END LOOP;

    FOR element IN SELECT item FROM jsonb_array_elements(layout_page->'elements') item LOOP
      IF element->>'type' IN (
        'source_panel', 'north_arrow', 'scale_bar', 'legend_frame'
      ) AND NOT element->>'mapFrameId' = ANY(map_frame_ids)
      THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION app.project_site_print_layout_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE value->>'schemaVersion'
    WHEN 'opengeo.print-layout.1.0.0' THEN app.project_site_print_layout_v1_valid(value)
    WHEN 'opengeo.print-layout.1.1.0' THEN app.project_site_print_layout_v11_valid(value)
    ELSE false
  END;
$$;

ALTER TABLE app.project_site_versions
  DROP CONSTRAINT project_site_versions_print_layout_contract;
ALTER TABLE app.project_site_versions
  ADD CONSTRAINT project_site_versions_print_layout_contract
  CHECK (app.project_site_print_layout_valid(print_layout));
ALTER TABLE app.project_site_versions
  ALTER COLUMN print_layout SET DEFAULT
    '{"schemaVersion":"opengeo.print-layout.1.1.0","pages":[]}'::jsonb;

CREATE FUNCTION app.enforce_project_site_rich_print_layout_seal()
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

  IF sealed_print_layout->>'schemaVersion' <> 'opengeo.print-layout.1.1.0' THEN
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

CREATE TRIGGER project_site_editions_rich_print_layout_seal
BEFORE INSERT ON app.project_site_editions
FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_rich_print_layout_seal();

REVOKE EXECUTE ON FUNCTION app.project_site_print_layout_v1_valid(jsonb)
FROM PUBLIC, opengeo_runtime, opengeo_worker;
REVOKE EXECUTE ON FUNCTION app.project_site_print_layout_v11_valid(jsonb)
FROM PUBLIC, opengeo_runtime, opengeo_worker;
REVOKE EXECUTE ON FUNCTION app.project_site_print_layout_valid(jsonb)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.project_site_print_layout_v1_valid(jsonb)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.project_site_print_layout_v11_valid(jsonb)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.project_site_print_layout_valid(jsonb)
TO opengeo_runtime;
REVOKE EXECUTE ON FUNCTION app.enforce_project_site_rich_print_layout_seal()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON FUNCTION app.project_site_print_layout_v11_valid(jsonb) IS
  'Validates portable rich print frames, integer-degree rotation, clipping, and contain/cover fitting.';
COMMENT ON FUNCTION app.enforce_project_site_rich_print_layout_seal() IS
  'Requires style-derived legends and image/table/chart frames to resolve through the exact edition.';

COMMIT;
