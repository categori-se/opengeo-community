BEGIN;

-- Stable output identity is separate from the authored map and each render job.
CREATE TABLE app.project_artifacts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  map_id uuid NOT NULL,
  representation text NOT NULL CHECK (representation = 'saved-map-image'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_version_number integer,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users(id),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, resource_id, representation),
  FOREIGN KEY (organization_id, resource_id)
    REFERENCES app.governed_resources(organization_id, id),
  FOREIGN KEY (organization_id, map_id) REFERENCES app.maps(organization_id, id)
);
CREATE TABLE app.project_artifact_versions (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  render_job_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (
    jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 49152
    AND manifest->>'schemaVersion' = 'opengeo.project-artifact.1.0.0'
  ),
  manifest_checksum_sha256 text NOT NULL CHECK (manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, artifact_id, version_number),
  UNIQUE (organization_id, artifact_id, render_job_id),
  FOREIGN KEY (organization_id, artifact_id)
    REFERENCES app.project_artifacts(organization_id, id),
  FOREIGN KEY (organization_id, render_job_id)
    REFERENCES app.map_render_job_bindings(organization_id, render_job_id)
);
ALTER TABLE app.project_artifacts ADD CONSTRAINT artifact_current_version_fk
  FOREIGN KEY (organization_id, id, current_version_number)
  REFERENCES app.project_artifact_versions(organization_id, artifact_id, version_number);

CREATE FUNCTION app.check_project_artifact_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.project_artifacts artifact
    JOIN app.map_render_job_bindings binding
      ON binding.organization_id = artifact.organization_id
     AND binding.resource_id = artifact.resource_id
     AND binding.render_job_id = NEW.render_job_id
    JOIN app.map_resource_version_bindings revision
      ON revision.organization_id = binding.organization_id
     AND revision.resource_id = binding.resource_id
     AND revision.resource_version_id = binding.resource_version_id
     AND revision.map_id = artifact.map_id
    JOIN app.map_render_jobs job
      ON job.organization_id = binding.organization_id AND job.id = binding.render_job_id
     AND job.state = 'completed' AND job.composition_sealed
     AND job.output_object_id IS NOT NULL
    WHERE artifact.organization_id = NEW.organization_id AND artifact.id = NEW.artifact_id
      AND NEW.manifest->>'artifactId' = job.id::text
      AND NEW.manifest#>>'{project,id}' = artifact.map_id::text
      AND NEW.manifest->>'manifestChecksumSha256' = NEW.manifest_checksum_sha256
  ) THEN
    RAISE EXCEPTION 'artifact edition does not match completed saved-map output';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_artifact_version_binding BEFORE INSERT ON app.project_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION app.check_project_artifact_version();
CREATE TRIGGER project_artifact_history_is_immutable
  BEFORE UPDATE OR DELETE ON app.project_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.project_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_tenant ON app.project_artifacts
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY artifact_version_tenant ON app.project_artifact_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.project_artifacts, app.project_artifact_versions TO opengeo_runtime;
GRANT UPDATE (revision, current_version_number, updated_at, updated_by) ON app.project_artifacts TO opengeo_runtime;
REVOKE ALL ON app.project_artifacts, app.project_artifact_versions FROM opengeo_worker;
COMMENT ON TABLE app.project_artifacts IS
  'Stable compiled-output identity. Registering an immutable edition does not advance current or grant publication rights.';
COMMIT;
