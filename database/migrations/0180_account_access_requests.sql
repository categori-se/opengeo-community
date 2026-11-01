BEGIN;

-- Requests are isolated from identities and grants. Only the explicitly selected
-- reviewer can read them; an ordinary account administrator is not a reviewer.
CREATE TABLE app.account_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  reviewer_user_id uuid NOT NULL REFERENCES app.users(id),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email = lower(email)),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 10 AND 2000),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  client_fingerprint text NOT NULL CHECK (length(client_fingerprint) = 64),
  invitation_id uuid REFERENCES app.membership_invitations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  CHECK ((state = 'pending') = (reviewed_at IS NULL)),
  CHECK ((state = 'approved') = (invitation_id IS NOT NULL)),
  UNIQUE (organization_id, reviewer_user_id, email)
);
CREATE TABLE app.account_request_rate_limits (
  client_fingerprint text PRIMARY KEY CHECK (length(client_fingerprint) = 64),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 6)
);
ALTER TABLE app.account_request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_request_rate_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.account_request_rate_limits FROM PUBLIC, opengeo_runtime, opengeo_worker;
ALTER TABLE app.account_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY account_access_requests_reviewer ON app.account_access_requests
  USING (organization_id = app.current_organization_id()
    AND reviewer_user_id = app.current_user_id()
    AND EXISTS (SELECT 1 FROM app.organization_memberships membership
      WHERE membership.organization_id = account_access_requests.organization_id
        AND membership.user_id = app.current_user_id() AND membership.role = 'admin'))
  WITH CHECK (organization_id = app.current_organization_id()
    AND reviewer_user_id = app.current_user_id());
REVOKE ALL ON app.account_access_requests FROM PUBLIC, opengeo_runtime, opengeo_worker;
GRANT SELECT, UPDATE ON app.account_access_requests TO opengeo_runtime;

-- Anonymous callers receive no row identity, state or account existence data.
-- This is the sole anonymous write and cannot provision an identity or a grant.
CREATE FUNCTION app.submit_account_access_request(
  p_organization uuid, p_reviewer uuid, p_email text, p_name text,
  p_purpose text, p_fingerprint text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  attempt_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.organization_memberships
    WHERE organization_id = p_organization AND user_id = p_reviewer AND role = 'admin')
  THEN RETURN 'unavailable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_fingerprint, 0));
  INSERT INTO app.account_request_rate_limits AS rate
    (client_fingerprint, window_started_at, attempts)
  VALUES (p_fingerprint, clock_timestamp(), 1)
  ON CONFLICT (client_fingerprint) DO UPDATE SET
    attempts = CASE WHEN rate.window_started_at <= clock_timestamp() - interval '1 hour'
      THEN 1 ELSE least(rate.attempts + 1, 6) END,
    window_started_at = CASE
      WHEN rate.window_started_at <= clock_timestamp() - interval '1 hour'
      THEN clock_timestamp() ELSE rate.window_started_at END
  RETURNING attempts INTO attempt_count;
  IF attempt_count > 5
  THEN RETURN 'rate_limited'; END IF;
  INSERT INTO app.account_access_requests
    (organization_id, reviewer_user_id, email, display_name, purpose, client_fingerprint)
  VALUES (p_organization, p_reviewer, p_email, p_name, p_purpose, p_fingerprint)
  ON CONFLICT (organization_id, reviewer_user_id, email) DO NOTHING;
  RETURN 'pending';
END;
$$;
REVOKE ALL ON FUNCTION app.submit_account_access_request(uuid,uuid,text,text,text,text)
  FROM PUBLIC, opengeo_worker;
GRANT EXECUTE ON FUNCTION app.submit_account_access_request(uuid,uuid,text,text,text,text)
  TO opengeo_runtime;

COMMIT;
