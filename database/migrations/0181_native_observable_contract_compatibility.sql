BEGIN;

-- Forward repair for the recorded sparse production history through 0180.
-- Do not backfill 0162/0163 receipts or replace the 0178 TIFF helper.
-- Adopted source SHA256: 0162 8bbab31b26b6f84265408e761920ee363610a88347ac6206c8ecd133a28cf482
-- Adopted source SHA256: 0163 09bacc1f64cd4a4f265c4093edfe16a1e8f5d6eeadebf7154acb3ebc7de35a3d
DO $native_compatibility$
DECLARE
  readiness_sql text := $readiness$SELECT check_name, object_present, marker_or_signature_matches
FROM (
SELECT 'table:' || item.name AS check_name,
pg_catalog.to_regclass(item.name) IS NOT NULL AS object_present,
pg_catalog.to_regclass(item.name) IS NOT NULL AS marker_or_signature_matches
FROM (VALUES
('app.observable_input_distribution_approvals'),
('app.observable_distribution_approval_revocations'),
('app.observable_publication_input_approvals')
) AS item(name)
UNION ALL
SELECT 'function:' || item.signature,
proc.oid IS NOT NULL,
COALESCE(pg_catalog.pg_get_function_result(proc.oid) = item.expected_result, false)
FROM (VALUES
('app.observable_distribution_matches_build(uuid,uuid)', 'boolean'),
('app.observable_distribution_approval_is_current(uuid)', 'boolean'),
('app.require_observable_distribution_request(uuid)', 'void'),
('app.require_observable_review_distribution(uuid,uuid)', 'uuid'),
('app.review_framework_publication_with_inputs(uuid,uuid,uuid,uuid,text,uuid)', 'uuid'),
('app.review_framework_publication(uuid,uuid,uuid,uuid,text)', 'uuid'),
('app.observable_localized_result_is_valid(jsonb,jsonb,jsonb)', 'boolean'),
('app.enforce_observable_build_job_insert()', 'trigger'),
('app.require_observable_staging_manifest_support()', 'trigger'),
('app.resolve_observable_build_data(uuid,uuid)', 'jsonb'),
('app.complete_observable_build(uuid,uuid,jsonb)', 'boolean'),
('app.claim_framework_publication(uuid,uuid)', 'jsonb'),
('app.authorize_framework_publication(uuid,uuid)', 'boolean'),
('app.framework_publisher_authorized(uuid)', 'boolean')
) AS item(signature, expected_result)
LEFT JOIN pg_catalog.pg_proc AS proc
ON proc.oid = pg_catalog.to_regprocedure(item.signature)
UNION ALL
SELECT 'marker:' || item.label,
proc.oid IS NOT NULL,
COALESCE(pg_catalog.strpos(proc.prosrc, item.needle) > 0, false)
FROM (VALUES
('distribution-request-v4', 'app.require_observable_distribution_request(uuid)', 'opengeo.observable-build-request.4.0.0'),
('insert-request-v4', 'app.enforce_observable_build_job_insert()', 'opengeo.observable-build-request.4.0.0'),
('staging-request-v4', 'app.require_observable_staging_manifest_support()', 'opengeo.observable-build-request.4.0.0'),
('resolver-request-v4', 'app.resolve_observable_build_data(uuid,uuid)', 'opengeo.observable-build-request.4.0.0'),
('localized-result-v2', 'app.observable_localized_result_is_valid(jsonb,jsonb,jsonb)', 'opengeo.observable-build-result.2.0.0'),
('completion-localized-validator', 'app.complete_observable_build(uuid,uuid,jsonb)', 'observable_localized_result_is_valid'),
('completion-request-v4', 'app.complete_observable_build(uuid,uuid,jsonb)', 'opengeo.observable-build-request.4.0.0'),
('publisher-previous-release-plan', 'app.claim_framework_publication(uuid,uuid)', 'previous_release_plan'),
('publisher-current-distribution', 'app.framework_publisher_authorized(uuid)', 'observable_distribution_matches_build'),
('publisher-authorize-wrapper-chain', 'app.authorize_framework_publication(uuid,uuid)', 'framework_publisher_authorized'),
('review-input-wrapper', 'app.review_framework_publication(uuid,uuid,uuid,uuid,text)', 'review_framework_publication_with_inputs')
) AS item(label, signature, needle)
LEFT JOIN pg_catalog.pg_proc AS proc
ON proc.oid = pg_catalog.to_regprocedure(item.signature)
) AS diagnostics
ORDER BY check_name$readiness$;
  readiness record;
  all_ready boolean := true;
  core_functions text[] := ARRAY['app.approve_framework_publication(uuid,uuid,text)','app.claim_framework_publication(uuid,uuid)','app.complete_observable_build(uuid,uuid,jsonb)','app.enforce_observable_build_job_insert()','app.framework_publisher_authorized(uuid)','app.lock_observable_artifact_lease(uuid,uuid,uuid,uuid)','app.observable_exact_archive_output(jsonb,jsonb)','app.read_observable_artifact_lease(uuid,uuid)','app.require_observable_staging_manifest_support()','app.require_publication_artifact_staging()','app.resolve_observable_build_data(uuid,uuid)','app.review_framework_publication(uuid,uuid,uuid,uuid,text)'];
  signature text;
  before_security jsonb;
  after_security jsonb;
  before_helper text;
  preview_guard text := $guard$v_job.request->>'schemaVersion'='opengeo.observable-build-request.1.0.0' AND v_job.purpose='preview' AND v_manifest->>'schemaVersion'='opengeo.observable-source-revision.2.0.0' AND (v_file->>'contentType') IN ('image/tiff','image/geotiff') AND app.observable_exact_archive_output(v_manifest,v_file)$guard$;
