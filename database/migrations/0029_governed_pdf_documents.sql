BEGIN;

ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'pdf';

COMMENT ON TYPE app.dataset_format IS
  'Governed spatial and project-content formats; PDF uploads remain private until activation-only malware and document inspection succeeds.';

COMMIT;
