BEGIN;

CREATE TABLE app.spatial_tile_caches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  service_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  current_version_id uuid NOT NULL,
  current_version_number bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, binding_id),
  CONSTRAINT spatial_tile_caches_version_positive CHECK (current_version_number > 0),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, service_id)
    REFERENCES app.spatial_services (organization_id, id),
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES app.spatial_service_collections (organization_id, id)
);

CREATE TABLE app.spatial_tile_cache_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  cache_id uuid NOT NULL,
  version_number bigint NOT NULL,
  minimum_tile_matrix integer NOT NULL DEFAULT 0,
  maximum_tile_matrix integer NOT NULL,
  maximum_entries integer NOT NULL,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, cache_id, version_number),
  UNIQUE (organization_id, cache_id, id),
  CONSTRAINT spatial_tile_cache_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT spatial_tile_cache_versions_matrix_range CHECK (
    minimum_tile_matrix BETWEEN 0 AND 22
    AND maximum_tile_matrix BETWEEN minimum_tile_matrix AND 22
  ),
  CONSTRAINT spatial_tile_cache_versions_entry_limit CHECK (
    maximum_entries BETWEEN 1 AND 10000
  ),
  CONSTRAINT spatial_tile_cache_versions_message_bounded CHECK (
    change_message IS NULL
    OR (change_message = btrim(change_message)
        AND char_length(change_message) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (organization_id, cache_id)
    REFERENCES app.spatial_tile_caches (organization_id, id)
);

ALTER TABLE app.spatial_tile_caches
  ADD CONSTRAINT spatial_tile_caches_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_id)
  REFERENCES app.spatial_tile_cache_versions (organization_id, cache_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.spatial_tile_cache_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  cache_id uuid NOT NULL,
  cache_version_id uuid NOT NULL,
  cache_version_number bigint NOT NULL,
  tile_matrix integer NOT NULL,
  tile_row integer NOT NULL,
  tile_col integer NOT NULL,
  render_job_id uuid NOT NULL,
  seeded_by uuid NOT NULL REFERENCES app.users(id),
  seeded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id, cache_id, cache_version_number,
    tile_matrix, tile_row, tile_col
  ),
  UNIQUE (organization_id, cache_id, cache_version_number, render_job_id),
  CONSTRAINT spatial_tile_cache_entries_matrix_bounded CHECK (
    tile_matrix BETWEEN 0 AND 22
  ),
  CONSTRAINT spatial_tile_cache_entries_coordinates_nonnegative CHECK (
    tile_row >= 0 AND tile_col >= 0
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, cache_id)
    REFERENCES app.spatial_tile_caches (organization_id, id),
  FOREIGN KEY (organization_id, cache_id, cache_version_id)
    REFERENCES app.spatial_tile_cache_versions (organization_id, cache_id, id),
  FOREIGN KEY (organization_id, cache_id, cache_version_number)
    REFERENCES app.spatial_tile_cache_versions (organization_id, cache_id, version_number),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_jobs (organization_id, id)
);

CREATE INDEX spatial_tile_caches_service_idx
  ON app.spatial_tile_caches (organization_id, project_id, service_id, binding_id);
CREATE INDEX spatial_tile_cache_entries_current_lookup_idx
  ON app.spatial_tile_cache_entries (
    organization_id, cache_id, cache_version_number,
    tile_matrix, tile_row, tile_col
  );

CREATE FUNCTION app.enforce_spatial_tile_cache_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.updated_by <> app.current_user_id()
    OR NEW.current_version_number <> 1
  THEN
    RAISE EXCEPTION 'spatial tile cache creator or initial version mismatch';
  END IF;
  PERFORM 1
  FROM app.spatial_service_collections binding
  JOIN app.spatial_services service
    ON service.organization_id = binding.organization_id
   AND service.project_id = binding.project_id
   AND service.id = binding.service_id
  WHERE binding.organization_id = NEW.organization_id
    AND binding.project_id = NEW.project_id
    AND binding.service_id = NEW.service_id
    AND binding.id = NEW.binding_id
    AND binding.withdrawn_at IS NULL
    AND service.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial tile cache must target an active binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_tile_cache_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.service_id <> OLD.service_id
    OR NEW.binding_id <> OLD.binding_id
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.current_version_number <> OLD.current_version_number + 1
    OR NEW.current_version_id = OLD.current_version_id
    OR NEW.updated_by <> app.current_user_id()
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'spatial tile cache advances one immutable version at a time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_tile_cache_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_cache app.spatial_tile_caches%ROWTYPE;
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'spatial tile cache version creator mismatch';
  END IF;
  SELECT * INTO current_cache
  FROM app.spatial_tile_caches cache
  WHERE cache.organization_id = NEW.organization_id
    AND cache.id = NEW.cache_id
  FOR UPDATE;
  IF NOT FOUND
    OR NOT (
      (NEW.version_number = 1
       AND current_cache.current_version_number = 1
       AND current_cache.current_version_id = NEW.id)
      OR NEW.version_number = current_cache.current_version_number + 1
    )
  THEN
    RAISE EXCEPTION 'spatial tile cache version must follow the current head';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_spatial_tile_cache_entry_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_cache app.spatial_tile_caches%ROWTYPE;
  current_version app.spatial_tile_cache_versions%ROWTYPE;
  binding app.spatial_service_collections%ROWTYPE;
  job app.map_render_jobs%ROWTYPE;
  matrix_width bigint;
  entry_count bigint;
  tile_span double precision;
  expected_bbox double precision[];
  coordinate integer;
