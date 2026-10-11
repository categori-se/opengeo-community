BEGIN;

-- Output-only viewer grants are distinct from public Artifact releases and
-- authoring/resource permissions. Each grant pins an existing immutable edition.
CREATE TABLE app.project_artifact_shares (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL,
  version_number integer NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  password_salt text NOT NULL CHECK (password_salt ~ '^[0-9a-f]{32}$'),
  password_hash text NOT NULL CHECK (password_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by uuid REFERENCES app.users(id),
  revoked_at timestamptz,
  creation_key uuid,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,artifact_id,version_number)
    REFERENCES app.project_artifact_versions(organization_id,artifact_id,version_number),
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX artifact_share_creation_identity
  ON app.project_artifact_shares(organization_id,created_by,creation_key)
  WHERE creation_key IS NOT NULL;
CREATE INDEX artifact_share_history
  ON app.project_artifact_shares(organization_id,artifact_id,created_at DESC,id DESC);
-- The existing guard permits revocation only; changing a password requires a
-- new grant and never changes the original output, password or history.
CREATE TRIGGER artifact_share_history
  BEFORE UPDATE OR DELETE ON app.project_artifact_shares
  FOR EACH ROW EXECUTE FUNCTION app.guard_project_artifact_release();
ALTER TABLE app.project_artifact_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_share_tenant ON app.project_artifact_shares
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.project_artifact_shares TO opengeo_runtime;
GRANT UPDATE(revoked_by,revoked_at) ON app.project_artifact_shares TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_shares FROM opengeo_worker;

-- One row per grant bounds storage and admits at most five expensive password
-- checks per fifteen-minute window across all Lambda instances and viewers.
-- Successful opens consume a slot too. This quota never changes grant history.
CREATE TABLE app.project_artifact_share_attempts (
  organization_id uuid NOT NULL,
  share_id uuid NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 5),
  PRIMARY KEY (organization_id,share_id),
  FOREIGN KEY (organization_id,share_id)
    REFERENCES app.project_artifact_shares(organization_id,id)
);
ALTER TABLE app.project_artifact_share_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_share_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_share_attempt_tenant ON app.project_artifact_share_attempts
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.project_artifact_share_attempts TO opengeo_runtime;
GRANT UPDATE(window_started_at,attempt_count)
  ON app.project_artifact_share_attempts TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_share_attempts FROM opengeo_worker;

COMMENT ON TABLE app.project_artifact_shares IS
  'Password-gated output-only shares. API publisher/source authorization is mandatory. No Project/Layer access grant and no public-release/Collection exposure. Revocation stops new static tickets; already issued tickets retain only their bounded expiry.';
COMMENT ON TABLE app.project_artifact_share_attempts IS
  'Atomic persistent password admission quota, committed before slow verification. Five attempts including successful opens per grant per fifteen minutes; no password or request identity retained.';

COMMIT;
