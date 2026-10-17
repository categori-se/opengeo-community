-- Additive intake boundary; frozen 0172 and ordinary ingestion stay unchanged.
BEGIN;
ALTER TYPE app.dataset_version_state ADD VALUE IF NOT EXISTS 'preserved';
ALTER TABLE app.upload_intents ADD COLUMN purpose text NOT NULL DEFAULT 'ingest',
  ADD CONSTRAINT upload_intent_purpose_known CHECK (purpose IN ('ingest','pmtiles_original')),
  ADD CONSTRAINT pmtiles_original_upload_bounded CHECK (purpose <> 'pmtiles_original' OR (
    staged_base_version_id IS NULL AND content_type = 'application/geo+json'
    AND expected_size_bytes BETWEEN 1 AND 536870912
    AND object_key = format('organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
      organization_id,project_id,dataset_id,id,original_filename)));

CREATE FUNCTION app.enforce_upload_intent_purpose() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'upload intent purpose is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.purpose = 'pmtiles_original' THEN
    IF NOT EXISTS (
    SELECT 1 FROM app.datasets dataset
    JOIN app.project_datasets link ON link.organization_id=dataset.organization_id
      AND link.dataset_id=dataset.id AND link.project_id=NEW.project_id
    WHERE dataset.organization_id=NEW.organization_id AND dataset.id=NEW.dataset_id
      AND dataset.source_type='upload' AND dataset.format='geojson'
      AND dataset.status='draft' AND dataset.current_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM app.dataset_versions version
        WHERE version.organization_id=dataset.organization_id AND version.dataset_id=dataset.id)
    ) THEN RAISE EXCEPTION 'PMTiles original purpose requires a new draft GeoJSON dataset'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER upload_intent_purpose_immutable BEFORE INSERT OR UPDATE ON app.upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_upload_intent_purpose();

-- Structural eligibility only. Callers retain their existing project authority;
-- SECURITY INVOKER retains tenant RLS for API reads. Worker/trigger owners call
-- it inside their existing narrow SECURITY DEFINER boundaries.
CREATE FUNCTION app.pmtiles_preserved_original_eligible(
  p_organization_id uuid,p_project_id uuid,p_dataset_id uuid,
  p_dataset_version_id uuid,p_source_object_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.datasets dataset
    JOIN app.projects project ON project.organization_id=dataset.organization_id
      AND project.id=p_project_id AND project.status='active'
    JOIN app.project_datasets project_dataset ON project_dataset.organization_id=dataset.organization_id
      AND project_dataset.dataset_id=dataset.id AND project_dataset.project_id=project.id
    JOIN app.dataset_versions version ON version.organization_id=dataset.organization_id
      AND version.dataset_id=dataset.id AND version.id=p_dataset_version_id
      AND version.original_object_id=p_source_object_id
    JOIN app.dataset_version_objects link ON link.organization_id=version.organization_id
      AND link.dataset_id=version.dataset_id AND link.dataset_version_id=version.id
      AND link.data_object_id=version.original_object_id
    JOIN app.data_objects original ON original.organization_id=version.organization_id
      AND original.dataset_id=version.dataset_id AND original.id=version.original_object_id
    JOIN app.upload_intents intent ON intent.organization_id=version.organization_id
      AND intent.dataset_id=version.dataset_id
      AND intent.completed_object_id=original.id AND intent.state='completed'
      AND intent.purpose='pmtiles_original' AND intent.staged_base_version_id IS NULL
      AND intent.bucket=original.bucket AND intent.object_key=original.object_key
      AND intent.content_type=original.content_type AND intent.expected_size_bytes=original.size_bytes
      AND intent.expected_sha256=original.checksum_sha256
    WHERE dataset.organization_id=p_organization_id AND dataset.id=p_dataset_id
      AND dataset.source_type='upload' AND dataset.format='geojson' AND dataset.status='draft'
      AND dataset.current_version_id=version.id AND version.state::text='preserved'
      AND version.parent_version_id IS NULL AND version.feature_count IS NULL
      AND version.extent IS NULL AND version.crs IS NULL AND version.geometry_type IS NULL
      AND version.schema_definition='{}'::jsonb AND version.quality_results='{}'::jsonb
      AND original.role='original' AND original.content_type='application/geo+json'
      AND original.size_bytes BETWEEN 1 AND 536870912
      AND original.s3_version_id NOT IN ('','null') AND original.s3_version_id !~ '[[:cntrl:]]'
      AND original.object_key=format('organizations/%s/projects/%s/datasets/%s/uploads/%s/original/%s',
        intent.organization_id,intent.project_id,intent.dataset_id,intent.id,intent.original_filename)
      AND NOT EXISTS (SELECT 1 FROM app.processing_jobs job
        WHERE job.organization_id=version.organization_id AND job.dataset_id=version.dataset_id
          AND job.dataset_version_id=version.id AND job.job_type='dataset.ingest')
  );
