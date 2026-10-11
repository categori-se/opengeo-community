BEGIN;

-- A durable map has one canonical governed map resource per project. This
-- keeps its metadata, style, discussion, and publication history together
-- while leaving page embeds and service resources independent.
CREATE UNIQUE INDEX governed_resources_map_binding_idx
  ON app.governed_resources (organization_id, project_id, map_id)
  WHERE kind = 'map' AND map_id IS NOT NULL;

COMMENT ON INDEX app.governed_resources_map_binding_idx IS
  'Prevents concurrent creation of competing governed publication identities for one project map.';

COMMIT;
