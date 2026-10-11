BEGIN;

-- Derived search values retain the original immutable metadata document.
CREATE FUNCTION app.catalog_place_uris(document jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  active text[] := ARRAY[]::text[];
  result text[];
  handled text[] := ARRAY[]::text[];
  reached text[];
  frontier text[];
  next_frontier text[];
  claim jsonb;
  snapshot jsonb;
  edge jsonb;
  root_uri text;
  target_uri text;
  depth integer;
BEGIN
  FOR claim IN SELECT value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(document#>'{metadata,curated}')='array'
      THEN document#>'{metadata,curated}' ELSE '[]'::jsonb END)
  LOOP
    IF claim->>'subject'='resource' AND claim->>'property' IN
      ('http://purl.org/dc/terms/spatial','http://purl.org/dc/terms/subject')
      AND claim->>'provenance'='curator_asserted'
      AND (claim#>>'{value,@id}') ~ '^(http://www.wikidata.org/entity/Q[1-9][0-9]{0,15}|https://sws.geonames.org/[1-9][0-9]*/)$'
    THEN active := array_append(active, claim#>>'{value,@id}'); END IF;
  END LOOP;
  result := active;
  -- The last retained snapshot for an active place owns its current expansion.
  FOR claim IN SELECT value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(document#>'{metadata,normalized}')='array'
      THEN document#>'{metadata,normalized}' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS entries(value, position) ORDER BY position DESC
  LOOP
    root_uri := claim#>>'{value,@id}';
    IF NOT (root_uri = ANY(active)) OR root_uri = ANY(handled) THEN CONTINUE; END IF;
    IF claim->>'subject' IS DISTINCT FROM 'resource'
      OR claim->>'property' IS DISTINCT FROM 'http://purl.org/dc/terms/relation'
      OR claim->>'method' IS DISTINCT FROM 'Wikidata P17/P30/P131 projection v1'
    THEN CONTINUE; END IF;
    snapshot := claim->'value'->'http://www.w3.org/1999/02/22-rdf-syntax-ns#value';
    IF snapshot->>'provider' IS DISTINCT FROM 'Wikidata'
      OR ('http://www.wikidata.org/entity/' || (snapshot->>'item')) IS DISTINCT FROM root_uri
      OR jsonb_typeof(snapshot->'relationships') IS DISTINCT FROM 'array'
    THEN CONTINUE; END IF;
    handled := array_append(handled, root_uri);
    reached := ARRAY[root_uri]; frontier := reached;
    FOR depth IN 1..3 LOOP
      next_frontier := ARRAY[]::text[];
      FOR edge IN SELECT value FROM jsonb_array_elements(snapshot->'relationships') LOOP
        target_uri := edge->>'object';
        IF edge->>'subject' = ANY(frontier)
          AND edge->>'property' IN ('http://www.wikidata.org/prop/direct/P17',
            'http://www.wikidata.org/prop/direct/P30','http://www.wikidata.org/prop/direct/P131')
          AND edge->>'rank' IN ('normal','preferred')
          AND target_uri ~ '^http://www.wikidata.org/entity/Q[1-9][0-9]{0,15}$'
          AND NOT (target_uri = ANY(reached))
        THEN
          reached := array_append(reached,target_uri);
          next_frontier := array_append(next_frontier,target_uri);
        END IF;
      END LOOP;
      frontier := next_frontier;
      EXIT WHEN cardinality(frontier)=0;
    END LOOP;
    result := result || reached;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT value FROM unnest(result) AS places(value) ORDER BY value);
END;
$$;

ALTER TABLE app.dataset_knowledge_revisions ADD COLUMN place_uris text[]
  GENERATED ALWAYS AS (app.catalog_place_uris(document)) STORED;
COMMENT ON COLUMN app.dataset_knowledge_revisions.place_uris IS
  'Current curated place references and bounded retained Wikidata expansion; descriptive discovery, never authorization or verified containment.';
COMMIT;
