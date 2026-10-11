BEGIN;

CREATE TYPE app.invitation_state AS ENUM ('pending', 'accepted', 'revoked');

CREATE TABLE app.membership_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  invitee_user_id uuid NOT NULL REFERENCES app.users(id),
  email text NOT NULL,
  organization_role app.organization_role NOT NULL,
  project_id uuid,
  project_role app.project_role,
  state app.invitation_state NOT NULL DEFAULT 'pending',
  invited_by uuid NOT NULL REFERENCES app.users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT membership_invitations_email_normalized CHECK (email = lower(email)),
  CONSTRAINT membership_invitations_future_expiry CHECK (expires_at > created_at),
  CONSTRAINT membership_invitations_project_scope CHECK (
    (project_id IS NULL AND project_role IS NULL)
    OR (project_id IS NOT NULL AND project_role IS NOT NULL)
  ),
  CONSTRAINT membership_invitations_transition_shape CHECK (
    (state = 'pending' AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (state = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND accepted_at IS NULL AND revoked_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE INDEX membership_invitations_tenant_feed_idx
  ON app.membership_invitations (organization_id, created_at DESC, id);
CREATE INDEX membership_invitations_invitee_idx
  ON app.membership_invitations (invitee_user_id, created_at DESC, id);
CREATE UNIQUE INDEX membership_invitations_one_pending_scope
  ON app.membership_invitations (
    organization_id,
    invitee_user_id,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE state = 'pending';

CREATE FUNCTION app.enforce_invitation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.invitee_user_id IS DISTINCT FROM NEW.invitee_user_id
    OR OLD.email IS DISTINCT FROM NEW.email
    OR OLD.organization_role IS DISTINCT FROM NEW.organization_role
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.project_role IS DISTINCT FROM NEW.project_role
    OR OLD.invited_by IS DISTINCT FROM NEW.invited_by
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'invitation identity, scope, role, and expiry are immutable';
  END IF;

  IF OLD.state <> 'pending' OR NEW.state NOT IN ('accepted', 'revoked') THEN
    RAISE EXCEPTION 'invitation transitions are forward-only';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER membership_invitations_enforce_transition
  BEFORE UPDATE ON app.membership_invitations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_invitation_transition();
CREATE TRIGGER membership_invitations_set_updated_at
  BEFORE UPDATE ON app.membership_invitations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.membership_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY membership_invitations_tenant_isolation
  ON app.membership_invitations
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.provision_invited_user(
  p_cognito_subject text,
  p_email text,
  p_display_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_actor uuid := app.current_user_id();
  v_organization uuid := app.current_organization_id();
  v_subject_user uuid;
  v_email_user uuid;
BEGIN
  IF p_email <> lower(p_email) OR p_email = '' OR p_cognito_subject = '' OR p_display_name = '' THEN
    RAISE EXCEPTION 'invalid invited identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.organization_memberships membership
    WHERE membership.organization_id = v_organization
      AND membership.user_id = v_actor
      AND membership.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'organization administrator required';
  END IF;

  SELECT identity.id INTO v_subject_user
  FROM app.users identity
  WHERE identity.cognito_subject = p_cognito_subject;

  SELECT identity.id INTO v_email_user
  FROM app.users identity
  WHERE identity.email = p_email;

  IF v_subject_user IS NOT NULL AND v_email_user IS NOT NULL
     AND v_subject_user <> v_email_user THEN
    RAISE EXCEPTION 'invited identity conflicts with an existing email';
  END IF;

  IF v_subject_user IS NOT NULL THEN
    IF v_email_user IS NULL THEN
      RAISE EXCEPTION 'invited identity email does not match';
    END IF;
    RETURN v_subject_user;
  END IF;

  IF v_email_user IS NOT NULL THEN
    RAISE EXCEPTION 'invited email belongs to a different identity';
  END IF;

  INSERT INTO app.users (cognito_subject, email, display_name)
  VALUES (p_cognito_subject, p_email, p_display_name)
  RETURNING id INTO v_subject_user;
  RETURN v_subject_user;
END;
$$;

CREATE FUNCTION app.accept_membership_invitation(
  p_invitation_id uuid,
  p_request_id text
)
RETURNS TABLE (
  result_code text,
  invitation_id uuid,
  organization_id uuid,
  project_id uuid,
  organization_role app.organization_role,
  project_role app.project_role,
  accepted_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  v_user uuid := app.current_user_id();
  invitation app.membership_invitations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT candidate.* INTO invitation
  FROM app.membership_invitations candidate
  WHERE candidate.id = p_invitation_id
    AND candidate.invitee_user_id = v_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::app.organization_role, NULL::app.project_role, NULL::timestamptz;
    RETURN;
  END IF;

  IF invitation.state = 'accepted' THEN
    RETURN QUERY SELECT 'already_accepted', invitation.id, invitation.organization_id,
      invitation.project_id, invitation.organization_role, invitation.project_role,
      invitation.accepted_at;
    RETURN;
  END IF;

  IF invitation.state = 'revoked' THEN
    RETURN QUERY SELECT 'revoked', invitation.id, invitation.organization_id,
      invitation.project_id, invitation.organization_role, invitation.project_role,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF invitation.expires_at <= v_now THEN
    RETURN QUERY SELECT 'expired', invitation.id, invitation.organization_id,
      invitation.project_id, invitation.organization_role, invitation.project_role,
      NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO app.organization_memberships
    (organization_id, user_id, role, invited_by)
  VALUES (
    invitation.organization_id,
    v_user,
    invitation.organization_role,
    invitation.invited_by
  )
  ON CONFLICT ON CONSTRAINT organization_memberships_pkey DO NOTHING;

  IF invitation.project_id IS NOT NULL THEN
    INSERT INTO app.project_memberships
      (organization_id, project_id, user_id, role)
    VALUES (
      invitation.organization_id,
      invitation.project_id,
      v_user,
      invitation.project_role
    )
    ON CONFLICT ON CONSTRAINT project_memberships_pkey DO NOTHING;
  END IF;

  UPDATE app.membership_invitations
  SET state = 'accepted', accepted_at = v_now
  WHERE id = invitation.id;

  INSERT INTO app.activity_events
    (organization_id, actor_user_id, project_id, event_type, resource_type,
     resource_id, request_id, payload)
  VALUES (
    invitation.organization_id,
    v_user,
    invitation.project_id,
    'membership.invitation.accepted',
    'membership_invitation',
    invitation.id,
    p_request_id,
    jsonb_build_object(
      'organization_role', invitation.organization_role,
      'project_role', invitation.project_role
    )
  );

  RETURN QUERY SELECT 'accepted', invitation.id, invitation.organization_id,
    invitation.project_id, invitation.organization_role, invitation.project_role, v_now;
END;
$$;

CREATE FUNCTION app.list_pending_membership_invitations()
RETURNS TABLE (
  invitation_id uuid,
  organization_id uuid,
  organization_name text,
  project_id uuid,
  project_name text,
  organization_role app.organization_role,
  project_role app.project_role,
  expires_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT
    invitation.id,
    invitation.organization_id,
    organization.name,
    invitation.project_id,
    project.name,
    invitation.organization_role,
    invitation.project_role,
    invitation.expires_at,
    invitation.created_at
  FROM app.membership_invitations invitation
  JOIN app.organizations organization ON organization.id = invitation.organization_id
  LEFT JOIN app.projects project
    ON project.organization_id = invitation.organization_id
   AND project.id = invitation.project_id
  WHERE invitation.invitee_user_id = app.current_user_id()
    AND invitation.state = 'pending'
    AND invitation.expires_at > clock_timestamp()
  ORDER BY invitation.created_at, invitation.id
  LIMIT 100
$$;

REVOKE EXECUTE ON FUNCTION
  app.enforce_invitation_transition(),
  app.provision_invited_user(text, text, text),
  app.accept_membership_invitation(uuid, text),
  app.list_pending_membership_invitations()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.provision_invited_user(text, text, text),
  app.accept_membership_invitation(uuid, text),
  app.list_pending_membership_invitations()
TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.membership_invitations TO opengeo_runtime;

COMMENT ON TABLE app.membership_invitations IS
  'Tenant-owned, non-deletable invitations; pending records may only advance to accepted or revoked.';
COMMENT ON FUNCTION app.provision_invited_user(text, text, text) IS
  'Admin-gated identity reconciliation for a Cognito subject established by the invitation service.';
COMMENT ON FUNCTION app.accept_membership_invitation(uuid, text) IS
  'Single-use, authenticated-user-bound invitation acceptance with atomic memberships and activity.';
COMMENT ON FUNCTION app.list_pending_membership_invitations() IS
  'Bounded invitation discovery for the authenticated user before organization membership exists.';

COMMIT;
