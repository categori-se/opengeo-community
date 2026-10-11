BEGIN;
ALTER TABLE app.archive_upload_sessions
 ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
 ADD COLUMN sealed_at timestamptz,
 ADD COLUMN file_count integer CHECK (file_count BETWEEN 1 AND 100000),
 ADD COLUMN logical_bytes bigint CHECK (logical_bytes BETWEEN 0 AND 1099511627776),
 ADD COLUMN upload_bytes bigint CHECK (upload_bytes BETWEEN 0 AND 1099511627776);
-- Resume may update lifecycle facts, never move the session to another identity.
REVOKE UPDATE ON app.archive_upload_sessions FROM opengeo_runtime;
GRANT UPDATE(state,sealed_at,file_count,logical_bytes,upload_bytes)
 ON app.archive_upload_sessions TO opengeo_runtime;
CREATE INDEX archive_sessions_active_owner
 ON app.archive_upload_sessions(organization_id,created_by,expires_at)
 WHERE state IN ('planning','uploading','paused');
COMMIT;
