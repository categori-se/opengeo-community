BEGIN;

-- A capability records its historical requester, not a permanent membership.
-- Keep the existing organization, user, project and build identity references;
-- remove only the membership FK that prevented ordinary account offboarding.
DO $$
DECLARE membership_constraint name;
BEGIN
  SELECT constraint_record.conname INTO STRICT membership_constraint
  FROM pg_catalog.pg_constraint constraint_record
  WHERE constraint_record.conrelid = 'app.observable_preview_capabilities'::regclass
    AND constraint_record.confrelid = 'app.organization_memberships'::regclass
    AND constraint_record.contype = 'f'
    AND (
      SELECT array_agg(attribute.attname::text ORDER BY key.position)
      FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key(number, position)
      JOIN pg_catalog.pg_attribute attribute
        ON attribute.attrelid = constraint_record.conrelid AND attribute.attnum = key.number
    ) = ARRAY['organization_id', 'requested_by']::text[];
  EXECUTE format('ALTER TABLE app.observable_preview_capabilities DROP CONSTRAINT %I', membership_constraint);
END;
$$;

-- Replace the FK's admission/locking effect without tying retained audit rows
-- to a revocable grant. API issue/exchange authorization and the SQL exchange
-- membership check are unchanged, as are already issued signed-cookie leases.
CREATE FUNCTION app.require_observable_preview_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_id = NEW.requested_by
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observable preview requires current organization membership'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER observable_preview_capability_membership_guard
BEFORE INSERT ON app.observable_preview_capabilities
FOR EACH ROW EXECUTE FUNCTION app.require_observable_preview_membership();

REVOKE ALL ON FUNCTION app.require_observable_preview_membership()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

COMMENT ON FUNCTION app.require_observable_preview_membership() IS
  'Require and key-share-lock current requester membership at insertion; capability history survives later offboarding without granting access.';

COMMIT;
