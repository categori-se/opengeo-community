BEGIN;

-- Distribution decisions retain exact originals and do not change Catalog
-- visibility, source uploads, Project access or existing private-preview seals.
CREATE TABLE app.observable_input_distribution_approvals (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=262144),
  manifest_checksum_sha256 text NOT NULL CHECK (manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (id),
  FOREIGN KEY (organization_id,project_id,source_project_id)
    REFERENCES app.observable_source_projects(organization_id,project_id,id),
  FOREIGN KEY (organization_id,source_project_id,source_revision_id)
    REFERENCES app.observable_source_revisions(organization_id,source_project_id,id)
);
CREATE TABLE app.observable_distribution_approval_revocations (
  organization_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  revoked_by uuid NOT NULL REFERENCES app.users(id),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,approval_id),
  FOREIGN KEY (organization_id,approval_id)
    REFERENCES app.observable_input_distribution_approvals(organization_id,id)
);
CREATE TABLE app.observable_publication_input_approvals (
  review_id uuid PRIMARY KEY REFERENCES app.framework_publication_reviews(id),
  organization_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  FOREIGN KEY (organization_id,approval_id)
    REFERENCES app.observable_input_distribution_approvals(organization_id,id)
);
ALTER TABLE app.observable_input_distribution_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_input_distribution_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_distribution_approval_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_distribution_approval_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_publication_input_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_publication_input_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_distribution_tenant ON app.observable_input_distribution_approvals
 USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY observable_distribution_revocation_tenant ON app.observable_distribution_approval_revocations
 USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id());
