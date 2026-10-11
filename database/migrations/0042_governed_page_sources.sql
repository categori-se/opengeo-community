BEGIN;

CREATE TYPE app.page_source_upload_state AS ENUM ('pending', 'completed');

CREATE TABLE app.page_source_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  expected_resource_version bigint NOT NULL,
  source_block_id text NOT NULL,
  expected_size_bytes bigint NOT NULL,
  expected_sha256 text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  state app.page_source_upload_state NOT NULL DEFAULT 'pending',
  completed_source_object_id uuid,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, resource_id, object_key),
  CONSTRAINT page_source_upload_intents_version_positive CHECK (
    expected_resource_version > 0
  ),
  CONSTRAINT page_source_upload_intents_block_bounded CHECK (
    source_block_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  CONSTRAINT page_source_upload_intents_object_bounded CHECK (
    expected_size_bytes BETWEEN 1 AND 65536
    AND expected_sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(bucket) BETWEEN 3 AND 63
    AND char_length(object_key) BETWEEN 1 AND 1024
  ),
  CONSTRAINT page_source_upload_intents_expiry_bounded CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'
  ),
  CONSTRAINT page_source_upload_intents_completion_shape CHECK (
    (state = 'pending' AND completed_source_object_id IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND completed_source_object_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE TABLE app.page_source_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  upload_intent_id uuid NOT NULL,
  source_block_id text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  s3_version_id text NOT NULL,
  etag text NOT NULL,
  content_type text NOT NULL DEFAULT 'text/markdown',
  size_bytes bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  dialect text NOT NULL DEFAULT 'opengeo-markdown',
  dialect_version text NOT NULL DEFAULT '1.0.0',
  compiler_version text NOT NULL DEFAULT 'opengeo-page-renderer-1.0.0',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, resource_id, id),
  UNIQUE (organization_id, resource_id, resource_version_id),
  UNIQUE (organization_id, upload_intent_id),
  UNIQUE (bucket, object_key, s3_version_id),
  CONSTRAINT page_source_objects_block_bounded CHECK (
    source_block_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  CONSTRAINT page_source_objects_exact_facts CHECK (
    char_length(bucket) BETWEEN 3 AND 63
    AND char_length(object_key) BETWEEN 1 AND 1024
    AND char_length(s3_version_id) BETWEEN 1 AND 1024
    AND char_length(etag) BETWEEN 1 AND 512
    AND content_type = 'text/markdown'
    AND size_bytes BETWEEN 1 AND 65536
    AND checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT page_source_objects_compiler_identity CHECK (
    dialect = 'opengeo-markdown'
    AND dialect_version = '1.0.0'
    AND compiler_version = 'opengeo-page-renderer-1.0.0'
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, upload_intent_id)
    REFERENCES app.page_source_upload_intents (organization_id, id)
);

ALTER TABLE app.page_source_upload_intents
  ADD CONSTRAINT page_source_upload_intents_completed_object_fk
  FOREIGN KEY (organization_id, resource_id, completed_source_object_id)
  REFERENCES app.page_source_objects (organization_id, resource_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX page_source_upload_intents_lookup_idx
  ON app.page_source_upload_intents (
    organization_id, project_id, resource_id, state, expires_at DESC
  );
CREATE INDEX page_source_objects_history_idx
  ON app.page_source_objects (
    organization_id, project_id, resource_id, created_at DESC, id
  );

CREATE FUNCTION app.enforce_page_source_upload_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'pending'
    OR NEW.state <> 'completed'
    OR NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.expected_resource_version <> OLD.expected_resource_version
    OR NEW.source_block_id <> OLD.source_block_id
    OR NEW.expected_size_bytes <> OLD.expected_size_bytes
    OR NEW.expected_sha256 <> OLD.expected_sha256
    OR NEW.bucket <> OLD.bucket
    OR NEW.object_key <> OLD.object_key
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.completed_source_object_id IS NULL
    OR NEW.completed_at IS NULL
  THEN
    RAISE EXCEPTION 'page source upload identity and completion are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_page_source_object_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_intent app.page_source_upload_intents%ROWTYPE;
  v_kind app.governed_resource_kind;
  v_version bigint;
BEGIN
  SELECT * INTO v_intent
  FROM app.page_source_upload_intents
  WHERE organization_id = NEW.organization_id AND id = NEW.upload_intent_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_intent.state <> 'pending'
    OR v_intent.expires_at <= clock_timestamp()
    OR v_intent.project_id <> NEW.project_id
    OR v_intent.resource_id <> NEW.resource_id
    OR v_intent.source_block_id <> NEW.source_block_id
    OR v_intent.bucket <> NEW.bucket
    OR v_intent.object_key <> NEW.object_key
    OR v_intent.expected_size_bytes <> NEW.size_bytes
    OR v_intent.expected_sha256 <> NEW.checksum_sha256
    OR v_intent.created_by <> NEW.created_by
  THEN
    RAISE EXCEPTION 'page source object does not match its active upload intent';
  END IF;

  SELECT resource.kind, version.version_number INTO v_kind, v_version
  FROM app.governed_resources resource
  JOIN app.governed_resource_versions version
    ON version.organization_id = resource.organization_id
   AND version.resource_id = resource.id
   AND version.id = NEW.resource_version_id
  WHERE resource.organization_id = NEW.organization_id
    AND resource.project_id = NEW.project_id
    AND resource.id = NEW.resource_id;
  IF NOT FOUND
    OR v_kind NOT IN ('document', 'story', 'dashboard')
    OR v_version <> v_intent.expected_resource_version + 1
  THEN
    RAISE EXCEPTION 'page source object must bind the intended page resource version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_source_upload_intents_enforce_transition
  BEFORE UPDATE ON app.page_source_upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_page_source_upload_transition();
CREATE TRIGGER page_source_objects_enforce_binding
  BEFORE INSERT ON app.page_source_objects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_page_source_object_binding();
CREATE TRIGGER page_source_objects_are_immutable
  BEFORE UPDATE OR DELETE ON app.page_source_objects
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

CREATE FUNCTION app.enforce_page_renderer_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_page jsonb;
  v_source app.page_source_objects%ROWTYPE;
  v_expected jsonb;
BEGIN
  IF NEW.manifest->>'rendererVersion' IS DISTINCT FROM 'opengeo-page-renderer-1.0.0' THEN
    RAISE EXCEPTION 'site edition renderer identity is missing or unsupported';
  END IF;

  FOR v_page IN
    SELECT value FROM jsonb_array_elements(COALESCE(NEW.manifest->'pages', '[]'::jsonb))
  LOOP
    SELECT * INTO v_source
    FROM app.page_source_objects source
    WHERE source.organization_id = NEW.organization_id
      AND source.resource_id = (v_page->>'resourceId')::uuid
      AND source.resource_version_id = (v_page->>'resourceVersionId')::uuid;
    IF FOUND THEN
      v_expected := jsonb_build_object(
        'sourceId', v_source.id,
        'sourceBlockId', v_source.source_block_id,
        's3VersionId', v_source.s3_version_id,
        'etag', v_source.etag,
        'contentType', v_source.content_type,
        'sizeBytes', v_source.size_bytes,
        'checksumSha256', v_source.checksum_sha256,
        'dialect', v_source.dialect,
        'dialectVersion', v_source.dialect_version,
        'compilerVersion', v_source.compiler_version
      );
      IF v_page->'pageSource' IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'site edition page source seal is missing or mismatched';
      END IF;
    ELSIF COALESCE(v_page->'pageSource', 'null'::jsonb) <> 'null'::jsonb THEN
      RAISE EXCEPTION 'site edition page source seal has no governed source';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('app.project_site_editions') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER project_site_editions_require_page_renderer
      BEFORE INSERT ON app.project_site_editions
      FOR EACH ROW EXECUTE FUNCTION app.enforce_page_renderer_identity()';
  END IF;
END;
$$;

ALTER TABLE app.page_source_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_source_upload_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.page_source_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY page_source_upload_intents_tenant_isolation
  ON app.page_source_upload_intents
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY page_source_objects_tenant_isolation
  ON app.page_source_objects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.page_source_upload_intents TO opengeo_runtime;
GRANT SELECT, INSERT ON app.page_source_objects TO opengeo_runtime;
REVOKE DELETE ON app.page_source_upload_intents, app.page_source_objects FROM opengeo_runtime;
REVOKE ALL ON app.page_source_upload_intents, app.page_source_objects FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_page_source_upload_transition(),
  app.enforce_page_source_object_binding(),
  app.enforce_page_renderer_identity()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.page_source_upload_intents IS
  'Short-lived authorized requests for exact UTF-8 Markdown page-source objects.';
COMMENT ON TABLE app.page_source_objects IS
  'Immutable exact S3 object facts and pinned authoring/compiler identity for governed page versions.';

COMMIT;
