BEGIN;
-- Versioned authoring intent, separate from immutable source files and build pins.
CREATE TABLE app.publication_artifact_reference_sets (
  organization_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  references_json jsonb NOT NULL CHECK (
    jsonb_typeof(references_json) = 'array'
    AND jsonb_array_length(references_json) <= 32
    AND octet_length(references_json::text) <= 32768
  ),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, source_project_id, revision),
  FOREIGN KEY (organization_id, source_project_id)
    REFERENCES app.observable_source_projects(organization_id, id)
);
ALTER TABLE app.publication_artifact_reference_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.publication_artifact_reference_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_artifact_reference_tenant ON app.publication_artifact_reference_sets
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.publication_artifact_reference_sets TO opengeo_runtime;
REVOKE ALL ON app.publication_artifact_reference_sets FROM opengeo_worker;

-- Fail closed until staging/compiler support consumes exact resolved Artifact pins.
-- Share the source row lock with authoring so a build cannot skip a concurrent edit.
CREATE FUNCTION app.require_publication_artifact_staging() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE v_refs jsonb;
BEGIN
  PERFORM 1 FROM app.observable_source_projects
    WHERE organization_id = NEW.organization_id AND id = NEW.source_project_id FOR SHARE;
  SELECT references_json INTO v_refs FROM app.publication_artifact_reference_sets
    WHERE organization_id = NEW.organization_id AND source_project_id = NEW.source_project_id
    ORDER BY revision DESC LIMIT 1;
  IF jsonb_array_length(v_refs) > 0 THEN
    RAISE EXCEPTION 'publication_artifact_staging_unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER observable_build_artifact_staging
  BEFORE INSERT ON app.observable_build_jobs
  FOR EACH ROW EXECUTE FUNCTION app.require_publication_artifact_staging();
COMMIT;
