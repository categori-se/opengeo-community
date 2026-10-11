BEGIN;

CREATE TABLE app.source_capture_count_evidence (
  snapshot_job_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  original_object_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, snapshot_job_id)
    REFERENCES app.external_source_snapshot_jobs(organization_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, original_object_id)
    REFERENCES app.data_objects(organization_id, id)
);
CREATE TRIGGER source_capture_counts_immutable
  BEFORE UPDATE OR DELETE ON app.source_capture_count_evidence
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.source_capture_count_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.source_capture_count_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY source_capture_counts_tenant ON app.source_capture_count_evidence
  USING (organization_id = app.current_organization_id());
GRANT SELECT ON app.source_capture_count_evidence TO opengeo_runtime;
REVOKE ALL ON app.source_capture_count_evidence FROM opengeo_worker, opengeo_source_archiver;

-- Preserve the working completion implementation; only the wrapper is callable by the service.
ALTER FUNCTION app.complete_external_source_snapshot(uuid, uuid, jsonb)
  RENAME TO complete_external_source_snapshot_without_counts;
REVOKE ALL ON FUNCTION app.complete_external_source_snapshot_without_counts(uuid, uuid, jsonb)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_source_archiver;

CREATE FUNCTION app.complete_external_source_snapshot(
  p_job_id uuid, p_worker_token uuid, p_artifact jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off
AS $$
DECLARE
  v_job app.external_source_snapshot_jobs%ROWTYPE;
  v_estimate app.external_source_copy_estimates%ROWTYPE;
  v_evidence jsonb := p_artifact->'count_evidence';
  v_source_type text;
  v_fetched bigint;
  v_matched bigint;
  v_maximum bigint;
BEGIN
  SELECT * INTO v_job FROM app.external_source_snapshot_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token IS DISTINCT FROM p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  IF v_evidence IS NOT NULL THEN
    SELECT * INTO STRICT v_estimate FROM app.external_source_copy_estimates
      WHERE organization_id = v_job.organization_id AND id = v_job.estimate_id;
    SELECT source_type::text INTO v_source_type FROM app.external_sources
      WHERE organization_id = v_job.organization_id AND dataset_id = v_job.source_dataset_id;
    IF jsonb_typeof(v_evidence) IS DISTINCT FROM 'object'
      OR octet_length(v_evidence::text) > 4096
      OR v_estimate.copy_method::text <> 'bounded_feature_capture'
      OR v_evidence->>'schemaVersion' IS DISTINCT FROM 'opengeo.feature-capture-counts.1.0.0'
      OR v_evidence->'scope' IS DISTINCT FROM v_estimate.capture_scope
      OR v_evidence->>'sourceType' IS DISTINCT FROM v_source_type
      OR jsonb_typeof(v_evidence->'fetchedCount') IS DISTINCT FROM 'number'
      OR (v_evidence->>'fetchedCount') !~ '^[0-9]{1,5}$'
    THEN RAISE EXCEPTION 'invalid capture count evidence'; END IF;
    v_fetched := (v_evidence->>'fetchedCount')::bigint;
    v_maximum := (v_estimate.capture_scope->>'maximum_features')::bigint;
    IF v_fetched > v_maximum THEN RAISE EXCEPTION 'capture exceeds approved count'; END IF;
    IF v_evidence->'numberMatched' = 'null'::jsonb THEN
      IF v_evidence->>'countStatus' IS DISTINCT FROM 'unknown'
        OR v_evidence->'limitedByMaximumFeatures' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'unknown capture count misrepresented'; END IF;
    ELSE
      IF jsonb_typeof(v_evidence->'numberMatched') IS DISTINCT FROM 'number'
        OR (v_evidence->>'numberMatched') !~ '^[0-9]{1,16}$'
      THEN RAISE EXCEPTION 'invalid matched count'; END IF;
      v_matched := (v_evidence->>'numberMatched')::bigint;
      IF v_matched > 9007199254740991 OR v_fetched <> least(v_matched, v_maximum)
        OR v_evidence->>'countStatus' IS DISTINCT FROM 'matched_bounded_scope'
        OR v_evidence->'limitedByMaximumFeatures' IS DISTINCT FROM to_jsonb(v_matched > v_maximum)
      THEN RAISE EXCEPTION 'capture count mismatch'; END IF;
    END IF;
  END IF;
  IF NOT app.complete_external_source_snapshot_without_counts(p_job_id, p_worker_token, p_artifact)
    THEN RETURN false; END IF;
  IF v_evidence IS NOT NULL THEN
    INSERT INTO app.source_capture_count_evidence
      (snapshot_job_id, organization_id, dataset_id, dataset_version_id, original_object_id, evidence)
    SELECT id, organization_id, destination_dataset_id, output_dataset_version_id,
      output_object_id, v_evidence
    FROM app.external_source_snapshot_jobs WHERE id = p_job_id AND state = 'completed';
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.complete_external_source_snapshot(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_external_source_snapshot(uuid, uuid, jsonb)
  TO opengeo_source_archiver;
COMMENT ON TABLE app.source_capture_count_evidence IS
 'Immutable server capture summary bound atomically to completed job, version and original object. Uploaded GeoJSON foreign members are never authority. Legacy captures may lack evidence.';
COMMIT;
