BEGIN;

-- Native notebooks remain exact source objects. Saved-output rendering is a
-- credential-free compiler operation, not kernel or arbitrary Python execution.
ALTER TABLE app.observable_source_revisions
  DROP CONSTRAINT observable_source_revisions_paths_safe,
  ADD CONSTRAINT observable_source_revisions_paths_safe CHECK (
    app.observable_source_path_is_safe(entry_path)
    AND (
      (entry_path ~* '\.md$' AND (lockfile_path IS NULL OR (
        app.observable_source_path_is_safe(lockfile_path) AND lockfile_path = 'package-lock.json'
      )))
      OR ((entry_path ~ '(^|/)index\.html$' OR entry_path ~* '\.ipynb$') AND lockfile_path IS NULL)
    )
  );

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('app.observable_source_media_is_supported(text,text)'::regprocedure) INTO definition;
  IF position('SELECT CASE' IN definition) = 0 OR position('.ipynb' IN definition) <> 0
  THEN RAISE EXCEPTION 'Unexpected source media validator; review notebook admission'; END IF;
  definition := replace(definition, 'SELECT CASE',
    'SELECT CASE WHEN p_path ~* ''\.ipynb$'' THEN p_content_type IN (''application/x-ipynb+json'', ''application/json'')');
  EXECUTE definition;

  SELECT pg_get_functiondef('app.enforce_observable_source_project_head()'::regprocedure) INTO definition;
  IF position('OR v_entry_type IS DISTINCT FROM (CASE WHEN v_revision.entry_path' IN definition) = 0
  THEN RAISE EXCEPTION 'Unexpected source head validator; apply reviewed HTML admission first'; END IF;
  definition := replace(definition,
    'OR v_entry_type IS DISTINCT FROM (CASE WHEN v_revision.entry_path ~ ''(^|/)index\.html$'' THEN ''text/html'' ELSE ''text/markdown'' END)',
    'OR v_entry_type IS NULL OR NOT app.observable_source_media_is_supported(v_revision.entry_path, v_entry_type)');
  EXECUTE definition;
END;
$$;

COMMIT;
