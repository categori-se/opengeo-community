BEGIN;

-- The revision transaction records export intent. A saved revision is never
-- misreported as lost when SQS or GitHub is temporarily unavailable.
CREATE TABLE app.observable_github_syncs (
  source_revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  stage text NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending', 'syncing', 'synced', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, source_project_id, source_revision_id)
    REFERENCES app.observable_source_revisions(organization_id, project_id, source_project_id, id),
  FOREIGN KEY (organization_id, project_id, source_project_id, connection_id)
    REFERENCES app.observable_github_links(organization_id, project_id, source_project_id, connection_id)
);
ALTER TABLE app.observable_github_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_github_syncs_tenant ON app.observable_github_syncs
  USING (organization_id = app.current_organization_id());
GRANT SELECT ON app.observable_github_syncs TO opengeo_runtime;
REVOKE ALL ON app.observable_github_syncs FROM PUBLIC, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

CREATE FUNCTION app.request_github_source_sync(p_revision uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE r app.observable_source_revisions%ROWTYPE; c uuid;
BEGIN
  SELECT * INTO r FROM app.observable_source_revisions WHERE id = p_revision
    AND organization_id = app.current_organization_id();
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM app.projects p JOIN app.organizations o ON o.id = p.organization_id AND o.status = 'active'
    JOIN app.organization_memberships m ON m.organization_id = p.organization_id AND m.user_id = app.current_user_id()
    WHERE p.id = r.project_id AND p.status = 'active'
      AND (m.role = 'admin' OR app.effective_project_role(p.id, m.user_id)::text IN ('owner', 'editor'))
  ) THEN RAISE EXCEPTION 'Source sync requires project management' USING ERRCODE = '42501'; END IF;
  SELECT connection.id INTO c FROM app.observable_github_links link
    JOIN app.github_publication_connections connection ON connection.id = link.connection_id AND connection.enabled
    WHERE link.organization_id = r.organization_id AND link.source_project_id = r.source_project_id;
  IF c IS NULL THEN RETURN false; END IF;
  INSERT INTO app.observable_github_syncs(source_revision_id, organization_id, project_id, source_project_id, connection_id, requested_by)
    VALUES(r.id, r.organization_id, r.project_id, r.source_project_id, c, app.current_user_id())
    ON CONFLICT (source_revision_id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM app.observable_github_revision_receipts WHERE source_revision_id = r.id AND connection_id = c) THEN
    UPDATE app.observable_github_syncs SET stage = 'synced', error_code = NULL, updated_at = clock_timestamp()
      WHERE source_revision_id = r.id;
    RETURN false;
  END IF;
  -- An explicit authorized retry may assume responsibility after an expired
  -- attempt. It cannot change the connection, revision or a live worker's actor.
  UPDATE app.observable_github_syncs SET requested_by = app.current_user_id(), stage = 'pending',
    error_code = NULL, updated_at = clock_timestamp()
    WHERE source_revision_id = r.id AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp());
  RETURN true;
END;
$$;

CREATE FUNCTION app.stage_saved_github_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE revision_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'observable_source_revisions' THEN
    revision_id := NEW.id;
  ELSE
    SELECT current_revision_id INTO revision_id FROM app.observable_source_projects
      WHERE id = NEW.source_project_id AND organization_id = NEW.organization_id;
  END IF;
  IF revision_id IS NOT NULL THEN PERFORM app.request_github_source_sync(revision_id); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER observable_revision_github_outbox AFTER INSERT ON app.observable_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.stage_saved_github_revision();
CREATE TRIGGER observable_connection_github_outbox AFTER INSERT ON app.observable_github_links
  FOR EACH ROW EXECUTE FUNCTION app.stage_saved_github_revision();

CREATE FUNCTION app.claim_github_source_sync(p_revision uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.observable_github_syncs%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'Source sync token required'; END IF;
  SELECT * INTO j FROM app.observable_github_syncs WHERE source_revision_id = p_revision FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  IF j.stage = 'synced' THEN RETURN jsonb_build_object('status', 'synced'); END IF;
  IF j.lease_expires_at > clock_timestamp() THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.projects p JOIN app.organizations o ON o.id = p.organization_id AND o.status = 'active'
    JOIN app.organization_memberships m ON m.organization_id = p.organization_id AND m.user_id = j.requested_by
    JOIN app.github_publication_connections c ON c.id = j.connection_id AND c.enabled
    WHERE p.id = j.project_id AND p.organization_id = j.organization_id AND p.status = 'active'
      AND (m.role = 'admin' OR app.effective_project_role(p.id, m.user_id)::text IN ('owner', 'editor'))
  ) THEN
    UPDATE app.observable_github_syncs SET stage = 'failed', error_code = 'github_sync_authority_unavailable',
      updated_at = clock_timestamp() WHERE source_revision_id = p_revision;
    RETURN jsonb_build_object('status', 'failed');
  END IF;
  UPDATE app.observable_github_syncs SET stage = 'syncing', lease_token = p_token,
    lease_expires_at = clock_timestamp() + interval '1000 seconds', updated_at = clock_timestamp()
    WHERE source_revision_id = p_revision;
  RETURN jsonb_build_object('status', 'claimed', 'source_revision_id', p_revision,
    'organization_id', j.organization_id, 'project_id', j.project_id,
    'source_project_id', j.source_project_id, 'user_id', j.requested_by);
END;
$$;

CREATE FUNCTION app.finish_github_source_sync(p_revision uuid, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.observable_github_syncs%ROWTYPE; completed boolean;
BEGIN
  SELECT * INTO j FROM app.observable_github_syncs WHERE source_revision_id = p_revision FOR UPDATE;
  IF NOT FOUND OR j.lease_token IS DISTINCT FROM p_token OR j.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  SELECT EXISTS (SELECT 1 FROM app.observable_github_revision_receipts
    WHERE source_revision_id = p_revision AND connection_id = j.connection_id) INTO completed;
  UPDATE app.observable_github_syncs SET stage = CASE WHEN completed THEN 'synced' ELSE 'pending' END,
    error_code = CASE WHEN completed THEN NULL ELSE p_error END,
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE source_revision_id = p_revision;
  RETURN completed;
END;
$$;

REVOKE ALL ON FUNCTION app.stage_saved_github_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.request_github_source_sync(uuid), app.claim_github_source_sync(uuid, uuid),
  app.finish_github_source_sync(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_github_source_sync(uuid), app.claim_github_source_sync(uuid, uuid),
  app.finish_github_source_sync(uuid, uuid, text) TO opengeo_runtime;
COMMIT;
