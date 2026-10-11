BEGIN;
-- Renew only the pending policy window; never change its object or expectations.
CREATE OR REPLACE FUNCTION app.enforce_upload_intent_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.original_filename IS DISTINCT FROM NEW.original_filename
    OR OLD.content_type IS DISTINCT FROM NEW.content_type
    OR OLD.expected_size_bytes IS DISTINCT FROM NEW.expected_size_bytes
    OR OLD.expected_sha256 IS DISTINCT FROM NEW.expected_sha256
    OR OLD.bucket IS DISTINCT FROM NEW.bucket
    OR OLD.object_key IS DISTINCT FROM NEW.object_key
    OR OLD.staged_base_version_id IS DISTINCT FROM NEW.staged_base_version_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'upload intent identity, scope, object, and expectations are immutable';
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'pending'
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
    AND NEW.completed_object_id IS NOT DISTINCT FROM OLD.completed_object_id
    AND NEW.expires_at >= OLD.expires_at
    AND NEW.expires_at > clock_timestamp()
    AND NEW.expires_at <= clock_timestamp() + interval '1 hour'
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state <> 'pending' OR NEW.state <> 'completed'
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'upload intent transitions are forward-only';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