CREATE POLICY observable_publication_inputs_tenant ON app.observable_publication_input_approvals
 USING (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.observable_input_distribution_approvals,app.observable_distribution_approval_revocations TO opengeo_runtime;
GRANT SELECT ON app.observable_publication_input_approvals TO opengeo_runtime;
REVOKE ALL ON app.observable_input_distribution_approvals,app.observable_distribution_approval_revocations,
 app.observable_publication_input_approvals FROM PUBLIC,opengeo_worker,opengeo_connector,opengeo_observable_coordinator,opengeo_framework_publisher;
CREATE TRIGGER observable_distribution_immutable BEFORE UPDATE OR DELETE
 ON app.observable_input_distribution_approvals FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_distribution_revocation_immutable BEFORE UPDATE OR DELETE
 ON app.observable_distribution_approval_revocations FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_publication_inputs_immutable BEFORE UPDATE OR DELETE
 ON app.observable_publication_input_approvals FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

CREATE FUNCTION app.observable_distribution_resource_authority(p_org uuid,p_resource uuid,p_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT EXISTS (
  SELECT 1 FROM app.governed_resources resource
  JOIN app.projects project ON project.organization_id=resource.organization_id AND project.id=resource.project_id AND project.status='active'
  JOIN app.organizations organization ON organization.id=resource.organization_id AND organization.status='active'
  JOIN app.organization_memberships member ON member.organization_id=resource.organization_id AND member.user_id=p_actor
  LEFT JOIN app.governed_resource_permissions permission ON permission.organization_id=resource.organization_id
    AND permission.resource_id=resource.id AND permission.user_id=p_actor
  WHERE resource.organization_id=p_org AND resource.id=p_resource AND resource.state<>'archived'
    AND (member.role='admin' OR app.background_project_role(p_org,resource.project_id,p_actor)::text='owner'
      OR permission.role::text IN ('manage','publish'))
 );
$$;

CREATE FUNCTION app.validate_observable_distribution_manifest(p_org uuid,p_project uuid,p_source uuid,p_revision uuid,p_actor uuid,p_manifest jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE revision app.observable_source_revisions%ROWTYPE; pin jsonb; rights jsonb; item jsonb;
 inputs jsonb; source jsonb; edition jsonb; definition jsonb; source_layer jsonb;
 dependency jsonb; source_count integer; prior_org text:=current_setting('app.organization_id',true);
 prior_user text:=current_setting('app.user_id',true);
BEGIN
 SELECT * INTO revision FROM app.observable_source_revisions
  WHERE organization_id=p_org AND project_id=p_project AND source_project_id=p_source AND id=p_revision;
 IF NOT FOUND OR NOT EXISTS (
   SELECT 1 FROM app.projects project JOIN app.organization_memberships member ON member.organization_id=project.organization_id
    AND member.user_id=p_actor JOIN app.organizations organization ON organization.id=project.organization_id AND organization.status='active'
   WHERE project.organization_id=p_org AND project.id=p_project AND project.status='active'
    AND (member.role='admin' OR app.background_project_role(p_org,p_project,p_actor)::text IN ('owner','editor')))
  OR p_manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-input-distribution-approval.1.0.0'
  OR p_manifest->>'organizationId' IS DISTINCT FROM p_org::text OR p_manifest->>'projectId' IS DISTINCT FROM p_project::text
  OR p_manifest->>'sourceProjectId' IS DISTINCT FROM p_source::text OR p_manifest->>'sourceRevisionId' IS DISTINCT FROM p_revision::text
  OR p_manifest->>'sourceManifestChecksumSha256' IS DISTINCT FROM revision.manifest_checksum_sha256
  OR p_manifest->>'compilerImageDigest' IS DISTINCT FROM app.observable_effective_compiler_digest(p_org,p_source)
  OR coalesce(p_manifest->>'outputProfile','') NOT IN ('default-32m','archive-96m')
  OR p_manifest-ARRAY['schemaVersion','organizationId','projectId','sourceProjectId','sourceRevisionId','sourceManifestChecksumSha256','compilerImageDigest','outputProfile','artifactInputsChecksumSha256','dataAttachments','archiveRights','artifacts']<>'{}'::jsonb
  OR NOT p_manifest ?& ARRAY['schemaVersion','organizationId','projectId','sourceProjectId','sourceRevisionId','sourceManifestChecksumSha256','compilerImageDigest','outputProfile','artifactInputsChecksumSha256','dataAttachments','archiveRights','artifacts']
  OR p_manifest->'dataAttachments' IS DISTINCT FROM coalesce(revision.manifest->'dataAttachments','[]'::jsonb)
  OR jsonb_typeof(p_manifest->'archiveRights') IS DISTINCT FROM 'array' OR jsonb_typeof(p_manifest->'artifacts') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_manifest->'archiveRights') IS DISTINCT FROM jsonb_array_length(p_manifest->'dataAttachments')
  OR jsonb_array_length(p_manifest->'artifacts')>32
  OR (p_manifest->>'outputProfile'='archive-96m' AND jsonb_array_length(p_manifest->'dataAttachments')=0)
 THEN RETURN false; END IF;
 -- Reuse exact archive validation under the stored approving actor. This is
 -- distinct from the independent RESOURCE_PUBLISH checks below.
 PERFORM set_config('app.organization_id',p_org::text,true);
 PERFORM set_config('app.user_id',p_actor::text,true);
 PERFORM app.validate_observable_revision_data_bindings(p_org,p_project,p_source,revision.manifest);
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);
 PERFORM set_config('app.user_id',coalesce(prior_user,''),true);
 FOR pin,rights IN SELECT data.value,terms.value FROM jsonb_array_elements(p_manifest->'dataAttachments') WITH ORDINALITY data(value,n)
  JOIN jsonb_array_elements(p_manifest->'archiveRights') WITH ORDINALITY terms(value,n) USING(n)
 LOOP
  IF rights-ARRAY['path','attachmentId','resourceId','resourceVersionId','license','attribution','acknowledgment']<>'{}'::jsonb
   OR rights->>'path' IS DISTINCT FROM pin->>'path' OR rights->>'attachmentId' IS DISTINCT FROM pin->>'attachmentId'
   OR rights->>'acknowledgment' IS DISTINCT FROM 'publish-exact-archive-file'
   OR coalesce(rights->>'license','') NOT IN ('CC0-1.0','CC-BY-4.0','PDDL-1.0') OR coalesce(char_length(trim(rights->>'attribution')),0) NOT BETWEEN 1 AND 2000
   OR NOT EXISTS (SELECT 1 FROM app.governed_resources resource WHERE resource.organization_id=p_org
     AND resource.id::text=rights->>'resourceId' AND resource.current_version_id::text=rights->>'resourceVersionId'
     AND resource.kind='dataset' AND resource.dataset_id::text=pin->>'datasetId' AND resource.state<>'archived')
   OR NOT app.observable_distribution_resource_authority(p_org,(rights->>'resourceId')::uuid,p_actor)
  THEN RETURN false; END IF;
 END LOOP;
 IF p_manifest->>'artifactInputsChecksumSha256' IS NOT NULL THEN
  SELECT manifest INTO inputs FROM app.publication_artifact_inputs WHERE organization_id=p_org AND source_project_id=p_source
   AND source_revision_id=p_revision AND manifest_checksum_sha256=p_manifest->>'artifactInputsChecksumSha256';
  IF inputs IS NULL OR jsonb_array_length(inputs->'artifacts') IS DISTINCT FROM jsonb_array_length(p_manifest->'artifacts') THEN RETURN false; END IF;
 ELSIF jsonb_array_length(p_manifest->'artifacts')<>0 THEN RETURN false; END IF;
 IF jsonb_array_length(p_manifest->'dataAttachments')+jsonb_array_length(p_manifest->'artifacts')=0 THEN RETURN false; END IF;
 FOR pin,item IN SELECT saved.value,approved.value FROM jsonb_array_elements(coalesce(inputs->'artifacts','[]'::jsonb)) WITH ORDINALITY saved(value,n)
   JOIN jsonb_array_elements(p_manifest->'artifacts') WITH ORDINALITY approved(value,n) USING(n)
 LOOP
  IF item-ARRAY['releaseId','resourceId','resourceVersionId','license','attribution','acknowledgment','sourceResources'] IS DISTINCT FROM pin
   OR item->>'acknowledgment' IS DISTINCT FROM 'publish-exact-map-artifact'
   OR NOT app.observable_distribution_resource_authority(p_org,(item->>'resourceId')::uuid,p_actor)
   OR NOT EXISTS(SELECT 1 FROM app.project_artifact_releases release JOIN app.project_artifacts artifact
      ON artifact.organization_id=release.organization_id AND artifact.id=release.artifact_id
     JOIN app.governed_resources resource ON resource.organization_id=artifact.organization_id AND resource.id=artifact.resource_id
     JOIN app.maps map ON map.organization_id=artifact.organization_id AND map.id=artifact.map_id
       AND map.project_id=resource.project_id AND resource.map_id=map.id AND map.status='active'
     WHERE release.organization_id=p_org AND release.id::text=item->>'releaseId' AND release.revoked_at IS NULL
      AND release.artifact_id::text=pin->>'artifactId' AND release.version_number=(pin->>'version')::integer
      AND release.license=item->>'license' AND release.attribution=item->>'attribution'
      AND resource.id::text=item->>'resourceId' AND resource.current_version_id::text=item->>'resourceVersionId'
      AND artifact.representation='portable-map-html')
   OR jsonb_typeof(item->'sourceResources') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'sourceResources')>128
  THEN RETURN false; END IF;
  SELECT version.manifest,history.definition INTO edition,definition FROM app.project_artifact_versions version
   JOIN app.project_artifacts artifact ON artifact.organization_id=version.organization_id AND artifact.id=version.artifact_id
   JOIN app.map_versions history ON history.organization_id=artifact.organization_id AND history.map_id=artifact.map_id AND history.version=version.origin_map_version
   WHERE version.organization_id=p_org AND version.artifact_id::text=pin->>'artifactId' AND version.version_number=(pin->>'version')::integer
    AND version.portable_object_id::text=pin->>'outputObjectId' AND version.manifest_checksum_sha256=pin->>'manifestChecksumSha256';
  IF edition IS NULL OR edition->'output' IS DISTINCT FROM pin->'output'
    OR jsonb_array_length(edition->'dependencies') IS DISTINCT FROM jsonb_array_length(item->'sourceResources') THEN RETURN false; END IF;
  source_count:=0;
  FOR dependency IN SELECT value FROM jsonb_array_elements(edition->'dependencies') LOOP
   SELECT layer INTO source_layer FROM jsonb_array_elements(definition->'layers') layer WHERE
    CASE WHEN layer->>'sourceType'='governed-dataset' THEN 'dataset_'||(layer->>'datasetId')||'_version_'||(layer->>'datasetVersionId')||'-source'
      ELSE (layer->>'layerId')||'-source' END=dependency->>'id' LIMIT 1;
   SELECT value INTO source FROM jsonb_array_elements(item->'sourceResources') WHERE value->>'datasetId'=source_layer->>'datasetId'
     AND value->>'sourceVersion'=source_layer->>'sourceVersion'
     AND value->>'datasetVersionId' IS NOT DISTINCT FROM source_layer->>'datasetVersionId';
   IF source_layer IS NULL OR source IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.governed_resources resource JOIN app.datasets dataset ON dataset.organization_id=resource.organization_id AND dataset.id=resource.dataset_id
     JOIN app.governed_resource_versions metadata ON metadata.organization_id=resource.organization_id AND metadata.resource_id=resource.id AND metadata.id=resource.current_version_id
     WHERE resource.organization_id=p_org AND resource.id::text=source->>'resourceId' AND resource.current_version_id::text=source->>'resourceVersionId'
       AND resource.dataset_id::text=source->>'datasetId' AND resource.kind='dataset' AND resource.state='published' AND resource.visibility='public'
       AND dataset.status='active' AND dataset.classification='public'
       AND char_length(trim(metadata.attribution))>0 AND char_length(trim(metadata.license))>0
       AND ((source->>'datasetVersionId' IS NOT NULL AND metadata.license IN ('CC0-1.0','CC-BY-4.0','PDDL-1.0') AND metadata.provenance->>'datasetVersionId'=source->>'datasetVersionId')
         OR (source->>'datasetVersionId' IS NULL AND metadata.provenance->>'externalSourceVersion'=source->>'sourceVersion' AND metadata.provenance->>'externalSourceUrl'=source_layer->>'sourceUrl')))
    OR ((source->>'datasetVersionId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.dataset_versions version
      WHERE version.organization_id=p_org AND version.dataset_id::text=source->>'datasetId' AND version.id::text=source->>'datasetVersionId'
       AND version.version_number=(source->>'sourceVersion')::bigint AND version.state='active'))
   THEN RETURN false; END IF;
   source_count:=source_count+1;
  END LOOP;
  IF source_count<>jsonb_array_length(item->'sourceResources') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation THEN
 RETURN false;
