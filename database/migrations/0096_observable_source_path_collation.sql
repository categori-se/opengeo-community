BEGIN;

-- Source paths are restricted ASCII and sealed by byte order in the API.
-- Production en_US ordering otherwise puts package.json before package-lock.json,
-- rejecting valid Framework imports that pass on C-locale development databases.
-- Preserve every validation and existing history; change only these two comparisons.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('app.enforce_observable_source_project_head()'::regprocedure)
    INTO definition;
  IF position('ORDER BY file.relative_path' IN definition) = 0
    OR position('earlier.relative_path <= file.relative_path' IN definition) = 0
  THEN RAISE EXCEPTION 'Unexpected source head validator; review before changing collation'; END IF;
  definition := replace(definition, 'ORDER BY file.relative_path', 'ORDER BY file.relative_path COLLATE "C"');
  definition := replace(definition, 'earlier.relative_path <= file.relative_path',
    'earlier.relative_path COLLATE "C" <= file.relative_path COLLATE "C"');
  EXECUTE definition;
END;
$$;

COMMIT;
