BEGIN;

CREATE TABLE app.public_wms_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  title text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_by uuid REFERENCES app.users(id),
  disabled_at timestamptz,
  UNIQUE (organization_id, id),
  CONSTRAINT public_wms_services_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 200
    AND title = btrim(title)
  ),
  CONSTRAINT public_wms_services_disable_shape CHECK (
    (disabled_by IS NULL AND disabled_at IS NULL)
    OR (disabled_by IS NOT NULL AND disabled_at IS NOT NULL AND disabled_at >= created_at)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE UNIQUE INDEX public_wms_services_one_active_project_idx
  ON app.public_wms_services (organization_id, project_id)
  WHERE disabled_at IS NULL;
CREATE INDEX public_wms_services_lookup_idx
  ON app.public_wms_services (organization_id, project_id, id, disabled_at);

CREATE FUNCTION app.enforce_public_wms_service_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.disabled_by IS NOT NULL
    OR NEW.disabled_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'public WMS service creator mismatch';
  END IF;

  PERFORM 1
  FROM app.wms_layer_publications publication
  JOIN app.governed_resources resource
    ON resource.organization_id = publication.organization_id
   AND resource.project_id = publication.project_id
   AND resource.id = publication.resource_id
  WHERE publication.organization_id = NEW.organization_id
    AND publication.project_id = NEW.project_id
    AND publication.withdrawn_at IS NULL
    AND resource.kind IN ('dataset', 'service')
    AND resource.state = 'published'
    AND resource.visibility = 'public';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public WMS service requires an active public layer publication';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_public_wms_service_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.title <> OLD.title
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'public WMS service identity is immutable';
  END IF;
  IF OLD.disabled_at IS NOT NULL
    OR NEW.disabled_at IS NULL
    OR NEW.disabled_by IS NULL
    OR NEW.disabled_by <> app.current_user_id()
    OR NEW.disabled_at < OLD.created_at
  THEN
    RAISE EXCEPTION 'public WMS service disable is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER public_wms_services_validate_insert
  BEFORE INSERT ON app.public_wms_services
  FOR EACH ROW EXECUTE FUNCTION app.enforce_public_wms_service_insert();
CREATE TRIGGER public_wms_services_enforce_transition
  BEFORE UPDATE ON app.public_wms_services
  FOR EACH ROW EXECUTE FUNCTION app.enforce_public_wms_service_transition();

ALTER TABLE app.public_wms_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.public_wms_services FORCE ROW LEVEL SECURITY;

CREATE POLICY public_wms_services_tenant_isolation
  ON app.public_wms_services
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.public_wms_services TO opengeo_runtime;
REVOKE DELETE ON app.public_wms_services FROM opengeo_runtime;
REVOKE ALL ON app.public_wms_services FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_public_wms_service_insert(),
  app.enforce_public_wms_service_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.public_wms_services IS
  'Explicit revocable project WMS read boundary; only active publications of public governed resources are discoverable, and anonymous requests cannot create render jobs.';

COMMIT;
