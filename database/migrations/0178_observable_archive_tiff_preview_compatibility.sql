BEGIN;

-- Forward correction for instances with 0160 but no referenced-file migrations.
-- Preserve the 0165/0177 path and all existing completion authority and bounds;
-- allow only an exact already-admitted TIFF in request1/source2 private previews.
DO $$
DECLARE
  definition text;
  previous_predicate text := $predicate$(v_job.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' OR v_manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0') AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$predicate$;
  corrected_predicate text := $predicate$((v_job.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' OR v_manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0') OR (v_job.request->>'schemaVersion'='opengeo.observable-build-request.1.0.0' AND v_job.purpose='preview' AND v_manifest->>'schemaVersion'='opengeo.observable-source-revision.2.0.0')) AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$predicate$;
  legacy_predicate text := $predicate$(v_file->>'contentType') NOT IN (
        'text/html', 'text/css', 'text/javascript', 'application/json',
        'text/plain', 'text/csv', 'application/geo+json',
        'image/svg+xml', 'image/png', 'image/jpeg',
        'application/octet-stream', 'application/zip'
      )$predicate$;
  legacy_suffix text := $predicate$
      OR (v_file->>'sizeBytes')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes$predicate$;
  preview_predicate text := $predicate$v_job.request->>'schemaVersion'='opengeo.observable-build-request.1.0.0' AND v_job.purpose='preview' AND v_manifest->>'schemaVersion'='opengeo.observable-source-revision.2.0.0' AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$predicate$;
  legacy_anchor text;
  legacy_corrected text;
  previous_count integer;
  corrected_count integer;
  legacy_count integer;
  legacy_corrected_count integer;
BEGIN
  definition := pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
  legacy_anchor := legacy_predicate || legacy_suffix;
  legacy_corrected := legacy_predicate || ' AND NOT (' || preview_predicate || ')' || legacy_suffix;
  previous_count := (length(definition) - length(replace(definition, previous_predicate, ''))) / length(previous_predicate);
  corrected_count := (length(definition) - length(replace(definition, corrected_predicate, ''))) / length(corrected_predicate);
  legacy_count := (length(definition) - length(replace(definition, legacy_anchor, ''))) / length(legacy_anchor);
  legacy_corrected_count := (length(definition) - length(replace(definition, legacy_corrected, ''))) / length(legacy_corrected);
  IF previous_count = 1 AND corrected_count = 0 AND legacy_count = 0 AND legacy_corrected_count = 0 THEN
    -- pg_get_functiondef retains CREATE OR REPLACE and the existing security
    -- configuration. Replacing this signature preserves its owner and grants.
    definition := replace(definition, previous_predicate, corrected_predicate);
  ELSIF previous_count = 0 AND corrected_count = 0 AND legacy_count = 1 AND legacy_corrected_count = 0 THEN
    -- Production may retain 0160 without the later referenced-file features.
    -- Preserve its complete output bounds and non-preview rejection behavior.
    definition := replace(definition, legacy_anchor, legacy_corrected);
  ELSIF NOT (previous_count = 0 AND corrected_count = 1 AND legacy_count = 0 AND legacy_corrected_count = 0)
    AND NOT (previous_count = 0 AND corrected_count = 0 AND legacy_count = 0 AND legacy_corrected_count = 1) THEN
    RAISE EXCEPTION 'Unexpected Observable exact TIFF completion guard';
  END IF;

  IF to_regprocedure('app.observable_exact_archive_output(jsonb,jsonb)') IS NULL THEN
    -- Identical to 0165; do not install its adjacent reference/distribution work.
    -- Existing helper definitions and grants remain untouched.
    EXECUTE $create$
      CREATE FUNCTION app.observable_exact_archive_output(p_manifest jsonb,p_file jsonb)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $helper$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_manifest->'dataAttachments','[]'::jsonb)||coalesce(p_manifest->'referencedFiles','[]'::jsonb)) pin
  WHERE pin->>'checksumSha256'=p_file->>'checksumSha256' AND pin->>'sizeBytes'=p_file->>'sizeBytes'
   AND lower(substring(pin->>'path' FROM '\.[^.\/]+$'))=lower(substring(p_file->>'path' FROM '\.[^.\/]+$'))
   AND (p_file->>'sizeBytes')::bigint BETWEEN 1 AND 67108864);
$helper$
    $create$;
    REVOKE ALL ON FUNCTION app.observable_exact_archive_output(jsonb,jsonb)
      FROM PUBLIC,opengeo_worker,opengeo_connector;
    GRANT EXECUTE ON FUNCTION app.observable_exact_archive_output(jsonb,jsonb) TO opengeo_runtime;
  END IF;
  EXECUTE definition;
END;
$$;

COMMIT;
