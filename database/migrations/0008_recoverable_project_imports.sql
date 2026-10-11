BEGIN;

CREATE TYPE app.project_import_state AS ENUM ('open', 'completed');
CREATE TYPE app.project_import_item_kind AS ENUM ('external_source', 'embedded_dataset');
CREATE TYPE app.project_import_item_state AS ENUM ('pending', 'bound');

CREATE TABLE app.project_import_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  map_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  source_product text NOT NULL,
  source_version text NOT NULL,
  source_sha256 text NOT NULL,
  plan_digest text NOT NULL,
  expected_map_version bigint NOT NULL,
  map_definition jsonb NOT NULL,
  conversion_report jsonb NOT NULL,
  state app.project_import_state NOT NULL DEFAULT 'open',
  created_by uuid NOT NULL REFERENCES app.users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, idempotency_key),
  CONSTRAINT project_import_source_product_supported CHECK (source_product = 'geolibre'),
  CONSTRAINT project_import_source_version_bounded CHECK (
    char_length(source_version) BETWEEN 1 AND 40
  ),
  CONSTRAINT project_import_hashes_hex CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$' AND plan_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT project_import_map_version_positive CHECK (expected_map_version > 0),
  CONSTRAINT project_import_definition_bounded CHECK (
    jsonb_typeof(map_definition) = 'object'
    AND octet_length(map_definition::text) <= 524288
  ),
  CONSTRAINT project_import_report_bounded CHECK (
    jsonb_typeof(conversion_report) = 'object'
    AND octet_length(conversion_report::text) <= 131072
  ),
  CONSTRAINT project_import_state_shape CHECK (
    (state = 'open' AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, map_id)
    REFERENCES app.maps (organization_id, id)
);

CREATE TABLE app.project_import_items (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  import_id uuid NOT NULL,
  import_ref text NOT NULL,
  kind app.project_import_item_kind NOT NULL,
  expected_source_type app.dataset_source_type NOT NULL,
  expected_format app.dataset_format NOT NULL,
  candidate jsonb NOT NULL,
  state app.project_import_item_state NOT NULL DEFAULT 'pending',
  dataset_id uuid,
  bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, import_id, import_ref),
  CONSTRAINT project_import_item_ref_bounded CHECK (
    import_ref ~ '^geolibre:[A-Za-z0-9._:-]{1,200}$'
  ),
  CONSTRAINT project_import_item_candidate_bounded CHECK (
    jsonb_typeof(candidate) = 'object'
    AND octet_length(candidate::text) <= 32768
  ),
  CONSTRAINT project_import_item_kind_shape CHECK (
    (kind = 'external_source'
      AND expected_source_type IN ('xyz', 'wms', 'pmtiles')
      AND expected_source_type::text = expected_format::text)
    OR (kind = 'embedded_dataset'
      AND expected_source_type = 'upload'
      AND expected_format NOT IN ('xyz', 'wms'))
  ),
  CONSTRAINT project_import_item_state_shape CHECK (
    (state = 'pending' AND dataset_id IS NULL AND bound_at IS NULL)
    OR (state = 'bound' AND dataset_id IS NOT NULL AND bound_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, import_id)
    REFERENCES app.project_import_operations (organization_id, id),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

CREATE INDEX project_import_operations_open_idx
  ON app.project_import_operations (organization_id, project_id, state, updated_at DESC);
CREATE INDEX project_import_items_dataset_idx
  ON app.project_import_items (organization_id, dataset_id)
  WHERE dataset_id IS NOT NULL;

CREATE FUNCTION app.enforce_project_import_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.map_id <> OLD.map_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.source_product <> OLD.source_product
    OR NEW.source_version <> OLD.source_version
    OR NEW.source_sha256 <> OLD.source_sha256
    OR NEW.plan_digest <> OLD.plan_digest
    OR NEW.expected_map_version <> OLD.expected_map_version
    OR NEW.map_definition <> OLD.map_definition
    OR NEW.conversion_report <> OLD.conversion_report
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'project import identity and plan are immutable';
  END IF;
  IF OLD.state = 'completed' OR NEW.state < OLD.state THEN
    RAISE EXCEPTION 'project import transitions are forward-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_import_item_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id
    OR NEW.import_id <> OLD.import_id
    OR NEW.import_ref <> OLD.import_ref
    OR NEW.kind <> OLD.kind
    OR NEW.expected_source_type <> OLD.expected_source_type
    OR NEW.expected_format <> OLD.expected_format
    OR NEW.candidate <> OLD.candidate
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'project import item plan is immutable';
  END IF;
  IF OLD.state = 'bound'
    OR NEW.state <> 'bound'
    OR OLD.dataset_id IS NOT NULL
    OR NEW.dataset_id IS NULL
  THEN
    RAISE EXCEPTION 'project import item binding is single-assignment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_import_operations_enforce_transition
  BEFORE UPDATE ON app.project_import_operations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_import_transition();
CREATE TRIGGER project_import_items_enforce_transition
  BEFORE UPDATE ON app.project_import_items
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_import_item_transition();
CREATE TRIGGER project_import_operations_set_updated_at
  BEFORE UPDATE ON app.project_import_operations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.project_import_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_import_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_import_items FORCE ROW LEVEL SECURITY;

CREATE POLICY project_import_operations_tenant_isolation ON app.project_import_operations
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_import_items_tenant_isolation ON app.project_import_items
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON
  app.project_import_operations,
  app.project_import_items
TO opengeo_runtime;

REVOKE DELETE ON
  app.project_import_operations,
  app.project_import_items
FROM opengeo_runtime;

REVOKE ALL ON
  app.project_import_operations,
  app.project_import_items
FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_project_import_transition(),
  app.enforce_project_import_item_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.project_import_operations IS
  'Idempotent, tenant-scoped import plans whose final map rewrite is atomic and recoverable.';
COMMENT ON TABLE app.project_import_items IS
  'Single-assignment mapping from portable-project references to real governed dataset identities.';

COMMIT;
