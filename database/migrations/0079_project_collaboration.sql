BEGIN;

ALTER TYPE app.project_discussion_target_kind ADD VALUE 'map';
ALTER TYPE app.project_discussion_target_kind ADD VALUE 'dataset';
ALTER TYPE app.project_discussion_target_kind ADD VALUE 'resource';
ALTER TYPE app.project_discussion_target_kind ADD VALUE 'site';

CREATE TYPE app.project_notification_kind AS ENUM (
  'assignment',
  'mention',
  'reply',
  'state'
);

COMMIT;

BEGIN;

ALTER TABLE app.project_discussions
  DROP CONSTRAINT project_discussions_target_shape,
  ADD COLUMN target_object_id uuid,
  ADD COLUMN target_object_version bigint,
  ADD COLUMN assigned_to uuid REFERENCES app.users(id),
  ADD COLUMN assigned_by uuid REFERENCES app.users(id),
  ADD COLUMN assigned_at timestamptz,
  ADD CONSTRAINT project_discussions_target_shape CHECK (
    (
      target_kind = 'project'
      AND target_map_id IS NULL
      AND target_map_version IS NULL
      AND target_layer_id IS NULL
      AND target_dataset_id IS NULL
      AND target_feature_id IS NULL
      AND target_object_id IS NULL
      AND target_object_version IS NULL
    )
    OR (
      target_kind = 'feature'
      AND target_map_id IS NOT NULL
      AND target_map_version IS NOT NULL
      AND target_layer_id IS NOT NULL
      AND target_dataset_id IS NOT NULL
      AND target_feature_id IS NOT NULL
      AND target_object_id IS NULL
      AND target_object_version IS NULL
    )
    OR (
      target_kind IN ('map', 'dataset', 'resource', 'site')
      AND target_map_id IS NULL
      AND target_map_version IS NULL
      AND target_layer_id IS NULL
      AND target_dataset_id IS NULL
      AND target_feature_id IS NULL
      AND target_object_id IS NOT NULL
      AND target_object_version IS NOT NULL
    )
  ),
  ADD CONSTRAINT project_discussions_target_object_version_positive CHECK (
    target_object_version IS NULL OR target_object_version > 0
  ),
  ADD CONSTRAINT project_discussions_assignment_consistent CHECK (
    (
      assigned_to IS NULL
      AND assigned_by IS NULL
      AND assigned_at IS NULL
    )
    OR (
      assigned_to IS NOT NULL
      AND assigned_by IS NOT NULL
      AND assigned_at IS NOT NULL
    )
  );

CREATE INDEX project_discussions_object_target_idx
  ON app.project_discussions (
    organization_id, project_id, target_kind, target_object_id,
    target_object_version, updated_at DESC, id
  )
  WHERE target_kind IN ('map', 'dataset', 'resource', 'site');

CREATE INDEX project_discussions_assignee_idx
  ON app.project_discussions (
    organization_id, assigned_to, state, updated_at DESC, id
  )
  WHERE assigned_to IS NOT NULL;

CREATE TABLE app.project_discussion_comment_mentions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  mentioned_user_id uuid NOT NULL REFERENCES app.users(id),
  mentioned_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    organization_id, project_id, discussion_id, comment_id, mentioned_user_id
  ),
  FOREIGN KEY (organization_id, project_id, discussion_id, comment_id)
    REFERENCES app.project_discussion_comments (
      organization_id, project_id, discussion_id, id
    )
);

