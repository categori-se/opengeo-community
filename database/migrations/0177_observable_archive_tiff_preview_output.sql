BEGIN;

-- A private preview may retain the exact TIFF already admitted from Catalog.
-- Keep the completion function, owner, ACLs, lease/access checks and size bounds;
-- extend only the existing exact-output exception for request1/source2 previews.
DO $$
DECLARE
  definition text;
  previous_predicate text := $predicate$(v_job.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' OR v_manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0') AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$predicate$;
  corrected_predicate text := $predicate$((v_job.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' OR v_manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0') OR (v_job.request->>'schemaVersion'='opengeo.observable-build-request.1.0.0' AND v_job.purpose='preview' AND v_manifest->>'schemaVersion'='opengeo.observable-source-revision.2.0.0')) AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$predicate$;
  previous_count integer;
  corrected_count integer;
BEGIN
  definition := pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
  previous_count := (length(definition) - length(replace(definition, previous_predicate, ''))) / length(previous_predicate);
  corrected_count := (length(definition) - length(replace(definition, corrected_predicate, ''))) / length(corrected_predicate);
  IF previous_count = 1 AND corrected_count = 0 THEN
    -- pg_get_functiondef retains CREATE OR REPLACE and the existing security
    -- configuration. Replacing this signature preserves its owner and grants.
    EXECUTE replace(definition, previous_predicate, corrected_predicate);
  ELSIF previous_count <> 0 OR corrected_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected Observable exact TIFF completion guard';
  END IF;
END;
$$;

COMMIT;
