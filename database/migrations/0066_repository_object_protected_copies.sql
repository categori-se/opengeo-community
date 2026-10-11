BEGIN;

-- CONNECT-001N gives one exact, already-registered repository object a
-- separately reviewed custody path. The request runtime seals intent and
-- limits; only the credential-isolated copier can resolve source authority.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_repository_copier') THEN
    EXECUTE 'CREATE ROLE opengeo_repository_copier LOGIN NOINHERIT NOBYPASSRLS';
  END IF;
END;
$$;

ALTER ROLE opengeo_repository_copier SET search_path = app, public;
GRANT USAGE ON SCHEMA app TO opengeo_repository_copier;

CREATE TABLE app.repository_object_copy_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
  output_format app.dataset_format NOT NULL,
  output_content_type text NOT NULL,
  maximum_requests integer NOT NULL DEFAULT 1,
  maximum_output_bytes bigint NOT NULL,
  estimated_cost_usd numeric(12, 6) NOT NULL,
  estimate_checksum_sha256 text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, source_dataset_id)
    REFERENCES app.repository_object_sources (organization_id, dataset_id),
  CONSTRAINT repository_copy_estimate_output_supported CHECK (
    output_format IN (
      'geojson', 'csv', 'shapefile', 'geopackage', 'geoparquet', 'cog',
      'pmtiles', 'png', 'jpeg', 'pdf', 'odt'
    )
  ),
  CONSTRAINT repository_copy_estimate_content_type_bounded CHECK (
    octet_length(output_content_type) BETWEEN 3 AND 100
    AND output_content_type ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]*$'
  ),
  CONSTRAINT repository_copy_estimate_one_request CHECK (maximum_requests = 1),
  CONSTRAINT repository_copy_estimate_bytes_bounded CHECK (
    maximum_output_bytes BETWEEN 1 AND 536870912
  ),
  CONSTRAINT repository_copy_estimate_cost_bounded CHECK (
    estimated_cost_usd BETWEEN 0 AND 100
  ),
  CONSTRAINT repository_copy_estimate_checksum_valid CHECK (
    estimate_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT repository_copy_estimate_expiry_bounded CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 minutes'
  )
);

