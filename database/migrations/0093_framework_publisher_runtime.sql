BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeo_framework_publisher') THEN
    CREATE ROLE opengeo_framework_publisher NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app TO opengeo_framework_publisher;

ALTER TABLE app.framework_publication_origins ADD COLUMN active_publication_id uuid
  REFERENCES app.framework_publication_reviews(id);
CREATE TABLE app.framework_publication_jobs (
  review_id uuid PRIMARY KEY REFERENCES app.framework_publication_reviews(id),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  origin_id uuid NOT NULL REFERENCES app.framework_publication_origins(id),
  stage text NOT NULL DEFAULT 'preparing' CHECK (stage IN ('preparing', 'copying', 'activating', 'deployed', 'needs_attention')),
  plan jsonb CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 900000),
  edge_snapshot jsonb CHECK (jsonb_typeof(edge_snapshot) = 'object' AND octet_length(edge_snapshot::text) <= 100000),
  completed_files integer NOT NULL DEFAULT 0 CHECK (completed_files BETWEEN 0 AND 2048),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,100}$'),
  receipt jsonb CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 100000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, review_id)
    REFERENCES app.framework_publication_reviews(organization_id, project_id, id),
  CHECK ((plan IS NULL) = (edge_snapshot IS NULL)),
  CHECK (stage <> 'deployed' OR receipt IS NOT NULL)
);
ALTER TABLE app.framework_publication_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY framework_publication_jobs_tenant ON app.framework_publication_jobs
  USING (organization_id = app.current_organization_id());
GRANT SELECT ON app.framework_publication_jobs TO opengeo_runtime;
REVOKE ALL ON app.framework_publication_jobs FROM PUBLIC, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

CREATE FUNCTION app.framework_publisher_authorized(p_review uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.framework_publication_reviews review
    JOIN app.framework_publication_approvals approval ON approval.review_id = review.id
    JOIN app.organizations organization ON organization.id = review.organization_id AND organization.status = 'active'
    JOIN app.projects project ON project.id = review.project_id AND project.organization_id = organization.id AND project.status = 'active'
    JOIN app.organization_memberships member ON member.organization_id = organization.id AND member.user_id = approval.approved_by
    JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id AND mount.enabled
    JOIN app.framework_publication_origins origin ON origin.id = mount.origin_id AND origin.enabled
    JOIN app.observable_build_jobs build ON build.id = review.build_job_id AND build.state = 'succeeded'
      AND build.result_checksum_sha256 = review.result_checksum_sha256
    JOIN app.observable_source_revisions revision ON revision.id = build.source_revision_id AND revision.rights_status = 'approved'
    WHERE review.id = p_review AND origin.generation = review.expected_generation
      AND origin.active_release_prefix = review.previous_release_prefix
      AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'reviewer'))
  );
$$;

