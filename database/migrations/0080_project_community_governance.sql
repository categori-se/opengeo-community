BEGIN;

CREATE TYPE app.project_discussion_moderation_action AS ENUM ('redact');

CREATE TABLE app.project_discussion_subscriptions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  version_number integer NOT NULL DEFAULT 1,
  subscribed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unsubscribed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, discussion_id, user_id),
  CONSTRAINT project_discussion_subscriptions_version_positive CHECK (
    version_number BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT project_discussion_subscriptions_time_order CHECK (
    updated_at >= subscribed_at
    AND (unsubscribed_at IS NULL OR unsubscribed_at BETWEEN subscribed_at AND updated_at)
  ),
  FOREIGN KEY (organization_id, project_id, discussion_id)
    REFERENCES app.project_discussions (organization_id, project_id, id)
);

CREATE INDEX project_discussion_subscriptions_active_idx
  ON app.project_discussion_subscriptions (
    organization_id, project_id, discussion_id, user_id
  ) WHERE unsubscribed_at IS NULL;

CREATE TABLE app.project_discussion_comment_moderations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  action app.project_discussion_moderation_action NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, project_id, discussion_id, comment_id),
  UNIQUE (organization_id, project_id, discussion_id, id),
  CONSTRAINT project_discussion_moderation_reason_bounded CHECK (
    reason = btrim(reason)
    AND char_length(reason) BETWEEN 1 AND 500
    AND octet_length(reason) <= 2000
  ),
  FOREIGN KEY (organization_id, project_id, discussion_id, comment_id)
    REFERENCES app.project_discussion_comments (
      organization_id, project_id, discussion_id, id
    )
);

