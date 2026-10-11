BEGIN;

-- A source project's attachment library is not a source revision or a build
-- manifest. Consumers must explicitly bind these exact pins in a later revision.
CREATE TABLE app.observable_data_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  data_object_id uuid NOT NULL,
  s3_version_id text NOT NULL CHECK (s3_version_id NOT IN ('', 'null')),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, source_project_id, id),
  UNIQUE (organization_id, source_project_id, dataset_version_id, data_object_id),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, dataset_version_id, data_object_id)
    REFERENCES app.dataset_version_objects (organization_id, dataset_version_id, data_object_id),
  FOREIGN KEY (organization_id, data_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

CREATE FUNCTION app.enforce_observable_data_attachment()
RETURNS trigger LANGUAGE plpgsql
AS $$
DECLARE
  v_object app.data_objects%ROWTYPE;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'attachment requires its tenant actor' USING ERRCODE = '23514';
  END IF;

  -- Serialize the bounded registry without starting processing or copying data.
  PERFORM 1 FROM app.observable_source_projects source
  JOIN app.projects project
    ON project.organization_id = source.organization_id AND project.id = source.project_id
  JOIN app.organization_memberships member
    ON member.organization_id = project.organization_id AND member.user_id = NEW.created_by
  WHERE source.organization_id = NEW.organization_id AND source.project_id = NEW.project_id
    AND source.id = NEW.source_project_id AND project.status = 'active'
    AND (member.role = 'admin' OR app.effective_project_role(project.id, NEW.created_by)::text IN ('owner', 'editor'))
  FOR UPDATE OF source;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment requires source-project manage access' USING ERRCODE = '23514';
  END IF;

  IF (SELECT count(*) FROM app.observable_data_attachments
      WHERE organization_id = NEW.organization_id AND source_project_id = NEW.source_project_id) >= 128
    AND NOT EXISTS (SELECT 1 FROM app.observable_data_attachments
      WHERE organization_id = NEW.organization_id AND source_project_id = NEW.source_project_id
        AND dataset_version_id = NEW.dataset_version_id AND data_object_id = NEW.data_object_id)
  THEN
    RAISE EXCEPTION 'source project attachment limit reached' USING ERRCODE = '23514';
  END IF;

  SELECT object.* INTO v_object
  FROM app.project_datasets linked
  JOIN app.datasets dataset
    ON dataset.organization_id = linked.organization_id AND dataset.id = linked.dataset_id
  JOIN app.dataset_versions version
    ON version.organization_id = dataset.organization_id AND version.dataset_id = dataset.id
   AND version.id = NEW.dataset_version_id
  JOIN app.dataset_version_objects file
    ON file.organization_id = version.organization_id AND file.dataset_id = version.dataset_id
   AND file.dataset_version_id = version.id AND file.data_object_id = NEW.data_object_id
  JOIN app.data_objects object
    ON object.organization_id = file.organization_id AND object.dataset_id = file.dataset_id
   AND object.id = file.data_object_id
  WHERE linked.organization_id = NEW.organization_id AND linked.project_id = NEW.project_id
    AND linked.dataset_id = NEW.dataset_id AND dataset.status = 'active' AND version.state = 'active'
    AND object.s3_version_id NOT IN ('', 'null');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment requires an active exact project dataset object' USING ERRCODE = '23514';
  END IF;

  -- Immutable file facts come from the archive, never a browser's assertions.
  NEW.s3_version_id := v_object.s3_version_id;
  NEW.checksum_sha256 := v_object.checksum_sha256;
  NEW.size_bytes := v_object.size_bytes;
  NEW.content_type := v_object.content_type;
  RETURN NEW;
END;
$$;

CREATE TRIGGER observable_data_attachments_validate
  BEFORE INSERT ON app.observable_data_attachments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_data_attachment();
CREATE TRIGGER observable_data_attachments_immutable
  BEFORE UPDATE OR DELETE ON app.observable_data_attachments
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.observable_data_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_data_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_data_attachments_tenant_isolation
  ON app.observable_data_attachments
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
GRANT SELECT, INSERT ON app.observable_data_attachments TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.observable_data_attachments FROM opengeo_runtime;

COMMENT ON TABLE app.observable_data_attachments IS
  'Exact archived dataset objects available to a source project; registration neither copies bytes nor binds a source revision, grants data access, stages a build, or publishes content.';

COMMIT;
