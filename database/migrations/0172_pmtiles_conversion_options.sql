-- PMTiles v2 extension: depends on existing 0058/0059/0151/0169 only.
-- It does not activate or depend on held PostGIS migrations 0170/0171.
BEGIN;
ALTER TABLE app.pmtiles_derivative_jobs ADD COLUMN conversion_options jsonb;
ALTER TABLE app.pmtiles_derivative_jobs ADD COLUMN worker_image_digest text;

CREATE FUNCTION app.pmtiles_conversion_options_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE key text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR octet_length(value::text) > 16384
    OR (value - ARRAY['input_layer','extent','simplification','simplification_max_zoom',
      'buffer','max_size','max_features','attribute_names']) <> '{}'::jsonb
    OR NOT (value ?& ARRAY['input_layer','extent','simplification','simplification_max_zoom',
      'buffer','max_size','max_features','attribute_names']) THEN RETURN false; END IF;
  IF value->'input_layer' <> 'null'::jsonb AND (
    jsonb_typeof(value->'input_layer') IS DISTINCT FROM 'string'
    OR char_length(value->>'input_layer') NOT BETWEEN 1 AND 200
    OR value->>'input_layer' <> btrim(value->>'input_layer')
    OR value->>'input_layer' LIKE '-%' OR value->>'input_layer' ~ '[[:cntrl:]]'
  ) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['extent','buffer','max_size','max_features'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR value->>key !~ '^[0-9]+$'
    THEN RETURN false; END IF;
  END LOOP;
  IF (value->>'extent')::numeric NOT IN (2048,4096,8192)
    OR (value->>'buffer')::numeric NOT BETWEEN 0 AND 256
    OR (value->>'max_size')::numeric NOT BETWEEN 50000 AND 2000000
    OR (value->>'max_features')::numeric NOT BETWEEN 1000 AND 500000
  THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['simplification','simplification_max_zoom'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'number'
      OR (value->>key)::numeric NOT BETWEEN 0 AND 10 THEN RETURN false; END IF;
  END LOOP;
  IF value->'attribute_names' <> 'null'::jsonb THEN
    IF jsonb_typeof(value->'attribute_names') IS DISTINCT FROM 'array'
      OR jsonb_array_length(value->'attribute_names') NOT BETWEEN 1 AND 128
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'attribute_names') item
        WHERE jsonb_typeof(item) <> 'string' OR item #>> '{}' !~ '^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$')
      OR (SELECT count(DISTINCT item) FROM jsonb_array_elements(value->'attribute_names') item)
        <> jsonb_array_length(value->'attribute_names') THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE app.pmtiles_derivative_jobs ADD CONSTRAINT pmtiles_conversion_options_valid
  CHECK ((conversion_options IS NULL AND worker_image_digest IS NULL) OR
    (conversion_options IS NOT NULL AND app.pmtiles_conversion_options_valid(conversion_options)
    AND source_layer ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'
    AND worker_image_digest IS NOT NULL AND worker_image_digest ~ '^sha256:[0-9a-f]{64}$'));
CREATE FUNCTION app.enforce_pmtiles_conversion_options_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.conversion_options IS DISTINCT FROM OLD.conversion_options OR NEW.worker_image_digest IS DISTINCT FROM OLD.worker_image_digest
  THEN RAISE EXCEPTION 'PMTiles conversion options are immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pmtiles_conversion_options_immutable BEFORE UPDATE
  ON app.pmtiles_derivative_jobs FOR EACH ROW EXECUTE FUNCTION app.enforce_pmtiles_conversion_options_immutable();
ALTER TABLE app.dataset_version_derivative_lineage DROP CONSTRAINT dataset_version_derivative_lineage_recipe_known;
ALTER TABLE app.dataset_version_derivative_lineage ADD CONSTRAINT dataset_version_derivative_lineage_recipe_known
  CHECK (recipe IN ('gdal-pmtiles-v1','gdal-pmtiles-v2'));

ALTER FUNCTION app.claim_pmtiles_derivative(uuid,uuid,integer) RENAME TO claim_pmtiles_derivative_base;
REVOKE ALL ON FUNCTION app.claim_pmtiles_derivative_base(uuid,uuid,integer) FROM PUBLIC,opengeo_runtime,opengeo_worker;

CREATE FUNCTION app.claim_pmtiles_derivative(p_job_id uuid,p_worker_token uuid,p_lease_seconds integer)
RETURNS TABLE (claim_status text,
  job_id uuid,
  organization_id uuid,
  project_id uuid,
  dataset_id uuid,
  dataset_version_id uuid,
  source_object_id uuid,
  source_bucket text,
  source_object_key text,
  source_s3_version_id text,
  source_etag text,
  source_content_type text,
  source_size_bytes bigint,
  source_checksum_sha256 text,
  bounds jsonb,
  minimum_zoom smallint,
  maximum_zoom smallint,
  source_layer text,
  request_checksum_sha256 text,
  attempt_count integer,
  output_object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.pmtiles_derivative_jobs WHERE id=p_job_id AND conversion_options IS NULL) THEN
    RETURN QUERY SELECT 'not_ready'::text, p_job_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::jsonb, NULL::smallint, NULL::smallint, NULL::text, NULL::text, NULL::integer, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT base.* FROM app.claim_pmtiles_derivative_base(p_job_id,p_worker_token,p_lease_seconds) base;
END; $$;
REVOKE ALL ON FUNCTION app.claim_pmtiles_derivative(uuid,uuid,integer) FROM PUBLIC,opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.claim_pmtiles_derivative(uuid,uuid,integer) TO opengeo_worker;

CREATE FUNCTION app.claim_pmtiles_derivative_v2(p_job_id uuid,p_worker_token uuid,p_lease_seconds integer)
RETURNS TABLE (claim_status text,
  job_id uuid,
  organization_id uuid,
  project_id uuid,
  dataset_id uuid,
  dataset_version_id uuid,
  source_object_id uuid,
  source_bucket text,
  source_object_key text,
  source_s3_version_id text,
  source_etag text,
  source_content_type text,
  source_size_bytes bigint,
  source_checksum_sha256 text,
  bounds jsonb,
  minimum_zoom smallint,
  maximum_zoom smallint,
  source_layer text,
  request_checksum_sha256 text,
  attempt_count integer,
  output_object_key text,
  conversion_options jsonb,
  worker_image_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.pmtiles_derivative_jobs job WHERE job.id=p_job_id AND job.conversion_options IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_ready'::text, p_job_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::jsonb, NULL::smallint, NULL::smallint, NULL::text, NULL::text, NULL::integer, NULL::text, NULL::jsonb, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT base.*,job.conversion_options,job.worker_image_digest FROM app.claim_pmtiles_derivative_base(p_job_id,p_worker_token,p_lease_seconds) base JOIN app.pmtiles_derivative_jobs job ON job.id=base.job_id;
END; $$;
REVOKE ALL ON FUNCTION app.claim_pmtiles_derivative_v2(uuid,uuid,integer) FROM PUBLIC,opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.claim_pmtiles_derivative_v2(uuid,uuid,integer) TO opengeo_worker;

-- Retain the previous receipt predicate verbatim, including its historical
-- software pin, and add the separately versioned v2 execution facts.
DO $$ DECLARE expression text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT expression FROM pg_constraint
    WHERE conrelid='app.processing_execution_receipts'::regclass
      AND conname='processing_execution_receipt_software_bounded';
  expression := substring(expression FROM 8 FOR char_length(expression)-8);
  ALTER TABLE app.processing_execution_receipts DROP CONSTRAINT processing_execution_receipt_software_bounded;
  EXECUTE 'ALTER TABLE app.processing_execution_receipts ADD CONSTRAINT processing_execution_receipt_software_bounded CHECK (('
    || expression || ') OR (verification_status=''pinned'' AND job_kind=''pmtiles-derivative''
      AND tool_version=''1.1.0'' AND jsonb_typeof(software)=''object'' AND octet_length(software::text)<=8192
      AND software->>''gdal''=''3.13.1'' AND software->>''projNetwork''=''disabled''
      AND software->>''workerBaseImage''=''ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59''
      AND software->>''runtimeImageDigest'' ~ ''^sha256:[0-9a-f]{64}$''
      AND software->>''versionOutput'' ~ ''^GDAL 3[.]13[.]1([ ,]|$)''))';
