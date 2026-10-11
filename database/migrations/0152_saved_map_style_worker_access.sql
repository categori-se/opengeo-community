BEGIN;

-- Recheck the original Style, not the generated render-profile copy. Workers have
-- no tenant session; all grants below are scoped to the job's organization/actor.
CREATE FUNCTION app.map_render_job_styles_available(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.map_render_jobs job
    JOIN app.governed_resources target
      ON target.organization_id = job.organization_id AND target.id = job.resource_id
    LEFT JOIN app.map_render_job_bindings render_binding
      ON render_binding.organization_id = job.organization_id AND render_binding.render_job_id = job.id
    LEFT JOIN app.map_resource_version_bindings map_binding
      ON map_binding.organization_id = render_binding.organization_id
     AND map_binding.resource_id = render_binding.resource_id
     AND map_binding.resource_version_id = render_binding.resource_version_id
    LEFT JOIN app.map_versions map_version
      ON map_version.organization_id = map_binding.organization_id
     AND map_version.map_id = map_binding.map_id AND map_version.version = map_binding.map_version
    WHERE job.id = p_job_id AND (
      target.kind <> 'map' OR map_version.map_id IS NULL OR (
        map_version.map_id IS NOT NULL
        AND jsonb_typeof(map_version.definition->'layers') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(map_version.definition->'layers') = 'array'
              THEN map_version.definition->'layers' ELSE '[]'::jsonb END) layer
          WHERE layer->'styleReference' IS NOT NULL AND layer->'styleReference' <> 'null'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM app.governed_resource_styles style
              JOIN app.governed_resource_style_versions version
                ON version.organization_id = style.organization_id AND version.style_id = style.id
              JOIN app.governed_resources resource
                ON resource.organization_id = style.organization_id
               AND resource.project_id = style.project_id AND resource.id = style.resource_id
              JOIN app.organization_memberships membership
                ON membership.organization_id = resource.organization_id AND membership.user_id = job.created_by
              WHERE style.organization_id = job.organization_id
                AND style.project_id::text = layer->'styleReference'->>'projectId'
                AND style.resource_id::text = layer->'styleReference'->>'resourceId'
                AND style.id::text = layer->'styleReference'->>'styleId'
                AND version.version_number::text = layer->'styleReference'->>'versionNumber'
                AND version.checksum_sha256 = layer->'styleReference'->>'checksumSha256'
                AND style.format::text = layer->'styleReference'->>'format'
                AND resource.dataset_id::text = layer->>'datasetId'
                AND encode(sha256(convert_to(version.definition, 'UTF8')), 'hex') = version.checksum_sha256
                -- Matches RESOURCE_READ, including active team-derived access.
                AND (membership.role = 'admin' OR resource.owner_user_id = job.created_by
                  OR EXISTS (SELECT 1 FROM app.governed_resource_permissions permission
                    WHERE permission.organization_id = job.organization_id
                      AND permission.resource_id = resource.id AND permission.user_id = job.created_by)
                  OR EXISTS (SELECT 1 FROM app.project_memberships direct
                    WHERE direct.organization_id = job.organization_id
                      AND direct.project_id = resource.project_id AND direct.user_id = job.created_by)
                  OR EXISTS (
                    SELECT 1 FROM app.project_team_grants grant_entry
                    JOIN app.teams team ON team.organization_id = grant_entry.organization_id
                      AND team.id = grant_entry.team_id AND team.status = 'active'
                    JOIN app.team_memberships team_member ON team_member.organization_id = team.organization_id
                      AND team_member.team_id = team.id AND team_member.user_id = job.created_by
                    WHERE grant_entry.organization_id = job.organization_id
                      AND grant_entry.project_id = resource.project_id))
            )
        )
      )
    )
  );
$$;

-- Called only inside locked worker lease functions. Cancelling clears the lease;
-- existing queue/lease handling stops work without retrying an unavailable Style.
CREATE FUNCTION app.cancel_map_render_for_unavailable_style(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_job app.map_render_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state NOT IN ('queued', 'running') OR NOT v_job.composition_sealed THEN
    RETURN false;
  END IF;
  IF app.map_render_job_styles_available(v_job.id) THEN RETURN false; END IF;
  UPDATE app.map_render_jobs
  SET state = 'cancelled', error_code = 'saved_map_style_unavailable', worker_token = NULL,
      lease_expires_at = NULL, last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_job.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type, resource_type, resource_id, request_id, payload)
  VALUES (v_job.organization_id, v_job.created_by, v_job.project_id,
    'map.render.cancelled', 'resource', v_job.resource_id, 'worker:' || v_job.id::text,
    jsonb_build_object('render_job_id', v_job.id, 'error_code', 'saved_map_style_unavailable'));
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.map_render_job_styles_available(uuid),
  app.cancel_map_render_for_unavailable_style(uuid) FROM PUBLIC, opengeo_runtime, opengeo_worker;

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

  PERFORM app.cancel_map_render_for_unavailable_style(p_job_id);

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

CREATE OR REPLACE FUNCTION app.heartbeat_map_render(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
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
  IF p_job_id IS NULL OR p_worker_token IS NULL OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RETURN false;
  END IF;
  SELECT * INTO v_job FROM app.map_render_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token IS DISTINCT FROM p_worker_token THEN
    RETURN false;
  END IF;
  IF app.cancel_map_render_for_unavailable_style(v_job.id) THEN RETURN false; END IF;
  UPDATE app.map_render_jobs
  SET last_heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE id = v_job.id;
  RETURN true;
END;
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
  IF NOT FOUND OR v_job.state <> 'running' OR v_job.worker_token IS DISTINCT FROM p_worker_token THEN
    RETURN false;
  END IF;
  IF app.cancel_map_render_for_unavailable_style(v_job.id) THEN RETURN false; END IF;
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

CREATE OR REPLACE FUNCTION app.map_render_job_pins_complete(p_job_id uuid)
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
    WHERE job.id = p_job_id AND app.map_render_job_styles_available(job.id)
    GROUP BY job.id
    HAVING count(*) BETWEEN 1 AND 16 AND min(layer.position) = 1 AND max(layer.position) = count(*)
      AND count(pin.position) = count(*) AND count(source.id) = count(*)
  );
$$;

COMMIT;
