BEGIN;

CREATE TYPE app.project_site_publication_reach AS ENUM (
  'unpublished',
  'unlisted',
  'listed'
);

CREATE TABLE app.project_site_publication_destinations (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  reach app.project_site_publication_reach NOT NULL DEFAULT 'unpublished',
  listed_slug text,
  is_primary boolean NOT NULL DEFAULT false,
  configured_by uuid NOT NULL REFERENCES app.users(id),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, site_id),
  UNIQUE (organization_id, project_id, site_id),
  CONSTRAINT project_site_publication_destinations_revision_positive
    CHECK (revision > 0),
  CONSTRAINT project_site_publication_destinations_slug_bounded CHECK (
    listed_slug IS NULL
    OR (
      listed_slug = lower(listed_slug)
      AND listed_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
    )
  ),
  CONSTRAINT project_site_publication_destinations_shape CHECK (
    (reach = 'listed' AND listed_slug IS NOT NULL)
    OR (reach IN ('unpublished', 'unlisted') AND NOT is_primary)
  ),
  CONSTRAINT project_site_publication_destinations_primary_listed CHECK (
    NOT is_primary OR reach = 'listed'
  ),
  FOREIGN KEY (organization_id, project_id, site_id)
    REFERENCES app.project_sites (organization_id, project_id, id)
);

-- Listed paths are account-wide reservations. They remain reserved while a
-- site is unpublished or unlisted so a citation can never silently move to an
-- unrelated project.
CREATE UNIQUE INDEX project_site_publication_destinations_slug_idx
  ON app.project_site_publication_destinations (organization_id, lower(listed_slug))
  WHERE listed_slug IS NOT NULL;

CREATE UNIQUE INDEX project_site_publication_destinations_primary_idx
  ON app.project_site_publication_destinations (organization_id)
  WHERE is_primary;

CREATE TABLE app.project_site_publication_destination_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  destination_revision bigint NOT NULL,
  source_reach app.project_site_publication_reach NOT NULL,
  target_reach app.project_site_publication_reach NOT NULL,
  source_listed_slug text,
  target_listed_slug text,
  source_is_primary boolean NOT NULL,
  target_is_primary boolean NOT NULL,
  request_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, site_id, destination_revision),
  CONSTRAINT project_site_publication_destination_events_revision_positive
    CHECK (destination_revision > 1),
  CONSTRAINT project_site_publication_destination_events_request_bounded CHECK (
    request_id = btrim(request_id) AND char_length(request_id) BETWEEN 1 AND 200
  ),
  FOREIGN KEY (organization_id, project_id, site_id)
    REFERENCES app.project_sites (organization_id, project_id, id)
);

ALTER TABLE app.project_site_editions
  ADD COLUMN publication_reach app.project_site_publication_reach NOT NULL DEFAULT 'listed',
  ADD COLUMN listed_slug text,
  ADD COLUMN unlisted_token text,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false;

UPDATE app.project_site_editions edition
SET listed_slug = lower(site.slug)
FROM app.project_sites site
WHERE site.organization_id = edition.organization_id
  AND site.project_id = edition.project_id
  AND site.id = edition.site_id;

ALTER TABLE app.project_site_editions
  ADD CONSTRAINT project_site_editions_publication_destination_shape CHECK (
    (publication_reach = 'unpublished'
      AND listed_slug IS NULL
      AND unlisted_token IS NULL
      AND NOT is_primary)
    OR (publication_reach = 'unlisted'
      AND listed_slug IS NULL
      AND unlisted_token ~ '^[0-9a-f]{32}$'
      AND NOT is_primary)
    OR (publication_reach = 'listed'
      AND listed_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
      AND unlisted_token IS NULL)
  ),
  ADD CONSTRAINT project_site_editions_primary_listed CHECK (
    NOT is_primary OR publication_reach = 'listed'
  );

CREATE UNIQUE INDEX project_site_editions_unlisted_token_idx
  ON app.project_site_editions (unlisted_token)
  WHERE unlisted_token IS NOT NULL;

-- Preserve the current public editions as listed legacy releases. Destination
-- configuration starts unpublished and reserves an account-wide slug only
-- when the prior per-project spelling is unambiguous.
WITH site_slug_counts AS (
  SELECT organization_id, lower(slug) AS slug, count(*) AS site_count
  FROM app.project_sites
  GROUP BY organization_id, lower(slug)
)
INSERT INTO app.project_site_publication_destinations
  (organization_id, project_id, site_id, revision, reach, listed_slug,
   is_primary, configured_by, configured_at)
