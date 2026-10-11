BEGIN;

-- Reviews bind two exact versions of one Layer. Inserting a review never promotes it.
CREATE TABLE app.dataset_refresh_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  base_version_id uuid NOT NULL,
  candidate_version_id uuid NOT NULL,
  source_revision integer,
  decision text NOT NULL CHECK (decision IN ('rejected', 'review_required', 'ready')),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= 131072
    AND evidence->>'schemaVersion' = 'opengeo.dataset-refresh-review.1.0.0'
  ),
  evidence_sha256 text GENERATED ALWAYS AS
    (encode(public.digest(evidence::text, 'sha256'), 'hex')) STORED,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dataset_id, id),
  UNIQUE (organization_id, dataset_id, candidate_version_id),
  CHECK (base_version_id <> candidate_version_id),
  CHECK (source_revision IS NULL OR source_revision > 0),
  FOREIGN KEY (organization_id, dataset_id, base_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, dataset_id, candidate_version_id)
    REFERENCES app.dataset_versions(organization_id, dataset_id, id),
  FOREIGN KEY (organization_id, dataset_id, source_revision)
    REFERENCES app.external_source_revisions(organization_id, dataset_id, version_number)
);
CREATE INDEX dataset_refresh_review_history
  ON app.dataset_refresh_reviews(organization_id, dataset_id, created_at DESC, id);
CREATE TRIGGER dataset_refresh_review_immutable
  BEFORE UPDATE OR DELETE ON app.dataset_refresh_reviews
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.dataset_refresh_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dataset_refresh_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_refresh_review_tenant ON app.dataset_refresh_reviews
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id()
              AND created_by = app.current_user_id());
-- Read-only until authoritative verification and acceptance endpoints are connected.
GRANT SELECT ON app.dataset_refresh_reviews TO opengeo_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.dataset_refresh_reviews FROM opengeo_runtime;
REVOKE ALL ON app.dataset_refresh_reviews FROM opengeo_worker;
COMMENT ON TABLE app.dataset_refresh_reviews IS
 'Immutable server-authored staged replacement evidence. No current-pointer change or access grant. Runtime review creation/promotion not enabled by this migration.';
COMMENT ON COLUMN app.dataset_refresh_reviews.evidence_sha256 IS
 'SHA-256 of PostgreSQL JSONB text UTF-8. Identifies this stored evidence representation, not provider bytes or a cross-system canonical JSON signature.';

COMMIT;
