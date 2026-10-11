BEGIN;

-- Explicit operator delegation, disabled on every existing origin by default.
-- Only public delivery origins may opt in; never the authenticated Studio or
-- capability preview origin. Runtime cannot change this column or create origins.
ALTER TABLE app.framework_publication_origins ADD COLUMN self_service_prefix text
  CHECK (self_service_prefix IS NULL OR (
    self_service_prefix ~ '^/[a-z0-9][a-z0-9-]{0,79}(/[a-z0-9][a-z0-9-]{0,79}){0,6}/$'
    AND hostname NOT IN ('studio.opengeo.tools', 'preview.studio.opengeo.tools', 'api.opengeo.tools', 'auth.opengeo.tools')
  ));

CREATE OR REPLACE FUNCTION app.guard_framework_publication_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.hostname, NEW.bucket, NEW.distribution_id, NEW.origin_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.hostname, OLD.bucket, OLD.distribution_id, OLD.origin_id)
  THEN RAISE EXCEPTION 'Publication delivery identity is immutable'; END IF;
  IF NEW.generation < OLD.generation OR (
    ROW(NEW.active_release_prefix, NEW.enabled, NEW.self_service_prefix)
      IS DISTINCT FROM ROW(OLD.active_release_prefix, OLD.enabled, OLD.self_service_prefix)
    AND NEW.generation <= OLD.generation
  ) THEN RAISE EXCEPTION 'Publication changes must advance generation'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reserve_framework_publication_mount(
  p_id uuid, p_project uuid, p_source uuid, p_origin uuid, p_slug text, p_ack text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  origin app.framework_publication_origins%ROWTYPE;
  existing app.framework_publication_mounts%ROWTYPE;
  chosen_path text;
BEGIN
  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);
  IF NOT EXISTS (SELECT 1 FROM app.organization_memberships
      WHERE organization_id = app.current_organization_id() AND user_id = app.current_user_id() AND role = 'admin')
  THEN RAISE EXCEPTION 'Destination administration required' USING ERRCODE = '42501'; END IF;
  IF p_id IS NULL OR p_ack IS DISTINCT FROM 'reserve-address-without-publishing'
    OR p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$'
  THEN RAISE EXCEPTION 'Invalid publication destination request' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.observable_source_projects
      WHERE organization_id = app.current_organization_id() AND project_id = p_project AND id = p_source)
  THEN RAISE EXCEPTION 'Source project not found' USING ERRCODE = '42501'; END IF;
  SELECT * INTO origin FROM app.framework_publication_origins
    WHERE id = p_origin AND organization_id = app.current_organization_id() AND enabled
      AND self_service_prefix IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Public hosting is not authorized' USING ERRCODE = '42501'; END IF;
  chosen_path := origin.self_service_prefix || p_slug || '/';
  SELECT * INTO existing FROM app.framework_publication_mounts WHERE id = p_id;
  IF FOUND THEN
    IF ROW(existing.organization_id, existing.project_id, existing.source_project_id, existing.origin_id, existing.mount_path, existing.enabled)
      IS DISTINCT FROM ROW(app.current_organization_id(), p_project, p_source, p_origin, chosen_path, true)
    THEN RAISE EXCEPTION 'Publication destination identity conflict' USING ERRCODE = '23505'; END IF;
    RETURN existing.id;
  END IF;
  IF origin.active_publication_id IS NOT NULL THEN
    RAISE EXCEPTION 'Publication delivery is busy' USING ERRCODE = '23505';
  END IF;
  -- Disabled/retired paths stay reserved. Siblings and their descendants cannot
  -- be captured by a new source; a root outside the delegated prefix is retained.
  IF EXISTS (SELECT 1 FROM app.framework_publication_mounts
    WHERE origin_id = origin.id AND mount_path LIKE origin.self_service_prefix || '%'
      AND (chosen_path LIKE mount_path || '%' OR mount_path LIKE chosen_path || '%'))
  THEN RAISE EXCEPTION 'Publication address is already reserved' USING ERRCODE = '23505'; END IF;
  INSERT INTO app.framework_publication_mounts
    (id, organization_id, project_id, source_project_id, origin_id, mount_path, enabled, verified_by, verified_at)
  VALUES (p_id, app.current_organization_id(), p_project, p_source, origin.id, chosen_path, true, app.current_user_id(), clock_timestamp());
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION app.reserve_framework_publication_mount(uuid, uuid, uuid, uuid, text, text)
  FROM PUBLIC, opengeo_worker, opengeo_connector, opengeo_observable_coordinator, opengeo_framework_publisher;
GRANT EXECUTE ON FUNCTION app.reserve_framework_publication_mount(uuid, uuid, uuid, uuid, text, text) TO opengeo_runtime;

COMMIT;