SELECT site.organization_id,
       site.project_id,
       site.id,
       1,
       'unpublished',
       CASE WHEN counts.site_count = 1 THEN lower(site.slug) ELSE NULL END,
       false,
       site.created_by,
       site.created_at
FROM app.project_sites site
JOIN site_slug_counts counts
  ON counts.organization_id = site.organization_id
 AND counts.slug = lower(site.slug);

CREATE FUNCTION app.create_project_site_publication_destination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO app.project_site_publication_destinations
    (organization_id, project_id, site_id, revision, reach, listed_slug,
     is_primary, configured_by)
  VALUES
    (NEW.organization_id, NEW.project_id, NEW.id, 1, 'unpublished',
     lower(NEW.slug), false, NEW.created_by);
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_publication_destination_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision <> 1
    OR NEW.reach <> 'unpublished'
    OR NEW.is_primary
    OR NEW.configured_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'project site publication destination initial state mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_publication_destination_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.listed_slug IS DISTINCT FROM OLD.listed_slug
    AND OLD.listed_slug IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app.project_site_editions edition
      WHERE edition.organization_id = OLD.organization_id
        AND edition.project_id = OLD.project_id
        AND edition.site_id = OLD.site_id
        AND edition.publication_reach = 'listed'
    )
  THEN
    RAISE EXCEPTION 'published listed project site path is immutable';
  END IF;
  IF NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.site_id <> OLD.site_id
    OR NEW.revision <> OLD.revision + 1
    OR NEW.configured_by <> app.current_user_id()
    OR NEW.configured_at < OLD.configured_at
  THEN
    RAISE EXCEPTION 'project site publication destination revision mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_publication_destination_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination app.project_site_publication_destinations%ROWTYPE;
  previous_event app.project_site_publication_destination_events%ROWTYPE;
  site_slug text;
BEGIN
  IF NEW.actor_user_id <> app.current_user_id() THEN
    RAISE EXCEPTION 'project site publication destination event actor mismatch';
  END IF;
  SELECT * INTO destination
  FROM app.project_site_publication_destinations current_destination
  WHERE current_destination.organization_id = NEW.organization_id
    AND current_destination.project_id = NEW.project_id
    AND current_destination.site_id = NEW.site_id;
  IF NOT FOUND
    OR destination.revision <> NEW.destination_revision
    OR destination.reach <> NEW.target_reach
    OR destination.listed_slug IS DISTINCT FROM NEW.target_listed_slug
    OR destination.is_primary <> NEW.target_is_primary
  THEN
    RAISE EXCEPTION 'project site publication destination event does not match head';
  END IF;
  IF NEW.destination_revision = 2 THEN
    SELECT lower(site.slug) INTO site_slug
    FROM app.project_sites site
    WHERE site.organization_id = NEW.organization_id
      AND site.project_id = NEW.project_id
      AND site.id = NEW.site_id;
    IF NEW.source_reach <> 'unpublished'
      OR NEW.source_is_primary
      OR (
        NEW.source_listed_slug IS NOT NULL
        AND NEW.source_listed_slug IS DISTINCT FROM site_slug
      )
    THEN
      RAISE EXCEPTION 'project site publication destination event source mismatch';
    END IF;
  ELSE
    SELECT * INTO previous_event
    FROM app.project_site_publication_destination_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.project_id = NEW.project_id
      AND event.site_id = NEW.site_id
      AND event.destination_revision = NEW.destination_revision - 1;
    IF NOT FOUND
      OR NEW.source_reach <> previous_event.target_reach
      OR NEW.source_listed_slug IS DISTINCT FROM previous_event.target_listed_slug
      OR NEW.source_is_primary <> previous_event.target_is_primary
    THEN
      RAISE EXCEPTION 'project site publication destination event source mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_publication_destination_event_recorded()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM app.project_site_publication_destination_events event
  WHERE event.organization_id = NEW.organization_id
    AND event.project_id = NEW.project_id
    AND event.site_id = NEW.site_id
    AND event.destination_revision = NEW.revision
    AND event.target_reach = NEW.reach
    AND event.target_listed_slug IS NOT DISTINCT FROM NEW.listed_slug
    AND event.target_is_primary = NEW.is_primary
    AND event.actor_user_id = NEW.configured_by;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project site publication destination update must record its event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_edition_publication_destination_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination app.project_site_publication_destinations%ROWTYPE;