CREATE TABLE app.governed_resource_ratings (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  score smallint,
  version_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  PRIMARY KEY (organization_id, project_id, resource_id, user_id),
  CONSTRAINT governed_resource_ratings_version_positive CHECK (
    version_number BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT governed_resource_ratings_state_valid CHECK (
    (score BETWEEN 1 AND 5 AND withdrawn_at IS NULL)
    OR (score IS NULL AND withdrawn_at IS NOT NULL)
  ),
  CONSTRAINT governed_resource_ratings_time_order CHECK (
    updated_at >= created_at
    AND (withdrawn_at IS NULL OR withdrawn_at BETWEEN created_at AND updated_at)
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE TABLE app.governed_resource_rating_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  score smallint,
  version_number integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (
    organization_id, project_id, resource_id, user_id, version_number
  ),
  CONSTRAINT governed_resource_rating_revisions_score_valid CHECK (
    score IS NULL OR score BETWEEN 1 AND 5
  ),
  CONSTRAINT governed_resource_rating_revisions_version_positive CHECK (
    version_number BETWEEN 1 AND 2147483647
  ),
  FOREIGN KEY (organization_id, project_id, resource_id, user_id)
    REFERENCES app.governed_resource_ratings (
      organization_id, project_id, resource_id, user_id
    )
);

CREATE TABLE app.governed_resource_rating_summaries (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  rating_count bigint NOT NULL DEFAULT 0,
  rating_sum bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, resource_id),
  CONSTRAINT governed_resource_rating_summary_values_valid CHECK (
    rating_count BETWEEN 0 AND 2147483647
    AND rating_sum BETWEEN 0 AND rating_count * 5
    AND (rating_count <> 0 OR rating_sum = 0)
  ),
  FOREIGN KEY (organization_id, project_id, resource_id)
    REFERENCES app.governed_resources (organization_id, project_id, id)
);

CREATE FUNCTION app.current_user_can_read_governed_resource(
  p_organization_id uuid,
  p_project_id uuid,
  p_resource_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT p_organization_id = app.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM app.governed_resources resource
      WHERE resource.organization_id = p_organization_id
        AND resource.project_id = p_project_id
        AND resource.id = p_resource_id
        AND (
          resource.owner_user_id = app.current_user_id()
          OR app.effective_project_role(p_project_id) IS NOT NULL
          OR app.current_user_is_organization_admin()
          OR EXISTS (
            SELECT 1
            FROM app.governed_resource_permissions permission
            WHERE permission.organization_id = p_organization_id
              AND permission.resource_id = p_resource_id
              AND permission.user_id = app.current_user_id()
          )
        )
    )
$$;

CREATE FUNCTION app.enforce_project_discussion_subscription_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.version_number <> 1
      OR NEW.unsubscribed_at IS NOT NULL
      OR NOT app.project_discussion_user_has_access(
        NEW.organization_id, NEW.project_id, NEW.user_id
      )
    THEN
      RAISE EXCEPTION 'discussion subscription requires the current participant';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.discussion_id IS DISTINCT FROM OLD.discussion_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.user_id IS DISTINCT FROM app.current_user_id()
    OR NEW.version_number <> OLD.version_number + 1
    OR (OLD.unsubscribed_at IS NULL) = (NEW.unsubscribed_at IS NULL)
  THEN
    RAISE EXCEPTION 'discussion subscription transition is invalid';
  END IF;

  IF OLD.unsubscribed_at IS NULL THEN
    IF NEW.subscribed_at IS DISTINCT FROM OLD.subscribed_at
      OR NEW.unsubscribed_at IS NULL
      OR NEW.updated_at IS DISTINCT FROM NEW.unsubscribed_at
    THEN
      RAISE EXCEPTION 'discussion unsubscribe transition is invalid';
    END IF;
  ELSIF NEW.unsubscribed_at IS NOT NULL
    OR NEW.subscribed_at <= OLD.subscribed_at
    OR NEW.updated_at IS DISTINCT FROM NEW.subscribed_at
  THEN
    RAISE EXCEPTION 'discussion resubscribe transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.notify_project_discussion_recipients(
  p_organization_id uuid,
  p_project_id uuid,
  p_discussion_id uuid,
  p_discussion_version integer,
  p_comment_id uuid,
  p_kind app.project_notification_kind,
  p_explicit_user_ids uuid[],
  p_include_subscribers boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF p_organization_id IS DISTINCT FROM app.current_organization_id()
    OR NOT app.project_discussion_user_has_access(
      p_organization_id, p_project_id, app.current_user_id()
    )
    OR p_discussion_version NOT BETWEEN 1 AND 2147483647
    OR cardinality(COALESCE(p_explicit_user_ids, ARRAY[]::uuid[])) > 20
    OR (p_include_subscribers AND p_kind NOT IN ('reply', 'state'))
    OR NOT EXISTS (
      SELECT 1
      FROM app.project_discussions discussion
      WHERE discussion.organization_id = p_organization_id
        AND discussion.project_id = p_project_id
        AND discussion.id = p_discussion_id
        AND discussion.version_number = p_discussion_version
    )
  THEN
    RAISE EXCEPTION 'discussion notification request is invalid';
  END IF;

  WITH explicit_recipients AS (
    SELECT DISTINCT recipient_user_id
    FROM unnest(COALESCE(p_explicit_user_ids, ARRAY[]::uuid[])) AS recipient_user_id
  ), subscribed_recipients AS (
    SELECT subscription.user_id AS recipient_user_id
    FROM app.project_discussion_subscriptions subscription
    WHERE p_include_subscribers
      AND subscription.organization_id = p_organization_id
      AND subscription.project_id = p_project_id
      AND subscription.discussion_id = p_discussion_id
      AND subscription.unsubscribed_at IS NULL
  ), recipients AS (
    SELECT recipient_user_id FROM explicit_recipients
    UNION
    SELECT recipient_user_id FROM subscribed_recipients
  )
  INSERT INTO app.project_notifications (
    id, organization_id, project_id, recipient_user_id, actor_user_id,
    discussion_id, discussion_version, comment_id, kind
  )
  SELECT gen_random_uuid(), p_organization_id, p_project_id,
         recipient.recipient_user_id, app.current_user_id(), p_discussion_id,
         p_discussion_version, p_comment_id, p_kind
  FROM recipients recipient
  JOIN app.organization_memberships membership
    ON membership.organization_id = p_organization_id
   AND membership.user_id = recipient.recipient_user_id
  WHERE recipient.recipient_user_id <> app.current_user_id()
    AND (
      membership.role = 'admin'
      OR app.effective_project_role(p_project_id, membership.user_id) IS NOT NULL
    )
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION app.validate_project_discussion_comment_moderation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.actor_user_id IS DISTINCT FROM app.current_user_id()
    OR NOT (
      app.effective_project_role(NEW.project_id) IN ('owner', 'editor', 'reviewer')
      OR app.current_user_is_organization_admin()
    )
  THEN
    RAISE EXCEPTION 'discussion moderation requires current moderator authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_governed_resource_rating_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.version_number <> 1
      OR NEW.score IS NULL
      OR NEW.withdrawn_at IS NOT NULL
      OR NOT app.current_user_can_read_governed_resource(
        NEW.organization_id, NEW.project_id, NEW.resource_id
      )
    THEN
      RAISE EXCEPTION 'resource rating requires the current authorized reader';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.user_id IS DISTINCT FROM app.current_user_id()
    OR NEW.version_number <> OLD.version_number + 1
    OR NEW.updated_at <= OLD.updated_at
    OR NOT app.current_user_can_read_governed_resource(
      NEW.organization_id, NEW.project_id, NEW.resource_id
    )
  THEN
    RAISE EXCEPTION 'resource rating transition is invalid';
  END IF;

  IF NEW.score IS NULL THEN
    IF OLD.score IS NULL
      OR NEW.withdrawn_at IS NULL
      OR NEW.updated_at IS DISTINCT FROM NEW.withdrawn_at
    THEN
      RAISE EXCEPTION 'resource rating withdrawal is invalid';
    END IF;
  ELSIF NEW.withdrawn_at IS NOT NULL
    OR (OLD.score IS NOT NULL AND NEW.score IS NOT DISTINCT FROM OLD.score)
  THEN
    RAISE EXCEPTION 'resource rating revision must change the score or restore it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.record_governed_resource_rating_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  INSERT INTO app.governed_resource_rating_revisions (
    organization_id, project_id, resource_id, user_id, score,
    version_number, actor_user_id, created_at
  ) VALUES (
    NEW.organization_id, NEW.project_id, NEW.resource_id, NEW.user_id, NEW.score,
    NEW.version_number, app.current_user_id(), NEW.updated_at
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION app.refresh_governed_resource_rating_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  old_count bigint := 0;
  old_sum bigint := 0;
  new_count bigint := 0;
  new_sum bigint := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.score IS NOT NULL THEN
      old_count := 1;
      old_sum := OLD.score;
    END IF;
  END IF;
  IF NEW.score IS NOT NULL THEN
    new_count := 1;
    new_sum := NEW.score;
  END IF;

  INSERT INTO app.governed_resource_rating_summaries AS summary (
    organization_id, project_id, resource_id, rating_count, rating_sum, updated_at
  ) VALUES (
    NEW.organization_id, NEW.project_id, NEW.resource_id,
    new_count, new_sum, clock_timestamp()
  )
  ON CONFLICT (organization_id, project_id, resource_id)
  DO UPDATE SET
    rating_count = summary.rating_count + (new_count - old_count),
    rating_sum = summary.rating_sum + (new_sum - old_sum),
    updated_at = GREATEST(summary.updated_at, EXCLUDED.updated_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER project_discussion_subscriptions_enforce_transition
  BEFORE INSERT OR UPDATE ON app.project_discussion_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_discussion_subscription_transition();
CREATE TRIGGER project_discussion_subscriptions_are_undeletable
  BEFORE DELETE ON app.project_discussion_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_comment_mutation();
CREATE TRIGGER project_discussion_comment_moderations_validate
  BEFORE INSERT ON app.project_discussion_comment_moderations
  FOR EACH ROW EXECUTE FUNCTION app.validate_project_discussion_comment_moderation();
CREATE TRIGGER project_discussion_comment_moderations_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_discussion_comment_moderations
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_comment_mutation();
CREATE TRIGGER governed_resource_ratings_enforce_transition
  BEFORE INSERT OR UPDATE ON app.governed_resource_ratings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_governed_resource_rating_transition();
CREATE TRIGGER governed_resource_ratings_are_undeletable
  BEFORE DELETE ON app.governed_resource_ratings
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER governed_resource_ratings_record_revision
  AFTER INSERT OR UPDATE ON app.governed_resource_ratings
  FOR EACH ROW EXECUTE FUNCTION app.record_governed_resource_rating_revision();
CREATE TRIGGER governed_resource_ratings_refresh_summary
  AFTER INSERT OR UPDATE ON app.governed_resource_ratings
  FOR EACH ROW EXECUTE FUNCTION app.refresh_governed_resource_rating_summary();
CREATE TRIGGER governed_resource_rating_revisions_are_immutable
  BEFORE UPDATE OR DELETE ON app.governed_resource_rating_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
ALTER TABLE app.project_discussion_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_comment_moderations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_rating_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_rating_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_comment_moderations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_ratings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_rating_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.governed_resource_rating_summaries FORCE ROW LEVEL SECURITY;

CREATE POLICY project_discussion_subscriptions_select
  ON app.project_discussion_subscriptions FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.project_discussion_user_has_access(organization_id, project_id, user_id)
  );
CREATE POLICY project_discussion_subscriptions_insert
  ON app.project_discussion_subscriptions FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.project_discussion_user_has_access(organization_id, project_id, user_id)
  );
