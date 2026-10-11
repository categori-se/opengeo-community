BEGIN;

-- The representation is generated output, never a larger authored Source or
-- arbitrary asset allowance. Keep all current rights and final review checks.
CREATE OR REPLACE FUNCTION app.require_observable_distribution_request(p_job uuid) RETURNS void
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
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected request validator'; END IF;
 EXECUTE replace(definition,anchor,addition||anchor);
 definition:=pg_get_functiondef('app.require_observable_staging_manifest_support()'::regprocedure);
 anchor:='NEW.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0''';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive staging guard'; END IF;
 EXECUTE replace(definition,anchor,'NEW.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'')');
 definition:=pg_get_functiondef('app.resolve_observable_build_data(uuid,uuid)'::regprocedure);
 anchor:='v_job.request->>''schemaVersion'' <> ''opengeo.observable-build-request.3.0.0''';
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected archive resolver'; END IF;
 EXECUTE replace(definition,anchor,'v_job.request->>''schemaVersion'' NOT IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'')');
END;
$$;

-- Metadata facts are sealed separately from HTML bytes. This validator never
-- grants publication authority or fetches a source object.
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
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  OR position('p_result->>''schemaVersion'' <> ''opengeo.observable-build-result.1.0.0''' IN definition)=0
  OR position('v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296' IN definition)=0
 THEN RAISE EXCEPTION 'Unexpected Observable result contract'; END IF;
 definition:=replace(definition,anchor,addition||anchor);
 definition:=replace(definition,'p_result->>''schemaVersion'' <> ''opengeo.observable-build-result.1.0.0''',
  'p_result->>''schemaVersion'' IS DISTINCT FROM (CASE WHEN v_job.request->>''schemaVersion''=''opengeo.observable-build-request.4.0.0'' THEN ''opengeo.observable-build-result.2.0.0'' ELSE ''opengeo.observable-build-result.1.0.0'' END)');
 definition:=replace(definition,'v_job.request->>''schemaVersion''=''opengeo.observable-build-request.3.0.0'' AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296',
  'v_job.request->>''schemaVersion'' IN (''opengeo.observable-build-request.3.0.0'',''opengeo.observable-build-request.4.0.0'') AND v_job.request->>''outputProfile''=''archive-96m'' THEN 100663296');
 EXECUTE definition;
END;
$$;

-- The prior plan is an existing owner-sealed deployed record, bound to the
-- current tenant/origin/release. It is read-only proof for retaining sibling
-- HTML, not an S3 label or permission to inspect an arbitrary release prefix.
DO $$
DECLARE definition text; anchor text:='''plan'', j.plan, ''edge_snapshot'', j.edge_snapshot';
BEGIN
 definition:=pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Unexpected publication claim'; END IF;
 EXECUTE replace(definition,anchor,
  '''previous_release_plan'', (SELECT prior.plan FROM app.framework_publication_jobs prior
    WHERE prior.organization_id=r.organization_id AND prior.origin_id=o.id AND prior.stage=''deployed''
      AND prior.plan->>''targetPrefix''=r.previous_release_prefix ORDER BY prior.updated_at DESC LIMIT 1), '||anchor);
END;
$$;

COMMIT;
