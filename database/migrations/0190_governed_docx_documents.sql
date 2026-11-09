BEGIN;

-- Original DOCX uploads use the existing private source and inspected-document
-- workflow. Format admission does not grant publication or object access.
ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'docx';

COMMIT;
