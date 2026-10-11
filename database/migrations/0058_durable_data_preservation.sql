BEGIN;

-- CONNECT-001E separates private conversion from outbound source custody.
-- Queue messages carry only an id; exact source identity, limits, destination,
-- and lineage remain sealed in PostgreSQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_source_archiver') THEN
    EXECUTE 'CREATE ROLE opengeo_source_archiver LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_source_archiver SET search_path = app, public;
GRANT USAGE ON SCHEMA app TO opengeo_source_archiver;

CREATE TABLE app.external_source_copy_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
  source_revision_number bigint NOT NULL,
  copy_method text NOT NULL,
  capture_scope jsonb NOT NULL,
  output_format app.dataset_format NOT NULL,
  output_content_type text NOT NULL,
  maximum_requests integer NOT NULL,
  maximum_output_bytes bigint NOT NULL,
  estimated_cost_usd numeric(12, 6) NOT NULL,
  estimate_checksum_sha256 text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, source_dataset_id, source_revision_number)
    REFERENCES app.external_source_revisions
      (organization_id, dataset_id, version_number),
  CONSTRAINT external_source_copy_estimates_revision_positive CHECK (
    source_revision_number > 0
  ),
  CONSTRAINT external_source_copy_estimates_method_known CHECK (
    copy_method IN ('exact_object_copy', 'bounded_map_capture', 'bounded_tile_capture')
  ),
  CONSTRAINT external_source_copy_estimates_output_known CHECK (
    (copy_method = 'exact_object_copy' AND output_format = 'pmtiles'
      AND output_content_type = 'application/vnd.pmtiles')
    OR (copy_method = 'bounded_map_capture' AND output_format = 'png'
      AND output_content_type = 'image/png')
    OR (copy_method = 'bounded_tile_capture' AND output_format = 'pmtiles'
      AND output_content_type = 'application/vnd.pmtiles')
  ),
  CONSTRAINT external_source_copy_estimates_scope_bounded CHECK (
    jsonb_typeof(capture_scope) = 'object'
    AND octet_length(capture_scope::text) <= 8192
  ),
  CONSTRAINT external_source_copy_estimates_requests_bounded CHECK (
    maximum_requests BETWEEN 1 AND 4096
  ),
  CONSTRAINT external_source_copy_estimates_bytes_bounded CHECK (
    maximum_output_bytes BETWEEN 1 AND 536870912
  ),
  CONSTRAINT external_source_copy_estimates_cost_bounded CHECK (
    estimated_cost_usd BETWEEN 0 AND 100
  ),
  CONSTRAINT external_source_copy_estimates_checksum_valid CHECK (
    estimate_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT external_source_copy_estimates_expiry_bounded CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 minutes'
  )
);

