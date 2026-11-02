BEGIN;

-- A superseded edition's withdrawal never suppresses its newer replacement.
-- Latest means successfully deployed generation for the exact immutable mount.
CREATE FUNCTION app.framework_publication_withdrawn_mounts(p_origin uuid, p_confirmed_only boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE result jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(latest.mount_path ORDER BY latest.mount_path), '[]'::jsonb)
    INTO result FROM (
      SELECT DISTINCT ON (review.mount_id) review.id, review.mount_path
      FROM app.framework_publication_reviews review
      JOIN app.framework_publication_jobs job ON job.review_id = review.id
        AND job.organization_id = review.organization_id AND job.project_id = review.project_id
        AND job.origin_id = p_origin AND job.stage = 'deployed'
      JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id
        AND mount.organization_id = review.organization_id AND mount.project_id = review.project_id
        AND mount.source_project_id = review.source_project_id AND mount.origin_id = job.origin_id
      ORDER BY review.mount_id, review.expected_generation DESC, review.id DESC
    ) latest
    JOIN app.framework_publication_revocations request ON request.review_id = latest.id
    JOIN app.framework_publication_revocation_jobs withdrawal ON withdrawal.review_id = request.review_id
      AND withdrawal.organization_id = request.organization_id AND withdrawal.project_id = request.project_id
    WHERE NOT p_confirmed_only OR withdrawal.state = 'revoked';
  IF jsonb_array_length(result) > 2048 THEN
    RAISE EXCEPTION 'Publication withdrawn mount limit exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.framework_publication_withdrawn_mounts(uuid, boolean)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
    opengeo_observable_coordinator, opengeo_framework_publisher;

-- Append to the installed claim rather than replaying its older definition;
-- retained native input, distribution and previous-plan contracts stay intact.
DO $$
DECLARE definition text; anchor text := '''plan'', j.plan, ''edge_snapshot'', j.edge_snapshot';
BEGIN
  definition := pg_get_functiondef('app.claim_framework_publication(uuid,uuid)'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Unexpected publication claim';
  END IF;
  EXECUTE replace(definition, anchor,
    '''withdrawn_mounts'', app.framework_publication_withdrawn_mounts(o.id, false), ' || anchor);
END;
$$;

-- Only confirmed withdrawals fence an already sealed in-flight publication.
-- A new pending request waits for its origin reservation, then withdraws that
-- publication's latest composed snapshot. Never discard ambiguous reservations.
CREATE OR REPLACE FUNCTION app.authorize_framework_publication(p_review uuid, p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
  SELECT app.framework_publisher_authorized(p_review) AND EXISTS (
    SELECT 1 FROM app.framework_publication_jobs job
    JOIN app.framework_publication_origins origin ON origin.id = job.origin_id
    JOIN app.framework_publication_reviews review ON review.id = job.review_id
    WHERE job.review_id = p_review AND job.lease_token = p_token
      AND job.lease_expires_at > clock_timestamp() AND job.stage <> 'deployed'
      AND origin.active_publication_id = p_review
      AND (job.plan IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          app.framework_publication_withdrawn_mounts(origin.id, true)
        ) withdrawn(mount_path)
        WHERE withdrawn.mount_path <> review.mount_path
          AND NOT (coalesce(job.plan->'withdrawnMounts', '[]'::jsonb) ? withdrawn.mount_path)
      ))
  );
$$;

-- Origin-wide release prefixes advance for sibling mounts. The highest sealed
-- generation among deployed reviews of this exact mount identifies its current
-- edition; creation/update timestamps and the origin's current prefix do not.
CREATE FUNCTION app.framework_publication_withdrawal_plan(
  p_plan jsonb, p_mount text, p_reserved jsonb, p_keep_proof boolean
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, app AS $$
DECLARE files jsonb;
BEGIN
  IF p_plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_plan->'files') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_reserved) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_reserved) > 2048
  THEN RAISE EXCEPTION 'Publication withdrawal plan invalid' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(jsonb_agg(
    CASE WHEN jsonb_typeof(entry->'source') = 'object'
      AND NOT (p_keep_proof AND entry->>'path' = ltrim(p_mount, '/') || 'index.html')
    THEN jsonb_set(entry, '{source}', (entry->'source') - 'localizedOutput')
    ELSE entry END ORDER BY entry->>'path'), '[]'::jsonb)
    INTO files FROM jsonb_array_elements(p_plan->'files') entry
    WHERE (SELECT mount_path FROM jsonb_array_elements_text(p_reserved) owned(mount_path)
      WHERE mount_path = '/' OR entry->>'path' IN (trim(both '/' FROM mount_path),
        trim(both '/' FROM mount_path) || '.html')
        OR starts_with(entry->>'path', ltrim(mount_path, '/'))
      ORDER BY length(mount_path) DESC LIMIT 1) = p_mount;
  IF jsonb_array_length(files) > 8 THEN
    RAISE EXCEPTION 'Publication withdrawal file limit exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('schema', p_plan->'schema', 'reviewId', p_plan->'reviewId',
    'buildId', p_plan->'buildId', 'bucket', p_plan->'bucket',
    'targetPrefix', p_plan->'targetPrefix', 'previousPrefix', p_plan->'previousPrefix',
    'mountPath', p_plan->'mountPath', 'privateOrigin', p_plan->'privateOrigin',
    'editionPath', p_plan->'editionPath', 'files', files);
