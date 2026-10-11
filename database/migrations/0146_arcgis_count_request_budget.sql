-- Preserve legacy page-only estimates; new ArcGIS estimates budget one count query.
-- Existing actor, project-role and source-revision checks remain unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION app.enforce_external_source_copy_estimate_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type text;
  v_source_format text;
  v_source_page_size integer;
  v_maximum_features integer;
  v_page_size integer;
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'source-copy estimate actor mismatch';
  END IF;
  IF COALESCE(
    app.effective_project_role(NEW.project_id, NEW.created_by)::text,
    ''
  ) NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION 'source-copy estimate requires project edit access';
  END IF;
  SELECT source.source_type::text,
         revision.configuration->>'format',
         CASE
           WHEN jsonb_typeof(revision.configuration->'page_size') = 'number'
           THEN (revision.configuration->>'page_size')::integer
           ELSE NULL
         END
    INTO v_source_type, v_source_format, v_source_page_size
  FROM app.external_sources source
  JOIN app.external_source_revisions revision
    ON revision.organization_id = source.organization_id
   AND revision.dataset_id = source.dataset_id
   AND revision.version_number = NEW.source_revision_number
  JOIN app.project_datasets project_dataset
    ON project_dataset.organization_id = source.organization_id
   AND project_dataset.dataset_id = source.dataset_id
   AND project_dataset.project_id = NEW.project_id
  WHERE source.organization_id = NEW.organization_id
    AND source.dataset_id = NEW.source_dataset_id;

  IF NEW.copy_method = 'bounded_feature_capture'
    AND jsonb_typeof(NEW.capture_scope->'maximum_features') = 'number'
    AND jsonb_typeof(NEW.capture_scope->'page_size') = 'number'
  THEN
    v_maximum_features := (NEW.capture_scope->>'maximum_features')::integer;
    v_page_size := (NEW.capture_scope->>'page_size')::integer;
  END IF;

  IF NOT FOUND OR NOT (
    (v_source_type = 'pmtiles' AND NEW.copy_method = 'exact_object_copy'
      AND NEW.capture_scope = '{"kind":"exact_object"}'::jsonb
      AND NEW.maximum_requests = 1 AND NEW.output_format = 'pmtiles')
    OR (v_source_type = 'wms' AND v_source_format = 'image/png'
      AND NEW.copy_method = 'bounded_map_capture'
      AND NEW.capture_scope->>'kind' = 'bounded_image'
      AND NEW.capture_scope - ARRAY['kind', 'bounds', 'width', 'height'] = '{}'::jsonb
      AND jsonb_typeof(NEW.capture_scope->'bounds') = 'array'
      AND jsonb_array_length(NEW.capture_scope->'bounds') = 4
      AND jsonb_typeof(NEW.capture_scope->'bounds'->0) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->1) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->2) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->3) = 'number'
      AND (NEW.capture_scope->'bounds'->>0)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        BETWEEN -85.0511287798066 AND 85.0511287798066
      AND (NEW.capture_scope->'bounds'->>2)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>3)::numeric
        BETWEEN -85.0511287798066 AND 85.0511287798066
      AND (NEW.capture_scope->'bounds'->>0)::numeric
        < (NEW.capture_scope->'bounds'->>2)::numeric
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        < (NEW.capture_scope->'bounds'->>3)::numeric
      AND jsonb_typeof(NEW.capture_scope->'width') = 'number'
      AND jsonb_typeof(NEW.capture_scope->'height') = 'number'
      AND (NEW.capture_scope->>'width')::integer BETWEEN 1 AND 4096
      AND (NEW.capture_scope->>'height')::integer BETWEEN 1 AND 4096
      AND (NEW.capture_scope->>'width')::bigint
        * (NEW.capture_scope->>'height')::bigint <= 16777216
      AND NEW.maximum_requests = 1
      AND NEW.maximum_output_bytes <= 134217728
      AND NEW.output_format = 'png')
    OR (v_source_type IN ('arcgis', 'wfs')
      AND NEW.copy_method = 'bounded_feature_capture'
      AND NEW.capture_scope->>'kind' = 'bounded_features'
      AND NEW.capture_scope
        - ARRAY['kind', 'bounds', 'maximum_features', 'page_size'] = '{}'::jsonb
      AND jsonb_typeof(NEW.capture_scope->'bounds') = 'array'
      AND jsonb_array_length(NEW.capture_scope->'bounds') = 4
      AND jsonb_typeof(NEW.capture_scope->'bounds'->0) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->1) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->2) = 'number'
      AND jsonb_typeof(NEW.capture_scope->'bounds'->3) = 'number'
      AND (NEW.capture_scope->'bounds'->>0)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>1)::numeric BETWEEN -90 AND 90
      AND (NEW.capture_scope->'bounds'->>2)::numeric BETWEEN -180 AND 180
      AND (NEW.capture_scope->'bounds'->>3)::numeric BETWEEN -90 AND 90
      AND (NEW.capture_scope->'bounds'->>0)::numeric
        < (NEW.capture_scope->'bounds'->>2)::numeric
      AND (NEW.capture_scope->'bounds'->>1)::numeric
        < (NEW.capture_scope->'bounds'->>3)::numeric
      AND jsonb_typeof(NEW.capture_scope->'maximum_features') = 'number'
      AND jsonb_typeof(NEW.capture_scope->'page_size') = 'number'
      AND (NEW.capture_scope->>'maximum_features')::numeric
        = trunc((NEW.capture_scope->>'maximum_features')::numeric)
      AND (NEW.capture_scope->>'page_size')::numeric
        = trunc((NEW.capture_scope->>'page_size')::numeric)
      AND v_maximum_features BETWEEN 1 AND 50000
      AND v_page_size BETWEEN 1 AND CASE
        WHEN v_source_type = 'arcgis' THEN 2000 ELSE 1000 END
      AND v_page_size <= v_source_page_size
      AND NEW.maximum_requests
        IN (ceil(v_maximum_features::numeric / v_page_size::numeric)::integer,
          ceil(v_maximum_features::numeric / v_page_size::numeric)::integer
            + CASE WHEN v_source_type = 'arcgis' THEN 1 ELSE 0 END)
      AND NEW.maximum_requests BETWEEN 1 AND 64
      AND NEW.maximum_output_bytes BETWEEN 1 AND 134217728
      AND NEW.output_format = 'geojson')
  ) THEN
    RAISE EXCEPTION 'source-copy estimate does not match the project source';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
