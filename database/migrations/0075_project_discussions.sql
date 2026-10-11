BEGIN;

CREATE TYPE app.project_discussion_state AS ENUM ('open', 'resolved');

CREATE TABLE app.project_discussions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  initial_comment_id uuid NOT NULL,
  title text NOT NULL,
  state app.project_discussion_state NOT NULL DEFAULT 'open',
  version_number integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES app.users(id),
  resolved_by uuid REFERENCES app.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, project_id, id),
  CONSTRAINT project_discussions_title_bounded CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 200
    AND octet_length(title) <= 800
  ),
  CONSTRAINT project_discussions_version_positive CHECK (
    version_number BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT project_discussions_resolution_consistent CHECK (
    (state = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (state = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id)
);

CREATE TABLE app.project_discussion_comments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  body text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, project_id, discussion_id, id),
  CONSTRAINT project_discussion_comments_body_bounded CHECK (
    body = btrim(body)
    AND char_length(body) BETWEEN 1 AND 4000
    AND octet_length(body) <= 16000
  ),
  FOREIGN KEY (organization_id, project_id, discussion_id)
    REFERENCES app.project_discussions (organization_id, project_id, id)
);

ALTER TABLE app.project_discussions
  ADD CONSTRAINT project_discussions_initial_comment_fk
  FOREIGN KEY (organization_id, project_id, id, initial_comment_id)
  REFERENCES app.project_discussion_comments (
    organization_id, project_id, discussion_id, id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX project_discussions_project_activity_idx
  ON app.project_discussions (
    organization_id, project_id, state, updated_at DESC, id
  );
CREATE INDEX project_discussion_comments_thread_idx
  ON app.project_discussion_comments (
    organization_id, project_id, discussion_id, created_at, id
  );

CREATE FUNCTION app.enforce_project_discussion_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.initial_comment_id IS DISTINCT FROM OLD.initial_comment_id
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project discussion identity and initial content are immutable';
  END IF;

  IF NEW.version_number <> OLD.version_number + 1 THEN
    RAISE EXCEPTION 'project discussion transition requires the next version';
  END IF;
  IF NEW.state = OLD.state THEN
    RAISE EXCEPTION 'project discussion transition must change state';
  END IF;

  IF NEW.state = 'resolved' THEN
    IF NEW.resolved_by IS DISTINCT FROM app.current_user_id()
      OR NEW.resolved_at IS NULL
    THEN
      RAISE EXCEPTION 'project discussion resolution requires current-user attribution';
    END IF;
  ELSIF NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'open project discussion cannot retain resolution attribution';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_project_discussion_comment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'project discussion comments are append-only';
END;
$$;

CREATE TRIGGER project_discussions_enforce_transition
  BEFORE UPDATE ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_discussion_transition();
CREATE TRIGGER project_discussions_set_updated_at
  BEFORE UPDATE ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER project_discussion_comments_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_discussion_comments
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_comment_mutation();

ALTER TABLE app.project_discussions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_comments FORCE ROW LEVEL SECURITY;

CREATE POLICY project_discussions_select ON app.project_discussions
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  );
CREATE POLICY project_discussions_insert ON app.project_discussions
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND created_by = app.current_user_id()
    AND state = 'open'
    AND version_number = 1
    AND (
      app.effective_project_role(project_id) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  );
CREATE POLICY project_discussions_update ON app.project_discussions
  FOR UPDATE USING (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) IN ('owner', 'editor', 'reviewer')
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  ) WITH CHECK (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) IN ('owner', 'editor', 'reviewer')
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  );

CREATE POLICY project_discussion_comments_select ON app.project_discussion_comments
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(project_id) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  );
CREATE POLICY project_discussion_comments_insert ON app.project_discussion_comments
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND created_by = app.current_user_id()
    AND EXISTS (
      SELECT 1
      FROM app.project_discussions discussion
      WHERE discussion.organization_id = project_discussion_comments.organization_id
        AND discussion.project_id = project_discussion_comments.project_id
        AND discussion.id = project_discussion_comments.discussion_id
        AND discussion.state = 'open'
    )
    AND (
      app.effective_project_role(project_id) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = app.current_organization_id()
          AND membership.user_id = app.current_user_id()
          AND membership.role = 'admin'
      )
    )
  );

GRANT SELECT, INSERT ON
  app.project_discussions,
  app.project_discussion_comments
TO opengeo_runtime;
GRANT UPDATE (state, version_number, resolved_by, resolved_at)
  ON app.project_discussions TO opengeo_runtime;

REVOKE ALL ON
  app.project_discussions,
  app.project_discussion_comments
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
REVOKE EXECUTE ON FUNCTION
  app.enforce_project_discussion_transition(),
  app.reject_project_discussion_comment_mutation()
FROM PUBLIC;

COMMENT ON TABLE app.project_discussions IS
  'Project-scoped durable collaboration threads; titles and initial-comment identity are immutable while resolution uses optimistic transitions.';
COMMENT ON TABLE app.project_discussion_comments IS
  'Append-only attributed project discussion comments; edits and deletion require a future explicit moderation design.';
COMMENT ON CONSTRAINT project_discussions_initial_comment_fk
  ON app.project_discussions IS
  'Every thread is transactionally bound to one exact initial comment in the same project and discussion.';

COMMIT;