CREATE TABLE app.repository_object_copy_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
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
    REFERENCES app.repository_object_copy_estimates (organization_id, id),
  FOREIGN KEY (organization_id, source_dataset_id)
    REFERENCES app.repository_object_sources (organization_id, dataset_id),
  FOREIGN KEY (organization_id, destination_dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id),
  FOREIGN KEY (organization_id, destination_dataset_id, output_dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  CONSTRAINT repository_copy_job_rights_bounded CHECK (
    rights_basis = btrim(rights_basis)
    AND char_length(rights_basis) BETWEEN 1 AND 500
    AND attribution = btrim(attribution)
    AND char_length(attribution) BETWEEN 1 AND 1000
  ),
  CONSTRAINT repository_copy_job_bucket_bounded CHECK (
    char_length(destination_bucket) BETWEEN 3 AND 63
    AND destination_bucket ~ '^[a-z0-9][a-z0-9.-]+[a-z0-9]$'
  ),
  CONSTRAINT repository_copy_job_request_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT repository_copy_job_request_id_bounded CHECK (
    request_id = btrim(request_id)
    AND char_length(request_id) BETWEEN 1 AND 128
    AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT repository_copy_job_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT repository_copy_job_error_bounded CHECK (
    error_code IS NULL OR (
      error_code ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
      AND char_length(error_code) <= 100
    )
  ),
  CONSTRAINT repository_copy_job_result_shape CHECK (
    (state = 'completed' AND output_object_id IS NOT NULL
      AND output_dataset_version_id IS NOT NULL AND error_code IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state <> 'completed' AND output_object_id IS NULL
      AND output_dataset_version_id IS NULL)
  ),
  CONSTRAINT repository_copy_job_lease_shape CHECK (
    (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state <> 'running' AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
  ),
  CONSTRAINT repository_copy_job_terminal_shape CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state = 'completed' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE TABLE app.dataset_version_repository_object_lineage (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  destination_dataset_id uuid NOT NULL,
  destination_dataset_version_id uuid NOT NULL,
  source_dataset_id uuid NOT NULL,
  copy_job_id uuid NOT NULL,
  retrieved_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, destination_dataset_id, destination_dataset_version_id),
  UNIQUE (organization_id, copy_job_id),
  FOREIGN KEY (organization_id, destination_dataset_id, destination_dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, source_dataset_id)
    REFERENCES app.repository_object_sources (organization_id, dataset_id),
  FOREIGN KEY (organization_id, copy_job_id)
    REFERENCES app.repository_object_copy_jobs (organization_id, id)
);

CREATE INDEX repository_object_copy_jobs_project_idx
  ON app.repository_object_copy_jobs
    (organization_id, project_id, source_dataset_id, created_at DESC);
CREATE INDEX repository_object_copy_jobs_expired_idx
  ON app.repository_object_copy_jobs (lease_expires_at, id)
  WHERE state = 'running';

CREATE FUNCTION app.reject_repository_copy_estimate_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repository object copy estimates are immutable';
END;
$$;

CREATE FUNCTION app.enforce_repository_copy_estimate_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_source record;
BEGIN
  SELECT dataset.format::text AS format, source.size_bytes,
         source.content_type, source.created_by
  INTO v_source
  FROM app.repository_object_sources source
  JOIN app.datasets dataset
    ON dataset.organization_id = source.organization_id
   AND dataset.id = source.dataset_id
  JOIN app.project_datasets link
    ON link.organization_id = source.organization_id
   AND link.dataset_id = source.dataset_id
   AND link.project_id = NEW.project_id
  WHERE source.organization_id = NEW.organization_id
    AND source.dataset_id = NEW.source_dataset_id;
  IF NEW.created_by <> app.current_user_id()
    OR COALESCE(app.effective_project_role(NEW.project_id, NEW.created_by)::text, '')
      NOT IN ('owner', 'editor')
    OR v_source.format IS NULL
    OR v_source.format <> NEW.output_format::text
    OR v_source.size_bytes <> NEW.maximum_output_bytes
    OR v_source.size_bytes > 536870912
    OR v_source.content_type IS NULL
    OR lower(v_source.content_type) <> NEW.output_content_type
  THEN
    RAISE EXCEPTION 'repository copy estimate does not match an exact project source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_repository_copy_job_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_estimate app.repository_object_copy_estimates%ROWTYPE;
  v_destination app.datasets%ROWTYPE;
BEGIN
  IF NEW.created_by <> app.current_user_id() OR NEW.state <> 'queued'
    OR NEW.output_object_id IS NOT NULL OR NEW.output_dataset_version_id IS NOT NULL
    OR NEW.error_code IS NOT NULL OR NEW.worker_token IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
  THEN RAISE EXCEPTION 'repository copy creator or initial state mismatch'; END IF;
  IF COALESCE(app.effective_project_role(NEW.project_id, NEW.created_by)::text, '')
    NOT IN ('owner', 'editor')
  THEN RAISE EXCEPTION 'repository copy requires project edit access'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo:repository-copy-quota:' || NEW.organization_id::text, 0
  ));
  SELECT * INTO v_estimate FROM app.repository_object_copy_estimates
  WHERE organization_id = NEW.organization_id AND id = NEW.estimate_id;
  SELECT * INTO v_destination FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.destination_dataset_id;
  IF v_estimate.id IS NULL OR v_estimate.project_id <> NEW.project_id
    OR v_estimate.source_dataset_id <> NEW.source_dataset_id
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
  THEN RAISE EXCEPTION 'repository copy does not match its estimate and destination'; END IF;
  IF (SELECT count(*) FROM app.repository_object_copy_jobs job
      WHERE job.organization_id = NEW.organization_id
        AND job.state IN ('queued', 'running')) >= 4
    OR (SELECT count(*) FROM app.repository_object_copy_jobs job
        WHERE job.organization_id = NEW.organization_id
          AND job.source_dataset_id = NEW.source_dataset_id
          AND job.created_at >= clock_timestamp() - interval '24 hours') >= 64
    OR COALESCE((
      SELECT sum(estimate.maximum_output_bytes)
      FROM app.repository_object_copy_jobs job
      JOIN app.repository_object_copy_estimates estimate
        ON estimate.organization_id = job.organization_id
       AND estimate.id = job.estimate_id
      WHERE job.organization_id = NEW.organization_id
        AND job.created_at >= clock_timestamp() - interval '24 hours'
        AND job.state <> 'cancelled'
    ), 0) + v_estimate.maximum_output_bytes > 10737418240
  THEN RAISE EXCEPTION 'repository copy quota exceeded'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_repository_copy_job_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.estimate_id <> OLD.estimate_id
    OR NEW.source_dataset_id <> OLD.source_dataset_id
    OR NEW.destination_dataset_id <> OLD.destination_dataset_id
    OR NEW.destination_bucket <> OLD.destination_bucket
    OR NEW.rights_basis <> OLD.rights_basis OR NEW.attribution <> OLD.attribution
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  THEN RAISE EXCEPTION 'repository copy request seal is immutable'; END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'repository copy terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_repository_copy_lineage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repository object copy lineage is immutable';
END;
$$;