CREATE FUNCTION app.claim_framework_publication(p_review uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE r app.framework_publication_reviews%ROWTYPE; o app.framework_publication_origins%ROWTYPE;
  j app.framework_publication_jobs%ROWTYPE; mount app.framework_publication_mounts%ROWTYPE;
BEGIN
  IF p_review IS NULL OR p_token IS NULL THEN RAISE EXCEPTION 'Invalid publication identity'; END IF;
  SELECT * INTO r FROM app.framework_publication_reviews WHERE id = p_review;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  SELECT * INTO mount FROM app.framework_publication_mounts WHERE id = r.mount_id;
  SELECT * INTO o FROM app.framework_publication_origins WHERE id = mount.origin_id FOR UPDATE;
  SELECT * INTO j FROM app.framework_publication_jobs WHERE review_id = p_review FOR UPDATE;
  IF FOUND AND j.stage = 'deployed' THEN RETURN jsonb_build_object('status', 'deployed'); END IF;
  IF NOT app.framework_publisher_authorized(p_review) THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  IF o.active_publication_id IS NOT NULL AND o.active_publication_id <> p_review THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  IF j.lease_expires_at > clock_timestamp() THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  IF j.review_id IS NULL THEN
    INSERT INTO app.framework_publication_jobs(review_id, organization_id, project_id, origin_id)
      VALUES(r.id, r.organization_id, r.project_id, o.id) RETURNING * INTO j;
  END IF;
  UPDATE app.framework_publication_origins SET active_publication_id = p_review WHERE id = o.id;
  UPDATE app.framework_publication_jobs SET lease_token = p_token,
    lease_expires_at = clock_timestamp() + interval '1000 seconds', updated_at = clock_timestamp()
    WHERE review_id = p_review;
  RETURN jsonb_build_object('status', 'claimed', 'organization_id', r.organization_id,
    'project_id', r.project_id, 'source_project_id', r.source_project_id, 'build_job_id', r.build_job_id,
    'mount_path', r.mount_path, 'previous_release_prefix', r.previous_release_prefix,
    'build_result', (SELECT result FROM app.observable_build_jobs WHERE id = r.build_job_id),
    'origin', jsonb_build_object('hostname', o.hostname, 'bucket', o.bucket, 'distribution_id', o.distribution_id, 'origin_id', o.origin_id),
    'reserved_mounts', (SELECT jsonb_agg(mount_path ORDER BY mount_path) FROM app.framework_publication_mounts WHERE origin_id = o.id),
    'plan', j.plan, 'edge_snapshot', j.edge_snapshot, 'completed_files', j.completed_files, 'stage', j.stage);
END;
$$;

CREATE FUNCTION app.authorize_framework_publication(p_review uuid, p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT app.framework_publisher_authorized(p_review) AND EXISTS (
    SELECT 1 FROM app.framework_publication_jobs j JOIN app.framework_publication_origins o ON o.id = j.origin_id
    WHERE j.review_id = p_review AND j.lease_token = p_token AND j.lease_expires_at > clock_timestamp()
      AND j.stage <> 'deployed' AND o.active_publication_id = p_review
  );
$$;

CREATE FUNCTION app.seal_framework_publication_plan(p_review uuid, p_token uuid, p_plan jsonb, p_edge jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.framework_publication_jobs%ROWTYPE; r app.framework_publication_reviews%ROWTYPE; bucket_name text;
BEGIN
  SELECT * INTO j FROM app.framework_publication_jobs WHERE review_id = p_review FOR UPDATE;
  IF NOT app.authorize_framework_publication(p_review, p_token) THEN RETURN false; END IF;
  IF j.plan IS NOT NULL THEN RETURN j.plan = p_plan AND j.edge_snapshot = p_edge; END IF;
  SELECT * INTO r FROM app.framework_publication_reviews WHERE id = p_review;
  SELECT bucket INTO bucket_name FROM app.framework_publication_origins WHERE id = j.origin_id;
  IF p_plan->>'reviewId' IS DISTINCT FROM p_review::text OR p_plan->>'buildId' IS DISTINCT FROM r.build_job_id::text
    OR p_plan->>'targetPrefix' IS DISTINCT FROM 'releases/framework-' || p_review::text
    OR p_plan->>'previousPrefix' IS DISTINCT FROM r.previous_release_prefix
    OR p_plan->>'mountPath' IS DISTINCT FROM r.mount_path OR p_plan->>'bucket' IS DISTINCT FROM bucket_name
    OR jsonb_typeof(p_plan->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'files') NOT BETWEEN 1 AND 2048
  THEN RAISE EXCEPTION 'Publication plan identity mismatch'; END IF;
  UPDATE app.framework_publication_jobs SET plan = p_plan, edge_snapshot = p_edge, stage = 'copying', updated_at = clock_timestamp()
    WHERE review_id = p_review;
  RETURN true;
END;
$$;

CREATE FUNCTION app.checkpoint_framework_publication(p_review uuid, p_token uuid, p_position integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.framework_publication_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM app.framework_publication_jobs WHERE review_id = p_review FOR UPDATE;
  IF NOT app.authorize_framework_publication(p_review, p_token) THEN RETURN false; END IF;
  IF j.plan IS NULL OR p_position IS NULL OR p_position NOT BETWEEN j.completed_files AND j.completed_files + 1
    OR p_position > jsonb_array_length(j.plan->'files') THEN RAISE EXCEPTION 'Publication checkpoint invalid'; END IF;
  UPDATE app.framework_publication_jobs SET completed_files = p_position, updated_at = clock_timestamp() WHERE review_id = p_review;
  RETURN true;
END;
$$;

CREATE FUNCTION app.activate_framework_publication(p_review uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.framework_publication_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM app.framework_publication_jobs WHERE review_id = p_review FOR UPDATE;
  IF NOT app.authorize_framework_publication(p_review, p_token) THEN RETURN false; END IF;
  IF j.plan IS NULL OR j.completed_files <> jsonb_array_length(j.plan->'files') THEN RETURN false; END IF;
  UPDATE app.framework_publication_jobs SET stage = 'activating', updated_at = clock_timestamp() WHERE review_id = p_review;
  RETURN true;
END;
$$;

CREATE FUNCTION app.complete_framework_publication(p_review uuid, p_token uuid, p_receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE j app.framework_publication_jobs%ROWTYPE; origin app.framework_publication_origins%ROWTYPE;
BEGIN
  -- Match claim lock order: origin first, then job. No other project's review
  -- can take this origin until the completed receipt and pointer commit together.
  SELECT o.* INTO origin FROM app.framework_publication_origins o
    JOIN app.framework_publication_jobs job ON job.origin_id = o.id WHERE job.review_id = p_review FOR UPDATE OF o;
  SELECT * INTO j FROM app.framework_publication_jobs WHERE review_id = p_review FOR UPDATE;
  IF NOT app.authorize_framework_publication(p_review, p_token) OR j.stage <> 'activating' THEN RETURN false; END IF;
  IF p_receipt->>'targetPrefix' IS DISTINCT FROM j.plan->>'targetPrefix'
    OR p_receipt->>'previousPrefix' IS DISTINCT FROM j.plan->>'previousPrefix'
    OR p_receipt->>'distributionId' IS DISTINCT FROM origin.distribution_id
    OR p_receipt->>'status' IS DISTINCT FROM 'Deployed' OR p_receipt->>'invalidationStatus' IS DISTINCT FROM 'Completed'
  THEN RAISE EXCEPTION 'Verified edge deployment receipt required'; END IF;
  UPDATE app.framework_publication_jobs SET stage = 'deployed', receipt = p_receipt, error_code = NULL,
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE review_id = p_review;
  UPDATE app.framework_publication_origins SET active_release_prefix = j.plan->>'targetPrefix', generation = generation + 1,
    active_publication_id = NULL WHERE id = j.origin_id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.release_framework_publication(p_review uuid, p_token uuid, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  UPDATE app.framework_publication_jobs SET lease_token = NULL, lease_expires_at = NULL,
    error_code = p_error, stage = CASE WHEN p_error IS NULL THEN stage ELSE 'needs_attention' END,
    updated_at = clock_timestamp() WHERE review_id = p_review AND lease_token = p_token AND stage <> 'deployed';
  -- Deliberately keep the origin reservation. Ambiguous remote state is not
  -- permission to start another publication or restore an older global prefix.
END;
$$;

REVOKE ALL ON FUNCTION app.framework_publisher_authorized(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_framework_publication(uuid, uuid), app.authorize_framework_publication(uuid, uuid),
  app.seal_framework_publication_plan(uuid, uuid, jsonb, jsonb), app.checkpoint_framework_publication(uuid, uuid, integer),
  app.activate_framework_publication(uuid, uuid), app.complete_framework_publication(uuid, uuid, jsonb),
  app.release_framework_publication(uuid, uuid, text) FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.claim_framework_publication(uuid, uuid), app.authorize_framework_publication(uuid, uuid),
  app.seal_framework_publication_plan(uuid, uuid, jsonb, jsonb), app.checkpoint_framework_publication(uuid, uuid, integer),
  app.activate_framework_publication(uuid, uuid), app.complete_framework_publication(uuid, uuid, jsonb),
  app.release_framework_publication(uuid, uuid, text) TO opengeo_framework_publisher;
COMMIT;
