BEGIN;

-- Portable output is neither a dataset nor a Publication source tree.
ALTER TABLE app.project_artifacts DROP CONSTRAINT project_artifacts_representation_check;
ALTER TABLE app.project_artifacts ADD CONSTRAINT project_artifacts_representation_check
  CHECK (representation IN ('saved-map-image', 'portable-map-html'));

CREATE TABLE app.project_artifact_objects (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 3 AND 63),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  s3_version_id text NOT NULL CHECK (char_length(s3_version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (char_length(etag) BETWEEN 1 AND 512),
  content_type text NOT NULL CHECK (content_type = 'text/html'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, artifact_id, id),
  UNIQUE (bucket, object_key, s3_version_id),
  FOREIGN KEY (organization_id, artifact_id)
    REFERENCES app.project_artifacts(organization_id, id)
);
ALTER TABLE app.project_artifact_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_object_tenant ON app.project_artifact_objects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE TRIGGER artifact_objects_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_artifact_objects
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
GRANT SELECT, INSERT ON app.project_artifact_objects TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_objects FROM opengeo_worker;

ALTER TABLE app.project_artifact_versions ALTER COLUMN render_job_id DROP NOT NULL;
ALTER TABLE app.project_artifact_versions
  ADD COLUMN portable_object_id uuid,
  ADD COLUMN origin_map_id uuid,
  ADD COLUMN origin_map_version bigint,
  ADD CONSTRAINT artifact_edition_representation_binding CHECK (
    (render_job_id IS NOT NULL AND portable_object_id IS NULL
      AND origin_map_id IS NULL AND origin_map_version IS NULL)
    OR (render_job_id IS NULL AND portable_object_id IS NOT NULL
      AND origin_map_id IS NOT NULL AND origin_map_version IS NOT NULL AND origin_map_version > 0)
  ),
  ADD FOREIGN KEY (organization_id, artifact_id, portable_object_id)
    REFERENCES app.project_artifact_objects(organization_id, artifact_id, id),
  ADD FOREIGN KEY (organization_id, origin_map_id, origin_map_version)
    REFERENCES app.map_versions(organization_id, map_id, version);
CREATE UNIQUE INDEX portable_artifact_manifest_identity
  ON app.project_artifact_versions(organization_id, artifact_id, manifest_checksum_sha256)
  WHERE portable_object_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.check_project_artifact_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.portable_object_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.project_artifacts artifact
      JOIN app.project_artifact_objects output
        ON output.organization_id = artifact.organization_id
       AND output.artifact_id = artifact.id AND output.id = NEW.portable_object_id
      WHERE artifact.organization_id = NEW.organization_id AND artifact.id = NEW.artifact_id
        AND artifact.representation = 'portable-map-html'
        AND artifact.map_id = NEW.origin_map_id
        AND NEW.manifest->>'representation' = 'portable-map-html'
        AND NEW.manifest->>'canonicalization' = 'opengeo-codepoint-decimal-v1'
        AND NEW.manifest->'project' = 'null'::jsonb
        AND NEW.manifest#>>'{build,inputScope}' = 'reviewed-browser-snapshot'
        AND NEW.manifest#>>'{provenance,originatingProject,id}' = artifact.map_id::text
        AND NEW.manifest#>>'{provenance,originatingProject,version}' = NEW.origin_map_version::text
        AND NEW.manifest#>>'{provenance,authoritativeBuild}' = 'false'
        AND NEW.manifest#>>'{output,checksumSha256}' = output.checksum_sha256
        AND NEW.manifest#>>'{output,sizeBytes}' = output.size_bytes::text
        AND NEW.manifest#>>'{output,mediaType}' = output.content_type
        AND NEW.manifest->>'artifactId' = 'sha256:' || output.checksum_sha256
        AND NEW.manifest->>'manifestChecksumSha256' = NEW.manifest_checksum_sha256
    ) THEN
      RAISE EXCEPTION 'portable edition does not match retained output and saved origin';
    END IF;
    RETURN NEW;
  END IF;
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
      AND artifact.representation = 'saved-map-image'
      AND NEW.manifest->>'artifactId' = job.id::text
      AND NEW.manifest#>>'{project,id}' = artifact.map_id::text
      AND NEW.manifest->>'manifestChecksumSha256' = NEW.manifest_checksum_sha256
  ) THEN
    RAISE EXCEPTION 'artifact edition does not match completed saved-map output';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE app.project_artifact_objects IS
  'Immutable retained portable output metadata. Registration must verify exact versioned bytes and current authorization; rows alone grant no download or publication rights.';
COMMIT;