CREATE TABLE app.external_source_snapshot_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
  source_revision_number bigint NOT NULL,
  destination_dataset_id uuid NOT NULL,
  destination_bucket text NOT NULL,
  rights_basis text NOT NULL,
  attribution text NOT NULL,
  request_checksum_sha256 text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_id text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  output_object_id uuid,
  output_dataset_version_id uuid,
  error_code text,
  worker_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, estimate_id),
  UNIQUE (organization_id, project_id, idempotency_key),
  UNIQUE (organization_id, request_checksum_sha256),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, estimate_id)
    REFERENCES app.external_source_copy_estimates (organization_id, id),
  FOREIGN KEY (organization_id, source_dataset_id, source_revision_number)
    REFERENCES app.external_source_revisions
      (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, destination_dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, destination_dataset_id, output_dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  CONSTRAINT external_source_snapshot_rights_bounded CHECK (
    rights_basis = btrim(rights_basis)
    AND char_length(rights_basis) BETWEEN 1 AND 500
    AND attribution = btrim(attribution)
    AND char_length(attribution) BETWEEN 1 AND 1000
  ),
  CONSTRAINT external_source_snapshot_bucket_bounded CHECK (
    char_length(destination_bucket) BETWEEN 3 AND 63
    AND destination_bucket ~ '^[a-z0-9][a-z0-9.-]+[a-z0-9]$'
  ),
  CONSTRAINT external_source_snapshot_request_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT external_source_snapshot_request_id_bounded CHECK (
    request_id = btrim(request_id) AND char_length(request_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT external_source_snapshot_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT external_source_snapshot_error_bounded CHECK (
    error_code IS NULL OR (
      error_code ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
      AND char_length(error_code) <= 100
    )
  ),
  CONSTRAINT external_source_snapshot_result_shape CHECK (
    (state = 'completed' AND output_object_id IS NOT NULL
      AND output_dataset_version_id IS NOT NULL AND error_code IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state <> 'completed' AND output_object_id IS NULL
      AND output_dataset_version_id IS NULL)
  ),
  CONSTRAINT external_source_snapshot_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
  ),
  CONSTRAINT external_source_snapshot_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE TABLE app.pmtiles_derivative_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  source_object_id uuid NOT NULL,
  bounds jsonb NOT NULL,
  minimum_zoom smallint NOT NULL,
  maximum_zoom smallint NOT NULL,
  source_layer text NOT NULL,
  request_checksum_sha256 text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_id text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  output_object_id uuid,
  output_size_bytes bigint,
  output_checksum_sha256 text,
  error_code text,
  worker_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, idempotency_key),
  UNIQUE (organization_id, dataset_version_id, request_checksum_sha256),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, source_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id),
  CONSTRAINT pmtiles_derivative_bounds_valid CHECK (
    jsonb_typeof(bounds) = 'array' AND jsonb_array_length(bounds) = 4
    AND jsonb_typeof(bounds->0) = 'number'
    AND jsonb_typeof(bounds->1) = 'number'
    AND jsonb_typeof(bounds->2) = 'number'
    AND jsonb_typeof(bounds->3) = 'number'
    AND (bounds->>0)::numeric BETWEEN -180 AND 180
    AND (bounds->>1)::numeric BETWEEN -90 AND 90
    AND (bounds->>2)::numeric BETWEEN -180 AND 180
    AND (bounds->>3)::numeric BETWEEN -90 AND 90
    AND (bounds->>0)::numeric < (bounds->>2)::numeric
    AND (bounds->>1)::numeric < (bounds->>3)::numeric
  ),
  CONSTRAINT pmtiles_derivative_zoom_bounded CHECK (
    minimum_zoom BETWEEN 0 AND 22
    AND maximum_zoom BETWEEN minimum_zoom AND 22
  ),
  CONSTRAINT pmtiles_derivative_layer_bounded CHECK (
    source_layer = btrim(source_layer)
    AND char_length(source_layer) BETWEEN 1 AND 200
    AND source_layer !~ '[[:cntrl:]]'
  ),
  CONSTRAINT pmtiles_derivative_request_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT pmtiles_derivative_request_id_bounded CHECK (
    request_id = btrim(request_id) AND char_length(request_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT pmtiles_derivative_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT pmtiles_derivative_output_bounded CHECK (
    output_size_bytes IS NULL OR output_size_bytes BETWEEN 1 AND 2147483648
  ),
  CONSTRAINT pmtiles_derivative_error_bounded CHECK (
    error_code IS NULL OR (
      error_code ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
      AND char_length(error_code) <= 100
    )
  ),
  CONSTRAINT pmtiles_derivative_result_shape CHECK (
    (state = 'completed' AND output_object_id IS NOT NULL
      AND output_size_bytes IS NOT NULL
      AND output_checksum_sha256 ~ '^[0-9a-f]{64}$'
      AND error_code IS NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state <> 'completed' AND output_object_id IS NULL
      AND output_size_bytes IS NULL AND output_checksum_sha256 IS NULL)
  ),
  CONSTRAINT pmtiles_derivative_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
  ),
  CONSTRAINT pmtiles_derivative_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE TABLE app.dataset_version_external_source_lineage (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  destination_dataset_id uuid NOT NULL,
  destination_dataset_version_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
  source_revision_number bigint NOT NULL,
  snapshot_job_id uuid NOT NULL,
  retrieved_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, destination_dataset_version_id),
  UNIQUE (organization_id, snapshot_job_id),
  FOREIGN KEY (organization_id, destination_dataset_id, destination_dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, source_dataset_id, source_revision_number)
    REFERENCES app.external_source_revisions
      (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, snapshot_job_id)
    REFERENCES app.external_source_snapshot_jobs (organization_id, id)
);

