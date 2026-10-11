BEGIN;

CREATE TABLE app.observable_preview_capabilities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  token_checksum_sha256 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT observable_preview_capability_token_valid CHECK (
    token_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT observable_preview_capability_time_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '2 minutes'
    AND (
      consumed_at IS NULL
      OR consumed_at BETWEEN created_at AND expires_at
    )
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, build_job_id)
    REFERENCES app.observable_build_jobs (organization_id, project_id, id),
  FOREIGN KEY (organization_id, requested_by)
    REFERENCES app.organization_memberships (organization_id, user_id)
);

CREATE INDEX observable_preview_capabilities_expiry_idx
  ON app.observable_preview_capabilities (expires_at, id)
  WHERE consumed_at IS NULL;

CREATE FUNCTION app.enforce_observable_preview_capability_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_build app.observable_build_jobs%ROWTYPE;
  v_active_count integer;
  v_recent_count integer;
  v_entry_file text;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.requested_by IS DISTINCT FROM app.current_user_id()
    OR NEW.consumed_at IS NOT NULL
    OR NEW.expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Observable preview capability actor is invalid';
  END IF;
  SELECT * INTO v_build
  FROM app.observable_build_jobs
  WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id
    AND id = NEW.build_job_id;
  IF NOT FOUND OR v_build.state <> 'succeeded' OR v_build.result IS NULL THEN
    RAISE EXCEPTION 'Observable preview requires one successful exact build';
  END IF;
  SELECT route->>'file' INTO v_entry_file
  FROM jsonb_array_elements(v_build.result->'routeManifest') route
  WHERE route->>'path' = '/'
  LIMIT 1;
  IF v_entry_file IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_build.result->'outputManifest'->'files') file
      WHERE file->>'path' = v_entry_file
        AND file->>'contentType' = 'text/html'
        AND file->>'objectKey'
          = v_build.output_prefix || substring(v_entry_file FROM 6)
    )
  THEN
    RAISE EXCEPTION 'Observable preview build has no exact root document';
  END IF;
  SELECT count(*)::integer INTO v_active_count
  FROM app.observable_preview_capabilities capability
  WHERE capability.organization_id = NEW.organization_id
    AND capability.build_job_id = NEW.build_job_id
    AND capability.requested_by = NEW.requested_by
    AND capability.consumed_at IS NULL
    AND capability.expires_at > clock_timestamp();
  SELECT count(*)::integer INTO v_recent_count
  FROM app.observable_preview_capabilities capability
  WHERE capability.organization_id = NEW.organization_id
    AND capability.requested_by = NEW.requested_by
    AND capability.created_at > clock_timestamp() - interval '24 hours';
  IF v_active_count >= 8 OR v_recent_count >= 256 THEN
    RAISE EXCEPTION 'Observable preview capability quota exceeded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_preview_capability_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.build_job_id <> OLD.build_job_id
    OR NEW.requested_by <> OLD.requested_by
    OR NEW.token_checksum_sha256 <> OLD.token_checksum_sha256
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
    OR NEW.consumed_at < NEW.created_at
    OR NEW.consumed_at > NEW.expires_at
  THEN
    RAISE EXCEPTION 'Observable preview capability is immutable or already consumed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER observable_preview_capability_insert_guard
BEFORE INSERT ON app.observable_preview_capabilities
FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_preview_capability_insert();

CREATE TRIGGER observable_preview_capability_update_guard
BEFORE UPDATE ON app.observable_preview_capabilities
FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_preview_capability_update();

