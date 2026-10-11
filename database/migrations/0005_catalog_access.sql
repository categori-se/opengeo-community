BEGIN;

CREATE TYPE app.dataset_permission_role AS ENUM (
  'manage',
  'edit',
  'view',
  'download'
);

CREATE TABLE app.dataset_permissions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role app.dataset_permission_role NOT NULL,
  granted_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, user_id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES app.organization_memberships (organization_id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX dataset_permissions_user_idx
  ON app.dataset_permissions (organization_id, user_id, dataset_id, role);

CREATE TABLE app.dataset_version_objects (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  data_object_id uuid NOT NULL,
  PRIMARY KEY (organization_id, dataset_version_id, data_object_id),
  UNIQUE (organization_id, data_object_id),
  FOREIGN KEY (organization_id, dataset_id, dataset_version_id)
    REFERENCES app.dataset_versions (organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, data_object_id)
    REFERENCES app.data_objects (organization_id, id)
);

CREATE INDEX dataset_version_objects_history_idx
  ON app.dataset_version_objects (
    organization_id,
    dataset_id,
    dataset_version_id,
    data_object_id
  );

ALTER TABLE app.datasets
  ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' || coalesce(description, '')
    )
  ) STORED;

CREATE INDEX datasets_search_idx ON app.datasets USING gin (search_document);
CREATE INDEX datasets_catalog_filter_idx
  ON app.datasets (
    organization_id,
    classification,
    source_type,
    format,
    owner_user_id,
    updated_at DESC,
    id
  );

CREATE FUNCTION app.link_dataset_version_original()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  INSERT INTO app.dataset_version_objects
    (organization_id, dataset_id, dataset_version_id, data_object_id)
  VALUES
    (NEW.organization_id, NEW.dataset_id, NEW.id, NEW.original_object_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_versions_link_original
  AFTER INSERT ON app.dataset_versions
  FOR EACH ROW EXECUTE FUNCTION app.link_dataset_version_original();

CREATE FUNCTION app.link_completed_dataset_artifacts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_expected integer;
  v_linked integer;
BEGIN
  IF NEW.state <> 'completed' OR OLD.state = 'completed' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.result->'artifacts') <> 'array' THEN
    RAISE EXCEPTION 'completed ingestion job has no artifact array';
  END IF;

  v_expected := jsonb_array_length(NEW.result->'artifacts');
  INSERT INTO app.dataset_version_objects
    (organization_id, dataset_id, dataset_version_id, data_object_id)
  SELECT
    NEW.organization_id,
    NEW.dataset_id,
    NEW.dataset_version_id,
    object.id
  FROM jsonb_array_elements(NEW.result->'artifacts') artifact
  JOIN app.data_objects object
    ON object.organization_id = NEW.organization_id
   AND object.dataset_id = NEW.dataset_id
   AND object.id = (artifact->>'id')::uuid
   AND object.role <> 'original';

  SELECT count(*)::integer INTO v_linked
  FROM app.dataset_version_objects link
  JOIN app.data_objects object
    ON object.organization_id = link.organization_id
   AND object.id = link.data_object_id
  WHERE link.organization_id = NEW.organization_id
    AND link.dataset_id = NEW.dataset_id
    AND link.dataset_version_id = NEW.dataset_version_id
    AND object.role <> 'original';

  IF v_linked <> v_expected THEN
    RAISE EXCEPTION 'completed ingestion artifacts do not match stored objects';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER processing_jobs_link_completed_artifacts
  AFTER UPDATE OF state, result ON app.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION app.link_completed_dataset_artifacts();

INSERT INTO app.dataset_version_objects
  (organization_id, dataset_id, dataset_version_id, data_object_id)
SELECT organization_id, dataset_id, id, original_object_id
FROM app.dataset_versions;

INSERT INTO app.dataset_version_objects
  (organization_id, dataset_id, dataset_version_id, data_object_id)
SELECT
  job.organization_id,
  job.dataset_id,
  job.dataset_version_id,
  object.id
FROM app.processing_jobs job
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(job.result->'artifacts') = 'array'
      THEN job.result->'artifacts'
    ELSE '[]'::jsonb
  END
) artifact
JOIN app.data_objects object
  ON object.organization_id = job.organization_id
 AND object.dataset_id = job.dataset_id
 AND object.id = (artifact->>'id')::uuid
ON CONFLICT DO NOTHING;

CREATE TRIGGER dataset_permissions_set_updated_at
  BEFORE UPDATE ON app.dataset_permissions
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.dataset_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_version_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY dataset_permissions_tenant_isolation ON app.dataset_permissions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY dataset_version_objects_tenant_isolation ON app.dataset_version_objects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

REVOKE EXECUTE ON FUNCTION
  app.link_dataset_version_original(),
  app.link_completed_dataset_artifacts()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.dataset_permissions TO opengeo_runtime;
GRANT SELECT ON app.dataset_version_objects TO opengeo_runtime;

COMMENT ON TABLE app.dataset_permissions IS
  'Explicit per-user dataset grants. Project roles and ownership remain separately evaluated baselines.';
COMMENT ON TABLE app.dataset_version_objects IS
  'Authoritative association between one logical dataset revision and immutable original or derivative objects.';
COMMENT ON COLUMN app.datasets.search_document IS
  'PostgreSQL simple-dictionary search over catalog name and description; tags are matched through tenant-scoped relations.';

COMMIT;
