BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeo_analysis_runtime') THEN
    CREATE ROLE opengeo_analysis_runtime LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeo_analysis_controller') THEN
    CREATE ROLE opengeo_analysis_controller LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
END $$;

-- Independent analysis reservations never replace/reset the GIS/PMTiles ledger.
CREATE TABLE app.analysis_runtime_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  configuration jsonb NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  configuration_revision bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, window_state jsonb,
  budget_day date, starts_today integer NOT NULL DEFAULT 0,
  total_windows bigint NOT NULL DEFAULT 0, reserved_seconds bigint NOT NULL DEFAULT 0,
  last_result jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(jsonb_typeof(configuration)='object'),
  CHECK(window_state IS NULL OR jsonb_typeof(window_state)='object'),
  CHECK(starts_today>=0 AND total_windows>=0 AND reserved_seconds>=0)
);
INSERT INTO app.analysis_runtime_control(singleton) VALUES(true);

CREATE TABLE app.analysis_jobs (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(), project_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app.users(id), request_key uuid NOT NULL,
  language text NOT NULL CHECK(language IN ('python','javascript','bash')),
  state text NOT NULL DEFAULT 'awaiting_upload' CHECK(state IN
    ('awaiting_upload','dispatch_pending','pending','running','cancel_requested','succeeded','failed','cancelled')),
  request_definition jsonb NOT NULL CHECK(octet_length(request_definition::text)<=16384),
  snapshot jsonb NOT NULL, source_bindings jsonb NOT NULL,
  profile jsonb NOT NULL, profiles_sha256 text NOT NULL CHECK(profiles_sha256 ~ '^[0-9a-f]{64}$'),
  queue_url text NOT NULL, bucket text NOT NULL, object_prefix text NOT NULL,
  input_object jsonb, manifest jsonb, manifest_sha256 text,
  window_id uuid, lease_token uuid, lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1),
  result jsonb, execution jsonb, cleanup jsonb,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '15 minutes'),
  PRIMARY KEY(organization_id,id), UNIQUE(id),
  UNIQUE(organization_id,project_id,requested_by,request_key),
  FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
  CHECK(jsonb_typeof(snapshot)='object' AND jsonb_typeof(source_bindings)='array'),
  CHECK(jsonb_array_length(source_bindings)<=16),
  CHECK(manifest IS NULL OR octet_length(manifest::text)<=32768),
  CHECK((manifest IS NULL AND input_object IS NULL AND manifest_sha256 IS NULL AND window_id IS NULL)
    OR (manifest IS NOT NULL AND input_object IS NOT NULL AND manifest_sha256 ~ '^[0-9a-f]{64}$' AND window_id IS NOT NULL)),
  CHECK(execution IS NULL OR octet_length(execution::text)<=16384),
  CHECK(cleanup IS NULL OR octet_length(cleanup::text)<=4096)
);
CREATE INDEX analysis_jobs_window_state ON app.analysis_jobs(window_id,state);
CREATE INDEX analysis_jobs_actor ON app.analysis_jobs(organization_id,requested_by,created_at);
ALTER TABLE app.analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.analysis_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY analysis_jobs_private ON app.analysis_jobs USING(
  organization_id=app.current_organization_id() AND requested_by=app.current_user_id());

