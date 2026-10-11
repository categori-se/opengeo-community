BEGIN;

ALTER TABLE app.map_render_jobs
  ADD COLUMN background_color text,
  ADD COLUMN transparent boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT map_render_jobs_background_color_valid CHECK (
    background_color IS NULL OR background_color ~ '^#[0-9a-f]{6}$'
  );

ALTER TABLE app.map_render_jobs
  DROP CONSTRAINT map_render_jobs_dimensions_bounded,
  ADD CONSTRAINT map_render_jobs_dimensions_bounded CHECK (
    width BETWEEN 1 AND 2048
    AND height BETWEEN 1 AND 2048
    AND width::bigint * height::bigint <= 4194304
  );

COMMENT ON COLUMN app.map_render_jobs.background_color IS
  'Optional request-level #rrggbb background override included in deterministic render identity.';
COMMENT ON COLUMN app.map_render_jobs.transparent IS
  'Whether the map background is transparent; included in deterministic render identity.';

CREATE FUNCTION app.get_map_render_presentation(
  p_job_id uuid,
  p_worker_token uuid
)
RETURNS TABLE (
  background_color text,
  transparent boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT job.background_color, job.transparent
  FROM app.map_render_jobs job
  WHERE job.id = p_job_id
    AND job.state = 'running'
    AND job.worker_token = p_worker_token;
$$;

REVOKE ALL ON FUNCTION app.get_map_render_presentation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_map_render_presentation(uuid, uuid) TO opengeo_worker;

COMMIT;