BEGIN
  SELECT * INTO destination
  FROM app.project_site_publication_destinations current_destination
  WHERE current_destination.organization_id = NEW.organization_id
    AND current_destination.project_id = NEW.project_id
    AND current_destination.site_id = NEW.site_id;
  IF NOT FOUND
    OR NEW.publication_reach <> destination.reach
    OR (NEW.publication_reach = 'listed'
      AND NEW.listed_slug IS DISTINCT FROM destination.listed_slug)
    OR (NEW.publication_reach <> 'listed' AND NEW.listed_slug IS NOT NULL)
    OR NEW.is_primary <> destination.is_primary
    OR (NEW.manifest->'publication'->>'reach') IS DISTINCT FROM NEW.publication_reach::text
    OR (NEW.manifest->'publication'->>'listedSlug') IS DISTINCT FROM NEW.listed_slug
    OR (NEW.manifest->'publication'->>'unlistedToken') IS DISTINCT FROM NEW.unlisted_token
    OR (NEW.manifest->'publication'->>'primary') IS DISTINCT FROM lower(NEW.is_primary::text)
  THEN
    RAISE EXCEPTION 'project site edition publication destination seal mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_edition_publication_destination_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.publication_reach <> OLD.publication_reach
    OR NEW.listed_slug IS DISTINCT FROM OLD.listed_slug
    OR NEW.unlisted_token IS DISTINCT FROM OLD.unlisted_token
    OR NEW.is_primary <> OLD.is_primary
  THEN
    RAISE EXCEPTION 'project site edition publication destination is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_sites_create_publication_destination
  AFTER INSERT ON app.project_sites
  FOR EACH ROW EXECUTE FUNCTION app.create_project_site_publication_destination();
CREATE TRIGGER project_site_publication_destinations_validate_insert
  BEFORE INSERT ON app.project_site_publication_destinations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_publication_destination_insert();
CREATE TRIGGER project_site_publication_destinations_validate_update
  BEFORE UPDATE ON app.project_site_publication_destinations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_publication_destination_update();
CREATE TRIGGER project_site_publication_destinations_reject_delete
  BEFORE DELETE ON app.project_site_publication_destinations
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER project_site_publication_destination_events_validate_insert
  BEFORE INSERT ON app.project_site_publication_destination_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_publication_destination_event_insert();
CREATE TRIGGER project_site_publication_destination_events_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_site_publication_destination_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE CONSTRAINT TRIGGER project_site_publication_destination_event_required
  AFTER UPDATE ON app.project_site_publication_destinations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_publication_destination_event_recorded();
CREATE TRIGGER project_site_editions_validate_publication_destination
  BEFORE INSERT ON app.project_site_editions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_edition_publication_destination_insert();
CREATE TRIGGER project_site_editions_keep_publication_destination
  BEFORE UPDATE ON app.project_site_editions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_edition_publication_destination_immutable();

ALTER TABLE app.project_site_publication_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_publication_destination_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_publication_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_publication_destination_events FORCE ROW LEVEL SECURITY;

CREATE POLICY project_site_publication_destinations_tenant_isolation
  ON app.project_site_publication_destinations
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_site_publication_destination_events_tenant_isolation
  ON app.project_site_publication_destination_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.project_site_publication_destinations TO opengeo_runtime;
GRANT SELECT, INSERT ON app.project_site_publication_destination_events TO opengeo_runtime;
REVOKE DELETE ON
  app.project_site_publication_destinations,
  app.project_site_publication_destination_events
FROM opengeo_runtime;
REVOKE ALL ON
  app.project_site_publication_destinations,
  app.project_site_publication_destination_events
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
REVOKE EXECUTE ON FUNCTION
  app.create_project_site_publication_destination(),
  app.enforce_project_site_publication_destination_insert(),
  app.enforce_project_site_publication_destination_update(),
  app.enforce_project_site_publication_destination_event_insert(),
  app.enforce_project_site_publication_destination_event_recorded(),
  app.enforce_project_site_edition_publication_destination_insert(),
  app.enforce_project_site_edition_publication_destination_immutable()
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;

COMMENT ON TABLE app.project_site_publication_destinations IS
  'Versioned account-wide publication intent and permanent listed-path reservation, separate from mutable authoring access and immutable editions.';
COMMENT ON TABLE app.project_site_publication_destination_events IS
  'Append-only actor/request-attributed changes between unpublished, opaque unlisted, listed path, and primary-root publication destinations.';
COMMENT ON COLUMN app.project_site_editions.unlisted_token IS
  'Exactly 128 random bits encoded as lower-case hexadecimal for one immutable unlisted edition; never user-selected.';

COMMIT;
