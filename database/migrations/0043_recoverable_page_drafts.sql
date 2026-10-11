BEGIN;

CREATE TABLE app.page_working_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  base_resource_version bigint NOT NULL,
  current_revision_number bigint NOT NULL DEFAULT 0,
  current_document_checksum_sha256 text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, resource_id, owner_user_id),
  UNIQUE (
    organization_id, project_id, resource_id, id, owner_user_id, base_resource_version
  ),
  CONSTRAINT page_working_drafts_version_bounded CHECK (
    base_resource_version > 0
    AND current_revision_number BETWEEN 0 AND 512
  ),
  CONSTRAINT page_working_drafts_checksum_shape CHECK (
    (current_revision_number = 0 AND current_document_checksum_sha256 IS NULL)
    OR
    (current_revision_number > 0
      AND current_document_checksum_sha256 ~ '^[0-9a-f]{64}$')
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES app.organization_memberships (organization_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE app.page_working_draft_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  base_resource_version bigint NOT NULL,
  revision_number bigint NOT NULL,
  visibility app.governed_resource_visibility NOT NULL,
  metadata jsonb NOT NULL,
  content jsonb NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_block_id text,
  source_markdown text NOT NULL,
  change_summary text,
  document_checksum_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, draft_id, revision_number),
  CONSTRAINT page_working_draft_revisions_number_bounded CHECK (
    revision_number BETWEEN 1 AND 512 AND base_resource_version > 0
  ),
  CONSTRAINT page_working_draft_revisions_documents_bounded CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 65536
    AND jsonb_typeof(content) = 'object'
    AND octet_length(content::text) <= 16384
    AND jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 4096
  ),
  CONSTRAINT page_working_draft_revisions_source_bounded CHECK (
    (source_block_id IS NULL
      OR source_block_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
    AND octet_length(source_markdown) <= 65536
  ),
  CONSTRAINT page_working_draft_revisions_checksum_shape CHECK (
    document_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT page_working_draft_revisions_change_bounded CHECK (
    change_summary IS NULL OR char_length(change_summary) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (
    organization_id, project_id, resource_id, draft_id,
    owner_user_id, base_resource_version
  ) REFERENCES app.page_working_drafts (
    organization_id, project_id, resource_id, id,
    owner_user_id, base_resource_version
  ) ON DELETE CASCADE
);

CREATE INDEX page_working_drafts_owner_updated_idx
  ON app.page_working_drafts (
    organization_id, owner_user_id, updated_at DESC, resource_id
  );
CREATE INDEX page_working_draft_revisions_history_idx
  ON app.page_working_draft_revisions (
    organization_id, draft_id, revision_number DESC
  );

CREATE FUNCTION app.enforce_page_working_draft_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind app.governed_resource_kind;
  v_resource_version bigint;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.owner_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'page working draft must belong to the current tenant and user';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision_number <> 0
      OR NEW.current_document_checksum_sha256 IS NOT NULL
    THEN
      RAISE EXCEPTION 'page working draft must begin before its first revision';
    END IF;
    SELECT resource.kind, version.version_number INTO v_kind, v_resource_version
    FROM app.governed_resources resource
    JOIN app.governed_resource_versions version
      ON version.organization_id = resource.organization_id
     AND version.resource_id = resource.id
     AND version.id = resource.current_version_id
    WHERE resource.organization_id = NEW.organization_id
      AND resource.project_id = NEW.project_id
      AND resource.id = NEW.resource_id;
    IF NOT FOUND
      OR v_kind NOT IN ('document', 'story', 'dashboard')
      OR v_resource_version <> NEW.base_resource_version
    THEN
      RAISE EXCEPTION 'page working draft must target the current page resource version';
    END IF;
  ELSIF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.resource_id <> OLD.resource_id
    OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.base_resource_version <> OLD.base_resource_version
    OR NEW.created_at <> OLD.created_at
    OR NEW.current_revision_number <> OLD.current_revision_number + 1
    OR NOT EXISTS (
      SELECT 1
      FROM app.page_working_draft_revisions revision
      WHERE revision.organization_id = NEW.organization_id
        AND revision.draft_id = NEW.id
        AND revision.revision_number = NEW.current_revision_number
        AND revision.document_checksum_sha256 = NEW.current_document_checksum_sha256
    )
  THEN
    RAISE EXCEPTION 'page working draft head must advance to its exact next revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_page_working_draft_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_revision bigint;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.owner_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'page working draft revision must belong to the current tenant and user';
  END IF;
  SELECT current_revision_number INTO v_current_revision
  FROM app.page_working_drafts draft
  WHERE draft.organization_id = NEW.organization_id
    AND draft.project_id = NEW.project_id
    AND draft.resource_id = NEW.resource_id
    AND draft.id = NEW.draft_id
    AND draft.owner_user_id = NEW.owner_user_id
    AND draft.base_resource_version = NEW.base_resource_version
  FOR UPDATE;
  IF NOT FOUND OR NEW.revision_number <> v_current_revision + 1 THEN
    RAISE EXCEPTION 'page working draft revision must append exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_page_working_draft_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'page working draft revisions are immutable';
END;
$$;

CREATE FUNCTION app.discard_page_working_draft(
  p_organization_id uuid,
  p_project_id uuid,
  p_resource_id uuid,
  p_owner_user_id uuid,
  p_expected_base_resource_version bigint,
  p_expected_revision_number bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_revision bigint;
BEGIN
  IF p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR p_owner_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'page working draft discard scope is invalid';
  END IF;
  SELECT current_revision_number INTO v_revision
  FROM app.page_working_drafts
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND resource_id = p_resource_id
    AND owner_user_id = p_owner_user_id
    AND base_resource_version = p_expected_base_resource_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_expected_revision_number IS NOT NULL
    AND p_expected_revision_number <> v_revision
  THEN
    RAISE EXCEPTION 'page working draft revision conflict';
  END IF;
  DELETE FROM app.page_working_drafts
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND resource_id = p_resource_id
    AND owner_user_id = p_owner_user_id
    AND base_resource_version = p_expected_base_resource_version;
  RETURN true;
END;
$$;

CREATE TRIGGER page_working_drafts_enforce_head
  BEFORE INSERT OR UPDATE ON app.page_working_drafts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_page_working_draft_head();
CREATE TRIGGER page_working_drafts_set_updated_at
  BEFORE UPDATE ON app.page_working_drafts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER page_working_draft_revisions_enforce_append
  BEFORE INSERT ON app.page_working_draft_revisions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_page_working_draft_revision();
CREATE TRIGGER page_working_draft_revisions_are_immutable
  BEFORE UPDATE ON app.page_working_draft_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_page_working_draft_revision_update();

ALTER TABLE app.page_working_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_working_draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_working_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.page_working_draft_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY page_working_drafts_private_owner
  ON app.page_working_drafts
  USING (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );
CREATE POLICY page_working_draft_revisions_private_owner
  ON app.page_working_draft_revisions
  USING (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND owner_user_id = app.current_user_id()
  );

GRANT SELECT, INSERT, UPDATE ON app.page_working_drafts TO opengeo_runtime;
GRANT SELECT, INSERT ON app.page_working_draft_revisions TO opengeo_runtime;
REVOKE DELETE ON app.page_working_drafts, app.page_working_draft_revisions
FROM opengeo_runtime;
REVOKE ALL ON app.page_working_drafts, app.page_working_draft_revisions
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_page_working_draft_head(),
  app.enforce_page_working_draft_revision(),
  app.reject_page_working_draft_revision_update()
FROM PUBLIC, opengeo_runtime, opengeo_worker;
REVOKE EXECUTE ON FUNCTION app.discard_page_working_draft(uuid, uuid, uuid, uuid, bigint, bigint)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.discard_page_working_draft(uuid, uuid, uuid, uuid, bigint, bigint)
TO opengeo_runtime;

COMMENT ON TABLE app.page_working_drafts IS
  'Private per-author recovery heads for uncommitted governed page edits.';
COMMENT ON TABLE app.page_working_draft_revisions IS
  'Bounded immutable full-document recovery revisions; never a public publication source.';
COMMENT ON FUNCTION app.discard_page_working_draft(uuid, uuid, uuid, uuid, bigint, bigint) IS
  'Deletes only the current user draft after an explicit CAS discard or matching page checkpoint.';

COMMIT;
