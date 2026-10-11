BEGIN;

-- Referenced public files retain Catalog editions, not invented archive objects.
-- Registration and draft binding do not authorize transport or publication.
CREATE TABLE app.observable_public_file_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version BETWEEN 1 AND 9007199254740991),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  resource_version_number bigint NOT NULL CHECK (resource_version_number > 0),
  distribution_id text NOT NULL CHECK (char_length(distribution_id) BETWEEN 1 AND 1000),
  source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 9 AND 2048),
  content_type text NOT NULL CHECK (content_type IN ('image/tiff','image/geotiff')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, source_project_id, id),
  UNIQUE (organization_id, source_project_id, dataset_id, source_version,
    resource_id, resource_version_id, distribution_id),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (organization_id, dataset_id, source_version)
    REFERENCES app.external_source_revisions (organization_id, dataset_id, version_number),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id)
);

CREATE FUNCTION app.resolve_observable_public_file_reference(
  p_org uuid, p_project uuid, p_dataset uuid, p_source_version bigint,
  p_resource uuid, p_resource_version uuid, p_distribution text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, app AS $$
DECLARE facts record; distribution jsonb; matches integer; host text; label text;
BEGIN
  IF p_org IS DISTINCT FROM app.current_organization_id()
    OR p_source_version NOT BETWEEN 1 AND 9007199254740991
    OR coalesce(char_length(p_distribution),0) NOT BETWEEN 1 AND 1000
  THEN RAISE EXCEPTION 'public file reference selection unavailable' USING ERRCODE='23514'; END IF;
  SELECT metadata.version_number, metadata.metadata_extensions, revision.source_url INTO facts
  FROM app.projects project
  JOIN app.organizations organization ON organization.id=project.organization_id AND organization.status='active'
  JOIN app.organization_memberships member ON member.organization_id=project.organization_id AND member.user_id=app.current_user_id()
  JOIN app.project_datasets linked ON linked.organization_id=project.organization_id AND linked.project_id=project.id AND linked.dataset_id=p_dataset
  JOIN app.datasets dataset ON dataset.organization_id=linked.organization_id AND dataset.id=linked.dataset_id AND dataset.status='active'
  JOIN app.external_sources source ON source.organization_id=dataset.organization_id AND source.dataset_id=dataset.id
    AND source.source_type='cog' AND source.access_mode='direct_browser' AND source.credential_mode='none'
  JOIN app.external_source_revisions revision ON revision.organization_id=source.organization_id
    AND revision.dataset_id=source.dataset_id AND revision.version_number=p_source_version
  JOIN app.governed_resources resource ON resource.organization_id=project.organization_id AND resource.project_id=project.id
    AND resource.id=p_resource AND resource.dataset_id=dataset.id AND resource.kind='dataset' AND resource.state<>'archived'
  JOIN app.governed_resource_versions metadata ON metadata.organization_id=resource.organization_id
    AND metadata.resource_id=resource.id AND metadata.id=p_resource_version
    AND metadata.provenance->>'externalSourceVersion'=p_source_version::text
    AND metadata.provenance->>'externalSourceUrl'=revision.source_url
  LEFT JOIN app.dataset_permissions dataset_permission ON dataset_permission.organization_id=dataset.organization_id
    AND dataset_permission.dataset_id=dataset.id AND dataset_permission.user_id=member.user_id
  LEFT JOIN app.governed_resource_permissions resource_permission ON resource_permission.organization_id=resource.organization_id
    AND resource_permission.resource_id=resource.id AND resource_permission.user_id=member.user_id
  WHERE project.organization_id=p_org AND project.id=p_project AND project.status='active'
    -- Catalog Layer access and metadata access remain independent decisions.
    AND (member.role='admin' OR dataset.owner_user_id=member.user_id
      OR app.effective_project_role(project.id,member.user_id)::text IN ('owner','editor','reviewer','viewer')
      OR dataset_permission.role::text IN ('manage','edit','view','download'))
    AND (member.role='admin' OR resource.owner_user_id=member.user_id
      OR app.effective_project_role(project.id,member.user_id)::text IN ('owner','editor','reviewer','viewer')
      OR resource_permission.role::text IN ('manage','edit','publish','view'))
  FOR SHARE OF project, dataset, resource;
  IF NOT FOUND OR coalesce(facts.metadata_extensions#>>'{opengeo,schemaVersion}','') NOT IN ('1.0.0','1.1.0','1.2.0','1.3.0')
    OR jsonb_typeof(facts.metadata_extensions#>'{opengeo,distributions}') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'public file reference selection unavailable' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(facts.metadata_extensions#>'{opengeo,distributions}') item
    WHERE item->>'identifier'=p_distribution;
  IF matches<>1 THEN RAISE EXCEPTION 'public file reference distribution unavailable' USING ERRCODE='23514'; END IF;
  SELECT item INTO distribution FROM jsonb_array_elements(facts.metadata_extensions#>'{opengeo,distributions}') item
    WHERE item->>'identifier'=p_distribution;
  IF jsonb_typeof(distribution->'byteSize') IS DISTINCT FROM 'number'
    OR coalesce(distribution->>'byteSize','') !~ '^[0-9]{1,8}$'
    OR coalesce(distribution->>'checksumSha256','') !~ '^[0-9a-f]{64}$'
    OR coalesce(distribution->>'mediaType','') NOT IN ('image/tiff','image/geotiff')
    OR distribution->>'downloadUrl' IS DISTINCT FROM facts.source_url
  THEN RAISE EXCEPTION 'public file reference facts invalid' USING ERRCODE='23514'; END IF;
  IF (distribution->>'byteSize')::bigint NOT BETWEEN 1 AND 67108864
    OR facts.source_url !~* '^https://[A-Za-z0-9.-]+(:443)?(/[^?#]*)?$'
    OR facts.source_url ~ '[[:cntrl:][:space:]\\]'
  THEN RAISE EXCEPTION 'public file reference URL or size invalid' USING ERRCODE='23514'; END IF;
  host:=lower(rtrim(substring(facts.source_url FROM '^[Hh][Tt][Tt][Pp][Ss]://([^/:]+)'),'.'));
  IF char_length(host) NOT BETWEEN 1 AND 253 OR host ~ '^[0-9.]+$'
    OR host IN ('localhost','localhost.localdomain') OR host ~ '\.(localhost|local|internal|home\.arpa)$'
  THEN RAISE EXCEPTION 'public file reference host invalid' USING ERRCODE='23514'; END IF;
  FOREACH label IN ARRAY string_to_array(host,'.') LOOP
    IF label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    THEN RAISE EXCEPTION 'public file reference host invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN jsonb_build_object('kind','referenced-public-file','custody','referenced',
    'datasetId',p_dataset,'sourceVersion',p_source_version,'resourceId',p_resource,
    'resourceVersionId',p_resource_version,'resourceVersionNumber',facts.version_number,
    'distributionId',p_distribution,'url',facts.source_url,'contentType',distribution->>'mediaType',
    'sizeBytes',(distribution->>'byteSize')::bigint,'checksumSha256',distribution->>'checksumSha256');
END;
$$;

CREATE FUNCTION app.enforce_observable_public_file_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE facts jsonb;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
  THEN RAISE EXCEPTION 'public file reference requires its tenant actor' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM app.observable_source_projects source
  JOIN app.projects project ON project.organization_id=source.organization_id AND project.id=source.project_id AND project.status='active'
  JOIN app.organization_memberships member ON member.organization_id=project.organization_id AND member.user_id=NEW.created_by
  WHERE source.organization_id=NEW.organization_id AND source.project_id=NEW.project_id AND source.id=NEW.source_project_id
    AND (member.role='admin' OR app.effective_project_role(project.id,member.user_id)::text IN ('owner','editor'))
  FOR UPDATE OF source;
  IF NOT FOUND THEN RAISE EXCEPTION 'public file reference requires source-project manage access' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM app.observable_public_file_references WHERE organization_id=NEW.organization_id AND source_project_id=NEW.source_project_id)>=128
    AND NOT EXISTS(SELECT 1 FROM app.observable_public_file_references WHERE organization_id=NEW.organization_id
      AND source_project_id=NEW.source_project_id AND dataset_id=NEW.dataset_id AND source_version=NEW.source_version
      AND resource_id=NEW.resource_id AND resource_version_id=NEW.resource_version_id AND distribution_id=NEW.distribution_id)
  THEN RAISE EXCEPTION 'source project public file reference limit reached' USING ERRCODE='23514'; END IF;
  facts:=app.resolve_observable_public_file_reference(NEW.organization_id,NEW.project_id,NEW.dataset_id,
    NEW.source_version,NEW.resource_id,NEW.resource_version_id,NEW.distribution_id);
  NEW.resource_version_number:=(facts->>'resourceVersionNumber')::bigint;
  NEW.source_url:=facts->>'url'; NEW.content_type:=facts->>'contentType';
  NEW.size_bytes:=(facts->>'sizeBytes')::bigint; NEW.checksum_sha256:=facts->>'checksumSha256';
  RETURN NEW;
END;
$$;
CREATE TRIGGER observable_public_file_references_validate BEFORE INSERT ON app.observable_public_file_references
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_public_file_reference();
CREATE TRIGGER observable_public_file_references_immutable BEFORE UPDATE OR DELETE ON app.observable_public_file_references
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.observable_public_file_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_public_file_references FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_public_file_references_tenant ON app.observable_public_file_references
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.observable_public_file_references TO opengeo_runtime;
REVOKE ALL ON app.observable_public_file_references FROM PUBLIC,opengeo_worker,opengeo_observable_coordinator,opengeo_framework_publisher;

CREATE FUNCTION app.observable_public_file_reference_available(p_org uuid,p_project uuid,p_reference uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,app AS $$
DECLARE reference app.observable_public_file_references%ROWTYPE; facts jsonb;
BEGIN
  IF p_org IS DISTINCT FROM app.current_organization_id() THEN RETURN false; END IF;
  SELECT * INTO reference FROM app.observable_public_file_references WHERE organization_id=p_org AND project_id=p_project AND id=p_reference;
  IF NOT FOUND THEN RETURN false; END IF;
  facts:=app.resolve_observable_public_file_reference(p_org,p_project,reference.dataset_id,reference.source_version,
    reference.resource_id,reference.resource_version_id,reference.distribution_id);
  RETURN facts=jsonb_build_object('kind','referenced-public-file','custody','referenced',
    'datasetId',reference.dataset_id,'sourceVersion',reference.source_version,'resourceId',reference.resource_id,
    'resourceVersionId',reference.resource_version_id,'resourceVersionNumber',reference.resource_version_number,
    'distributionId',reference.distribution_id,'url',reference.source_url,'contentType',reference.content_type,
    'sizeBytes',reference.size_bytes,'checksumSha256',reference.checksum_sha256);
EXCEPTION WHEN check_violation THEN RETURN false;
END;
$$;

CREATE FUNCTION app.validate_observable_revision_input_bindings(p_org uuid,p_project uuid,p_source uuid,p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,app AS $$
DECLARE archives jsonb; reference_pins jsonb:='[]'; item jsonb; facts jsonb; reference app.observable_public_file_references%ROWTYPE;
  projection jsonb; path text; previous text; total bigint;
BEGIN
  IF p_manifest->>'schemaVersion' IN ('opengeo.observable-source-revision.1.0.0','opengeo.observable-source-revision.2.0.0') THEN
    RETURN jsonb_build_object('dataAttachments',app.validate_observable_revision_data_bindings(p_org,p_project,p_source,p_manifest),'referencedFiles','[]'::jsonb);
  END IF;
  IF p_manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-source-revision.3.0.0'
    OR jsonb_typeof(p_manifest->'files') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'dataAttachments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'referencedFiles') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'unsupported Observable source manifest' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(p_manifest->'referencedFiles') NOT BETWEEN 1 AND 128
    OR jsonb_array_length(p_manifest->'files')+jsonb_array_length(p_manifest->'dataAttachments')+jsonb_array_length(p_manifest->'referencedFiles')>128
    OR p_org IS DISTINCT FROM app.current_organization_id()
    OR NOT EXISTS(SELECT 1 FROM app.observable_source_projects source JOIN app.projects project
      ON project.organization_id=source.organization_id AND project.id=source.project_id AND project.status='active'
      JOIN app.organization_memberships member ON member.organization_id=project.organization_id AND member.user_id=app.current_user_id()
      WHERE source.organization_id=p_org AND source.project_id=p_project AND source.id=p_source
        AND (member.role='admin' OR app.effective_project_role(project.id,member.user_id)::text IN ('owner','editor')))
  THEN RAISE EXCEPTION 'referenced bindings require bounded source-project manage access' USING ERRCODE='23514'; END IF;
  projection:=p_manifest-'referencedFiles';
  IF jsonb_array_length(p_manifest->'dataAttachments')=0 THEN
    projection:=(projection-'dataAttachments')||jsonb_build_object('schemaVersion','opengeo.observable-source-revision.1.0.0');
  ELSE projection:=projection||jsonb_build_object('schemaVersion','opengeo.observable-source-revision.2.0.0'); END IF;
  archives:=app.validate_observable_revision_data_bindings(p_org,p_project,p_source,projection);
  SELECT coalesce(sum((pin->>'sizeBytes')::bigint),0) INTO total FROM jsonb_array_elements(archives) pin;
  FOR item IN SELECT value FROM jsonb_array_elements(p_manifest->'referencedFiles') LOOP
    path:=item->>'path';
    IF NOT app.observable_source_path_is_safe(path) OR path !~* '\.tiff?$'
      OR (previous IS NOT NULL AND previous COLLATE "C">=path COLLATE "C")
    THEN RAISE EXCEPTION 'referenced binding path is unsafe or unsorted' USING ERRCODE='23514'; END IF;
    previous:=path;
    SELECT * INTO reference FROM app.observable_public_file_references WHERE organization_id=p_org AND project_id=p_project
      AND source_project_id=p_source AND id::text=item->>'referenceId';
    IF NOT FOUND THEN RAISE EXCEPTION 'referenced binding unavailable' USING ERRCODE='23514'; END IF;
    facts:=app.resolve_observable_public_file_reference(p_org,p_project,reference.dataset_id,reference.source_version,
      reference.resource_id,reference.resource_version_id,reference.distribution_id);
    IF facts->>'url' IS DISTINCT FROM reference.source_url OR facts->>'contentType' IS DISTINCT FROM reference.content_type
      OR facts->>'checksumSha256' IS DISTINCT FROM reference.checksum_sha256
      OR (facts->>'sizeBytes')::bigint IS DISTINCT FROM reference.size_bytes
      OR (facts->>'resourceVersionNumber')::bigint IS DISTINCT FROM reference.resource_version_number
    THEN RAISE EXCEPTION 'referenced binding registered facts changed' USING ERRCODE='23514'; END IF;
    facts:=facts||jsonb_build_object('referenceId',reference.id,'path',path);
    IF item IS DISTINCT FROM facts THEN RAISE EXCEPTION 'referenced binding must match exact registered facts' USING ERRCODE='23514'; END IF;
    total:=total+reference.size_bytes;
    IF total>67108864 THEN RAISE EXCEPTION 'data bindings exceed 64 MiB' USING ERRCODE='23514'; END IF;
    reference_pins:=reference_pins||jsonb_build_array(facts);
  END LOOP;
  IF EXISTS(WITH paths AS(SELECT row_number() OVER() AS ordinal,lower(value->>'path') AS path
    FROM jsonb_array_elements((p_manifest->'files')||archives||reference_pins))
    SELECT 1 FROM paths a JOIN paths b ON a.ordinal<b.ordinal WHERE a.path=b.path
      OR starts_with(a.path,b.path||'/') OR starts_with(b.path,a.path||'/'))
  THEN RAISE EXCEPTION 'source and data binding paths collide' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('dataAttachments',archives,'referencedFiles',reference_pins);
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_observable_revision_data_bindings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.validate_observable_revision_input_bindings(NEW.organization_id,NEW.project_id,NEW.source_project_id,NEW.manifest);
  RETURN NEW;
END;
$$;

-- Preserve the installed head validator's HTML/notebook, C-order and immutable
-- project rules. Extend only construction of the exact expected manifest.
DO $$
DECLARE definition text; anchor text:='  IF v_revision.manifest IS DISTINCT FROM v_expected_manifest THEN';
  addition text:=$body$
  IF v_revision.manifest->>'schemaVersion'='opengeo.observable-source-revision.3.0.0' THEN
    v_expected_manifest:=v_expected_manifest||jsonb_build_object('schemaVersion','opengeo.observable-source-revision.3.0.0')
      ||app.validate_observable_revision_input_bindings(NEW.organization_id,NEW.project_id,NEW.id,v_revision.manifest);
  END IF;
$body$;
BEGIN
  definition:=pg_get_functiondef('app.enforce_observable_source_project_head()'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  THEN RAISE EXCEPTION 'Unexpected source head validator; review referenced-file admission'; END IF;
  EXECUTE replace(definition,anchor,addition||anchor);
  definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
  anchor:='  IF v_manifest->>''schemaVersion'' = ''opengeo.observable-source-revision.2.0.0'' THEN';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  THEN RAISE EXCEPTION 'Unexpected staging guard; review referenced-file denial'; END IF;
  addition:='  IF v_manifest->>''schemaVersion'' = ''opengeo.observable-source-revision.3.0.0'' THEN
    RAISE EXCEPTION ''referenced file staging is not available'' USING ERRCODE=''23514'';
  END IF;
';
  EXECUTE replace(definition,anchor,addition||anchor);
  definition:=pg_get_functiondef('app.require_observable_preview_archive_access()'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  THEN RAISE EXCEPTION 'Unexpected preview guard; review referenced-file denial'; END IF;
  EXECUTE replace(definition,anchor,addition||anchor);
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_observable_public_file_reference(uuid,uuid,uuid,bigint,uuid,uuid,text),
  app.enforce_observable_public_file_reference(),app.observable_public_file_reference_available(uuid,uuid,uuid),
  app.validate_observable_revision_input_bindings(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,opengeo_worker,opengeo_observable_coordinator,opengeo_framework_publisher;
GRANT EXECUTE ON FUNCTION app.resolve_observable_public_file_reference(uuid,uuid,uuid,bigint,uuid,uuid,text),
  app.enforce_observable_public_file_reference(),app.observable_public_file_reference_available(uuid,uuid,uuid),
  app.validate_observable_revision_input_bindings(uuid,uuid,uuid,jsonb) TO opengeo_runtime;

COMMIT;
