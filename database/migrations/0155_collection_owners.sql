BEGIN;
-- Preserve existing User owners and creator provenance; ownership is not audience.
ALTER TABLE app.workspace_collections
  ALTER COLUMN owner_user_id DROP NOT NULL,
  ADD COLUMN owner_team_id uuid,
  ADD COLUMN owner_organization_id uuid,
  ADD CONSTRAINT workspace_collections_one_owner CHECK (
    num_nonnulls(owner_user_id, owner_team_id, owner_organization_id) = 1
  ),
  ADD CONSTRAINT workspace_collections_owner_team_fk
    FOREIGN KEY (organization_id, owner_team_id) REFERENCES app.teams(organization_id, id),
  ADD CONSTRAINT workspace_collections_owner_organization_fk
    FOREIGN KEY (owner_organization_id) REFERENCES app.organizations(id),
  ADD CONSTRAINT workspace_collections_owner_organization_scope CHECK (
    owner_organization_id IS NULL OR owner_organization_id = organization_id
  );

CREATE INDEX workspace_collections_owner_team_idx
  ON app.workspace_collections(organization_id, owner_team_id)
  WHERE owner_team_id IS NOT NULL;

COMMENT ON COLUMN app.workspace_collections.owner_user_id IS
  'Actual User owner, null for Team/Organization ownership; never a creator fallback.';
COMMENT ON COLUMN app.workspace_collections.owner_team_id IS
  'Same-account Team owner. Current active Team membership supplies declared Collection authority only.';
COMMENT ON COLUMN app.workspace_collections.owner_organization_id IS
  'Owning security-account Organization. Agency/client business context and audience remain independent.';

-- Extend only the existing metadata inventory from 0154. Retain its reviewed
-- allowlist, access policy, bounds and grants; activate no recovery body draft.
DO $owners$
DECLARE
  definition text;
  old_projection constant text := '"workspace_collections": ["created_at", "created_by", "id", "organization_id", "owner_user_id", "revision", "title", "updated_at", "visibility"]';
  new_projection constant text := '"workspace_collections": ["created_at", "created_by", "id", "organization_id", "owner_organization_id", "owner_team_id", "owner_user_id", "revision", "title", "updated_at", "visibility"]';
BEGIN
  SELECT pg_get_functiondef('app.capture_account_recovery_inventory()'::regprocedure)
    INTO definition;
  IF (length(definition) - length(replace(definition, old_projection, '')))
      <> length(old_projection) THEN
    RAISE EXCEPTION 'Collection recovery metadata projection changed; review ownership migration';
  END IF;
  EXECUTE replace(definition, old_projection, new_projection);
END
$owners$;
COMMIT;
