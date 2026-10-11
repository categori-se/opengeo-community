-- Background workers have a durable job identity, not a browser tenant context.
-- Keep the public/RLS-aware helper unchanged. This private helper is callable
-- only by the existing SECURITY DEFINER routines owned by the migration owner.
CREATE FUNCTION app.background_project_role(p_organization uuid, p_project uuid, p_user uuid)
RETURNS app.project_role
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT candidate.role
  FROM app.projects project
  JOIN app.organizations organization
    ON organization.id = project.organization_id AND organization.status = 'active'
  JOIN app.organization_memberships membership
    ON membership.organization_id = organization.id AND membership.user_id = p_user
  CROSS JOIN LATERAL (
    SELECT direct.role
    FROM app.project_memberships direct
    WHERE direct.organization_id = p_organization
      AND direct.project_id = p_project AND direct.user_id = p_user
    UNION ALL
    SELECT grant_record.role
    FROM app.project_team_grants grant_record
    JOIN app.teams team ON team.organization_id = grant_record.organization_id
      AND team.id = grant_record.team_id AND team.status = 'active'
    JOIN app.team_memberships team_member
      ON team_member.organization_id = grant_record.organization_id
      AND team_member.team_id = grant_record.team_id AND team_member.user_id = p_user
    WHERE grant_record.organization_id = p_organization AND grant_record.project_id = p_project
  ) candidate
  WHERE project.organization_id = p_organization AND project.id = p_project AND project.status = 'active'
  ORDER BY CASE candidate.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2
    WHEN 'reviewer' THEN 3 WHEN 'viewer' THEN 4 END
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.background_project_role(uuid, uuid, uuid)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

-- Preserve each existing routine's identity, grants, lease checks, job-state
-- transitions and validation. Refuse unexpected definitions instead of silently
-- modifying another authorization expression. Each replacement is tenant-bound
-- to the project already joined against the durable job or publication review.
DO $$
DECLARE item record; definition text; revised text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('app.claim_github_source_sync(uuid,uuid)',
      'app.effective_project_role(p.id, m.user_id)',
      'app.background_project_role(p.organization_id, p.id, m.user_id)'),
    ('app.claim_github_build_dispatch(uuid,uuid)',
      'app.effective_project_role(project.id, member.user_id)',
      'app.background_project_role(project.organization_id, project.id, member.user_id)'),
    ('app.advance_github_build_dispatch(uuid,uuid,text,text,bigint,integer,text,text,text)',
      'app.effective_project_role(project.id, member.user_id)',
      'app.background_project_role(project.organization_id, project.id, member.user_id)'),
    ('app.framework_publisher_authorized(uuid)',
      'app.effective_project_role(project.id, member.user_id)',
      'app.background_project_role(project.organization_id, project.id, member.user_id)')
  ) AS changes(signature, old_expression, new_expression)
  LOOP
    IF NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = item.signature::regprocedure) THEN
      RAISE EXCEPTION 'Expected existing security-definer routine: %', item.signature;
    END IF;
    definition := pg_catalog.pg_get_functiondef(item.signature::regprocedure);
    IF (length(definition) - length(replace(definition, item.old_expression, '')))
         / length(item.old_expression) <> 1 THEN
      RAISE EXCEPTION 'Unexpected background authority definition: %', item.signature;
    END IF;
    revised := replace(definition, item.old_expression, item.new_expression);
    EXECUTE revised;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION app.background_project_role(uuid, uuid, uuid) IS
  'Private background-worker role lookup: durable tenant/project/user identity; no browser-context dependency or direct runtime grant.';
