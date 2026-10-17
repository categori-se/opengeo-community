BEGIN;

-- Worker facts are separate from terminal jobs and from deliberate display admission.
CREATE TABLE app.pmtiles_display_validations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  pmtiles_job_id uuid NOT NULL,
  output_object_id uuid NOT NULL,
  block_index_object_id uuid,
  validation jsonb NOT NULL CHECK (
    jsonb_typeof(validation) = 'object' AND octet_length(validation::text) <= 131072
  ),
  review_sha256 text NOT NULL CHECK (review_sha256 = encode(sha256(convert_to(
    jsonb_build_object('organization_id', organization_id, 'job_id', pmtiles_job_id,
      'output_object_id', output_object_id, 'validation', validation)::text, 'UTF8'
  )), 'hex')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, pmtiles_job_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, pmtiles_job_id)
    REFERENCES app.pmtiles_derivative_jobs(organization_id, id),
  FOREIGN KEY (organization_id, output_object_id) REFERENCES app.data_objects(organization_id, id),
  FOREIGN KEY (organization_id, block_index_object_id) REFERENCES app.data_objects(organization_id, id)
);

CREATE FUNCTION app.reject_pmtiles_display_validation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PMTiles display validations are immutable';
END;
$$;
CREATE TRIGGER pmtiles_display_validations_immutable
  BEFORE UPDATE OR DELETE ON app.pmtiles_display_validations
  FOR EACH ROW EXECUTE FUNCTION app.reject_pmtiles_display_validation_mutation();

ALTER TABLE app.pmtiles_display_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pmtiles_display_validations FORCE ROW LEVEL SECURITY;
CREATE POLICY pmtiles_display_validations_workspace_read ON app.pmtiles_display_validations
  TO opengeo_runtime USING (organization_id = app.current_organization_id()
    AND app.effective_project_role(project_id) IS NOT NULL);
GRANT SELECT ON app.pmtiles_display_validations TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.pmtiles_display_validations FROM opengeo_runtime;
REVOKE ALL ON app.pmtiles_display_validations FROM opengeo_worker;

