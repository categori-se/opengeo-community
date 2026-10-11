BEGIN;

CREATE TYPE app.map_render_format AS ENUM ('svg');
CREATE TYPE app.map_render_job_state AS ENUM (
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
);

ALTER TABLE app.governed_resource_styles
  ADD CONSTRAINT governed_resource_styles_resource_identity_unique
  UNIQUE (organization_id, resource_id, id);

CREATE TABLE app.map_render_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  slug text NOT NULL,
  current_version_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, resource_id, id),
  UNIQUE (organization_id, resource_id, slug),
  CONSTRAINT map_render_profiles_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE TABLE app.map_render_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  profile_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  style_id uuid NOT NULL,
  style_version_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  configuration jsonb NOT NULL,
  checksum_sha256 text NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, profile_id, id),
  UNIQUE (organization_id, profile_id, version_number),
  CONSTRAINT map_render_profile_versions_positive CHECK (version_number > 0),
  CONSTRAINT map_render_profile_versions_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT map_render_profile_versions_configuration_bounded CHECK (
    jsonb_typeof(configuration) = 'object'
    AND octet_length(configuration::text) BETWEEN 2 AND 32768
  ),
  CONSTRAINT map_render_profile_versions_checksum_valid CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT map_render_profile_versions_change_bounded CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, profile_id, resource_id)
    REFERENCES app.map_render_profiles (organization_id, id, resource_id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, resource_id, style_id)
    REFERENCES app.governed_resource_styles (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, style_id, style_version_id)
    REFERENCES app.governed_resource_style_versions (organization_id, style_id, id)
);

