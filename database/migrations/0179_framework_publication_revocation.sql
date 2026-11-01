BEGIN;

-- Preserve immutable reviews, approvals, builds, source rights and output bytes.
-- A withdrawal request is distinct from an acknowledged delivery withdrawal.
CREATE TABLE app.framework_publication_revocations (
  review_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES app.users(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, review_id)
    REFERENCES app.framework_publication_reviews(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects(organization_id, project_id, id)
);
CREATE TRIGGER framework_publication_revocations_immutable
  BEFORE UPDATE OR DELETE ON app.framework_publication_revocations
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TABLE app.framework_publication_revocation_jobs (
  review_id uuid PRIMARY KEY REFERENCES app.framework_publication_revocations(review_id),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'revoked', 'needs_attention')),
  lease_token uuid,
  lease_expires_at timestamptz,
  receipt jsonb CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 100000),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,100}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, review_id)
    REFERENCES app.framework_publication_reviews(organization_id, project_id, id),
  CHECK (state <> 'revoked' OR receipt IS NOT NULL)
);
ALTER TABLE app.framework_publication_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_revocation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_revocation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY framework_publication_revocations_tenant ON app.framework_publication_revocations
  USING (organization_id = app.current_organization_id());
CREATE POLICY framework_publication_revocation_jobs_tenant ON app.framework_publication_revocation_jobs
  USING (organization_id = app.current_organization_id());
REVOKE ALL ON app.framework_publication_revocations, app.framework_publication_revocation_jobs
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
    opengeo_observable_coordinator, opengeo_framework_publisher;
GRANT SELECT ON app.framework_publication_revocations, app.framework_publication_revocation_jobs
  TO opengeo_runtime;

CREATE FUNCTION app.request_framework_publication_revocation(
  p_review uuid, p_project uuid, p_source uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  review app.framework_publication_reviews%ROWTYPE;
  origin app.framework_publication_origins%ROWTYPE;
  withdrawal app.framework_publication_revocation_jobs%ROWTYPE;
BEGIN
  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);
  SELECT * INTO review FROM app.framework_publication_reviews
    WHERE id = p_review AND organization_id = app.current_organization_id()
      AND project_id = p_project AND source_project_id = p_source;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication review unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT destination.* INTO origin FROM app.framework_publication_origins destination
    JOIN app.framework_publication_mounts mount ON mount.origin_id = destination.id
    WHERE mount.id = review.mount_id AND mount.organization_id = review.organization_id
      AND mount.project_id = review.project_id AND mount.source_project_id = review.source_project_id
    FOR UPDATE OF destination;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication origin unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO withdrawal FROM app.framework_publication_revocation_jobs
    WHERE review_id = review.id;
  IF FOUND THEN RETURN withdrawal.state; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.framework_publication_jobs
    WHERE review_id = review.id AND organization_id = review.organization_id
      AND project_id = review.project_id AND stage = 'deployed')
  THEN
    RAISE EXCEPTION 'Deployed publication edition required' USING ERRCODE = '23514';
  END IF;
  INSERT INTO app.framework_publication_revocations
    (review_id, organization_id, project_id, source_project_id, requested_by)
  VALUES (review.id, review.organization_id, review.project_id, review.source_project_id,
    app.current_user_id());
  INSERT INTO app.framework_publication_revocation_jobs(review_id, organization_id, project_id)
    VALUES(review.id, review.organization_id, review.project_id);
  RETURN 'pending';
END;
$$;

CREATE FUNCTION app.claim_framework_publication_revocation(p_review uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  review app.framework_publication_reviews%ROWTYPE;
  origin app.framework_publication_origins%ROWTYPE;
  withdrawal app.framework_publication_revocation_jobs%ROWTYPE;
BEGIN
  IF p_review IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'Invalid publication revocation identity';
  END IF;
  SELECT * INTO review FROM app.framework_publication_reviews WHERE id = p_review;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  SELECT destination.* INTO origin FROM app.framework_publication_origins destination
    JOIN app.framework_publication_mounts mount ON mount.origin_id = destination.id
    WHERE mount.id = review.mount_id FOR UPDATE OF destination;
  SELECT * INTO withdrawal FROM app.framework_publication_revocation_jobs
    WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  IF withdrawal.state = 'revoked' THEN RETURN jsonb_build_object('status', 'revoked'); END IF;
  IF (origin.active_publication_id IS NOT NULL AND origin.active_publication_id <> p_review)
    OR withdrawal.lease_expires_at > clock_timestamp()
  THEN RETURN jsonb_build_object('status', 'busy'); END IF;
  UPDATE app.framework_publication_revocation_jobs
    SET lease_token = p_token, lease_expires_at = clock_timestamp() + interval '5 minutes',
      state = 'pending', error_code = NULL, updated_at = clock_timestamp()
    WHERE review_id = p_review;
  UPDATE app.framework_publication_origins SET active_publication_id = p_review
    WHERE id = origin.id;
  RETURN jsonb_build_object('status', 'claimed', 'review_id', review.id,
    'organization_id', review.organization_id, 'project_id', review.project_id,
    'source_project_id', review.source_project_id, 'mount_path', review.mount_path,
    'target_prefix', 'releases/framework-' || review.id::text, 'origin', to_jsonb(origin));
END;
$$;

CREATE FUNCTION app.complete_framework_publication_revocation(
  p_review uuid, p_token uuid, p_receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE origin uuid; withdrawal app.framework_publication_revocation_jobs%ROWTYPE;
BEGIN
  SELECT mount.origin_id INTO origin FROM app.framework_publication_reviews review
    JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id WHERE review.id = p_review;
  PERFORM 1 FROM app.framework_publication_origins WHERE id = origin FOR UPDATE;
  SELECT * INTO withdrawal FROM app.framework_publication_revocation_jobs
    WHERE review_id = p_review FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF withdrawal.state = 'revoked' THEN RETURN withdrawal.receipt = p_receipt; END IF;
  IF withdrawal.lease_token IS DISTINCT FROM p_token OR p_token IS NULL
    OR withdrawal.lease_expires_at <= clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM app.framework_publication_origins
      WHERE id = origin AND active_publication_id = p_review)
  THEN RETURN false; END IF;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::text) > 100000
    OR p_receipt->>'schema' IS DISTINCT FROM 'opengeo.framework-publication-revocation-receipt.1.0.0'
    OR p_receipt->>'reviewId' IS DISTINCT FROM p_review::text
    OR p_receipt->>'targetPrefix' IS DISTINCT FROM 'releases/framework-' || p_review::text
    OR p_receipt->>'originId' IS DISTINCT FROM origin::text
    OR p_receipt->'confirmed' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_receipt->'delivery') IS DISTINCT FROM 'string'
    OR coalesce(length(p_receipt->>'delivery'), 0) NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'Publication revocation receipt invalid' USING ERRCODE = '23514'; END IF;
  UPDATE app.framework_publication_revocation_jobs
    SET state = 'revoked', receipt = p_receipt, error_code = NULL, lease_token = NULL,
      lease_expires_at = NULL, updated_at = clock_timestamp() WHERE review_id = p_review;
  UPDATE app.framework_publication_origins SET active_publication_id = NULL
    WHERE id = origin AND active_publication_id = p_review;
  RETURN true;
