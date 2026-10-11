BEGIN;

CREATE TYPE app.observable_source_rights_status AS ENUM (
  'unreviewed',
  'approved',
  'rejected'
);

CREATE TYPE app.observable_source_upload_state AS ENUM (
  'pending',
  'committed'
);

CREATE TYPE app.observable_build_purpose AS ENUM (
  'preview',
  'release_candidate'
);

CREATE TYPE app.observable_build_state AS ENUM (
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE FUNCTION app.observable_source_path_is_safe(p_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    p_path IS NOT NULL
    AND char_length(p_path) BETWEEN 1 AND 512
    AND p_path ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$'
    AND p_path !~* '(^|/)(node_modules|dist|build|cache|\.git|\.aws|\.ssh)(/|$)'
    AND p_path !~* '(^|/)(\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$'
$$;

CREATE FUNCTION app.observable_source_media_is_supported(
  p_path text,
  p_content_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_path ~* '\.md$' THEN p_content_type = 'text/markdown'
    WHEN p_path ~* '\.(?:js|mjs)$' THEN p_content_type = 'text/javascript'
    WHEN p_path ~* '\.css$' THEN p_content_type = 'text/css'
    WHEN p_path ~* '\.(?:json|geojson)$' THEN p_content_type IN (
      'application/json', 'application/geo+json'
    )
    WHEN p_path ~* '\.csv$' THEN p_content_type = 'text/csv'
    WHEN p_path ~* '\.txt$' THEN p_content_type = 'text/plain'
    WHEN p_path ~* '\.html$' THEN p_content_type = 'text/html'
    WHEN p_path ~* '\.svg$' THEN p_content_type = 'image/svg+xml'
    WHEN p_path ~* '\.png$' THEN p_content_type = 'image/png'
    WHEN p_path ~* '\.(?:jpg|jpeg)$' THEN p_content_type = 'image/jpeg'
    ELSE false
  END
$$;

CREATE FUNCTION app.observable_output_path_is_safe(p_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    p_path IS NOT NULL
    AND char_length(p_path) BETWEEN 6 AND 512
    AND p_path ~ '^dist/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}(?:/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}){0,7}$'
    AND p_path !~* '(^|/)(node_modules|build|cache|\.git|\.aws|\.ssh)(/|$)'
    AND p_path !~* '(^|/)(\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$'
$$;

CREATE TABLE app.observable_source_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  route_namespace text NOT NULL,
  title text NOT NULL,
  rights_status app.observable_source_rights_status NOT NULL DEFAULT 'unreviewed',
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  current_revision_id uuid,
  current_revision_number bigint NOT NULL DEFAULT 0,
  compiler_image_digest text NOT NULL,
  framework_version text NOT NULL DEFAULT '1.13.4',
  lockfile_format text NOT NULL DEFAULT 'npm-package-lock-v3',
  network_policy text NOT NULL DEFAULT 'deny_all',
  resource_limits jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, site_id),
  CONSTRAINT observable_source_projects_route_bounded CHECK (
    route_namespace ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
  ),
  CONSTRAINT observable_source_projects_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT observable_source_projects_head_shape CHECK (
    (current_revision_number = 0 AND current_revision_id IS NULL)
    OR (current_revision_number > 0 AND current_revision_id IS NOT NULL)
  ),
  CONSTRAINT observable_source_projects_compiler_pinned CHECK (
    compiler_image_digest ~ '^sha256:[0-9a-f]{64}$'
    AND framework_version = '1.13.4'
    AND lockfile_format = 'npm-package-lock-v3'
    AND network_policy = 'deny_all'
  ),
  CONSTRAINT observable_source_projects_limits_bounded CHECK (
    jsonb_typeof(resource_limits) = 'object'
    AND octet_length(resource_limits::text) <= 1024
    AND resource_limits ?& ARRAY[
      'cpuMillis', 'memoryMiB', 'timeoutSeconds', 'maxInputFiles',
      'maxInputBytes', 'maxOutputFiles', 'maxOutputBytes'
    ]
    AND resource_limits - ARRAY[
      'cpuMillis', 'memoryMiB', 'timeoutSeconds', 'maxInputFiles',
      'maxInputBytes', 'maxOutputFiles', 'maxOutputBytes'
    ] = '{}'::jsonb
    AND (resource_limits->>'cpuMillis')::integer BETWEEN 250 AND 4000
    AND (resource_limits->>'memoryMiB')::integer BETWEEN 256 AND 8192
    AND (resource_limits->>'timeoutSeconds')::integer BETWEEN 10 AND 600
    AND (resource_limits->>'maxInputFiles')::integer BETWEEN 1 AND 128
    AND (resource_limits->>'maxInputBytes')::bigint BETWEEN 1 AND 16777216
    AND (resource_limits->>'maxOutputFiles')::integer BETWEEN 1 AND 512
    AND (resource_limits->>'maxOutputBytes')::bigint BETWEEN 1 AND 33554432
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, site_id)
    REFERENCES app.project_sites (organization_id, project_id, id),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES app.organization_memberships (organization_id, user_id)
);

CREATE TABLE app.observable_source_file_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  relative_path text NOT NULL,
  expected_content_type text NOT NULL,
  expected_size_bytes bigint NOT NULL,
  expected_sha256 text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  state app.observable_source_upload_state NOT NULL DEFAULT 'pending',
  completed_object_id uuid,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_project_id, id),
  UNIQUE (bucket, object_key),
  CONSTRAINT observable_source_upload_intents_path_safe CHECK (
    app.observable_source_path_is_safe(relative_path)
    AND app.observable_source_media_is_supported(relative_path, expected_content_type)
  ),
  CONSTRAINT observable_source_upload_intents_facts_bounded CHECK (
    expected_size_bytes BETWEEN 1 AND 4194304
    AND expected_sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(bucket) BETWEEN 3 AND 63
    AND char_length(object_key) BETWEEN 1 AND 1024
    AND expires_at > created_at
    AND expires_at <= created_at + interval '1 hour'
  ),
  CONSTRAINT observable_source_upload_intents_completion_shape CHECK (
    (state = 'pending' AND completed_object_id IS NULL AND completed_at IS NULL)
    OR (state = 'committed' AND completed_object_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id)
);

CREATE TABLE app.observable_source_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  upload_intent_id uuid NOT NULL,
  relative_path text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  s3_version_id text NOT NULL,
  etag text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_project_id, id),
  UNIQUE (organization_id, upload_intent_id),
  UNIQUE (bucket, object_key, s3_version_id),
  CONSTRAINT observable_source_objects_path_safe CHECK (
    app.observable_source_path_is_safe(relative_path)
    AND app.observable_source_media_is_supported(relative_path, content_type)
  ),
  CONSTRAINT observable_source_objects_facts_bounded CHECK (
    size_bytes BETWEEN 1 AND 4194304
    AND checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(bucket) BETWEEN 3 AND 63
    AND char_length(object_key) BETWEEN 1 AND 1024
    AND char_length(s3_version_id) BETWEEN 1 AND 1024
    AND char_length(etag) BETWEEN 1 AND 512
  ),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (organization_id, source_project_id, upload_intent_id)
    REFERENCES app.observable_source_file_upload_intents (
      organization_id, source_project_id, id
    )
);

