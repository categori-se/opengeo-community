BEGIN;

CREATE TYPE app.project_site_state AS ENUM (
  'draft',
  'review',
  'published'
);

CREATE TABLE app.project_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  slug text NOT NULL,
  current_version_id uuid NOT NULL,
  current_version_number bigint NOT NULL DEFAULT 1,
  state app.project_site_state NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  CONSTRAINT project_sites_slug_bounded CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
  ),
  CONSTRAINT project_sites_version_positive CHECK (current_version_number > 0),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

-- A retired spelling remains reserved for this stable site identity. A later
-- edition may replace an earlier one, but a different site cannot inherit its URL.
CREATE UNIQUE INDEX project_sites_slug_identity_idx
  ON app.project_sites (organization_id, project_id, lower(slug));

CREATE TABLE app.project_site_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  version_number bigint NOT NULL,
  title text NOT NULL,
  description text,
  language text NOT NULL DEFAULT 'en',
  theme text NOT NULL DEFAULT 'paper',
  theme_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, site_id, id),
  UNIQUE (organization_id, site_id, version_number),
  UNIQUE (organization_id, project_id, site_id, id),
  UNIQUE (organization_id, project_id, site_id, version_number),
  CONSTRAINT project_site_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT project_site_versions_title_bounded CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  CONSTRAINT project_site_versions_description_bounded CHECK (
    description IS NULL
    OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 4000)
  ),
  CONSTRAINT project_site_versions_language_bounded CHECK (
    language ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$'
  ),
  CONSTRAINT project_site_versions_theme_bounded CHECK (
    theme ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND jsonb_typeof(theme_options) = 'object'
    AND octet_length(theme_options::text) <= 4096
  ),
  CONSTRAINT project_site_versions_change_bounded CHECK (
    change_message IS NULL
    OR (change_message = btrim(change_message)
        AND char_length(change_message) BETWEEN 1 AND 500)
  ),
  FOREIGN KEY (organization_id, project_id, site_id)
    REFERENCES app.project_sites (organization_id, project_id, id)
);

ALTER TABLE app.project_sites
  ADD CONSTRAINT project_sites_current_version_fk
  FOREIGN KEY (organization_id, project_id, id, current_version_id)
  REFERENCES app.project_site_versions (organization_id, project_id, site_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.project_site_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  site_version_id uuid NOT NULL,
  site_version_number bigint NOT NULL,
  page_slug text NOT NULL,
  navigation_label text NOT NULL,
  position integer NOT NULL,
  is_home boolean NOT NULL DEFAULT false,
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  resource_version_number bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, site_version_id, page_slug),
  UNIQUE (organization_id, site_version_id, position),
  UNIQUE (organization_id, site_version_id, resource_id),
  CONSTRAINT project_site_pages_slug_bounded CHECK (
    page_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$'
  ),
  CONSTRAINT project_site_pages_label_bounded CHECK (
    navigation_label = btrim(navigation_label)
    AND char_length(navigation_label) BETWEEN 1 AND 120
  ),
  CONSTRAINT project_site_pages_position_bounded CHECK (position BETWEEN 0 AND 63),
  CONSTRAINT project_site_pages_versions_positive CHECK (
    site_version_number > 0 AND resource_version_number > 0
  ),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_id)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, id),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_number)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, version_number),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_id)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, id),
  FOREIGN KEY (organization_id, resource_id, resource_version_number)
    REFERENCES app.governed_resource_versions (organization_id, resource_id, version_number)
);

CREATE TABLE app.project_site_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  site_version_id uuid NOT NULL,
  site_version_number bigint NOT NULL,
  source_state app.project_site_state NOT NULL,
  target_state app.project_site_state NOT NULL,
  reason text,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CONSTRAINT project_site_workflow_forward CHECK (
    (source_state = 'draft' AND target_state = 'review')
    OR (source_state = 'review' AND target_state = 'published')
  ),
  CONSTRAINT project_site_workflow_reason_bounded CHECK (
    reason IS NULL
    OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 1000)
  ),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_id)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, id),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_number)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, version_number)
);