CREATE FUNCTION app.analysis_actor_authorized(p_org uuid,p_project uuid,p_actor uuid,p_bindings jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
DECLARE binding jsonb; dataset uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.projects project
      JOIN app.organizations organization ON organization.id=project.organization_id AND organization.status='active'
      JOIN app.organization_memberships member ON member.organization_id=organization.id AND member.user_id=p_actor
      WHERE project.organization_id=p_org AND project.id=p_project AND project.status='active'
        AND (member.role='admin' OR app.background_project_role(p_org,p_project,p_actor) IN ('owner','editor')))
    OR jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>16 THEN RETURN false; END IF;
  FOR binding IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
      OR binding-ARRAY['layer_id','dataset_id','dataset_version_id','source_version','feature_generation']<>'{}'::jsonb
      OR NOT binding ?& ARRAY['layer_id','dataset_id']
      OR COALESCE(binding->>'dataset_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN RETURN false; END IF;
    dataset := (binding->>'dataset_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM app.datasets d
      JOIN app.organization_memberships member ON member.organization_id=d.organization_id AND member.user_id=p_actor
      WHERE d.organization_id=p_org AND d.id=dataset AND d.status='active'
        AND (member.role='admin' OR d.owner_user_id=p_actor
          OR EXISTS(SELECT 1 FROM app.dataset_permissions permission
            WHERE permission.organization_id=p_org AND permission.dataset_id=dataset AND permission.user_id=p_actor
              AND permission.role IN ('manage','edit','download'))
          OR EXISTS(SELECT 1 FROM app.project_datasets link
            WHERE link.organization_id=p_org AND link.dataset_id=dataset
              AND app.background_project_role(p_org,link.project_id,p_actor) IN ('owner','editor'))))
      THEN RETURN false; END IF;
    IF binding ? 'dataset_version_id' AND NOT EXISTS(SELECT 1 FROM app.dataset_versions version
      WHERE version.organization_id=p_org AND version.dataset_id=dataset
        AND version.id::text=binding->>'dataset_version_id' AND version.state::text IN ('active','ready')) THEN RETURN false; END IF;
    IF binding ? 'source_version' AND NOT EXISTS(SELECT 1 FROM app.external_source_revisions source
      WHERE source.organization_id=p_org AND source.dataset_id=dataset
        AND source.version_number::text=binding->>'source_version') THEN RETURN false; END IF;
    IF binding ? 'feature_generation' AND NOT EXISTS(SELECT 1 FROM app.feature_collections feature
      WHERE feature.organization_id=p_org AND feature.dataset_id=dataset
        AND feature.generation::text=binding->>'feature_generation') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION app.analysis_policy_ready(p_profiles_sha text,p_queue text,p_new_job boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
DECLARE control app.analysis_runtime_control%ROWTYPE; config jsonb; key text; today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton;
  config := control.configuration;
  IF NOT FOUND OR config->'enabled' IS DISTINCT FROM 'true'::jsonb
    THEN RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_disabled'); END IF;
  IF config->>'analysisProfilesSha256' IS DISTINCT FROM p_profiles_sha
    OR config->>'analysisQueueUrl' IS DISTINCT FROM p_queue
    OR COALESCE(p_profiles_sha,'') !~ '^[0-9a-f]{64}$'
    THEN RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_binding_changed'); END IF;
  FOREACH key IN ARRAY ARRAY['windowSeconds','cleanupSeconds','dailyWindows','totalWindows','analysisDailyJobs','analysisTotalJobs'] LOOP
    IF jsonb_typeof(config->key) IS DISTINCT FROM 'number' OR COALESCE(config->>key,'') !~ '^[0-9]{1,5}$'
      THEN RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_policy_invalid'); END IF;
  END LOOP;
  IF (config->>'windowSeconds')::integer NOT BETWEEN 300 AND 3600
    OR (config->>'cleanupSeconds')::integer NOT BETWEEN 300 AND 1800
    OR (config->>'dailyWindows')::integer NOT BETWEEN 1 AND 8
    OR (config->>'totalWindows')::integer NOT BETWEEN 1 AND 1000
    OR (config->>'analysisDailyJobs')::integer NOT BETWEEN 1 AND 64
    OR (config->>'analysisTotalJobs')::integer NOT BETWEEN 1 AND 10000
    OR COALESCE(config->>'scopeHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(config->>'workerHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(config->>'endpointHash','') !~ '^[0-9a-f]{64}$'
    OR config->>'endpointHash' IS DISTINCT FROM config->>'sharedEndpointHash'
    OR COALESCE(config->>'sharedEndpointId','') NOT LIKE 'arn:%:cloudformation:%:stack/%'
    THEN RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_policy_invalid'); END IF;
  IF p_new_job AND ((SELECT count(*) FROM app.analysis_jobs)>=(config->>'analysisTotalJobs')::integer
    OR (SELECT count(*) FROM app.analysis_jobs WHERE (created_at AT TIME ZONE 'UTC')::date=today)>=(config->>'analysisDailyJobs')::integer)
    THEN RETURN jsonb_build_object('ready',false,'reason','analysis_job_budget_exhausted'); END IF;
  IF EXISTS(SELECT 1 FROM app.analysis_jobs WHERE cleanup->>'cleanup_required'='true')
    THEN RETURN jsonb_build_object('ready',false,'reason','analysis_cleanup_required'); END IF;
  IF control.window_state IS NOT NULL THEN
    IF control.window_state->>'phase' NOT IN ('endpoints','worker','processing')
      OR COALESCE((control.window_state->>'deadline')::numeric,0)<=extract(epoch FROM clock_timestamp())
      THEN RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_closing'); END IF;
    -- The first immutable job freezes this host window's profile. A later
    -- configuration change must not attach new-profile jobs to an old host.
    IF EXISTS(SELECT 1 FROM app.analysis_jobs WHERE window_id=(control.window_state->>'id')::uuid
        AND profiles_sha256 IS DISTINCT FROM p_profiles_sha) THEN
      RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_binding_changed'); END IF;
    IF (SELECT count(*) FROM app.analysis_jobs WHERE window_id=(control.window_state->>'id')::uuid)>=4 THEN
      RETURN jsonb_build_object('ready',false,'reason','analysis_window_job_limit'); END IF;
  ELSIF control.lease_until>clock_timestamp() THEN
    RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_busy');
  ELSIF control.total_windows>=(config->>'totalWindows')::bigint
    OR (control.budget_day=today AND control.starts_today>=(config->>'dailyWindows')::integer) THEN
    RETURN jsonb_build_object('ready',false,'reason','analysis_runtime_budget_exhausted');
  END IF;
  RETURN jsonb_build_object('ready',true,'reason','ready','window_seconds',(config->>'windowSeconds')::integer,
    'remaining_window_seconds',CASE WHEN control.window_state IS NULL THEN (config->>'windowSeconds')::integer
      ELSE greatest(0,(control.window_state->>'deadline')::bigint-floor(extract(epoch FROM clock_timestamp()))::bigint) END);
END $$;

CREATE FUNCTION app.analysis_job_capabilities(p_project uuid,p_configured boolean,p_profiles_sha text,p_queue text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE can_submit boolean; policy jsonb; active boolean;
BEGIN
  IF app.current_user_id() IS NULL OR app.current_organization_id() IS NULL OR
    NOT EXISTS(SELECT 1 FROM app.organization_memberships member JOIN app.projects project ON project.organization_id=member.organization_id
      WHERE member.organization_id=app.current_organization_id() AND member.user_id=app.current_user_id() AND project.id=p_project
        AND project.status='active' AND (member.role='admin' OR app.background_project_role(member.organization_id,p_project,member.user_id) IS NOT NULL))
    THEN RETURN jsonb_build_object('error','analysis_forbidden'); END IF;
  can_submit:=app.analysis_actor_authorized(app.current_organization_id(),p_project,app.current_user_id(),'[]');
  IF p_configured IS NOT TRUE THEN RETURN jsonb_build_object('configured',false,'available',false,'can_submit',can_submit,
    'state','unconfigured','reason','analysis_runtime_unavailable','languages','[]'::jsonb); END IF;
  policy:=app.analysis_policy_ready(p_profiles_sha,p_queue);
  SELECT window_state IS NOT NULL INTO active FROM app.analysis_runtime_control WHERE singleton;
  RETURN jsonb_build_object('configured',true,'available',can_submit AND (policy->>'ready')::boolean,'can_submit',can_submit,
    'state',CASE WHEN policy->>'ready'<>'true' THEN 'blocked' WHEN active THEN 'active' ELSE 'asleep' END,
    'reason',CASE WHEN can_submit THEN policy->>'reason' ELSE 'analysis_forbidden' END,
    'languages',jsonb_build_array('python','javascript','bash'),
    'limits',jsonb_build_object('snapshot_bytes',17825792,'code_bytes',65536,'layer_bytes',16777216,'layers',16,
      'logs_bytes',131072,'geojson_bytes',8388608,'result_bytes',9437184,'window_seconds',policy->'window_seconds',
      'remaining_window_seconds',policy->'remaining_window_seconds'));
END $$;

CREATE FUNCTION app.analysis_job_record(job app.analysis_jobs)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object('job_id',job.id,'request_key',job.request_key,'state',job.state,'language',job.language,
   'created_at',job.created_at,'updated_at',job.updated_at,'expires_at',job.expires_at,'error_code',job.error_code,
   'snapshot',job.snapshot||jsonb_build_object('bucket',job.bucket,'key',job.object_prefix||'snapshot.json'),
   'result',job.result,'execution',job.execution,'cleanup',job.cleanup,
   'provenance',jsonb_build_object('inputCustody','user-provided-snapshot','permissionChecked',true,
     'sourceBindings',job.source_bindings,'snapshotSha256',job.snapshot->>'checksum_sha256'))
$$;

CREATE FUNCTION app.read_analysis_job(p_project uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE;
BEGIN
 SELECT * INTO job FROM app.analysis_jobs WHERE organization_id=app.current_organization_id() AND id=p_job
   AND project_id=p_project AND requested_by=app.current_user_id();
 IF NOT FOUND THEN RETURN jsonb_build_object('error','analysis_not_found'); END IF;
 IF NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings)
   THEN RETURN jsonb_build_object('error','analysis_forbidden'); END IF;
 RETURN app.analysis_job_record(job);
END $$;
CREATE FUNCTION app.find_analysis_job(p_project uuid,p_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job_id uuid;
BEGIN
 SELECT id INTO job_id FROM app.analysis_jobs WHERE organization_id=app.current_organization_id()
   AND project_id=p_project AND requested_by=app.current_user_id() AND request_key=p_request_key;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','analysis_not_found'); END IF;
 RETURN app.read_analysis_job(p_project,job_id);
END $$;

CREATE FUNCTION app.create_analysis_job(p_project uuid,p_request uuid,p_language text,p_snapshot jsonb,
  p_bindings jsonb,p_profile jsonb,p_profiles_sha text,p_queue text,p_bucket text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE; control app.analysis_runtime_control%ROWTYPE;
  definition jsonb; policy jsonb; layer_ids jsonb; expected_profile jsonb; new_id uuid:=gen_random_uuid();
BEGIN
 IF p_request IS NULL OR p_language NOT IN ('python','javascript','bash')
   OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
   OR p_snapshot-ARRAY['size_bytes','checksum_sha256','layer_ids']<>'{}'::jsonb
   OR NOT p_snapshot ?& ARRAY['size_bytes','checksum_sha256','layer_ids']
   OR COALESCE(p_snapshot->>'size_bytes','') !~ '^[0-9]{1,8}$'
   OR (p_snapshot->>'size_bytes')::integer NOT BETWEEN 1 AND 17825792
   OR COALESCE(p_snapshot->>'checksum_sha256','') !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(p_snapshot->'layer_ids') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_snapshot->'layer_ids')>16
   OR jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>16
   OR p_bucket IS NULL OR p_bucket !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
   THEN RETURN jsonb_build_object('error','analysis_request_invalid'); END IF;
 layer_ids:=p_snapshot->'layer_ids';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(layer_ids) value WHERE jsonb_typeof(value)<>'string'
     OR char_length(value#>>'{}') NOT BETWEEN 1 AND 200 OR value#>>'{}' ~ '[[:cntrl:]]')
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(layer_ids) value)<>jsonb_array_length(layer_ids)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_bindings) binding
     WHERE NOT layer_ids ? (binding->>'layer_id'))
   OR (SELECT count(DISTINCT binding->>'layer_id') FROM jsonb_array_elements(p_bindings) binding)<>jsonb_array_length(p_bindings)
   THEN RETURN jsonb_build_object('error','analysis_request_invalid'); END IF;
 IF NOT app.analysis_actor_authorized(app.current_organization_id(),p_project,app.current_user_id(),p_bindings)
   THEN RETURN jsonb_build_object('error','analysis_forbidden'); END IF;
 definition:=jsonb_build_object('language',p_language,'snapshot',p_snapshot,'source_bindings',p_bindings,
   'profile',p_profile,'profiles_sha256',p_profiles_sha,'queue_url',p_queue,'bucket',p_bucket);
 -- Serializes idempotency, actor limits and global/daily budgets before a new row.
 SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
 SELECT * INTO job FROM app.analysis_jobs WHERE organization_id=app.current_organization_id()
   AND project_id=p_project AND requested_by=app.current_user_id() AND request_key=p_request;
 IF FOUND THEN
   IF job.request_definition IS DISTINCT FROM definition THEN RETURN jsonb_build_object('error','analysis_request_conflict'); END IF;
   RETURN app.analysis_job_record(job);
 END IF;
 policy:=app.analysis_policy_ready(p_profiles_sha,p_queue);
 IF policy->>'ready'<>'true' THEN RETURN jsonb_build_object('error',policy->>'reason'); END IF;
 expected_profile:=jsonb_build_object('image',control.configuration#>>ARRAY['analysisProfiles','profiles',p_language,'image'],
   'interpreter',control.configuration#>>ARRAY['analysisProfiles','profiles',p_language,'interpreter'],
   'architecture',control.configuration#>>'{analysisProfiles,architecture}','timeout_seconds',10,'memory_mib',256);
 IF p_profile IS DISTINCT FROM expected_profile
   OR COALESCE(p_profile->>'image','') !~ '^sha256:[0-9a-f]{64}$'
   OR p_profile->>'architecture' NOT IN ('arm64','amd64')
   THEN RETURN jsonb_build_object('error','analysis_runtime_binding_changed'); END IF;
 UPDATE app.analysis_jobs SET state='cancelled',error_code='analysis_upload_expired',updated_at=clock_timestamp(),
   cleanup='{"container_removed":true,"staging_removed":true,"cleanup_required":false}'::jsonb
   WHERE organization_id=app.current_organization_id() AND requested_by=app.current_user_id()
     AND state='awaiting_upload' AND expires_at<=clock_timestamp();
 IF EXISTS(SELECT 1 FROM app.analysis_jobs WHERE organization_id=app.current_organization_id()
   AND requested_by=app.current_user_id() AND state IN ('awaiting_upload','dispatch_pending','pending','running','cancel_requested'))
   THEN RETURN jsonb_build_object('error','analysis_actor_busy'); END IF;
 INSERT INTO app.analysis_jobs(organization_id,id,project_id,requested_by,request_key,language,
   request_definition,snapshot,source_bindings,profile,profiles_sha256,queue_url,bucket,object_prefix)
 VALUES(app.current_organization_id(),new_id,p_project,app.current_user_id(),p_request,p_language,
   definition,p_snapshot,p_bindings,p_profile,p_profiles_sha,p_queue,p_bucket,
   'organizations/'||app.current_organization_id()||'/projects/'||p_project||'/analysis/'||new_id||'/') RETURNING * INTO job;
 RETURN app.analysis_job_record(job);
END $$;

CREATE FUNCTION app.submit_analysis_job(p_project uuid,p_job uuid,p_object jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE; control app.analysis_runtime_control%ROWTYPE;
 policy jsonb; moment timestamptz:=clock_timestamp(); today date:=(moment AT TIME ZONE 'UTC')::date;
 seconds integer; cleanup_seconds integer; new_window jsonb; v_manifest jsonb;
BEGIN
 SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
 SELECT * INTO job FROM app.analysis_jobs WHERE organization_id=app.current_organization_id()
   AND id=p_job AND project_id=p_project AND requested_by=app.current_user_id() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','analysis_not_found'); END IF;
 IF NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings)
   THEN RETURN jsonb_build_object('error','analysis_forbidden'); END IF;
 IF job.state<>'awaiting_upload' THEN RETURN app.analysis_job_record(job); END IF;
 IF job.expires_at<=moment THEN RETURN jsonb_build_object('error','analysis_upload_expired'); END IF;
 IF jsonb_typeof(p_object) IS DISTINCT FROM 'object'
   OR p_object-ARRAY['bucket','key','version_id','size_bytes','checksum_sha256','content_type']<>'{}'::jsonb
   OR p_object->>'bucket' IS DISTINCT FROM job.bucket OR p_object->>'key' IS DISTINCT FROM job.object_prefix||'snapshot.json'
   OR p_object->'size_bytes' IS DISTINCT FROM job.snapshot->'size_bytes'
   OR p_object->'checksum_sha256' IS DISTINCT FROM job.snapshot->'checksum_sha256'
   OR p_object->>'content_type' IS DISTINCT FROM 'application/json'
   OR char_length(COALESCE(p_object->>'version_id','')) NOT BETWEEN 1 AND 1024
   OR p_object->>'version_id'='null' THEN RETURN jsonb_build_object('error','analysis_snapshot_mismatch'); END IF;
 -- Existing draft is already counted: compare quotas excluding this exact row.
 policy:=app.analysis_policy_ready(job.profiles_sha256,job.queue_url,false);
 IF policy->>'ready'<>'true'
   THEN RETURN jsonb_build_object('error',policy->>'reason'); END IF;
 IF EXISTS(SELECT 1 FROM app.analysis_jobs WHERE id<>job.id
   AND (state IN ('dispatch_pending','pending','running','cancel_requested') OR cleanup->>'cleanup_required'='true'))
   THEN RETURN jsonb_build_object('error','analysis_runtime_busy'); END IF;
 IF control.window_state IS NULL THEN
   seconds:=(control.configuration->>'windowSeconds')::integer;
   cleanup_seconds:=(control.configuration->>'cleanupSeconds')::integer;
   new_window:=jsonb_build_object('id',gen_random_uuid()::text,'started_at',floor(extract(epoch FROM moment))::bigint,
     'deadline',floor(extract(epoch FROM moment))::bigint+seconds,
     'cleanup_deadline',floor(extract(epoch FROM moment))::bigint+seconds+cleanup_seconds,
     'endpoint_hash',control.configuration->>'endpointHash','worker_hash',control.configuration->>'workerHash',
     'shared_endpoint_id',control.configuration->>'sharedEndpointId','shared_endpoint_hash',control.configuration->>'sharedEndpointHash',
     'phase','endpoints','endpoint_id',NULL,'worker_id',NULL,'outcome',NULL,
     'endpoint_requested',false,'worker_requested',false,'worker_service_name',NULL);
   UPDATE app.analysis_runtime_control SET window_state=new_window,budget_day=today,
     starts_today=CASE WHEN budget_day=today THEN starts_today+1 ELSE 1 END,
     total_windows=total_windows+1,reserved_seconds=reserved_seconds+seconds+cleanup_seconds,updated_at=moment
     WHERE singleton RETURNING * INTO control;
 END IF;
 v_manifest:=jsonb_build_object('schemaVersion','opengeo.analysis.manifest.1','job_id',job.id,
   'organization_id',job.organization_id,'project_id',job.project_id,'requestor_id',job.requested_by,
   'language',job.language,'layer_ids',job.snapshot->'layer_ids','source_bindings',job.source_bindings,
   'input',p_object-'content_type','profile',job.profile,
   'output',jsonb_build_object('bucket',job.bucket,'key',job.object_prefix||'result.json'));
 UPDATE app.analysis_jobs SET state='dispatch_pending',input_object=p_object,manifest=v_manifest,
   manifest_sha256=encode(public.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex'),
   window_id=(control.window_state->>'id')::uuid,updated_at=moment WHERE id=job.id RETURNING * INTO job;
 RETURN app.analysis_job_record(job);
END $$;

CREATE FUNCTION app.analysis_job_dispatched(p_project uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE;
BEGIN
 SELECT * INTO job FROM app.analysis_jobs WHERE organization_id=app.current_organization_id() AND id=p_job
   AND project_id=p_project AND requested_by=app.current_user_id() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','analysis_not_found'); END IF;
 IF NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings)
   THEN RETURN jsonb_build_object('error','analysis_forbidden'); END IF;
 IF job.state='dispatch_pending' THEN UPDATE app.analysis_jobs SET state='pending',updated_at=clock_timestamp()
   WHERE id=job.id RETURNING * INTO job; END IF;
 RETURN app.analysis_job_record(job);
END $$;

CREATE FUNCTION app.cancel_analysis_job(p_project uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE;
BEGIN
 -- Cancelling one's own work confers no read/source/copy authority. It remains
 -- possible after edit/source revocation while authenticated in this account.
 SELECT * INTO job FROM app.analysis_jobs WHERE organization_id=app.current_organization_id() AND id=p_job
   AND project_id=p_project AND requested_by=app.current_user_id() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','analysis_not_found'); END IF;
 IF job.state IN ('awaiting_upload','dispatch_pending','pending') THEN
   UPDATE app.analysis_jobs SET state='cancelled',updated_at=clock_timestamp(),error_code='analysis_cancelled',
     cleanup='{"container_removed":true,"staging_removed":true,"cleanup_required":false}'::jsonb
     WHERE id=job.id RETURNING * INTO job;
 ELSIF job.state='running' THEN UPDATE app.analysis_jobs SET state='cancel_requested',updated_at=clock_timestamp()
   WHERE id=job.id RETURNING * INTO job; END IF;
 RETURN jsonb_build_object('job_id',job.id,'request_key',job.request_key,'state',job.state,'language',job.language,
   'cleanup_required',COALESCE((job.cleanup->>'cleanup_required')::boolean,job.state IN ('running','cancel_requested')));
END $$;

CREATE FUNCTION app.analysis_window_authorized(job app.analysis_jobs)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.analysis_runtime_control control WHERE singleton
   AND control.configuration->'enabled'='true'::jsonb
   AND control.configuration->>'analysisProfilesSha256'=job.profiles_sha256
   AND control.configuration->>'analysisQueueUrl'=job.queue_url
   AND control.window_state->>'worker_hash'=control.configuration->>'workerHash'
   AND control.window_state->>'endpoint_hash'=control.configuration->>'endpointHash'
   AND control.window_state->>'shared_endpoint_id'=control.configuration->>'sharedEndpointId'
   AND control.window_state->>'shared_endpoint_hash'=control.configuration->>'sharedEndpointHash'
   AND control.window_state->>'id'=job.window_id::text
   AND control.window_state->>'phase'='processing'
   AND COALESCE(control.window_state->>'worker_id','') LIKE 'arn:%:cloudformation:%:stack/%'
   AND (control.window_state->>'deadline')::numeric>extract(epoch FROM clock_timestamp()))
$$;

CREATE FUNCTION app.claim_analysis_job(p_job uuid,p_token uuid,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE; control app.analysis_runtime_control%ROWTYPE;
BEGIN
 IF p_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 120 THEN RETURN jsonb_build_object('state','terminal','job_id',p_job); END IF;
 SELECT * INTO job FROM app.analysis_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','terminal','job_id',p_job); END IF;
 IF job.state='running' AND job.lease_until<=clock_timestamp() THEN
   UPDATE app.analysis_jobs SET state='cancel_requested',error_code='analysis_lease_expired',
     cleanup='{"cleanup_required":true,"container_removed":false,"staging_removed":false}'::jsonb,
     updated_at=clock_timestamp() WHERE id=job.id;
   RETURN jsonb_build_object('state','terminal','job_id',p_job);
 END IF;
 IF job.state='cancelled' THEN RETURN jsonb_build_object('state','cancelled','job_id',p_job); END IF;
 IF job.state IN ('succeeded','failed','cancel_requested') THEN RETURN jsonb_build_object('state','terminal','job_id',p_job); END IF;
 IF job.state='running' OR job.state='awaiting_upload' THEN RETURN jsonb_build_object('state','busy','job_id',p_job); END IF;
 IF NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings) THEN
   UPDATE app.analysis_jobs SET state='failed',error_code='analysis_source_access_changed',
     cleanup='{"cleanup_required":false,"container_removed":true,"staging_removed":true}'::jsonb,
     updated_at=clock_timestamp() WHERE id=job.id;
   RETURN jsonb_build_object('state','unauthorized','job_id',p_job);
 END IF;
 IF NOT app.analysis_window_authorized(job) THEN
   -- Startup may precede controller adoption. Closing/expired/reconfigured
   -- windows cannot execute this pending snapshot later or keep a host waiting.
   SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton;
   IF control.window_state->>'id' IS DISTINCT FROM job.window_id::text
     OR control.window_state->>'phase' NOT IN ('endpoints','worker','processing')
     OR COALESCE((control.window_state->>'deadline')::numeric,0)<=extract(epoch FROM clock_timestamp())
     OR control.configuration->'enabled' IS DISTINCT FROM 'true'::jsonb
     OR control.configuration->>'analysisProfilesSha256' IS DISTINCT FROM job.profiles_sha256
     OR control.configuration->>'analysisQueueUrl' IS DISTINCT FROM job.queue_url THEN
     UPDATE app.analysis_jobs SET state='cancelled',error_code='analysis_window_closed',
       cleanup='{"cleanup_required":false,"container_removed":true,"staging_removed":true}'::jsonb,
       updated_at=clock_timestamp() WHERE id=job.id;
     RETURN jsonb_build_object('state','cancelled','job_id',p_job);
   END IF;
   RETURN jsonb_build_object('state','busy','job_id',p_job);
 END IF;
 IF job.attempt_count<>0 OR job.manifest IS NULL THEN RETURN jsonb_build_object('state','terminal','job_id',p_job); END IF;
 IF EXISTS(SELECT 1 FROM app.analysis_jobs other WHERE other.id<>job.id AND
   (other.state IN ('running','cancel_requested') OR other.cleanup->>'cleanup_required'='true')) THEN
   RETURN jsonb_build_object('state','busy','job_id',p_job); END IF;
 UPDATE app.analysis_jobs SET state='running',lease_token=p_token,
   lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempt_count=1,
   updated_at=clock_timestamp() WHERE id=job.id RETURNING * INTO job;
 SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton;
 RETURN jsonb_build_object('state','claimed','job_id',job.id,'lease_token',p_token,
   'manifest_json',job.manifest::text,'manifest_sha256',job.manifest_sha256,'attempt_count',job.attempt_count,
   'runtime',jsonb_build_object('window_id',job.window_id,'stack_id',control.window_state->>'worker_id',
      'profiles_sha256',job.profiles_sha256));
END $$;

CREATE FUNCTION app.heartbeat_analysis_job(p_job uuid,p_token uuid,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE;
BEGIN
 SELECT * INTO job FROM app.analysis_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 120
   OR job.lease_token IS DISTINCT FROM p_token OR job.lease_until<=clock_timestamp()
   THEN RETURN jsonb_build_object('state','lease_lost'); END IF;
 IF job.state='cancel_requested' THEN RETURN jsonb_build_object('state','cancel_requested'); END IF;
 IF job.state<>'running' THEN RETURN jsonb_build_object('state','lease_lost'); END IF;
 IF NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings)
   OR NOT app.analysis_window_authorized(job) THEN
   UPDATE app.analysis_jobs SET state='cancel_requested',error_code='analysis_source_access_changed',updated_at=clock_timestamp()
     WHERE id=job.id;
   RETURN jsonb_build_object('state','unauthorized');
 END IF;
 UPDATE app.analysis_jobs SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
   WHERE id=job.id;
 RETURN jsonb_build_object('state','running');
END $$;
CREATE FUNCTION app.stage_analysis_job(p_job uuid,p_token uuid,p_lease_seconds integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
 SELECT app.heartbeat_analysis_job(p_job,p_token,p_lease_seconds)
$$;

CREATE FUNCTION app.complete_analysis_job(p_job uuid,p_token uuid,p_result jsonb,p_execution jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE; exit_code integer;
BEGIN
 SELECT * INTO job FROM app.analysis_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL OR job.lease_token IS DISTINCT FROM p_token
   OR job.lease_until<=clock_timestamp() OR job.state<>'running'
   OR NOT app.analysis_actor_authorized(job.organization_id,job.project_id,job.requested_by,job.source_bindings)
   OR NOT app.analysis_window_authorized(job) THEN RETURN false; END IF;
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object'
   OR p_result-ARRAY['bucket','key','version_id','size_bytes','checksum_sha256','content_type']<>'{}'::jsonb
   OR p_result->>'bucket' IS DISTINCT FROM job.bucket OR p_result->>'key' IS DISTINCT FROM job.object_prefix||'result.json'
   OR COALESCE(p_result->>'size_bytes','') !~ '^[0-9]{1,7}$'
   OR (p_result->>'size_bytes')::integer NOT BETWEEN 1 AND 9437184
   OR COALESCE(p_result->>'checksum_sha256','') !~ '^[0-9a-f]{64}$'
   OR char_length(COALESCE(p_result->>'version_id','')) NOT BETWEEN 1 AND 1024 OR p_result->>'version_id'='null'
   OR (p_result ? 'content_type' AND p_result->>'content_type'<>'application/json')
   OR jsonb_typeof(p_execution) IS DISTINCT FROM 'object' OR octet_length(p_execution::text)>16384
   OR p_execution#>'{cleanup,containerRemoved}' IS DISTINCT FROM 'true'::jsonb
   OR p_execution#>'{cleanup,stagingRemoved}' IS DISTINCT FROM 'true'::jsonb
   OR p_execution->>'runtimeImage' IS DISTINCT FROM job.profile->>'image'
   OR p_execution->>'interpreter' IS DISTINCT FROM job.profile->>'interpreter'
   OR p_execution->>'language' IS DISTINCT FROM job.language
   OR p_execution->>'network' IS DISTINCT FROM 'none'
   OR p_execution->>'jobId' IS DISTINCT FROM job.id::text
   OR p_execution->>'manifestSha256' IS DISTINCT FROM job.manifest_sha256
   OR p_execution->>'snapshotSha256' IS DISTINCT FROM job.snapshot->>'checksum_sha256'
   OR p_execution->>'inputCustody' IS DISTINCT FROM 'user-provided-snapshot'
   OR jsonb_typeof(p_execution->'exitCode') IS DISTINCT FROM 'number'
   OR COALESCE(p_execution->>'exitCode','') !~ '^-?[0-9]{1,3}$'
   THEN RETURN false; END IF;
 exit_code:=(p_execution->>'exitCode')::integer;
 UPDATE app.analysis_jobs SET state=CASE WHEN exit_code=0 THEN 'succeeded' ELSE 'failed' END,
   result=p_result,execution=p_execution,error_code=CASE WHEN exit_code=0 THEN NULL ELSE 'analysis_process_failed' END,
   cleanup='{"cleanup_required":false,"container_removed":true,"staging_removed":true}'::jsonb,
   lease_until=NULL,updated_at=clock_timestamp() WHERE id=job.id;
 RETURN true;
END $$;

CREATE FUNCTION app.fail_analysis_job(p_job uuid,p_token uuid,p_code text,p_cleanup jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE job app.analysis_jobs%ROWTYPE; complete boolean;
BEGIN
 SELECT * INTO job FROM app.analysis_jobs WHERE id=p_job FOR UPDATE;
 -- A cleanup-only acknowledgement of this same single-use token is safe after
 -- expiry/revocation; it cannot adopt outputs or replace another attempt.
 IF NOT FOUND OR p_token IS NULL OR job.lease_token IS DISTINCT FROM p_token
   OR job.state NOT IN ('running','cancel_requested')
   OR p_code IS NULL OR p_code NOT IN ('analysis_cancelled','analysis_timeout','analysis_failed','analysis_cleanup_failed',
      'analysis_lease_lost','analysis_input_invalid','analysis_result_invalid','analysis_storage_failed',
      'analysis_source_access_changed','analysis_profile_unavailable')
   OR jsonb_typeof(p_cleanup) IS DISTINCT FROM 'object' OR octet_length(p_cleanup::text)>4096
   OR p_cleanup-ARRAY['container_removed','staging_removed','cleanup_required','container_name','staging_directory','output_uncommitted']<>'{}'::jsonb
   OR jsonb_typeof(p_cleanup->'container_removed') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_cleanup->'staging_removed') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_cleanup->'cleanup_required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
 complete:=p_cleanup->'container_removed'='true'::jsonb AND p_cleanup->'staging_removed'='true'::jsonb
   AND p_cleanup->'cleanup_required'='false'::jsonb;
 IF p_cleanup->'cleanup_required'='false'::jsonb AND NOT complete THEN RETURN false; END IF;
 IF p_cleanup ? 'output_uncommitted' AND (p_cleanup#>>'{output_uncommitted,bucket}' IS DISTINCT FROM job.bucket
   OR p_cleanup#>>'{output_uncommitted,key}' IS DISTINCT FROM job.object_prefix||'result.json') THEN RETURN false; END IF;
 UPDATE app.analysis_jobs SET state=CASE WHEN complete AND (job.state='cancel_requested' OR p_code='analysis_cancelled')
   THEN 'cancelled' ELSE 'failed' END,error_code=p_code,cleanup=p_cleanup,
   lease_until=NULL,updated_at=clock_timestamp() WHERE id=job.id;
 RETURN true;
END $$;

CREATE FUNCTION app.request_cancel_analysis_window(p_window uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE changed integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.analysis_runtime_control WHERE singleton AND window_state->>'id'=p_window::text)
   THEN RETURN jsonb_build_object('cancel_requested',0); END IF;
 UPDATE app.analysis_jobs SET state=CASE WHEN state IN ('dispatch_pending','pending') THEN 'cancelled' ELSE 'cancel_requested' END,
   error_code='analysis_window_closed',cleanup=CASE WHEN state IN ('dispatch_pending','pending')
     THEN '{"cleanup_required":false,"container_removed":true,"staging_removed":true}'::jsonb ELSE cleanup END,
   updated_at=clock_timestamp() WHERE window_id=p_window AND state IN ('dispatch_pending','pending','running');
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN jsonb_build_object('cancel_requested',changed);
END $$;

CREATE FUNCTION app.finalize_analysis_window_cleanup(p_window uuid,p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=off AS $$
DECLARE changed integer; control app.analysis_runtime_control%ROWTYPE;
BEGIN
 SELECT * INTO control FROM app.analysis_runtime_control WHERE singleton FOR UPDATE;
 IF p_window IS NULL OR control.window_state->>'id' IS DISTINCT FROM p_window::text
   OR control.window_state->>'phase' NOT IN ('remove-worker','remove-endpoints')
   OR control.window_state->>'worker_id' IS DISTINCT FROM p_worker
   OR NOT COALESCE(((p_worker IS NOT NULL AND p_worker LIKE 'arn:%:cloudformation:%:stack/%')
     OR (p_worker IS NULL AND control.window_state->'worker_requested'='false'::jsonb)),false)
   THEN RETURN jsonb_build_object('error','analysis_cleanup_binding_changed'); END IF;
 -- Trusted lifecycle caller proves exact ASG absence and all tagged instances
 -- terminated before invoking this function. It never receives source/result bytes.
 UPDATE app.analysis_jobs SET state=CASE WHEN state IN ('dispatch_pending','pending','running','cancel_requested')
   THEN 'cancelled' ELSE state END,cleanup=jsonb_build_object('host_absent',true,'cleanup_required',false,
     'container_removed',true,'staging_removed',true,'worker_id',p_worker),lease_until=NULL,updated_at=clock_timestamp()
   WHERE window_id=p_window AND (state IN ('dispatch_pending','pending','running','cancel_requested') OR cleanup->>'cleanup_required'='true');
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN jsonb_build_object('finalized',changed);
END $$;


CREATE FUNCTION app.enforce_analysis_job_immutability()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'analysis job history is immutable' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.organization_id,NEW.id,NEW.project_id,NEW.requested_by,NEW.request_key,NEW.language,
     NEW.request_definition,NEW.snapshot,NEW.source_bindings,NEW.profile,NEW.profiles_sha256,
     NEW.queue_url,NEW.bucket,NEW.object_prefix,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.project_id,OLD.requested_by,OLD.request_key,OLD.language,
     OLD.request_definition,OLD.snapshot,OLD.source_bindings,OLD.profile,OLD.profiles_sha256,
     OLD.queue_url,OLD.bucket,OLD.object_prefix,OLD.created_at,OLD.expires_at)
   OR (OLD.manifest IS NOT NULL AND ROW(NEW.input_object,NEW.manifest,NEW.manifest_sha256,NEW.window_id)
     IS DISTINCT FROM ROW(OLD.input_object,OLD.manifest,OLD.manifest_sha256,OLD.window_id))
   OR (OLD.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token)
   OR NEW.attempt_count<OLD.attempt_count
   OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.execution) IS DISTINCT FROM ROW(OLD.result,OLD.execution))
   OR (OLD.state IN ('succeeded','failed','cancelled') AND NEW.state IS DISTINCT FROM OLD.state)
   THEN RAISE EXCEPTION 'analysis snapshot, identity, execution and history are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER analysis_job_immutable BEFORE UPDATE OR DELETE ON app.analysis_jobs
 FOR EACH ROW EXECUTE FUNCTION app.enforce_analysis_job_immutability();

-- No role receives arbitrary job/control DML or another worker's credentials.
REVOKE ALL ON app.analysis_jobs,app.analysis_runtime_control
 FROM PUBLIC,opengeo_runtime,opengeo_worker,opengeo_connector,opengeo_analysis_runtime,opengeo_analysis_controller;
REVOKE EXECUTE ON FUNCTION
 app.analysis_actor_authorized(uuid,uuid,uuid,jsonb),
 app.analysis_policy_ready(text,text,boolean),app.analysis_job_record(app.analysis_jobs),
 app.analysis_window_authorized(app.analysis_jobs),app.enforce_analysis_job_immutability(),
 app.analysis_job_capabilities(uuid,boolean,text,text),
 app.create_analysis_job(uuid,uuid,text,jsonb,jsonb,jsonb,text,text,text),
 app.read_analysis_job(uuid,uuid),app.find_analysis_job(uuid,uuid),
 app.submit_analysis_job(uuid,uuid,jsonb),app.analysis_job_dispatched(uuid,uuid),app.cancel_analysis_job(uuid,uuid),
 app.claim_analysis_job(uuid,uuid,integer),app.stage_analysis_job(uuid,uuid,integer),
 app.heartbeat_analysis_job(uuid,uuid,integer),app.complete_analysis_job(uuid,uuid,jsonb,jsonb),
 app.fail_analysis_job(uuid,uuid,text,jsonb),app.request_cancel_analysis_window(uuid),
 app.finalize_analysis_window_cleanup(uuid,text)
 FROM PUBLIC,opengeo_runtime,opengeo_worker,opengeo_connector,opengeo_analysis_runtime,opengeo_analysis_controller;
GRANT USAGE ON SCHEMA app TO opengeo_analysis_runtime,opengeo_analysis_controller;
GRANT EXECUTE ON FUNCTION
 app.analysis_job_capabilities(uuid,boolean,text,text),
 app.create_analysis_job(uuid,uuid,text,jsonb,jsonb,jsonb,text,text,text),
 app.read_analysis_job(uuid,uuid),app.find_analysis_job(uuid,uuid),app.submit_analysis_job(uuid,uuid,jsonb),
 app.analysis_job_dispatched(uuid,uuid),app.cancel_analysis_job(uuid,uuid)
 TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.claim_analysis_job(uuid,uuid,integer),app.stage_analysis_job(uuid,uuid,integer),
 app.heartbeat_analysis_job(uuid,uuid,integer),app.complete_analysis_job(uuid,uuid,jsonb,jsonb),
 app.fail_analysis_job(uuid,uuid,text,jsonb) TO opengeo_analysis_runtime;
GRANT EXECUTE ON FUNCTION app.request_cancel_analysis_window(uuid),app.finalize_analysis_window_cleanup(uuid,text)
 TO opengeo_analysis_controller;
COMMENT ON TABLE app.analysis_jobs IS
 'Requestor-private single-attempt analysis of caller-provided copied snapshots, with current source-copy authority and immutable input/result object versions. No catalog content is created.';
COMMENT ON TABLE app.analysis_runtime_control IS
 'Independent default-off analysis admission, cumulative reservations and lifecycle leases. Existing GIS/PMTiles counters are never reset or reused.';
COMMIT;