CREATE FUNCTION app.prevent_active_repository_copy_detach()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.repository_object_copy_jobs job
    WHERE job.organization_id = OLD.organization_id
      AND job.project_id = OLD.project_id
      AND (job.source_dataset_id = OLD.dataset_id
        OR job.destination_dataset_id = OLD.dataset_id)
      AND job.state IN ('queued', 'running')
  ) THEN RAISE EXCEPTION 'project dataset has active repository copy work'; END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER repository_copy_estimates_validate_insert
  BEFORE INSERT ON app.repository_object_copy_estimates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_repository_copy_estimate_insert();
CREATE TRIGGER repository_copy_estimates_are_immutable
  BEFORE UPDATE OR DELETE ON app.repository_object_copy_estimates
  FOR EACH ROW EXECUTE FUNCTION app.reject_repository_copy_estimate_mutation();
CREATE TRIGGER repository_copy_jobs_validate_insert
  BEFORE INSERT ON app.repository_object_copy_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_repository_copy_job_insert();
CREATE TRIGGER repository_copy_jobs_validate_transition
  BEFORE UPDATE ON app.repository_object_copy_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_repository_copy_job_transition();
CREATE TRIGGER project_datasets_repository_copy_detach_guard
  BEFORE DELETE ON app.project_datasets
  FOR EACH ROW EXECUTE FUNCTION app.prevent_active_repository_copy_detach();
CREATE TRIGGER dataset_version_repository_copy_lineage_is_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_version_repository_object_lineage
  FOR EACH ROW EXECUTE FUNCTION app.reject_repository_copy_lineage_mutation();

