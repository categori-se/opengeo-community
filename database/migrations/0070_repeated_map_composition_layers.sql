BEGIN;

ALTER TABLE app.map_render_job_layers
  DROP CONSTRAINT map_render_job_layers_organization_id_render_job_id_resourc_key;

COMMENT ON TABLE app.map_render_job_layers IS
  'Immutable bottom-to-top resource/profile occurrences for one deterministic map render; one resource may appear at multiple positions.';

COMMIT;
