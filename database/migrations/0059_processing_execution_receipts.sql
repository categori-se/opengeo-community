BEGIN;

CREATE FUNCTION app.processing_receipt_logs_valid(p_logs jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(p_logs) = 'array'
    AND jsonb_array_length(p_logs) BETWEEN 1 AND 20
    AND octet_length(p_logs::text) <= 8192
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_logs) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
        OR char_length(item.value #>> '{}') NOT BETWEEN 1 AND 240
        OR (item.value #>> '{}') ~ '[[:cntrl:]]'
    )
$$;

CREATE FUNCTION app.processing_execution_receipt_checksum(
  p_job_kind text,
  p_coverage_job_id uuid,
  p_pmtiles_job_id uuid,
  p_tool_id text,
  p_tool_version text,
  p_request_checksum_sha256 text,
  p_source_object_id uuid,
  p_output_object_id uuid,
  p_output_checksum_sha256 text,
  p_software jsonb,
  p_logs jsonb,
  p_verification_status text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'jobKind', p_job_kind,
          'coverageJobId', p_coverage_job_id,
          'pmtilesJobId', p_pmtiles_job_id,
          'toolId', p_tool_id,
          'toolVersion', p_tool_version,
          'requestChecksumSha256', p_request_checksum_sha256,
          'sourceObjectId', p_source_object_id,
          'outputObjectId', p_output_object_id,
          'outputChecksumSha256', p_output_checksum_sha256,
          'software', p_software,
          'logs', p_logs,
          'verificationStatus', p_verification_status
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE TABLE app.processing_execution_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  job_kind text NOT NULL,
  coverage_job_id uuid,
  pmtiles_job_id uuid,
  tool_id text NOT NULL,
  tool_version text NOT NULL,
  request_checksum_sha256 text NOT NULL,
  source_object_id uuid NOT NULL,
  output_object_id uuid NOT NULL,
  output_checksum_sha256 text NOT NULL,
  software jsonb NOT NULL,
  logs jsonb NOT NULL,
  verification_status text NOT NULL,
  receipt_checksum_sha256 text NOT NULL,
  initiated_by uuid NOT NULL REFERENCES app.users(id),
  recorded_at timestamptz NOT NULL,
  UNIQUE (organization_id, coverage_job_id),
  UNIQUE (organization_id, pmtiles_job_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, coverage_job_id)
    REFERENCES app.spatial_coverage_derivative_jobs (organization_id, id),
  FOREIGN KEY (organization_id, pmtiles_job_id)
    REFERENCES app.pmtiles_derivative_jobs (organization_id, id),
  FOREIGN KEY (organization_id, source_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id),
  CONSTRAINT processing_execution_receipt_job_shape CHECK (
    (job_kind = 'coverage-derivative'
      AND coverage_job_id IS NOT NULL AND pmtiles_job_id IS NULL
      AND tool_id = 'raster-to-cog')
    OR (job_kind = 'pmtiles-derivative'
      AND coverage_job_id IS NULL AND pmtiles_job_id IS NOT NULL
      AND tool_id = 'vector-to-pmtiles')
  ),
  CONSTRAINT processing_execution_receipt_version_bounded CHECK (
    tool_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND char_length(tool_version) <= 40
  ),
  CONSTRAINT processing_execution_receipt_checksums_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND output_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND receipt_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT processing_execution_receipt_software_bounded CHECK (
    jsonb_typeof(software) = 'object'
    AND octet_length(software::text) <= 8192
    AND (
      (verification_status = 'pinned'
        AND software->>'workerBaseImage' =
          'ghcr.io/osgeo/gdal:ubuntu-full-3.13.0@sha256:83d114a6891ae18aa175d81a14c92a96d23944667b36fde9c15c4a10215d8939'
        AND software->>'gdal' = '3.13.0'
        AND software->>'projNetwork' = 'disabled'
        AND (job_kind <> 'pmtiles-derivative' OR software->>'tippecanoe' = '2.79.0'))
      OR (verification_status = 'legacy-unverified'
        AND software->>'verification' = 'legacy-unverified')
    )
  ),
  CONSTRAINT processing_execution_receipt_logs_valid CHECK (
    app.processing_receipt_logs_valid(logs)
  ),
  CONSTRAINT processing_execution_receipt_checksum_matches CHECK (
    receipt_checksum_sha256 = app.processing_execution_receipt_checksum(
      job_kind, coverage_job_id, pmtiles_job_id, tool_id, tool_version,
      request_checksum_sha256, source_object_id, output_object_id,
      output_checksum_sha256, software, logs, verification_status
    )
  )
);

CREATE INDEX processing_execution_receipts_project_idx
  ON app.processing_execution_receipts
    (organization_id, project_id, recorded_at DESC, id);

CREATE FUNCTION app.reject_processing_execution_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'processing execution receipts are immutable';
END;
$$;

CREATE TRIGGER processing_execution_receipts_reject_update
  BEFORE UPDATE OR DELETE ON app.processing_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION app.reject_processing_execution_receipt_mutation();

WITH candidates AS (
  SELECT
    job.organization_id,
    job.project_id,
    job.id AS coverage_job_id,
    job.request_checksum_sha256,
    coverage.data_object_id AS source_object_id,
    job.output_object_id,
    job.output_checksum_sha256,
    '{"verification":"legacy-unverified"}'::jsonb AS software,
    '["Completed before durable execution receipts were introduced."]'::jsonb AS logs,
    job.created_by,
    job.finished_at
  FROM app.spatial_coverage_derivative_jobs job
  JOIN app.spatial_service_coverages coverage
    ON coverage.organization_id = job.organization_id
   AND coverage.id = job.coverage_id
  WHERE job.state = 'completed'
)
INSERT INTO app.processing_execution_receipts
  (organization_id, project_id, job_kind, coverage_job_id, tool_id,
   tool_version, request_checksum_sha256, source_object_id, output_object_id,
   output_checksum_sha256, software, logs, verification_status,
   receipt_checksum_sha256, initiated_by, recorded_at)
SELECT
  organization_id, project_id, 'coverage-derivative', coverage_job_id,
  'raster-to-cog', '1.0.0', request_checksum_sha256, source_object_id,
  output_object_id, output_checksum_sha256, software, logs,
  'legacy-unverified',
  app.processing_execution_receipt_checksum(
    'coverage-derivative', coverage_job_id, NULL, 'raster-to-cog', '1.0.0',
    request_checksum_sha256, source_object_id, output_object_id,
    output_checksum_sha256, software, logs, 'legacy-unverified'
  ),
  created_by, finished_at
FROM candidates;

WITH candidates AS (
  SELECT
    job.organization_id,
    job.project_id,
    job.id AS pmtiles_job_id,
    job.request_checksum_sha256,
    job.source_object_id,
    job.output_object_id,
    job.output_checksum_sha256,
    '{"verification":"legacy-unverified"}'::jsonb AS software,
    '["Completed before durable execution receipts were introduced."]'::jsonb AS logs,
    job.created_by,
    job.finished_at
  FROM app.pmtiles_derivative_jobs job
  WHERE job.state = 'completed'
)
INSERT INTO app.processing_execution_receipts
  (organization_id, project_id, job_kind, pmtiles_job_id, tool_id,
   tool_version, request_checksum_sha256, source_object_id, output_object_id,
   output_checksum_sha256, software, logs, verification_status,
   receipt_checksum_sha256, initiated_by, recorded_at)
SELECT
  organization_id, project_id, 'pmtiles-derivative', pmtiles_job_id,
  'vector-to-pmtiles', '1.0.0', request_checksum_sha256, source_object_id,
  output_object_id, output_checksum_sha256, software, logs,
  'legacy-unverified',
  app.processing_execution_receipt_checksum(
    'pmtiles-derivative', NULL, pmtiles_job_id, 'vector-to-pmtiles', '1.0.0',
    request_checksum_sha256, source_object_id, output_object_id,
    output_checksum_sha256, software, logs, 'legacy-unverified'
  ),
  created_by, finished_at
FROM candidates;

ALTER FUNCTION app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb)
  RENAME TO complete_spatial_coverage_derivative_without_execution_receipt;

