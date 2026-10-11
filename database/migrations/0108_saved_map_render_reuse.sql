BEGIN;

CREATE TABLE app.saved_map_render_reuse (
  organization_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  render_job_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_job_bindings(organization_id, render_job_id)
);
ALTER TABLE app.saved_map_render_reuse ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.saved_map_render_reuse FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_map_reuse_tenant ON app.saved_map_render_reuse
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.saved_map_render_reuse TO opengeo_runtime;
REVOKE ALL ON app.saved_map_render_reuse FROM opengeo_worker;
CREATE TRIGGER saved_map_reuse_is_immutable BEFORE UPDATE OR DELETE ON app.saved_map_render_reuse
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

-- Both tables share the request-key namespace. The lock is transaction-local;
-- hash collisions only serialize unrelated requests, never identify an output.
CREATE FUNCTION app.check_map_render_request_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'opengeo.map-render.request:' || NEW.organization_id::text || ':' || NEW.idempotency_key::text, 0));
  IF TG_TABLE_NAME = 'map_render_jobs' THEN
    IF EXISTS (SELECT 1 FROM app.saved_map_render_reuse
               WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key)
    THEN RAISE EXCEPTION 'render request key already retained' USING ERRCODE = '23505'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM app.map_render_jobs
               WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key)
    THEN RAISE EXCEPTION 'render request key already used' USING ERRCODE = '23505'; END IF;
    IF NOT EXISTS (SELECT 1 FROM app.map_render_jobs
                   WHERE organization_id = NEW.organization_id AND id = NEW.render_job_id
                     AND state = 'completed' AND composition_sealed AND output_object_id IS NOT NULL)
    THEN RAISE EXCEPTION 'only completed saved-map output can be reused'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER map_render_request_key BEFORE INSERT ON app.map_render_jobs
  FOR EACH ROW EXECUTE FUNCTION app.check_map_render_request_key();
CREATE TRIGGER saved_map_reuse_request_key BEFORE INSERT ON app.saved_map_render_reuse
  FOR EACH ROW EXECUTE FUNCTION app.check_map_render_request_key();
CREATE INDEX completed_saved_map_inputs_idx ON app.map_render_jobs
  (organization_id, resource_id, request_checksum_sha256, finished_at DESC, id DESC)
  WHERE state = 'completed' AND composition_sealed AND output_object_id IS NOT NULL;
COMMENT ON TABLE app.saved_map_render_reuse IS
  'Immutable retry keys for completed saved-map reuse. Input equality and current authorization remain API checks; no new job, profile, object or permission is created.';
COMMIT;
