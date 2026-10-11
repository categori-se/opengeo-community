BEGIN;

ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'odt';

COMMENT ON TYPE app.dataset_format IS
  'Governed spatial and project-content formats; ODF text and PDF uploads remain private until activation-only malware and bounded document inspection succeeds.';

COMMIT;
