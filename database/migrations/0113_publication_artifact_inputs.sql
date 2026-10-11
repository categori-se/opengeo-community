BEGIN;
-- Resolved input snapshots are immutable and distinct from jobs and authoring intent.
CREATE TABLE app.publication_artifact_inputs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_project_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  reference_revision integer NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 65536),
  manifest_checksum_sha256 text NOT NULL CHECK (manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,source_project_id,manifest_checksum_sha256),
  FOREIGN KEY (organization_id,source_project_id,source_revision_id)
    REFERENCES app.observable_source_revisions(organization_id,source_project_id,id),
  FOREIGN KEY (organization_id,source_project_id,reference_revision)
    REFERENCES app.publication_artifact_reference_sets(organization_id,source_project_id,revision)
);
ALTER TABLE app.publication_artifact_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.publication_artifact_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_artifact_inputs_tenant ON app.publication_artifact_inputs
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.publication_artifact_inputs TO opengeo_runtime;
REVOKE ALL ON app.publication_artifact_inputs FROM opengeo_worker;

CREATE FUNCTION app.validate_publication_artifact_inputs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,public AS $$
DECLARE
  v_source_checksum text;
  v_refs jsonb;
  v_pin jsonb;
  v_ref jsonb;
  v_manifest jsonb;
  v_output uuid;
  v_checksum text;
BEGIN
  SELECT manifest_checksum_sha256 INTO v_source_checksum FROM app.observable_source_revisions
    WHERE organization_id=NEW.organization_id AND source_project_id=NEW.source_project_id
      AND id=NEW.source_revision_id;
  SELECT references_json INTO v_refs FROM app.publication_artifact_reference_sets
    WHERE organization_id=NEW.organization_id AND source_project_id=NEW.source_project_id
      AND revision=NEW.reference_revision;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NEW.manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.publication-artifact-inputs.1.0.0'
    OR NEW.manifest->>'sourceProjectId' IS DISTINCT FROM NEW.source_project_id::text
    OR NEW.manifest->>'sourceRevisionId' IS DISTINCT FROM NEW.source_revision_id::text
    OR NEW.manifest->>'sourceManifestChecksumSha256' IS DISTINCT FROM v_source_checksum
    OR NEW.manifest->>'referenceRevision' IS DISTINCT FROM NEW.reference_revision::text
    OR jsonb_typeof(NEW.manifest->'artifacts') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.manifest->'artifacts') IS DISTINCT FROM jsonb_array_length(v_refs)
    OR jsonb_array_length(v_refs) NOT BETWEEN 1 AND 32
  THEN
    RAISE EXCEPTION 'publication Artifact inputs do not match source and references';
  END IF;
  FOR v_pin, v_ref IN
    SELECT pin.value, ref.value FROM jsonb_array_elements(NEW.manifest->'artifacts')
      WITH ORDINALITY pin(value,n)
    JOIN jsonb_array_elements(v_refs) WITH ORDINALITY ref(value,n) USING (n)
  LOOP
    SELECT manifest,portable_object_id,manifest_checksum_sha256
      INTO v_manifest,v_output,v_checksum FROM app.project_artifact_versions
      WHERE organization_id=NEW.organization_id AND artifact_id=(v_ref->>'artifact_id')::uuid
        AND version_number=(v_pin->>'version')::integer;
    IF v_manifest IS NULL OR v_output IS NULL
      OR v_pin->>'path' IS DISTINCT FROM v_ref->>'path'
      OR v_pin->>'artifactId' IS DISTINCT FROM v_ref->>'artifact_id'
      OR v_pin->>'outputObjectId' IS DISTINCT FROM v_output::text
      OR v_pin->>'manifestChecksumSha256' IS DISTINCT FROM v_checksum
      OR v_pin->'output' IS DISTINCT FROM v_manifest->'output'
      OR (v_ref->>'mode'='pinned' AND v_pin->'version' IS DISTINCT FROM v_ref->'version')
    THEN
      RAISE EXCEPTION 'publication Artifact pin does not match retained edition';
    END IF;
  END LOOP;
  NEW.manifest_checksum_sha256 := encode(digest(convert_to(NEW.manifest::text,'UTF8'),'sha256'),'hex');
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_artifact_inputs_validate BEFORE INSERT
  ON app.publication_artifact_inputs FOR EACH ROW
  EXECUTE FUNCTION app.validate_publication_artifact_inputs();
COMMIT;