CREATE FUNCTION app.consume_observable_preview_capability(
  p_capability_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_token_checksum_sha256 text
)
RETURNS TABLE (
  output_prefix text,
  entry_file text,
  cookie_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, public
SET row_security = off
AS $$
DECLARE
  v_capability app.observable_preview_capabilities%ROWTYPE;
  v_build app.observable_build_jobs%ROWTYPE;
  v_entry_file text;
BEGIN
  IF p_capability_id IS NULL OR p_organization_id IS NULL OR p_user_id IS NULL
    OR p_token_checksum_sha256 !~ '^[0-9a-f]{64}$'
    OR p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR p_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RETURN;
  END IF;
  SELECT * INTO v_capability
  FROM app.observable_preview_capabilities capability
  WHERE capability.id = p_capability_id
    AND capability.organization_id = p_organization_id
    AND capability.requested_by = p_user_id
    AND capability.token_checksum_sha256 = p_token_checksum_sha256
  FOR UPDATE;
  IF NOT FOUND OR v_capability.consumed_at IS NOT NULL
    OR v_capability.expires_at <= clock_timestamp()
  THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.organization_memberships membership
    WHERE membership.organization_id = v_capability.organization_id
      AND membership.user_id = v_capability.requested_by
      AND (
        membership.role = 'admin'
        OR EXISTS (
          SELECT 1
          FROM app.project_memberships project_membership
          WHERE project_membership.organization_id = v_capability.organization_id
            AND project_membership.project_id = v_capability.project_id
            AND project_membership.user_id = v_capability.requested_by
            AND project_membership.role IN ('owner', 'editor', 'reviewer', 'viewer')
        )
      )
  ) THEN
    RETURN;
  END IF;
  SELECT * INTO v_build
  FROM app.observable_build_jobs build
  WHERE build.organization_id = v_capability.organization_id
    AND build.project_id = v_capability.project_id
    AND build.id = v_capability.build_job_id
    AND build.state = 'succeeded'
  FOR SHARE;
  IF NOT FOUND OR v_build.result IS NULL THEN
    RETURN;
  END IF;
  SELECT route->>'file' INTO v_entry_file
  FROM jsonb_array_elements(v_build.result->'routeManifest') route
  WHERE route->>'path' = '/'
  LIMIT 1;
  IF v_entry_file IS NULL
    OR NOT app.observable_output_path_is_safe(v_entry_file)
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_build.result->'outputManifest'->'files') file
      WHERE file->>'path' = v_entry_file
        AND file->>'contentType' = 'text/html'
        AND file->>'objectKey'
          = v_build.output_prefix || substring(v_entry_file FROM 6)
    )
  THEN
    RETURN;
  END IF;
  UPDATE app.observable_preview_capabilities capability
  SET consumed_at = clock_timestamp()
  WHERE capability.id = v_capability.id;
  RETURN QUERY SELECT
    v_build.output_prefix,
    v_entry_file,
    clock_timestamp() + interval '15 minutes';
END;
$$;

ALTER TABLE app.observable_preview_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_preview_capabilities FORCE ROW LEVEL SECURITY;

CREATE POLICY observable_preview_capability_select
ON app.observable_preview_capabilities
FOR SELECT TO opengeo_runtime
USING (
  organization_id = app.current_organization_id()
  AND requested_by = app.current_user_id()
);

CREATE POLICY observable_preview_capability_insert
ON app.observable_preview_capabilities
FOR INSERT TO opengeo_runtime
WITH CHECK (
  organization_id = app.current_organization_id()
  AND requested_by = app.current_user_id()
);

GRANT SELECT, INSERT ON app.observable_preview_capabilities TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.observable_preview_capabilities FROM opengeo_runtime;
REVOKE ALL ON app.observable_preview_capabilities FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_observable_preview_capability_insert(),
  app.enforce_observable_preview_capability_update(),
  app.consume_observable_preview_capability(uuid, uuid, uuid, text)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.consume_observable_preview_capability(uuid, uuid, uuid, text)
TO opengeo_runtime;

COMMENT ON TABLE app.observable_preview_capabilities IS
  'Short-lived one-time exchanges from authenticated Studio authorization to path-scoped private preview delivery; raw capabilities are never stored.';
COMMENT ON FUNCTION app.consume_observable_preview_capability(uuid, uuid, uuid, text) IS
  'Consume one exact unexpired capability only while requester authorization and successful immutable build output still match.';

COMMIT;