BEGIN
  FOR readiness IN EXECUTE readiness_sql LOOP
    all_ready := all_ready AND readiness.object_present AND readiness.marker_or_signature_matches;
  END LOOP;
  -- A normal fully upgraded chain already supplies these contracts, including
  -- later referenced-file guards. Never replace those newer implementations.
  IF all_ready THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[
    'app.observable_input_distribution_approvals',
    'app.observable_distribution_approval_revocations',
    'app.observable_publication_input_approvals']) names(name)
    WHERE pg_catalog.to_regclass(name) IS NOT NULL)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['app.observable_distribution_resource_authority(uuid,uuid,uuid)','app.validate_observable_distribution_manifest(uuid,uuid,uuid,uuid,uuid,jsonb)','app.observable_distribution_approval_current_for_org(uuid,uuid)','app.observable_distribution_approval_is_current(uuid)','app.guard_observable_distribution_approval()','app.guard_observable_distribution_revocation()','app.observable_distribution_matches_build(uuid,uuid)','app.require_observable_distribution_request(uuid)','app.require_observable_review_distribution(uuid,uuid)','app.review_framework_publication_with_inputs(uuid,uuid,uuid,uuid,text,uuid)','app.observable_localized_result_is_valid(jsonb,jsonb,jsonb)']) names(name)
      WHERE pg_catalog.to_regprocedure(name) IS NOT NULL)
  THEN RAISE EXCEPTION 'Partial native Observable contract; reconcile before migration'; END IF;
  FOREACH signature IN ARRAY core_functions LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Missing native Observable prerequisite: %', signature;
    END IF;
  END LOOP;
  SELECT pg_catalog.pg_get_functiondef('app.observable_exact_archive_output(jsonb,jsonb)'::regprocedure)
    INTO before_helper;
  IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc
      WHERE oid='app.observable_exact_archive_output(jsonb,jsonb)'::regprocedure)
      <> '3989c923b673041eab39a735cc1198b8'
    OR pg_catalog.strpos(pg_catalog.pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure),preview_guard)=0
  THEN RAISE EXCEPTION 'Unexpected retained 0178 TIFF contract'; END IF;
  SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile)) FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT pg_catalog.to_regprocedure(name) FROM unnest(core_functions) names(name)) INTO before_security;
  IF pg_catalog.to_regprocedure('pg_temp.opengeo_native_replace_once(text,text,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'Unexpected native migration temporary helper'; END IF;
  EXECUTE $helper_create$
    CREATE FUNCTION pg_temp.opengeo_native_replace_once(p_source text,p_old text,p_new text)
    RETURNS text LANGUAGE plpgsql AS $replace_once$
    BEGIN
      IF p_old IS NULL OR p_old='' OR p_source IS NULL OR
        (length(p_source)-length(pg_catalog.replace(p_source,p_old,'')))/length(p_old)<>1
      THEN RAISE EXCEPTION 'Unexpected native Observable replacement anchor'; END IF;
      RETURN pg_catalog.replace(p_source,p_old,p_new);
    END;
    $replace_once$;
  $helper_create$;
  EXECUTE $install_distribution$CREATE TABLE app.observable_input_distribution_approvals (
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
 IF (length(definition)-length(pg_temp.opengeo_native_replace_once(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected request validator'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,anchor,addition||anchor);
END;
$$;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
 IF position('IF NEW.purpose <> ''preview'' THEN' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive staging guard'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,'IF NEW.purpose <> ''preview'' THEN',
  'IF NEW.purpose <> ''preview'' AND NEW.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0'' THEN');
 definition:=pg_get_functiondef('app.resolve_observable_build_data(uuid,uuid)'::regprocedure);
 IF position('IF v_job.purpose <> ''preview'' THEN' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive resolver'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,'IF v_job.purpose <> ''preview'' THEN',
  'PERFORM app.require_observable_distribution_request(v_job.id); IF v_job.purpose <> ''preview'' AND v_job.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0'' THEN');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.read_observable_artifact_lease(uuid,uuid)'::regprocedure);
 IF position('AND job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected Artifact lease'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,'AND job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''',
  'AND ((job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0'') OR job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'')');
 definition:=pg_temp.opengeo_native_replace_once(definition,'  RETURN v_result;','  PERFORM app.require_observable_distribution_request(p_job); RETURN v_result;');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.lock_observable_artifact_lease(uuid,uuid,uuid,uuid)'::regprocedure);
 IF position('AND job.lease_expires_at>clock_timestamp() AND job.purpose=''preview''' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected locked Artifact lease'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,'AND job.lease_expires_at>clock_timestamp() AND job.purpose=''preview''
    AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0''',
  'AND job.lease_expires_at>clock_timestamp() AND ((job.purpose=''preview'' AND job.request->>''schemaVersion''=''opengeo.observable-build-request.2.0.0'') OR job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'')');
 definition:=pg_temp.opengeo_native_replace_once(definition,'  FOR SHARE OF job;',
  '    AND (job.request->>''distributionApprovalId'' IS NULL OR app.observable_distribution_matches_build(job.id,(job.request->>''distributionApprovalId'')::uuid)) FOR SHARE OF job;');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.require_publication_artifact_staging()'::regprocedure);
 EXECUTE pg_temp.opengeo_native_replace_once(definition,'NEW.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0''',
  '(NEW.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0'' OR (NEW.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND NEW.request->>''artifactInputsChecksumSha256'' IS NOT NULL))');
END;
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
 definition:=pg_temp.opengeo_native_replace_once(definition,'IF v_job.request->>''schemaVersion'' = ''opengeo.observable-build-request.2.0.0'' THEN',
  'IF v_job.request->>''schemaVersion'' IN (''opengeo.observable-build-request.2.0.0'',''opengeo.observable-build-request.3.0.0'') AND v_job.request->>''artifactInputsChecksumSha256'' IS NOT NULL THEN');
 definition:=pg_temp.opengeo_native_replace_once(definition,anchor,addition||anchor);
 definition:=pg_temp.opengeo_native_replace_once(definition,'(v_file->>''sizeBytes'')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes',
  '((v_file->>''sizeBytes'')::bigint NOT BETWEEN 1 AND v_maximum_file_bytes AND NOT (v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' AND app.observable_exact_archive_output(v_manifest,v_file)))');
 definition:=pg_temp.opengeo_native_replace_once(definition,'v_total_bytes > 33554432',
  'v_total_bytes > (CASE WHEN v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296 ELSE 33554432 END)');
 definition:=pg_temp.opengeo_native_replace_once(definition,'''application/octet-stream'', ''application/zip''
      )',
  '''application/octet-stream'', ''application/zip''
      ) AND NOT (v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND (v_file->>''contentType'') IN (''image/tiff'',''image/geotiff'') AND app.observable_exact_archive_output(v_manifest,v_file))');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure);
 IF position('''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id)' IN definition)=0
 THEN RAISE EXCEPTION 'Unexpected publication claim'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,'''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id)',
  '''build_result'', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id),
   ''build_request'', (SELECT request FROM app.observable_build_jobs WHERE id = r.build_job_id),
   ''source_manifest'', (SELECT revision.manifest FROM app.observable_build_jobs build JOIN app.observable_source_revisions revision ON revision.organization_id=build.organization_id AND revision.id=build.source_revision_id WHERE build.id=r.build_job_id),
   ''input_distribution'', (SELECT jsonb_build_object(''id'',approval.id,''manifest'',approval.manifest,''manifest_checksum_sha256'',approval.manifest_checksum_sha256) FROM app.observable_publication_input_approvals selected JOIN app.observable_input_distribution_approvals approval ON approval.organization_id=selected.organization_id AND approval.id=selected.approval_id WHERE selected.review_id=r.id)');
 EXECUTE definition;
END;
$$;
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
 definition:=pg_temp.opengeo_native_replace_once(definition,'FUNCTION app.review_framework_publication(', 'FUNCTION app.review_framework_publication_with_inputs(');
 definition:=pg_temp.opengeo_native_replace_once(definition,'p_checksum text)','p_checksum text, p_distribution_approval uuid)');
 definition:=pg_temp.opengeo_native_replace_once(definition,'prior app.framework_publication_reviews%ROWTYPE;','prior app.framework_publication_reviews%ROWTYPE; input_approval uuid;');
 definition:=pg_temp.opengeo_native_replace_once(definition,'  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);',
  '  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project); input_approval:=app.require_observable_review_distribution(p_build,p_distribution_approval);');
 definition:=pg_temp.opengeo_native_replace_once(definition,'    RETURN prior.id;',
  '    IF (SELECT approval_id FROM app.observable_publication_input_approvals WHERE review_id=prior.id) IS DISTINCT FROM input_approval THEN RAISE EXCEPTION ''Input distribution review changed'' USING ERRCODE=''23514''; END IF; RETURN prior.id;');
 definition:=pg_temp.opengeo_native_replace_once(definition,'  RETURN p_id;',
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
 definition:=pg_temp.opengeo_native_replace_once(definition,'  IF EXISTS (SELECT 1 FROM app.framework_publication_approvals',
  '  PERFORM app.require_observable_review_distribution(review.build_job_id,(SELECT approval_id FROM app.observable_publication_input_approvals WHERE review_id=review.id)); IF EXISTS (SELECT 1 FROM app.framework_publication_approvals');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.framework_publisher_authorized(uuid)'::regprocedure);
 IF position('WHERE review.id = p_review AND origin.generation' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected publisher authorization'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,'WHERE review.id = p_review AND origin.generation',
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
GRANT EXECUTE ON FUNCTION app.require_observable_distribution_request(uuid) TO opengeo_observable_coordinator;$install_distribution$;
  EXECUTE $install_localized$CREATE OR REPLACE FUNCTION app.require_observable_distribution_request(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.observable_build_jobs%ROWTYPE; approval uuid; checksum text; manifest jsonb;
BEGIN
 SELECT * INTO job FROM app.observable_build_jobs WHERE id=p_job;
 IF NOT FOUND THEN RAISE EXCEPTION 'Build unavailable' USING ERRCODE='23514'; END IF;
 IF job.request->>'schemaVersion' NOT IN ('opengeo.observable-build-request.3.0.0','opengeo.observable-build-request.4.0.0') THEN RETURN; END IF;
 approval:=(job.request->>'distributionApprovalId')::uuid;
 IF approval IS NULL THEN
  SELECT revision.manifest INTO manifest FROM app.observable_source_revisions revision
   WHERE revision.organization_id=job.organization_id AND revision.id=job.source_revision_id;
  IF job.purpose<>'preview' AND NOT (
    job.request->>'schemaVersion'='opengeo.observable-build-request.4.0.0'
    AND job.request->>'outputRepresentation'='single-html'
    AND job.request->>'outputProfile'='default-32m'
    AND NOT job.request ? 'artifactInputsChecksumSha256'
    AND coalesce(jsonb_array_length(manifest->'dataAttachments'),0)=0)
  THEN RAISE EXCEPTION 'Public input distribution approval required' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT manifest_checksum_sha256 INTO checksum FROM app.observable_input_distribution_approvals
   WHERE organization_id=job.organization_id AND id=approval;
  IF checksum IS DISTINCT FROM job.request->>'distributionApprovalChecksumSha256'
    OR NOT app.observable_distribution_matches_build(job.id,approval)
  THEN RAISE EXCEPTION 'Input distribution approval unavailable or changed' USING ERRCODE='23514'; END IF;
 END IF;
END;
$$;
DO $$
DECLARE definition text; anchor text:='  IF v_project.id IS NULL'; addition text:=$body$
  IF NEW.request->>'schemaVersion'='opengeo.observable-build-request.4.0.0' THEN
    IF NEW.request->>'outputRepresentation' IS DISTINCT FROM 'single-html'
      OR v_revision.entry_path NOT IN ('index.md','src/index.md')
      OR NEW.request ? 'artifactInputsChecksumSha256'
      OR coalesce(NEW.request->>'outputProfile','') NOT IN ('default-32m','archive-96m')
      OR (NEW.request->>'outputProfile'='archive-96m' AND (
        NEW.request->>'sizeAcknowledgment' IS DISTINCT FROM 'allow-up-to-96-mib-output'
        OR coalesce(jsonb_array_length(v_revision.manifest->'dataAttachments'),0)=0))
      OR (NEW.request->>'outputProfile'='default-32m' AND NEW.request->>'sizeAcknowledgment' IS NOT NULL)
      OR ((NEW.request->>'distributionApprovalId') IS NULL) <> ((NEW.request->>'distributionApprovalChecksumSha256') IS NULL)
      OR (NEW.purpose<>'preview' AND coalesce(jsonb_array_length(v_revision.manifest->'dataAttachments'),0)>0
        AND NEW.request->>'distributionApprovalId' IS NULL)
    THEN RAISE EXCEPTION 'Explicit localized output consent and distribution decision required' USING ERRCODE='23514'; END IF;
    IF NEW.request->>'distributionApprovalId' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM app.observable_input_distribution_approvals approval WHERE approval.organization_id=NEW.organization_id
       AND approval.project_id=NEW.project_id AND approval.source_project_id=NEW.source_project_id AND approval.source_revision_id=NEW.source_revision_id
       AND approval.id::text=NEW.request->>'distributionApprovalId' AND approval.manifest_checksum_sha256=NEW.request->>'distributionApprovalChecksumSha256'
       AND approval.manifest->>'compilerImageDigest'=NEW.request->>'compilerImageDigest'
       AND approval.manifest->>'outputProfile'=NEW.request->>'outputProfile'
       AND approval.manifest->>'artifactInputsChecksumSha256' IS NULL
       AND app.observable_distribution_approval_is_current(approval.id))
    THEN RAISE EXCEPTION 'Exact current distribution approval required' USING ERRCODE='23514'; END IF;
    v_expected:=v_expected||jsonb_build_object('schemaVersion','opengeo.observable-build-request.4.0.0',
      'outputRepresentation','single-html','outputProfile',NEW.request->'outputProfile',
      'sizeAcknowledgment',NEW.request->'sizeAcknowledgment','distributionApprovalId',NEW.request->'distributionApprovalId',
      'distributionApprovalChecksumSha256',NEW.request->'distributionApprovalChecksumSha256');
  END IF;
$body$;
BEGIN
 definition:=pg_get_functiondef('app.enforce_observable_build_job_insert()'::regprocedure);
 IF (length(definition)-length(pg_temp.opengeo_native_replace_once(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected request validator'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,anchor,addition||anchor);
 definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
 anchor:='NEW.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0''';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive staging guard'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,anchor,'NEW.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'')');
 definition:=pg_get_functiondef('app.resolve_observable_build_data(uuid,uuid)'::regprocedure);
 anchor:='v_job.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0''';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive resolver'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,anchor,'v_job.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'')');
END;
$$;
CREATE FUNCTION app.observable_localized_result_is_valid(p_result jsonb,p_request jsonb,p_source jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,app,public AS $$
DECLARE envelope jsonb:=p_result->'localizedOutput'; manifest jsonb; output jsonb; file jsonb; asset jsonb;
 pins jsonb:=coalesce(p_source->'dataAttachments','[]'::jsonb); expected_paths jsonb; inventory jsonb:='{}';
 seen text[]:=ARRAY[]::text[]; lazy text[]:=ARRAY[]::text[]; total bigint:=0; asset_total bigint:=0; cap bigint:=33554432; n integer:=0;
BEGIN
 IF p_result IS NULL OR p_request->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-build-request.4.0.0'
  OR p_request->>'outputRepresentation' IS DISTINCT FROM 'single-html'
  OR p_result->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-build-result.2.0.0'
  OR p_result->>'outputRepresentation' IS DISTINCT FROM 'single-html'
  OR p_result-ARRAY['schemaVersion','outputRepresentation','localizedOutput','buildJobId','requestChecksumSha256','compilerImageDigest','inputManifestChecksumSha256','outputPrefix','outputTreeChecksumSha256','sandbox','networkRequests','validationReport','routeManifest','outputManifest']<>'{}'
  OR NOT p_result ?& ARRAY['schemaVersion','outputRepresentation','localizedOutput','buildJobId','requestChecksumSha256','compilerImageDigest','inputManifestChecksumSha256','outputPrefix','outputTreeChecksumSha256','sandbox','networkRequests','validationReport','routeManifest','outputManifest']
  OR coalesce(p_result->>'buildJobId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR coalesce(p_result->>'requestChecksumSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(p_result->>'inputManifestChecksumSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(p_result->>'outputTreeChecksumSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(p_result->>'compilerImageDigest','') !~ '^sha256:[0-9a-f]{64}$'
  OR coalesce(length(p_result->>'outputPrefix'),0) NOT BETWEEN 1 AND 2048
  OR jsonb_typeof(envelope) IS DISTINCT FROM 'object' OR octet_length(envelope::text)>262144
  OR envelope-ARRAY['manifest','manifestChecksumSha256']<>'{}' OR NOT envelope ?& ARRAY['manifest','manifestChecksumSha256']
  OR envelope->>'manifestChecksumSha256' IS DISTINCT FROM encode(digest(convert_to((envelope->'manifest')::text,'UTF8'),'sha256'),'hex')
  OR p_result->'routeManifest' IS DISTINCT FROM '[{"path":"/","file":"dist/index.html"}]'::jsonb
  OR jsonb_typeof(p_result#>'{outputManifest,files}') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_result#>'{outputManifest,files}')<>1
  OR (p_result->'outputManifest')-'files'<>'{}'
 THEN RETURN false; END IF;
 IF p_request->>'outputProfile'='archive-96m' THEN
  IF p_request->>'sizeAcknowledgment' IS DISTINCT FROM 'allow-up-to-96-mib-output' OR jsonb_array_length(pins)=0 THEN RETURN false; END IF;
  cap:=100663296;
 ELSIF p_request->>'outputProfile' IS DISTINCT FROM 'default-32m' OR p_request->>'sizeAcknowledgment' IS NOT NULL THEN RETURN false;
 ELSE
  cap:=(p_request#>>'{resourceLimits,maxOutputBytes}')::bigint;
  IF cap NOT BETWEEN 1 AND 33554432 THEN RETURN false; END IF;
 END IF;
 output:=p_result#>'{outputManifest,files,0}'; manifest:=envelope->'manifest';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object'
  OR manifest-ARRAY['schemaVersion','entryPath','inputFiles','assets','outputBytes','unsupportedLazyImports','fontFallback','publicationAuthorized','sourceOutputTreeChecksumSha256','output']<>'{}'
  OR NOT manifest ?& ARRAY['schemaVersion','entryPath','inputFiles','assets','outputBytes','unsupportedLazyImports','fontFallback','publicationAuthorized','sourceOutputTreeChecksumSha256','output']
  OR manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.framework-localized-output.1.0.0'
  OR manifest->>'entryPath' IS DISTINCT FROM 'dist/index.html' OR manifest->'publicationAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR (manifest->'fontFallback' IS DISTINCT FROM 'null'::jsonb AND manifest->>'fontFallback' IS DISTINCT FROM 'system-fonts')
  OR coalesce(manifest->>'sourceOutputTreeChecksumSha256','') !~ '^[0-9a-f]{64}$'
  OR output->>'path' IS DISTINCT FROM 'dist/index.html' OR output->>'contentType' IS DISTINCT FROM 'text/html'
  OR output-ARRAY['path','bucket','objectKey','s3VersionId','etag','contentType','sizeBytes','checksumSha256']<>'{}'
  OR NOT output ?& ARRAY['path','bucket','objectKey','s3VersionId','etag','contentType','sizeBytes','checksumSha256']
  OR coalesce(output->>'checksumSha256','') !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(output->'sizeBytes') IS DISTINCT FROM 'number' OR coalesce(output->>'sizeBytes','') !~ '^[0-9]{1,9}$'
  OR coalesce(length(output->>'bucket'),0) NOT BETWEEN 3 AND 255
  OR coalesce(length(output->>'objectKey'),0) NOT BETWEEN 1 AND 2048
  OR coalesce(length(output->>'s3VersionId'),0) NOT BETWEEN 1 AND 1024 OR output->>'s3VersionId'='null'
  OR coalesce(length(output->>'etag'),0) NOT BETWEEN 1 AND 512
  OR output->'sizeBytes' IS DISTINCT FROM manifest->'outputBytes'
  OR (output->>'sizeBytes')::bigint NOT BETWEEN 1 AND cap
  OR jsonb_typeof(manifest->'inputFiles') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'inputFiles') NOT BETWEEN 1 AND (p_request#>>'{resourceLimits,maxOutputFiles}')::integer
  OR jsonb_typeof(manifest->'assets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'assets')>jsonb_array_length(manifest->'inputFiles')
  OR jsonb_typeof(manifest->'unsupportedLazyImports') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'unsupportedLazyImports')>512
  OR manifest->'output' IS DISTINCT FROM (output-ARRAY['bucket','objectKey','s3VersionId','etag'])
  OR (manifest->'output')-ARRAY['path','contentType','sizeBytes','checksumSha256']<>'{}'
  OR p_result#>'{validationReport,publicationAuthorized}' IS DISTINCT FROM 'false'::jsonb
  OR p_result#>'{validationReport,inputObjectsReverified}' IS DISTINCT FROM 'true'::jsonb
  OR p_result#>'{validationReport,outputBytesReverified}' IS DISTINCT FROM 'true'::jsonb
  OR p_result#>'{validationReport,outputObjectsReverified}' IS DISTINCT FROM 'true'::jsonb
  OR p_result#>>'{validationReport,outputFileCount}' IS DISTINCT FROM '1'
  OR p_result#>'{validationReport,outputBytes}' IS DISTINCT FROM output->'sizeBytes'
  OR p_result->>'outputTreeChecksumSha256' IS DISTINCT FROM encode(digest(convert_to(
    '[{"path":"dist/index.html","contentType":"text/html","sizeBytes":'||(output->>'sizeBytes')||
    ',"checksumSha256":"'||(output->>'checksumSha256')||'"}]','UTF8'),'sha256'),'hex')
 THEN RETURN false; END IF;
 FOR file IN SELECT value FROM jsonb_array_elements(manifest->'inputFiles') LOOP
  IF jsonb_typeof(file) IS DISTINCT FROM 'object' OR file-ARRAY['path','contentType','sizeBytes','checksumSha256']<>'{}'
   OR NOT file ?& ARRAY['path','contentType','sizeBytes','checksumSha256'] OR NOT app.observable_output_path_is_safe(file->>'path')
   OR inventory ? lower(file->>'path') OR coalesce(file->>'checksumSha256','') !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(file->'sizeBytes') IS DISTINCT FROM 'number' OR coalesce(file->>'sizeBytes','') !~ '^[0-9]{1,9}$'
   OR (file->>'sizeBytes')::bigint NOT BETWEEN 1 AND least(cap,
     CASE WHEN cap=100663296 AND app.observable_exact_archive_output(p_source,file) THEN 67108864 ELSE 33554432 END)
   OR coalesce(file->>'contentType','') NOT IN ('text/html','text/css','text/javascript','application/json','text/plain','text/csv','application/geo+json','image/svg+xml','image/png','image/jpeg','application/octet-stream','application/zip','image/tiff','image/geotiff')
  THEN RETURN false; END IF;
  inventory:=inventory||jsonb_build_object(lower(file->>'path'),file); total:=total+(file->>'sizeBytes')::bigint;
 END LOOP;
 IF total>cap OR inventory#>>'{dist/index.html,contentType}' IS DISTINCT FROM 'text/html' THEN RETURN false; END IF;
 FOR asset IN SELECT value FROM jsonb_array_elements(manifest->'assets') LOOP
  file:=inventory->lower(asset->>'path');
  SELECT coalesce(jsonb_agg(pin->'path' ORDER BY position),'[]') INTO expected_paths
   FROM jsonb_array_elements(pins) WITH ORDINALITY AS data(pin,position)
   WHERE pin->'sizeBytes'=file->'sizeBytes' AND pin->'checksumSha256'=file->'checksumSha256'
     AND lower(substring(pin->>'path' FROM '\.[^.\/]+$'))=lower(substring(file->>'path' FROM '\.[^.\/]+$'));
  IF jsonb_typeof(asset) IS DISTINCT FROM 'object' OR asset-ARRAY['path','mimeType','sizeBytes','checksumSha256','payloadId','archivePaths']<>'{}'
   OR NOT asset ?& ARRAY['path','mimeType','sizeBytes','checksumSha256','payloadId'] OR file IS NULL
   OR asset->>'path' IS DISTINCT FROM file->>'path' OR asset->>'path'=ANY(seen) OR asset->>'path' ~* '\.(html|m?js|css)$'
   OR asset->>'payloadId' IS DISTINCT FROM 'opengeo-localized-file-'||n::text
   OR coalesce(asset->>'mimeType','') !~ '^(image/(tiff|geotiff|png|jpeg|svg\+xml)|font/(woff2?|ttf|otf)|application/(json|geo\+json|octet-stream)|text/(plain|csv))$'
   OR asset->'sizeBytes' IS DISTINCT FROM file->'sizeBytes' OR asset->'checksumSha256' IS DISTINCT FROM file->'checksumSha256'
   OR (jsonb_array_length(expected_paths)>0 AND asset->'archivePaths' IS DISTINCT FROM expected_paths)
   OR (jsonb_array_length(expected_paths)=0 AND asset ? 'archivePaths')
  THEN RETURN false; END IF;
  seen:=array_append(seen,asset->>'path'); n:=n+1; asset_total:=asset_total+(asset->>'sizeBytes')::bigint;
 END LOOP;
 IF asset_total>67108864 THEN RETURN false; END IF;
 FOR file IN SELECT value FROM jsonb_array_elements(manifest->'unsupportedLazyImports') LOOP
  IF jsonb_typeof(file) IS DISTINCT FROM 'string' OR NOT app.observable_output_path_is_safe(file#>>'{}')
    OR inventory ? lower(file#>>'{}') OR (file#>>'{}')=ANY(lazy) THEN RETURN false; END IF;
  lazy:=array_append(lazy,file#>>'{}');
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION app.observable_localized_result_is_valid(jsonb,jsonb,jsonb)
 FROM PUBLIC,opengeo_runtime,opengeo_worker,opengeo_connector,opengeo_observable_coordinator,opengeo_framework_publisher;
DO $$
DECLARE definition text; anchor text:='  IF p_result IS NULL'; addition text:=$body$
  IF v_job.request->>'schemaVersion'='opengeo.observable-build-request.4.0.0' THEN
    PERFORM app.require_observable_distribution_request(v_job.id);
    IF NOT app.observable_localized_result_is_valid(p_result,v_job.request,v_manifest)
      OR p_result#>>'{validationReport,inputFileCount}' IS DISTINCT FROM
        (jsonb_array_length(v_manifest->'files')+coalesce(jsonb_array_length(v_manifest->'dataAttachments'),0))::text
      OR p_result#>>'{validationReport,inputBytes}' IS DISTINCT FROM
        (SELECT coalesce(sum((file->>'sizeBytes')::bigint),0) FROM jsonb_array_elements(v_manifest->'files'||coalesce(v_manifest->'dataAttachments','[]'::jsonb)) file)::text
    THEN RAISE EXCEPTION 'Invalid localized output or exact input proof' USING ERRCODE='23514'; END IF;
    v_maximum_file_bytes:=CASE WHEN v_job.request->>'outputProfile'='archive-96m' THEN 100663296 ELSE 33554432 END;
  END IF;
$body$;
BEGIN
 definition:=pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure);
 IF (length(definition)-length(pg_temp.opengeo_native_replace_once(definition,anchor,'')))/length(anchor)<>1
  OR position('p_result->>''schemaVersion'' <> ''opengeo.observable-build-result.1.0.0''' IN definition)=0
  OR position('v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296' IN definition)=0
 THEN RAISE EXCEPTION 'Unexpected Observable result contract'; END IF;
 definition:=pg_temp.opengeo_native_replace_once(definition,anchor,addition||anchor);
 definition:=pg_temp.opengeo_native_replace_once(definition,'p_result->>''schemaVersion'' <> ''opengeo.observable-build-result.1.0.0''',
  'p_result->>''schemaVersion'' IS DISTINCT FROM (CASE WHEN v_job.request->>''schemaVersion''=''opengeo.observable-build-request.4.0.0'' THEN ''opengeo.observable-build-result.2.0.0'' ELSE ''opengeo.observable-build-result.1.0.0'' END)');
 definition:=pg_temp.opengeo_native_replace_once(definition,'v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296',
  'v_job.request->>''schemaVersion'' IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'') AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296');
 EXECUTE definition;
END;
$$;
DO $$
DECLARE definition text; anchor text:='''plan'', j.plan, ''edge_snapshot'', j.edge_snapshot';
BEGIN
 definition:=pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure);
 IF (length(definition)-length(pg_temp.opengeo_native_replace_once(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected publication claim'; END IF;
 EXECUTE pg_temp.opengeo_native_replace_once(definition,anchor,
  '''previous_release_plan'', (SELECT prior.plan FROM app.framework_publication_jobs prior
    WHERE prior.organization_id=r.organization_id AND prior.origin_id=o.id AND prior.stage=''deployed''
      AND prior.plan->>''targetPrefix''=r.previous_release_prefix ORDER BY prior.updated_at DESC LIMIT 1), '||anchor);
END;
$$;$install_localized$;
  DROP FUNCTION pg_temp.opengeo_native_replace_once(text,text,text);
  SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile)) FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT pg_catalog.to_regprocedure(name) FROM unnest(core_functions) names(name)) INTO after_security;
  IF before_security IS DISTINCT FROM after_security OR before_helper IS DISTINCT FROM
      pg_catalog.pg_get_functiondef('app.observable_exact_archive_output(jsonb,jsonb)'::regprocedure)
    OR pg_catalog.strpos(pg_catalog.pg_get_functiondef('app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure),preview_guard)=0
  THEN RAISE EXCEPTION 'Retained Observable security or TIFF contract changed'; END IF;
  FOR readiness IN EXECUTE readiness_sql LOOP
    IF NOT readiness.object_present OR NOT readiness.marker_or_signature_matches
    THEN RAISE EXCEPTION 'Native Observable contract incomplete: %', readiness.check_name; END IF;
  END LOOP;
END;
$native_compatibility$;

COMMIT;
