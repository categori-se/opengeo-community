BEGIN;

-- SERVICE-010 reclaims bounded batches from retired WMTS cache generations.
-- Catalog reads and elapsed time never create a plan or enqueue work.
CREATE TABLE app.spatial_tile_cache_reclamations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  cache_id uuid NOT NULL,
  cache_version_id uuid NOT NULL,
  cache_version_number bigint NOT NULL,
  target_count integer NOT NULL,
  target_size_bytes bigint NOT NULL,
  preview_checksum_sha256 text NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
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
  UNIQUE (
    organization_id, cache_id, cache_version_id,
    preview_checksum_sha256, preview_expires_at
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id),
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES app.spatial_service_collections (organization_id, id),
  FOREIGN KEY (organization_id, cache_id)
    REFERENCES app.spatial_tile_caches (organization_id, id),
  FOREIGN KEY (organization_id, cache_id, cache_version_id)
    REFERENCES app.spatial_tile_cache_versions (organization_id, cache_id, id),
  CONSTRAINT spatial_tile_cache_reclamation_batch_bounded CHECK (
    target_count BETWEEN 1 AND 64
    AND target_size_bytes BETWEEN 1 AND 1342177280
  ),
  CONSTRAINT spatial_tile_cache_reclamation_preview_shape CHECK (
    preview_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND preview_expires_at > created_at
    AND preview_expires_at <= created_at + interval '15 minutes'
  ),
  CONSTRAINT spatial_tile_cache_reclamation_attempt_nonnegative CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT spatial_tile_cache_reclamation_state_shape CHECK (
    (state = 'queued' AND worker_token IS NULL AND lease_expires_at IS NULL
      AND last_heartbeat_at IS NULL AND finished_at IS NULL)
    OR (state = 'running' AND worker_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('completed', 'failed') AND worker_token IS NULL
      AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT spatial_tile_cache_reclamation_no_cancel CHECK (state <> 'cancelled')
);

CREATE TABLE app.spatial_tile_cache_reclamation_items (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  reclamation_id uuid NOT NULL,
  position smallint NOT NULL,
  render_job_id uuid NOT NULL,
  output_object_id uuid NOT NULL,
  sealed_bucket text NOT NULL,
  sealed_object_key text NOT NULL,
  sealed_storage_version_id text NOT NULL,
  sealed_etag text NOT NULL,
  sealed_content_type text NOT NULL,
  sealed_size_bytes bigint NOT NULL,
  sealed_checksum_sha256 text NOT NULL,
  state app.processing_job_state NOT NULL DEFAULT 'queued',
  error_code text,
  delete_started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (organization_id, reclamation_id, position),
  UNIQUE (organization_id, reclamation_id, render_job_id),
  UNIQUE (organization_id, reclamation_id, output_object_id),
  FOREIGN KEY (organization_id, reclamation_id)
    REFERENCES app.spatial_tile_cache_reclamations (organization_id, id),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_jobs (organization_id, id),
  CONSTRAINT spatial_tile_cache_reclamation_item_position CHECK (
    position BETWEEN 1 AND 64
  ),
  CONSTRAINT spatial_tile_cache_reclamation_item_target_shape CHECK (
    sealed_bucket <> ''
    AND sealed_object_key ~ '^organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/datasets/[0-9a-f-]{36}/versions/[0-9a-f-]{36}/derivatives/renders/[0-9a-f-]{36}\.(svg|png)$'
    AND sealed_storage_version_id NOT IN ('', 'null')
    AND sealed_etag ~ '^[A-Fa-f0-9]{16,128}$'
    AND sealed_content_type IN ('image/svg+xml', 'image/png')
    AND sealed_size_bytes BETWEEN 1 AND 20971520
    AND sealed_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT spatial_tile_cache_reclamation_item_state_shape CHECK (
    (state = 'queued' AND delete_started_at IS NULL
      AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'running' AND delete_started_at IS NOT NULL
      AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'completed' AND delete_started_at IS NOT NULL
      AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state = 'failed' AND delete_started_at IS NULL
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CONSTRAINT spatial_tile_cache_reclamation_item_no_cancel CHECK (
    state <> 'cancelled'
  )
);

CREATE UNIQUE INDEX spatial_tile_cache_reclamation_item_one_live_object_idx
  ON app.spatial_tile_cache_reclamation_items (organization_id, output_object_id)
  WHERE state IN ('queued', 'running', 'completed');
CREATE INDEX spatial_tile_cache_reclamation_expired_idx
  ON app.spatial_tile_cache_reclamations (lease_expires_at, id)
  WHERE state = 'running';

-- Immutable render jobs keep the output UUID as retained history after the
-- catalog row and exact storage version are reclaimed.
DO $$
DECLARE
  v_constraint name;
BEGIN
  SELECT constraints.constraint_name INTO v_constraint
  FROM information_schema.table_constraints constraints
  JOIN information_schema.key_column_usage columns
    ON columns.constraint_schema = constraints.constraint_schema
   AND columns.constraint_name = constraints.constraint_name
   AND columns.table_schema = constraints.table_schema
   AND columns.table_name = constraints.table_name
  WHERE constraints.table_schema = 'app'
    AND constraints.table_name = 'map_render_jobs'
    AND constraints.constraint_type = 'FOREIGN KEY'
    AND columns.column_name = 'output_object_id'
  ORDER BY constraints.constraint_name
  LIMIT 1;
  IF v_constraint IS NULL THEN
    RAISE EXCEPTION 'map render output object constraint not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE app.map_render_jobs DROP CONSTRAINT %I', v_constraint
  );
END;
$$;

CREATE FUNCTION app.render_cache_output_is_referenced(
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

-- This worker-internal target function is deliberately never granted to the
-- runtime role because it includes bucket keys and storage version identifiers.
CREATE FUNCTION app.render_cache_reclamation_candidate_targets(
  p_organization_id uuid,
  p_project_id uuid,
  p_service_id uuid,
  p_binding_id uuid,
  p_cache_version_id uuid
)
RETURNS TABLE (
  render_job_id uuid,
  output_object_id uuid,
  bucket text,
  object_key text,
  storage_version_id text,
  etag text,
  content_type text,
  size_bytes bigint,
  checksum_sha256 text,
  finished_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT job.id, object.id, object.bucket, object.object_key,
         object.s3_version_id, lower(object.etag), object.content_type,
         object.size_bytes, object.checksum_sha256, job.finished_at
  FROM app.spatial_tile_caches cache
  JOIN app.spatial_tile_cache_versions version
    ON version.organization_id = cache.organization_id
   AND version.cache_id = cache.id
   AND version.id = p_cache_version_id
  JOIN LATERAL (
    SELECT min(successor.created_at) AS retired_at
    FROM app.spatial_tile_cache_versions successor
    WHERE successor.organization_id = version.organization_id
      AND successor.cache_id = version.cache_id
      AND successor.version_number > version.version_number
  ) retirement ON true
  JOIN app.spatial_tile_cache_entries entry
    ON entry.organization_id = version.organization_id
   AND entry.cache_id = version.cache_id
   AND entry.cache_version_id = version.id
   AND entry.cache_version_number = version.version_number
  JOIN app.map_render_jobs job
    ON job.organization_id = entry.organization_id
   AND job.id = entry.render_job_id
   AND job.project_id = p_project_id
   AND job.state = 'completed'
   AND job.composition_sealed
  JOIN app.map_render_profile_versions profile_version
    ON profile_version.organization_id = job.organization_id
   AND profile_version.profile_id = job.profile_id
   AND profile_version.id = job.profile_version_id
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.output_object_id
  WHERE cache.organization_id = p_organization_id
    AND cache.project_id = p_project_id
    AND cache.service_id = p_service_id
    AND cache.binding_id = p_binding_id
    AND version.id <> cache.current_version_id
    AND version.version_number < cache.current_version_number
    AND retirement.retired_at <= clock_timestamp() - interval '24 hours'
    AND entry.seeded_at <= clock_timestamp() - interval '24 hours'
    AND job.finished_at <= clock_timestamp() - interval '24 hours'
    AND object.role = 'derived'
    AND object.content_type = CASE job.format::text
      WHEN 'svg' THEN 'image/svg+xml' WHEN 'png' THEN 'image/png' END
    AND object.size_bytes BETWEEN 1 AND 20971520
    AND object.object_key = format(
      'organizations/%s/projects/%s/datasets/%s/versions/%s/derivatives/renders/%s.%s',
      job.organization_id, job.project_id, profile_version.dataset_id,
      profile_version.dataset_version_id, job.id,
      CASE job.format::text WHEN 'svg' THEN 'svg' WHEN 'png' THEN 'png' END
    )
    AND object.s3_version_id NOT IN ('', 'null')
    AND object.etag ~ '^[A-Fa-f0-9]{16,128}$'
    AND object.checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND NOT EXISTS (
      SELECT 1 FROM app.map_render_job_layers extra_layer
      WHERE extra_layer.organization_id = job.organization_id
        AND extra_layer.render_job_id = job.id
        AND extra_layer.position > 1
    )
    AND NOT app.render_cache_output_is_referenced(
      job.organization_id, job.id, object.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.spatial_tile_cache_reclamation_items item
      WHERE item.organization_id = object.organization_id
        AND item.output_object_id = object.id
        AND item.state IN ('queued', 'running', 'completed')
    )
  ORDER BY job.finished_at, job.id;
$$;

CREATE FUNCTION app.render_cache_reclamation_candidate_facts(
  p_organization_id uuid,
  p_project_id uuid,
  p_service_id uuid,
  p_binding_id uuid,
  p_cache_version_id uuid
)
RETURNS TABLE (
  render_job_id uuid,
  output_object_id uuid,
  size_bytes bigint,
  checksum_sha256 text,
  finished_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT candidate.render_job_id, candidate.output_object_id,
         candidate.size_bytes, candidate.checksum_sha256,
         candidate.finished_at
  FROM app.render_cache_reclamation_candidate_targets(
    p_organization_id, p_project_id, p_service_id, p_binding_id,
    p_cache_version_id
  ) candidate
  WHERE p_organization_id = app.current_organization_id()
  ORDER BY candidate.finished_at, candidate.render_job_id;
$$;

CREATE FUNCTION app.queue_spatial_tile_cache_reclamation(
  p_organization_id uuid,
  p_project_id uuid,
  p_service_id uuid,
  p_binding_id uuid,
  p_cache_version_id uuid,
  p_render_job_ids uuid[],
  p_preview_checksum_sha256 text,
  p_preview_expires_at timestamptz,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_cache record;
  v_existing app.spatial_tile_cache_reclamations%ROWTYPE;
  v_candidate_ids uuid[];
  v_target_count integer;
  v_target_size bigint;
  v_inserted integer;
  v_id uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_organization_id <> app.current_organization_id()
    OR p_actor_user_id <> app.current_user_id()
    OR cardinality(p_render_job_ids) NOT BETWEEN 1 AND 64
    OR p_preview_checksum_sha256 !~ '^[0-9a-f]{64}$'
    OR p_preview_expires_at <= v_now
    OR p_preview_expires_at > v_now + interval '15 minutes'
    OR p_request_id IS NULL OR char_length(p_request_id) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'invalid tile cache reclamation confirmation';
  END IF;

  SELECT reclamation.* INTO v_existing
  FROM app.spatial_tile_cache_reclamations reclamation
  WHERE reclamation.organization_id = p_organization_id
    AND reclamation.project_id = p_project_id
    AND reclamation.service_id = p_service_id
    AND reclamation.binding_id = p_binding_id
    AND reclamation.cache_version_id = p_cache_version_id
    AND reclamation.preview_checksum_sha256 = p_preview_checksum_sha256
    AND reclamation.preview_expires_at = p_preview_expires_at
  FOR UPDATE;
  IF FOUND THEN RETURN v_existing.id; END IF;

  SELECT cache.id, version.version_number
  INTO v_cache
  FROM app.spatial_tile_caches cache
  JOIN app.spatial_tile_cache_versions version
    ON version.organization_id = cache.organization_id
   AND version.cache_id = cache.id
   AND version.id = p_cache_version_id
  WHERE cache.organization_id = p_organization_id
    AND cache.project_id = p_project_id
    AND cache.service_id = p_service_id
    AND cache.binding_id = p_binding_id
    AND version.id <> cache.current_version_id
    AND version.version_number < cache.current_version_number
  FOR UPDATE OF cache;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile cache generation is not retired'; END IF;

  SELECT array_agg(candidate.render_job_id ORDER BY candidate.finished_at, candidate.render_job_id),
         count(*)::integer, sum(candidate.size_bytes)::bigint
  INTO v_candidate_ids, v_target_count, v_target_size
  FROM (
    SELECT * FROM app.render_cache_reclamation_candidate_targets(
      p_organization_id, p_project_id, p_service_id, p_binding_id,
      p_cache_version_id
    )
    LIMIT 64
  ) candidate;
  IF v_candidate_ids IS NULL OR v_candidate_ids <> p_render_job_ids THEN
    RAISE EXCEPTION 'tile cache reclamation preview changed';
  END IF;

  PERFORM object.id
  FROM app.map_render_jobs job
  JOIN app.data_objects object
    ON object.organization_id = job.organization_id
   AND object.id = job.output_object_id
  WHERE job.organization_id = p_organization_id
    AND job.id = ANY(p_render_job_ids)
  ORDER BY job.id
  FOR UPDATE OF job, object;

  INSERT INTO app.spatial_tile_cache_reclamations
    (id, organization_id, project_id, service_id, binding_id, cache_id,
     cache_version_id, cache_version_number, target_count, target_size_bytes,
     preview_checksum_sha256, preview_expires_at, created_by, created_at)
  VALUES
    (v_id, p_organization_id, p_project_id, p_service_id, p_binding_id,
     v_cache.id, p_cache_version_id, v_cache.version_number, v_target_count,
     v_target_size, p_preview_checksum_sha256, p_preview_expires_at,
     p_actor_user_id, v_now);

  INSERT INTO app.spatial_tile_cache_reclamation_items
    (organization_id, reclamation_id, position, render_job_id,
     output_object_id, sealed_bucket, sealed_object_key,
     sealed_storage_version_id, sealed_etag, sealed_content_type,
     sealed_size_bytes, sealed_checksum_sha256)
  SELECT p_organization_id, v_id,
         row_number() OVER (ORDER BY candidate.finished_at, candidate.render_job_id),
         candidate.render_job_id, candidate.output_object_id, candidate.bucket,
         candidate.object_key, candidate.storage_version_id, candidate.etag,
         candidate.content_type, candidate.size_bytes, candidate.checksum_sha256
  FROM app.render_cache_reclamation_candidate_targets(
    p_organization_id, p_project_id, p_service_id, p_binding_id,
    p_cache_version_id
  ) candidate
  WHERE candidate.render_job_id = ANY(p_render_job_ids)
  ORDER BY candidate.finished_at, candidate.render_job_id;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_target_count THEN
    RAISE EXCEPTION 'tile cache reclamation target changed';
  END IF;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (p_organization_id, p_actor_user_id, p_project_id,
     'spatial_service.tile_cache.reclamation.requested',
     'spatial_service', p_service_id, p_request_id,
     jsonb_build_object(
       'reclamation_id', v_id, 'binding_id', p_binding_id,
       'cache_id', v_cache.id, 'cache_version_id', p_cache_version_id,
       'cache_version_number', v_cache.version_number,
       'target_count', v_target_count, 'target_size_bytes', v_target_size,
       'preview_checksum_sha256', p_preview_checksum_sha256
     ));
  RETURN v_id;
END;
$$;

CREATE FUNCTION app.claim_spatial_tile_cache_reclamation(
  p_reclamation_id uuid,
  p_worker_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  reclamation_id uuid,
  target_count integer,
  target_size_bytes bigint,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_tile_cache_reclamations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_active integer;
BEGIN
  IF p_reclamation_id IS NULL OR p_worker_token IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 3600
  THEN RAISE EXCEPTION 'invalid tile cache reclamation claim'; END IF;
  SELECT * INTO v_plan FROM app.spatial_tile_cache_reclamations
  WHERE id = p_reclamation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_ready', p_reclamation_id, NULL::integer,
      NULL::bigint, NULL::integer;
    RETURN;
  END IF;
  IF v_plan.state IN ('completed', 'failed') THEN
    claim_status := 'already_' || v_plan.state::text;
  ELSIF v_plan.state = 'running' AND v_plan.lease_expires_at > v_now THEN
    claim_status := 'busy';
  ELSE
    UPDATE app.spatial_tile_cache_reclamation_items item
    SET state = 'failed', error_code = 'render_cache_output_referenced',
        finished_at = v_now
    WHERE item.organization_id = v_plan.organization_id
      AND item.reclamation_id = v_plan.id
      AND item.state = 'queued'
      AND app.render_cache_output_is_referenced(
        item.organization_id, item.render_job_id, item.output_object_id
      );
    SELECT count(*)::integer INTO v_active
    FROM app.spatial_tile_cache_reclamation_items item
    WHERE item.organization_id = v_plan.organization_id
      AND item.reclamation_id = v_plan.id
      AND item.state IN ('queued', 'running');
    IF v_active = 0 THEN
      UPDATE app.spatial_tile_cache_reclamations
      SET state = 'failed', error_code = 'render_cache_output_referenced',
          worker_token = NULL, lease_expires_at = NULL,
          last_heartbeat_at = NULL, started_at = COALESCE(started_at, v_now),
          finished_at = v_now
      WHERE id = v_plan.id;
      claim_status := 'already_failed';
    ELSE
      UPDATE app.spatial_tile_cache_reclamations target
      SET state = 'running', worker_token = p_worker_token,
          lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
          last_heartbeat_at = v_now,
          attempt_count = target.attempt_count + 1,
          started_at = COALESCE(target.started_at, v_now),
          finished_at = NULL, error_code = NULL
      WHERE target.id = v_plan.id;
      claim_status := 'claimed';
      v_plan.attempt_count := v_plan.attempt_count + 1;
    END IF;
  END IF;
  RETURN QUERY SELECT claim_status, v_plan.id, v_plan.target_count,
    v_plan.target_size_bytes, v_plan.attempt_count;
END;
$$;

CREATE FUNCTION app.get_spatial_tile_cache_reclamation_targets(
  p_reclamation_id uuid,
  p_worker_token uuid
)
RETURNS TABLE (
  item_position smallint,
  render_job_id uuid,
  output_object_id uuid,
  bucket text,
  object_key text,
  storage_version_id text,
  etag text,
  content_type text,
  size_bytes bigint,
  checksum_sha256 text,
  delete_started_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT item.position, item.render_job_id, item.output_object_id,
         item.sealed_bucket, item.sealed_object_key,
         item.sealed_storage_version_id, item.sealed_etag,
         item.sealed_content_type, item.sealed_size_bytes,
         item.sealed_checksum_sha256, item.delete_started_at
  FROM app.spatial_tile_cache_reclamations reclamation
  JOIN app.spatial_tile_cache_reclamation_items item
    ON item.organization_id = reclamation.organization_id
   AND item.reclamation_id = reclamation.id
  WHERE reclamation.id = p_reclamation_id
    AND reclamation.state = 'running'
    AND reclamation.worker_token = p_worker_token
    AND reclamation.lease_expires_at > clock_timestamp()
    AND item.state IN ('queued', 'running')
  ORDER BY item.position;
$$;

CREATE FUNCTION app.heartbeat_spatial_tile_cache_reclamation(
  p_reclamation_id uuid, p_worker_token uuid, p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN RETURN false; END IF;
  UPDATE app.spatial_tile_cache_reclamations
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.start_spatial_tile_cache_reclamation_item_delete(
  p_reclamation_id uuid, p_item_position integer, p_worker_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_item app.spatial_tile_cache_reclamation_items%ROWTYPE;
BEGIN
  SELECT item.* INTO v_item
  FROM app.spatial_tile_cache_reclamations reclamation
  JOIN app.spatial_tile_cache_reclamation_items item
    ON item.organization_id = reclamation.organization_id
   AND item.reclamation_id = reclamation.id
  WHERE reclamation.id = p_reclamation_id
    AND reclamation.state = 'running'
    AND reclamation.worker_token = p_worker_token
    AND reclamation.lease_expires_at > clock_timestamp()
    AND item.position = p_item_position
    AND item.state IN ('queued', 'running')
  FOR UPDATE OF reclamation, item;
  IF NOT FOUND OR app.render_cache_output_is_referenced(
    v_item.organization_id, v_item.render_job_id, v_item.output_object_id
  ) THEN RETURN false; END IF;
  UPDATE app.spatial_tile_cache_reclamation_items
  SET state = 'running', delete_started_at = COALESCE(
        delete_started_at, clock_timestamp()
      )
  WHERE organization_id = v_item.organization_id
    AND reclamation_id = v_item.reclamation_id
    AND position = v_item.position;
  UPDATE app.spatial_tile_cache_reclamations
  SET last_heartbeat_at = clock_timestamp()
  WHERE id = p_reclamation_id AND worker_token = p_worker_token;
  RETURN true;
END;
$$;

CREATE FUNCTION app.complete_spatial_tile_cache_reclamation_item(
  p_reclamation_id uuid, p_item_position integer, p_worker_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_item app.spatial_tile_cache_reclamation_items%ROWTYPE;
  v_deleted integer;
BEGIN
  SELECT item.* INTO v_item
  FROM app.spatial_tile_cache_reclamations reclamation
  JOIN app.spatial_tile_cache_reclamation_items item
    ON item.organization_id = reclamation.organization_id
   AND item.reclamation_id = reclamation.id
  WHERE reclamation.id = p_reclamation_id
    AND reclamation.state = 'running'
    AND reclamation.worker_token = p_worker_token
    AND reclamation.lease_expires_at > clock_timestamp()
    AND item.position = p_item_position
    AND item.state = 'running' AND item.delete_started_at IS NOT NULL
  FOR UPDATE OF reclamation, item;
  IF NOT FOUND OR app.render_cache_output_is_referenced(
    v_item.organization_id, v_item.render_job_id, v_item.output_object_id
  ) THEN RETURN false; END IF;
  PERFORM 1 FROM app.data_objects object
  WHERE object.organization_id = v_item.organization_id
    AND object.id = v_item.output_object_id
    AND object.bucket = v_item.sealed_bucket
    AND object.object_key = v_item.sealed_object_key
    AND object.s3_version_id = v_item.sealed_storage_version_id
    AND lower(object.etag) = v_item.sealed_etag
    AND object.content_type = v_item.sealed_content_type
    AND object.size_bytes = v_item.sealed_size_bytes
    AND object.checksum_sha256 = v_item.sealed_checksum_sha256
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM app.dataset_version_objects
  WHERE organization_id = v_item.organization_id
    AND data_object_id = v_item.output_object_id;
  DELETE FROM app.data_objects object
  WHERE object.organization_id = v_item.organization_id
    AND object.id = v_item.output_object_id
    AND object.bucket = v_item.sealed_bucket
    AND object.object_key = v_item.sealed_object_key
    AND object.s3_version_id = v_item.sealed_storage_version_id
    AND lower(object.etag) = v_item.sealed_etag
    AND object.content_type = v_item.sealed_content_type
    AND object.size_bytes = v_item.sealed_size_bytes
    AND object.checksum_sha256 = v_item.sealed_checksum_sha256;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN RETURN false; END IF;
  UPDATE app.spatial_tile_cache_reclamation_items
  SET state = 'completed', finished_at = clock_timestamp()
  WHERE organization_id = v_item.organization_id
    AND reclamation_id = v_item.reclamation_id
    AND position = v_item.position;
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_spatial_tile_cache_reclamation_item(
  p_reclamation_id uuid, p_item_position integer, p_worker_token uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200
  THEN RETURN false; END IF;
  UPDATE app.spatial_tile_cache_reclamation_items item
  SET state = 'failed', error_code = p_error_code,
      finished_at = clock_timestamp()
  FROM app.spatial_tile_cache_reclamations reclamation
  WHERE reclamation.organization_id = item.organization_id
    AND reclamation.id = item.reclamation_id
    AND reclamation.id = p_reclamation_id
    AND reclamation.state = 'running'
    AND reclamation.worker_token = p_worker_token
    AND reclamation.lease_expires_at > clock_timestamp()
    AND item.position = p_item_position
    AND item.state = 'queued' AND item.delete_started_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.finish_spatial_tile_cache_reclamation(
  p_reclamation_id uuid, p_worker_token uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_tile_cache_reclamations%ROWTYPE;
  v_active integer;
  v_completed integer;
  v_failed integer;
  v_state text;
BEGIN
  SELECT * INTO v_plan FROM app.spatial_tile_cache_reclamations
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token
    AND lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  SELECT count(*) FILTER (WHERE state IN ('queued', 'running')),
         count(*) FILTER (WHERE state = 'completed'),
         count(*) FILTER (WHERE state = 'failed')
  INTO v_active, v_completed, v_failed
  FROM app.spatial_tile_cache_reclamation_items
  WHERE organization_id = v_plan.organization_id
    AND reclamation_id = v_plan.id;
  IF v_active <> 0 OR v_completed + v_failed <> v_plan.target_count THEN
    RETURN 'not_ready';
  END IF;
  v_state := CASE WHEN v_failed = 0 THEN 'completed' ELSE 'failed' END;
  UPDATE app.spatial_tile_cache_reclamations
  SET state = v_state::app.processing_job_state,
      error_code = CASE WHEN v_failed = 0 THEN NULL
                        ELSE 'render_cache_reclamation_partial_failure' END,
      worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp()
  WHERE id = v_plan.id;
  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type,
     resource_type, resource_id, request_id, payload)
  VALUES
    (v_plan.organization_id, v_plan.created_by, v_plan.project_id,
     'spatial_service.tile_cache.reclamation.' || v_state,
     'spatial_service', v_plan.service_id, 'worker:' || v_plan.id::text,
     jsonb_build_object(
       'reclamation_id', v_plan.id, 'binding_id', v_plan.binding_id,
       'cache_id', v_plan.cache_id,
       'cache_version_number', v_plan.cache_version_number,
       'completed_target_count', v_completed,
       'failed_target_count', v_failed,
       'target_size_bytes', v_plan.target_size_bytes
     ));
  RETURN v_state;
END;
$$;

CREATE FUNCTION app.release_spatial_tile_cache_reclamation(
  p_reclamation_id uuid, p_worker_token uuid, p_error_code text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_plan app.spatial_tile_cache_reclamations%ROWTYPE;
  v_ambiguous boolean;
  v_state text;
BEGIN
  IF p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 200 OR p_max_attempts NOT BETWEEN 1 AND 100
  THEN RETURN 'lost'; END IF;
  SELECT * INTO v_plan FROM app.spatial_tile_cache_reclamations
  WHERE id = p_reclamation_id AND state = 'running'
    AND worker_token = p_worker_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM app.spatial_tile_cache_reclamation_items item
    WHERE item.organization_id = v_plan.organization_id
      AND item.reclamation_id = v_plan.id
      AND item.state = 'running' AND item.delete_started_at IS NOT NULL
  ) INTO v_ambiguous;
  v_state := CASE WHEN v_ambiguous OR v_plan.attempt_count < p_max_attempts
                  THEN 'queued' ELSE 'failed' END;
  IF v_state = 'failed' THEN
    UPDATE app.spatial_tile_cache_reclamation_items
    SET state = 'failed', error_code = p_error_code,
        finished_at = clock_timestamp()
    WHERE organization_id = v_plan.organization_id
      AND reclamation_id = v_plan.id AND state = 'queued';
  END IF;
  UPDATE app.spatial_tile_cache_reclamations
  SET state = v_state::app.processing_job_state, error_code = p_error_code,
      worker_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL,
      finished_at = CASE WHEN v_state = 'failed' THEN clock_timestamp() ELSE NULL END
  WHERE id = v_plan.id;
  RETURN v_state;
END;
$$;

-- Queueing hides every target before any storage call. The optional coverage
-- clause preserves SERVICE-009 behavior in sparse domain-test migration sets.
DROP POLICY data_objects_tenant_isolation ON app.data_objects;
DO $$
DECLARE
  v_coverage_clause text := '';
BEGIN
  IF to_regclass('app.spatial_coverage_derivative_reclamations') IS NOT NULL THEN
    v_coverage_clause := '
      AND NOT EXISTS (
        SELECT 1 FROM app.spatial_coverage_derivative_reclamations reclamation
        WHERE reclamation.organization_id = data_objects.organization_id
          AND reclamation.output_object_id = data_objects.id
          AND reclamation.state IN (''queued'', ''running'', ''completed'')
      )';
  END IF;
  EXECUTE 'CREATE POLICY data_objects_tenant_isolation ON app.data_objects
    USING (
      organization_id = app.current_organization_id()
      ' || v_coverage_clause || '
      AND NOT EXISTS (
        SELECT 1 FROM app.spatial_tile_cache_reclamation_items item
        WHERE item.organization_id = data_objects.organization_id
          AND item.output_object_id = data_objects.id
          AND item.state IN (''queued'', ''running'', ''completed'')
      )
    )
    WITH CHECK (organization_id = app.current_organization_id())';
END;
$$;

ALTER TABLE app.spatial_tile_cache_reclamations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_reclamations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_reclamation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_reclamation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY spatial_tile_cache_reclamations_tenant_isolation
  ON app.spatial_tile_cache_reclamations
  USING (organization_id = app.current_organization_id());
CREATE POLICY spatial_tile_cache_reclamation_items_tenant_isolation
  ON app.spatial_tile_cache_reclamation_items
  USING (organization_id = app.current_organization_id());

GRANT SELECT ON app.spatial_tile_cache_reclamations TO opengeo_runtime;
GRANT SELECT ON app.spatial_tile_cache_reclamation_items TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON
  app.spatial_tile_cache_reclamations,
  app.spatial_tile_cache_reclamation_items
FROM opengeo_runtime;
REVOKE ALL ON
  app.spatial_tile_cache_reclamations,
  app.spatial_tile_cache_reclamation_items
FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.render_cache_output_is_referenced(uuid, uuid, uuid),
  app.render_cache_reclamation_candidate_targets(uuid, uuid, uuid, uuid, uuid),
  app.render_cache_reclamation_candidate_facts(uuid, uuid, uuid, uuid, uuid),
  app.queue_spatial_tile_cache_reclamation(
    uuid, uuid, uuid, uuid, uuid, uuid[], text, timestamptz, uuid, text
  ),
  app.claim_spatial_tile_cache_reclamation(uuid, uuid, integer),
  app.get_spatial_tile_cache_reclamation_targets(uuid, uuid),
  app.heartbeat_spatial_tile_cache_reclamation(uuid, uuid, integer),
  app.start_spatial_tile_cache_reclamation_item_delete(uuid, integer, uuid),
  app.complete_spatial_tile_cache_reclamation_item(uuid, integer, uuid),
  app.fail_spatial_tile_cache_reclamation_item(uuid, integer, uuid, text),
  app.finish_spatial_tile_cache_reclamation(uuid, uuid),
  app.release_spatial_tile_cache_reclamation(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.queue_spatial_tile_cache_reclamation(
  uuid, uuid, uuid, uuid, uuid, uuid[], text, timestamptz, uuid, text
) TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.render_cache_reclamation_candidate_facts(uuid, uuid, uuid, uuid, uuid)
TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION
  app.claim_spatial_tile_cache_reclamation(uuid, uuid, integer),
  app.get_spatial_tile_cache_reclamation_targets(uuid, uuid),
  app.heartbeat_spatial_tile_cache_reclamation(uuid, uuid, integer),
  app.start_spatial_tile_cache_reclamation_item_delete(uuid, integer, uuid),
  app.complete_spatial_tile_cache_reclamation_item(uuid, integer, uuid),
  app.fail_spatial_tile_cache_reclamation_item(uuid, integer, uuid, text),
  app.finish_spatial_tile_cache_reclamation(uuid, uuid),
  app.release_spatial_tile_cache_reclamation(uuid, uuid, text, integer)
TO opengeo_worker;

COMMENT ON TABLE app.spatial_tile_cache_reclamations IS
  'Explicit preview-confirmed batches of at most 64 unreachable retired-cache render outputs; reads and timers never create work.';
COMMENT ON TABLE app.spatial_tile_cache_reclamation_items IS
  'Worker-only exact storage seals with per-object durable delete boundaries and retained result history.';

COMMIT;
