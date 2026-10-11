BEGIN;
-- -1 is the destination index. Reconstruction pages retain their 256 KiB bound.
ALTER TABLE app.archive_manifest_records
 DROP CONSTRAINT archive_manifest_records_first_ordinal_check,
 DROP CONSTRAINT archive_manifest_records_body_check;
ALTER TABLE app.archive_manifest_records
 ADD CHECK (first_ordinal BETWEEN -1 AND 99999),
 ADD CHECK (octet_length(body) BETWEEN 1 AND
  CASE WHEN first_ordinal=-1 THEN 33554432 ELSE 262144 END);
COMMIT;
