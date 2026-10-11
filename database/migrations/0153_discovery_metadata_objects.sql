BEGIN;
-- Existing inline documents, omissions, result contract and old worker claims remain compatible.
CREATE FUNCTION app.claim_external_source_discovery_document(
  p_job_id uuid, p_worker_token uuid, p_lease_seconds integer
) RETURNS TABLE (
  claim_status text, job_id uuid, source_type text, discovery_kind text,
  service_url text, collection_ref text, attempt_count integer,
  organization_id uuid, project_id uuid
) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT claim.*, job.organization_id, job.project_id
  FROM app.claim_external_source_discovery(p_job_id,p_worker_token,p_lease_seconds) claim
  LEFT JOIN app.external_source_discovery_jobs job ON job.id = claim.job_id
$$;
REVOKE ALL ON FUNCTION app.claim_external_source_discovery_document(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_external_source_discovery_document(uuid,uuid,integer)
  TO opengeo_source_archiver;

CREATE OR REPLACE FUNCTION app.complete_external_source_discovery_document(
  p_job_id uuid, p_worker_token uuid, p_result jsonb, p_document jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  v_job app.external_source_discovery_jobs%ROWTYPE;
  v_body bytea;
  v_length integer;
  v_object jsonb;
  v_expected_key text;
BEGIN
  SELECT * INTO v_job FROM app.external_source_discovery_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR p_worker_token IS NULL OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object'
    OR octet_length(p_document::text) > 49152
    OR NOT p_document ?& ARRAY['status','body_base64','byte_length','sha256','retrieved_at']
    OR p_document - ARRAY['status','body_base64','byte_length','sha256','retrieved_at','object'] <> '{}'::jsonb
    OR jsonb_typeof(p_document->'status') <> 'string'
    OR jsonb_typeof(p_document->'byte_length') <> 'number'
    OR jsonb_typeof(p_document->'sha256') <> 'string'
    OR jsonb_typeof(p_document->'retrieved_at') <> 'string'
    OR p_document->>'sha256' !~ '^[0-9a-f]{64}$'
    OR p_document->>'retrieved_at' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN RAISE EXCEPTION 'invalid discovery source document'; END IF;
  PERFORM (p_document->>'retrieved_at')::timestamptz;
  v_length := (p_document->>'byte_length')::integer;
  IF v_length NOT BETWEEN 1 AND 2097152 THEN RAISE EXCEPTION 'invalid discovery source length'; END IF;
  IF p_document->>'status' = 'retained' THEN
    IF p_document ? 'object' OR jsonb_typeof(p_document->'body_base64') <> 'string' OR v_length > 32768
    THEN RAISE EXCEPTION 'invalid retained discovery body'; END IF;
    v_body := decode(p_document->>'body_base64','base64');
    IF octet_length(v_body) <> v_length
      OR encode(public.digest(v_body,'sha256'),'hex') <> p_document->>'sha256'
    THEN RAISE EXCEPTION 'discovery source checksum mismatch'; END IF;
  ELSIF p_document->>'status' = 'not_retained_size' THEN
    IF p_document ? 'object' OR v_length <= 32768 OR jsonb_typeof(p_document->'body_base64') <> 'null'
    THEN RAISE EXCEPTION 'invalid discovery omission'; END IF;
  ELSIF p_document->>'status' = 'retained_object' THEN
    v_object := p_document->'object';
    v_expected_key := 'discovery-metadata/organizations/' || v_job.organization_id::text
      || '/projects/' || v_job.project_id::text || '/jobs/' || v_job.id::text || '/response.bin';
    IF v_length <= 32768 OR jsonb_typeof(p_document->'body_base64') IS DISTINCT FROM 'null'
      OR jsonb_typeof(v_object) IS DISTINCT FROM 'object'
      OR NOT v_object ?& ARRAY['bucket','key','version_id','etag','content_type']
      OR v_object - ARRAY['bucket','key','version_id','etag','content_type'] <> '{}'::jsonb
      OR jsonb_typeof(v_object->'bucket') IS DISTINCT FROM 'string'
      OR length(v_object->>'bucket') NOT BETWEEN 3 AND 63
      OR v_object->>'bucket' !~ '^[a-z0-9][a-z0-9.-]+[a-z0-9]$'
      OR jsonb_typeof(v_object->'key') IS DISTINCT FROM 'string'
      OR v_object->>'key' IS DISTINCT FROM v_expected_key
      OR jsonb_typeof(v_object->'version_id') IS DISTINCT FROM 'string'
      OR length(v_object->>'version_id') NOT BETWEEN 1 AND 1024
      OR v_object->>'version_id' = 'null'
      OR v_object->>'version_id' ~ '[[:cntrl:]]'
      OR jsonb_typeof(v_object->'etag') IS DISTINCT FROM 'string'
      OR v_object->>'etag' !~ '^[0-9a-f]{16,128}$'
      OR v_object->>'content_type' IS DISTINCT FROM 'application/octet-stream'
    THEN RAISE EXCEPTION 'invalid discovery object binding'; END IF;
  ELSE RAISE EXCEPTION 'invalid discovery source status'; END IF;
  IF NOT app.complete_external_source_discovery(p_job_id,p_worker_token,p_result)
    THEN RETURN false; END IF;
  INSERT INTO app.source_discovery_documents(organization_id,project_id,discovery_job_id,document)
    VALUES(v_job.organization_id,v_job.project_id,p_job_id,p_document);
  RETURN true;
END; $$;
COMMENT ON TABLE app.source_discovery_documents IS
  'Immutable exact response bodies: inline up to 32 KiB, governed private object versions through 2 MiB, or historical explicit omissions. Layer authorization controls linked reads.';
COMMIT;
