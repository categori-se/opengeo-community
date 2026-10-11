BEGIN;

ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'arcgis';
ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS 'wfs';
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'arcgis';
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'wfs';

COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION app.claim_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, organization_id uuid, project_id uuid,
  source_dataset_id uuid, source_revision_number bigint, source_type text,
  source_url text, source_configuration jsonb, copy_method text,
  capture_scope jsonb, maximum_requests integer, maximum_output_bytes bigint,
  output_format text, output_content_type text, attribution text,
  destination_dataset_id uuid, destination_bucket text,
  output_object_key text, request_checksum_sha256 text, attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900
  THEN RAISE EXCEPTION 'invalid source snapshot claim'; END IF;
  SELECT job.*, estimate.copy_method, estimate.capture_scope,
         estimate.maximum_requests, estimate.maximum_output_bytes,
         estimate.output_format::text AS output_format,
         estimate.output_content_type,
         source.source_type::text AS source_type,
         revision.source_url, revision.configuration
  INTO v_job
  FROM app.external_source_snapshot_jobs job
  JOIN app.external_source_copy_estimates estimate
    ON estimate.organization_id = job.organization_id
   AND estimate.id = job.estimate_id
  JOIN app.external_sources source
    ON source.organization_id = job.organization_id
   AND source.dataset_id = job.source_dataset_id
  JOIN app.external_source_revisions revision
    ON revision.organization_id = job.organization_id
   AND revision.dataset_id = job.source_dataset_id
   AND revision.version_number = job.source_revision_number
  WHERE job.id = p_job_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::bigint, NULL::text, NULL::text, NULL::jsonb,
      NULL::text, NULL::jsonb, NULL::integer, NULL::bigint, NULL::text,
      NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text,
      NULL::integer;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.external_source_snapshot_jobs
    SET state = 'failed', error_code = 'retry_exhausted',
        worker_token = NULL, lease_expires_at = NULL,
        last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSE
    UPDATE app.external_source_snapshot_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now,
        attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id
    RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.organization_id,
    v_job.project_id, v_job.source_dataset_id, v_job.source_revision_number,
    v_job.source_type, v_job.source_url, v_job.configuration,
    v_job.copy_method, v_job.capture_scope, v_job.maximum_requests,
    v_job.maximum_output_bytes, v_job.output_format, v_job.output_content_type,
    v_job.attribution,
    v_job.destination_dataset_id, v_job.destination_bucket,
    format(
      'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
      v_job.organization_id, v_job.project_id, v_job.destination_dataset_id, v_job.id,
      CASE v_job.output_format
        WHEN 'png' THEN 'snapshot.png'
        WHEN 'geojson' THEN 'snapshot.geojson'
        ELSE 'source.pmtiles'
      END
    ), v_job.request_checksum_sha256, v_job.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job app.external_source_snapshot_jobs%ROWTYPE;
  v_estimate app.external_source_copy_estimates%ROWTYPE;
  v_object_id uuid;
  v_version_id uuid := gen_random_uuid();
  v_processing_job_id uuid := gen_random_uuid();
  v_expected_key text;
  v_filename text;
