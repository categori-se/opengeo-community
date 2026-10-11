BEGIN;

-- Repository authority is provisioned by the deployment operator after GitHub
-- installation verification. A Studio editor may select an existing grant, not
-- invent an installation ID or grant access to another organization's source.
CREATE TABLE app.github_publication_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL,
  verified_by uuid NOT NULL REFERENCES app.users(id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, repository_id)
);

CREATE TABLE app.observable_github_links (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, source_project_id),
  UNIQUE (organization_id, project_id, source_project_id, connection_id),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES app.github_publication_connections (organization_id, id)
);

CREATE TABLE app.observable_github_revision_receipts (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  git_ref text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, source_revision_id),
  FOREIGN KEY (organization_id, project_id, source_project_id, source_revision_id)
    REFERENCES app.observable_source_revisions (organization_id, project_id, source_project_id, id),
  FOREIGN KEY (organization_id, project_id, source_project_id, connection_id)
    REFERENCES app.observable_github_links (organization_id, project_id, source_project_id, connection_id),
  CHECK (git_ref = 'heads/studio/sources/' || source_project_id::text || '/revisions/' || source_revision_id::text)
);

CREATE FUNCTION app.enforce_observable_github_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NOT EXISTS (
      SELECT 1 FROM app.projects project
      JOIN app.organization_memberships member ON member.organization_id = project.organization_id
        AND member.user_id = app.current_user_id()
      WHERE project.organization_id = NEW.organization_id AND project.id = NEW.project_id
        AND project.status = 'active'
        AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'editor'))
    ) OR NOT EXISTS (
      SELECT 1 FROM app.github_publication_connections connection
      WHERE connection.organization_id = NEW.organization_id AND connection.id = NEW.connection_id
        AND connection.enabled
    )
  THEN
    RAISE EXCEPTION 'GitHub source export requires project management and enabled repository grant' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'observable_github_revision_receipts' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.github_publication_connections connection
      WHERE connection.organization_id = NEW.organization_id AND connection.id = NEW.connection_id
        AND connection.repository_id = NEW.repository_id
    ) THEN
      RAISE EXCEPTION 'GitHub receipt repository mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER observable_github_links_validate BEFORE INSERT ON app.observable_github_links
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_github_record();
CREATE TRIGGER observable_github_revision_receipts_validate BEFORE INSERT ON app.observable_github_revision_receipts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_github_record();
CREATE TRIGGER observable_github_links_immutable BEFORE UPDATE OR DELETE ON app.observable_github_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_github_revision_receipts_immutable BEFORE UPDATE OR DELETE ON app.observable_github_revision_receipts
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.github_publication_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.github_publication_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_links FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_revision_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_github_revision_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY github_publication_connections_tenant ON app.github_publication_connections
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_github_links_tenant ON app.observable_github_links
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_github_revision_receipts_tenant ON app.observable_github_revision_receipts
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT ON app.github_publication_connections TO opengeo_runtime;
GRANT SELECT, INSERT ON app.observable_github_links, app.observable_github_revision_receipts TO opengeo_runtime;
REVOKE ALL ON app.github_publication_connections, app.observable_github_links,
  app.observable_github_revision_receipts FROM PUBLIC, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator;
REVOKE ALL ON FUNCTION app.enforce_observable_github_record() FROM PUBLIC;

COMMENT ON TABLE app.github_publication_connections IS
  'Operator-verified organization repository grants. No tokens or private keys; app users cannot create grants.';
COMMENT ON TABLE app.observable_github_links IS
  'Explicit project-manager selection of an already authorized private repository; independent of publication authority.';
COMMENT ON TABLE app.observable_github_revision_receipts IS
  'Immutable exact GitHub snapshot identities, separate for every standalone Framework project and revision.';
COMMIT;