END; $$;

CREATE FUNCTION app.complete_pmtiles_derivative_with_options(
  p_job_id uuid,p_worker_token uuid,p_artifact jsonb,p_validation jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE v_job app.pmtiles_derivative_jobs%ROWTYPE; v_software jsonb; v_logs jsonb;
BEGIN
  SELECT * INTO v_job FROM app.pmtiles_derivative_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_job.conversion_options IS NULL THEN
    RETURN app.complete_pmtiles_derivative(p_job_id,p_worker_token,p_artifact);
  END IF;
  v_software := p_validation->'software';
  IF p_validation->'options' IS DISTINCT FROM v_job.conversion_options
    OR p_validation->>'recipe' IS DISTINCT FROM 'gdal-pmtiles-v2'
    OR jsonb_typeof(v_software) IS DISTINCT FROM 'object'
    OR (v_software - ARRAY['gdal','workerBaseImage','projNetwork','versionOutput','runtimeImageDigest']) <> '{}'::jsonb
    OR v_software->>'runtimeImageDigest' IS DISTINCT FROM v_job.worker_image_digest
    OR v_software->>'gdal' IS DISTINCT FROM '3.13.1'
    OR v_software->>'workerBaseImage' IS DISTINCT FROM 'ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59'
    OR v_software->>'projNetwork' IS DISTINCT FROM 'disabled'
    OR char_length(COALESCE(v_software->>'versionOutput','')) NOT BETWEEN 1 AND 512
    OR v_software->>'versionOutput' !~ '^GDAL 3[.]13[.]1([ ,]|$)'
    OR p_validation->'losses'->>'adaptive_tile_limits' IS DISTINCT FROM 'Tile byte and feature limits may reduce precision or omit display features; source data remains preserved.'
    OR p_validation->'losses'->'attribute_selection' IS DISTINCT FROM v_job.conversion_options->'attribute_names'
    OR char_length(COALESCE(p_validation->>'input_layer','')) NOT BETWEEN 1 AND 200
    OR p_validation->>'input_layer' ~ '[[:cntrl:]]'
    OR p_validation->>'input_layer' LIKE '-%'
    OR (v_job.conversion_options->'input_layer' <> 'null'::jsonb
      AND p_validation->'input_layer' IS DISTINCT FROM v_job.conversion_options->'input_layer')
  THEN RAISE EXCEPTION 'invalid PMTiles v2 execution facts'; END IF;
  IF NOT app.complete_pmtiles_derivative_without_execution_receipt(p_job_id,p_worker_token,p_artifact)
    THEN RETURN false; END IF;
  SELECT * INTO STRICT v_job FROM app.pmtiles_derivative_jobs WHERE id=p_job_id;
  v_logs := jsonb_build_array('Immutable v2 request, selected options and source seals matched.',
    'Network-disabled GDAL3.13.1 PMTiles output validated; adaptive limits may simplify or omit display features.',
    'Output object and versioned derivative lineage committed atomically.');
  INSERT INTO app.processing_execution_receipts(organization_id,project_id,job_kind,pmtiles_job_id,
    tool_id,tool_version,request_checksum_sha256,source_object_id,output_object_id,output_checksum_sha256,
    software,logs,verification_status,receipt_checksum_sha256,initiated_by,recorded_at)
  VALUES(v_job.organization_id,v_job.project_id,'pmtiles-derivative',v_job.id,'vector-to-pmtiles','1.1.0',
    v_job.request_checksum_sha256,v_job.source_object_id,v_job.output_object_id,v_job.output_checksum_sha256,
    v_software,v_logs,'pinned',app.processing_execution_receipt_checksum('pmtiles-derivative',NULL,v_job.id,
      'vector-to-pmtiles','1.1.0',v_job.request_checksum_sha256,v_job.source_object_id,v_job.output_object_id,
      v_job.output_checksum_sha256,v_software,v_logs,'pinned'),v_job.created_by,v_job.finished_at);
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION app.complete_pmtiles_derivative_with_options(uuid,uuid,jsonb,jsonb) FROM PUBLIC,opengeo_runtime,opengeo_worker;

-- Replace exact clauses while retaining existing owners, grants, authorization,
-- lease checks and all unchanged v1 completion and admission behavior.
DO $$ DECLARE original text; updated text;
BEGIN
  original := pg_get_functiondef('app.complete_pmtiles_derivative_without_execution_receipt(uuid,uuid,jsonb)'::regprocedure);
  updated := replace(original, 'v_job.id, ''gdal-pmtiles-v1'');',
    'v_job.id, CASE WHEN v_job.conversion_options IS NULL THEN ''gdal-pmtiles-v1'' ELSE ''gdal-pmtiles-v2'' END);');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles lineage recipe clause changed'; END IF;
  EXECUTE updated;

  original := pg_get_functiondef('app.complete_pmtiles_derivative(uuid,uuid,jsonb)'::regprocedure);
  updated := replace(original, E'BEGIN\n  v_completed :=', E'BEGIN\n  IF EXISTS(SELECT 1 FROM app.pmtiles_derivative_jobs WHERE id=p_job_id AND conversion_options IS NOT NULL) THEN RAISE EXCEPTION ''PMTiles v2 requires validated completion''; END IF;\n  v_completed :=');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles legacy completion clause changed'; END IF;
  EXECUTE updated;

  original := pg_get_functiondef('app.complete_pmtiles_derivative(uuid,uuid,jsonb,jsonb)'::regprocedure);
  updated := replace(original, 'app.complete_pmtiles_derivative(p_job_id, p_worker_token, p_artifact)',
    'app.complete_pmtiles_derivative_with_options(p_job_id, p_worker_token, p_artifact, p_validation)');
  updated := replace(updated, '''losses'',''block_sha256'',''block_index_artifact'']',
    '''losses'',''block_sha256'',''block_index_artifact'',''options'',''software'',''input_layer'']');
  updated := replace(updated, 'p_validation->>''recipe'' IS DISTINCT FROM ''gdal-pmtiles-v1''',
    'p_validation->>''recipe'' IS DISTINCT FROM (CASE WHEN v_job.conversion_options IS NULL THEN ''gdal-pmtiles-v1'' ELSE ''gdal-pmtiles-v2'' END) OR (v_job.conversion_options IS NULL AND p_validation ?| ARRAY[''options'',''software'',''input_layer''])');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles validation clauses changed'; END IF;
  EXECUTE updated;

  original := pg_get_functiondef('app.admit_pmtiles_derivative_display(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean)'::regprocedure);
  updated := replace(original, 'lineage.recipe = ''gdal-pmtiles-v1''',
    'lineage.recipe = CASE WHEN v_job.conversion_options IS NULL THEN ''gdal-pmtiles-v1'' ELSE ''gdal-pmtiles-v2'' END');
  updated := replace(updated, '''recipe'', ''gdal-pmtiles-v1''',
    '''recipe'', CASE WHEN v_job.conversion_options IS NULL THEN ''gdal-pmtiles-v1'' ELSE ''gdal-pmtiles-v2'' END');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles admission recipe clauses changed'; END IF;
  EXECUTE updated;
END; $$;

CREATE FUNCTION app.worker_runtime_unfinished_pmtiles_v2()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
  SELECT jsonb_build_object('pmtiles',count(*)) FROM app.pmtiles_derivative_jobs
    WHERE conversion_options IS NOT NULL AND state IN ('queued','running');
$$;
REVOKE ALL ON FUNCTION app.worker_runtime_unfinished_pmtiles_v2() FROM PUBLIC,opengeo_runtime,opengeo_connector,opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.worker_runtime_unfinished_pmtiles_v2() TO opengeo_worker;

-- Admission never enables, reserves or resets the operator's controller ledger.
-- The API locks this same singleton immediately before one new v2 job INSERT,
-- after returning any matching committed job. Controller claims take this lock too.
CREATE FUNCTION app.pmtiles_v2_admission(
  p_worker_image_digest text,p_queue_url text,p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE control app.worker_runtime_control%ROWTYPE; config jsonb;
  key text; seconds integer; cleanup integer; daily_limit integer; total_limit integer;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_worker_image_digest IS NULL OR p_worker_image_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_queue_url IS NULL OR p_queue_url !~ '^https://sqs[.][a-z0-9-]+[.]amazonaws[.]com/[0-9]{12}/[A-Za-z0-9_-]{1,80}$'
    OR p_lock IS NULL
  THEN RETURN jsonb_build_object('ready',false,'reason','runtime_not_configured'); END IF;
  IF p_lock THEN
    SELECT * INTO control FROM app.worker_runtime_control WHERE singleton FOR UPDATE;
  ELSE
    SELECT * INTO control FROM app.worker_runtime_control WHERE singleton;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'reason','runtime_not_ready'); END IF;
  config := control.configuration;
  IF config->'enabled' IS DISTINCT FROM 'true'::jsonb
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_disabled'); END IF;
  IF config->'pmtilesV2Ready' IS DISTINCT FROM 'true'::jsonb
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_not_ready'); END IF;
  IF config->>'pmtilesWorkerImageDigest' IS DISTINCT FROM p_worker_image_digest
    OR config->>'pmtilesQueueUrl' IS DISTINCT FROM p_queue_url
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_binding_changed'); END IF;
  IF control.window_state IS NOT NULL
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_window_active'); END IF;
  FOREACH key IN ARRAY ARRAY['windowSeconds','cleanupSeconds','dailyWindows','totalWindows'] LOOP
    IF jsonb_typeof(config->key) IS DISTINCT FROM 'number'
      OR COALESCE(config->>key,'') !~ '^[0-9]{1,4}$'
      THEN RETURN jsonb_build_object('ready',false,'reason','runtime_limits_invalid'); END IF;
  END LOOP;
  seconds := (config->>'windowSeconds')::integer;
  cleanup := (config->>'cleanupSeconds')::integer;
  daily_limit := (config->>'dailyWindows')::integer;
  total_limit := (config->>'totalWindows')::integer;
  IF seconds NOT BETWEEN 300 AND 3600 OR cleanup NOT BETWEEN 300 AND 1800
    OR daily_limit NOT BETWEEN 1 AND 8 OR total_limit NOT BETWEEN 1 AND 1000
    OR COALESCE(config->>'scopeHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(config->>'endpointHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(config->>'workerHash','') !~ '^[0-9a-f]{64}$'
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_limits_invalid'); END IF;
  IF control.total_windows >= total_limit
    OR (control.budget_day=today AND control.starts_today>=daily_limit)
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_budget_exhausted'); END IF;
  IF EXISTS(SELECT 1 FROM app.pmtiles_derivative_jobs
    WHERE conversion_options IS NOT NULL AND state IN ('queued','running'))
    THEN RETURN jsonb_build_object('ready',false,'reason','runtime_job_pending'); END IF;
  RETURN jsonb_build_object('ready',true,'reason','ready');
END; $$;
REVOKE ALL ON FUNCTION app.pmtiles_v2_admission(text,text,boolean)
  FROM PUBLIC,opengeo_worker,opengeo_connector,opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.pmtiles_v2_admission(text,text,boolean) TO opengeo_runtime;
COMMENT ON FUNCTION app.pmtiles_v2_admission(text,text,boolean) IS
  'One new v2 job per fresh operator-ready window. pmtilesV2Ready is asserted only after exact singleton/triggers binding, and revoked before disable/rebind. Read or lock only: counters and configuration are never changed.';
COMMENT ON COLUMN app.pmtiles_derivative_jobs.conversion_options IS
  'Immutable normalized closed GDAL-v2 options; SQL NULL retains the original1.0/v1 request, checksum, lane and completion behavior.';
COMMIT;