ALTER TABLE app.map_render_profiles
  ADD CONSTRAINT map_render_profiles_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.map_render_profile_versions (organization_id, profile_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.map_render_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  bbox jsonb NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  format app.map_render_format NOT NULL DEFAULT 'svg',
  request_checksum_sha256 text NOT NULL,
  state app.map_render_job_state NOT NULL DEFAULT 'queued',
  worker_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  output_object_id uuid,
  error_code text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  request_id text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  CONSTRAINT map_render_jobs_bbox_shape CHECK (
    jsonb_typeof(bbox) = 'array' AND jsonb_array_length(bbox) = 4
  ),
  CONSTRAINT map_render_jobs_dimensions_bounded CHECK (
    width BETWEEN 64 AND 2048
    AND height BETWEEN 64 AND 2048
    AND width::bigint * height::bigint <= 4194304
  ),
  CONSTRAINT map_render_jobs_checksum_valid CHECK (
    request_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT map_render_jobs_attempt_bounded CHECK (
    attempt_count BETWEEN 0 AND 10
  ),
  CONSTRAINT map_render_jobs_error_bounded CHECK (
    error_code IS NULL
    OR (
      error_code ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
      AND char_length(error_code) <= 100
    )
  ),
  CONSTRAINT map_render_jobs_request_id_bounded CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT map_render_jobs_state_shape CHECK (
    (state = 'queued'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL AND output_object_id IS NULL
      AND started_at IS NULL AND finished_at IS NULL)
    OR (state = 'running'
      AND worker_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL AND output_object_id IS NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state = 'completed'
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL AND output_object_id IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_code IS NULL)
    OR (state IN ('failed', 'cancelled')
      AND worker_token IS NULL AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL AND output_object_id IS NULL
      AND finished_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, profile_id, resource_id)
    REFERENCES app.map_render_profiles (organization_id, id, resource_id),
  FOREIGN KEY (organization_id, profile_id, profile_version_id)
    REFERENCES app.map_render_profile_versions (organization_id, profile_id, id),
  FOREIGN KEY (organization_id, output_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

CREATE INDEX map_render_profiles_resource_idx
  ON app.map_render_profiles (organization_id, project_id, resource_id, slug);
CREATE INDEX map_render_profile_versions_history_idx
  ON app.map_render_profile_versions (
    organization_id, profile_id, version_number DESC
  );
CREATE INDEX map_render_jobs_queue_idx
  ON app.map_render_jobs (state, created_at, id);
CREATE INDEX map_render_jobs_resource_idx
  ON app.map_render_jobs (
    organization_id, project_id, resource_id, created_at DESC, id
  );
CREATE INDEX map_render_jobs_expired_lease_idx
  ON app.map_render_jobs (lease_expires_at, id)
  WHERE state = 'running';

CREATE FUNCTION app.enforce_map_render_profile_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.slug <> OLD.slug
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'map render profile identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_profiles_enforce_transition
  BEFORE UPDATE ON app.map_render_profiles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_map_render_profile_transition();
CREATE TRIGGER map_render_profiles_set_updated_at
  BEFORE UPDATE ON app.map_render_profiles
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER map_render_profile_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.map_render_profile_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER map_render_jobs_set_updated_at
  BEFORE UPDATE ON app.map_render_jobs
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE FUNCTION app.claim_map_render(
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
  JOIN app.map_render_profile_versions profile
    ON profile.organization_id = job.organization_id
   AND profile.profile_id = job.profile_id
   AND profile.id = job.profile_version_id
  LEFT JOIN app.dataset_version_objects link
    ON link.organization_id = profile.organization_id
   AND link.dataset_id = profile.dataset_id
   AND link.dataset_version_id = profile.dataset_version_id
  LEFT JOIN app.data_objects source
    ON source.organization_id = link.organization_id
   AND source.id = link.data_object_id
   AND source.role = 'derived'
   AND source.content_type = 'application/geo+json'
   AND source.object_key LIKE '%/derivatives/preview/preview.geojson'
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
      NULL::text, NULL::jsonb, NULL::integer, NULL::integer, NULL::text,
      NULL::text, NULL::integer, NULL::text;
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
      v_job.configuration_checksum, v_job.bbox, v_job.width, v_job.height,
      v_job.format::text, v_job.request_checksum_sha256,
      v_job.attempt_count,
      format(
        'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
        v_job.organization_id, v_job.project_id, v_job.snapshot_dataset_id,
        v_job.snapshot_dataset_version_id
      );
    RETURN;
  END IF;

  IF v_job.source_id IS NULL OR v_job.source_size NOT BETWEEN 1 AND 16777216 THEN
    RETURN QUERY SELECT
      'not_ready', p_job_id, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::jsonb,
      NULL::text, NULL::jsonb, NULL::integer, NULL::integer, NULL::text,
      NULL::text, NULL::integer, NULL::text;
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
      v_job.width, v_job.height, v_job.format::text,
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
    v_job.width, v_job.height, v_job.format::text,
    v_job.request_checksum_sha256, v_job.attempt_count + 1,
    format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
      v_job.organization_id, v_job.project_id, v_job.snapshot_dataset_id,
      v_job.snapshot_dataset_version_id
    );
END;
$$;

CREATE FUNCTION app.heartbeat_map_render(
  p_job_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  WITH heartbeat AS (
    UPDATE app.map_render_jobs
    SET last_heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE id = p_job_id
      AND state = 'running'
      AND worker_token = p_worker_token
      AND p_lease_seconds BETWEEN 60 AND 3600
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM heartbeat)
$$;

CREATE FUNCTION app.complete_map_render(
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
  v_expected_key text;
BEGIN
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN false;
  END IF;
  SELECT * INTO v_profile
  FROM app.map_render_profile_versions
  WHERE organization_id = v_job.organization_id
    AND profile_id = v_job.profile_id
    AND id = v_job.profile_version_id;
  SELECT object.bucket INTO v_bucket
  FROM app.dataset_version_objects link
  JOIN app.data_objects object
    ON object.organization_id = link.organization_id
   AND object.id = link.data_object_id
  WHERE link.organization_id = v_job.organization_id
    AND link.dataset_id = v_profile.dataset_id
    AND link.dataset_version_id = v_profile.dataset_version_id
  ORDER BY object.id
  LIMIT 1;

  v_prefix := format(
    'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/',
    v_job.organization_id, v_job.project_id, v_profile.dataset_id,
    v_profile.dataset_version_id
  );
  v_expected_key := v_prefix || 'renders/' || v_job.id::text || '.svg';
  IF v_bucket IS NULL
    OR p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object'
    OR octet_length(p_artifact::text) > 8192
    OR (p_artifact->>'id') IS NULL
    OR (p_artifact->>'role') <> 'derived'
    OR (p_artifact->>'bucket') <> v_bucket
    OR (p_artifact->>'object_key') <> v_expected_key
    OR (p_artifact->>'content_type') <> 'image/svg+xml'
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
  INSERT INTO app.dataset_version_objects
    (organization_id, dataset_id, dataset_version_id, data_object_id)
  VALUES
    (v_job.organization_id, v_profile.dataset_id,
     v_profile.dataset_version_id, (p_artifact->>'id')::uuid);

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
       'output_object_id', (p_artifact->>'id')::uuid,
       'output_checksum_sha256', p_artifact->>'checksum_sha256'
     ));
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_map_render(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.map_render_jobs%ROWTYPE;
BEGIN
  IF p_error_code IS NULL
    OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
  THEN
    RAISE EXCEPTION 'invalid map render failure';
  END IF;
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN false;
  END IF;
  UPDATE app.map_render_jobs
  SET state = 'failed', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_job.organization_id, v_job.created_by, v_job.project_id,
     'map.render.failed', 'resource', v_job.resource_id,
     'worker:' || v_job.id::text,
     jsonb_build_object('render_job_id', v_job.id, 'error_code', p_error_code));
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_map_render(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_code text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.map_render_jobs%ROWTYPE;
  v_failed boolean;
BEGIN
  IF p_error_code IS NULL
    OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
    OR p_max_attempts NOT BETWEEN 1 AND 10
  THEN
    RAISE EXCEPTION 'invalid map render release';
  END IF;
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token THEN
    RETURN 'lost';
  END IF;
  IF v_job.attempt_count >= p_max_attempts THEN
    v_failed := app.fail_map_render(
      p_job_id, p_worker_token, 'render_retry_exhausted'
    );
    RETURN CASE WHEN v_failed THEN 'failed' ELSE 'lost' END;
  END IF;
  UPDATE app.map_render_jobs
  SET state = 'queued', error_code = p_error_code, worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL,
      started_at = NULL
  WHERE id = v_job.id;
  RETURN 'queued';
END;
$$;

ALTER TABLE app.map_render_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.map_render_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY map_render_profiles_tenant_isolation ON app.map_render_profiles
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY map_render_profile_versions_tenant_isolation
  ON app.map_render_profile_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY map_render_jobs_tenant_isolation ON app.map_render_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.map_render_profiles TO opengeo_runtime;
GRANT SELECT, INSERT ON app.map_render_profile_versions TO opengeo_runtime;
GRANT SELECT, INSERT ON app.map_render_jobs TO opengeo_runtime;
REVOKE UPDATE, DELETE ON
  app.map_render_profile_versions,
  app.map_render_jobs
FROM opengeo_runtime;
REVOKE ALL ON
  app.map_render_profiles,
  app.map_render_profile_versions,
  app.map_render_jobs
FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_map_render_profile_transition(),
  app.claim_map_render(uuid, uuid, integer),
  app.heartbeat_map_render(uuid, uuid, integer),
  app.complete_map_render(uuid, uuid, jsonb),
  app.fail_map_render(uuid, uuid, text),
  app.release_map_render(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_map_render(uuid, uuid, integer),
  app.heartbeat_map_render(uuid, uuid, integer),
  app.complete_map_render(uuid, uuid, jsonb),
  app.fail_map_render(uuid, uuid, text),
  app.release_map_render(uuid, uuid, text, integer)
TO opengeo_worker;

COMMENT ON TABLE app.map_render_profiles IS
  'Stable declarative render profiles for one governed, dataset-bound resource.';
COMMENT ON TABLE app.map_render_profile_versions IS
  'Immutable render activation snapshots binding exact resource, dataset, and portable-style versions.';
COMMENT ON TABLE app.map_render_jobs IS
  'Bounded idempotent map-image requests and immutable output-object facts.';
COMMENT ON FUNCTION app.claim_map_render(uuid, uuid, integer) IS
  'Claim one exact-version render and expose only its bounded preview object and compiled configuration.';

COMMIT;