END;
$$;

CREATE FUNCTION app.observable_distribution_approval_current_for_org(p_org uuid,p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM app.observable_input_distribution_approvals approval WHERE approval.id=p_id AND approval.organization_id=p_org
  AND NOT EXISTS(SELECT 1 FROM app.observable_distribution_approval_revocations revoked
    WHERE revoked.organization_id=approval.organization_id AND revoked.approval_id=approval.id)
  AND app.validate_observable_distribution_manifest(approval.organization_id,approval.project_id,approval.source_project_id,
    approval.source_revision_id,approval.created_by,approval.manifest));
$$;
CREATE FUNCTION app.observable_distribution_approval_is_current(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT app.observable_distribution_approval_current_for_org(app.current_organization_id(),p_id);
$$;
CREATE FUNCTION app.guard_observable_distribution_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public SET row_security=off AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
  OR NOT app.validate_observable_distribution_manifest(NEW.organization_id,NEW.project_id,NEW.source_project_id,NEW.source_revision_id,NEW.created_by,NEW.manifest)
 THEN RAISE EXCEPTION 'Exact input distribution authority and rights required' USING ERRCODE='23514'; END IF;
 NEW.manifest_checksum_sha256:=encode(digest(convert_to(NEW.manifest::text,'UTF8'),'sha256'),'hex');
 RETURN NEW;
END;
$$;
CREATE TRIGGER observable_distribution_validate BEFORE INSERT ON app.observable_input_distribution_approvals
 FOR EACH ROW EXECUTE FUNCTION app.guard_observable_distribution_approval();
CREATE FUNCTION app.guard_observable_distribution_revocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE project_id uuid;
BEGIN
 SELECT approval.project_id INTO project_id FROM app.observable_input_distribution_approvals approval
 WHERE approval.organization_id=NEW.organization_id AND approval.id=NEW.approval_id;
 IF project_id IS NULL OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
   OR NEW.revoked_by IS DISTINCT FROM app.current_user_id() OR NOT EXISTS (
    SELECT 1 FROM app.organization_memberships member WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.revoked_by
      AND (member.role='admin' OR app.effective_project_role(project_id,member.user_id)::text IN ('owner','editor')))
 THEN RAISE EXCEPTION 'Input distribution revocation requires source management' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER observable_distribution_revoke_validate BEFORE INSERT ON app.observable_distribution_approval_revocations
 FOR EACH ROW EXECUTE FUNCTION app.guard_observable_distribution_revocation();

CREATE FUNCTION app.observable_distribution_matches_build(p_job uuid,p_approval uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM app.observable_build_jobs job JOIN app.observable_input_distribution_approvals approval
  ON approval.organization_id=job.organization_id AND approval.project_id=job.project_id
   AND approval.source_project_id=job.source_project_id AND approval.source_revision_id=job.source_revision_id
  WHERE job.id=p_job AND approval.id=p_approval AND app.observable_distribution_approval_current_for_org(job.organization_id,approval.id)
   AND approval.manifest->>'sourceManifestChecksumSha256'=job.request->>'sourceManifestChecksumSha256'
   AND approval.manifest->>'compilerImageDigest'=job.request->>'compilerImageDigest'
   AND approval.manifest->>'outputProfile'=coalesce(job.request->>'outputProfile','default-32m')
   AND approval.manifest->>'artifactInputsChecksumSha256' IS NOT DISTINCT FROM job.request->>'artifactInputsChecksumSha256');
$$;
CREATE FUNCTION app.require_observable_distribution_request(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.observable_build_jobs%ROWTYPE; approval uuid; checksum text;
BEGIN
 SELECT * INTO job FROM app.observable_build_jobs WHERE id=p_job;
 IF NOT FOUND THEN RAISE EXCEPTION 'Build unavailable' USING ERRCODE='23514'; END IF;
 IF job.request->>'schemaVersion'<>'opengeo.observable-build-request.3.0.0' THEN RETURN; END IF;
 approval:=(job.request->>'distributionApprovalId')::uuid;
 IF approval IS NULL THEN
  IF job.purpose<>'preview' THEN RAISE EXCEPTION 'Public input distribution approval required' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT manifest_checksum_sha256 INTO checksum FROM app.observable_input_distribution_approvals WHERE organization_id=job.organization_id AND id=approval;
  IF checksum IS DISTINCT FROM job.request->>'distributionApprovalChecksumSha256' OR NOT app.observable_distribution_matches_build(job.id,approval)
  THEN RAISE EXCEPTION 'Input distribution approval unavailable or changed' USING ERRCODE='23514'; END IF;
 END IF;
END;
$$;

-- Extend closed envelopes only for the explicit opt-in version. Legacy bytes
-- and all historical preview-only protections remain unchanged.
DO $$
DECLARE definition text; anchor text:='  IF v_project.id IS NULL'; addition text:=$body$
  IF NEW.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' THEN
    IF coalesce(NEW.request->>'outputProfile','') NOT IN ('default-32m','archive-96m')
      OR (NEW.request->>'outputProfile'='archive-96m' AND (
        NEW.request->>'sizeAcknowledgment' IS DISTINCT FROM 'allow-up-to-96-mib-output'
        OR coalesce(jsonb_array_length(v_revision.manifest->'dataAttachments'),0)=0))
      OR (NEW.request->>'outputProfile'='default-32m' AND NEW.request->>'sizeAcknowledgment' IS NOT NULL)
      OR ((NEW.request->>'distributionApprovalId') IS NULL) <> ((NEW.request->>'distributionApprovalChecksumSha256') IS NULL)
      OR (NEW.purpose<>'preview' AND NEW.request->>'distributionApprovalId' IS NULL)
    THEN RAISE EXCEPTION 'Explicit output consent and distribution decision required'; END IF;
    IF NEW.request->>'artifactInputsChecksumSha256' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM app.publication_artifact_inputs inputs WHERE inputs.organization_id=NEW.organization_id
       AND inputs.source_project_id=NEW.source_project_id AND inputs.source_revision_id=NEW.source_revision_id
       AND inputs.manifest_checksum_sha256=NEW.request->>'artifactInputsChecksumSha256')
    THEN RAISE EXCEPTION 'Exact Artifact input required'; END IF;
    IF NEW.request->>'distributionApprovalId' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM app.observable_input_distribution_approvals approval WHERE approval.organization_id=NEW.organization_id
       AND approval.project_id=NEW.project_id AND approval.source_project_id=NEW.source_project_id AND approval.source_revision_id=NEW.source_revision_id
       AND approval.id::text=NEW.request->>'distributionApprovalId' AND approval.manifest_checksum_sha256=NEW.request->>'distributionApprovalChecksumSha256'
       AND approval.manifest->>'compilerImageDigest'=NEW.request->>'compilerImageDigest'
       AND approval.manifest->>'outputProfile'=NEW.request->>'outputProfile'
       AND approval.manifest->>'artifactInputsChecksumSha256' IS NOT DISTINCT FROM NEW.request->>'artifactInputsChecksumSha256'
       -- Keep this insert trigger SECURITY INVOKER. Runtime may call only the
       -- tenant-bound wrapper; the explicit-organization owner helper stays private.
       AND app.observable_distribution_approval_is_current(approval.id))
    THEN RAISE EXCEPTION 'Exact current distribution approval required'; END IF;
    v_expected:=v_expected||jsonb_build_object('schemaVersion','opengeo.observable-build-request.3.0.0',
      'outputProfile',NEW.request->'outputProfile','sizeAcknowledgment',NEW.request->'sizeAcknowledgment',
      'distributionApprovalId',NEW.request->'distributionApprovalId','distributionApprovalChecksumSha256',NEW.request->'distributionApprovalChecksumSha256');
    IF NEW.request ? 'artifactInputsChecksumSha256' THEN
      v_expected:=v_expected||jsonb_build_object('artifactInputsChecksumSha256',NEW.request->'artifactInputsChecksumSha256');
    END IF;
  END IF;