CREATE TABLE app.dataset_version_derivative_lineage (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  source_object_id uuid NOT NULL,
  output_object_id uuid NOT NULL,
  pmtiles_job_id uuid NOT NULL,
  recipe text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, output_object_id),
  UNIQUE (organization_id, pmtiles_job_id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, source_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, pmtiles_job_id)
    REFERENCES app.pmtiles_derivative_jobs (organization_id, id),
  CONSTRAINT dataset_version_derivative_lineage_recipe_known CHECK (
    recipe = 'gdal-pmtiles-v1'
  )
);

CREATE INDEX external_source_copy_estimates_project_idx
  ON app.external_source_copy_estimates
    (organization_id, project_id, source_dataset_id, created_at DESC, id);
CREATE INDEX external_source_snapshot_jobs_project_idx
  ON app.external_source_snapshot_jobs
    (organization_id, project_id, source_dataset_id, created_at DESC, id);
CREATE INDEX external_source_snapshot_jobs_expired_idx
  ON app.external_source_snapshot_jobs (lease_expires_at, id)
  WHERE state = 'running';
CREATE INDEX external_source_snapshot_jobs_destination_active_idx
  ON app.external_source_snapshot_jobs
    (organization_id, project_id, destination_dataset_id, id)
  WHERE state IN ('queued', 'running');
CREATE INDEX pmtiles_derivative_jobs_project_idx
  ON app.pmtiles_derivative_jobs
    (organization_id, project_id, dataset_id, created_at DESC, id);
CREATE INDEX pmtiles_derivative_jobs_expired_idx
  ON app.pmtiles_derivative_jobs (lease_expires_at, id)
  WHERE state = 'running';

CREATE FUNCTION app.enforce_external_source_copy_estimate_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type text;
  v_source_format text;
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
  SELECT source.source_type::text, revision.configuration->>'format'
    INTO v_source_type, v_source_format
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
  ) THEN
    RAISE EXCEPTION 'source-copy estimate does not match the project source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_external_source_copy_estimate_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source-copy estimates are immutable';
END;
$$;

CREATE FUNCTION app.enforce_external_source_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_estimate app.external_source_copy_estimates%ROWTYPE;
  v_destination app.datasets%ROWTYPE;