CREATE FUNCTION app.claim_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text, job_id uuid, organization_id uuid, project_id uuid,
  source_dataset_id uuid, source_owner_user_id uuid, connection_id uuid,
  connection_target_revision bigint, credential_revision bigint,
  credential_mode text, role_arn text, secret_arn text,
  source_bucket text, source_region text, source_object_key text,
  source_version_id text, source_etag text, source_checksum_sha256 text,
  output_format text, output_content_type text, maximum_output_bytes bigint,
  destination_dataset_id uuid, destination_bucket text,
  output_object_key text, request_checksum_sha256 text, attribution text,
  attempt_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900
  THEN RAISE EXCEPTION 'invalid repository copy claim'; END IF;
  SELECT job.*, estimate.output_format::text AS output_format,
         estimate.output_content_type, estimate.maximum_output_bytes,
         source.connection_id, source.connection_target_revision,
         source.bucket_name, source.region_name,
         source.object_prefix || source.relative_path AS source_object_key,
         source.provider_version_id, source.etag,
         source.provider_checksum_sha256, source.created_by AS source_owner_user_id,
         connection.credential_revision,
         connection.credential_mode::text AS credential_mode,
         connection.role_arn, connection.secret_arn,
         connection.status::text AS connection_status,
         connection.target_revision AS current_target_revision
  INTO v_job
  FROM app.repository_object_copy_jobs job
  JOIN app.repository_object_copy_estimates estimate
    ON estimate.organization_id = job.organization_id AND estimate.id = job.estimate_id
  JOIN app.repository_object_sources source
    ON source.organization_id = job.organization_id
   AND source.dataset_id = job.source_dataset_id
  JOIN app.user_dataset_connections connection
    ON connection.organization_id = source.organization_id
   AND connection.id = source.connection_id
   AND connection.owner_user_id = source.created_by
  WHERE job.id = p_job_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_job_id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint,
      NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    claim_status := 'already_' || v_job.state::text;
  ELSIF v_job.connection_status <> 'verified'
    OR v_job.current_target_revision <> v_job.connection_target_revision
    OR (v_job.credential_mode <> 'workload_identity'
      AND (v_job.credential_revision <= 0 OR v_job.secret_arn IS NULL))
  THEN
    UPDATE app.repository_object_copy_jobs
    SET state = 'failed', error_code = 'source_connection_unavailable',
        worker_token = NULL, lease_expires_at = NULL,
        last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSIF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSIF v_job.attempt_count >= 3 THEN
    UPDATE app.repository_object_copy_jobs
    SET state = 'failed', error_code = 'retry_exhausted',
        worker_token = NULL, lease_expires_at = NULL,
        last_heartbeat_at = NULL, finished_at = v_now
    WHERE id = v_job.id;
    claim_status := 'already_failed';
  ELSE
    UPDATE app.repository_object_copy_jobs target
    SET state = 'running', worker_token = p_worker_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_heartbeat_at = v_now, attempt_count = target.attempt_count + 1,
        started_at = COALESCE(target.started_at, v_now),
        finished_at = NULL, error_code = NULL
    WHERE target.id = v_job.id
    RETURNING target.attempt_count INTO v_job.attempt_count;
    claim_status := 'claimed';
  END IF;
  IF claim_status <> 'claimed' THEN
    RETURN QUERY SELECT claim_status, v_job.id, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint,
      NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT claim_status, v_job.id, v_job.organization_id,
    v_job.project_id, v_job.source_dataset_id, v_job.source_owner_user_id,
    v_job.connection_id, v_job.connection_target_revision,
    v_job.credential_revision, v_job.credential_mode, v_job.role_arn,
    v_job.secret_arn, v_job.bucket_name, v_job.region_name,
    v_job.source_object_key, v_job.provider_version_id, v_job.etag,
    v_job.provider_checksum_sha256, v_job.output_format,
    v_job.output_content_type, v_job.maximum_output_bytes,
    v_job.destination_dataset_id, v_job.destination_bucket,
    format(
      'organizations/%s/projects/%s/datasets/%s/uploads/%s/original/source.%s',
      v_job.organization_id, v_job.project_id, v_job.destination_dataset_id, v_job.id,
      CASE v_job.output_format
        WHEN 'geojson' THEN 'geojson' WHEN 'csv' THEN 'csv'
        WHEN 'shapefile' THEN 'zip' WHEN 'geopackage' THEN 'gpkg'
        WHEN 'geoparquet' THEN 'parquet' WHEN 'cog' THEN 'tif'
        WHEN 'pmtiles' THEN 'pmtiles' WHEN 'png' THEN 'png'
        WHEN 'jpeg' THEN 'jpg' WHEN 'pdf' THEN 'pdf' WHEN 'odt' THEN 'odt'
      END
    ), v_job.request_checksum_sha256, v_job.attribution, v_job.attempt_count;
END;
$$;

CREATE FUNCTION app.heartbeat_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 900 THEN RETURN false; END IF;
  UPDATE app.repository_object_copy_jobs
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
    AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.complete_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job app.repository_object_copy_jobs%ROWTYPE;
  v_estimate app.repository_object_copy_estimates%ROWTYPE;
  v_object_id uuid;
  v_version_id uuid := gen_random_uuid();
  v_processing_job_id uuid := gen_random_uuid();
  v_expected_key text;
  v_filename text;
