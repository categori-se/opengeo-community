BEGIN;

-- Source identities and publication ownership remain unchanged. Static trees
-- use index.html instead of invoking the Markdown/Framework compiler.
ALTER TABLE app.observable_source_revisions
  DROP CONSTRAINT observable_source_revisions_paths_safe,
  ADD CONSTRAINT observable_source_revisions_paths_safe CHECK (
    app.observable_source_path_is_safe(entry_path)
    AND (
      (entry_path ~* '\.md$' AND (
        lockfile_path IS NULL OR (
          app.observable_source_path_is_safe(lockfile_path)
          AND lockfile_path = 'package-lock.json'
        )
      ))
      OR (entry_path ~ '(^|/)index\.html$' AND lockfile_path IS NULL)
    )
  );

-- The deferred source-head validator must agree with the path constraint.
-- Retain the entire installed validator (including C ordering from 0096).
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('app.enforce_observable_source_project_head()'::regprocedure)
    INTO definition;
  IF position('OR v_entry_type <> ''text/markdown''' IN definition) = 0
  THEN RAISE EXCEPTION 'Unexpected source head validator; review before admitting HTML'; END IF;
  definition := replace(definition, 'OR v_entry_type <> ''text/markdown''',
    'OR v_entry_type IS DISTINCT FROM (CASE WHEN v_revision.entry_path ~ ''(^|/)index\.html$'' THEN ''text/html'' ELSE ''text/markdown'' END)');
  EXECUTE definition;
END;
$$;

COMMIT;