$$;
REVOKE ALL ON FUNCTION app.pmtiles_preserved_original_eligible(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC,opengeo_worker,opengeo_connector,opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.pmtiles_preserved_original_eligible(uuid,uuid,uuid,uuid,uuid)
  TO opengeo_runtime;

CREATE FUNCTION app.enforce_preserved_dataset_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state::text='preserved' THEN RAISE EXCEPTION 'preserved original version is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.state::text='preserved' OR NEW.state::text='preserved') THEN
    IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
      RAISE EXCEPTION 'preserved original version is immutable';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.state::text='preserved' THEN
    IF NEW.parent_version_id IS NOT NULL OR NEW.version_number<>1
      OR NEW.feature_count IS NOT NULL OR NEW.extent IS NOT NULL OR NEW.crs IS NOT NULL
      OR NEW.geometry_type IS NOT NULL OR NEW.schema_definition<>'{}'::jsonb
      OR NEW.quality_results<>'{}'::jsonb OR NOT EXISTS (
        SELECT 1 FROM app.datasets dataset
        JOIN app.data_objects original ON original.organization_id=dataset.organization_id
          AND original.dataset_id=dataset.id AND original.id=NEW.original_object_id
        JOIN app.upload_intents intent ON intent.organization_id=dataset.organization_id
          AND intent.dataset_id=dataset.id AND intent.purpose='pmtiles_original'
          AND intent.staged_base_version_id IS NULL AND intent.bucket=original.bucket
          AND intent.object_key=original.object_key AND intent.expected_sha256=original.checksum_sha256
          AND intent.expected_size_bytes=original.size_bytes AND intent.content_type=original.content_type
          AND (intent.state='pending' OR intent.completed_object_id=original.id)
        WHERE dataset.organization_id=NEW.organization_id AND dataset.id=NEW.dataset_id
          AND dataset.source_type='upload' AND dataset.format='geojson'
          AND dataset.status='draft' AND dataset.current_version_id IS NULL
          AND original.role='original' AND original.content_type='application/geo+json'
          AND original.size_bytes BETWEEN 1 AND 536870912
          AND original.s3_version_id NOT IN ('','null') AND original.s3_version_id !~ '[[:cntrl:]]'
          AND NOT EXISTS (SELECT 1 FROM app.dataset_versions version
            WHERE version.organization_id=dataset.organization_id AND version.dataset_id=dataset.id)
      ) THEN RAISE EXCEPTION 'preserved original must be a new exact uninspected PMTiles source'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserved_dataset_version_immutable BEFORE INSERT OR UPDATE OR DELETE ON app.dataset_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_preserved_dataset_version();

CREATE FUNCTION app.enforce_preserved_dataset_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_version_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.dataset_versions version WHERE version.organization_id=OLD.organization_id
      AND version.dataset_id=OLD.id AND version.id=OLD.current_version_id AND version.state::text='preserved'
  ) AND (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    OR NEW.status::text NOT IN ('draft','archived')) THEN
    RAISE EXCEPTION 'preserved original cannot be activated or replaced through ingestion edits';
  END IF;
  IF NEW.current_version_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.dataset_versions version WHERE version.organization_id=NEW.organization_id
      AND version.dataset_id=NEW.id AND version.id=NEW.current_version_id AND version.state::text='preserved'
  ) THEN
    IF NEW.status::text NOT IN ('draft','archived') OR NOT EXISTS (
      SELECT 1 FROM app.dataset_versions version JOIN app.upload_intents intent
        ON intent.organization_id=version.organization_id AND intent.dataset_id=version.dataset_id
        AND intent.completed_object_id=version.original_object_id AND intent.state='completed'
        AND intent.purpose='pmtiles_original'
      WHERE version.organization_id=NEW.organization_id AND version.dataset_id=NEW.id
        AND version.id=NEW.current_version_id AND version.state::text='preserved'
    ) THEN RAISE EXCEPTION 'preserved dataset head requires its completed original intent'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserved_dataset_head BEFORE UPDATE ON app.datasets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_preserved_dataset_head();