CREATE TABLE app.project_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES app.users(id),
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  discussion_id uuid NOT NULL,
  discussion_version integer NOT NULL,
  comment_id uuid,
  kind app.project_notification_kind NOT NULL,
  version_number integer NOT NULL DEFAULT 1,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_notifications_not_self CHECK (
    recipient_user_id <> actor_user_id
  ),
  CONSTRAINT project_notifications_version_positive CHECK (
    version_number BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT project_notifications_discussion_version_positive CHECK (
    discussion_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT project_notifications_cause_shape CHECK (
    (
      kind IN ('mention', 'reply')
      AND comment_id IS NOT NULL
    )
    OR (
      kind IN ('assignment', 'state')
      AND comment_id IS NULL
    )
  ),
  CONSTRAINT project_notifications_read_shape CHECK (
    (read_at IS NULL AND version_number = 1)
    OR (read_at IS NOT NULL AND version_number >= 2 AND read_at >= created_at)
  ),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES app.projects (organization_id, id),
  FOREIGN KEY (organization_id, project_id, discussion_id)
    REFERENCES app.project_discussions (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, discussion_id, comment_id)
    REFERENCES app.project_discussion_comments (
      organization_id, project_id, discussion_id, id
    )
);

CREATE UNIQUE INDEX project_notifications_exact_cause_idx
  ON app.project_notifications (
    organization_id, recipient_user_id, kind, discussion_id,
    discussion_version,
    COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX project_notifications_recipient_idx
  ON app.project_notifications (
    organization_id, recipient_user_id, (read_at IS NULL), created_at DESC, id
  );

CREATE OR REPLACE FUNCTION app.validate_project_discussion_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_exists boolean;
BEGIN
  IF NEW.target_kind = 'project' THEN
    RETURN NEW;
  END IF;

  IF NEW.target_kind = 'feature' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.maps map
      JOIN app.map_versions map_version
        ON map_version.organization_id = map.organization_id
       AND map_version.map_id = map.id
       AND map_version.version = NEW.target_map_version
      JOIN app.project_datasets project_dataset
        ON project_dataset.organization_id = map.organization_id
       AND project_dataset.project_id = map.project_id
       AND project_dataset.dataset_id = NEW.target_dataset_id
      JOIN app.dataset_features feature
        ON feature.organization_id = project_dataset.organization_id
       AND feature.dataset_id = project_dataset.dataset_id
       AND feature.id = NEW.target_feature_id
       AND feature.deleted_at IS NULL
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(map_version.definition->'layers') = 'array'
            THEN map_version.definition->'layers'
          ELSE '[]'::jsonb
        END
      ) layer
      WHERE map.organization_id = NEW.organization_id
        AND map.project_id = NEW.project_id
        AND map.id = NEW.target_map_id
        AND map.status = 'active'
        AND layer->>'layerId' = NEW.target_layer_id
        AND layer->>'datasetId' = NEW.target_dataset_id::text
    ) INTO v_target_exists;
  ELSIF NEW.target_kind = 'map' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.maps map
      JOIN app.map_versions version
        ON version.organization_id = map.organization_id
       AND version.map_id = map.id
       AND version.version = NEW.target_object_version
      WHERE map.organization_id = NEW.organization_id
        AND map.project_id = NEW.project_id
        AND map.id = NEW.target_object_id
        AND map.version = NEW.target_object_version
        AND map.status = 'active'
    ) INTO v_target_exists;
  ELSIF NEW.target_kind = 'dataset' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.project_datasets project_dataset
      JOIN app.datasets dataset
        ON dataset.organization_id = project_dataset.organization_id
       AND dataset.id = project_dataset.dataset_id
      JOIN app.dataset_versions version
        ON version.organization_id = dataset.organization_id
       AND version.dataset_id = dataset.id
       AND version.id = dataset.current_version_id
       AND version.version_number = NEW.target_object_version
      WHERE project_dataset.organization_id = NEW.organization_id
        AND project_dataset.project_id = NEW.project_id
        AND project_dataset.dataset_id = NEW.target_object_id
        AND dataset.status <> 'archived'
    ) INTO v_target_exists;
  ELSIF NEW.target_kind = 'resource' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.governed_resources resource
      JOIN app.governed_resource_versions version
        ON version.organization_id = resource.organization_id
       AND version.resource_id = resource.id
       AND version.id = resource.current_version_id
       AND version.version_number = NEW.target_object_version
      WHERE resource.organization_id = NEW.organization_id
        AND resource.project_id = NEW.project_id
        AND resource.id = NEW.target_object_id
        AND resource.state <> 'archived'
    ) INTO v_target_exists;
  ELSIF NEW.target_kind = 'site' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.project_sites site
      JOIN app.project_site_versions version
        ON version.organization_id = site.organization_id
       AND version.project_id = site.project_id
       AND version.site_id = site.id
       AND version.id = site.current_version_id
       AND version.version_number = NEW.target_object_version
      WHERE site.organization_id = NEW.organization_id
        AND site.project_id = NEW.project_id
        AND site.id = NEW.target_object_id
        AND site.current_version_number = NEW.target_object_version
    ) INTO v_target_exists;
  END IF;

  IF NOT COALESCE(v_target_exists, false) THEN
    RAISE EXCEPTION
      'discussion target must reference one exact current object version in the project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.project_discussion_user_has_access(
  p_organization_id uuid,
  p_project_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT p_organization_id = app.current_organization_id()
    AND (
      app.effective_project_role(p_project_id, p_user_id) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM app.organization_memberships membership
        WHERE membership.organization_id = p_organization_id
          AND membership.user_id = p_user_id
          AND membership.role = 'admin'
      )
    )
