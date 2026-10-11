BEGIN;
ALTER TABLE app.external_source_snapshot_jobs ADD COLUMN staged_base_version_id uuid,
  ADD CONSTRAINT snapshot_staged_base_same_layer FOREIGN KEY
    (organization_id, destination_dataset_id, staged_base_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id);
COMMENT ON COLUMN app.external_source_snapshot_jobs.staged_base_version_id IS
 'Opt-in refresh of an existing managed capture of the same upstream Layer. Keeps current version until reviewed acceptance; never converts a remote reference into hosted data.';

CREATE OR REPLACE FUNCTION app.enforce_external_source_snapshot_insert()
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
  WHERE organization_id = NEW.organization_id AND id = NEW.destination_dataset_id FOR UPDATE;
  IF NOT FOUND OR v_estimate.project_id <> NEW.project_id
    OR v_estimate.source_dataset_id <> NEW.source_dataset_id
    OR v_estimate.source_revision_number <> NEW.source_revision_number
    OR v_estimate.created_by <> NEW.created_by
    OR v_estimate.expires_at <= clock_timestamp()
    OR v_destination.source_type <> 'upload'
    OR v_destination.format <> v_estimate.output_format
    OR (NEW.staged_base_version_id IS NULL AND (
      v_destination.status <> 'draft' OR v_destination.current_version_id IS NOT NULL
      OR v_destination.owner_user_id <> NEW.created_by))
    OR (NEW.staged_base_version_id IS NOT NULL AND (
      v_estimate.copy_method::text <> 'bounded_feature_capture'
      OR v_destination.status <> 'active'
      OR v_destination.current_version_id IS DISTINCT FROM NEW.staged_base_version_id
      OR NOT EXISTS (
        SELECT 1 FROM app.dataset_versions version
        JOIN app.dataset_version_external_source_lineage lineage
          ON lineage.organization_id=version.organization_id
         AND lineage.destination_dataset_version_id=version.id
         AND lineage.destination_dataset_id=version.dataset_id
        WHERE version.organization_id=NEW.organization_id
          AND version.dataset_id=NEW.destination_dataset_id
          AND version.id=NEW.staged_base_version_id AND version.state='active'
          AND lineage.source_dataset_id=NEW.source_dataset_id
      )))
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

CREATE OR REPLACE FUNCTION app.enforce_external_source_snapshot_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.estimate_id <> OLD.estimate_id
    OR NEW.source_dataset_id <> OLD.source_dataset_id
    OR NEW.source_revision_number <> OLD.source_revision_number
    OR NEW.staged_base_version_id IS DISTINCT FROM OLD.staged_base_version_id
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

CREATE OR REPLACE FUNCTION app.complete_external_source_snapshot_without_counts(
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
  v_version_number bigint := 1;
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
  IF v_job.staged_base_version_id IS NOT NULL THEN
    PERFORM 1 FROM app.datasets WHERE organization_id=v_job.organization_id
      AND id=v_job.destination_dataset_id AND status='active'
      AND current_version_id=v_job.staged_base_version_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source refresh base changed'; END IF;
    SELECT COALESCE(max(version_number),0)+1 INTO v_version_number
      FROM app.dataset_versions WHERE organization_id=v_job.organization_id
        AND dataset_id=v_job.destination_dataset_id;
  END IF;
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
     bucket, object_key, state, expires_at, completed_at, completed_object_id, staged_base_version_id)
  VALUES
    (v_job.id, v_job.organization_id, v_job.project_id,
     v_job.destination_dataset_id, v_job.created_by, v_filename,
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', p_artifact->>'bucket',
     p_artifact->>'object_key', 'completed', clock_timestamp() + interval '1 day',
     clock_timestamp(), v_object_id, v_job.staged_base_version_id);
  INSERT INTO app.dataset_versions
    (id, organization_id, dataset_id, version_number, parent_version_id,
     original_object_id, state, change_message, created_by)
  VALUES
    (v_version_id, v_job.organization_id, v_job.destination_dataset_id, v_version_number, v_job.staged_base_version_id,
     v_object_id, 'queued', 'Protected copy of external source revision',
     v_job.created_by);
  IF v_job.staged_base_version_id IS NULL THEN
  UPDATE app.datasets
  SET status = 'processing', current_version_id = v_version_id,
      updated_by = v_job.created_by
  WHERE organization_id = v_job.organization_id
    AND id = v_job.destination_dataset_id AND status = 'draft'
    AND current_version_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'source snapshot destination changed'; END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION app.fail_external_source_snapshot(
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
    AND dataset_id = v_destination_dataset_id
    AND EXISTS (SELECT 1 FROM app.external_source_snapshot_jobs job
      WHERE job.id=p_job_id AND job.staged_base_version_id IS NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.release_external_source_snapshot(
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
      AND link.dataset_id = job.destination_dataset_id
      AND job.staged_base_version_id IS NULL;
  END IF;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION app.cancel_external_source_snapshot(
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
    AND dataset_id = v_dataset_id
    AND EXISTS (SELECT 1 FROM app.external_source_snapshot_jobs job
      WHERE job.id=p_job_id AND job.staged_base_version_id IS NULL);
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
COMMIT;
