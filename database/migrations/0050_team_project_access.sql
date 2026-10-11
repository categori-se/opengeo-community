BEGIN;

CREATE TYPE app.team_role AS ENUM ('owner', 'manager', 'member');

CREATE TABLE app.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  name text NOT NULL,
  description text,
  status app.record_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT teams_name_bounded CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 200
  ),
  CONSTRAINT teams_description_bounded CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 10000
  )
);

CREATE UNIQUE INDEX teams_organization_name_unique
  ON app.teams (organization_id, lower(name));
CREATE INDEX teams_organization_status_idx
  ON app.teams (organization_id, status, updated_at DESC, id);

CREATE TABLE app.team_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  team_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  role app.team_role NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, team_id, user_id),
  FOREIGN KEY (organization_id, team_id)
    REFERENCES app.teams (organization_id, id)
);

CREATE INDEX team_memberships_user_idx
  ON app.team_memberships (organization_id, user_id, team_id);

CREATE TABLE app.project_team_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  team_id uuid NOT NULL,
  role app.project_role NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, team_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, team_id)
    REFERENCES app.teams (organization_id, id)
);

CREATE INDEX project_team_grants_team_idx
  ON app.project_team_grants (organization_id, team_id, project_id);

CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON app.teams
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER team_memberships_set_updated_at
  BEFORE UPDATE ON app.team_memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER project_team_grants_set_updated_at
  BEFORE UPDATE ON app.project_team_grants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_team_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teams FORCE ROW LEVEL SECURITY;
ALTER TABLE app.team_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_team_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY teams_tenant_isolation ON app.teams
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY team_memberships_tenant_isolation ON app.team_memberships
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_team_grants_tenant_isolation ON app.project_team_grants
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.effective_project_role(
  p_project_id uuid,
  p_user_id uuid DEFAULT app.current_user_id()
)
RETURNS app.project_role
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT candidate.role
  FROM (
    SELECT direct_membership.role
    FROM app.project_memberships direct_membership
    WHERE direct_membership.organization_id = app.current_organization_id()
      AND direct_membership.project_id = p_project_id
      AND direct_membership.user_id = p_user_id

    UNION ALL

    SELECT team_grant.role
    FROM app.project_team_grants team_grant
    JOIN app.teams team
      ON team.organization_id = team_grant.organization_id
     AND team.id = team_grant.team_id
     AND team.status = 'active'
    JOIN app.team_memberships team_membership
      ON team_membership.organization_id = team_grant.organization_id
     AND team_membership.team_id = team_grant.team_id
     AND team_membership.user_id = p_user_id
    WHERE team_grant.organization_id = app.current_organization_id()
      AND team_grant.project_id = p_project_id
  ) candidate
  ORDER BY CASE candidate.role
    WHEN 'owner' THEN 1
    WHEN 'editor' THEN 2
    WHEN 'reviewer' THEN 3
    WHEN 'viewer' THEN 4
  END
  LIMIT 1
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.teams,
  app.team_memberships,
  app.project_team_grants
TO opengeo_runtime;

REVOKE EXECUTE ON FUNCTION app.effective_project_role(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.effective_project_role(uuid, uuid) TO opengeo_runtime;

REVOKE ALL ON
  app.teams,
  app.team_memberships,
  app.project_team_grants
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;

COMMENT ON TABLE app.teams IS
  'Organization-scoped collaboration groups; membership alone grants no project access.';
COMMENT ON TABLE app.project_team_grants IS
  'Explicit team-to-project role grants. Project creators retain a direct owner membership.';
COMMENT ON FUNCTION app.effective_project_role(uuid, uuid) IS
  'Strongest direct or active-team project role for one user inside the current tenant.';

COMMIT;