$$;

CREATE FUNCTION app.validate_project_discussion_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to IS NULL THEN
    IF NEW.assigned_by IS NOT NULL OR NEW.assigned_at IS NOT NULL THEN
      RAISE EXCEPTION 'unassigned discussion cannot retain assignment attribution';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_by IS DISTINCT FROM app.current_user_id()
    OR NEW.assigned_at IS NULL
    OR NOT app.project_discussion_user_has_access(
      NEW.organization_id, NEW.project_id, NEW.assigned_to
    )
  THEN
    RAISE EXCEPTION 'discussion assignee must be an authorized project participant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_project_discussion_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state_changed boolean := NEW.state IS DISTINCT FROM OLD.state;
  v_assignment_changed boolean := NEW.assigned_to IS DISTINCT FROM OLD.assigned_to;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.initial_comment_id IS DISTINCT FROM OLD.initial_comment_id
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.target_map_id IS DISTINCT FROM OLD.target_map_id
    OR NEW.target_map_version IS DISTINCT FROM OLD.target_map_version
    OR NEW.target_layer_id IS DISTINCT FROM OLD.target_layer_id
    OR NEW.target_dataset_id IS DISTINCT FROM OLD.target_dataset_id
    OR NEW.target_feature_id IS DISTINCT FROM OLD.target_feature_id
    OR NEW.target_object_id IS DISTINCT FROM OLD.target_object_id
    OR NEW.target_object_version IS DISTINCT FROM OLD.target_object_version
  THEN
    RAISE EXCEPTION 'project discussion identity, initial content, and target are immutable';
  END IF;

  IF NEW.version_number <> OLD.version_number + 1 THEN
    RAISE EXCEPTION 'project discussion transition requires the next version';
  END IF;
  IF v_state_changed = v_assignment_changed THEN
    RAISE EXCEPTION 'project discussion transition must change exactly one state or assignment';
  END IF;

  IF v_state_changed THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
      OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
      OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
    THEN
      RAISE EXCEPTION 'state transition cannot change assignment';
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
  ELSE
    IF NEW.state IS DISTINCT FROM OLD.state
      OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
      OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    THEN
      RAISE EXCEPTION 'assignment transition cannot change discussion state';
    END IF;
    IF NEW.assigned_to IS NULL THEN
      IF NEW.assigned_by IS NOT NULL OR NEW.assigned_at IS NOT NULL THEN
        RAISE EXCEPTION 'unassigned discussion cannot retain assignment attribution';
      END IF;
    ELSIF NEW.assigned_by IS DISTINCT FROM app.current_user_id()
      OR NEW.assigned_at IS NULL
    THEN
      RAISE EXCEPTION 'assignment transition requires current-user attribution';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.validate_project_discussion_mention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.mentioned_by IS DISTINCT FROM app.current_user_id()
    OR NOT app.project_discussion_user_has_access(
      NEW.organization_id, NEW.project_id, NEW.mentioned_user_id
    )
  THEN
    RAISE EXCEPTION 'discussion mention must name an authorized project participant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_project_notification_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
    OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.discussion_id IS DISTINCT FROM OLD.discussion_id
    OR NEW.discussion_version IS DISTINCT FROM OLD.discussion_version
    OR NEW.comment_id IS DISTINCT FROM OLD.comment_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project notification identity and cause are immutable';
  END IF;
  IF OLD.read_at IS NOT NULL
    OR NEW.read_at IS NULL
    OR NEW.version_number <> OLD.version_number + 1
    OR NEW.recipient_user_id IS DISTINCT FROM app.current_user_id()
  THEN
    RAISE EXCEPTION 'project notification permits one recipient-attributed read transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER project_discussions_target_is_immutable ON app.project_discussions;
