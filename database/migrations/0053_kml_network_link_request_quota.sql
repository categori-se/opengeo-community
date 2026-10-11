BEGIN;

CREATE TABLE app.kml_network_link_quota_lock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO app.kml_network_link_quota_lock (singleton) VALUES (true);

CREATE TABLE app.kml_network_link_request_slots (
  request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES app.organization_memberships (organization_id, user_id),
  CONSTRAINT kml_network_link_request_slots_lease_bounded CHECK (
    lease_expires_at > started_at
    AND lease_expires_at <= started_at + interval '15 seconds'
  ),
  CONSTRAINT kml_network_link_request_slots_release_ordered CHECK (
    released_at IS NULL OR released_at >= started_at
  )
);

CREATE INDEX kml_network_link_request_slots_key_window_idx
  ON app.kml_network_link_request_slots
    (organization_id, project_id, user_id, started_at DESC);
CREATE INDEX kml_network_link_request_slots_active_idx
  ON app.kml_network_link_request_slots (lease_expires_at)
  WHERE released_at IS NULL;

ALTER TABLE app.kml_network_link_quota_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kml_network_link_quota_lock FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kml_network_link_request_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kml_network_link_request_slots FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.acquire_kml_network_link_request_slot(
  p_request_id uuid,
  p_project_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_organization_id uuid := app.current_organization_id();
  v_now timestamptz := clock_timestamp();
  v_count integer;
BEGIN
  IF p_request_id IS NULL OR p_project_id IS NULL OR p_user_id IS NULL
    OR p_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'invalid KML NetworkLink quota request';
  END IF;

  PERFORM 1
  FROM app.projects project
  WHERE project.organization_id = v_organization_id
    AND project.id = p_project_id
    AND project.status = 'active'
    AND app.effective_project_role(project.id, p_user_id) IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KML NetworkLink project access denied'
      USING ERRCODE = '42501';
  END IF;

  -- One fixed row serializes the small global quota decision across Lambda
  -- runtimes. The external fetch happens after this transaction commits.
  PERFORM singleton
  FROM app.kml_network_link_quota_lock
  WHERE singleton
  FOR UPDATE;

  DELETE FROM app.kml_network_link_request_slots slot
  WHERE slot.started_at <= v_now - interval '1 minute'
    AND (slot.released_at IS NOT NULL OR slot.lease_expires_at <= v_now);

  SELECT count(*) INTO v_count
  FROM app.kml_network_link_request_slots slot
  WHERE slot.organization_id = v_organization_id
    AND slot.project_id = p_project_id
    AND slot.user_id = p_user_id
    AND slot.started_at > v_now - interval '1 minute';
  IF v_count >= 60 THEN
    RETURN 'rate_limited';
  END IF;

  SELECT count(*) INTO v_count
  FROM app.kml_network_link_request_slots slot
  WHERE slot.organization_id = v_organization_id
    AND slot.project_id = p_project_id
    AND slot.user_id = p_user_id
    AND slot.released_at IS NULL
    AND slot.lease_expires_at > v_now;
  IF v_count >= 4 THEN
    RETURN 'busy';
  END IF;

  SELECT count(*) INTO v_count
  FROM app.kml_network_link_request_slots slot
  WHERE slot.released_at IS NULL
    AND slot.lease_expires_at > v_now;
  IF v_count >= 8 THEN
    RETURN 'busy';
  END IF;

  INSERT INTO app.kml_network_link_request_slots
    (request_id, organization_id, project_id, user_id, started_at, lease_expires_at)
  VALUES
    (p_request_id, v_organization_id, p_project_id, p_user_id,
     v_now, v_now + interval '15 seconds');
  RETURN 'acquired';
END;
$$;

CREATE FUNCTION app.release_kml_network_link_request_slot(
  p_request_id uuid,
  p_project_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_request_id IS NULL OR p_project_id IS NULL OR p_user_id IS NULL
    OR p_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'invalid KML NetworkLink quota release';
  END IF;

  UPDATE app.kml_network_link_request_slots slot
  SET released_at = COALESCE(slot.released_at, clock_timestamp())
  WHERE slot.request_id = p_request_id
    AND slot.organization_id = app.current_organization_id()
    AND slot.project_id = p_project_id
    AND slot.user_id = p_user_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON
  app.kml_network_link_quota_lock,
  app.kml_network_link_request_slots
FROM opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_dataset_verifier;

REVOKE EXECUTE ON FUNCTION
  app.acquire_kml_network_link_request_slot(uuid, uuid, uuid),
  app.release_kml_network_link_request_slot(uuid, uuid, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.acquire_kml_network_link_request_slot(uuid, uuid, uuid),
  app.release_kml_network_link_request_slot(uuid, uuid, uuid)
TO opengeo_runtime;

COMMENT ON TABLE app.kml_network_link_request_slots IS
  'Short-lived distributed NetworkLink quota leases; target URLs, validators, response bytes, and credentials are never stored.';
COMMENT ON FUNCTION app.acquire_kml_network_link_request_slot(uuid, uuid, uuid) IS
  'Atomically applies fixed 60/minute, four-per-user/project, and eight-platform-wide NetworkLink limits.';

COMMIT;
