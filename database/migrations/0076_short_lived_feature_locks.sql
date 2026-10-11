BEGIN;

CREATE TABLE app.dataset_feature_locks (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  feature_version bigint NOT NULL,
  lock_token uuid NOT NULL,
  locked_by uuid NOT NULL REFERENCES app.users(id),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, dataset_id, feature_id),
  CONSTRAINT dataset_feature_locks_version_positive CHECK (
    feature_version BETWEEN 1 AND 9223372036854775807
  ),
  CONSTRAINT dataset_feature_locks_duration_bounded CHECK (
    expires_at > acquired_at
    AND expires_at <= acquired_at + interval '5 minutes'
  ),
  FOREIGN KEY (organization_id, dataset_id, feature_id)
    REFERENCES app.dataset_features (organization_id, dataset_id, id)
);

CREATE INDEX dataset_feature_locks_active_idx
  ON app.dataset_feature_locks (
    organization_id, dataset_id, expires_at, feature_id
  );
CREATE INDEX dataset_feature_locks_user_idx
  ON app.dataset_feature_locks (
    organization_id, locked_by, expires_at
  );

ALTER TABLE app.dataset_feature_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_feature_locks FORCE ROW LEVEL SECURITY;

CREATE POLICY dataset_feature_locks_select_tenant
  ON app.dataset_feature_locks
  FOR SELECT
  USING (organization_id = app.current_organization_id());

CREATE POLICY dataset_feature_locks_insert_owner
  ON app.dataset_feature_locks
  FOR INSERT
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND locked_by = app.current_user_id()
  );

CREATE POLICY dataset_feature_locks_update_owner_or_expired
  ON app.dataset_feature_locks
  FOR UPDATE
  USING (
    organization_id = app.current_organization_id()
    AND (
      locked_by = app.current_user_id()
      OR expires_at <= clock_timestamp()
    )
  )
  WITH CHECK (
    organization_id = app.current_organization_id()
    AND locked_by = app.current_user_id()
  );

CREATE POLICY dataset_feature_locks_delete_owner
  ON app.dataset_feature_locks
  FOR DELETE
  USING (
    organization_id = app.current_organization_id()
    AND (
      locked_by = app.current_user_id()
      OR expires_at <= clock_timestamp()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.dataset_feature_locks TO opengeo_runtime;
REVOKE ALL ON app.dataset_feature_locks
  FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;

COMMENT ON TABLE app.dataset_feature_locks IS
  'Optional expiring feature-edit reservations. Optimistic feature versions remain authoritative and expired rows confer no write authority.';
COMMENT ON COLUMN app.dataset_feature_locks.lock_token IS
  'Opaque client-held lease capability required to renew, release, or write through an active reservation.';
COMMENT ON COLUMN app.dataset_feature_locks.feature_version IS
  'Exact live feature version observed when the current lease interval was issued.';

COMMIT;
