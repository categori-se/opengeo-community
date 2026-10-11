BEGIN;

-- TIFF is an immutable data attachment, not executable publication source.
-- Preserve the existing 64 MiB bound, access checks, exact pins and upload rules.
CREATE FUNCTION app.observable_archive_media_is_supported(p_path text, p_content_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_path ~* '\.tiff?$'
    THEN p_content_type IN ('image/tiff', 'image/geotiff')
    ELSE app.observable_source_media_is_supported(p_path, p_content_type)
  END
$$;
REVOKE ALL ON FUNCTION app.observable_archive_media_is_supported(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.observable_archive_media_is_supported(text, text) TO opengeo_runtime;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(
    'app.validate_observable_revision_data_bindings(uuid,uuid,uuid,jsonb)'::regprocedure
  ) INTO definition;
  IF position('\.(json|geojson|csv|txt|png|jpe?g)$' IN definition) = 0
    OR position('app.observable_source_media_is_supported(v_path, v_attachment.content_type)' IN definition) = 0
  THEN RAISE EXCEPTION 'Unexpected archive binding validator; review TIFF admission'; END IF;
  definition := replace(definition, '\.(json|geojson|csv|txt|png|jpe?g)$',
    '\.(json|geojson|csv|txt|png|jpe?g|tiff?)$');
  definition := replace(definition,
    'app.observable_source_media_is_supported(v_path, v_attachment.content_type)',
    'app.observable_archive_media_is_supported(v_path, v_attachment.content_type)');
  EXECUTE definition;
END;
$$;

COMMIT;
