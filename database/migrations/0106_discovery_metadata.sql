BEGIN;
-- Preserve source bodies separately; existing seven-field discovery results stay compatible.
CREATE TABLE app.source_discovery_documents (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  discovery_job_id uuid PRIMARY KEY,
  document jsonb NOT NULL CHECK (octet_length(document::text) <= 49152),
  UNIQUE (organization_id, discovery_job_id),
  FOREIGN KEY (organization_id, discovery_job_id) REFERENCES app.external_source_discovery_jobs(organization_id,id)
);
CREATE TABLE app.dataset_source_discoveries (
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  discovery_job_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('arcgis', 'wfs')),
  service_url text NOT NULL,
  collection_ref text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, dataset_id),
  FOREIGN KEY (organization_id, dataset_id) REFERENCES app.datasets(organization_id,id),
  FOREIGN KEY (organization_id, discovery_job_id)
    REFERENCES app.external_source_discovery_jobs(organization_id,id)
);
ALTER TABLE app.source_discovery_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.source_discovery_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_source_discoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_source_discoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY source_discovery_documents_tenant ON app.source_discovery_documents
  FOR SELECT TO opengeo_runtime USING (organization_id = app.current_organization_id());
CREATE POLICY dataset_source_discoveries_tenant ON app.dataset_source_discoveries
  TO opengeo_runtime USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id() AND created_by = app.current_user_id());
GRANT SELECT ON app.source_discovery_documents TO opengeo_runtime;
GRANT SELECT, INSERT ON app.dataset_source_discoveries TO opengeo_runtime;
CREATE TRIGGER source_discovery_document_immutable BEFORE UPDATE OR DELETE
  ON app.source_discovery_documents FOR EACH ROW
  EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER dataset_source_discovery_immutable BEFORE UPDATE OR DELETE
  ON app.dataset_source_discoveries FOR EACH ROW
  EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

CREATE FUNCTION app.complete_external_source_discovery_document(
  p_job_id uuid, p_worker_token uuid, p_result jsonb, p_document jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  v_job app.external_source_discovery_jobs%ROWTYPE;
  v_body bytea;
  v_length integer;
BEGIN
  SELECT * INTO v_job FROM app.external_source_discovery_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR p_worker_token IS NULL OR v_job.state <> 'running' OR v_job.worker_token <> p_worker_token
    OR v_job.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object'
    OR octet_length(p_document::text) > 49152
    OR NOT p_document ?& ARRAY['status','body_base64','byte_length','sha256','retrieved_at']
    OR p_document - ARRAY['status','body_base64','byte_length','sha256','retrieved_at'] <> '{}'::jsonb
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
    IF jsonb_typeof(p_document->'body_base64') <> 'string' OR v_length > 32768
    THEN RAISE EXCEPTION 'invalid retained discovery body'; END IF;
    v_body := decode(p_document->>'body_base64','base64');
    IF octet_length(v_body) <> v_length
      OR encode(public.digest(v_body,'sha256'),'hex') <> p_document->>'sha256'
    THEN RAISE EXCEPTION 'discovery source checksum mismatch'; END IF;
  ELSIF p_document->>'status' = 'not_retained_size' THEN
    IF v_length <= 32768 OR jsonb_typeof(p_document->'body_base64') <> 'null'
    THEN RAISE EXCEPTION 'invalid discovery omission'; END IF;
  ELSE RAISE EXCEPTION 'invalid discovery source status'; END IF;
  IF NOT app.complete_external_source_discovery(p_job_id,p_worker_token,p_result)
    THEN RETURN false; END IF;
  INSERT INTO app.source_discovery_documents(organization_id,project_id,discovery_job_id,document)
    VALUES(v_job.organization_id,v_job.project_id,p_job_id,p_document);
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION app.complete_external_source_discovery_document(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_external_source_discovery_document(uuid,uuid,jsonb,jsonb) TO opengeo_source_archiver;
COMMENT ON TABLE app.source_discovery_documents IS
  'Exact bounded anonymous discovery response bodies or explicit size omissions; API authorization applies in addition to tenant RLS.';

COMMIT;
