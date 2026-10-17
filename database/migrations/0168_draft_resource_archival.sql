BEGIN;

-- The delivered API already admits draft archival. Keep its explicit authority,
-- immutable resource identity, history and published workflow unchanged.
DO $$
DECLARE definition text; body text;
BEGIN
  SELECT pg_get_functiondef(oid), prosrc INTO definition, body
  FROM pg_proc
  WHERE oid = 'app.enforce_governed_resource_transition()'::regprocedure;
  IF md5(body) <> 'baa061c926dbed258ef663c286318ee7'
    OR position('OR (OLD.state = ''draft'' AND NEW.state = ''review'')' IN definition) = 0
  THEN RAISE EXCEPTION 'Unexpected resource transition guard; review draft archival'; END IF;
  definition := replace(definition,
    'OR (OLD.state = ''draft'' AND NEW.state = ''review'')',
    'OR (OLD.state = ''draft'' AND NEW.state IN (''review'', ''archived''))');
  EXECUTE definition;
END;
$$;

ALTER TABLE app.governed_resource_workflow_events
  DROP CONSTRAINT governed_resource_workflow_transition_valid,
  ADD CONSTRAINT governed_resource_workflow_transition_valid CHECK (
    (source_state = 'draft' AND target_state IN ('review', 'archived'))
    OR (source_state = 'review' AND target_state = 'published')
    OR (source_state = 'published' AND target_state = 'archived')
  );

COMMIT;
