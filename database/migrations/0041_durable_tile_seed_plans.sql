BEGIN;

CREATE TABLE app.spatial_tile_seed_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  cache_id uuid NOT NULL,
  cache_version_id uuid NOT NULL,
  cache_version_number bigint NOT NULL,
  mode text NOT NULL,
  request_bbox double precision[],
  minimum_tile_matrix integer,
  maximum_tile_matrix integer,
  requested_count integer NOT NULL,
  existing_count integer NOT NULL,
  target_count integer NOT NULL,
  preview_checksum_sha256 text NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'preparing',
  error_code text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatch_started_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id, project_id, service_id, binding_id,
    preview_checksum_sha256, preview_expires_at
  ),
  CONSTRAINT spatial_tile_seed_plans_mode_valid CHECK (mode IN ('tiles', 'bbox')),
  CONSTRAINT spatial_tile_seed_plans_bbox_valid CHECK (
    (mode = 'tiles' AND request_bbox IS NULL)
    OR (mode = 'bbox' AND array_length(request_bbox, 1) = 4)
  ),
  CONSTRAINT spatial_tile_seed_plans_zoom_range_valid CHECK (
    minimum_tile_matrix IS NOT NULL AND maximum_tile_matrix IS NOT NULL
    AND minimum_tile_matrix BETWEEN 0 AND 22
    AND maximum_tile_matrix BETWEEN minimum_tile_matrix AND 22
  ),
  CONSTRAINT spatial_tile_seed_plans_counts_valid CHECK (
    requested_count BETWEEN 1 AND 64
    AND existing_count BETWEEN 0 AND requested_count
    AND target_count BETWEEN 1 AND 64
    AND requested_count = existing_count + target_count
  ),
  CONSTRAINT spatial_tile_seed_plans_checksum_valid CHECK (
    preview_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT spatial_tile_seed_plans_state_valid CHECK (
    state IN ('preparing', 'queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT spatial_tile_seed_plans_error_bounded CHECK (
    error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 100
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
  FOREIGN KEY (organization_id, cache_id, cache_version_number)
    REFERENCES app.spatial_tile_cache_versions (organization_id, cache_id, version_number)
);

CREATE TABLE app.spatial_tile_seed_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  plan_id uuid NOT NULL,
  cache_id uuid NOT NULL,
  cache_version_number bigint NOT NULL,
  position integer NOT NULL,
  tile_matrix integer NOT NULL,
  tile_row integer NOT NULL,
  tile_col integer NOT NULL,
  render_job_id uuid,
  state text NOT NULL DEFAULT 'pending',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, plan_id, position),
  UNIQUE (organization_id, plan_id, tile_matrix, tile_row, tile_col),
  UNIQUE (organization_id, plan_id, render_job_id),
  CONSTRAINT spatial_tile_seed_plan_items_position_valid CHECK (position BETWEEN 1 AND 64),
  CONSTRAINT spatial_tile_seed_plan_items_matrix_valid CHECK (tile_matrix BETWEEN 0 AND 22),
  CONSTRAINT spatial_tile_seed_plan_items_coordinates_valid CHECK (
    tile_row >= 0 AND tile_col >= 0
  ),
  CONSTRAINT spatial_tile_seed_plan_items_state_valid CHECK (
    state IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT spatial_tile_seed_plan_items_error_bounded CHECK (
    error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 100
  ),
  FOREIGN KEY (organization_id, plan_id)
    REFERENCES app.spatial_tile_seed_plans (organization_id, id),
  FOREIGN KEY (organization_id, cache_id)
    REFERENCES app.spatial_tile_caches (organization_id, id),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_jobs (organization_id, id)
);

CREATE UNIQUE INDEX spatial_tile_seed_plan_items_generation_coordinate_idx
  ON app.spatial_tile_seed_plan_items (
    organization_id, cache_id, cache_version_number,
    tile_matrix, tile_row, tile_col
  )
  WHERE state NOT IN ('failed', 'cancelled');
CREATE INDEX spatial_tile_seed_plans_binding_idx
  ON app.spatial_tile_seed_plans (
    organization_id, project_id, service_id, binding_id, created_at DESC
  );
CREATE INDEX spatial_tile_seed_plan_items_job_idx
  ON app.spatial_tile_seed_plan_items (organization_id, render_job_id)
  WHERE render_job_id IS NOT NULL;

CREATE FUNCTION app.queue_spatial_tile_seed_plan(
  requested_organization_id uuid,
  requested_project_id uuid,
  requested_service_id uuid,
  requested_binding_id uuid,
  requested_cache_version bigint,
  requested_mode text,
  requested_bbox double precision[],
  requested_minimum_tile_matrix integer,
  requested_maximum_tile_matrix integer,
  requested_matrices integer[],
  requested_rows integer[],
  requested_cols integer[],
  requested_count integer,
  requested_existing_count integer,
  requested_preview_checksum text,
  requested_preview_expires_at timestamptz,
  requested_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  cache_head app.spatial_tile_caches%ROWTYPE;
  policy app.spatial_tile_cache_versions%ROWTYPE;
  plan_id uuid;
  coordinate_count integer;
  current_count bigint;
  reserved_count bigint;
  active_count bigint;
  retained_count bigint;
  coordinate record;
  matrix_width bigint;
BEGIN
  IF requested_organization_id <> app.current_organization_id()
    OR requested_by <> app.current_user_id()
    OR requested_mode NOT IN ('tiles', 'bbox')
    OR requested_preview_expires_at <= clock_timestamp()
    OR requested_preview_expires_at > clock_timestamp() + interval '15 minutes'
    OR requested_preview_checksum !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid spatial tile seed plan request';
  END IF;
  coordinate_count := COALESCE(array_length(requested_matrices, 1), 0);
  IF coordinate_count NOT BETWEEN 1 AND 64
    OR coordinate_count <> COALESCE(array_length(requested_rows, 1), 0)
    OR coordinate_count <> COALESCE(array_length(requested_cols, 1), 0)
    OR requested_count <> requested_existing_count + coordinate_count
  THEN
    RAISE EXCEPTION 'spatial tile seed plan batch is invalid';
  END IF;
  SELECT * INTO cache_head
  FROM app.spatial_tile_caches cache
  WHERE cache.organization_id = requested_organization_id
    AND cache.project_id = requested_project_id
    AND cache.service_id = requested_service_id
    AND cache.binding_id = requested_binding_id
    AND cache.current_version_number = requested_cache_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial tile seed plan cache version changed';
  END IF;
  SELECT * INTO policy
  FROM app.spatial_tile_cache_versions version
  WHERE version.organization_id = cache_head.organization_id
    AND version.cache_id = cache_head.id
    AND version.id = cache_head.current_version_id
    AND version.version_number = cache_head.current_version_number;
  PERFORM 1
  FROM app.spatial_service_collections binding
  JOIN app.spatial_services service
    ON service.organization_id = binding.organization_id
   AND service.id = binding.service_id
  JOIN app.feature_collections features
    ON features.organization_id = binding.organization_id
   AND features.dataset_id = binding.dataset_id
  JOIN app.map_render_profiles profile
    ON profile.organization_id = binding.organization_id
   AND profile.id = binding.default_profile_id
  WHERE binding.organization_id = requested_organization_id
    AND binding.id = requested_binding_id
    AND binding.withdrawn_at IS NULL
    AND service.disabled_at IS NULL
    AND features.generation = binding.sealed_feature_generation
    AND profile.current_version_id = binding.sealed_profile_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial tile seed plan binding is not fresh';
  END IF;
  SELECT existing.id INTO plan_id
  FROM app.spatial_tile_seed_plans existing
  WHERE existing.organization_id = requested_organization_id
    AND existing.project_id = requested_project_id
    AND existing.service_id = requested_service_id
    AND existing.binding_id = requested_binding_id
    AND existing.preview_checksum_sha256 = requested_preview_checksum
    AND existing.preview_expires_at = requested_preview_expires_at;
  IF plan_id IS NOT NULL THEN
    RETURN plan_id;
  END IF;
  FOR coordinate IN
    SELECT matrix, row_number, col_number, ordinal
    FROM unnest(requested_matrices, requested_rows, requested_cols)
         WITH ORDINALITY AS item(matrix, row_number, col_number, ordinal)
    ORDER BY ordinal
  LOOP
    IF coordinate.matrix NOT BETWEEN policy.minimum_tile_matrix AND policy.maximum_tile_matrix
      OR coordinate.matrix <> requested_matrices[coordinate.ordinal]
      OR coordinate.row_number < 0 OR coordinate.col_number < 0
    THEN
      RAISE EXCEPTION 'spatial tile seed plan coordinate is outside the policy';
    END IF;
    matrix_width := (1::bigint << coordinate.matrix);
    IF coordinate.row_number >= matrix_width OR coordinate.col_number >= matrix_width THEN
      RAISE EXCEPTION 'spatial tile seed plan coordinate is outside the matrix';
    END IF;
    IF coordinate.ordinal > 1 AND ROW(
      coordinate.matrix, coordinate.row_number, coordinate.col_number
    ) <= ROW(
      requested_matrices[coordinate.ordinal - 1],
      requested_rows[coordinate.ordinal - 1],
      requested_cols[coordinate.ordinal - 1]
    ) THEN
      RAISE EXCEPTION 'spatial tile seed plan coordinates must be unique and sorted';
    END IF;
    PERFORM 1 FROM app.spatial_tile_cache_entries entry
    WHERE entry.organization_id = requested_organization_id
      AND entry.cache_id = cache_head.id
      AND entry.cache_version_number = cache_head.current_version_number
      AND entry.tile_matrix = coordinate.matrix
      AND entry.tile_row = coordinate.row_number
      AND entry.tile_col = coordinate.col_number;
    IF FOUND THEN
      RAISE EXCEPTION 'spatial tile seed plan target already exists';
    END IF;
  END LOOP;
  SELECT count(*) INTO active_count
  FROM app.spatial_tile_seed_plans plan
  WHERE plan.organization_id = requested_organization_id
    AND plan.cache_id = cache_head.id
    AND plan.cache_version_number = cache_head.current_version_number
    AND plan.state IN ('preparing', 'queued', 'running');
  SELECT count(*) INTO retained_count
  FROM app.spatial_tile_seed_plans plan
  WHERE plan.organization_id = requested_organization_id
    AND plan.cache_id = cache_head.id
    AND plan.cache_version_number = cache_head.current_version_number;
  IF active_count >= 4 OR retained_count >= 64 THEN
    RAISE EXCEPTION 'spatial tile seed plan limit reached';
  END IF;
  SELECT count(*) INTO current_count
  FROM app.spatial_tile_cache_entries entry
  WHERE entry.organization_id = requested_organization_id
    AND entry.cache_id = cache_head.id
    AND entry.cache_version_number = cache_head.current_version_number;
  SELECT COALESCE(sum(plan.target_count), 0) INTO reserved_count
  FROM app.spatial_tile_seed_plans plan
  WHERE plan.organization_id = requested_organization_id
    AND plan.cache_id = cache_head.id
    AND plan.cache_version_number = cache_head.current_version_number
    AND plan.state = 'preparing';
  IF current_count + reserved_count + coordinate_count > policy.maximum_entries THEN
    RAISE EXCEPTION 'spatial tile seed plan exceeds cache quota';
  END IF;
  plan_id := gen_random_uuid();
  INSERT INTO app.spatial_tile_seed_plans
    (id, organization_id, project_id, service_id, binding_id, cache_id,
     cache_version_id, cache_version_number, mode, request_bbox,
     minimum_tile_matrix, maximum_tile_matrix, requested_count, existing_count,
     target_count, preview_checksum_sha256, preview_expires_at, created_by)
  VALUES
    (plan_id, requested_organization_id, requested_project_id, requested_service_id,
     requested_binding_id, cache_head.id, cache_head.current_version_id,
     cache_head.current_version_number, requested_mode, requested_bbox,
     requested_minimum_tile_matrix, requested_maximum_tile_matrix,
     requested_count, requested_existing_count, coordinate_count,
     requested_preview_checksum, requested_preview_expires_at, requested_by);
  INSERT INTO app.spatial_tile_seed_plan_items
    (organization_id, plan_id, cache_id, cache_version_number, position,
     tile_matrix, tile_row, tile_col)
  SELECT requested_organization_id, plan_id, cache_head.id,
         cache_head.current_version_number, ordinal, matrix, row_number, col_number
  FROM unnest(requested_matrices, requested_rows, requested_cols)
       WITH ORDINALITY AS item(matrix, row_number, col_number, ordinal);
  RETURN plan_id;
END;
$$;

CREATE FUNCTION app.attach_spatial_tile_seed_plan_render(
  requested_organization_id uuid,
  requested_plan_id uuid,
  requested_position integer,
  requested_render_job_id uuid,
  requested_by uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  plan app.spatial_tile_seed_plans%ROWTYPE;
  item app.spatial_tile_seed_plan_items%ROWTYPE;
  binding app.spatial_service_collections%ROWTYPE;
  job app.map_render_jobs%ROWTYPE;
  tile_span double precision;
  expected_bbox double precision[];
  coordinate integer;
  next_state text;
BEGIN
  IF requested_organization_id <> app.current_organization_id()
    OR requested_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial tile seed plan actor mismatch';
  END IF;
  SELECT * INTO plan FROM app.spatial_tile_seed_plans candidate
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.id = requested_plan_id FOR UPDATE;
  SELECT * INTO item FROM app.spatial_tile_seed_plan_items candidate
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.plan_id = requested_plan_id
    AND candidate.position = requested_position FOR UPDATE;
  IF plan.id IS NULL OR item.id IS NULL OR plan.state <> 'preparing' THEN
    RAISE EXCEPTION 'spatial tile seed plan is not preparing';
  END IF;
  IF item.render_job_id IS NOT NULL THEN
    IF item.render_job_id <> requested_render_job_id THEN
      RAISE EXCEPTION 'spatial tile seed plan render collision';
    END IF;
    RETURN false;
  END IF;
  SELECT * INTO binding FROM app.spatial_service_collections candidate
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.id = plan.binding_id AND candidate.withdrawn_at IS NULL;
  SELECT * INTO job FROM app.map_render_jobs candidate
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.project_id = plan.project_id
    AND candidate.id = requested_render_job_id;
  IF binding.id IS NULL OR job.id IS NULL
    OR job.resource_id <> binding.resource_id
    OR job.profile_id <> binding.default_profile_id
    OR job.profile_version_id <> binding.sealed_profile_version_id
    OR job.crs <> 'EPSG:3857' OR job.width <> 256 OR job.height <> 256
    OR job.format::text <> 'png' OR job.background_color IS NOT NULL
    OR NOT job.transparent
  THEN
    RAISE EXCEPTION 'spatial tile seed plan render seal mismatch';
  END IF;
  tile_span := 40075016.685578488 / (1::bigint << item.tile_matrix);
  expected_bbox := ARRAY[
    -20037508.342789244 + item.tile_col * tile_span,
    20037508.342789244 - (item.tile_row + 1) * tile_span,
    -20037508.342789244 + (item.tile_col + 1) * tile_span,
    20037508.342789244 - item.tile_row * tile_span
  ];
  FOR coordinate IN 0..3 LOOP
    IF abs((job.bbox ->> coordinate)::double precision - expected_bbox[coordinate + 1]) > 0.000001 THEN
      RAISE EXCEPTION 'spatial tile seed plan render bbox mismatch';
    END IF;
  END LOOP;
  next_state := CASE job.state::text
    WHEN 'queued' THEN 'queued'
    WHEN 'running' THEN 'running'
    WHEN 'completed' THEN 'completed'
    ELSE 'failed'
  END;
  UPDATE app.spatial_tile_seed_plan_items
  SET render_job_id = requested_render_job_id,
      state = next_state,
      error_code = CASE WHEN next_state = 'failed' THEN 'render_failed' END,
      started_at = CASE WHEN next_state IN ('running', 'completed', 'failed')
                        THEN COALESCE(job.started_at, clock_timestamp()) END,
      finished_at = CASE WHEN next_state IN ('completed', 'failed')
                         THEN COALESCE(job.finished_at, clock_timestamp()) END
  WHERE organization_id = requested_organization_id AND id = item.id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.begin_spatial_tile_seed_plan_dispatch(
  requested_organization_id uuid,
  requested_plan_id uuid,
  requested_by uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  plan app.spatial_tile_seed_plans%ROWTYPE;
  cache_head app.spatial_tile_caches%ROWTYPE;
  next_state text;
BEGIN
  IF requested_organization_id <> app.current_organization_id()
    OR requested_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial tile seed plan actor mismatch';
  END IF;
  SELECT * INTO plan FROM app.spatial_tile_seed_plans candidate
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.id = requested_plan_id FOR UPDATE;
  IF plan.id IS NULL THEN RAISE EXCEPTION 'spatial tile seed plan not found'; END IF;
  IF plan.state <> 'preparing' THEN RETURN plan.state; END IF;
  IF EXISTS (
    SELECT 1 FROM app.spatial_tile_seed_plan_items item
    WHERE item.organization_id = requested_organization_id
      AND item.plan_id = requested_plan_id AND item.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'spatial tile seed plan preparation is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.spatial_tile_seed_plan_items item
    WHERE item.organization_id = requested_organization_id
      AND item.plan_id = requested_plan_id AND item.state = 'failed'
  ) THEN
    UPDATE app.spatial_tile_seed_plans
    SET state = 'failed', error_code = 'render_failed', finished_at = clock_timestamp()
    WHERE organization_id = requested_organization_id AND id = requested_plan_id;
    RETURN 'failed';
  END IF;
  SELECT * INTO cache_head FROM app.spatial_tile_caches cache
  WHERE cache.organization_id = requested_organization_id
    AND cache.id = plan.cache_id FOR UPDATE;
  IF cache_head.current_version_id <> plan.cache_version_id
    OR cache_head.current_version_number <> plan.cache_version_number
  THEN
    UPDATE app.spatial_tile_seed_plans
    SET state = 'failed', error_code = 'cache_version_changed', finished_at = clock_timestamp()
    WHERE organization_id = requested_organization_id AND id = requested_plan_id;
    RETURN 'failed';
  END IF;
  INSERT INTO app.spatial_tile_cache_entries
    (organization_id, project_id, cache_id, cache_version_id,
     cache_version_number, tile_matrix, tile_row, tile_col,
     render_job_id, seeded_by)
  SELECT item.organization_id, plan.project_id, plan.cache_id, plan.cache_version_id,
         plan.cache_version_number, item.tile_matrix, item.tile_row, item.tile_col,
         item.render_job_id, requested_by
  FROM app.spatial_tile_seed_plan_items item
  WHERE item.organization_id = requested_organization_id
    AND item.plan_id = requested_plan_id
  ORDER BY item.position;
  next_state := CASE
    WHEN EXISTS (SELECT 1 FROM app.spatial_tile_seed_plan_items item
                 WHERE item.organization_id = requested_organization_id
                   AND item.plan_id = requested_plan_id AND item.state = 'running')
      THEN 'running'
    WHEN EXISTS (SELECT 1 FROM app.spatial_tile_seed_plan_items item
                 WHERE item.organization_id = requested_organization_id
                   AND item.plan_id = requested_plan_id AND item.state = 'queued')
      THEN 'queued'
    ELSE 'completed'
  END;
  UPDATE app.spatial_tile_seed_plans
  SET state = next_state, dispatch_started_at = clock_timestamp(),
      started_at = CASE WHEN next_state IN ('running', 'completed')
                        THEN clock_timestamp() END,
      finished_at = CASE WHEN next_state = 'completed' THEN clock_timestamp() END
  WHERE organization_id = requested_organization_id AND id = requested_plan_id;
  RETURN next_state;
END;
$$;

CREATE FUNCTION app.cancel_spatial_tile_seed_plan(
  requested_organization_id uuid,
  requested_plan_id uuid,
  requested_by uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  plan_state text;
BEGIN
  IF requested_organization_id <> app.current_organization_id()
    OR requested_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'spatial tile seed plan actor mismatch';
  END IF;
  SELECT state INTO plan_state FROM app.spatial_tile_seed_plans
  WHERE organization_id = requested_organization_id AND id = requested_plan_id
  FOR UPDATE;
  IF plan_state IS NULL THEN RAISE EXCEPTION 'spatial tile seed plan not found'; END IF;
  IF plan_state = 'cancelled' THEN RETURN false; END IF;
  IF plan_state <> 'preparing' OR EXISTS (
    SELECT 1 FROM app.spatial_tile_seed_plan_items item
    JOIN app.map_render_jobs job
      ON job.organization_id = item.organization_id AND job.id = item.render_job_id
    WHERE item.organization_id = requested_organization_id
      AND item.plan_id = requested_plan_id
      AND job.state::text <> 'queued'
  ) THEN
    RAISE EXCEPTION 'spatial tile seed plan crossed the dispatch boundary';
  END IF;
  UPDATE app.spatial_tile_seed_plan_items
  SET state = 'cancelled', finished_at = clock_timestamp()
  WHERE organization_id = requested_organization_id AND plan_id = requested_plan_id;
  UPDATE app.spatial_tile_seed_plans
  SET state = 'cancelled', finished_at = clock_timestamp()
  WHERE organization_id = requested_organization_id AND id = requested_plan_id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.sync_spatial_tile_seed_render_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  target_plan uuid;
  next_item_state text;
  next_plan_state text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  next_item_state := CASE NEW.state::text
    WHEN 'queued' THEN 'queued'
    WHEN 'running' THEN 'running'
    WHEN 'completed' THEN 'completed'
    ELSE 'failed'
  END;
  FOR target_plan IN
    UPDATE app.spatial_tile_seed_plan_items
    SET state = next_item_state,
        error_code = CASE WHEN next_item_state = 'failed' THEN 'render_failed' END,
        started_at = CASE WHEN next_item_state IN ('running', 'completed', 'failed')
                          THEN COALESCE(started_at, NEW.started_at, clock_timestamp())
                          ELSE started_at END,
        finished_at = CASE WHEN next_item_state IN ('completed', 'failed')
                           THEN COALESCE(NEW.finished_at, clock_timestamp()) END
    WHERE organization_id = NEW.organization_id AND render_job_id = NEW.id
      AND state NOT IN ('cancelled', 'failed', 'completed')
    RETURNING plan_id
  LOOP
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM app.spatial_tile_seed_plan_items item
                   WHERE item.organization_id = NEW.organization_id
                     AND item.plan_id = target_plan AND item.state = 'failed') THEN 'failed'
      WHEN NOT EXISTS (SELECT 1 FROM app.spatial_tile_seed_plan_items item
                       WHERE item.organization_id = NEW.organization_id
                         AND item.plan_id = target_plan AND item.state <> 'completed') THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM app.spatial_tile_seed_plan_items item
                   WHERE item.organization_id = NEW.organization_id
                     AND item.plan_id = target_plan AND item.state = 'running') THEN 'running'
      ELSE 'queued'
    END INTO next_plan_state;
    UPDATE app.spatial_tile_seed_plans
    SET state = next_plan_state,
        error_code = CASE WHEN next_plan_state = 'failed' THEN 'render_failed' END,
        started_at = CASE WHEN next_plan_state IN ('running', 'completed', 'failed')
                          THEN COALESCE(started_at, clock_timestamp()) ELSE started_at END,
        finished_at = CASE WHEN next_plan_state IN ('completed', 'failed')
                           THEN clock_timestamp() ELSE NULL END
    WHERE organization_id = NEW.organization_id AND id = target_plan
      AND dispatch_started_at IS NOT NULL AND state NOT IN ('cancelled', 'completed', 'failed');
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER map_render_jobs_sync_tile_seed_plans
  AFTER UPDATE OF state ON app.map_render_jobs
  FOR EACH ROW EXECUTE FUNCTION app.sync_spatial_tile_seed_render_state();

ALTER TABLE app.spatial_tile_seed_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_seed_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_seed_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_seed_plan_items FORCE ROW LEVEL SECURITY;
CREATE POLICY spatial_tile_seed_plans_tenant_isolation ON app.spatial_tile_seed_plans
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_tile_seed_plan_items_tenant_isolation ON app.spatial_tile_seed_plan_items
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT ON app.spatial_tile_seed_plans, app.spatial_tile_seed_plan_items
  TO opengeo_runtime;
REVOKE ALL ON app.spatial_tile_seed_plans, app.spatial_tile_seed_plan_items
  FROM opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.queue_spatial_tile_seed_plan(uuid,uuid,uuid,uuid,bigint,text,double precision[],integer,integer,integer[],integer[],integer[],integer,integer,text,timestamptz,uuid),
  app.attach_spatial_tile_seed_plan_render(uuid,uuid,integer,uuid,uuid),
  app.begin_spatial_tile_seed_plan_dispatch(uuid,uuid,uuid),
  app.cancel_spatial_tile_seed_plan(uuid,uuid,uuid)
TO opengeo_runtime;
REVOKE EXECUTE ON FUNCTION app.sync_spatial_tile_seed_render_state()
  FROM PUBLIC, opengeo_runtime, opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.queue_spatial_tile_seed_plan(uuid,uuid,uuid,uuid,bigint,text,double precision[],integer,integer,integer[],integer[],integer[],integer,integer,text,timestamptz,uuid),
  app.attach_spatial_tile_seed_plan_render(uuid,uuid,integer,uuid,uuid),
  app.begin_spatial_tile_seed_plan_dispatch(uuid,uuid,uuid),
  app.cancel_spatial_tile_seed_plan(uuid,uuid,uuid)
FROM PUBLIC, opengeo_worker;

COMMENT ON TABLE app.spatial_tile_seed_plans IS
  'Durable, checksum-confirmed, quota-reserved batches of at most 64 exact tiles; previews, reads, and timers never create work.';
COMMENT ON COLUMN app.spatial_tile_seed_plans.dispatch_started_at IS
  'Irreversible boundary after which immutable cache entries exist and queued render commands may be sent.';
COMMENT ON TABLE app.spatial_tile_seed_plan_items IS
  'Deterministically ordered coordinates attached to the existing authoritative map render jobs, never a second rendering system.';

COMMIT;