CREATE POLICY project_discussion_subscriptions_update
  ON app.project_discussion_subscriptions FOR UPDATE USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
  ) WITH CHECK (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.project_discussion_user_has_access(organization_id, project_id, user_id)
  );

CREATE POLICY project_discussion_comment_moderations_select
  ON app.project_discussion_comment_moderations FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND app.project_discussion_user_has_access(
      organization_id, project_id, app.current_user_id()
    )
  );
CREATE POLICY project_discussion_comment_moderations_insert
  ON app.project_discussion_comment_moderations FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND actor_user_id = app.current_user_id()
    AND (
      app.effective_project_role(project_id) IN ('owner', 'editor', 'reviewer')
      OR app.current_user_is_organization_admin()
    )
  );

CREATE POLICY governed_resource_ratings_select
  ON app.governed_resource_ratings FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
  );
CREATE POLICY governed_resource_ratings_insert
  ON app.governed_resource_ratings FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.current_user_can_read_governed_resource(
      organization_id, project_id, resource_id
    )
  );
CREATE POLICY governed_resource_ratings_update
  ON app.governed_resource_ratings FOR UPDATE USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
  ) WITH CHECK (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
    AND app.current_user_can_read_governed_resource(
      organization_id, project_id, resource_id
    )
  );