ALTER TABLE app.observable_source_file_upload_intents
  ADD CONSTRAINT observable_source_upload_intents_completed_object_fk
  FOREIGN KEY (organization_id, source_project_id, completed_object_id)
  REFERENCES app.observable_source_objects (organization_id, source_project_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.observable_source_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  parent_revision_id uuid,
  title text NOT NULL,
  rights_status app.observable_source_rights_status NOT NULL,
  entry_path text NOT NULL,
  lockfile_path text,
  manifest jsonb NOT NULL,
  manifest_checksum_sha256 text NOT NULL,
  change_summary text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_project_id, id),
  UNIQUE (organization_id, project_id, source_project_id, id),
  UNIQUE (organization_id, source_project_id, revision_number),
  CONSTRAINT observable_source_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT observable_source_revisions_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT observable_source_revisions_paths_safe CHECK (
    app.observable_source_path_is_safe(entry_path)
    AND entry_path ~* '\.md$'
    AND (
      lockfile_path IS NULL
      OR (
        app.observable_source_path_is_safe(lockfile_path)
        AND lockfile_path = 'package-lock.json'
      )
    )
  ),
  CONSTRAINT observable_source_revisions_manifest_bounded CHECK (
    jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 131072
    AND jsonb_typeof(manifest->'files') = 'array'
    AND jsonb_array_length(manifest->'files') BETWEEN 1 AND 128
    AND manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT observable_source_revisions_change_bounded CHECK (
    change_summary = btrim(change_summary)
    AND char_length(change_summary) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (organization_id, source_project_id, parent_revision_id)
    REFERENCES app.observable_source_revisions (organization_id, source_project_id, id)
);

ALTER TABLE app.observable_source_projects
  ADD CONSTRAINT observable_source_projects_current_revision_fk
  FOREIGN KEY (organization_id, id, current_revision_id)
  REFERENCES app.observable_source_revisions (organization_id, source_project_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.observable_source_revision_files (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  relative_path text NOT NULL,
  source_object_id uuid NOT NULL,
  position integer NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, source_revision_id, relative_path),
  UNIQUE (organization_id, source_revision_id, source_object_id),
  UNIQUE (organization_id, source_revision_id, position),
  CONSTRAINT observable_source_revision_files_path_safe CHECK (
    app.observable_source_path_is_safe(relative_path)
    AND position BETWEEN 0 AND 127
  ),
  FOREIGN KEY (organization_id, project_id, source_project_id, source_revision_id)
    REFERENCES app.observable_source_revisions (
      organization_id, project_id, source_project_id, id
    ),
  FOREIGN KEY (organization_id, source_project_id, source_object_id)
    REFERENCES app.observable_source_objects (organization_id, source_project_id, id)
);

CREATE TABLE app.observable_build_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_revision_number bigint NOT NULL,
  purpose app.observable_build_purpose NOT NULL,
  state app.observable_build_state NOT NULL DEFAULT 'pending',
  request jsonb NOT NULL,
  request_checksum_sha256 text NOT NULL,
  output_prefix text NOT NULL,
  result jsonb,
  result_checksum_sha256 text,
  attempt_count integer NOT NULL DEFAULT 0,
  coordinator_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  error_code text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  CONSTRAINT observable_build_jobs_request_bounded CHECK (
    jsonb_typeof(request) = 'object'
    AND octet_length(request::text) <= 135168
    AND request_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND char_length(output_prefix) BETWEEN 1 AND 1024
  ),
  CONSTRAINT observable_build_jobs_result_bounded CHECK (
    (result IS NULL AND result_checksum_sha256 IS NULL)
    OR (
      jsonb_typeof(result) = 'object'
      AND octet_length(result::text) <= 262144
      AND result_checksum_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT observable_build_jobs_runtime_shape CHECK (
    attempt_count BETWEEN 0 AND 10
    AND (
      (state = 'pending'
        AND coordinator_token IS NULL
        AND lease_expires_at IS NULL
        AND last_heartbeat_at IS NULL
        AND result IS NULL
        AND finished_at IS NULL)
      OR (state = 'running'
        AND coordinator_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND last_heartbeat_at IS NOT NULL
        AND started_at IS NOT NULL
        AND result IS NULL
        AND finished_at IS NULL)
      OR (state = 'succeeded'
        AND coordinator_token IS NULL
        AND lease_expires_at IS NULL
        AND last_heartbeat_at IS NULL
        AND result IS NOT NULL
        AND error_code IS NULL
        AND finished_at IS NOT NULL)
      OR (state IN ('failed', 'cancelled')
        AND coordinator_token IS NULL
        AND lease_expires_at IS NULL
        AND last_heartbeat_at IS NULL
        AND result IS NULL
        AND error_code IS NOT NULL
        AND finished_at IS NOT NULL)
    )
  ),
  CONSTRAINT observable_build_jobs_error_bounded CHECK (
    error_code IS NULL
    OR (
      error_code ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
      AND char_length(error_code) <= 100
    )
  ),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects (organization_id, project_id, id),
  FOREIGN KEY (
    organization_id, source_project_id, source_revision_id
  ) REFERENCES app.observable_source_revisions (
    organization_id, source_project_id, id
  )
);

CREATE INDEX observable_source_projects_site_idx
  ON app.observable_source_projects (organization_id, project_id, site_id);
CREATE INDEX observable_source_upload_intents_pending_idx
  ON app.observable_source_file_upload_intents (
    organization_id, project_id, source_project_id, expires_at
  ) WHERE state = 'pending';
CREATE INDEX observable_source_revisions_history_idx
  ON app.observable_source_revisions (
    organization_id, project_id, source_project_id, revision_number DESC
  );
CREATE INDEX observable_build_jobs_project_idx
  ON app.observable_build_jobs (
    organization_id, project_id, source_project_id, created_at DESC
  );
CREATE INDEX observable_build_jobs_expired_lease_idx
  ON app.observable_build_jobs (lease_expires_at, id) WHERE state = 'running';

CREATE FUNCTION app.enforce_observable_source_project_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_site_slug text;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.owner_user_id IS DISTINCT FROM app.current_user_id()
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NEW.updated_by IS DISTINCT FROM app.current_user_id()
    OR NEW.current_revision_number <> 0
    OR NEW.current_revision_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'Observable source project insert scope is invalid';
  END IF;
  SELECT slug INTO v_site_slug
  FROM app.project_sites
  WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id
    AND id = NEW.site_id;
  IF NOT FOUND OR NEW.route_namespace <> v_site_slug THEN
    RAISE EXCEPTION 'Observable source project must bind the exact governed site route';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_source_upload_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'pending'
    OR NEW.state <> 'committed'
    OR NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.source_project_id <> OLD.source_project_id
    OR NEW.relative_path <> OLD.relative_path
    OR NEW.expected_content_type <> OLD.expected_content_type
    OR NEW.expected_size_bytes <> OLD.expected_size_bytes
    OR NEW.expected_sha256 <> OLD.expected_sha256
    OR NEW.bucket <> OLD.bucket
    OR NEW.object_key <> OLD.object_key
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.completed_object_id IS NULL
    OR NEW.completed_at IS NULL
  THEN
    RAISE EXCEPTION 'Observable source upload identity and completion are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_source_upload_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_expected_key text;
BEGIN
  v_expected_key := format(
    'organizations/%s/projects/%s/source-projects/%s/uploads/%s/files/%s',
    NEW.organization_id, NEW.project_id, NEW.source_project_id,
    NEW.id, NEW.relative_path
  );
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NEW.object_key <> v_expected_key
    OR NEW.state <> 'pending'
    OR NEW.completed_object_id IS NOT NULL
    OR NEW.completed_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Observable source upload must bind the current actor and exact private path';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_source_object_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_intent app.observable_source_file_upload_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent
  FROM app.observable_source_file_upload_intents
  WHERE organization_id = NEW.organization_id
    AND source_project_id = NEW.source_project_id
    AND id = NEW.upload_intent_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_intent.state <> 'pending'
    OR v_intent.expires_at <= clock_timestamp()
    OR v_intent.project_id <> NEW.project_id
    OR v_intent.relative_path <> NEW.relative_path
    OR v_intent.expected_content_type <> NEW.content_type
    OR v_intent.expected_size_bytes <> NEW.size_bytes
    OR v_intent.expected_sha256 <> NEW.checksum_sha256
    OR v_intent.bucket <> NEW.bucket
    OR v_intent.object_key <> NEW.object_key
    OR v_intent.created_by <> NEW.created_by
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'Observable source object does not match its active upload intent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_source_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project app.observable_source_projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project
  FROM app.observable_source_projects
  WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id
    AND id = NEW.source_project_id
  FOR UPDATE;
  IF NOT FOUND
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NEW.revision_number <> v_project.current_revision_number + 1
    OR (
      v_project.current_revision_number = 0
      AND NEW.parent_revision_id IS NOT NULL
    )
    OR (
      v_project.current_revision_number > 0
      AND NEW.parent_revision_id IS DISTINCT FROM v_project.current_revision_id
    )
  THEN
    RAISE EXCEPTION 'Observable source revision must append to the exact current head';
  END IF;
  NEW.manifest_checksum_sha256 := encode(
    digest(convert_to(NEW.manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_source_project_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision app.observable_source_revisions%ROWTYPE;
  v_files jsonb;
  v_expected_manifest jsonb;
  v_file_count integer;
  v_total_bytes bigint;
  v_case_count integer;
  v_positions_sorted boolean;
  v_entry_type text;
  v_lock_type text;
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.site_id <> OLD.site_id
    OR NEW.route_namespace <> OLD.route_namespace
    OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.compiler_image_digest <> OLD.compiler_image_digest
    OR NEW.framework_version <> OLD.framework_version
    OR NEW.lockfile_format <> OLD.lockfile_format
    OR NEW.network_policy <> OLD.network_policy
    OR NEW.resource_limits <> OLD.resource_limits
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.updated_by IS DISTINCT FROM app.current_user_id()
    OR NEW.current_revision_number <> OLD.current_revision_number + 1
  THEN
    RAISE EXCEPTION 'Observable source project head may only advance to one exact revision';
  END IF;

  SELECT * INTO v_revision
  FROM app.observable_source_revisions
  WHERE organization_id = NEW.organization_id
    AND source_project_id = NEW.id
    AND id = NEW.current_revision_id
    AND revision_number = NEW.current_revision_number;
  IF NOT FOUND
    OR v_revision.title <> NEW.title
    OR v_revision.rights_status <> NEW.rights_status
  THEN
    RAISE EXCEPTION 'Observable source project head does not match its revision';
  END IF;

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'path', file.relative_path,
        'objectId', object.id,
        'bucket', object.bucket,
        'objectKey', object.object_key,
        's3VersionId', object.s3_version_id,
        'etag', object.etag,
        'contentType', object.content_type,
        'sizeBytes', object.size_bytes,
        'checksumSha256', object.checksum_sha256
      ) ORDER BY file.relative_path
    ),
    count(*)::integer,
    COALESCE(sum(object.size_bytes), 0),
    count(DISTINCT lower(file.relative_path))::integer,
    bool_and(
      file.position = (
        SELECT count(*)::integer - 1
        FROM app.observable_source_revision_files earlier
        WHERE earlier.organization_id = file.organization_id
          AND earlier.source_revision_id = file.source_revision_id
          AND earlier.relative_path <= file.relative_path
      )
    ),
    max(object.content_type) FILTER (
      WHERE file.relative_path = v_revision.entry_path
    ),
    max(object.content_type) FILTER (
      WHERE file.relative_path = v_revision.lockfile_path
    )
  INTO v_files, v_file_count, v_total_bytes, v_case_count, v_positions_sorted,
       v_entry_type, v_lock_type
  FROM app.observable_source_revision_files file
  JOIN app.observable_source_objects object
    ON object.organization_id = file.organization_id
   AND object.source_project_id = file.source_project_id
   AND object.id = file.source_object_id
   AND object.relative_path = file.relative_path
  WHERE file.organization_id = NEW.organization_id
    AND file.source_project_id = NEW.id
    AND file.source_revision_id = v_revision.id;

  IF v_file_count NOT BETWEEN 1 AND 128
    OR v_file_count <> v_case_count
    OR NOT v_positions_sorted
    OR v_total_bytes > 16777216
    OR v_entry_type <> 'text/markdown'
    OR (v_revision.lockfile_path IS NOT NULL AND v_lock_type <> 'application/json')
    OR (
      EXISTS (
        SELECT 1 FROM app.observable_source_revision_files file
        WHERE file.organization_id = NEW.organization_id
          AND file.source_revision_id = v_revision.id
          AND file.relative_path = 'package.json'
      )
      AND v_revision.lockfile_path IS NULL
    )
  THEN
    RAISE EXCEPTION 'Observable source revision file set is invalid or incomplete';
  END IF;

  v_expected_manifest := jsonb_build_object(
    'schemaVersion', 'opengeo.observable-source-revision.1.0.0',
    'sourceProjectId', v_revision.source_project_id,
    'revisionId', v_revision.id,
    'revisionNumber', v_revision.revision_number,
    'entryPath', v_revision.entry_path,
    'lockfilePath', v_revision.lockfile_path,
    'files', v_files
  );
  IF v_revision.manifest IS DISTINCT FROM v_expected_manifest THEN
    RAISE EXCEPTION 'Observable source revision manifest does not match exact file objects';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_build_job_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project app.observable_source_projects%ROWTYPE;
  v_revision app.observable_source_revisions%ROWTYPE;
  v_lock_checksum text;
  v_expected jsonb;
  v_expected_prefix text;
BEGIN
  SELECT * INTO v_project
  FROM app.observable_source_projects
  WHERE organization_id = NEW.organization_id
    AND project_id = NEW.project_id
    AND id = NEW.source_project_id;
  SELECT * INTO v_revision
  FROM app.observable_source_revisions
  WHERE organization_id = NEW.organization_id
    AND source_project_id = NEW.source_project_id
    AND id = NEW.source_revision_id
    AND revision_number = NEW.source_revision_number;
  SELECT object.checksum_sha256 INTO v_lock_checksum
  FROM app.observable_source_revision_files file
  JOIN app.observable_source_objects object
    ON object.organization_id = file.organization_id
   AND object.source_project_id = file.source_project_id
   AND object.id = file.source_object_id
  WHERE file.organization_id = NEW.organization_id
    AND file.source_revision_id = NEW.source_revision_id
    AND file.relative_path = v_revision.lockfile_path;

  v_expected := jsonb_build_object(
    'schemaVersion', 'opengeo.observable-build-request.1.0.0',
    'sourceProjectId', NEW.source_project_id,
    'sourceRevisionId', NEW.source_revision_id,
    'sourceRevisionNumber', NEW.source_revision_number,
    'sourceManifestChecksumSha256', v_revision.manifest_checksum_sha256,
    'purpose', NEW.purpose::text,
    'compilerImageDigest', v_project.compiler_image_digest,
    'frameworkVersion', v_project.framework_version,
    'lockfileFormat', v_project.lockfile_format,
    'lockfileChecksumSha256', v_lock_checksum,
    'networkPolicy', v_project.network_policy,
    'resourceLimits', v_project.resource_limits
  );
  v_expected_prefix := format(
    'organizations/%s/projects/%s/source-projects/%s/builds/%s/output/',
    NEW.organization_id, NEW.project_id, NEW.source_project_id, NEW.id
  );
  IF v_project.id IS NULL
    OR v_revision.id IS NULL
    OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NEW.source_revision_number <> v_revision.revision_number
    OR NEW.request IS DISTINCT FROM v_expected
    OR NEW.output_prefix <> v_expected_prefix
    OR NEW.state <> 'pending'
    OR NEW.attempt_count <> 0
    OR NEW.result IS NOT NULL
    OR (NEW.purpose = 'release_candidate' AND v_revision.rights_status <> 'approved')
  THEN
    RAISE EXCEPTION 'Observable build job does not seal an eligible exact source revision';
  END IF;
  NEW.request_checksum_sha256 := encode(
    digest(convert_to(NEW.request::text, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_observable_build_job_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.source_project_id <> OLD.source_project_id
    OR NEW.source_revision_id <> OLD.source_revision_id
    OR NEW.source_revision_number <> OLD.source_revision_number
    OR NEW.purpose <> OLD.purpose
    OR NEW.request <> OLD.request
    OR NEW.request_checksum_sha256 <> OLD.request_checksum_sha256
    OR NEW.output_prefix <> OLD.output_prefix
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR NEW.attempt_count > OLD.attempt_count + 1
    OR NOT (
      (OLD.state = 'pending' AND NEW.state IN ('running', 'cancelled'))
      OR (OLD.state = 'running'
        AND NEW.state IN ('running', 'pending', 'succeeded', 'failed'))
    )
  THEN
    RAISE EXCEPTION 'Observable build job transition is invalid';
  END IF;
  IF NEW.result IS NOT NULL THEN
    NEW.result_checksum_sha256 := encode(
      digest(convert_to(NEW.result::text, 'UTF8'), 'sha256'),
      'hex'
    );
  ELSE
    NEW.result_checksum_sha256 := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.claim_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  claim_status text,
  build_job_id uuid,
  organization_id uuid,
  project_id uuid,
  source_project_id uuid,
  source_revision_id uuid,
  source_revision_number bigint,
  purpose text,
  request jsonb,
  request_checksum_sha256 text,
  input_manifest jsonb,
  input_manifest_checksum_sha256 text,
  output_prefix text,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, public
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_revision app.observable_source_revisions%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_coordinator_token IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900
  THEN
    RAISE EXCEPTION 'invalid Observable build claim';
  END IF;
  SELECT * INTO v_job
  FROM app.observable_build_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_ready', p_job_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::bigint, NULL::text, NULL::jsonb, NULL::text, NULL::jsonb, NULL::text,
      NULL::text, NULL::integer;
    RETURN;
  END IF;
  SELECT * INTO v_revision
  FROM app.observable_source_revisions revision
  WHERE revision.organization_id = v_job.organization_id
    AND revision.source_project_id = v_job.source_project_id
    AND revision.id = v_job.source_revision_id;
  IF v_job.state IN ('succeeded', 'failed', 'cancelled') THEN
    RETURN QUERY SELECT
      'already_' || v_job.state::text, v_job.id, v_job.organization_id,
      v_job.project_id, v_job.source_project_id, v_job.source_revision_id,
      v_job.source_revision_number, v_job.purpose::text, v_job.request,
      v_job.request_checksum_sha256,
      v_revision.manifest, v_revision.manifest_checksum_sha256,
      v_job.output_prefix, v_job.attempt_count;
    RETURN;
  END IF;
  IF v_job.state = 'running' AND v_job.lease_expires_at > v_now THEN
    RETURN QUERY SELECT
      'busy', v_job.id, v_job.organization_id, v_job.project_id,
      v_job.source_project_id, v_job.source_revision_id,
      v_job.source_revision_number, v_job.purpose::text, v_job.request,
      v_job.request_checksum_sha256,
      v_revision.manifest, v_revision.manifest_checksum_sha256,
      v_job.output_prefix, v_job.attempt_count;
    RETURN;
  END IF;
  UPDATE app.observable_build_jobs
  SET state = 'running',
      coordinator_token = p_coordinator_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = v_now,
      attempt_count = v_job.attempt_count + 1,
      started_at = COALESCE(v_job.started_at, v_now),
      finished_at = NULL,
      error_code = NULL,
      updated_at = v_now
  WHERE id = v_job.id;
  RETURN QUERY SELECT
    'claimed', v_job.id, v_job.organization_id, v_job.project_id,
    v_job.source_project_id, v_job.source_revision_id,
    v_job.source_revision_number, v_job.purpose::text, v_job.request,
    v_job.request_checksum_sha256,
    v_revision.manifest, v_revision.manifest_checksum_sha256,
    v_job.output_prefix, v_job.attempt_count + 1;
END;
$$;

CREATE FUNCTION app.heartbeat_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  WITH heartbeat AS (
    UPDATE app.observable_build_jobs
    SET last_heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        updated_at = clock_timestamp()
    WHERE id = p_job_id
      AND state = 'running'
      AND coordinator_token = p_coordinator_token
      AND p_lease_seconds BETWEEN 30 AND 900
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM heartbeat)
$$;

CREATE FUNCTION app.complete_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, public
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_file jsonb;
  v_file_count integer := 0;
  v_total_bytes bigint := 0;
  v_case_count integer;
  v_expected_bucket text;
BEGIN
  SELECT * INTO v_job
  FROM app.observable_build_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running'
    OR v_job.coordinator_token <> p_coordinator_token
  THEN
    RETURN false;
  END IF;
  SELECT object.bucket INTO v_expected_bucket
  FROM app.observable_source_revision_files file
  JOIN app.observable_source_objects object
    ON object.organization_id = file.organization_id
   AND object.source_project_id = file.source_project_id
   AND object.id = file.source_object_id
  WHERE file.organization_id = v_job.organization_id
    AND file.source_revision_id = v_job.source_revision_id
  ORDER BY file.position
  LIMIT 1;
  IF p_result IS NULL
    OR jsonb_typeof(p_result) <> 'object'
    OR octet_length(p_result::text) > 262144
    OR p_result->>'schemaVersion' <> 'opengeo.observable-build-result.1.0.0'
    OR p_result->>'buildJobId' <> v_job.id::text
    OR p_result->>'requestChecksumSha256' <> v_job.request_checksum_sha256
    OR p_result->>'compilerImageDigest' <> v_job.request->>'compilerImageDigest'
    OR p_result->>'inputManifestChecksumSha256'
      <> v_job.request->>'sourceManifestChecksumSha256'
    OR p_result->>'outputPrefix' <> v_job.output_prefix
    OR p_result->>'outputTreeChecksumSha256' !~ '^[0-9a-f]{64}$'
    OR p_result->'sandbox' IS DISTINCT FROM jsonb_build_object(
      'credentialMode', 'none',
      'networkPolicy', 'deny_all',
      'readOnlyInputs', true,
      'readOnlyBaseImage', true,
      'unprivilegedUser', true,
      'dockerSocket', false
    )
    OR p_result->'networkRequests' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_typeof(p_result->'validationReport') <> 'object'
    OR octet_length((p_result->'validationReport')::text) > 65536
    OR jsonb_typeof(p_result->'routeManifest') <> 'array'
    OR jsonb_array_length(p_result->'routeManifest') > 128
    OR jsonb_typeof(p_result->'outputManifest') <> 'object'
    OR jsonb_typeof(p_result->'outputManifest'->'files') <> 'array'
    OR jsonb_array_length(p_result->'outputManifest'->'files') NOT BETWEEN 1 AND 512
  THEN
    RAISE EXCEPTION 'invalid Observable build result envelope';
  END IF;

  FOR v_file IN
    SELECT value FROM jsonb_array_elements(p_result->'outputManifest'->'files')
  LOOP
    v_file_count := v_file_count + 1;
    IF NOT app.observable_output_path_is_safe(v_file->>'path')
      OR (v_file->>'contentType') NOT IN (
        'text/html', 'text/css', 'text/javascript', 'application/json',
        'text/plain', 'text/csv', 'application/geo+json',
        'image/svg+xml', 'image/png', 'image/jpeg',
        'application/octet-stream', 'application/zip'
      )
      OR (v_file->>'sizeBytes')::bigint NOT BETWEEN 1 AND 16777216
      OR (v_file->>'checksumSha256') !~ '^[0-9a-f]{64}$'
      OR v_file->>'bucket' IS DISTINCT FROM v_expected_bucket
      OR v_file->>'objectKey'
        <> v_job.output_prefix || substring(v_file->>'path' FROM 6)
      OR (v_file->>'s3VersionId') IS NULL
      OR char_length(v_file->>'s3VersionId') NOT BETWEEN 1 AND 1024
      OR (v_file->>'etag') IS NULL
      OR char_length(v_file->>'etag') NOT BETWEEN 1 AND 512
    THEN
      RAISE EXCEPTION 'invalid Observable build output file';
    END IF;
    v_total_bytes := v_total_bytes + (v_file->>'sizeBytes')::bigint;
  END LOOP;
  SELECT count(DISTINCT lower(value->>'path'))::integer INTO v_case_count
  FROM jsonb_array_elements(p_result->'outputManifest'->'files');
  IF v_file_count <> v_case_count OR v_total_bytes > 33554432 THEN
    RAISE EXCEPTION 'Observable build output exceeds file or size limits';
  END IF;

  UPDATE app.observable_build_jobs
  SET state = 'succeeded', result = p_result, error_code = NULL,
      coordinator_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_job.id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_error_code IS NULL
    OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
  THEN
    RAISE EXCEPTION 'invalid Observable build failure';
  END IF;
  UPDATE app.observable_build_jobs
  SET state = 'failed', error_code = p_error_code, result = NULL,
      coordinator_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_job_id
    AND state = 'running'
    AND coordinator_token = p_coordinator_token;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION app.release_observable_build(
  p_job_id uuid,
  p_coordinator_token uuid,
  p_error_code text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_job app.observable_build_jobs%ROWTYPE;
  v_failed boolean;
BEGIN
  IF p_error_code IS NULL
    OR p_error_code !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    OR char_length(p_error_code) > 100
    OR p_max_attempts NOT BETWEEN 1 AND 10
  THEN
    RAISE EXCEPTION 'invalid Observable build release';
  END IF;
  SELECT * INTO v_job
  FROM app.observable_build_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'running'
    OR v_job.coordinator_token <> p_coordinator_token
  THEN
    RETURN 'lost';
  END IF;
  IF v_job.attempt_count >= p_max_attempts THEN
    v_failed := app.fail_observable_build(
      p_job_id, p_coordinator_token, 'build_retry_exhausted'
    );
    RETURN CASE WHEN v_failed THEN 'failed' ELSE 'lost' END;
  END IF;
  UPDATE app.observable_build_jobs
  SET state = 'pending', error_code = p_error_code, result = NULL,
      coordinator_token = NULL, lease_expires_at = NULL,
      last_heartbeat_at = NULL, started_at = NULL, updated_at = clock_timestamp()
  WHERE id = v_job.id;
  RETURN 'pending';
END;
$$;

CREATE TRIGGER observable_source_projects_validate_insert
  BEFORE INSERT ON app.observable_source_projects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_project_insert();
CREATE TRIGGER observable_source_projects_validate_head
  BEFORE UPDATE ON app.observable_source_projects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_project_head();
CREATE TRIGGER observable_source_projects_set_updated_at
  BEFORE UPDATE ON app.observable_source_projects
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER observable_source_upload_intents_enforce_transition
  BEFORE UPDATE ON app.observable_source_file_upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_upload_transition();
CREATE TRIGGER observable_source_upload_intents_validate_insert
  BEFORE INSERT ON app.observable_source_file_upload_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_upload_insert();
CREATE TRIGGER observable_source_objects_enforce_binding
  BEFORE INSERT ON app.observable_source_objects
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_object_binding();
CREATE TRIGGER observable_source_objects_are_immutable
  BEFORE UPDATE OR DELETE ON app.observable_source_objects
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_source_revisions_enforce_append
  BEFORE INSERT ON app.observable_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_source_revision_insert();
CREATE TRIGGER observable_source_revisions_are_immutable
  BEFORE UPDATE OR DELETE ON app.observable_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_source_revision_files_are_immutable
  BEFORE UPDATE OR DELETE ON app.observable_source_revision_files
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER observable_build_jobs_validate_insert
  BEFORE INSERT ON app.observable_build_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_build_job_insert();
CREATE TRIGGER observable_build_jobs_validate_transition
  BEFORE UPDATE ON app.observable_build_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_build_job_transition();

ALTER TABLE app.observable_source_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_file_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_revision_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_build_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_file_upload_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_source_revision_files FORCE ROW LEVEL SECURITY;
ALTER TABLE app.observable_build_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY observable_source_projects_tenant_isolation
  ON app.observable_source_projects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_source_upload_intents_tenant_isolation
  ON app.observable_source_file_upload_intents
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_source_objects_tenant_isolation
  ON app.observable_source_objects
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_source_revisions_tenant_isolation
  ON app.observable_source_revisions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_source_revision_files_tenant_isolation
  ON app.observable_source_revision_files
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY observable_build_jobs_tenant_isolation
  ON app.observable_build_jobs
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.observable_source_projects TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.observable_source_file_upload_intents TO opengeo_runtime;
GRANT SELECT, INSERT ON
  app.observable_source_objects,
  app.observable_source_revisions,
  app.observable_source_revision_files,
  app.observable_build_jobs
TO opengeo_runtime;
REVOKE DELETE ON
  app.observable_source_projects,
  app.observable_source_file_upload_intents,
  app.observable_source_objects,
  app.observable_source_revisions,
  app.observable_source_revision_files,
  app.observable_build_jobs
FROM opengeo_runtime;
REVOKE ALL ON
  app.observable_source_projects,
  app.observable_source_file_upload_intents,
  app.observable_source_objects,
  app.observable_source_revisions,
  app.observable_source_revision_files,
  app.observable_build_jobs
FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_observable_source_project_insert(),
  app.enforce_observable_source_upload_insert(),
  app.enforce_observable_source_upload_transition(),
  app.enforce_observable_source_object_binding(),
  app.enforce_observable_source_revision_insert(),
  app.enforce_observable_source_project_head(),
  app.enforce_observable_build_job_insert(),
  app.enforce_observable_build_job_transition(),
  app.claim_observable_build(uuid, uuid, integer),
  app.heartbeat_observable_build(uuid, uuid, integer),
  app.complete_observable_build(uuid, uuid, jsonb),
  app.fail_observable_build(uuid, uuid, text),
  app.release_observable_build(uuid, uuid, text, integer)
FROM PUBLIC, opengeo_runtime, opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.observable_source_path_is_safe(text),
  app.observable_source_media_is_supported(text, text),
  app.observable_output_path_is_safe(text)
FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION
  app.observable_source_path_is_safe(text),
  app.observable_source_media_is_supported(text, text),
  app.observable_output_path_is_safe(text)
TO opengeo_runtime;

COMMENT ON TABLE app.observable_source_projects IS
  'Stable site-bound Observable source identities with a pinned compiler policy and one append-only exact revision head.';
COMMENT ON TABLE app.observable_source_revisions IS
  'Immutable, checksum-addressed, sorted multi-file source manifests; generated output and mutable prefixes are never source identity.';
COMMENT ON TABLE app.observable_source_objects IS
  'Exact private source file bytes sealed by bucket, key, S3 version, media type, length and SHA-256.';
COMMENT ON TABLE app.observable_build_jobs IS
  'Non-publishing build requests sealing one source revision, compiler image digest, deny-all network policy and bounded zero-credential sandbox contract.';
COMMENT ON FUNCTION app.claim_observable_build(uuid, uuid, integer) IS
  'Future coordinator lease boundary. It is intentionally ungranted: a coordinator may stage exact inputs, but the compiler sandbox receives no database, AWS, Cognito or connector credential.';

COMMIT;
