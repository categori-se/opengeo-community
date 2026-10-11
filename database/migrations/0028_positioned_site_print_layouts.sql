BEGIN;

ALTER TABLE app.project_site_versions
  ADD COLUMN print_layout jsonb NOT NULL DEFAULT
    '{"schemaVersion":"opengeo.print-layout.1.0.0","pages":[]}'::jsonb;

CREATE FUNCTION app.project_site_print_layout_valid(value jsonb)
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
  page_slugs text[] := ARRAY[]::text[];
  element_ids text[];
  map_frame_ids text[];
  map_resource_ids uuid[] := ARRAY[]::uuid[];
  element_total integer := 0;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 2
    OR value->>'schemaVersion' <> 'opengeo.print-layout.1.0.0'
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
        OR kind NOT IN ('map_frame', 'text', 'source_panel', 'north_arrow', 'scale_bar')
        OR NOT element ?& ARRAY['id', 'type', 'x', 'y', 'width', 'height']
        OR element->>'id' !~ '^[a-z][a-z0-9_-]{0,63}$'
        OR element->>'id' = ANY(element_ids)
        OR jsonb_typeof(element->'x') <> 'number'
        OR jsonb_typeof(element->'y') <> 'number'
        OR jsonb_typeof(element->'width') <> 'number'
        OR jsonb_typeof(element->'height') <> 'number'
        OR element->>'x' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'y' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'width' !~ '^(0|[1-9][0-9]{0,3})$'
        OR element->>'height' !~ '^(0|[1-9][0-9]{0,3})$'
      THEN
        RETURN false;
      END IF;
      x_value := (element->>'x')::integer;
      y_value := (element->>'y')::integer;
      width_value := (element->>'width')::integer;
      height_value := (element->>'height')::integer;
      IF x_value > 1000 OR y_value > 1000
        OR width_value NOT BETWEEN 10 AND 1000
        OR height_value NOT BETWEEN 10 AND 1000
        OR x_value + width_value > 1000
        OR y_value + height_value > 1000
      THEN
        RETURN false;
      END IF;
      element_ids := array_append(element_ids, element->>'id');

      IF kind = 'map_frame' THEN
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 7
          OR NOT element ? 'resourceId'
          OR element->>'resourceId' !~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 8
          OR NOT element ?& ARRAY['text', 'style']
          OR jsonb_typeof(element->'text') <> 'string'
          OR element->>'text' <> btrim(element->>'text')
          OR char_length(element->>'text') NOT BETWEEN 1 AND 1000
          OR element->>'style' NOT IN ('title', 'heading', 'body', 'note', 'attribution')
        THEN
          RETURN false;
        END IF;
      ELSE
        IF (SELECT count(*) FROM jsonb_object_keys(element)) <> 7
          OR NOT element ? 'mapFrameId'
          OR element->>'mapFrameId' !~ '^[a-z][a-z0-9_-]{0,63}$'
        THEN
          RETURN false;
        END IF;
      END IF;
    END LOOP;

    FOR element IN SELECT item FROM jsonb_array_elements(layout_page->'elements') item LOOP
      IF element->>'type' IN ('source_panel', 'north_arrow', 'scale_bar')
        AND NOT element->>'mapFrameId' = ANY(map_frame_ids)
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

ALTER TABLE app.project_site_versions
  ADD CONSTRAINT project_site_versions_print_layout_contract
  CHECK (app.project_site_print_layout_valid(print_layout));

ALTER TABLE app.project_site_editions
  DROP CONSTRAINT project_site_editions_manifest_bounded;

ALTER TABLE app.project_site_editions
  ADD CONSTRAINT project_site_editions_manifest_bounded CHECK (
    jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 131072
    AND jsonb_typeof(manifest->'references') = 'array'
    AND jsonb_array_length(manifest->'references') <= 128
    AND manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  );

CREATE FUNCTION app.enforce_project_site_print_layout_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sealed_print_layout jsonb;
BEGIN
  SELECT version.print_layout INTO sealed_print_layout
  FROM app.project_site_versions version
  WHERE version.organization_id = NEW.organization_id
    AND version.project_id = NEW.project_id
    AND version.site_id = NEW.site_id
    AND version.id = NEW.site_version_id;
  IF NEW.manifest->>'schemaVersion' = 'opengeo.site-edition.1.3.0'
    AND NEW.manifest->'printLayout' IS DISTINCT FROM sealed_print_layout
  THEN
    RAISE EXCEPTION 'project site edition print layout seal mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(sealed_print_layout->'pages') layout_page
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(NEW.manifest->'pages') = 'array'
          THEN NEW.manifest->'pages' ELSE '[]'::jsonb END
      ) manifest_page
      WHERE manifest_page->>'slug' = layout_page->>'sitePageSlug'
    )
  ) THEN
    RAISE EXCEPTION 'project site edition print layout page seal mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(sealed_print_layout->'pages') layout_page
    CROSS JOIN LATERAL jsonb_array_elements(layout_page->'elements') element
    WHERE element->>'type' = 'map_frame'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(NEW.manifest->'references') = 'array'
            THEN NEW.manifest->'references' ELSE '[]'::jsonb END
        ) manifest_reference
        WHERE manifest_reference->>'resourceId' = element->>'resourceId'
          AND manifest_reference->>'kind' = 'map'
          AND jsonb_typeof(manifest_reference->'snapshot') = 'object'
      )
  ) THEN
    RAISE EXCEPTION 'project site edition print layout snapshot seal mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_site_editions_print_layout_seal
BEFORE INSERT ON app.project_site_editions
FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_print_layout_seal();

REVOKE EXECUTE ON FUNCTION app.project_site_print_layout_valid(jsonb)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.project_site_print_layout_valid(jsonb)
TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION app.enforce_project_site_print_layout_seal()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON COLUMN app.project_site_versions.print_layout IS
  'Immutable positioned print layout using a bounded 1000 by 1000 top-left coordinate space.';

COMMENT ON FUNCTION app.project_site_print_layout_valid(jsonb) IS
  'Validates bounded multi-frame print pages without remote dependencies or executable content.';

COMMIT;