CREATE FUNCTION app.reject_preserved_original_ingest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_type='dataset.ingest' AND EXISTS (SELECT 1 FROM app.dataset_versions version
    WHERE version.organization_id=NEW.organization_id AND version.dataset_id=NEW.dataset_id
      AND version.id=NEW.dataset_version_id AND version.state::text='preserved') THEN
    RAISE EXCEPTION 'preserved original has no dataset ingestion job';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserved_original_no_ingest BEFORE INSERT OR UPDATE ON app.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION app.reject_preserved_original_ingest();

-- Retain all original authorization, request seals, quotas and legacy branches.
DO $$ DECLARE original text; updated text;
BEGIN
  original:=pg_get_functiondef('app.enforce_pmtiles_derivative_insert()'::regprocedure);
  updated:=replace(original, 'AND dataset.status = ''active'' AND version.state = ''active''',
    'AND ((dataset.status = ''active'' AND version.state = ''active'') OR (NEW.conversion_options IS NOT NULL AND app.pmtiles_preserved_original_eligible(NEW.organization_id,NEW.project_id,NEW.dataset_id,NEW.dataset_version_id,NEW.source_object_id)))');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles source insert predicate changed'; END IF;
  EXECUTE updated;

  original:=pg_get_functiondef('app.claim_pmtiles_derivative_v2(uuid,uuid,integer)'::regprocedure);
  updated:=replace(original,E'BEGIN\n  IF NOT EXISTS',E'BEGIN\n  IF EXISTS (SELECT 1 FROM app.pmtiles_derivative_jobs job JOIN app.dataset_versions version ON version.organization_id=job.organization_id AND version.dataset_id=job.dataset_id AND version.id=job.dataset_version_id WHERE job.id=p_job_id AND job.conversion_options IS NOT NULL AND version.state::text=''preserved'' AND NOT app.pmtiles_preserved_original_eligible(job.organization_id,job.project_id,job.dataset_id,job.dataset_version_id,job.source_object_id)) THEN\n    RETURN QUERY SELECT ''not_ready''::text, p_job_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::jsonb, NULL::smallint, NULL::smallint, NULL::text, NULL::text, NULL::integer, NULL::text, NULL::jsonb, NULL::text;\n    RETURN;\n  END IF;\n  IF NOT EXISTS');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles v2 claim predicate changed'; END IF;
  EXECUTE updated;

  original:=pg_get_functiondef('app.admit_pmtiles_derivative_display(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean)'::regprocedure);
  updated:=replace(original, 'AND dataset.source_type = ''upload'' AND dataset.status = ''active'' AND version.state = ''active''',
    'AND dataset.source_type = ''upload'' AND ((dataset.status = ''active'' AND version.state = ''active'') OR (v_job.conversion_options IS NOT NULL AND app.pmtiles_preserved_original_eligible(p_organization_id,p_project_id,p_dataset_id,p_dataset_version_id,v_job.source_object_id)))');
  IF updated=original THEN RAISE EXCEPTION 'PMTiles display source predicate changed'; END IF;
  EXECUTE updated;

  original:=pg_get_functiondef('app.capture_account_recovery_inventory()'::regprocedure);
  updated:=replace(original, '"project_id", "staged_base_version_id", "state", "updated_at"]',
    '"project_id", "purpose", "staged_base_version_id", "state", "updated_at"]');
  IF updated=original THEN RAISE EXCEPTION 'Upload intent recovery projection changed'; END IF;
  EXECUTE updated;
END; $$;
REVOKE ALL ON FUNCTION app.enforce_upload_intent_purpose(), app.enforce_preserved_dataset_version(),
  app.enforce_preserved_dataset_head(), app.reject_preserved_original_ingest() FROM PUBLIC,opengeo_runtime,opengeo_worker;
COMMENT ON COLUMN app.upload_intents.purpose IS
  'Immutable processing decision: ordinary ingest, or preserve one uninspected original for deliberate v2 PMTiles conversion.';
COMMIT;