CREATE TABLE app.project_site_editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  site_version_id uuid NOT NULL,
  site_version_number bigint NOT NULL,
  edition_number bigint NOT NULL,
  manifest jsonb NOT NULL,
  manifest_checksum_sha256 text NOT NULL,
  published_by uuid NOT NULL REFERENCES app.users(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by uuid REFERENCES app.users(id),
  revoked_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, site_id, edition_number),
  CONSTRAINT project_site_editions_numbers_positive CHECK (
    site_version_number > 0 AND edition_number > 0
  ),
  CONSTRAINT project_site_editions_manifest_bounded CHECK (
    jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 32768
    AND jsonb_typeof(manifest->'references') = 'array'
    AND jsonb_array_length(manifest->'references') <= 128
    AND manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT project_site_editions_revocation_shape CHECK (
    (revoked_by IS NULL AND revoked_at IS NULL)
    OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at >= published_at)
  ),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_id)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, id),
  FOREIGN KEY (organization_id, project_id, site_id, site_version_number)
    REFERENCES app.project_site_versions (organization_id, project_id, site_id, version_number)
);

CREATE UNIQUE INDEX project_site_editions_one_active_idx
  ON app.project_site_editions (organization_id, site_id)
  WHERE revoked_at IS NULL;
CREATE INDEX project_site_editions_history_idx
  ON app.project_site_editions (organization_id, project_id, site_id, edition_number DESC);
CREATE INDEX project_site_pages_resource_idx
  ON app.project_site_pages (organization_id, project_id, resource_id, site_version_id);

CREATE FUNCTION app.enforce_project_site_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id()
    OR NEW.updated_by <> app.current_user_id()
    OR NEW.current_version_number <> 1
    OR NEW.state <> 'draft'
  THEN
    RAISE EXCEPTION 'project site creator or initial state mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_changed boolean;
  state_changed boolean;
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.slug <> OLD.slug
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.updated_by <> app.current_user_id()
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'project site identity or update actor mismatch';
  END IF;
  version_changed := NEW.current_version_id <> OLD.current_version_id;
  state_changed := NEW.state <> OLD.state;
  IF version_changed THEN
    IF NEW.current_version_number <> OLD.current_version_number + 1
      OR NEW.state <> 'draft'
    THEN
      RAISE EXCEPTION 'project site revision must advance once and return to draft';
    END IF;
  ELSIF state_changed THEN
    IF NEW.current_version_number <> OLD.current_version_number
      OR NOT (
        (OLD.state = 'draft' AND NEW.state = 'review')
        OR (OLD.state = 'review' AND NEW.state = 'published')
      )
    THEN
      RAISE EXCEPTION 'project site editorial transition is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'project site update must create a revision or editorial transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_site app.project_sites%ROWTYPE;
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'project site version creator mismatch';
  END IF;
  SELECT * INTO current_site
  FROM app.project_sites site
  WHERE site.organization_id = NEW.organization_id
    AND site.project_id = NEW.project_id
    AND site.id = NEW.site_id
  FOR UPDATE;
  IF NOT FOUND
    OR NOT (
      (NEW.version_number = 1
       AND current_site.current_version_number = 1
       AND current_site.current_version_id = NEW.id)
      OR NEW.version_number = current_site.current_version_number + 1
    )
  THEN
    RAISE EXCEPTION 'project site version must follow the current head';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_page_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by <> app.current_user_id() THEN
    RAISE EXCEPTION 'project site page creator mismatch';
  END IF;
  PERFORM 1
  FROM app.governed_resources resource
  JOIN app.governed_resource_versions version
    ON version.organization_id = resource.organization_id
   AND version.resource_id = resource.id
  WHERE resource.organization_id = NEW.organization_id
    AND resource.project_id = NEW.project_id
    AND resource.id = NEW.resource_id
    AND resource.kind IN ('document', 'story', 'dashboard', 'map')
    AND version.id = NEW.resource_version_id
    AND version.version_number = NEW.resource_version_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project site page must pin an editorial or map resource version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_workflow_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_user_id <> app.current_user_id() THEN
    RAISE EXCEPTION 'project site workflow actor mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_edition_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_site app.project_sites%ROWTYPE;
  page_count bigint;
  home_count bigint;