$body$;
BEGIN
 definition:=pg_get_functiondef('app.enforce_observable_build_job_insert()'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected request validator'; END IF;
 EXECUTE replace(definition,anchor,addition||anchor);
END;
$$;

DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
 IF position('IF NEW.purpose <> ''preview'' THEN' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive staging guard'; END IF;
 EXECUTE replace(definition,'IF NEW.purpose <> ''preview'' THEN',
  'IF NEW.purpose <> ''preview'' AND NEW.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0'' THEN');
 definition:=pg_get_functiondef('app.resolve_observable_build_data(uuid,uuid)'::regprocedure);
 IF position('IF v_job.purpose <> ''preview'' THEN' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive resolver'; END IF;
 definition:=replace(definition,'IF v_job.purpose <> ''preview'' THEN',
  'PERFORM app.require_observable_distribution_request(v_job.id); IF v_job.purpose <> ''preview'' AND v_job.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0'' THEN');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.read_observable_artifact_lease(uuid,uuid)'::regprocedure);
 IF position('AND job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected Artifact lease'; END IF;
 definition:=replace(definition,'AND job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''',
  'AND ((job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0'') OR job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'')');
 definition:=replace(definition,'  RETURN v_result;','  PERFORM app.require_observable_distribution_request(p_job); RETURN v_result;');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.lock_observable_artifact_lease(uuid,uuid,uuid,uuid)'::regprocedure);
 IF position('AND job.lease_expires_at>clock_timestamp() AND job.purpose=''preview''' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected locked Artifact lease'; END IF;
 definition:=replace(definition,'AND job.lease_expires_at>clock_timestamp() AND job.purpose=''preview''
    AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''',
  'AND job.lease_expires_at>clock_timestamp() AND ((job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0'') OR job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'')');
 definition:=replace(definition,'  FOR SHARE OF job;',
  '    AND (job.request->>''distributionApprovalId'' IS NULL OR app.observable_distribution_matches_build(job.id,(job.request->>''distributionApprovalId'')::uuid)) FOR SHARE OF job;');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.require_publication_artifact_staging()'::regprocedure);
 EXECUTE replace(definition,'NEW.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0''',
  '(NEW.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0'' OR (NEW.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND NEW.request->>''artifactInputsChecksumSha256'' IS NOT NULL))');
END;
$$;

CREATE FUNCTION app.observable_exact_archive_output(p_manifest jsonb,p_file jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_manifest->'dataAttachments','[]'::jsonb)) pin
  WHERE pin->>'checksumSha256'=p_file->>'checksumSha256' AND pin->>'sizeBytes'=p_file->>'sizeBytes'
   AND lower(substring(pin->>'path' FROM '\.[^.\/]+$'))=lower(substring(p_file->>'path' FROM '\.[^.\/]+$'))
   AND (p_file->>'sizeBytes')::bigint BETWEEN 1 AND 67108864);
$$;
DO $$
DECLARE definition text; anchor text:='  IF p_result IS NULL'; addition text:=$body$
  IF v_job.request->>'schemaVersion'='opengeo.observable-build-request.3.0.0' THEN
    PERFORM app.require_observable_distribution_request(v_job.id);
    v_maximum_file_bytes:=33554432;
    IF v_job.request->>'artifactInputsChecksumSha256' IS NULL AND (
      p_result#>>'{validationReport,inputFileCount}' IS DISTINCT FROM
       (jsonb_array_length(v_manifest->'files')+coalesce(jsonb_array_length(v_manifest->'dataAttachments'),0))::text
      OR p_result#>>'{validationReport,inputBytes}' IS DISTINCT FROM
       (SELECT coalesce(sum((file->>'sizeBytes')::bigint),0) FROM jsonb_array_elements((v_manifest->'files')||coalesce(v_manifest->'dataAttachments','[]'::jsonb)) file)::text)
    THEN RAISE EXCEPTION 'Build result must cover all exact inputs'; END IF;
  END IF;
$body$;
BEGIN
 definition:=pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
 IF position('(v_file->>''sizeBytes'')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes' IN definition)=0
  OR position('v_total_bytes > 33554432' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected output bounds'; END IF;
 definition:=replace(definition,'IF v_job.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0'' THEN',
  'IF v_job.request->>''schemaVersion'' IN (''opengeo.observable-build-request.2.0.0'',''opengeo.observable-build-request.3.0.0'') AND v_job.request->>''artifactInputsChecksumSha256'' IS NOT NULL THEN');
 definition:=replace(definition,anchor,addition||anchor);
 definition:=replace(definition,'(v_file->>''sizeBytes'')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes',
  '((v_file->>''sizeBytes'')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes AND NOT (v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' AND app.observable_exact_archive_output(v_manifest,v_file)))');
 definition:=replace(definition,'v_total_bytes > 33554432',
  'v_total_bytes > (CASE WHEN v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296 ELSE 33554432 END)');
 definition:=replace(definition,'''application/octet-stream'', ''application/zip''
      )',
  '''application/octet-stream'', ''application/zip''
      ) AND NOT (v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND (v_file->>''contentType'') IN (''image/tiff'',''image/geotiff'') AND app.observable_exact_archive_output(v_manifest,v_file))');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure);
 IF position('''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id)' IN definition)=0
 THEN RAISE EXCEPTION 'Unexpected publication claim'; END IF;
 definition:=replace(definition,'''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id)',
  '''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id),
   ''build_request'', (SELECT request FROM app.observable_build_jobs WHERE id = r.build_job_id),
   ''source_manifest'', (SELECT revision.manifest FROM app.observable_build_jobs build JOIN app.observable_source_revisions revision ON revision.organization_id=build.organization_id AND revision.id=build.source_revision_id WHERE build.id=r.build_job_id),
   ''input_distribution'', (SELECT jsonb_build_object(''id'',approval.id,''manifest'',approval.manifest,''manifest_checksum_sha256'',approval.manifest_checksum_sha256) FROM app.observable_publication_input_approvals selected JOIN app.observable_input_distribution_approvals approval ON approval.organization_id=selected.organization_id AND approval.id=selected.approval_id WHERE selected.review_id=r.id)');
 EXECUTE definition;
END;
$$;

-- Consent can be attached to a successful private preview without recompiling
-- unchanged bytes. The specific approval is retained with the output review.
CREATE FUNCTION app.require_observable_review_distribution(p_job uuid,p_approval uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE manifest jsonb; request jsonb;
BEGIN
 SELECT revision.manifest,job.request INTO manifest,request FROM app.observable_build_jobs job
 JOIN app.observable_source_revisions revision ON revision.organization_id=job.organization_id AND revision.id=job.source_revision_id WHERE job.id=p_job;
 IF coalesce(jsonb_array_length(manifest->'dataAttachments'),0)=0 AND request->>'artifactInputsChecksumSha256' IS NULL THEN
  IF p_approval IS NOT NULL THEN RAISE EXCEPTION 'Unexpected input distribution approval' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF p_approval IS NULL OR NOT app.observable_distribution_matches_build(p_job,p_approval)
 THEN RAISE EXCEPTION 'Exact input distribution approval required for publication' USING ERRCODE='23514'; END IF;
 RETURN p_approval;
END;
$$;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('app.review_framework_publication(uuid,uuid,uuid,uuid,text)'::regprocedure);
 IF position('p_checksum text)' IN definition)=0 OR position('prior app.framework_publication_reviews%ROWTYPE;' IN definition)=0
  OR position('  RETURN p_id;' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected publication review'; END IF;
 definition:=replace(definition,'FUNCTION app.review_framework_publication(', 'FUNCTION app.review_framework_publication_with_inputs(');
 definition:=replace(definition,'p_checksum text)','p_checksum text, p_distribution_approval uuid)');
 definition:=replace(definition,'prior app.framework_publication_reviews%ROWTYPE;','prior app.framework_publication_reviews%ROWTYPE; input_approval uuid;');
 definition:=replace(definition,'  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);',
  '  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project); input_approval:=app.require_observable_review_distribution(p_build,p_distribution_approval);');
 definition:=replace(definition,'    RETURN prior.id;',
  '    IF (SELECT approval_id FROM app.observable_publication_input_approvals WHERE review_id=prior.id) IS DISTINCT FROM input_approval THEN RAISE EXCEPTION ''Input distribution review changed'' USING ERRCODE=''23514''; END IF; RETURN prior.id;');
 definition:=replace(definition,'  RETURN p_id;',
  '  IF input_approval IS NOT NULL THEN INSERT INTO app.observable_publication_input_approvals(review_id,organization_id,approval_id) VALUES(p_id,job.organization_id,input_approval); END IF; RETURN p_id;');
 EXECUTE definition;
END;
$$;
CREATE OR REPLACE FUNCTION app.review_framework_publication(p_id uuid,p_project uuid,p_build uuid,p_mount uuid,p_checksum text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT app.review_framework_publication_with_inputs(p_id,p_project,p_build,p_mount,p_checksum,NULL);
$$;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('app.approve_framework_publication(uuid,uuid,text)'::regprocedure);
 IF position('  IF EXISTS (SELECT 1 FROM app.framework_publication_approvals' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected publication approval'; END IF;
 definition:=replace(definition,'  IF EXISTS (SELECT 1 FROM app.framework_publication_approvals',
  '  PERFORM app.require_observable_review_distribution(review.build_job_id,(SELECT approval_id FROM app.observable_publication_input_approvals WHERE review_id=review.id)); IF EXISTS (SELECT 1 FROM app.framework_publication_approvals');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.framework_publisher_authorized(uuid)'::regprocedure);
 IF position('WHERE review.id = p_review AND origin.generation' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected publisher authorization'; END IF;
 definition:=replace(definition,'WHERE review.id = p_review AND origin.generation',
  'WHERE review.id = p_review AND (coalesce(jsonb_array_length(revision.manifest->''dataAttachments''),0)=0 AND build.request->>''artifactInputsChecksumSha256'' IS NULL OR app.observable_distribution_matches_build(build.id,(SELECT approval_id FROM app.observable_publication_input_approvals WHERE review_id=review.id))) AND origin.generation');
 EXECUTE definition;
END;
$$;

REVOKE ALL ON FUNCTION app.observable_distribution_resource_authority(uuid,uuid,uuid),
 app.observable_distribution_approval_current_for_org(uuid,uuid),
 app.validate_observable_distribution_manifest(uuid,uuid,uuid,uuid,uuid,jsonb),
 app.observable_distribution_approval_is_current(uuid),app.guard_observable_distribution_approval(),
 app.guard_observable_distribution_revocation(),app.observable_distribution_matches_build(uuid,uuid),
 app.require_observable_distribution_request(uuid),app.observable_exact_archive_output(jsonb,jsonb),
 app.require_observable_review_distribution(uuid,uuid),app.review_framework_publication_with_inputs(uuid,uuid,uuid,uuid,text,uuid)
 FROM PUBLIC,opengeo_worker,opengeo_connector;
GRANT EXECUTE ON FUNCTION app.observable_distribution_approval_is_current(uuid),
 app.observable_exact_archive_output(jsonb,jsonb),app.review_framework_publication_with_inputs(uuid,uuid,uuid,uuid,text,uuid)
 TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.require_observable_distribution_request(uuid) TO opengeo_observable_coordinator;

COMMIT;