END;
$$;
REVOKE ALL ON FUNCTION app.framework_publication_withdrawal_plan(jsonb, text, jsonb, boolean)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
    opengeo_observable_coordinator, opengeo_framework_publisher;

CREATE OR REPLACE FUNCTION app.claim_framework_publication_revocation(p_review uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  review app.framework_publication_reviews%ROWTYPE;
  origin app.framework_publication_origins%ROWTYPE;
  withdrawal app.framework_publication_revocation_jobs%ROWTYPE;
  current_mount_review uuid;
  reserved_mounts jsonb;
  result jsonb;
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
  SELECT candidate.id INTO current_mount_review
    FROM app.framework_publication_reviews candidate
    JOIN app.framework_publication_jobs deployed ON deployed.review_id = candidate.id
      AND deployed.organization_id = candidate.organization_id
      AND deployed.project_id = candidate.project_id
      AND deployed.origin_id = origin.id AND deployed.stage = 'deployed'
    WHERE candidate.mount_id = review.mount_id
      AND candidate.organization_id = review.organization_id
      AND candidate.project_id = review.project_id
      AND candidate.source_project_id = review.source_project_id
    ORDER BY candidate.expected_generation DESC, candidate.id DESC LIMIT 1;
  UPDATE app.framework_publication_revocation_jobs
    SET lease_token = p_token, lease_expires_at = clock_timestamp() + interval '5 minutes',
      state = 'pending', error_code = NULL, updated_at = clock_timestamp()
    WHERE review_id = p_review;
  UPDATE app.framework_publication_origins SET active_publication_id = p_review
    WHERE id = origin.id;
  SELECT jsonb_agg(mount_path ORDER BY mount_path) INTO reserved_mounts
    FROM app.framework_publication_mounts WHERE origin_id = origin.id
      AND organization_id = origin.organization_id;
  result := jsonb_build_object('status', 'claimed', 'review_id', review.id,
    'organization_id', review.organization_id, 'project_id', review.project_id,
    'source_project_id', review.source_project_id, 'mount_path', review.mount_path,
    'target_prefix', 'releases/framework-' || review.id::text, 'origin', to_jsonb(origin),
    'target_plan', app.framework_publication_withdrawal_plan((SELECT job.plan FROM app.framework_publication_jobs job
      WHERE job.review_id = review.id AND job.organization_id = review.organization_id
        AND job.project_id = review.project_id AND job.origin_id = origin.id AND job.stage = 'deployed'),
      review.mount_path, reserved_mounts, true),
    'current_release_plan', app.framework_publication_withdrawal_plan((SELECT job.plan FROM app.framework_publication_jobs job
      WHERE job.organization_id = origin.organization_id AND job.origin_id = origin.id
        AND job.stage = 'deployed' AND job.plan->>'targetPrefix' = origin.active_release_prefix
        AND job.plan->>'reviewId' = job.review_id::text
        AND job.plan->>'targetPrefix' = 'releases/framework-' || job.review_id::text LIMIT 1),
      review.mount_path, reserved_mounts, false),
    'reserved_mounts', reserved_mounts,
    'current_mount_review_id', current_mount_review,
    'is_current_mount_edition', coalesce(current_mount_review = review.id, false));
  IF octet_length(result::text) > 600000 THEN
    RAISE EXCEPTION 'Publication withdrawal claim limit exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN result;
END;
$$;

-- A successful delivery step can still be propagating. Release only this
-- attempt's lease while retaining the exact origin reservation and pending
-- state; another review must not cut over during ambiguous withdrawal delivery.
CREATE FUNCTION app.pending_framework_publication_revocation(p_review uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE origin uuid;
BEGIN
  SELECT mount.origin_id INTO origin FROM app.framework_publication_reviews review
    JOIN app.framework_publication_mounts mount ON mount.id = review.mount_id
    WHERE review.id = p_review;
  PERFORM 1 FROM app.framework_publication_origins WHERE id = origin FOR UPDATE;
  UPDATE app.framework_publication_revocation_jobs
    SET lease_token = NULL, lease_expires_at = NULL, state = 'pending', error_code = NULL,
      updated_at = clock_timestamp()
    WHERE review_id = p_review AND state = 'pending' AND p_token IS NOT NULL
      AND lease_token = p_token AND lease_expires_at > clock_timestamp()
      AND EXISTS (SELECT 1 FROM app.framework_publication_origins
        WHERE id = origin AND active_publication_id = p_review);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION app.pending_framework_publication_revocation(uuid, uuid)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.pending_framework_publication_revocation(uuid, uuid)
  TO opengeo_framework_publisher;

COMMIT;
