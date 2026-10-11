BEGIN;

-- Private compilation uses exact Catalog references under the original build
-- actor. This does not create archived objects or referenced-file distribution
-- approvals, and does not grant the coordinator access to application tables.
CREATE OR REPLACE FUNCTION app.resolve_observable_build_data(p_job_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.observable_build_jobs%ROWTYPE; manifest jsonb; bindings jsonb; pins jsonb; result jsonb;
 prior_org text:=current_setting('app.organization_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
 SELECT * INTO job FROM app.observable_build_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL OR job.state<>'running' OR job.coordinator_token IS DISTINCT FROM p_token
  OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'data resolution requires a live build lease' USING ERRCODE='23514'; END IF;
 SELECT revision.manifest INTO manifest FROM app.observable_source_revisions revision
  WHERE revision.organization_id=job.organization_id AND revision.source_project_id=job.source_project_id
   AND revision.id=job.source_revision_id;
 IF manifest->>'schemaVersion'='opengeo.observable-source-revision.1.0.0' THEN RETURN '[]'::jsonb; END IF;
 IF manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0' AND job.purpose<>'preview'
 THEN RAISE EXCEPTION 'referenced file publication rights are not implemented' USING ERRCODE='23514'; END IF;
 IF manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0' AND (
  job.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.1.0.0','opengeo.observable-build-request.4.0.0')
  OR job.request ? 'artifactInputsChecksumSha256' OR job.request->>'distributionApprovalId' IS NOT NULL)
 THEN RAISE EXCEPTION 'referenced file composition is not supported' USING ERRCODE='23514'; END IF;
 PERFORM app.require_observable_distribution_request(job.id);
 IF job.purpose<>'preview' AND job.request->>'schemaVersion' NOT IN
  ('opengeo.observable-build-request.3.0.0','opengeo.observable-build-request.4.0.0')
 THEN RAISE EXCEPTION 'archive publication rights are not implemented' USING ERRCODE='23514'; END IF;
 PERFORM set_config('app.organization_id',job.organization_id::text,true);
 PERFORM set_config('app.user_id',job.created_by::text,true);
 bindings:=app.validate_observable_revision_input_bindings(job.organization_id,job.project_id,job.source_project_id,manifest);
 pins:=bindings->'dataAttachments';
 SELECT coalesce(jsonb_agg(pin.value||jsonb_build_object('bucket',object.bucket,'objectKey',object.object_key,'etag',object.etag)
  ORDER BY pin.ordinality),'[]'::jsonb) INTO result
 FROM jsonb_array_elements(pins) WITH ORDINALITY pin(value,ordinality)
 JOIN app.data_objects object ON object.organization_id=job.organization_id AND object.id::text=pin.value->>'dataObjectId';
 IF jsonb_array_length(result) IS DISTINCT FROM jsonb_array_length(pins)
 THEN RAISE EXCEPTION 'archive resolution is incomplete' USING ERRCODE='23514'; END IF;
 -- Lease expiration can occur while current-authority row locks are waiting.
 IF job.lease_expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'data resolution requires a live build lease' USING ERRCODE='23514'; END IF;
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
 RETURN result||(bindings->'referencedFiles');
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION app.require_observable_staging_manifest_support()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE manifest jsonb;
BEGIN
 SELECT revision.manifest INTO manifest FROM app.observable_source_revisions revision
  WHERE revision.organization_id=NEW.organization_id AND revision.source_project_id=NEW.source_project_id AND revision.id=NEW.source_revision_id;
 IF manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0' THEN
  IF NEW.purpose<>'preview' THEN
   RAISE EXCEPTION 'referenced file publication rights are not implemented' USING ERRCODE='23514';
  END IF;
  IF NEW.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.1.0.0','opengeo.observable-build-request.4.0.0')
   OR NEW.request ? 'artifactInputsChecksumSha256' OR NEW.request->>'distributionApprovalId' IS NOT NULL
  THEN RAISE EXCEPTION 'referenced file composition is not supported' USING ERRCODE='23514'; END IF;
  PERFORM app.validate_observable_revision_input_bindings(NEW.organization_id,NEW.project_id,NEW.source_project_id,manifest);
 ELSIF manifest->>'schemaVersion'='opengeo.observable-source-revision.2.0.0' THEN
  IF NEW.purpose<>'preview' AND NEW.request->>'schemaVersion' NOT IN
   ('opengeo.observable-build-request.3.0.0','opengeo.observable-build-request.4.0.0')
  THEN RAISE EXCEPTION 'archive publication rights are not implemented' USING ERRCODE='23514'; END IF;
  PERFORM app.validate_observable_revision_data_bindings(NEW.organization_id,NEW.project_id,NEW.source_project_id,manifest);
 ELSIF manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-source-revision.1.0.0'
 THEN RAISE EXCEPTION 'unsupported source staging manifest' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.require_observable_preview_archive_access()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE build app.observable_build_jobs%ROWTYPE; manifest jsonb;
BEGIN
 SELECT * INTO build FROM app.observable_build_jobs WHERE organization_id=NEW.organization_id AND id=NEW.build_job_id;
 SELECT revision.manifest INTO manifest FROM app.observable_source_revisions revision
  WHERE revision.organization_id=build.organization_id AND revision.id=build.source_revision_id;
 IF manifest->>'schemaVersion' IN ('opengeo.observable-source-revision.2.0.0','opengeo.observable-source-revision.3.0.0') THEN
  IF NEW.requested_by IS DISTINCT FROM app.current_user_id() OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  THEN RAISE EXCEPTION 'data preview requires its current requester' USING ERRCODE='23514'; END IF;
  PERFORM app.validate_observable_revision_input_bindings(build.organization_id,build.project_id,build.source_project_id,manifest);
 END IF;
 RETURN NEW;
END;
$$;

-- Lock mutable authority and custody rows before a fresh validation query.
-- Network and compilation happen after the resolver transaction has ended.
DO $$
DECLARE definition text; anchor text:='  SELECT metadata.version_number, metadata.metadata_extensions, revision.source_url INTO facts';
 addition text:=$body$
  PERFORM 1 FROM app.project_memberships WHERE organization_id=p_org AND project_id=p_project AND user_id=app.current_user_id() FOR SHARE;
  PERFORM 1 FROM app.dataset_permissions WHERE organization_id=p_org AND dataset_id=p_dataset AND user_id=app.current_user_id() FOR SHARE;
  PERFORM 1 FROM app.governed_resource_permissions WHERE organization_id=p_org AND resource_id=p_resource AND user_id=app.current_user_id() FOR SHARE;
  PERFORM 1 FROM app.project_team_grants grant_row JOIN app.teams team
    ON team.organization_id=grant_row.organization_id AND team.id=grant_row.team_id
    JOIN app.team_memberships member_row ON member_row.organization_id=team.organization_id AND member_row.team_id=team.id
    WHERE grant_row.organization_id=p_org AND grant_row.project_id=p_project AND member_row.user_id=app.current_user_id()
    FOR SHARE OF grant_row,team,member_row;
$body$;
BEGIN
 definition:=pg_get_functiondef('app.resolve_observable_public_file_reference(uuid,uuid,uuid,bigint,uuid,uuid,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  OR position('FOR SHARE OF project, dataset, resource;' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected public reference authority'; END IF;
 definition:=replace(definition,anchor,addition||anchor);
 definition:=replace(definition,'FOR SHARE OF project, dataset, resource;',
  'FOR SHARE OF project, dataset, resource, organization, member, linked;');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.validate_observable_revision_input_bindings(uuid,uuid,uuid,jsonb)'::regprocedure);
 anchor:='  IF p_manifest->>''schemaVersion'' IN';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected reference binding authority'; END IF;
 EXECUTE replace(definition,anchor,'  IF p_manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' THEN
    PERFORM 1 FROM app.observable_source_projects source JOIN app.projects project
      ON project.organization_id=source.organization_id AND project.id=source.project_id
      JOIN app.organizations organization ON organization.id=project.organization_id
      JOIN app.organization_memberships member ON member.organization_id=organization.id AND member.user_id=app.current_user_id()
      WHERE source.organization_id=p_org AND source.project_id=p_project AND source.id=p_source
      FOR SHARE OF source,project,organization,member;
    PERFORM 1 FROM app.project_memberships WHERE organization_id=p_org AND project_id=p_project AND user_id=app.current_user_id() FOR SHARE;
    PERFORM 1 FROM app.project_team_grants grant_row JOIN app.teams team
      ON team.organization_id=grant_row.organization_id AND team.id=grant_row.team_id
      JOIN app.team_memberships member_row ON member_row.organization_id=team.organization_id AND member_row.team_id=team.id
      WHERE grant_row.organization_id=p_org AND grant_row.project_id=p_project AND member_row.user_id=app.current_user_id()
      FOR SHARE OF grant_row,team,member_row;
  END IF;
'||anchor);
 definition:=pg_get_functiondef('app.claim_observable_build_runtime(uuid,uuid,integer)'::regprocedure);
 anchor:='      p_job_id, p_coordinator_token, p_lease_seconds
    );';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected runtime claim'; END IF;
 EXECUTE replace(definition,anchor,anchor||'
  IF EXISTS(SELECT 1 FROM app.observable_build_jobs job JOIN app.observable_source_revisions revision
    ON revision.organization_id=job.organization_id AND revision.id=job.source_revision_id
    WHERE job.id=p_job_id AND job.state=''running'' AND job.coordinator_token=p_coordinator_token
      AND revision.manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'') THEN
    PERFORM app.resolve_observable_build_data(p_job_id,p_coordinator_token);
  END IF;');
END;
$$;

-- Generic compiler dataFiles remain credential-free. Their exact matching
-- retains the historical archivePaths field without inventing archive records.
CREATE OR REPLACE FUNCTION app.observable_exact_archive_output(p_manifest jsonb,p_file jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_manifest->'dataAttachments','[]'::jsonb)||coalesce(p_manifest->'referencedFiles','[]'::jsonb)) pin
  WHERE pin->>'checksumSha256'=p_file->>'checksumSha256' AND pin->>'sizeBytes'=p_file->>'sizeBytes'
   AND lower(substring(pin->>'path' FROM '\.[^.\/]+$'))=lower(substring(p_file->>'path' FROM '\.[^.\/]+$'))
   AND (p_file->>'sizeBytes')::bigint BETWEEN 1 AND 67108864);
$$;

DO $$
DECLARE definition text; anchor text;
BEGIN
 definition:=pg_get_functiondef('app.enforce_observable_build_job_insert()'::regprocedure);
 anchor:='coalesce(jsonb_array_length(v_revision.manifest->''dataAttachments''),0)=0';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected output profile admission'; END IF;
 EXECUTE replace(definition,anchor,'(coalesce(jsonb_array_length(v_revision.manifest->''dataAttachments''),0)+coalesce(jsonb_array_length(v_revision.manifest->''referencedFiles''),0))=0');
 definition:=pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
 anchor:='IF v_manifest->>''schemaVersion'' = ''opengeo.observable-source-revision.2.0.0'' THEN';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected completion input guard'; END IF;
 definition:=replace(definition,anchor,'IF v_manifest->>''schemaVersion'' IN (''opengeo.observable-source-revision.2.0.0'',''opengeo.observable-source-revision.3.0.0'') THEN');
 anchor:='coalesce(jsonb_array_length(v_manifest->''dataAttachments''),0)';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected completion input count'; END IF;
 definition:=replace(definition,anchor,'(coalesce(jsonb_array_length(v_manifest->''dataAttachments''),0)+coalesce(jsonb_array_length(v_manifest->''referencedFiles''),0))');
 anchor:='coalesce(v_manifest->''dataAttachments'',''[]''::jsonb)';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected completion input bytes'; END IF;
 definition:=replace(definition,anchor,'(coalesce(v_manifest->''dataAttachments'',''[]''::jsonb)||coalesce(v_manifest->''referencedFiles'',''[]''::jsonb))');
 anchor:='v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND (v_file->>''contentType'') IN (''image/tiff'',''image/geotiff'')';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected TIFF output guard'; END IF;
 definition:=replace(definition,anchor,'(v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' OR v_manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'') AND (v_file->>''contentType'') IN (''image/tiff'',''image/geotiff'')');
 anchor:='  IF p_result IS NULL';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected referenced result proof'; END IF;
 definition:=replace(definition,anchor,'  IF v_manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' AND (
    p_result#>>''{validationReport,inputFileCount}'' IS DISTINCT FROM
      (jsonb_array_length(v_manifest->''files'')+jsonb_array_length(v_manifest->''dataAttachments'')+jsonb_array_length(v_manifest->''referencedFiles''))::text
    OR p_result#>>''{validationReport,inputBytes}'' IS DISTINCT FROM
      (SELECT coalesce(sum((file->>''sizeBytes'')::bigint),0) FROM jsonb_array_elements((v_manifest->''files'')||(v_manifest->''dataAttachments'')||(v_manifest->''referencedFiles'')) file)::text)
  THEN RAISE EXCEPTION ''Build result must cover all exact referenced inputs'' USING ERRCODE=''23514''; END IF;
'||anchor);
 EXECUTE definition;
 definition:=pg_get_functiondef('app.observable_localized_result_is_valid(jsonb,jsonb,jsonb)'::regprocedure);
 anchor:='pins jsonb:=coalesce(p_source->''dataAttachments'',''[]''::jsonb);';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected localized input pins'; END IF;
 definition:=replace(definition,anchor,'pins jsonb:=(SELECT coalesce(jsonb_agg(pin ORDER BY pin->>''path'' COLLATE "C"),''[]''::jsonb) FROM jsonb_array_elements(coalesce(p_source->''dataAttachments'',''[]''::jsonb)||coalesce(p_source->''referencedFiles'',''[]''::jsonb)) pin);');
 EXECUTE definition;
END;
$$;

-- A public URL is not an input distribution decision. Close all source-only
-- shortcuts independently of source rights, output representation or profile.
DO $$
DECLARE definition text; anchor text;
BEGIN
 definition:=pg_get_functiondef('app.require_observable_distribution_request(uuid)'::regprocedure);
 anchor:=' IF job.request->>''schemaVersion'' NOT IN';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected distribution request'; END IF;
 EXECUTE replace(definition,anchor,' IF EXISTS(SELECT 1 FROM app.observable_source_revisions revision WHERE revision.organization_id=job.organization_id AND revision.id=job.source_revision_id
   AND revision.manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'') AND job.purpose<>''preview'' THEN
   RAISE EXCEPTION ''referenced file publication rights are not implemented'' USING ERRCODE=''23514'';
 END IF;
'||anchor);
 definition:=pg_get_functiondef('app.validate_observable_distribution_manifest(uuid,uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
 anchor:=' IF NOT FOUND OR NOT EXISTS (';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected distribution approval'; END IF;
 EXECUTE replace(definition,anchor,' IF NOT FOUND OR revision.manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' OR NOT EXISTS (');
 definition:=pg_get_functiondef('app.require_observable_review_distribution(uuid,uuid)'::regprocedure);
 anchor:=' IF coalesce(jsonb_array_length(manifest->''dataAttachments''),0)=0';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected distribution review'; END IF;
 EXECUTE replace(definition,anchor,' IF manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' THEN
  RAISE EXCEPTION ''referenced file publication rights are not implemented'' USING ERRCODE=''23514'';
 END IF;
'||anchor);
 definition:=pg_get_functiondef('app.framework_publisher_authorized(uuid)'::regprocedure);
 anchor:='WHERE review.id = p_review AND';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected publisher authority'; END IF;
 EXECUTE replace(definition,anchor,'WHERE review.id = p_review AND revision.manifest->>''schemaVersion''<>''opengeo.observable-source-revision.3.0.0'' AND');
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_observable_build_data(uuid,uuid) FROM PUBLIC,opengeo_runtime,opengeo_worker;
GRANT EXECUTE ON FUNCTION app.resolve_observable_build_data(uuid,uuid) TO opengeo_observable_coordinator;

COMMIT;
