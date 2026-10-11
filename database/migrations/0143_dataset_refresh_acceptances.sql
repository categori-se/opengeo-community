BEGIN;
CREATE TABLE app.dataset_refresh_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  review_id uuid NOT NULL UNIQUE,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_by uuid NOT NULL REFERENCES app.users(id),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, dataset_id, review_id)
    REFERENCES app.dataset_refresh_reviews(organization_id, dataset_id, id)
);
CREATE TRIGGER dataset_refresh_acceptance_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_refresh_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.dataset_refresh_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_refresh_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_refresh_acceptance_tenant ON app.dataset_refresh_acceptances
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id()
              AND accepted_by = app.current_user_id());
GRANT SELECT, INSERT ON app.dataset_refresh_acceptances TO opengeo_runtime;
REVOKE UPDATE, DELETE ON app.dataset_refresh_acceptances FROM opengeo_runtime;
REVOKE ALL ON app.dataset_refresh_acceptances FROM opengeo_worker;
COMMENT ON TABLE app.dataset_refresh_acceptances IS
 'One immutable acceptance per reviewed candidate; API writes in the same locked transaction as Layer promotion. No changes to pinned map or publication versions.';
COMMIT;
