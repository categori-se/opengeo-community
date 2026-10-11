BEGIN;
-- Only the authenticated API authors review evidence from retained processing records.
-- Existing tenant/actor policy and immutable history trigger remain in force.
GRANT INSERT ON app.dataset_refresh_reviews TO opengeo_runtime;
COMMENT ON TABLE app.dataset_refresh_reviews IS
 'Immutable server-authored staged replacement evidence. API review creation is enabled; no promotion or worker writes. Collection or metadata visibility never grants access.';
COMMIT;
