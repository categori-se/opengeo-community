BEGIN;

ALTER TABLE app.map_render_jobs
  ADD COLUMN composition_sealed boolean NOT NULL DEFAULT true;

CREATE TABLE app.map_render_job_layers (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  render_job_id uuid NOT NULL,
  position smallint NOT NULL,
  resource_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, render_job_id, position),
  UNIQUE (organization_id, render_job_id, resource_id),
  CONSTRAINT map_render_job_layers_position_bounded CHECK (position BETWEEN 1 AND 16),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_jobs (organization_id, id),
  FOREIGN KEY (organization_id, profile_id, resource_id)
    REFERENCES app.map_render_profiles (organization_id, id, resource_id),
  FOREIGN KEY (organization_id, profile_id, profile_version_id)
    REFERENCES app.map_render_profile_versions (organization_id, profile_id, id)
);

INSERT INTO app.map_render_job_layers
  (organization_id, render_job_id, position, resource_id, profile_id, profile_version_id)
SELECT organization_id, id, 1, resource_id, profile_id, profile_version_id
FROM app.map_render_jobs;

CREATE FUNCTION app.enforce_map_render_job_layer_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_job app.map_render_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM app.map_render_jobs
  WHERE organization_id = NEW.organization_id AND id = NEW.render_job_id;
  IF NOT FOUND OR v_job.state <> 'queued' THEN
    RAISE EXCEPTION 'map render composition is not open';
  END IF;
  IF v_job.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'map render composition creator mismatch';
  END IF;
  IF NEW.position = 1 THEN
    IF NEW.resource_id <> v_job.resource_id
      OR NEW.profile_id <> v_job.profile_id
      OR NEW.profile_version_id <> v_job.profile_version_id
    THEN
      RAISE EXCEPTION 'map render composition anchor mismatch';
    END IF;
  ELSIF v_job.composition_sealed THEN
    RAISE EXCEPTION 'map render composition is sealed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_job_layers_validate_insert
  BEFORE INSERT ON app.map_render_job_layers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_map_render_job_layer_insert();
CREATE TRIGGER map_render_job_layers_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_render_job_layers
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

CREATE FUNCTION app.add_map_render_job_anchor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO app.map_render_job_layers
    (organization_id, render_job_id, position, resource_id, profile_id, profile_version_id)
  VALUES
    (NEW.organization_id, NEW.id, 1, NEW.resource_id, NEW.profile_id,
     NEW.profile_version_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_jobs_add_composition_anchor
  AFTER INSERT ON app.map_render_jobs
  FOR EACH ROW EXECUTE FUNCTION app.add_map_render_job_anchor();

CREATE FUNCTION app.enforce_map_render_composition_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_min smallint;
  v_max smallint;
BEGIN
  IF OLD.composition_sealed AND NOT NEW.composition_sealed THEN
    RAISE EXCEPTION 'map render composition cannot be reopened';
  END IF;
  IF NOT OLD.composition_sealed AND NEW.composition_sealed THEN
    SELECT count(*), min(position), max(position)
    INTO v_count, v_min, v_max
    FROM app.map_render_job_layers
    WHERE organization_id = NEW.organization_id AND render_job_id = NEW.id;
    IF v_count NOT BETWEEN 2 AND 16 OR v_min <> 1 OR v_max <> v_count THEN
      RAISE EXCEPTION 'map render composition is incomplete';
    END IF;
  END IF;
  IF NEW.state <> 'queued' AND NOT NEW.composition_sealed THEN
    RAISE EXCEPTION 'unsealed map render composition cannot transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_jobs_enforce_composition_transition
  BEFORE UPDATE ON app.map_render_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_map_render_composition_transition();

CREATE FUNCTION app.seal_map_render_composition(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_updated uuid;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'invalid map render composition';
  END IF;
  UPDATE app.map_render_jobs
  SET composition_sealed = true
  WHERE id = p_job_id
    AND organization_id = app.current_organization_id()
    AND created_by = app.current_user_id()
    AND state = 'queued'
    AND NOT composition_sealed
  RETURNING id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

CREATE FUNCTION app.get_map_render_layers(
  p_job_id uuid,
  p_worker_token uuid
)
RETURNS TABLE (
  layer_position smallint,
  resource_id uuid,
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
  profile_id uuid,
  profile_version_id uuid,
  style_id uuid,
  style_version_id uuid,
  configuration jsonb,
  configuration_checksum_sha256 text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT layer.position, layer.resource_id,
         profile.dataset_id, profile.dataset_version_id,
         source.id, source.bucket, source.object_key, source.s3_version_id,
         source.etag, source.content_type, source.size_bytes, source.checksum_sha256,
         layer.profile_id, layer.profile_version_id,
         profile.style_id, profile.style_version_id,
         profile.configuration, profile.checksum_sha256
  FROM app.map_render_jobs job
  JOIN app.map_render_job_layers layer
    ON layer.organization_id = job.organization_id
   AND layer.render_job_id = job.id
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = layer.organization_id
   AND profile.profile_id = layer.profile_id
   AND profile.id = layer.profile_version_id
  JOIN LATERAL (
    SELECT object.id, object.bucket, object.object_key, object.s3_version_id,
           object.etag, object.content_type, object.size_bytes, object.checksum_sha256
    FROM app.dataset_version_objects link
    JOIN app.data_objects object
      ON object.organization_id = link.organization_id
     AND object.id = link.data_object_id
    WHERE link.organization_id = profile.organization_id
      AND link.dataset_id = profile.dataset_id
      AND link.dataset_version_id = profile.dataset_version_id
      AND object.role = 'derived'
      AND object.content_type = 'application/geo+json'
      AND object.size_bytes BETWEEN 1 AND 16777216
      AND object.object_key LIKE '%/derivatives/preview/preview.geojson'
    ORDER BY object.id
    LIMIT 1
  ) source ON true
  WHERE job.id = p_job_id
    AND job.state = 'running'
    AND job.worker_token = p_worker_token
    AND job.composition_sealed
  ORDER BY layer.position;
$$;

ALTER TABLE app.map_render_job_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_job_layers FORCE ROW LEVEL SECURITY;
CREATE POLICY map_render_job_layers_tenant_isolation ON app.map_render_job_layers
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON app.map_render_job_layers TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.map_render_job_layers FROM opengeo_runtime;
REVOKE ALL ON app.map_render_job_layers FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_map_render_job_layer_insert(),
  app.add_map_render_job_anchor(),
  app.enforce_map_render_composition_transition(),
  app.seal_map_render_composition(uuid),
  app.get_map_render_layers(uuid, uuid)
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  app.seal_map_render_composition(uuid),
  app.get_map_render_layers(uuid, uuid)
FROM opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.seal_map_render_composition(uuid) TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.get_map_render_layers(uuid, uuid) TO opengeo_worker;

COMMENT ON COLUMN app.map_render_jobs.composition_sealed IS
  'True only when the ordered append-only layer snapshot is complete and claimable.';
COMMENT ON TABLE app.map_render_job_layers IS
  'Immutable bottom-to-top resource/profile snapshots for one deterministic map render.';
COMMENT ON FUNCTION app.get_map_render_layers(uuid, uuid) IS
  'Return exact ordered layer sources and configurations only to the active render lease.';

COMMIT;