BEGIN
  IF NEW.published_by <> app.current_user_id()
    OR NEW.revoked_by IS NOT NULL
    OR NEW.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'project site edition publisher mismatch';
  END IF;
  SELECT * INTO current_site
  FROM app.project_sites site
  WHERE site.organization_id = NEW.organization_id
    AND site.project_id = NEW.project_id
    AND site.id = NEW.site_id
  FOR UPDATE;
  IF NOT FOUND
    OR current_site.state <> 'review'
    OR current_site.current_version_id <> NEW.site_version_id
    OR current_site.current_version_number <> NEW.site_version_number
  THEN
    RAISE EXCEPTION 'project site edition must publish the reviewed head';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE page.is_home)
  INTO page_count, home_count
  FROM app.project_site_pages page
  WHERE page.organization_id = NEW.organization_id
    AND page.project_id = NEW.project_id
    AND page.site_id = NEW.site_id
    AND page.site_version_id = NEW.site_version_id;
  IF page_count NOT BETWEEN 1 AND 64 OR home_count <> 1 THEN
    RAISE EXCEPTION 'project site edition requires one to 64 pages and exactly one home page';
  END IF;
  IF NEW.manifest->>'schemaVersion' <> 'opengeo.site-edition.1.0.0'
    OR NEW.manifest->>'organizationId' <> NEW.organization_id::text
    OR NEW.manifest->>'projectId' <> NEW.project_id::text
    OR NEW.manifest->>'siteId' <> NEW.site_id::text
    OR NEW.manifest->>'siteVersionId' <> NEW.site_version_id::text
    OR NEW.manifest->>'siteVersionNumber' <> NEW.site_version_number::text
    OR NEW.manifest->>'editionId' <> NEW.id::text
    OR NEW.manifest->>'editionNumber' <> NEW.edition_number::text
    OR jsonb_typeof(NEW.manifest->'pages') <> 'array'
    OR jsonb_array_length(NEW.manifest->'pages') <> page_count
    OR jsonb_typeof(NEW.manifest->'references') <> 'array'
  THEN
    RAISE EXCEPTION 'project site edition manifest identity or shape mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.manifest->'pages') manifest_page
        WHERE manifest_page->>'slug' = page.page_slug
          AND manifest_page->>'navigationLabel' = page.navigation_label
          AND manifest_page->>'position' = page.position::text
          AND manifest_page->>'home' = lower(page.is_home::text)
          AND manifest_page->>'resourceId' = page.resource_id::text
          AND manifest_page->>'resourceVersionId' = page.resource_version_id::text
          AND manifest_page->>'resourceVersionNumber' = page.resource_version_number::text
      )
  ) THEN
    RAISE EXCEPTION 'project site edition manifest page seal mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    JOIN app.governed_resources resource
      ON resource.organization_id = page.organization_id
     AND resource.project_id = page.project_id
     AND resource.id = page.resource_id
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND (resource.state <> 'published' OR resource.visibility <> 'public')
  ) THEN
    RAISE EXCEPTION 'project site edition pages must be published and public';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.project_site_pages page
    JOIN app.governed_resource_versions version
      ON version.organization_id = page.organization_id
     AND version.resource_id = page.resource_id
     AND version.id = page.resource_version_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(version.content->'blocks') = 'array'
          THEN version.content->'blocks'
        ELSE '[]'::jsonb
      END
    ) block
    WHERE page.organization_id = NEW.organization_id
      AND page.site_version_id = NEW.site_version_id
      AND block->>'type' IN ('map', 'dataset')
      AND NOT EXISTS (
        SELECT 1
        FROM app.governed_resources referenced
        WHERE referenced.organization_id = NEW.organization_id
          AND referenced.project_id = NEW.project_id
          AND referenced.id = CASE
            WHEN block->>'resource_id' ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              THEN (block->>'resource_id')::uuid
            ELSE NULL
          END
          AND referenced.state = 'published'
          AND referenced.visibility = 'public'
      )
  ) THEN
    RAISE EXCEPTION 'project site edition references must be published and public';
  END IF;
  IF (
    WITH expected_reference AS (
      SELECT page.resource_id
      FROM app.project_site_pages page
      JOIN app.governed_resources resource
        ON resource.organization_id = page.organization_id
       AND resource.project_id = page.project_id
       AND resource.id = page.resource_id
      WHERE page.organization_id = NEW.organization_id
        AND page.site_version_id = NEW.site_version_id
        AND resource.kind = 'map'
      UNION
      SELECT CASE
        WHEN block->>'resource_id' ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          THEN (block->>'resource_id')::uuid
        ELSE NULL
      END
      FROM app.project_site_pages page
      JOIN app.governed_resource_versions version
        ON version.organization_id = page.organization_id
       AND version.resource_id = page.resource_id
       AND version.id = page.resource_version_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(version.content->'blocks') = 'array'
            THEN version.content->'blocks'
          ELSE '[]'::jsonb
        END
      ) block
      WHERE page.organization_id = NEW.organization_id
        AND page.site_version_id = NEW.site_version_id
        AND block->>'type' IN ('map', 'dataset')
    ), sealed_reference AS (
      SELECT manifest_reference
      FROM jsonb_array_elements(NEW.manifest->'references') manifest_reference
    )
    SELECT count(*) FROM expected_reference
  ) <> jsonb_array_length(NEW.manifest->'references')
    OR EXISTS (
      WITH expected_reference AS (
        SELECT page.resource_id
        FROM app.project_site_pages page
        JOIN app.governed_resources resource
          ON resource.organization_id = page.organization_id
         AND resource.project_id = page.project_id
         AND resource.id = page.resource_id
        WHERE page.organization_id = NEW.organization_id
          AND page.site_version_id = NEW.site_version_id
          AND resource.kind = 'map'
        UNION
        SELECT CASE
          WHEN block->>'resource_id' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
            THEN (block->>'resource_id')::uuid
          ELSE NULL
        END
        FROM app.project_site_pages page
        JOIN app.governed_resource_versions version
          ON version.organization_id = page.organization_id
         AND version.resource_id = page.resource_id
         AND version.id = page.resource_version_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(version.content->'blocks') = 'array'
              THEN version.content->'blocks'
            ELSE '[]'::jsonb
          END
        ) block
        WHERE page.organization_id = NEW.organization_id
          AND page.site_version_id = NEW.site_version_id
          AND block->>'type' IN ('map', 'dataset')
      )
      SELECT 1
      FROM expected_reference expected
      JOIN app.governed_resources resource
        ON resource.organization_id = NEW.organization_id
       AND resource.project_id = NEW.project_id
       AND resource.id = expected.resource_id
      JOIN app.governed_resource_versions version
        ON version.organization_id = resource.organization_id
       AND version.resource_id = resource.id
       AND version.id = resource.current_version_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.manifest->'references') manifest_reference
        WHERE manifest_reference->>'resourceId' = resource.id::text
          AND manifest_reference->>'versionId' = version.id::text
          AND manifest_reference->>'versionNumber' = version.version_number::text
          AND manifest_reference->>'kind' = resource.kind::text
      )
    )
  THEN
    RAISE EXCEPTION 'project site edition manifest reference seal mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_site_edition_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.site_id <> OLD.site_id
    OR NEW.site_version_id <> OLD.site_version_id
    OR NEW.site_version_number <> OLD.site_version_number
    OR NEW.edition_number <> OLD.edition_number
    OR NEW.manifest <> OLD.manifest
    OR NEW.manifest_checksum_sha256 <> OLD.manifest_checksum_sha256
    OR NEW.published_by <> OLD.published_by
    OR NEW.published_at <> OLD.published_at
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.revoked_by IS NULL
    OR NEW.revoked_by <> app.current_user_id()
  THEN
    RAISE EXCEPTION 'project site edition revocation is one-way and actor-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_sites_validate_insert
  BEFORE INSERT ON app.project_sites
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_insert();
CREATE TRIGGER project_sites_enforce_transition
  BEFORE UPDATE ON app.project_sites
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_transition();
CREATE TRIGGER project_site_versions_validate_insert
  BEFORE INSERT ON app.project_site_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_version_insert();
