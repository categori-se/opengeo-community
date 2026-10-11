BEGIN;

-- An existing public root must be preserved even before it is imported into
-- Studio. This is an ownership boundary, NOT a grant to publish that root.
-- Source/project/mount authorization remains unchanged; only the preservation
-- inventory gains the implicit root already represented by the verified origin.
DO $$
DECLARE definition text;
  original text := '(SELECT jsonb_agg(mount_path ORDER BY mount_path) FROM app.framework_publication_mounts WHERE origin_id = o.id)';
  replacement text := '(SELECT jsonb_agg(reserved.mount_path ORDER BY reserved.mount_path) FROM (SELECT ''/''::text AS mount_path UNION SELECT mount_path FROM app.framework_publication_mounts WHERE origin_id = o.id) reserved)';
BEGIN
  SELECT pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure) INTO definition;
  IF position(original IN definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected publication claim; review root preservation before migration';
  END IF;
  EXECUTE replace(definition, original, replacement);
END;
$$;

COMMIT;