END;
$$;

CREATE FUNCTION app.fail_framework_publication_revocation(p_review uuid, p_token uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE origin uuid;
BEGIN
  SELECT mount.origin_id INTO origin FROM app.framework_publication_reviews review
    JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id WHERE review.id = p_review;
  PERFORM 1 FROM app.framework_publication_origins WHERE id = origin FOR UPDATE;
  IF p_error IS NULL OR p_error !~ '^[a-z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'Publication revocation error invalid' USING ERRCODE = '23514';
  END IF;
  UPDATE app.framework_publication_revocation_jobs SET state = 'needs_attention', error_code = p_error,
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE review_id = p_review AND state <> 'revoked' AND lease_token = p_token
      AND lease_expires_at > clock_timestamp()
      AND EXISTS (SELECT 1 FROM app.framework_publication_origins
        WHERE id = origin AND active_publication_id = p_review);
  IF NOT FOUND THEN RETURN false; END IF;
  -- Match publication failure semantics: keep the origin reserved after an
  -- ambiguous transport failure. Only this exact withdrawal may resume until
  -- its delivery receipt proves completion; a sibling cutover must not race it.
  RETURN true;
END;
$$;

-- Request-checked adapters fail closed immediately. Static/CDN delivery must
-- acknowledge its own completed withdrawal before API state becomes revoked.
CREATE FUNCTION app.framework_publication_edition_available(p_review uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.framework_publication_reviews review
    JOIN app.framework_publication_jobs job ON job.review_id = review.id
      AND job.organization_id = review.organization_id AND job.project_id = review.project_id
    WHERE review.id = p_review AND job.stage = 'deployed'
      AND NOT EXISTS (SELECT 1 FROM app.framework_publication_revocations revoked
        WHERE revoked.review_id = review.id)
  );
$$;

-- Existing local/hosted publisher actions discover only bounded claimable IDs;
-- tenant callers receive no global queue inventory or underlying table grants.
CREATE FUNCTION app.pending_framework_publication_revocations(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Publication revocation batch limit invalid' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(item.review_id ORDER BY item.requested_at, item.review_id), '[]'::jsonb)
    INTO result FROM (
      SELECT request.review_id, request.requested_at
      FROM app.framework_publication_revocations request
      JOIN app.framework_publication_revocation_jobs job ON job.review_id = request.review_id
        AND job.organization_id = request.organization_id AND job.project_id = request.project_id
      JOIN app.framework_publication_reviews review ON review.id = request.review_id
      JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id
      JOIN app.framework_publication_origins origin ON origin.id = mount.origin_id
      WHERE job.state IN ('pending', 'needs_attention')
        AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= clock_timestamp())
        AND (origin.active_publication_id IS NULL OR origin.active_publication_id = request.review_id)
      ORDER BY request.requested_at, request.review_id LIMIT p_limit
    ) item;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION app.request_framework_publication_revocation(uuid, uuid, uuid),
  app.claim_framework_publication_revocation(uuid, uuid),
  app.complete_framework_publication_revocation(uuid, uuid, jsonb),
  app.fail_framework_publication_revocation(uuid, uuid, text),
  app.framework_publication_edition_available(uuid),
  app.pending_framework_publication_revocations(integer)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.request_framework_publication_revocation(uuid, uuid, uuid),
  app.framework_publication_edition_available(uuid) TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.claim_framework_publication_revocation(uuid, uuid),
  app.complete_framework_publication_revocation(uuid, uuid, jsonb),
  app.fail_framework_publication_revocation(uuid, uuid, text),
  app.framework_publication_edition_available(uuid),
  app.pending_framework_publication_revocations(integer) TO opengeo_framework_publisher;

COMMIT;
