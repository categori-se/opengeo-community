BEGIN;

-- Version 1 remains byte-for-byte unchanged. Version 2 seals registered archive
-- references into the revision, without copying data into source upload storage.
CREATE FUNCTION app.validate_observable_revision_data_bindings(
  p_organization uuid, p_project uuid, p_source uuid, p_manifest jsonb
)
RETURNS jsonb LANGUAGE plpgsql
AS $$
DECLARE
  v_item jsonb;
  v_pin jsonb;
  v_pins jsonb := '[]'::jsonb;
  v_attachment app.observable_data_attachments%ROWTYPE;
  v_path text;
  v_previous text;
  v_total bigint := 0;
BEGIN
  IF p_manifest->>'schemaVersion' = 'opengeo.observable-source-revision.1.0.0'
    AND NOT p_manifest ? 'dataAttachments'
  THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_manifest->>'schemaVersion' IS DISTINCT FROM 'opengeo.observable-source-revision.2.0.0'
    OR jsonb_typeof(p_manifest->'dataAttachments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'files') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'unsupported Observable source manifest' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_manifest->'dataAttachments') NOT BETWEEN 1 AND 128
    OR jsonb_array_length(p_manifest->'dataAttachments') + jsonb_array_length(p_manifest->'files') > 128
    OR p_organization IS DISTINCT FROM app.current_organization_id()
    OR NOT EXISTS (
      SELECT 1 FROM app.projects project
      JOIN app.organization_memberships member ON member.organization_id = project.organization_id
        AND member.user_id = app.current_user_id()
      WHERE project.organization_id = p_organization AND project.id = p_project
        AND project.status = 'active'
        AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'editor'))
    )
  THEN
    RAISE EXCEPTION 'archive bindings require bounded source-project manage access' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_manifest->'dataAttachments') LOOP
    v_path := v_item->>'path';
    IF NOT app.observable_source_path_is_safe(v_path)
      OR v_path !~* '\.(json|geojson|csv|txt|png|jpe?g)$'
      OR v_path ~* '(^|/)(package\.json|package-lock\.json)$'
      OR (v_previous IS NOT NULL AND v_previous >= v_path)
    THEN
      RAISE EXCEPTION 'archive binding path is unsafe or unsorted' USING ERRCODE = '23514';
    END IF;
    v_previous := v_path;
    SELECT attachment.* INTO v_attachment
    FROM app.observable_data_attachments attachment
    JOIN app.project_datasets linked ON linked.organization_id = attachment.organization_id
      AND linked.project_id = attachment.project_id AND linked.dataset_id = attachment.dataset_id
    JOIN app.datasets dataset ON dataset.organization_id = linked.organization_id AND dataset.id = linked.dataset_id
    JOIN app.dataset_versions version ON version.organization_id = dataset.organization_id
      AND version.dataset_id = dataset.id AND version.id = attachment.dataset_version_id
    JOIN app.data_objects object ON object.organization_id = dataset.organization_id
      AND object.dataset_id = dataset.id AND object.id = attachment.data_object_id
    WHERE attachment.organization_id = p_organization AND attachment.project_id = p_project
      AND attachment.source_project_id = p_source AND attachment.id::text = v_item->>'attachmentId'
      AND dataset.status = 'active' AND version.state = 'active'
      AND object.s3_version_id = attachment.s3_version_id
      AND object.checksum_sha256 = attachment.checksum_sha256
      AND object.size_bytes = attachment.size_bytes AND object.content_type = attachment.content_type;
    IF NOT FOUND OR NOT app.observable_source_media_is_supported(v_path, v_attachment.content_type) THEN
      RAISE EXCEPTION 'archive binding is unavailable or has incompatible media' USING ERRCODE = '23514';
    END IF;
    v_total := v_total + v_attachment.size_bytes;
    IF v_total > 67108864 THEN
      RAISE EXCEPTION 'archive bindings exceed 64 MiB' USING ERRCODE = '23514';
    END IF;
    v_pin := jsonb_build_object(
      'path', v_path, 'attachmentId', v_attachment.id, 'datasetId', v_attachment.dataset_id,
      'datasetVersionId', v_attachment.dataset_version_id, 'dataObjectId', v_attachment.data_object_id,
      's3VersionId', v_attachment.s3_version_id, 'checksumSha256', v_attachment.checksum_sha256,
      'sizeBytes', v_attachment.size_bytes, 'contentType', v_attachment.content_type
    );
    IF v_item IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'archive binding must match exact registered facts' USING ERRCODE = '23514';
    END IF;
    v_pins := v_pins || jsonb_build_array(v_pin);
  END LOOP;
  IF EXISTS (
    WITH paths AS (
      SELECT row_number() OVER () AS ordinal, lower(value->>'path') AS path
      FROM jsonb_array_elements((p_manifest->'files') || v_pins)
    )
    SELECT 1 FROM paths left_path JOIN paths right_path ON left_path.ordinal < right_path.ordinal
    WHERE left_path.path = right_path.path
      OR starts_with(left_path.path, right_path.path || '/')
      OR starts_with(right_path.path, left_path.path || '/')
  ) THEN
    RAISE EXCEPTION 'source and archive paths collide' USING ERRCODE = '23514';
  END IF;
  RETURN v_pins;
END;
$$;

CREATE FUNCTION app.enforce_observable_revision_data_bindings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.validate_observable_revision_data_bindings(
    NEW.organization_id, NEW.project_id, NEW.source_project_id, NEW.manifest
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER observable_source_revisions_validate_data
  BEFORE INSERT ON app.observable_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_observable_revision_data_bindings();

-- The current coordinator speaks version 1. Never accept a build that would
-- silently leave out pinned data; remove this guard only with verified staging.
CREATE FUNCTION app.require_observable_staging_manifest_support()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.observable_source_revisions
    WHERE organization_id = NEW.organization_id AND source_project_id = NEW.source_project_id
      AND id = NEW.source_revision_id
      AND manifest->>'schemaVersion' <> 'opengeo.observable-source-revision.1.0.0') THEN
    RAISE EXCEPTION 'archived data staging is not available' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER observable_build_jobs_data_staging_support
  BEFORE INSERT ON app.observable_build_jobs
  FOR EACH ROW EXECUTE FUNCTION app.require_observable_staging_manifest_support();

REVOKE ALL ON FUNCTION app.validate_observable_revision_data_bindings(uuid, uuid, uuid, jsonb),
  app.enforce_observable_revision_data_bindings(), app.require_observable_staging_manifest_support() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_observable_revision_data_bindings(uuid, uuid, uuid, jsonb),
  app.enforce_observable_revision_data_bindings(), app.require_observable_staging_manifest_support() TO opengeo_runtime;

CREATE OR REPLACE FUNCTION app.enforce_observable_source_project_head()
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
  IF v_revision.manifest->>'schemaVersion' = 'opengeo.observable-source-revision.2.0.0' THEN
    v_expected_manifest := v_expected_manifest || jsonb_build_object(
      'schemaVersion', 'opengeo.observable-source-revision.2.0.0',
      'dataAttachments', app.validate_observable_revision_data_bindings(
        NEW.organization_id, NEW.project_id, NEW.id, v_revision.manifest
      )
    );
  END IF;
  IF v_revision.manifest IS DISTINCT FROM v_expected_manifest THEN
    RAISE EXCEPTION 'Observable source revision manifest does not match exact file objects';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