CREATE TRIGGER project_discussions_target_is_immutable
  BEFORE UPDATE OF
    target_kind,
    target_map_id,
    target_map_version,
    target_layer_id,
    target_dataset_id,
    target_feature_id,
    target_object_id,
    target_object_version
  ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_target_change();

CREATE TRIGGER project_discussions_validate_assignment
  BEFORE INSERT OR UPDATE OF assigned_to, assigned_by, assigned_at
  ON app.project_discussions
  FOR EACH ROW EXECUTE FUNCTION app.validate_project_discussion_assignment();

CREATE TRIGGER project_discussion_mentions_validate
  BEFORE INSERT ON app.project_discussion_comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.validate_project_discussion_mention();
CREATE TRIGGER project_discussion_mentions_are_immutable
  BEFORE UPDATE OR DELETE ON app.project_discussion_comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_comment_mutation();
CREATE TRIGGER project_notifications_enforce_transition
  BEFORE UPDATE ON app.project_notifications
  FOR EACH ROW EXECUTE FUNCTION app.enforce_project_notification_transition();
CREATE TRIGGER project_notifications_are_undeletable
  BEFORE DELETE ON app.project_notifications
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_discussion_comment_mutation();

ALTER TABLE app.project_discussion_comment_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_discussion_comment_mentions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY project_discussion_mentions_select
  ON app.project_discussion_comment_mentions
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND app.project_discussion_user_has_access(
      organization_id, project_id, app.current_user_id()
    )
  );
CREATE POLICY project_discussion_mentions_insert
  ON app.project_discussion_comment_mentions
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND mentioned_by = app.current_user_id()
    AND app.project_discussion_user_has_access(
      organization_id, project_id, mentioned_user_id
    )
  );

CREATE POLICY project_notifications_select ON app.project_notifications
  FOR SELECT USING (
    organization_id = app.current_organization_id()
    AND recipient_user_id = app.current_user_id()
  );
CREATE POLICY project_notifications_insert ON app.project_notifications
  FOR INSERT WITH CHECK (
    organization_id = app.current_organization_id()
    AND actor_user_id = app.current_user_id()
    AND recipient_user_id <> app.current_user_id()
    AND app.project_discussion_user_has_access(
      organization_id, project_id, recipient_user_id
    )
  );
CREATE POLICY project_notifications_update ON app.project_notifications
  FOR UPDATE USING (
    organization_id = app.current_organization_id()
    AND recipient_user_id = app.current_user_id()
  ) WITH CHECK (
    organization_id = app.current_organization_id()
    AND recipient_user_id = app.current_user_id()
  );

GRANT SELECT, INSERT ON app.project_discussion_comment_mentions TO opengeo_runtime;
GRANT SELECT, INSERT ON app.project_notifications TO opengeo_runtime;
GRANT UPDATE (read_at, version_number) ON app.project_notifications TO opengeo_runtime;
GRANT UPDATE (assigned_to, assigned_by, assigned_at, version_number)
  ON app.project_discussions TO opengeo_runtime;

REVOKE ALL ON
  app.project_discussion_comment_mentions,
  app.project_notifications
FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
REVOKE EXECUTE ON FUNCTION
  app.project_discussion_user_has_access(uuid, uuid, uuid),
  app.validate_project_discussion_assignment(),
  app.validate_project_discussion_mention(),
  app.enforce_project_notification_transition()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_discussion_user_has_access(uuid, uuid, uuid)
  TO opengeo_runtime;

COMMENT ON COLUMN app.project_discussions.target_object_id IS
  'Stable map, dataset, governed-resource, or project-site identity selected by target_kind.';
COMMENT ON COLUMN app.project_discussions.target_object_version IS
  'Exact current object version at thread creation; later object revisions do not retarget the discussion.';
COMMENT ON COLUMN app.project_discussions.assigned_to IS
  'Optional currently authorized project participant responsible for the thread.';
COMMENT ON TABLE app.project_discussion_comment_mentions IS
  'Append-only explicit participant mentions bound to one exact immutable comment.';
COMMENT ON TABLE app.project_notifications IS
  'Recipient-private durable assignment, mention, reply, and state notifications with one-way read acknowledgement.';

COMMIT;