-- The old three-argument function, including its 0059 execution receipt, is unchanged.
CREATE FUNCTION app.complete_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb, p_validation jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  v_job app.pmtiles_derivative_jobs%ROWTYPE;
  v_source app.data_objects%ROWTYPE;
  v_output app.data_objects%ROWTYPE;
  v_index jsonb;
  v_index_id uuid;
  v_blocks bigint;
  v_layer jsonb;
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL THEN RETURN false; END IF;
  IF NOT app.complete_pmtiles_derivative(p_job_id, p_worker_token, p_artifact) THEN
    RETURN false;
  END IF;
  SELECT * INTO STRICT v_job FROM app.pmtiles_derivative_jobs WHERE id = p_job_id;
  SELECT * INTO STRICT v_source FROM app.data_objects
    WHERE organization_id = v_job.organization_id AND id = v_job.source_object_id;
  SELECT * INTO STRICT v_output FROM app.data_objects
    WHERE organization_id = v_job.organization_id AND id = v_job.output_object_id;
  IF p_validation IS NULL OR jsonb_typeof(p_validation) <> 'object'
    OR octet_length(p_validation::text) > 131072
    OR (p_validation - ARRAY['schema_version','recipe','source_object_id','source_checksum_sha256',
      'source_s3_version_id','request_checksum_sha256','output_checksum_sha256','output_size_bytes',
      'expected_owner','bounds','min_zoom','max_zoom','output_layer','tile_layers','count_semantics',
      'losses','block_sha256','block_index_artifact']) <> '{}'::jsonb
    OR p_validation->>'schema_version' IS DISTINCT FROM 'opengeo.pmtiles-display-validation.1'
    OR p_validation->>'recipe' IS DISTINCT FROM 'gdal-pmtiles-v1'
    OR p_validation->>'source_object_id' IS DISTINCT FROM v_job.source_object_id::text
    OR p_validation->>'source_checksum_sha256' IS DISTINCT FROM v_source.checksum_sha256
    OR p_validation->>'source_s3_version_id' IS DISTINCT FROM v_source.s3_version_id
    OR p_validation->>'request_checksum_sha256' IS DISTINCT FROM v_job.request_checksum_sha256
    OR p_validation->>'output_checksum_sha256' IS DISTINCT FROM v_output.checksum_sha256
    OR p_validation->'output_size_bytes' IS DISTINCT FROM to_jsonb(v_output.size_bytes)
    OR COALESCE(p_validation->>'expected_owner', '') !~ '^[0-9]{12}$'
    OR p_validation->'bounds' IS DISTINCT FROM v_job.bounds
    OR p_validation->'min_zoom' IS DISTINCT FROM to_jsonb(v_job.minimum_zoom)
    OR p_validation->'max_zoom' IS DISTINCT FROM to_jsonb(v_job.maximum_zoom)
    OR p_validation->>'count_semantics' IS DISTINCT FROM 'gdal-reported-tile-fragments-not-source-records'
    OR jsonb_typeof(p_validation->'losses') IS DISTINCT FROM 'object'
    OR p_validation->'losses'->>'geometry' IS DISTINCT FROM 'quantized-clipped-simplified-display-not-analysis'
    OR p_validation->'losses'->>'attributes' IS DISTINCT FROM 'not-independently-verified-null-values-may-be-omitted'
    OR p_validation->'losses'->>'feature_ids' IS DISTINCT FROM 'not-guaranteed-to-retain-source-fids'
    OR p_validation->'losses'->'source_record_count' IS DISTINCT FROM 'null'::jsonb
    OR p_validation->'losses'->'preservation_verified' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_validation->'output_layer') IS DISTINCT FROM 'object'
    OR p_validation->'output_layer'->>'name' IS DISTINCT FROM v_job.source_layer
    OR p_validation->'output_layer'->>'crs' IS DISTINCT FROM 'EPSG:3857'
    OR jsonb_typeof(p_validation->'output_layer'->'reported_fragment_count') IS DISTINCT FROM 'number'
    OR COALESCE(p_validation->'output_layer'->>'reported_fragment_count', '') !~ '^[0-9]{1,19}$'
    OR (p_validation->'output_layer'->>'reported_fragment_count')::numeric > 9223372036854775807
    OR jsonb_typeof(p_validation->'tile_layers') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'invalid PMTiles display validation'; END IF;
  IF jsonb_array_length(p_validation->'tile_layers') NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'invalid PMTiles display layers';
  END IF;
  IF jsonb_array_length(p_validation->'tile_layers') = 1 THEN
    v_layer := p_validation->'tile_layers'->0;
    IF jsonb_typeof(v_layer) <> 'object'
      OR (v_layer - ARRAY['source_layer','title','geometry_type','feature_count','geometry_method']) <> '{}'::jsonb
      OR COALESCE(v_layer->>'source_layer', '') !~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'
      OR v_layer->>'source_layer' IS DISTINCT FROM v_job.source_layer
      OR char_length(COALESCE(v_layer->>'title', '')) NOT BETWEEN 1 AND 200
      OR COALESCE(v_layer->>'geometry_type', '') NOT IN
        ('Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon')
      OR v_layer->'geometry_type' IS DISTINCT FROM p_validation->'output_layer'->'geometry_type'
      OR v_layer->'feature_count' IS DISTINCT FROM p_validation->'output_layer'->'reported_fragment_count'
      OR (v_layer->>'feature_count')::bigint > 10000000
      OR char_length(COALESCE(v_layer->>'geometry_method', '')) NOT BETWEEN 1 AND 2000
    THEN RAISE EXCEPTION 'invalid PMTiles display layers'; END IF;
  END IF;
  v_blocks := (v_output.size_bytes + 65535) / 65536;
  IF (p_validation ? 'block_sha256') = (p_validation ? 'block_index_artifact') THEN
    RAISE EXCEPTION 'PMTiles display requires one exact block verification method';
  END IF;
  IF p_validation ? 'block_sha256' THEN
    IF v_output.size_bytes > 67108864
      OR (p_validation->'output_layer'->>'reported_fragment_count')::bigint > 100000
      OR jsonb_typeof(p_validation->'block_sha256') <> 'array'
      OR jsonb_array_length(p_validation->'block_sha256') <> v_blocks
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_validation->'block_sha256') item
        WHERE jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[0-9a-f]{64}$')
    THEN RAISE EXCEPTION 'invalid PMTiles inline block verification'; END IF;
  ELSE
    v_index := p_validation->'block_index_artifact';
    IF jsonb_typeof(v_index) IS DISTINCT FROM 'object' OR octet_length(v_index::text) > 8192
      OR v_index->>'role' IS DISTINCT FROM 'derived'
      OR v_index->>'bucket' IS DISTINCT FROM v_output.bucket
      OR v_index->>'object_key' IS DISTINCT FROM regexp_replace(v_output.object_key, '\.pmtiles$', '.blocks.sha256')
      OR char_length(COALESCE(v_index->>'s3_version_id', '')) NOT BETWEEN 1 AND 1024
      OR v_index->>'s3_version_id' = 'null' OR v_index->>'s3_version_id' ~ '[[:cntrl:]]'
      OR COALESCE(v_index->>'etag', '') !~ '^[A-Fa-f0-9]{16,128}$'
      OR v_index->>'content_type' IS DISTINCT FROM 'application/octet-stream'
      OR v_index->'size_bytes' IS DISTINCT FROM to_jsonb(v_blocks * 32)
      OR v_blocks * 32 > 1048576
      OR COALESCE(v_index->>'checksum_sha256', '') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid PMTiles block index artifact'; END IF;
    v_index_id := (v_index->>'id')::uuid;
    IF v_index_id IS NULL THEN RAISE EXCEPTION 'invalid PMTiles block index identity'; END IF;
    INSERT INTO app.data_objects(id, organization_id, dataset_id, role, bucket, object_key,
      s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
    VALUES (v_index_id, v_job.organization_id, v_job.dataset_id, 'derived', v_output.bucket,
      v_index->>'object_key', v_index->>'s3_version_id', lower(v_index->>'etag'),
      'application/octet-stream', v_blocks * 32, v_index->>'checksum_sha256', v_job.created_by);
    INSERT INTO app.dataset_version_objects(organization_id, dataset_id, dataset_version_id, data_object_id)
    VALUES (v_job.organization_id, v_job.dataset_id, v_job.dataset_version_id, v_index_id);
  END IF;
  INSERT INTO app.pmtiles_display_validations(organization_id, project_id, dataset_id,
    dataset_version_id, pmtiles_job_id, output_object_id, block_index_object_id, validation, review_sha256)
  VALUES (v_job.organization_id, v_job.project_id, v_job.dataset_id, v_job.dataset_version_id,
    v_job.id, v_job.output_object_id, v_index_id, p_validation,
    encode(sha256(convert_to(jsonb_build_object('organization_id', v_job.organization_id,
      'job_id', v_job.id, 'output_object_id', v_job.output_object_id,
      'validation', p_validation)::text, 'UTF8')), 'hex'));
  RETURN true;
END;
$$;

ALTER TABLE app.layer_archive_distributions ADD COLUMN pmtiles_job_id uuid,
  ADD CONSTRAINT layer_archive_pmtiles_job UNIQUE (organization_id, pmtiles_job_id),
  ADD CONSTRAINT layer_archive_pmtiles_validation FOREIGN KEY (organization_id, pmtiles_job_id)
    REFERENCES app.pmtiles_display_validations(organization_id, pmtiles_job_id);

CREATE FUNCTION app.admit_pmtiles_derivative_display(
  p_organization_id uuid, p_project_id uuid, p_dataset_id uuid, p_dataset_version_id uuid,
  p_job_id uuid, p_expected_review_sha256 text, p_title text, p_rights_basis text,
  p_attribution text, p_acknowledge_conversion_limits boolean
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  v_job app.pmtiles_derivative_jobs%ROWTYPE;
  v_validation app.pmtiles_display_validations%ROWTYPE;
  v_output app.data_objects%ROWTYPE;
  v_index app.data_objects%ROWTYPE;
  v_object jsonb;
  v_descriptor jsonb;
  v_existing app.layer_archive_distributions%ROWTYPE;
BEGIN
  IF p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR NOT EXISTS (SELECT 1 FROM app.organization_memberships member
      WHERE member.organization_id = p_organization_id AND member.user_id = app.current_user_id()
      AND (member.role = 'admin' OR COALESCE(app.effective_project_role(p_project_id)::text, '') IN ('owner','editor')))
  THEN RAISE EXCEPTION 'PMTiles display admission requires current dataset management authority' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_job FROM app.pmtiles_derivative_jobs
    WHERE organization_id = p_organization_id AND project_id = p_project_id
      AND dataset_id = p_dataset_id AND dataset_version_id = p_dataset_version_id
      AND id = p_job_id AND state = 'completed' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM app.project_datasets link
    JOIN app.projects project ON project.organization_id = link.organization_id AND project.id = link.project_id
    JOIN app.datasets dataset ON dataset.organization_id = link.organization_id AND dataset.id = link.dataset_id
    JOIN app.dataset_versions version ON version.organization_id = dataset.organization_id
      AND version.dataset_id = dataset.id AND version.id = p_dataset_version_id
      AND version.original_object_id = v_job.source_object_id
    JOIN app.dataset_version_objects source ON source.organization_id = version.organization_id
      AND source.dataset_version_id = version.id AND source.dataset_id = dataset.id
      AND source.data_object_id = v_job.source_object_id
    JOIN app.data_objects source_object ON source_object.organization_id = source.organization_id
      AND source_object.dataset_id = dataset.id AND source_object.id = source.data_object_id
    JOIN app.dataset_version_derivative_lineage lineage ON lineage.organization_id = version.organization_id
      AND lineage.dataset_id = dataset.id AND lineage.dataset_version_id = version.id
      AND lineage.pmtiles_job_id = v_job.id AND lineage.source_object_id = v_job.source_object_id
      AND lineage.output_object_id = v_job.output_object_id AND lineage.recipe = 'gdal-pmtiles-v1'
    WHERE link.organization_id = p_organization_id AND link.project_id = p_project_id
      AND link.dataset_id = p_dataset_id AND project.status = 'active'
      AND dataset.source_type = 'upload' AND dataset.status = 'active' AND version.state = 'active'
      AND source_object.content_type IN ('application/geo+json','application/geopackage+sqlite3',
        'application/vnd.apache.parquet','application/zip','text/csv')
      AND source_object.size_bytes BETWEEN 1 AND 536870912
  ) THEN RAISE EXCEPTION 'PMTiles display requires the current exact completed output and source' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_validation FROM app.pmtiles_display_validations
    WHERE organization_id = p_organization_id AND pmtiles_job_id = p_job_id
      AND project_id = p_project_id AND dataset_id = p_dataset_id
      AND dataset_version_id = p_dataset_version_id AND output_object_id = v_job.output_object_id;
  IF NOT FOUND OR p_expected_review_sha256 IS DISTINCT FROM v_validation.review_sha256
    OR p_acknowledge_conversion_limits IS DISTINCT FROM true
    OR p_title IS NULL OR p_title <> btrim(p_title) OR char_length(p_title) NOT BETWEEN 1 AND 200
    OR p_title ~ '[[:cntrl:]]'
    OR p_rights_basis IS NULL OR p_rights_basis <> btrim(p_rights_basis) OR char_length(p_rights_basis) NOT BETWEEN 1 AND 2000
    OR p_attribution IS NULL OR p_attribution <> btrim(p_attribution) OR char_length(p_attribution) NOT BETWEEN 1 AND 2000
    OR jsonb_array_length(v_validation.validation->'tile_layers') <> 1
  THEN RAISE EXCEPTION 'PMTiles display review is missing, stale or incompatible' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT v_output FROM app.data_objects
    WHERE organization_id = p_organization_id AND dataset_id = p_dataset_id AND id = v_job.output_object_id;
  IF v_output.size_bytes < 127 OR v_output.checksum_sha256 <> v_job.output_checksum_sha256
    OR v_output.size_bytes <> v_job.output_size_bytes OR v_output.s3_version_id IN ('', 'null')
    OR v_output.s3_version_id ~ '[[:cntrl:]]'
  THEN RAISE EXCEPTION 'PMTiles display output identity is invalid' USING ERRCODE = '23514'; END IF;
  v_object := jsonb_build_object('bucket', v_output.bucket,
    'prefix', regexp_replace(v_output.object_key, '[^/]+$', ''),
    'expected_owner', v_validation.validation->>'expected_owner',
    'key', v_output.object_key, 'version_id', v_output.s3_version_id,
    'size_bytes', v_output.size_bytes, 'decoded_size_bytes', v_output.size_bytes,
    'sha256', v_output.checksum_sha256, 'decoded_sha256', v_output.checksum_sha256,
    'encoding', 'identity', 'feature_count', v_validation.validation->'output_layer'->'reported_fragment_count');
  IF v_validation.block_index_object_id IS NULL THEN
    v_object := v_object || jsonb_build_object('block_sha256', v_validation.validation->'block_sha256');
  ELSE
    SELECT * INTO STRICT v_index FROM app.data_objects
      WHERE organization_id = p_organization_id AND dataset_id = p_dataset_id AND id = v_validation.block_index_object_id;
    v_object := v_object || jsonb_build_object('block_index', jsonb_build_object('key', v_index.object_key,
      'version_id', v_index.s3_version_id, 'size_bytes', v_index.size_bytes, 'sha256', v_index.checksum_sha256));
  END IF;
  v_descriptor := jsonb_build_object('format', 'pmtiles', 'objects', jsonb_build_array(v_object),
    'min_zoom', v_validation.validation->'min_zoom', 'max_zoom', v_validation.validation->'max_zoom',
    'tile_layers', v_validation.validation->'tile_layers', 'attribution', p_attribution,
    'rights', jsonb_build_object('rights_basis', p_rights_basis),
    'provenance', jsonb_build_object('pmtiles_job_id', v_job.id, 'recipe', 'gdal-pmtiles-v1',
      'source_object_id', v_job.source_object_id, 'output_object_id', v_job.output_object_id,
      'request_checksum_sha256', v_job.request_checksum_sha256, 'review_sha256', v_validation.review_sha256,
      'output_finished_at', v_job.finished_at, 'bounds', v_job.bounds,
      'count_semantics', v_validation.validation->'count_semantics', 'losses', v_validation.validation->'losses'));
  SELECT * INTO v_existing FROM app.layer_archive_distributions
    WHERE organization_id = p_organization_id AND id = p_job_id;
  IF FOUND THEN
    IF v_existing.pmtiles_job_id IS DISTINCT FROM p_job_id OR v_existing.project_id <> p_project_id
      OR v_existing.dataset_id <> p_dataset_id OR v_existing.dataset_version_id IS DISTINCT FROM p_dataset_version_id
      OR v_existing.source_version IS NOT NULL OR NOT v_existing.enabled
      OR v_existing.title <> p_title OR v_existing.descriptor <> v_descriptor
    THEN RAISE EXCEPTION 'PMTiles display admission conflicts with the existing review' USING ERRCODE = '23514'; END IF;
    RETURN v_existing.id;
  END IF;
  INSERT INTO app.layer_archive_distributions(organization_id, project_id, dataset_id,
    dataset_version_id, pmtiles_job_id, id, title, captured_at, descriptor, enabled, reviewed_by)
  VALUES (p_organization_id, p_project_id, p_dataset_id, p_dataset_version_id,
    p_job_id, p_job_id, p_title, NULL, v_descriptor, true, app.current_user_id());
  RETURN p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION app.reject_pmtiles_display_validation_mutation(),
  app.complete_pmtiles_derivative(uuid,uuid,jsonb,jsonb),
  app.admit_pmtiles_derivative_display(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean)
  FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.complete_pmtiles_derivative(uuid,uuid,jsonb,jsonb) TO opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.admit_pmtiles_derivative_display(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean) TO opengeo_runtime;
COMMENT ON TABLE app.pmtiles_display_validations IS
  'Immutable worker validation and explicit conversion limits for one exact completed PMTiles output; completion does not enable a display.';
COMMENT ON FUNCTION app.admit_pmtiles_derivative_display(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean) IS
  'Deliberately admits only a currently authorized exact completed PMTiles job after matching its immutable review; accepts no storage coordinates.';
COMMIT;