BEGIN
  SELECT * INTO v_job FROM app.external_source_snapshot_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
  SELECT * INTO v_estimate FROM app.external_source_copy_estimates
  WHERE organization_id = v_job.organization_id AND id = v_job.estimate_id;
  v_filename := CASE v_estimate.output_format::text
    WHEN 'png' THEN 'snapshot.png'
    WHEN 'geojson' THEN 'snapshot.geojson'
    ELSE 'source.pmtiles'
  END;
  v_expected_key := format(
    'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
    v_job.organization_id, v_job.project_id, v_job.destination_dataset_id,
    v_job.id, v_filename
  );
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192
    OR (p_artifact->>'role') <> 'original'
    OR (p_artifact->>'bucket') <> v_job.destination_bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'s3_version_id') IN ('', 'null')
    OR char_length(p_artifact->>'s3_version_id') > 1024
    OR (p_artifact->>'etag') !~ '^[A-Fa-f0-9]{16,128}$'
    OR (p_artifact->>'content_type') <> v_estimate.output_content_type
    OR (p_artifact->>'size_bytes')::bigint NOT BETWEEN 1 AND v_estimate.maximum_output_bytes
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid source snapshot artifact'; END IF;
  v_object_id := (p_artifact->>'id')::uuid;
  INSERT INTO app.data_objects
    (id, organization_id, dataset_id, role, bucket, object_key,
     s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
  VALUES
    (v_object_id, v_job.organization_id, v_job.destination_dataset_id,
     'original', p_artifact->>'bucket', p_artifact->>'object_key',
     p_artifact->>'s3_version_id', lower(p_artifact->>'etag'),
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', v_job.created_by);
  INSERT INTO app.upload_intents
    (id, organization_id, project_id, dataset_id, created_by,
     original_filename, content_type, expected_size_bytes, expected_sha256,
     bucket, object_key, state, expires_at, completed_at, completed_object_id)
  VALUES
    (v_job.id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_job.created_by, v_filename,
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', p_artifact->>'bucket',
     p_artifact->>'object_key', 'completed', clock_timestamp() + interval '1 day',
     clock_timestamp(), v_object_id);
  INSERT INTO app.dataset_versions
    (id, organization_id, dataset_id, version_number, parent_version_id,
     original_object_id, state, change_message, created_by)
  VALUES
    (v_version_id, v_job.organization_id, v_job.destination_dataset_id, 1, NULL,
     v_object_id, 'queued', 'Protected copy of external source revision',
     v_job.created_by);
  UPDATE app.datasets
  SET status = 'processing', current_version_id = v_version_id,
      updated_by = v_job.created_by
  WHERE organization_id = v_job.organization_id
    AND id = v_job.destination_dataset_id AND status = 'draft'
    AND current_version_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'source snapshot destination changed'; END IF;
  INSERT INTO app.processing_jobs
    (id, organization_id, project_id, dataset_id, dataset_version_id,
     job_type, parameters, created_by)
  VALUES
    (v_processing_job_id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_version_id, 'dataset.ingest',
     jsonb_build_object(
       'upload_id', v_job.id,
       'object_id', v_object_id,
       's3_version_id', p_artifact->>'s3_version_id',
       'source_snapshot_job_id', v_job.id
     ), v_job.created_by);
  INSERT INTO app.dataset_version_external_source_lineage
    (organization_id, destination_dataset_id, destination_dataset_version_id,
     source_dataset_id, source_revision_number, snapshot_job_id, retrieved_at)
  VALUES
    (v_job.organization_id, v_job.destination_dataset_id, v_version_id,
     v_job.source_dataset_id, v_job.source_revision_number, v_job.id,
     clock_timestamp());
  UPDATE app.external_source_snapshot_jobs
  SET state = 'completed', output_object_id = v_object_id,
      output_dataset_version_id = v_version_id, error_code = NULL,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.source.snapshot.completed', 'dataset', v_job.destination_dataset_id,
     'source-archiver:' || v_job.id::text,
     jsonb_build_object(
       'snapshot_job_id', v_job.id,
       'source_dataset_id', v_job.source_dataset_id,
       'source_revision_number', v_job.source_revision_number,
       'dataset_version_id', v_version_id,
       'processing_job_id', v_processing_job_id,
       'output_object_id', v_object_id,
       'checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.get_completed_external_source_snapshot_artifact(
  p_job_id uuid
)
RETURNS TABLE (
  snapshot_job_id uuid, bucket text, object_key text, s3_version_id text,
  etag text, content_type text, size_bytes bigint, checksum_sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'invalid completed source snapshot lookup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.external_source_snapshot_jobs job
    WHERE job.id = p_job_id AND job.state = 'completed'
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT job.id, object.bucket, object.object_key, object.s3_version_id,
         object.etag, object.content_type, object.size_bytes,
         object.checksum_sha256
  FROM app.external_source_snapshot_jobs job
  JOIN app.external_source_copy_estimates estimate
    ON estimate.organization_id = job.organization_id
   AND estimate.id = job.estimate_id
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.output_object_id
   AND object.dataset_id = job.destination_dataset_id
   AND object.role = 'original'
  WHERE job.id = p_job_id AND job.state = 'completed'
    AND object.bucket = job.destination_bucket
    AND object.object_key = format(
      'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
      job.organization_id, job.project_id, job.destination_dataset_id, job.id,
      CASE estimate.output_format::text
        WHEN 'png' THEN 'snapshot.png'
        WHEN 'geojson' THEN 'snapshot.geojson'
        ELSE 'source.pmtiles'
      END
    )
    AND object.content_type = estimate.output_content_type
    AND object.size_bytes BETWEEN 1 AND estimate.maximum_output_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completed source snapshot artifact is inconsistent';
  END IF;
END;
$$;

ALTER TABLE app.datasets DROP CONSTRAINT datasets_source_format_match;
ALTER TABLE app.datasets ADD CONSTRAINT datasets_source_format_match CHECK (
  (source_type = 'upload' AND format NOT IN ('xyz', 'wms', 'arcgis', 'wfs'))
  OR (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs')
      AND source_type::text = format::text)
);

ALTER TABLE app.external_sources DROP CONSTRAINT external_sources_supported_type;
ALTER TABLE app.external_sources ADD CONSTRAINT external_sources_supported_type
  CHECK (source_type IN ('xyz', 'wms', 'pmtiles', 'geojson', 'arcgis', 'wfs'));

ALTER TABLE app.external_source_copy_estimates
  DROP CONSTRAINT external_source_copy_estimates_method_known;
ALTER TABLE app.external_source_copy_estimates
  ADD CONSTRAINT external_source_copy_estimates_method_known CHECK (
    copy_method IN (
      'exact_object_copy',
      'bounded_map_capture',
      'bounded_tile_capture',
      'bounded_feature_capture'
    )
  );

ALTER TABLE app.external_source_copy_estimates
  DROP CONSTRAINT external_source_copy_estimates_output_known;
ALTER TABLE app.external_source_copy_estimates
  ADD CONSTRAINT external_source_copy_estimates_output_known CHECK (
    (copy_method = 'exact_object_copy' AND output_format = 'pmtiles'
      AND output_content_type = 'application/vnd.pmtiles')
    OR (copy_method = 'bounded_map_capture' AND output_format = 'png'
      AND output_content_type = 'image/png')
    OR (copy_method = 'bounded_tile_capture' AND output_format = 'pmtiles'
      AND output_content_type = 'application/vnd.pmtiles')
    OR (copy_method = 'bounded_feature_capture' AND output_format = 'geojson'
      AND output_content_type = 'application/geo+json')
  );

CREATE OR REPLACE FUNCTION app.enforce_external_source_dataset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dataset_source_type app.dataset_source_type;
  dataset_format app.dataset_format;
BEGIN
  SELECT source_type, format
  INTO dataset_source_type, dataset_format
  FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.dataset_id;

  IF dataset_source_type IS NULL
    OR dataset_source_type <> NEW.source_type
    OR dataset_format::text <> NEW.source_type::text
  THEN
    RAISE EXCEPTION
      'external source identity must match an XYZ, WMS, PMTiles, GeoJSON, ArcGIS, or WFS dataset';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_external_source_copy_estimate_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type text;
  v_source_format text;
  v_source_page_size integer;
  v_maximum_features integer;
  v_page_size integer;
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'source-copy estimate actor mismatch';
  END IF;
  IF COALESCE(
    app.effective_project_role(NEW.project_id, NEW.created_by)::text,
    ''
  ) NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'source-copy estimate requires project edit access';
  END IF;
  SELECT source.source_type::text,
         revision.configuration->>'format',
         CASE
           WHEN jsonb_typeof(revision.configuration->'page_size') = 'number'
           THEN (revision.configuration->>'page_size')::integer
           ELSE NULL
         END
    INTO v_source_type, v_source_format, v_source_page_size
  FROM app.external_sources source
  JOIN app.external_source_revisions revision
    ON revision.organization_id = source.organization_id
   AND revision.dataset_id = source.dataset_id
   AND revision.version_number = NEW.source_revision_number
  JOIN app.project_datasets project_dataset
    ON project_dataset.organization_id = source.organization_id
   AND project_dataset.dataset_id = source.dataset_id
   AND project_dataset.project_id = NEW.project_id
  WHERE source.organization_id = NEW.organization_id
    AND source.dataset_id = NEW.source_dataset_id;

  IF NEW.copy_method = 'bounded_feature_capture'
    AND jsonb_typeof(NEW.capture_scope->'maximum_features') = 'number'
    AND jsonb_typeof(NEW.capture_scope->'page_size') = 'number'
  THEN
    v_maximum_features := (NEW.capture_scope->>'maximum_features')::integer;
    v_page_size := (NEW.capture_scope->>'page_size')::integer;
  END IF;

  IF NOT FOUND OR NOT (
    (v_source_type = 'pmtiles' AND NEW.copy_method = 'exact_object_copy'
      AND NEW.capture_scope = '{"kind":"exact_object"}'::jsonb
      AND NEW.maximum_requests = 1 AND NEW.output_format = 'pmtiles')
    OR (v_source_type = 'wms' AND v_source_format = 'image/png'
      AND NEW.copy_method = 'bounded_map_capture'
      AND NEW.capture_scope->>'kind' = 'bounded_image'
      AND NEW.capture_scope - ARRAY['kind', 'bounds', 'width', 'height'] = '{}'::jsonb
      AND jsonb_typeof(NEW.capture_scope->'bounds') = 'array'
      AND jsonb_array_length(NEW.capture_scope->'bounds') = 4
      AND jsonb_typeof(NEW.capture_scope->'bounds'->0) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->1) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->2) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->3) = 'number'
      AND (NEW.capture_scope->'bounds'->>0)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        BETWEEN -85.0511287798066 AND 85.0511287798066
      AND (NEW.capture_scope->'bounds'->>2)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>3)::numeric
        BETWEEN -85.0511287798066 AND 85.0511287798066
      AND (NEW.capture_scope->'bounds'->>0)::numeric
        < (NEW.capture_scope->'bounds'->>2)::numeric
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        < (NEW.capture_scope->'bounds'->>3)::numeric
      AND jsonb_typeof(NEW.capture_scope->'width') = 'number'
      AND jsonb_typeof(NEW.capture_scope->'height') = 'number'
      AND (NEW.capture_scope->>'width')::integer BETWEEN 1 AND 4096
      AND (NEW.capture_scope->>'height')::integer BETWEEN 1 AND 4096
      AND (NEW.capture_scope->>'width')::bigint
        * (NEW.capture_scope->>'height')::bigint <= 16777216
      AND NEW.maximum_requests = 1
      AND NEW.maximum_output_bytes <= 134217728
      AND NEW.output_format = 'png')
    OR (v_source_type IN ('arcgis', 'wfs')
      AND NEW.copy_method = 'bounded_feature_capture'
      AND NEW.capture_scope->>'kind' = 'bounded_features'
      AND NEW.capture_scope
        - ARRAY['kind', 'bounds', 'maximum_features', 'page_size'] = '{}'::jsonb
      AND jsonb_typeof(NEW.capture_scope->'bounds') = 'array'
      AND jsonb_array_length(NEW.capture_scope->'bounds') = 4
      AND jsonb_typeof(NEW.capture_scope->'bounds'->0) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->1) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->2) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->3) = 'number'
      AND (NEW.capture_scope->'bounds'->>0)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>1)::numeric BETWEEN -90 AND 90
      AND (NEW.capture_scope->'bounds'->>2)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>3)::numeric BETWEEN -90 AND 90
      AND (NEW.capture_scope->'bounds'->>0)::numeric
        < (NEW.capture_scope->'bounds'->>2)::numeric
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        < (NEW.capture_scope->'bounds'->>3)::numeric
      AND jsonb_typeof(NEW.capture_scope->'maximum_features') = 'number'
      AND jsonb_typeof(NEW.capture_scope->'page_size') = 'number'
      AND (NEW.capture_scope->>'maximum_features')::numeric
        = trunc((NEW.capture_scope->>'maximum_features')::numeric)
      AND (NEW.capture_scope->>'page_size')::numeric
        = trunc((NEW.capture_scope->>'page_size')::numeric)
      AND v_maximum_features BETWEEN 1 AND 50000
      AND v_page_size BETWEEN 1 AND CASE
        WHEN v_source_type = 'arcgis' THEN 2000 ELSE 1000 END
      AND v_page_size <= v_source_page_size
      AND NEW.maximum_requests
        = ceil(v_maximum_features::numeric / v_page_size::numeric)::integer
      AND NEW.maximum_requests BETWEEN 1 AND 64
      AND NEW.maximum_output_bytes BETWEEN 1 AND 134217728
      AND NEW.output_format = 'geojson')
  ) THEN
    RAISE EXCEPTION 'source-copy estimate does not match the project source';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  app.enforce_external_source_dataset(),
  app.enforce_external_source_copy_estimate_insert()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_source_archiver;

COMMENT ON TYPE app.dataset_source_type IS
  'Dataset acquisition mode; ArcGIS and WFS identify one reviewed anonymous feature collection, while GeoJSON identifies an immutable browser-direct archive.';
COMMENT ON TABLE app.external_sources IS
  'Tenant-scoped identity for a reviewed anonymous XYZ, WMS, PMTiles, GeoJSON, ArcGIS, or WFS source.';
COMMENT ON TABLE app.external_source_copy_estimates IS
  'Short-lived immutable estimates for exact objects, bounded map images, bounded feature collections, or bounded tile derivatives.';

COMMIT;