BEGIN
  SELECT * INTO v_job FROM app.repository_object_copy_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp()
  THEN RETURN false; END IF;
  SELECT * INTO v_estimate FROM app.repository_object_copy_estimates
  WHERE organization_id = v_job.organization_id AND id = v_job.estimate_id;
  v_filename := 'source.' || CASE v_estimate.output_format::text
    WHEN 'geojson' THEN 'geojson' WHEN 'csv' THEN 'csv'
    WHEN 'shapefile' THEN 'zip' WHEN 'geopackage' THEN 'gpkg'
    WHEN 'geoparquet' THEN 'parquet' WHEN 'cog' THEN 'tif'
    WHEN 'pmtiles' THEN 'pmtiles' WHEN 'png' THEN 'png'
    WHEN 'jpeg' THEN 'jpg' WHEN 'pdf' THEN 'pdf' WHEN 'odt' THEN 'odt'
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
    OR (p_artifact->>'size_bytes')::bigint <> v_estimate.maximum_output_bytes
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid repository copy artifact'; END IF;
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
     v_object_id, 'queued', 'Protected copy of exact repository object version',
     v_job.created_by);
  UPDATE app.datasets
  SET status = 'processing', current_version_id = v_version_id,
      updated_by = v_job.created_by, updated_at = clock_timestamp()
  WHERE organization_id = v_job.organization_id
    AND id = v_job.destination_dataset_id AND status = 'draft'
    AND current_version_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'repository copy destination changed'; END IF;
  INSERT INTO app.processing_jobs
    (id, organization_id, project_id, dataset_id, dataset_version_id,
     job_type, parameters, created_by)
  VALUES
    (v_processing_job_id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_version_id, 'dataset.ingest',
     jsonb_build_object(
       'upload_id', v_job.id, 'object_id', v_object_id,
       's3_version_id', p_artifact->>'s3_version_id',
       'repository_object_copy_job_id', v_job.id
     ), v_job.created_by);
  INSERT INTO app.dataset_version_repository_object_lineage
    (organization_id, destination_dataset_id, destination_dataset_version_id,
     source_dataset_id, copy_job_id, retrieved_at)
  VALUES
    (v_job.organization_id, v_job.destination_dataset_id, v_version_id,
     v_job.source_dataset_id, v_job.id, clock_timestamp());
  UPDATE app.repository_object_copy_jobs
  SET state = 'completed', output_object_id = v_object_id,
      output_dataset_version_id = v_version_id, error_code = NULL,
      worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'dataset.repository.copy.completed', 'dataset', v_job.destination_dataset_id,
     v_job.request_id, jsonb_build_object(
       'copy_job_id', v_job.id, 'source_dataset_id', v_job.source_dataset_id,
       'destination_dataset_version_id', v_version_id,
       'output_checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
  THEN RETURN false; END IF;
  UPDATE app.repository_object_copy_jobs
  SET state = 'failed', error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_repository_object_copy(
  p_job_id uuid, p_worker_token uuid, p_error_code text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_attempt integer;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
  THEN RETURN 'lost'; END IF;
  SELECT attempt_count INTO v_attempt FROM app.repository_object_copy_jobs
  WHERE id = p_job_id AND state = 'running' AND worker_token = p_worker_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  UPDATE app.repository_object_copy_jobs
  SET state = CASE WHEN v_attempt >= 3 THEN 'failed'::app.processing_job_state
                   ELSE 'queued'::app.processing_job_state END,
      error_code = CASE WHEN v_attempt >= 3 THEN p_error_code ELSE NULL END,
      worker_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_attempt >= 3 THEN clock_timestamp() ELSE NULL END
  WHERE id = p_job_id;
  RETURN CASE WHEN v_attempt >= 3 THEN 'failed' ELSE 'queued' END;
END;
$$;

CREATE FUNCTION app.get_completed_repository_object_copy_artifact(p_job_id uuid)
RETURNS TABLE (
  job_id uuid, object_id uuid, bucket text, object_key text,
  s3_version_id text, etag text, content_type text,
  size_bytes bigint, checksum_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
  SELECT job.id, object.id, object.bucket, object.object_key,
         object.s3_version_id, object.etag, object.content_type,
         object.size_bytes, object.checksum_sha256
  FROM app.repository_object_copy_jobs job
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.output_object_id
  WHERE job.id = p_job_id AND job.state = 'completed';
$$;

CREATE FUNCTION app.cancel_repository_object_copy(
  p_organization_id uuid, p_project_id uuid, p_source_dataset_id uuid,
  p_job_id uuid, p_actor_user_id uuid, p_request_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE v_dataset_id uuid;
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR COALESCE(app.effective_project_role(p_project_id, p_actor_user_id)::text, '')
      NOT IN ('owner', 'editor')
    OR p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RETURN false; END IF;
  UPDATE app.repository_object_copy_jobs
  SET state = 'cancelled', error_code = 'cancelled_by_user',
      finished_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND source_dataset_id = p_source_dataset_id AND id = p_job_id
    AND state = 'queued'
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
     'dataset.repository.copy.cancelled', 'dataset', v_dataset_id, p_request_id,
     jsonb_build_object('copy_job_id', p_job_id,
                        'source_dataset_id', p_source_dataset_id));
  RETURN true;
END;
$$;

ALTER TABLE app.repository_object_copy_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repository_object_copy_estimates FORCE ROW LEVEL SECURITY;
ALTER TABLE app.repository_object_copy_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repository_object_copy_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_repository_object_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_repository_object_lineage FORCE ROW LEVEL SECURITY;

CREATE POLICY repository_object_copy_estimates_tenant_isolation
  ON app.repository_object_copy_estimates
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY repository_object_copy_jobs_tenant_isolation
  ON app.repository_object_copy_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_version_repository_object_lineage_tenant_isolation
  ON app.dataset_version_repository_object_lineage
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.repository_object_copy_estimates,
  app.repository_object_copy_jobs TO opengeo_runtime;
GRANT SELECT ON app.dataset_version_repository_object_lineage TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.repository_object_copy_estimates,
  app.repository_object_copy_jobs,
  app.dataset_version_repository_object_lineage FROM opengeo_runtime;

REVOKE ALL ON app.repository_object_copy_estimates,
  app.repository_object_copy_jobs,
  app.dataset_version_repository_object_lineage
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator,
  opengeo_dataset_verifier, opengeo_source_archiver, opengeo_repository_copier;

REVOKE EXECUTE ON FUNCTION
  app.enforce_repository_copy_estimate_insert(),
  app.reject_repository_copy_estimate_mutation(),
  app.enforce_repository_copy_job_insert(),
  app.enforce_repository_copy_job_transition(),
  app.reject_repository_copy_lineage_mutation(),
  app.prevent_active_repository_copy_detach(),
  app.claim_repository_object_copy(uuid, uuid, integer),
  app.heartbeat_repository_object_copy(uuid, uuid, integer),
  app.complete_repository_object_copy(uuid, uuid, jsonb),
  app.fail_repository_object_copy(uuid, uuid, text),
  app.release_repository_object_copy(uuid, uuid, text),
  app.get_completed_repository_object_copy_artifact(uuid),
  app.cancel_repository_object_copy(uuid, uuid, uuid, uuid, uuid, text)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_dataset_verifier,
  opengeo_source_archiver, opengeo_repository_copier;

GRANT EXECUTE ON FUNCTION
  app.claim_repository_object_copy(uuid, uuid, integer),
  app.heartbeat_repository_object_copy(uuid, uuid, integer),
  app.complete_repository_object_copy(uuid, uuid, jsonb),
  app.fail_repository_object_copy(uuid, uuid, text),
  app.release_repository_object_copy(uuid, uuid, text),
  app.get_completed_repository_object_copy_artifact(uuid)
TO opengeo_repository_copier;
GRANT EXECUTE ON FUNCTION
  app.cancel_repository_object_copy(uuid, uuid, uuid, uuid, uuid, text)
TO opengeo_runtime;

COMMENT ON TABLE app.repository_object_copy_estimates IS
  'Short-lived, server-sealed size and cost review for copying one exact registered repository object version.';
COMMENT ON TABLE app.repository_object_copy_jobs IS
  'Durable, bounded request to copy one exact connected repository object into immutable managed storage.';
COMMENT ON TABLE app.dataset_version_repository_object_lineage IS
  'Immutable lineage from one managed dataset version to the exact registered repository source and custody job.';
COMMENT ON FUNCTION app.claim_repository_object_copy(uuid, uuid, integer) IS
  'Function-only repository copier claim. Returns source authority only after current connection and target revision checks.';

COMMIT;
