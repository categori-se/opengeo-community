BEGIN;

-- Runtime receives only the current tenant/actor predicate, never the private
-- explicit-organization helper used by background guards.
CREATE FUNCTION app.observable_distribution_resource_can_publish(p_resource uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT app.observable_distribution_resource_authority(
   app.current_organization_id(),p_resource,app.current_user_id());
$$;
REVOKE ALL ON FUNCTION app.observable_distribution_resource_can_publish(uuid)
 FROM PUBLIC,opengeo_worker,opengeo_observable_coordinator,opengeo_framework_publisher;
GRANT EXECUTE ON FUNCTION app.observable_distribution_resource_can_publish(uuid) TO opengeo_runtime;

-- An owner decision concerns one exact distribution and current publish
-- authority. Historical read metadata remains part of the immutable input pin.
CREATE FUNCTION app.validate_observable_referenced_distribution(
 p_org uuid,p_project uuid,p_source uuid,p_revision uuid,p_actor uuid,p_manifest jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE revision app.observable_source_revisions%ROWTYPE; pin jsonb; rights jsonb;
 prior_org text:=current_setting('app.organization_id',true); prior_user text:=current_setting('app.user_id',true);
BEGIN
 SELECT * INTO revision FROM app.observable_source_revisions WHERE organization_id=p_org
  AND project_id=p_project AND source_project_id=p_source AND id=p_revision;
 IF NOT FOUND OR revision.manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-source-revision.3.0.0'
  OR p_manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-input-distribution-approval.2.0.0'
  OR p_manifest-ARRAY['schemaVersion','organizationId','projectId','sourceProjectId','sourceRevisionId','sourceManifestChecksumSha256','compilerImageDigest','outputProfile','artifactInputsChecksumSha256','dataAttachments','archiveRights','artifacts','referencedFiles','referenceRights']<>'{}'
  OR NOT p_manifest ?& ARRAY['schemaVersion','organizationId','projectId','sourceProjectId','sourceRevisionId','sourceManifestChecksumSha256','compilerImageDigest','outputProfile','artifactInputsChecksumSha256','dataAttachments','archiveRights','artifacts','referencedFiles','referenceRights']
  OR p_manifest->>'organizationId' IS DISTINCT FROM p_org::text OR p_manifest->>'projectId' IS DISTINCT FROM p_project::text
  OR p_manifest->>'sourceProjectId' IS DISTINCT FROM p_source::text OR p_manifest->>'sourceRevisionId' IS DISTINCT FROM p_revision::text
  OR p_manifest->>'sourceManifestChecksumSha256' IS DISTINCT FROM revision.manifest_checksum_sha256
  OR p_manifest->>'compilerImageDigest' IS DISTINCT FROM app.observable_effective_compiler_digest(p_org,p_source)
  OR coalesce(p_manifest->>'outputProfile','') NOT IN ('default-32m','archive-96m')
  OR p_manifest->'artifactInputsChecksumSha256' IS DISTINCT FROM 'null'::jsonb OR p_manifest->'artifacts' IS DISTINCT FROM '[]'::jsonb
  OR p_manifest->'dataAttachments' IS DISTINCT FROM revision.manifest->'dataAttachments'
  OR p_manifest->'referencedFiles' IS DISTINCT FROM revision.manifest->'referencedFiles'
  OR jsonb_typeof(p_manifest->'archiveRights') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_manifest->'referenceRights') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_manifest->'archiveRights') IS DISTINCT FROM jsonb_array_length(p_manifest->'dataAttachments')
  OR jsonb_array_length(p_manifest->'referenceRights') IS DISTINCT FROM jsonb_array_length(p_manifest->'referencedFiles')
 THEN RETURN false; END IF;
 PERFORM set_config('app.organization_id',p_org::text,true);
 PERFORM set_config('app.user_id',p_actor::text,true);
 -- Locks current source/read authority and mutable Catalog rows, then reads
 -- exact saved input facts. A reference never inherits publication permission.
 PERFORM app.validate_observable_revision_input_bindings(p_org,p_project,p_source,revision.manifest);
 FOR pin,rights IN SELECT files.value,terms.value
  FROM jsonb_array_elements(p_manifest->'dataAttachments') WITH ORDINALITY files(value,n)
  JOIN jsonb_array_elements(p_manifest->'archiveRights') WITH ORDINALITY terms(value,n) USING(n)
 LOOP
  IF rights-ARRAY['path','attachmentId','resourceId','resourceVersionId','license','attribution','acknowledgment']<>'{}'
   OR NOT rights ?& ARRAY['path','attachmentId','resourceId','resourceVersionId','license','attribution','acknowledgment']
   OR rights->>'path' IS DISTINCT FROM pin->>'path' OR rights->>'attachmentId' IS DISTINCT FROM pin->>'attachmentId'
   OR rights->>'acknowledgment' IS DISTINCT FROM 'publish-exact-archive-file'
   OR coalesce(rights->>'license','') NOT IN ('CC0-1.0','CC-BY-4.0','PDDL-1.0')
   OR jsonb_typeof(rights->'attribution') IS DISTINCT FROM 'string'
   OR coalesce(char_length(trim(rights->>'attribution')),0) NOT BETWEEN 1 AND 2000
   OR NOT EXISTS(SELECT 1 FROM app.governed_resources resource WHERE resource.organization_id=p_org
     AND resource.id::text=rights->>'resourceId' AND resource.current_version_id::text=rights->>'resourceVersionId'
     AND resource.kind='dataset' AND resource.dataset_id::text=pin->>'datasetId' AND resource.state<>'archived')
   OR NOT app.observable_distribution_resource_authority(p_org,(rights->>'resourceId')::uuid,p_actor)
  THEN
   PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
   PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
   RETURN false;
  END IF;
 END LOOP;
 FOR pin,rights IN SELECT files.value,terms.value
  FROM jsonb_array_elements(p_manifest->'referencedFiles') WITH ORDINALITY files(value,n)
  JOIN jsonb_array_elements(p_manifest->'referenceRights') WITH ORDINALITY terms(value,n) USING(n)
 LOOP
  IF rights-ARRAY['referenceId','path','resourceId','resourceVersionId','distributionId','license','attribution','acknowledgment']<>'{}'
   OR NOT rights ?& ARRAY['referenceId','path','resourceId','resourceVersionId','distributionId','license','attribution','acknowledgment']
   OR rights->>'referenceId' IS DISTINCT FROM pin->>'referenceId' OR rights->>'path' IS DISTINCT FROM pin->>'path'
   OR rights->>'resourceId' IS DISTINCT FROM pin->>'resourceId' OR rights->>'distributionId' IS DISTINCT FROM pin->>'distributionId'
   OR rights->>'acknowledgment' IS DISTINCT FROM 'publish-exact-referenced-file'
   OR coalesce(rights->>'license','') NOT IN ('CC0-1.0','CC-BY-4.0','PDDL-1.0')
   OR jsonb_typeof(rights->'attribution') IS DISTINCT FROM 'string'
   OR coalesce(char_length(trim(rights->>'attribution')),0) NOT BETWEEN 1 AND 2000
   OR NOT EXISTS(SELECT 1 FROM app.governed_resources resource WHERE resource.organization_id=p_org
     AND resource.project_id=p_project AND resource.id::text=pin->>'resourceId'
     AND resource.current_version_id::text=rights->>'resourceVersionId' AND resource.state<>'archived'
     AND resource.kind='dataset' AND resource.dataset_id::text=pin->>'datasetId')
   OR NOT app.observable_distribution_resource_authority(p_org,(pin->>'resourceId')::uuid,p_actor)
  THEN
   PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
   PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
   RETURN false;
  END IF;
 END LOOP;
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation OR invalid_parameter_value THEN
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
 RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION app.validate_observable_referenced_distribution(uuid,uuid,uuid,uuid,uuid,jsonb)
 FROM PUBLIC,opengeo_runtime,opengeo_worker,opengeo_observable_coordinator,opengeo_framework_publisher;