CREATE POLICY governed_resource_rating_revisions_select
  ON app.governed_resource_rating_revisions FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND user_id = app.current_user_id()
  );
CREATE POLICY governed_resource_rating_summaries_select
  ON app.governed_resource_rating_summaries FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND (
      app.current_user_can_read_governed_resource(
        organization_id, project_id, resource_id
      )
      OR EXISTS (
        SELECT 1
        FROM app.governed_resources resource
        WHERE resource.organization_id = governed_resource_rating_summaries.organization_id
          AND resource.project_id = governed_resource_rating_summaries.project_id
          AND resource.id = governed_resource_rating_summaries.resource_id
          AND resource.state = 'published'
          AND resource.visibility = 'public'
      )
    )
  );

GRANT SELECT, INSERT, UPDATE ON app.project_discussion_subscriptions TO opengeo_runtime;
GRANT SELECT, INSERT ON app.project_discussion_comment_moderations TO opengeo_runtime;
GRANT SELECT, INSERT, UPDATE ON app.governed_resource_ratings TO opengeo_runtime;
GRANT SELECT ON
  app.governed_resource_rating_revisions,
  app.governed_resource_rating_summaries
TO opengeo_runtime;

REVOKE DELETE ON
  app.project_discussion_subscriptions,
  app.project_discussion_comment_moderations,
  app.governed_resource_ratings,
  app.governed_resource_rating_revisions,
  app.governed_resource_rating_summaries
FROM opengeo_runtime;
REVOKE ALL ON
  app.project_discussion_subscriptions,
  app.project_discussion_comment_moderations,
  app.governed_resource_ratings,
  app.governed_resource_rating_revisions,
  app.governed_resource_rating_summaries
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
REVOKE EXECUTE ON FUNCTION
  app.current_user_can_read_governed_resource(uuid, uuid, uuid),
  app.enforce_project_discussion_subscription_transition(),
  app.notify_project_discussion_recipients(
    uuid, uuid, uuid, integer, uuid, app.project_notification_kind, uuid[], boolean
  ),
  app.validate_project_discussion_comment_moderation(),
  app.enforce_governed_resource_rating_transition(),
  app.record_governed_resource_rating_revision(),
  app.refresh_governed_resource_rating_summary()
FROM PUBLIC, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.current_user_can_read_governed_resource(uuid, uuid, uuid)
  TO opengeo_runtime;
GRANT EXECUTE ON FUNCTION app.notify_project_discussion_recipients(
  uuid, uuid, uuid, integer, uuid, app.project_notification_kind, uuid[], boolean
)
  TO opengeo_runtime;

COMMENT ON TABLE app.project_discussion_subscriptions IS
  'Recipient-private exact-version project-discussion subscriptions; rows are toggled rather than deleted.';
COMMENT ON TABLE app.project_discussion_comment_moderations IS
  'Append-only irreversible moderation decisions that redact API projections without rewriting comment history.';
COMMENT ON TABLE app.governed_resource_ratings IS
  'Private current one-to-five rating per authorized user and governed resource; withdrawal preserves identity.';
COMMENT ON TABLE app.governed_resource_rating_revisions IS
  'Append-only private rating and withdrawal history for one user/resource identity.';
COMMENT ON TABLE app.governed_resource_rating_summaries IS
  'Identity-free resource rating counts and sums safe for governed public catalog aggregation.';

COMMIT;
