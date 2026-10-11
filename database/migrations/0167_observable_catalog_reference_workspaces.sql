BEGIN;

-- A Publication keeps its own Source/link identity while retaining the actual
-- Catalog resource and metadata edition in their original tenant/workspace.
DO $$
DECLARE constraint_name text; matches integer;
BEGIN
 SELECT count(*),min(conname::text) INTO matches,constraint_name FROM pg_constraint
  WHERE conrelid='app.observable_public_file_references'::regclass
   AND confrelid='app.governed_resources'::regclass AND contype='f'
   AND cardinality(conkey)=3;
 IF matches<>1 THEN RAISE EXCEPTION 'Unexpected public reference resource constraint'; END IF;
 EXECUTE format('ALTER TABLE app.observable_public_file_references DROP CONSTRAINT %I',constraint_name);
 ALTER TABLE app.observable_public_file_references
  ADD CONSTRAINT observable_public_file_references_resource_fkey
  FOREIGN KEY(organization_id,resource_id) REFERENCES app.governed_resources(organization_id,id);
END;
$$;

DO $$
DECLARE definition text; anchor text; addition text;
BEGIN
 definition:=pg_get_functiondef('app.resolve_observable_public_file_reference(uuid,uuid,uuid,bigint,uuid,uuid,text)'::regprocedure);
 anchor:='resource.organization_id=project.organization_id AND resource.project_id=project.id';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference resource workspace'; END IF;
 definition:=replace(definition,anchor,'resource.organization_id=project.organization_id');
 anchor:='  JOIN app.governed_resource_versions metadata ON';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference metadata join'; END IF;
 definition:=replace(definition,anchor,'  JOIN app.projects resource_project ON resource_project.organization_id=resource.organization_id
    AND resource_project.id=resource.project_id AND resource_project.status=''active''
'||anchor);
 anchor:='OR app.effective_project_role(project.id,member.user_id)::text IN (''owner'',''editor'',''reviewer'',''viewer'')';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>2 THEN RAISE EXCEPTION 'Unexpected reference read authority'; END IF;
 -- Datasets have account identity and arbitrary project links, not a canonical
 -- workspace column. Keep existing same-workspace access; a new target link
 -- cannot manufacture independent read access to another workspace's input.
 definition:=replace(definition,anchor,'OR EXISTS(SELECT 1 FROM app.project_datasets access_link
        JOIN app.projects access_project ON access_project.organization_id=access_link.organization_id
          AND access_project.id=access_link.project_id AND access_project.status=''active''
        WHERE access_link.organization_id=p_org AND access_link.dataset_id=p_dataset
          AND (access_link.project_id<>p_project OR resource.project_id=p_project)
          AND app.effective_project_role(access_project.id,member.user_id)::text IN (''owner'',''editor'',''reviewer'',''viewer''))');
 -- Only the second occurrence belongs to metadata resource read; Layer read
 -- remains based on its own links, ownership or dataset grants.
 anchor:='AND (member.role=''admin'' OR resource.owner_user_id=member.user_id
      OR EXISTS(SELECT 1 FROM app.project_datasets access_link
        JOIN app.projects access_project ON access_project.organization_id=access_link.organization_id
          AND access_project.id=access_link.project_id AND access_project.status=''active''
        WHERE access_link.organization_id=p_org AND access_link.dataset_id=p_dataset
          AND (access_link.project_id<>p_project OR resource.project_id=p_project)
          AND app.effective_project_role(access_project.id,member.user_id)::text IN (''owner'',''editor'',''reviewer'',''viewer''))';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected independent metadata read'; END IF;
 definition:=replace(definition,anchor,'AND (member.role=''admin'' OR resource.owner_user_id=member.user_id
      OR app.effective_project_role(resource_project.id,member.user_id)::text IN (''owner'',''editor'',''reviewer'',''viewer'')');
 anchor:='FOR SHARE OF project, dataset, resource, organization, member, linked;';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference authority locks'; END IF;
 definition:=replace(definition,anchor,'FOR SHARE OF project, dataset, resource, organization, member, linked, resource_project;');
 anchor:='  SELECT metadata.version_number, metadata.metadata_extensions, revision.source_url INTO facts';
 addition:=$body$
  PERFORM 1 FROM app.project_datasets access_link JOIN app.projects access_project
    ON access_project.organization_id=access_link.organization_id AND access_project.id=access_link.project_id
    WHERE access_link.organization_id=p_org AND access_link.dataset_id=p_dataset AND access_link.project_id<>p_project
    FOR SHARE OF access_link,access_project;
  PERFORM 1 FROM app.project_memberships permission WHERE permission.organization_id=p_org
    AND permission.user_id=app.current_user_id() AND permission.project_id IN (
      SELECT project_id FROM app.project_datasets WHERE organization_id=p_org AND dataset_id=p_dataset AND project_id<>p_project
      UNION SELECT project_id FROM app.governed_resources WHERE organization_id=p_org AND id=p_resource)
    FOR SHARE;
  PERFORM 1 FROM app.project_team_grants grant_row JOIN app.teams team
    ON team.organization_id=grant_row.organization_id AND team.id=grant_row.team_id
    JOIN app.team_memberships member_row ON member_row.organization_id=team.organization_id AND member_row.team_id=team.id
    WHERE grant_row.organization_id=p_org AND member_row.user_id=app.current_user_id() AND grant_row.project_id IN (
      SELECT project_id FROM app.project_datasets WHERE organization_id=p_org AND dataset_id=p_dataset AND project_id<>p_project
      UNION SELECT project_id FROM app.governed_resources WHERE organization_id=p_org AND id=p_resource)
    FOR SHARE OF grant_row,team,member_row;
$body$;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference facts query'; END IF;
 EXECUTE replace(definition,anchor,addition||anchor);
 definition:=pg_get_functiondef('app.validate_observable_referenced_distribution(uuid,uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
 anchor:='AND resource.project_id=p_project AND resource.id::text=pin->>''resourceId''';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference distribution workspace'; END IF;
 EXECUTE replace(definition,anchor,'AND resource.id::text=pin->>''resourceId''');
END;
$$;

COMMIT;