-- Preserve the legacy validator byte-for-byte after the new version branch.
DO $$
DECLARE definition text; anchor text:=' IF NOT FOUND OR revision.manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' OR NOT EXISTS (';
BEGIN
 definition:=pg_get_functiondef('app.validate_observable_distribution_manifest(uuid,uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected distribution validator'; END IF;
 definition:=replace(definition,' STABLE',' VOLATILE');
 EXECUTE replace(definition,anchor,' IF FOUND AND revision.manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' THEN
  RETURN app.validate_observable_referenced_distribution(p_org,p_project,p_source,p_revision,p_actor,p_manifest);
 END IF;
'||anchor);
END;
$$;

-- Lock the immutable decision against revocation while validating current
-- authority. Read revocation again after the Catalog/permission locks settle.
CREATE OR REPLACE FUNCTION app.observable_distribution_approval_current_for_org(p_org uuid,p_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE approval app.observable_input_distribution_approvals%ROWTYPE;
BEGIN
 SELECT * INTO approval FROM app.observable_input_distribution_approvals
  WHERE organization_id=p_org AND id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF approval.manifest->>'schemaVersion'='opengeo.observable-input-distribution-approval.2.0.0' THEN
  SELECT * INTO approval FROM app.observable_input_distribution_approvals
   WHERE organization_id=p_org AND id=p_id FOR SHARE;
  IF NOT app.validate_observable_distribution_manifest(approval.organization_id,approval.project_id,
    approval.source_project_id,approval.source_revision_id,approval.created_by,approval.manifest)
  THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.observable_distribution_approval_revocations revoked
   WHERE revoked.organization_id=p_org AND revoked.approval_id=p_id);
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM app.observable_distribution_approval_revocations revoked
   WHERE revoked.organization_id=p_org AND revoked.approval_id=p_id)
  AND app.validate_observable_distribution_manifest(approval.organization_id,approval.project_id,
    approval.source_project_id,approval.source_revision_id,approval.created_by,approval.manifest);
END;
$$;
ALTER FUNCTION app.observable_distribution_approval_is_current(uuid) VOLATILE;
ALTER FUNCTION app.observable_distribution_matches_build(uuid,uuid) VOLATILE;
DO $$
DECLARE definition text; anchor text:='WHERE approval.organization_id=NEW.organization_id AND approval.id=NEW.approval_id;';
BEGIN
 definition:=pg_get_functiondef('app.guard_observable_distribution_revocation()'::regprocedure);
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected distribution revocation guard'; END IF;
 EXECUTE replace(definition,anchor,'WHERE approval.organization_id=NEW.organization_id AND approval.id=NEW.approval_id FOR UPDATE;');
END;
$$;

CREATE OR REPLACE FUNCTION app.require_observable_distribution_request(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.observable_build_jobs%ROWTYPE; approval uuid; checksum text; manifest jsonb;
BEGIN
 SELECT * INTO job FROM app.observable_build_jobs WHERE id=p_job;
 IF NOT FOUND THEN RAISE EXCEPTION 'Build unavailable' USING ERRCODE='23514'; END IF;
 SELECT revision.manifest INTO manifest FROM app.observable_source_revisions revision
  WHERE revision.organization_id=job.organization_id AND revision.id=job.source_revision_id;
 IF manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0' THEN
  IF job.request ? 'artifactInputsChecksumSha256' OR
    (job.purpose='preview' AND (job.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.1.0.0','opengeo.observable-build-request.4.0.0')
      OR job.request->>'distributionApprovalId' IS NOT NULL OR job.request->>'distributionApprovalChecksumSha256' IS NOT NULL)) OR
    (job.purpose<>'preview' AND (job.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.3.0.0','opengeo.observable-build-request.4.0.0')
      OR job.request->>'distributionApprovalId' IS NULL OR job.request->>'distributionApprovalChecksumSha256' IS NULL))
  THEN RAISE EXCEPTION 'Exact referenced input distribution decision required' USING ERRCODE='23514'; END IF;
 END IF;
 IF job.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.3.0.0','opengeo.observable-build-request.4.0.0') THEN RETURN; END IF;
 approval:=(job.request->>'distributionApprovalId')::uuid;
 IF approval IS NULL THEN
  IF job.purpose<>'preview' AND NOT (job.request->>'schemaVersion'='opengeo.observable-build-request.4.0.0'
    AND job.request->>'outputRepresentation'='single-html' AND job.request->>'outputProfile'='default-32m'
    AND NOT job.request ? 'artifactInputsChecksumSha256'
    AND coalesce(jsonb_array_length(manifest->'dataAttachments'),0)=0
    AND coalesce(jsonb_array_length(manifest->'referencedFiles'),0)=0)
  THEN RAISE EXCEPTION 'Public input distribution approval required' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT manifest_checksum_sha256 INTO checksum FROM app.observable_input_distribution_approvals
   WHERE organization_id=job.organization_id AND id=approval;
  IF checksum IS DISTINCT FROM job.request->>'distributionApprovalChecksumSha256' OR NOT app.observable_distribution_matches_build(job.id,approval)
  THEN RAISE EXCEPTION 'Input distribution approval unavailable or changed' USING ERRCODE='23514'; END IF;
 END IF;
END;
$$;

DO $$
DECLARE definition text; anchor text; addition text;
BEGIN
 definition:=pg_get_functiondef('app.resolve_observable_build_data(uuid,uuid)'::regprocedure);
 anchor:=' IF manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' AND job.purpose<>''preview''';
 addition:=' PERFORM app.require_observable_distribution_request(job.id);';
 IF position(anchor IN definition)=0 OR position(addition IN definition)=0 THEN RAISE EXCEPTION 'Unexpected referenced resolver'; END IF;
 definition:=substring(definition FROM 1 FOR position(anchor IN definition)-1)||substring(definition FROM position(addition IN definition));
 EXECUTE definition;
 definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
 anchor:='  IF NEW.purpose<>''preview'' THEN';
 addition:='  PERFORM app.validate_observable_revision_input_bindings(NEW.organization_id,NEW.project_id,NEW.source_project_id,manifest);';
 IF position(anchor IN definition)=0 OR position(addition IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference staging'; END IF;
 definition:=substring(definition FROM 1 FOR position(anchor IN definition)-1)||'  IF NEW.request ? ''artifactInputsChecksumSha256'' OR
    (NEW.purpose=''preview'' AND (NEW.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.1.0.0'',''opengeo.observable-build-request.4.0.0'') OR NEW.request->>''distributionApprovalId'' IS NOT NULL)) OR
    (NEW.purpose<>''preview'' AND (NEW.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'') OR NEW.request->>''distributionApprovalId'' IS NULL))
  THEN RAISE EXCEPTION ''Exact referenced input distribution decision required'' USING ERRCODE=''23514''; END IF;
'||substring(definition FROM position(addition IN definition));
 EXECUTE definition;
 definition:=pg_get_functiondef('app.require_observable_review_distribution(uuid,uuid)'::regprocedure);
 anchor:=' IF manifest->>''schemaVersion''=''opengeo.observable-source-revision.3.0.0'' THEN
  RAISE EXCEPTION ''referenced file publication rights are not implemented'' USING ERRCODE=''23514'';
 END IF;
';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference review'; END IF;
 definition:=replace(definition,anchor,'');
 anchor:='IF coalesce(jsonb_array_length(manifest->''dataAttachments''),0)=0 AND';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected source-only review'; END IF;
 EXECUTE replace(definition,anchor,'IF coalesce(jsonb_array_length(manifest->''dataAttachments''),0)=0 AND coalesce(jsonb_array_length(manifest->''referencedFiles''),0)=0 AND');
 definition:=pg_get_functiondef('app.framework_publisher_authorized(uuid)'::regprocedure);
 anchor:='revision.manifest->>''schemaVersion''<>''opengeo.observable-source-revision.3.0.0'' AND';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reference publisher guard'; END IF;
 definition:=replace(definition,anchor,'');
 anchor:='coalesce(jsonb_array_length(revision.manifest->''dataAttachments''),0)=0 AND';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected source-only publisher'; END IF;
 EXECUTE replace(definition,anchor,'coalesce(jsonb_array_length(revision.manifest->''dataAttachments''),0)=0 AND coalesce(jsonb_array_length(revision.manifest->''referencedFiles''),0)=0 AND');
END;
$$;

COMMIT;