CREATE TRIGGER project_site_versions_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_site_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER project_site_pages_validate_insert
  BEFORE INSERT ON app.project_site_pages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_page_insert();
CREATE TRIGGER project_site_pages_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_site_pages
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER project_site_workflow_events_validate_insert
  BEFORE INSERT ON app.project_site_workflow_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_workflow_event_insert();
CREATE TRIGGER project_site_workflow_events_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_site_workflow_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER project_site_editions_validate_insert
  BEFORE INSERT ON app.project_site_editions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_edition_insert();
CREATE TRIGGER project_site_editions_enforce_transition
  BEFORE UPDATE ON app.project_site_editions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_site_edition_transition();

ALTER TABLE app.project_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_sites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_workflow_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_site_editions FORCE ROW LEVEL SECURITY;

CREATE POLICY project_sites_tenant_isolation ON app.project_sites
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_site_versions_tenant_isolation ON app.project_site_versions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_site_pages_tenant_isolation ON app.project_site_pages
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_site_workflow_events_tenant_isolation
  ON app.project_site_workflow_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY project_site_editions_tenant_isolation ON app.project_site_editions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT, UPDATE ON app.project_sites TO opengeo_runtime;
GRANT SELECT, INSERT ON
  app.project_site_versions,
  app.project_site_pages,
  app.project_site_workflow_events
TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.project_site_editions TO opengeo_runtime;
REVOKE DELETE ON
  app.project_sites,
  app.project_site_versions,
  app.project_site_pages,
  app.project_site_workflow_events,
  app.project_site_editions
FROM opengeo_runtime;
REVOKE ALL ON
  app.project_sites,
  app.project_site_versions,
  app.project_site_pages,
  app.project_site_workflow_events,
  app.project_site_editions
FROM opengeo_worker;
REVOKE EXECUTE ON FUNCTION
  app.enforce_project_site_insert(),
  app.enforce_project_site_transition(),
  app.enforce_project_site_version_insert(),
  app.enforce_project_site_page_insert(),
  app.enforce_project_site_workflow_event_insert(),
  app.enforce_project_site_edition_insert(),
  app.enforce_project_site_edition_transition()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.project_sites IS
  'Stable tenant/project site identities whose immutable content revisions can move through review while the prior public edition remains available.';
COMMENT ON TABLE app.project_site_versions IS
  'Immutable general-purpose site metadata and bounded theme configuration; no always-on publishing service is required.';
COMMENT ON TABLE app.project_site_pages IS
  'Ordered multi-page navigation pinned to exact governed story, document, dashboard, or map resource versions.';
COMMENT ON TABLE app.project_site_workflow_events IS
  'Append-only draft-to-review-to-published editorial decisions for exact site revisions.';
COMMENT ON TABLE app.project_site_editions IS
  'Revocable public release records with portable manifests; static packages can be served from ordinary object storage or any CDN.';

COMMIT;
