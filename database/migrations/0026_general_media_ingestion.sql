BEGIN;

ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'png';
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'jpeg';

COMMENT ON TYPE app.dataset_format IS
  'Governed spatial and project-media formats; png and jpeg uploads are privately retained and normalized before publication.';

COMMIT;
