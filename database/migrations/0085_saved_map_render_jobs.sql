BEGIN;

CREATE TABLE app.map_render_job_bindings (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  render_job_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  recipe jsonb NOT NULL,
  recipe_checksum_sha256 text NOT NULL CHECK (recipe_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  definition_checksum_sha256 text NOT NULL CHECK (definition_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id, render_job_id),
  CHECK (jsonb_typeof(recipe) = 'object' AND octet_length(recipe::text) BETWEEN 2 AND 131072),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_jobs (organization_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.map_resource_version_bindings (organization_id, resource_id, resource_version_id)
);

CREATE TABLE app.map_render_job_source_pins (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  render_job_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 16),
  source_resource_id uuid NOT NULL,
  source_resource_version_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  source_object_id uuid NOT NULL,
  source_s3_version_id text NOT NULL CHECK (source_s3_version_id NOT IN ('', 'null')),
  source_checksum_sha256 text NOT NULL CHECK (source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id, render_job_id, position),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_job_bindings (organization_id, render_job_id),
  FOREIGN KEY (organization_id, render_job_id, position)
    REFERENCES app.map_render_job_layers (organization_id, render_job_id, position),
  FOREIGN KEY (organization_id, source_resource_id, source_resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, dataset_version_id, source_object_id)
    REFERENCES app.dataset_version_objects (organization_id, dataset_version_id, data_object_id),
  FOREIGN KEY (organization_id, source_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

-- Lock the job before accepting another layer so sealing cannot race a late
-- layer insert. The caller still must be the queued job's current tenant actor.
CREATE OR REPLACE FUNCTION app.enforce_map_render_job_layer_insert()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.map_render_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM app.map_render_jobs
  WHERE organization_id = NEW.organization_id AND id = NEW.render_job_id
    AND organization_id = app.current_organization_id()
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'queued' THEN
    RAISE EXCEPTION 'map render composition is not open';
  END IF;
  IF v_job.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'map render composition creator mismatch';
  END IF;
  IF NEW.position = 1 THEN
    IF NEW.resource_id <> v_job.resource_id OR NEW.profile_id <> v_job.profile_id
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

CREATE FUNCTION app.validate_map_render_job_binding()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  PERFORM 1
  FROM app.map_render_jobs job
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = job.organization_id
   AND profile.profile_id = job.profile_id AND profile.id = job.profile_version_id
  WHERE job.organization_id = NEW.organization_id
    AND job.organization_id = app.current_organization_id()
    AND job.id = NEW.render_job_id AND job.resource_id = NEW.resource_id
    AND job.created_by = app.current_user_id()
    AND job.state = 'queued' AND NOT job.composition_sealed
    AND profile.resource_id = NEW.resource_id
    AND profile.resource_version_id = NEW.resource_version_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'saved map render binding requires its creator and an open matching map profile';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.validate_map_render_job_source_pin()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT job.project_id INTO v_project_id
  FROM app.map_render_jobs job
  JOIN app.map_render_job_bindings binding
    ON binding.organization_id = job.organization_id AND binding.render_job_id = job.id
  JOIN app.map_render_job_layers layer
    ON layer.organization_id = job.organization_id AND layer.render_job_id = job.id
   AND layer.position = NEW.position
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = layer.organization_id
   AND profile.profile_id = layer.profile_id AND profile.id = layer.profile_version_id
  WHERE job.organization_id = NEW.organization_id
    AND job.organization_id = app.current_organization_id()
    AND job.id = NEW.render_job_id AND job.created_by = app.current_user_id()
    AND job.state = 'queued' AND NOT job.composition_sealed
    AND layer.resource_id = binding.resource_id
    AND profile.resource_id = binding.resource_id
    AND profile.resource_version_id = binding.resource_version_id
    AND profile.dataset_id = NEW.dataset_id AND profile.dataset_version_id = NEW.dataset_version_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'saved map source pin requires its creator and an open matching layer profile';
  END IF;

  PERFORM 1
  FROM app.governed_resources resource
  JOIN app.governed_resource_versions version
    ON version.organization_id = resource.organization_id
   AND version.resource_id = resource.id AND version.id = NEW.source_resource_version_id
  JOIN app.project_datasets project_dataset
    ON project_dataset.organization_id = resource.organization_id
   AND project_dataset.project_id = resource.project_id
   AND project_dataset.dataset_id = NEW.dataset_id
  JOIN app.datasets dataset
    ON dataset.organization_id = resource.organization_id
   AND dataset.id = NEW.dataset_id AND dataset.status = 'active'
  JOIN app.dataset_versions dataset_version
    ON dataset_version.organization_id = resource.organization_id
   AND dataset_version.dataset_id = NEW.dataset_id
   AND dataset_version.id = NEW.dataset_version_id AND dataset_version.state = 'active'
  JOIN app.dataset_version_objects link
    ON link.organization_id = dataset_version.organization_id
   AND link.dataset_id = dataset_version.dataset_id AND link.dataset_version_id = dataset_version.id
   AND link.data_object_id = NEW.source_object_id
  JOIN app.data_objects object
    ON object.organization_id = link.organization_id AND object.id = link.data_object_id
   AND object.dataset_id = NEW.dataset_id
  WHERE resource.organization_id = NEW.organization_id
    AND resource.project_id = v_project_id AND resource.id = NEW.source_resource_id
    AND resource.kind = 'dataset' AND resource.dataset_id = NEW.dataset_id
    AND resource.state <> 'archived'
    AND object.role = 'derived' AND object.content_type = 'application/geo+json'
    AND object.size_bytes BETWEEN 1 AND 16777216
    AND object.object_key LIKE '%/derivatives/preview/preview.geojson'
    AND object.s3_version_id = NEW.source_s3_version_id
    AND object.checksum_sha256 = NEW.source_checksum_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'saved map source pin must match an exact canonical dataset preview';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_job_bindings_validate_insert
  BEFORE INSERT ON app.map_render_job_bindings
  FOR EACH ROW EXECUTE FUNCTION app.validate_map_render_job_binding();
CREATE TRIGGER map_render_job_source_pins_validate_insert
  BEFORE INSERT ON app.map_render_job_source_pins
  FOR EACH ROW EXECUTE FUNCTION app.validate_map_render_job_source_pin();
CREATE TRIGGER map_render_job_bindings_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_render_job_bindings
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER map_render_job_source_pins_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_render_job_source_pins
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.map_render_job_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_job_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_job_source_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_job_source_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY map_render_job_bindings_tenant_isolation ON app.map_render_job_bindings
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY map_render_job_source_pins_tenant_isolation ON app.map_render_job_source_pins
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.map_render_job_bindings, app.map_render_job_source_pins TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.map_render_job_bindings, app.map_render_job_source_pins FROM opengeo_runtime;
REVOKE ALL ON app.map_render_job_bindings, app.map_render_job_source_pins FROM PUBLIC, opengeo_worker;

-- Internal resolver shared by the initial claim, every composition position,
-- and completion's output-bucket check. Map jobs never fall back to discovery.
CREATE FUNCTION app.resolve_map_render_job_source(p_job_id uuid, p_position smallint)
RETURNS TABLE (
  id uuid, bucket text, object_key text, s3_version_id text, etag text,
  content_type text, size_bytes bigint, checksum_sha256 text
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT object.id, object.bucket, object.object_key, object.s3_version_id,
         object.etag, object.content_type, object.size_bytes, object.checksum_sha256
  FROM app.map_render_jobs job
  JOIN app.governed_resources resource
    ON resource.organization_id = job.organization_id AND resource.id = job.resource_id
  JOIN app.map_render_job_layers layer
    ON layer.organization_id = job.organization_id AND layer.render_job_id = job.id
   AND layer.position = p_position
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = layer.organization_id
   AND profile.profile_id = layer.profile_id AND profile.id = layer.profile_version_id
  JOIN app.dataset_version_objects link
    ON link.organization_id = profile.organization_id
   AND link.dataset_id = profile.dataset_id AND link.dataset_version_id = profile.dataset_version_id
  JOIN app.data_objects object
    ON object.organization_id = link.organization_id AND object.id = link.data_object_id
  LEFT JOIN app.map_render_job_bindings binding
    ON binding.organization_id = job.organization_id AND binding.render_job_id = job.id
  LEFT JOIN app.map_render_job_source_pins pin
    ON pin.organization_id = layer.organization_id
   AND pin.render_job_id = layer.render_job_id AND pin.position = layer.position
  WHERE job.id = p_job_id
    AND object.role = 'derived' AND object.content_type = 'application/geo+json'
    AND object.size_bytes BETWEEN 1 AND 16777216
    AND object.object_key LIKE '%/derivatives/preview/preview.geojson'
    AND (
      (resource.kind <> 'map' AND binding.render_job_id IS NULL)
      OR (
        resource.kind = 'map' AND binding.resource_id = job.resource_id
        AND binding.resource_version_id = profile.resource_version_id
        AND profile.resource_id = binding.resource_id
        AND pin.dataset_id = profile.dataset_id AND pin.dataset_version_id = profile.dataset_version_id
        AND pin.source_object_id = object.id AND pin.source_s3_version_id = object.s3_version_id
        AND pin.source_checksum_sha256 = object.checksum_sha256
        AND EXISTS (
          SELECT 1 FROM app.governed_resources source_resource
          JOIN app.governed_resource_versions source_version
            ON source_version.organization_id = source_resource.organization_id
           AND source_version.resource_id = source_resource.id
           AND source_version.id = pin.source_resource_version_id
          JOIN app.project_datasets project_dataset
            ON project_dataset.organization_id = source_resource.organization_id
           AND project_dataset.project_id = job.project_id
           AND project_dataset.dataset_id = pin.dataset_id
          JOIN app.datasets dataset
            ON dataset.organization_id = source_resource.organization_id
           AND dataset.id = pin.dataset_id AND dataset.status = 'active'
          JOIN app.dataset_versions dataset_version
            ON dataset_version.organization_id = dataset.organization_id
           AND dataset_version.dataset_id = dataset.id
           AND dataset_version.id = pin.dataset_version_id AND dataset_version.state = 'active'
          WHERE source_resource.organization_id = job.organization_id
            AND source_resource.project_id = job.project_id
            AND source_resource.id = pin.source_resource_id
            AND source_resource.kind = 'dataset' AND source_resource.dataset_id = pin.dataset_id
            AND source_resource.state <> 'archived'
        )
      )
    )
  ORDER BY object.id LIMIT 1;
$$;

CREATE FUNCTION app.map_render_job_pins_complete(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.map_render_job_bindings binding
    JOIN app.map_render_jobs job
      ON job.organization_id = binding.organization_id AND job.id = binding.render_job_id
     AND job.resource_id = binding.resource_id
    JOIN app.map_render_job_layers layer
      ON layer.organization_id = job.organization_id AND layer.render_job_id = job.id
    LEFT JOIN app.map_render_job_source_pins pin
      ON pin.organization_id = layer.organization_id
     AND pin.render_job_id = layer.render_job_id AND pin.position = layer.position
    LEFT JOIN LATERAL app.resolve_map_render_job_source(job.id, layer.position) source ON true
    WHERE job.id = p_job_id
    GROUP BY job.id
    HAVING count(*) BETWEEN 1 AND 16 AND min(layer.position) = 1 AND max(layer.position) = count(*)
      AND count(pin.position) = count(*) AND count(source.id) = count(*)
  );
$$;

REVOKE EXECUTE ON FUNCTION app.validate_map_render_job_binding(),
  app.validate_map_render_job_source_pin(), app.resolve_map_render_job_source(uuid, smallint),
  app.map_render_job_pins_complete(uuid) FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.map_render_job_bindings IS
  'Immutable saved-map identity and API-compiled canonical recipe for a map-owned render job, independent of every canonical dataset source.';
COMMENT ON TABLE app.map_render_job_source_pins IS
  'Immutable ordered canonical dataset resource versions and exact preview object/provider-version/checksum identities; worker access remains function-only.';

CREATE OR REPLACE FUNCTION app.enforce_map_render_composition_transition()
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
    IF EXISTS (
      SELECT 1 FROM app.governed_resources resource
      WHERE resource.organization_id = NEW.organization_id
        AND resource.id = NEW.resource_id AND resource.kind = 'map'
    ) THEN
      IF NOT app.map_render_job_pins_complete(NEW.id) THEN
        RAISE EXCEPTION 'saved map render sources are incomplete';
      END IF;
    ELSIF v_count NOT BETWEEN 2 AND 16 OR v_min <> 1 OR v_max <> v_count THEN
      RAISE EXCEPTION 'map render composition is incomplete';
    END IF;
  END IF;
  IF NEW.state <> 'queued' AND NOT NEW.composition_sealed THEN
    RAISE EXCEPTION 'unsealed map render composition cannot transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_map_render(
  p_job_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  render_job_id uuid,
  organization_id uuid,
  project_id uuid,
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
  configuration_checksum_sha256 text,
  request_bbox jsonb,
  request_crs text,
  request_width integer,
  request_height integer,
  request_format text,
  request_checksum_sha256 text,
  attempt_count integer,
  output_prefix text
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
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'invalid map render claim';
  END IF;

  SELECT
    job.*,
    resource.kind = 'map' AS saved_map_job,
    profile.dataset_id AS snapshot_dataset_id,
    profile.dataset_version_id AS snapshot_dataset_version_id,
    profile.style_id AS snapshot_style_id,
    profile.style_version_id AS snapshot_style_version_id,
    profile.configuration,
    profile.checksum_sha256 AS configuration_checksum,
    source.id AS source_id,
    source.bucket AS source_bucket,
    source.object_key AS source_key,
    source.s3_version_id AS source_version,
    source.etag AS source_etag,
    source.content_type AS source_type,
    source.size_bytes AS source_size,
    source.checksum_sha256 AS source_checksum
  INTO v_job
  FROM app.map_render_jobs job
  JOIN app.governed_resources resource
    ON resource.organization_id = job.organization_id AND resource.id = job.resource_id
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = job.organization_id
   AND profile.profile_id = job.profile_id
   AND profile.id = job.profile_version_id
  LEFT JOIN LATERAL app.resolve_map_render_job_source(job.id, 1::smallint) source ON true
  WHERE job.id = p_job_id
  ORDER BY source.id
  LIMIT 1
  FOR UPDATE OF job;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_ready', p_job_id, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::jsonb,
      NULL::text, NULL::jsonb, NULL::text, NULL::integer, NULL::integer,
      NULL::text, NULL::text, NULL::integer, NULL::text;
    RETURN;
  END IF;

  IF v_job.state::text IN ('completed', 'failed', 'cancelled') THEN
    RETURN QUERY SELECT
      'already_' || v_job.state::text,
      v_job.id, v_job.organization_id, v_job.project_id, v_job.resource_id,
      v_job.snapshot_dataset_id, v_job.snapshot_dataset_version_id,
      v_job.source_id, v_job.source_bucket, v_job.source_key,
      v_job.source_version, v_job.source_etag, v_job.source_type,
      v_job.source_size, v_job.source_checksum, v_job.profile_id,
      v_job.profile_version_id, v_job.snapshot_style_id,
      v_job.snapshot_style_version_id, v_job.configuration,
      v_job.configuration_checksum, v_job.bbox, v_job.crs,
      v_job.width, v_job.height, v_job.format::text,
      v_job.request_checksum_sha256, v_job.attempt_count,
      format(
        'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
        v_job.organization_id, v_job.project_id, v_job.snapshot_dataset_id,
        v_job.snapshot_dataset_version_id
      );
    RETURN;
  END IF;

  IF v_job.source_id IS NULL OR v_job.source_size NOT BETWEEN 1 AND 16777216
    OR NOT v_job.composition_sealed
    OR (v_job.saved_map_job AND NOT app.map_render_job_pins_complete(v_job.id))
  THEN
    RETURN QUERY SELECT
      'not_ready', p_job_id, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::jsonb,
      NULL::text, NULL::jsonb, NULL::text, NULL::integer, NULL::integer,
      NULL::text, NULL::text, NULL::integer, NULL::text;
    RETURN;
  END IF;

  IF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    RETURN QUERY SELECT
      'busy', v_job.id, v_job.organization_id, v_job.project_id,
      v_job.resource_id, v_job.snapshot_dataset_id,
      v_job.snapshot_dataset_version_id, v_job.source_id,
      v_job.source_bucket, v_job.source_key, v_job.source_version,
      v_job.source_etag, v_job.source_type, v_job.source_size,
      v_job.source_checksum, v_job.profile_id, v_job.profile_version_id,
      v_job.snapshot_style_id, v_job.snapshot_style_version_id,
      v_job.configuration, v_job.configuration_checksum, v_job.bbox,
      v_job.crs, v_job.width, v_job.height, v_job.format::text,
      v_job.request_checksum_sha256, v_job.attempt_count,
      format(
        'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
        v_job.organization_id, v_job.project_id, v_job.snapshot_dataset_id,
        v_job.snapshot_dataset_version_id
      );
    RETURN;
  END IF;

  UPDATE app.map_render_jobs AS target
  SET state = 'running',
      worker_token = p_worker_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = v_now,
      attempt_count = target.attempt_count + 1,
      started_at = COALESCE(target.started_at, v_now),
      finished_at = NULL,
      error_code = NULL
  WHERE target.id = v_job.id;

  RETURN QUERY SELECT
    'claimed', v_job.id, v_job.organization_id, v_job.project_id,
    v_job.resource_id, v_job.snapshot_dataset_id,
    v_job.snapshot_dataset_version_id, v_job.source_id,
    v_job.source_bucket, v_job.source_key, v_job.source_version,
    v_job.source_etag, v_job.source_type, v_job.source_size,
    v_job.source_checksum, v_job.profile_id, v_job.profile_version_id,
    v_job.snapshot_style_id, v_job.snapshot_style_version_id,
    v_job.configuration, v_job.configuration_checksum, v_job.bbox,
    v_job.crs, v_job.width, v_job.height, v_job.format::text,
    v_job.request_checksum_sha256, v_job.attempt_count + 1,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
      v_job.organization_id, v_job.project_id, v_job.snapshot_dataset_id,
      v_job.snapshot_dataset_version_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION app.get_map_render_layers(
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
  JOIN LATERAL app.resolve_map_render_job_source(job.id, layer.position) source ON true
  WHERE job.id = p_job_id
    AND job.state = 'running'
    AND job.worker_token = p_worker_token
    AND job.composition_sealed
    AND (
      NOT EXISTS (SELECT 1 FROM app.governed_resources resource
        WHERE resource.organization_id = job.organization_id
          AND resource.id = job.resource_id AND resource.kind = 'map')
      OR app.map_render_job_pins_complete(job.id)
    )
  ORDER BY layer.position;
$$;

CREATE OR REPLACE FUNCTION app.complete_map_render(
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
  v_job app.map_render_jobs%ROWTYPE;
  v_profile app.map_render_profile_versions%ROWTYPE;
  v_bucket text;
  v_prefix text;
  v_extension text;
  v_content_type text;
  v_expected_key text;
BEGIN
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN false;
  END IF;
  IF NOT v_job.composition_sealed OR (
    EXISTS (SELECT 1 FROM app.governed_resources resource
      WHERE resource.organization_id = v_job.organization_id
        AND resource.id = v_job.resource_id AND resource.kind = 'map')
    AND NOT app.map_render_job_pins_complete(v_job.id)
  ) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_profile
  FROM app.map_render_profile_versions
  WHERE organization_id = v_job.organization_id
    AND profile_id = v_job.profile_id
    AND id = v_job.profile_version_id;
  SELECT source.bucket INTO v_bucket
  FROM app.resolve_map_render_job_source(v_job.id, 1::smallint) source;

  v_prefix := format(
    'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
    v_job.organization_id, v_job.project_id, v_profile.dataset_id,
    v_profile.dataset_version_id
  );
  v_extension := CASE v_job.format::text WHEN 'svg' THEN 'svg' WHEN 'png' THEN 'png' END;
  v_content_type := CASE v_job.format::text
    WHEN 'svg' THEN 'image/svg+xml'
    WHEN 'png' THEN 'image/png'
  END;
  IF v_extension IS NULL OR v_content_type IS NULL THEN
    RAISE EXCEPTION 'invalid map render format';
  END IF;
  v_expected_key := v_prefix || 'renders/' || v_job.id::text || '.' || v_extension;
  IF v_bucket IS NULL
    OR p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192
    OR (p_artifact->>'id') IS NULL
    OR (p_artifact->>'role') <> 'derived'
    OR (p_artifact->>'bucket') <> v_bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'content_type') <> v_content_type
    OR (p_artifact->>'s3_version_id') IN ('', 'null')
    OR (p_artifact->>'etag') = ''
    OR (p_artifact->>'size_bytes')::bigint NOT BETWEEN 1 AND 20971520
    OR (p_artifact->>'checksum_sha256') !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid map render artifact';
  END IF;

  INSERT INTO app.data_objects
    (id, organization_id, dataset_id, role, bucket, object_key,
     s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
  VALUES
    ((p_artifact->>'id')::uuid, v_job.organization_id, v_profile.dataset_id,
     'derived', p_artifact->>'bucket', p_artifact->>'object_key',
     p_artifact->>'s3_version_id', p_artifact->>'etag',
     p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
     p_artifact->>'checksum_sha256', v_job.created_by);
  -- A saved-map image can contain other independently authorized datasets.
  -- Keep its output reachable through the map job, never through the anchor
  -- dataset's download or public-asset inventory.
  IF NOT EXISTS (
    SELECT 1 FROM app.map_render_job_bindings binding
    WHERE binding.organization_id = v_job.organization_id
      AND binding.render_job_id = v_job.id
  ) THEN
    INSERT INTO app.dataset_version_objects
      (organization_id, dataset_id, dataset_version_id, data_object_id)
    VALUES
      (v_job.organization_id, v_profile.dataset_id,
       v_profile.dataset_version_id, (p_artifact->>'id')::uuid);
  END IF;

  UPDATE app.map_render_jobs
  SET state = 'completed', output_object_id = (p_artifact->>'id')::uuid,
      error_code = NULL, worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_job.id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'map.render.completed', 'resource', v_job.resource_id,
     'worker:' || v_job.id::text,
     jsonb_build_object(
       'render_job_id', v_job.id,
       'profile_version_id', v_job.profile_version_id,
       'format', v_job.format::text,
       'crs', v_job.crs,
       'output_object_id', (p_artifact->>'id')::uuid,
       'output_checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.render_cache_output_is_referenced(
  p_organization_id uuid,
  p_render_job_id uuid,
  p_object_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_referenced boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.map_render_job_bindings binding
    WHERE binding.organization_id = p_organization_id
      AND binding.render_job_id = p_render_job_id
  ) THEN
    RETURN true;
  END IF;
  -- Current cache heads and current render-profile generations remain reusable.
  SELECT EXISTS (
    SELECT 1
    FROM app.spatial_tile_caches cache
    JOIN app.spatial_tile_cache_entries entry
      ON entry.organization_id = cache.organization_id
     AND entry.cache_id = cache.id
     AND entry.cache_version_id = cache.current_version_id
     AND entry.cache_version_number = cache.current_version_number
    WHERE cache.organization_id = p_organization_id
      AND entry.render_job_id = p_render_job_id
    UNION ALL
    SELECT 1
    FROM app.map_render_job_layers layer
    JOIN app.map_render_profiles profile
      ON profile.organization_id = layer.organization_id
     AND profile.id = layer.profile_id
     AND profile.current_version_id = layer.profile_version_id
    WHERE layer.organization_id = p_organization_id
      AND layer.render_job_id = p_render_job_id
    UNION ALL
    SELECT 1
    FROM app.map_render_jobs other_job
    WHERE other_job.organization_id = p_organization_id
      AND other_job.output_object_id = p_object_id
      AND other_job.id <> p_render_job_id
    UNION ALL
    SELECT 1
    FROM app.governed_resource_versions version
    WHERE version.organization_id = p_organization_id
      AND (
        version.content::text LIKE '%' || p_object_id::text || '%'
        OR version.content::text LIKE '%' || p_render_job_id::text || '%'
      )
  ) INTO v_referenced;
  IF v_referenced OR to_regclass('app.project_site_editions') IS NULL THEN
    RETURN v_referenced;
  END IF;
  EXECUTE
    'SELECT EXISTS (
       SELECT 1 FROM app.project_site_editions edition
       WHERE edition.organization_id = $1
         AND (
           edition.manifest::text LIKE ''%'' || $2::text || ''%''
           OR edition.manifest::text LIKE ''%'' || $3::text || ''%''
         )
     )'
  INTO v_referenced
  USING p_organization_id, p_object_id, p_render_job_id;
  RETURN v_referenced;
END;
$$;

COMMIT;
