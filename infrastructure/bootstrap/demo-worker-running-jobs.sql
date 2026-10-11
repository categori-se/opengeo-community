-- Include queued/retryable work: approximate SQS counters alone cannot prove drain.
WITH unfinished AS (
SELECT 'ingest' AS lane, 'app.processing_jobs' AS relation_name, count(*) FILTER (WHERE state = 'running') AS running_jobs, count(*) AS unfinished_jobs
FROM app.processing_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
SELECT 'render', 'app.map_render_jobs', count(*) FILTER (WHERE state = 'running'), count(*) FROM app.map_render_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
SELECT 'coverage', 'app.spatial_coverage_derivative_jobs', count(*) FILTER (WHERE state = 'running'), count(*) FROM app.spatial_coverage_derivative_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
SELECT 'pmtiles', 'app.pmtiles_derivative_jobs', count(*) FILTER (WHERE state = 'running'), count(*) FROM app.pmtiles_derivative_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
SELECT 'coverage-reclamation', 'app.spatial_coverage_derivative_reclamations', count(*) FILTER (WHERE state = 'running'), count(*) FROM app.spatial_coverage_derivative_reclamations WHERE state NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
SELECT 'tile-reclamation', 'app.spatial_tile_cache_reclamations', count(*) FILTER (WHERE state = 'running'), count(*) FROM app.spatial_tile_cache_reclamations WHERE state NOT IN ('completed', 'failed', 'cancelled')
)
SELECT lane, running_jobs, unfinished_jobs,
  NOT row_security_active(relation_name::regclass) AS unfiltered
FROM unfinished
ORDER BY lane;