BEGIN
  IF NEW.created_by <> app.current_user_id() OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL OR NEW.output_dataset_version_id IS NOT NULL
    OR NEW.error_code IS NOT NULL OR NEW.worker_token IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'source snapshot creator or initial state mismatch';
  END IF;
  IF COALESCE(
    app.effective_project_role(NEW.project_id, NEW.created_by)::text,
    ''
  ) NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'source snapshot requires project edit access';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:data-preservation-quota:' || NEW.organization_id::text, 0
  ));
  SELECT * INTO v_estimate FROM app.external_source_copy_estimates
  WHERE organization_id = NEW.organization_id AND id = NEW.estimate_id;
  SELECT * INTO v_destination FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.destination_dataset_id;
  IF NOT FOUND OR v_estimate.project_id <> NEW.project_id
    OR v_estimate.source_dataset_id <> NEW.source_dataset_id
    OR v_estimate.source_revision_number <> NEW.source_revision_number
    OR v_estimate.created_by <> NEW.created_by
    OR v_estimate.expires_at <= clock_timestamp()
    OR v_destination.source_type <> 'upload'
    OR v_destination.format <> v_estimate.output_format
    OR v_destination.status <> 'draft' OR v_destination.current_version_id IS NOT NULL
    OR v_destination.owner_user_id <> NEW.created_by
    OR NOT EXISTS (
      SELECT 1 FROM app.project_datasets link
      WHERE link.organization_id = NEW.organization_id
        AND link.project_id = NEW.project_id
        AND link.dataset_id = NEW.destination_dataset_id
    )
  THEN
    RAISE EXCEPTION 'source snapshot does not match its sealed estimate and destination';
  END IF;
  IF (SELECT count(*) FROM app.external_source_snapshot_jobs job
      WHERE job.organization_id = NEW.organization_id
        AND job.state IN ('queued', 'running')) >= 4
    OR (SELECT count(*) FROM app.external_source_snapshot_jobs job
        WHERE job.organization_id = NEW.organization_id
          AND job.source_dataset_id = NEW.source_dataset_id
          AND job.created_at >= clock_timestamp() - interval '24 hours') >= 64
    OR COALESCE((
      SELECT sum(estimate.maximum_output_bytes)
      FROM app.external_source_snapshot_jobs job
      JOIN app.external_source_copy_estimates estimate
        ON estimate.organization_id = job.organization_id
       AND estimate.id = job.estimate_id
      WHERE job.organization_id = NEW.organization_id
        AND job.created_at >= clock_timestamp() - interval '24 hours'
        AND job.state <> 'cancelled'
    ), 0) + v_estimate.maximum_output_bytes > 10737418240
  THEN
    RAISE EXCEPTION 'source snapshot quota exceeded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_external_source_snapshot_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.estimate_id <> OLD.estimate_id
    OR NEW.source_dataset_id <> OLD.source_dataset_id
    OR NEW.source_revision_number <> OLD.source_revision_number
    OR NEW.destination_dataset_id <> OLD.destination_dataset_id
    OR NEW.destination_bucket <> OLD.destination_bucket
    OR NEW.rights_basis <> OLD.rights_basis OR NEW.attribution <> OLD.attribution
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  THEN RAISE EXCEPTION 'source snapshot request seal is immutable'; END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'source snapshot terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_pmtiles_derivative_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:data-preservation-quota:' || NEW.organization_id::text, 0
  ));
  IF NEW.created_by <> app.current_user_id() OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.worker_token IS NOT NULL OR NEW.attempt_count <> 0
    OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1
      FROM app.project_datasets project_dataset
      JOIN app.datasets dataset
        ON dataset.organization_id = project_dataset.organization_id
       AND dataset.id = project_dataset.dataset_id
      JOIN app.dataset_versions version
        ON version.organization_id = dataset.organization_id
       AND version.dataset_id = dataset.id
       AND version.id = NEW.dataset_version_id
      JOIN app.dataset_version_objects link
        ON link.organization_id = version.organization_id
       AND link.dataset_id = version.dataset_id
       AND link.dataset_version_id = version.id
       AND link.data_object_id = NEW.source_object_id
      JOIN app.data_objects object
        ON object.organization_id = link.organization_id
       AND object.dataset_id = link.dataset_id
       AND object.id = link.data_object_id
      WHERE project_dataset.organization_id = NEW.organization_id
        AND project_dataset.project_id = NEW.project_id
        AND project_dataset.dataset_id = NEW.dataset_id
        AND dataset.status = 'active' AND version.state = 'active'
        AND object.role IN ('original', 'working')
        AND object.content_type IN (
          'application/geo+json', 'application/geopackage+sqlite3',
          'application/vnd.apache.parquet', 'application/zip', 'text/csv'
        )
        AND object.size_bytes <= 2147483648
    )
  THEN RAISE EXCEPTION 'PMTiles job must target an exact active managed vector object'; END IF;
  IF COALESCE(
    app.effective_project_role(NEW.project_id, NEW.created_by)::text,
    ''
  ) NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'PMTiles derivative requires project edit access';
  END IF;
  IF (SELECT count(*) FROM app.pmtiles_derivative_jobs job
      WHERE job.organization_id = NEW.organization_id
        AND job.dataset_id = NEW.dataset_id
        AND job.state IN ('queued', 'running')) >= 4
    OR (SELECT count(*) FROM app.pmtiles_derivative_jobs job
        WHERE job.organization_id = NEW.organization_id
          AND job.dataset_version_id = NEW.dataset_version_id
          AND job.created_at >= clock_timestamp() - interval '24 hours') >= 64
  THEN RAISE EXCEPTION 'PMTiles derivative quota exceeded'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_pmtiles_derivative_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.dataset_id <> OLD.dataset_id
    OR NEW.dataset_version_id <> OLD.dataset_version_id
    OR NEW.source_object_id <> OLD.source_object_id OR NEW.bounds <> OLD.bounds
    OR NEW.minimum_zoom <> OLD.minimum_zoom OR NEW.maximum_zoom <> OLD.maximum_zoom
    OR NEW.source_layer <> OLD.source_layer
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  THEN RAISE EXCEPTION 'PMTiles derivative request seal is immutable'; END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'PMTiles derivative terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.prevent_active_preservation_dataset_detach()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:data-preservation-quota:' || OLD.organization_id::text, 0
  ));
  IF EXISTS (
    SELECT 1
    FROM app.external_source_snapshot_jobs job
    WHERE job.organization_id = OLD.organization_id
      AND job.project_id = OLD.project_id
      AND (job.source_dataset_id = OLD.dataset_id
        OR job.destination_dataset_id = OLD.dataset_id)
      AND job.state IN ('queued', 'running')
  ) OR EXISTS (
    SELECT 1
    FROM app.pmtiles_derivative_jobs job
    WHERE job.organization_id = OLD.organization_id
      AND job.project_id = OLD.project_id
      AND job.dataset_id = OLD.dataset_id
      AND job.state IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'project dataset has active preservation work';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER external_source_copy_estimates_validate_insert
  BEFORE INSERT ON app.external_source_copy_estimates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_copy_estimate_insert();
CREATE TRIGGER external_source_copy_estimates_are_immutable
  BEFORE UPDATE OR DELETE ON app.external_source_copy_estimates
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_copy_estimate_mutation();
CREATE TRIGGER external_source_snapshot_jobs_validate_insert
  BEFORE INSERT ON app.external_source_snapshot_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_snapshot_insert();
CREATE TRIGGER external_source_snapshot_jobs_validate_transition
  BEFORE UPDATE ON app.external_source_snapshot_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_snapshot_transition();
CREATE TRIGGER pmtiles_derivative_jobs_validate_insert
  BEFORE INSERT ON app.pmtiles_derivative_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_pmtiles_derivative_insert();
CREATE TRIGGER pmtiles_derivative_jobs_validate_transition
  BEFORE UPDATE ON app.pmtiles_derivative_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_pmtiles_derivative_transition();
CREATE TRIGGER project_datasets_preservation_detach_guard
  BEFORE DELETE ON app.project_datasets
  FOR EACH ROW EXECUTE FUNCTION app.prevent_active_preservation_dataset_detach();
CREATE TRIGGER dataset_version_external_source_lineage_is_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_version_external_source_lineage
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_copy_estimate_mutation();
CREATE TRIGGER dataset_version_derivative_lineage_is_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_version_derivative_lineage
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_copy_estimate_mutation();

CREATE FUNCTION app.claim_external_source_snapshot(
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
      CASE WHEN v_job.output_format = 'png' THEN 'snapshot.png' ELSE 'source.pmtiles' END
    ), v_job.request_checksum_sha256, v_job.attempt_count;
END;
$$;

CREATE FUNCTION app.heartbeat_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 900 THEN RETURN false; END IF;
  UPDATE app.external_source_snapshot_jobs
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
    AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.complete_external_source_snapshot(
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
  v_filename := CASE WHEN v_estimate.output_format = 'png'
    THEN 'snapshot.png' ELSE 'source.pmtiles' END;
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

CREATE FUNCTION app.fail_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_organization_id uuid;
  v_project_id uuid;
  v_destination_dataset_id uuid;
  v_created_by uuid;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100 THEN RETURN false; END IF;
  UPDATE app.external_source_snapshot_jobs
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  RETURNING organization_id, project_id, destination_dataset_id, created_by
    INTO v_organization_id, v_project_id, v_destination_dataset_id, v_created_by;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.datasets
  SET status = 'failed', updated_by = v_created_by, updated_at = clock_timestamp()
  WHERE organization_id = v_organization_id AND id = v_destination_dataset_id
    AND status = 'draft' AND current_version_id IS NULL;
  DELETE FROM app.project_datasets
  WHERE organization_id = v_organization_id AND project_id = v_project_id
    AND dataset_id = v_destination_dataset_id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.get_completed_external_source_snapshot_artifact(
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
      CASE WHEN estimate.output_format = 'png'
        THEN 'snapshot.png' ELSE 'source.pmtiles' END
    )
    AND object.content_type = estimate.output_content_type
    AND object.size_bytes BETWEEN 1 AND estimate.maximum_output_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completed source snapshot artifact is inconsistent';
  END IF;
END;
$$;

CREATE FUNCTION app.release_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_attempt integer; v_state text;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100 THEN RETURN 'lost'; END IF;
  SELECT attempt_count INTO v_attempt FROM app.external_source_snapshot_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE WHEN v_attempt >= 3 THEN 'failed' ELSE 'queued' END;
  UPDATE app.external_source_snapshot_jobs
  SET state = v_state::app.processing_job_state, error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id;
  IF v_state = 'failed' THEN
    UPDATE app.datasets destination
    SET status = 'failed', updated_by = job.created_by,
        updated_at = clock_timestamp()
    FROM app.external_source_snapshot_jobs job
    WHERE job.id = p_job_id
      AND destination.organization_id = job.organization_id
      AND destination.id = job.destination_dataset_id
      AND destination.status = 'draft'
      AND destination.current_version_id IS NULL;
    DELETE FROM app.project_datasets link
    USING app.external_source_snapshot_jobs job
    WHERE job.id = p_job_id
      AND link.organization_id = job.organization_id
      AND link.project_id = job.project_id
      AND link.dataset_id = job.destination_dataset_id;
  END IF;
  RETURN v_state;
END;
$$;

CREATE FUNCTION app.claim_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, organization_id uuid, project_id uuid,
  dataset_id uuid, dataset_version_id uuid, source_object_id uuid,
  source_bucket text, source_object_key text, source_s3_version_id text,
  source_etag text, source_content_type text, source_size_bytes bigint,
  source_checksum_sha256 text, bounds jsonb, minimum_zoom smallint,
  maximum_zoom smallint, source_layer text, request_checksum_sha256 text,
  attempt_count integer, output_object_key text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_job record; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN RAISE EXCEPTION 'invalid PMTiles derivative claim'; END IF;
  SELECT job.*, object.bucket, object.object_key, object.s3_version_id,
         object.etag, object.content_type, object.size_bytes,
         object.checksum_sha256
  INTO v_job
  FROM app.pmtiles_derivative_jobs job
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.source_object_id
  WHERE job.id = p_job_id FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::jsonb,
      NULL::smallint, NULL::smallint, NULL::text, NULL::text, NULL::integer,
      NULL::text;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.pmtiles_derivative_jobs
    SET state = 'failed', error_code = 'retry_exhausted', worker_token = NULL,
        lease_expires_at = NULL, last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSE
    UPDATE app.pmtiles_derivative_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now, attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id
    RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.organization_id,
    v_job.project_id, v_job.dataset_id, v_job.dataset_version_id,
    v_job.source_object_id, v_job.bucket, v_job.object_key,
    v_job.s3_version_id, v_job.etag, v_job.content_type, v_job.size_bytes,
    v_job.checksum_sha256, v_job.bounds, v_job.minimum_zoom,
    v_job.maximum_zoom, v_job.source_layer, v_job.request_checksum_sha256,
    v_job.attempt_count,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/tiles/custom/%s.pmtiles',
      v_job.organization_id, v_job.project_id, v_job.dataset_id,
      v_job.dataset_version_id, v_job.id
    );
END;
$$;

CREATE FUNCTION app.heartbeat_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN RETURN false; END IF;
  UPDATE app.pmtiles_derivative_jobs
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
    AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.complete_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_job app.pmtiles_derivative_jobs%ROWTYPE; v_source app.data_objects%ROWTYPE;
  v_expected_key text; v_object_id uuid;
BEGIN
  SELECT * INTO v_job FROM app.pmtiles_derivative_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
  SELECT * INTO v_source FROM app.data_objects
  WHERE organization_id = v_job.organization_id AND id = v_job.source_object_id;
  v_expected_key := format(
    'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/tiles/custom/%s.pmtiles',
    v_job.organization_id, v_job.project_id, v_job.dataset_id,
    v_job.dataset_version_id, v_job.id
  );
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192 OR (p_artifact->>'role') <> 'tile'
    OR (p_artifact->>'bucket') <> v_source.bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'s3_version_id') IN ('', 'null')
    OR char_length(p_artifact->>'s3_version_id') > 1024
    OR (p_artifact->>'etag') !~ '^[A-Fa-f0-9]{16,128}$'
    OR (p_artifact->>'content_type') <> 'application/vnd.pmtiles'
    OR (p_artifact->>'size_bytes')::bigint NOT BETWEEN 1 AND 2147483648
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid PMTiles derivative artifact'; END IF;
  v_object_id := (p_artifact->>'id')::uuid;
  INSERT INTO app.data_objects
    (id, organization_id, dataset_id, role, bucket, object_key,
     s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
  VALUES
    (v_object_id, v_job.organization_id, v_job.dataset_id, 'tile',
     p_artifact->>'bucket', p_artifact->>'object_key',
     p_artifact->>'s3_version_id', lower(p_artifact->>'etag'),
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', v_job.created_by);
  INSERT INTO app.dataset_version_objects
    (organization_id, dataset_id, dataset_version_id, data_object_id)
  VALUES
    (v_job.organization_id, v_job.dataset_id,
     v_job.dataset_version_id, v_object_id);
  INSERT INTO app.dataset_version_derivative_lineage
    (organization_id, dataset_id, dataset_version_id, source_object_id,
     output_object_id, pmtiles_job_id, recipe)
  VALUES
    (v_job.organization_id, v_job.dataset_id, v_job.dataset_version_id,
     v_job.source_object_id, v_object_id, v_job.id, 'gdal-pmtiles-v1');
  UPDATE app.pmtiles_derivative_jobs
  SET state = 'completed', output_object_id = v_object_id,
      output_size_bytes = (p_artifact->>'size_bytes')::bigint,
      output_checksum_sha256 = p_artifact->>'checksum_sha256', error_code = NULL,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.pmtiles.derivative.completed', 'dataset', v_job.dataset_id,
     'worker:' || v_job.id::text,
     jsonb_build_object(
       'pmtiles_job_id', v_job.id,
       'dataset_version_id', v_job.dataset_version_id,
       'source_object_id', v_job.source_object_id,
       'output_object_id', v_object_id,
       'checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100 THEN RETURN false; END IF;
  UPDATE app.pmtiles_derivative_jobs
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_pmtiles_derivative(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_attempt integer; v_state text;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100 THEN RETURN 'lost'; END IF;
  SELECT attempt_count INTO v_attempt FROM app.pmtiles_derivative_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  v_state := CASE WHEN v_attempt >= 3 THEN 'failed' ELSE 'queued' END;
  UPDATE app.pmtiles_derivative_jobs
  SET state = v_state::app.processing_job_state, error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id;
  RETURN v_state;
END;
$$;

CREATE FUNCTION app.cancel_external_source_snapshot(
  p_organization_id uuid, p_project_id uuid, p_job_id uuid,
  p_actor_user_id uuid, p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_dataset_id uuid;
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR COALESCE(
      app.effective_project_role(p_project_id, p_actor_user_id)::text,
      ''
    ) NOT IN ('owner', 'editor')
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.external_source_snapshot_jobs
  SET state = 'cancelled', error_code = 'cancelled_by_user',
      finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND id = p_job_id AND state = 'queued'
  RETURNING destination_dataset_id INTO v_dataset_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.datasets
  SET status = 'archived', updated_by = p_actor_user_id,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND id = v_dataset_id
    AND status = 'draft' AND current_version_id IS NULL;
  DELETE FROM app.project_datasets
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND dataset_id = v_dataset_id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'dataset.source.snapshot.cancelled', 'dataset', v_dataset_id, p_request_id,
     jsonb_build_object('snapshot_job_id', p_job_id));
  RETURN true;
END;
$$;

CREATE FUNCTION app.cancel_pmtiles_derivative(
  p_organization_id uuid, p_project_id uuid, p_dataset_id uuid,
  p_job_id uuid, p_actor_user_id uuid, p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR COALESCE(
      app.effective_project_role(p_project_id, p_actor_user_id)::text,
      ''
    ) NOT IN ('owner', 'editor')
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.pmtiles_derivative_jobs
  SET state = 'cancelled', error_code = 'cancelled_by_user',
      finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND dataset_id = p_dataset_id AND id = p_job_id AND state = 'queued';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'dataset.pmtiles.derivative.cancelled', 'dataset', p_dataset_id, p_request_id,
     jsonb_build_object('pmtiles_job_id', p_job_id));
  RETURN true;
END;
$$;

ALTER TABLE app.external_source_copy_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_copy_estimates FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_snapshot_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_snapshot_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pmtiles_derivative_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pmtiles_derivative_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_external_source_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_external_source_lineage FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_derivative_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_derivative_lineage FORCE ROW LEVEL SECURITY;

CREATE POLICY external_source_copy_estimates_tenant_isolation
  ON app.external_source_copy_estimates
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY external_source_snapshot_jobs_tenant_isolation
  ON app.external_source_snapshot_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY pmtiles_derivative_jobs_tenant_isolation
  ON app.pmtiles_derivative_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_version_external_source_lineage_tenant_isolation
  ON app.dataset_version_external_source_lineage
  USING (organization_id = app.current_organization_id());
CREATE POLICY dataset_version_derivative_lineage_tenant_isolation
  ON app.dataset_version_derivative_lineage
  USING (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.external_source_copy_estimates,
  app.external_source_snapshot_jobs, app.pmtiles_derivative_jobs
TO opengeo_runtime;
GRANT SELECT ON app.dataset_version_external_source_lineage,
  app.dataset_version_derivative_lineage TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.external_source_copy_estimates,
  app.external_source_snapshot_jobs, app.pmtiles_derivative_jobs
FROM opengeo_runtime;
REVOKE ALL ON app.external_source_copy_estimates,
  app.external_source_snapshot_jobs, app.pmtiles_derivative_jobs,
  app.dataset_version_external_source_lineage,
  app.dataset_version_derivative_lineage
FROM opengeo_worker, opengeo_source_archiver;

REVOKE EXECUTE ON FUNCTION
  app.enforce_external_source_copy_estimate_insert(),
  app.reject_external_source_copy_estimate_mutation(),
  app.enforce_external_source_snapshot_insert(),
  app.enforce_external_source_snapshot_transition(),
  app.enforce_pmtiles_derivative_insert(),
  app.enforce_pmtiles_derivative_transition(),
  app.claim_external_source_snapshot(uuid, uuid, integer),
  app.heartbeat_external_source_snapshot(uuid, uuid, integer),
  app.complete_external_source_snapshot(uuid, uuid, jsonb),
  app.fail_external_source_snapshot(uuid, uuid, text),
  app.get_completed_external_source_snapshot_artifact(uuid),
  app.release_external_source_snapshot(uuid, uuid, text),
  app.claim_pmtiles_derivative(uuid, uuid, integer),
  app.heartbeat_pmtiles_derivative(uuid, uuid, integer),
  app.complete_pmtiles_derivative(uuid, uuid, jsonb),
  app.fail_pmtiles_derivative(uuid, uuid, text),
  app.release_pmtiles_derivative(uuid, uuid, text),
  app.cancel_external_source_snapshot(uuid, uuid, uuid, uuid, text),
  app.cancel_pmtiles_derivative(uuid, uuid, uuid, uuid, uuid, text)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_source_archiver;

GRANT EXECUTE ON FUNCTION
  app.claim_external_source_snapshot(uuid, uuid, integer),
  app.heartbeat_external_source_snapshot(uuid, uuid, integer),
  app.complete_external_source_snapshot(uuid, uuid, jsonb),
  app.fail_external_source_snapshot(uuid, uuid, text),
  app.get_completed_external_source_snapshot_artifact(uuid),
  app.release_external_source_snapshot(uuid, uuid, text)
TO opengeo_source_archiver;
GRANT EXECUTE ON FUNCTION
  app.claim_pmtiles_derivative(uuid, uuid, integer),
  app.heartbeat_pmtiles_derivative(uuid, uuid, integer),
  app.complete_pmtiles_derivative(uuid, uuid, jsonb),
  app.fail_pmtiles_derivative(uuid, uuid, text),
  app.release_pmtiles_derivative(uuid, uuid, text)
TO opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.cancel_external_source_snapshot(uuid, uuid, uuid, uuid, text),
  app.cancel_pmtiles_derivative(uuid, uuid, uuid, uuid, uuid, text)
TO opengeo_runtime;

COMMENT ON TABLE app.external_source_copy_estimates IS
  'Short-lived server-sealed upper bounds for an exact external-source revision and capture scope.';
COMMENT ON TABLE app.external_source_snapshot_jobs IS
  'Rights-confirmed, bounded, immutable protected-copy requests executed by the outbound-only archiver.';
COMMENT ON TABLE app.pmtiles_derivative_jobs IS
  'Explicit exact-version vector-to-PMTiles requests executed by the private no-egress GIS worker.';
COMMENT ON TABLE app.dataset_version_external_source_lineage IS
  'Exact FK-backed lineage from one protected managed version to the source definition revision and custody job.';
COMMENT ON TABLE app.dataset_version_derivative_lineage IS
  'Exact FK-backed lineage from one custom PMTiles object to its managed source object, version, and sealed recipe.';
COMMENT ON FUNCTION app.get_completed_external_source_snapshot_artifact(uuid) IS
  'Returns exact persisted object facts only for retry-safe post-completion ingestion dispatch.';

COMMIT;