REVOKE ALL ON FUNCTION
  app.complete_spatial_coverage_derivative_without_execution_receipt(
    uuid, uuid, jsonb, jsonb
  )
  FROM PUBLIC, opengeo_runtime, opengeo_worker;

CREATE FUNCTION app.complete_spatial_coverage_derivative(
  p_job_id uuid,
  p_worker_token uuid,
  p_artifact jsonb,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_completed boolean;
  v_job record;
  v_software jsonb := jsonb_build_object(
    'workerBaseImage',
    'ghcr.io/osgeo/gdal:ubuntu-full-3.13.0@sha256:83d114a6891ae18aa175d81a14c92a96d23944667b36fde9c15c4a10215d8939',
    'gdal', '3.13.0',
    'projNetwork', 'disabled'
  );
  v_logs jsonb := jsonb_build_array(
    'Immutable request and source seals matched.',
    'Network-disabled GDAL output metadata and checksum validated.',
    'Output object and derivative result committed atomically.'
  );
BEGIN
  v_completed := app.complete_spatial_coverage_derivative_without_execution_receipt(
    p_job_id, p_worker_token, p_artifact, p_metadata
  );
  IF NOT v_completed THEN RETURN false; END IF;

  SELECT
    job.organization_id, job.project_id, job.id,
    job.request_checksum_sha256, coverage.data_object_id AS source_object_id,
    job.output_object_id, job.output_checksum_sha256, job.created_by,
    job.finished_at
  INTO v_job
  FROM app.spatial_coverage_derivative_jobs job
  JOIN app.spatial_service_coverages coverage
    ON coverage.organization_id = job.organization_id
   AND coverage.id = job.coverage_id
  WHERE job.id = p_job_id AND job.state = 'completed';

  INSERT INTO app.processing_execution_receipts
    (organization_id, project_id, job_kind, coverage_job_id, tool_id,
     tool_version, request_checksum_sha256, source_object_id, output_object_id,
     output_checksum_sha256, software, logs, verification_status,
     receipt_checksum_sha256, initiated_by, recorded_at)
  VALUES
    (v_job.organization_id, v_job.project_id, 'coverage-derivative', v_job.id,
     'raster-to-cog', '1.0.0', v_job.request_checksum_sha256,
     v_job.source_object_id, v_job.output_object_id,
     v_job.output_checksum_sha256, v_software, v_logs, 'pinned',
     app.processing_execution_receipt_checksum(
       'coverage-derivative', v_job.id, NULL, 'raster-to-cog', '1.0.0',
       v_job.request_checksum_sha256, v_job.source_object_id,
       v_job.output_object_id, v_job.output_checksum_sha256,
       v_software, v_logs, 'pinned'
     ),
     v_job.created_by, v_job.finished_at);
  RETURN true;
END;
$$;

ALTER FUNCTION app.complete_pmtiles_derivative(uuid, uuid, jsonb)
  RENAME TO complete_pmtiles_derivative_without_execution_receipt;

REVOKE ALL ON FUNCTION
  app.complete_pmtiles_derivative_without_execution_receipt(uuid, uuid, jsonb)
  FROM PUBLIC, opengeo_runtime, opengeo_worker;

CREATE FUNCTION app.complete_pmtiles_derivative(
  p_job_id uuid,
  p_worker_token uuid,
  p_artifact jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_completed boolean;
  v_job app.pmtiles_derivative_jobs%ROWTYPE;
  v_software jsonb := jsonb_build_object(
    'workerBaseImage',
    'ghcr.io/osgeo/gdal:ubuntu-full-3.13.0@sha256:83d114a6891ae18aa175d81a14c92a96d23944667b36fde9c15c4a10215d8939',
    'gdal', '3.13.0',
    'tippecanoe', '2.79.0',
    'projNetwork', 'disabled'
  );
  v_logs jsonb := jsonb_build_array(
    'Immutable request and source seals matched.',
    'Network-disabled GDAL and Tippecanoe PMTiles output validated.',
    'Output object and derivative lineage committed atomically.'
  );
BEGIN
  v_completed := app.complete_pmtiles_derivative_without_execution_receipt(
    p_job_id, p_worker_token, p_artifact
  );
  IF NOT v_completed THEN RETURN false; END IF;

  SELECT * INTO v_job
  FROM app.pmtiles_derivative_jobs
  WHERE id = p_job_id AND state = 'completed';

  INSERT INTO app.processing_execution_receipts
    (organization_id, project_id, job_kind, pmtiles_job_id, tool_id,
     tool_version, request_checksum_sha256, source_object_id, output_object_id,
     output_checksum_sha256, software, logs, verification_status,
     receipt_checksum_sha256, initiated_by, recorded_at)
  VALUES
    (v_job.organization_id, v_job.project_id, 'pmtiles-derivative', v_job.id,
     'vector-to-pmtiles', '1.0.0', v_job.request_checksum_sha256,
     v_job.source_object_id, v_job.output_object_id,
     v_job.output_checksum_sha256, v_software, v_logs, 'pinned',
     app.processing_execution_receipt_checksum(
       'pmtiles-derivative', NULL, v_job.id, 'vector-to-pmtiles', '1.0.0',
       v_job.request_checksum_sha256, v_job.source_object_id,
       v_job.output_object_id, v_job.output_checksum_sha256,
       v_software, v_logs, 'pinned'
     ),
     v_job.created_by, v_job.finished_at);
  RETURN true;
END;
$$;

ALTER TABLE app.processing_execution_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.processing_execution_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY processing_execution_receipts_tenant_isolation
  ON app.processing_execution_receipts
  USING (organization_id = app.current_organization_id());

GRANT SELECT ON app.processing_execution_receipts TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.processing_execution_receipts
  FROM opengeo_runtime, opengeo_worker;

REVOKE ALL ON FUNCTION
  app.processing_receipt_logs_valid(jsonb),
  app.processing_execution_receipt_checksum(
    text, uuid, uuid, text, text, text, uuid, uuid, text, jsonb, jsonb, text
  ),
  app.reject_processing_execution_receipt_mutation()
  FROM PUBLIC, opengeo_runtime, opengeo_worker;

REVOKE ALL ON FUNCTION
  app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb),
  app.complete_pmtiles_derivative(uuid, uuid, jsonb)
  FROM PUBLIC, opengeo_runtime;

GRANT EXECUTE ON FUNCTION
  app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb),
  app.complete_pmtiles_derivative(uuid, uuid, jsonb)
  TO opengeo_worker;

COMMENT ON TABLE app.processing_execution_receipts IS
  'Immutable terminal PMTiles/COG execution receipts linking sealed requests, exact source/output objects, pinned software, bounded event logs, and a canonical checksum; legacy completions are explicitly marked unverified.';
COMMENT ON FUNCTION app.complete_spatial_coverage_derivative(uuid, uuid, jsonb, jsonb) IS
  'Completes one validated coverage derivative and atomically records a pinned, checksum-linked execution receipt.';
COMMENT ON FUNCTION app.complete_pmtiles_derivative(uuid, uuid, jsonb) IS
  'Completes one validated PMTiles derivative and atomically records a pinned, checksum-linked execution receipt.';

COMMIT;