BEGIN
  IF NEW.seeded_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'spatial tile cache entry actor mismatch';
  END IF;
  SELECT * INTO current_cache
  FROM app.spatial_tile_caches cache
  WHERE cache.organization_id = NEW.organization_id
    AND cache.project_id = NEW.project_id
    AND cache.id = NEW.cache_id
  FOR UPDATE;
  IF NOT FOUND
    OR NEW.cache_version_id <> current_cache.current_version_id
    OR NEW.cache_version_number <> current_cache.current_version_number
  THEN
    RAISE EXCEPTION 'spatial tile cache entry must target the current version';
  END IF;
  SELECT * INTO current_version
  FROM app.spatial_tile_cache_versions version
  WHERE version.organization_id = NEW.organization_id
    AND version.cache_id = NEW.cache_id
    AND version.id = NEW.cache_version_id
    AND version.version_number = NEW.cache_version_number;
  IF NOT FOUND
    OR NEW.tile_matrix NOT BETWEEN current_version.minimum_tile_matrix
                               AND current_version.maximum_tile_matrix
  THEN
    RAISE EXCEPTION 'spatial tile cache entry is outside the policy';
  END IF;
  matrix_width := (1::bigint << NEW.tile_matrix);
  IF NEW.tile_row >= matrix_width OR NEW.tile_col >= matrix_width THEN
    RAISE EXCEPTION 'spatial tile cache coordinate is outside the matrix';
  END IF;
  SELECT count(*) INTO entry_count
  FROM app.spatial_tile_cache_entries entry
  WHERE entry.organization_id = NEW.organization_id
    AND entry.cache_id = NEW.cache_id
    AND entry.cache_version_number = NEW.cache_version_number;
  IF entry_count >= current_version.maximum_entries THEN
    RAISE EXCEPTION 'spatial tile cache entry limit reached';
  END IF;
  SELECT * INTO binding
  FROM app.spatial_service_collections candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = current_cache.binding_id
    AND candidate.withdrawn_at IS NULL;
  SELECT * INTO job
  FROM app.map_render_jobs candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.project_id = NEW.project_id
    AND candidate.id = NEW.render_job_id;
  IF binding.id IS NULL OR job.id IS NULL
    OR job.resource_id <> binding.resource_id
    OR job.profile_id <> binding.default_profile_id
    OR job.profile_version_id <> binding.sealed_profile_version_id
    OR job.crs <> 'EPSG:3857'
    OR job.width <> 256 OR job.height <> 256
    OR job.format::text <> 'png'
    OR job.background_color IS NOT NULL OR NOT job.transparent
  THEN
    RAISE EXCEPTION 'spatial tile cache entry render seal mismatch';
  END IF;
  tile_span := 40075016.685578488 / matrix_width;
  expected_bbox := ARRAY[
    -20037508.342789244 + NEW.tile_col * tile_span,
    20037508.342789244 - (NEW.tile_row + 1) * tile_span,
    -20037508.342789244 + (NEW.tile_col + 1) * tile_span,
    20037508.342789244 - NEW.tile_row * tile_span
  ];
  FOR coordinate IN 0..3 LOOP
    IF abs((job.bbox ->> coordinate)::double precision - expected_bbox[coordinate + 1]) > 0.000001
    THEN
      RAISE EXCEPTION 'spatial tile cache entry bbox mismatch';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spatial_tile_caches_validate_insert
  BEFORE INSERT ON app.spatial_tile_caches
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_tile_cache_insert();
CREATE TRIGGER spatial_tile_caches_enforce_transition
  BEFORE UPDATE ON app.spatial_tile_caches
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_tile_cache_transition();
CREATE TRIGGER spatial_tile_cache_versions_validate_insert
  BEFORE INSERT ON app.spatial_tile_cache_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_tile_cache_version_insert();
CREATE TRIGGER spatial_tile_cache_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.spatial_tile_cache_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER spatial_tile_cache_entries_validate_insert
  BEFORE INSERT ON app.spatial_tile_cache_entries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_spatial_tile_cache_entry_insert();
CREATE TRIGGER spatial_tile_cache_entries_are_immutable
  BEFORE UPDATE OR DELETE ON app.spatial_tile_cache_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.spatial_tile_caches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_caches FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.spatial_tile_cache_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY spatial_tile_caches_tenant_isolation ON app.spatial_tile_caches
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_tile_cache_versions_tenant_isolation
  ON app.spatial_tile_cache_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY spatial_tile_cache_entries_tenant_isolation
  ON app.spatial_tile_cache_entries
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.spatial_tile_caches TO opengeo_runtime;
GRANT SELECT, INSERT ON
  app.spatial_tile_cache_versions,
  app.spatial_tile_cache_entries
TO opengeo_runtime;
REVOKE DELETE ON
  app.spatial_tile_caches,
  app.spatial_tile_cache_versions,
  app.spatial_tile_cache_entries
FROM opengeo_runtime;
REVOKE ALL ON
  app.spatial_tile_caches,
  app.spatial_tile_cache_versions,
  app.spatial_tile_cache_entries
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_spatial_tile_cache_insert(),
  app.enforce_spatial_tile_cache_transition(),
  app.enforce_spatial_tile_cache_version_insert(),
  app.enforce_spatial_tile_cache_entry_insert()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.spatial_tile_caches IS
  'Tenant-scoped durable WMTS cache heads bound one-to-one to immutable administered service collection seals.';
COMMENT ON TABLE app.spatial_tile_cache_versions IS
  'Immutable cache policy generations; advancing the head invalidates old entries without rewriting audit history.';
COMMENT ON TABLE app.spatial_tile_cache_entries IS
  'Immutable WebMercatorQuad coordinates pointing to exact deterministic render jobs; reads never create work.';

COMMIT;
