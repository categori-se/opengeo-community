import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";

import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000080",
  otherOrganization: "10000000-0000-4000-8000-000000000081",
  owner: "20000000-0000-4000-8000-000000000080",
  editor: "20000000-0000-4000-8000-000000000081",
  viewer: "20000000-0000-4000-8000-000000000082",
  outsider: "20000000-0000-4000-8000-000000000083",
  project: "50000000-0000-4000-8000-000000000080",
  resource: "90000000-0000-4000-8000-000000000080",
  resourceVersion: "91000000-0000-4000-8000-000000000080",
  discussion: "d5000000-0000-4000-8000-000000000080",
  comment: "c5000000-0000-4000-8000-000000000080",
  moderation: "a5000000-0000-4000-8000-000000000080"
};

let db;
let migration;

async function inTenant(userId, operation, organizationId = IDS.organization) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function load(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("0080 project community governance migration", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await load("0001_platform_foundation.sql");
    const resources = await load("0009_governed_resources.sql");
    const resourceGovernance = await load("0010_resource_governance.sql");
    const teams = await load("0050_team_project_access.sql");
    const discussions = await load("0075_project_discussions.sql");
    const featureTargets = await load("0077_feature_discussion_targets.sql");
    const collaboration = await load("0079_project_collaboration.sql");
    migration = await load("0080_project_community_governance.sql");

    await db.exec(foundation.replace(
      /^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""
    ));
    await db.exec(`
      CREATE ROLE opengeo_worker;
      CREATE ROLE opengeo_connector;
      CREATE ROLE opengeo_observable_coordinator;
      CREATE TABLE app.datasets (
        id uuid NOT NULL,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        status text NOT NULL DEFAULT 'active',
        current_version_id uuid,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE app.dataset_versions (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        dataset_id uuid NOT NULL,
        version_number bigint NOT NULL,
        PRIMARY KEY (organization_id, id),
        UNIQUE (organization_id, dataset_id, version_number)
      );
      CREATE TABLE app.project_datasets (
        organization_id uuid NOT NULL,
        project_id uuid NOT NULL,
        dataset_id uuid NOT NULL,
        PRIMARY KEY (organization_id, project_id, dataset_id),
        FOREIGN KEY (organization_id, project_id)
          REFERENCES app.projects (organization_id, id),
        FOREIGN KEY (organization_id, dataset_id)
          REFERENCES app.datasets (organization_id, id)
      );
      CREATE TABLE app.dataset_features (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        dataset_id uuid NOT NULL,
        deleted_at timestamptz,
        PRIMARY KEY (organization_id, dataset_id, id)
      );
      CREATE TABLE app.project_sites (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        project_id uuid NOT NULL,
        current_version_id uuid NOT NULL,
        current_version_number bigint NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE app.project_site_versions (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        project_id uuid NOT NULL,
        site_id uuid NOT NULL,
        version_number bigint NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      GRANT SELECT ON
        app.project_datasets, app.datasets, app.dataset_versions,
        app.dataset_features, app.project_sites, app.project_site_versions
      TO opengeo_runtime;
    `);
    await db.exec(resources);
    await db.exec(resourceGovernance);
    await db.exec(teams);
    await db.exec(discussions);
    await db.exec(featureTargets);
    await db.exec(collaboration);
    await db.exec(`
      CREATE FUNCTION app.current_user_is_organization_admin()
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY INVOKER
      SET search_path = pg_catalog, app
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM app.organization_memberships membership
          WHERE membership.organization_id = app.current_organization_id()
            AND membership.user_id = app.current_user_id()
            AND membership.role = 'admin'
        )
      $$;
      REVOKE EXECUTE ON FUNCTION app.current_user_is_organization_admin() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION app.current_user_is_organization_admin() TO opengeo_runtime;
    `);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'community-owner', 'owner@example.test', 'Owner'),
        ('${IDS.editor}', 'community-editor', 'editor@example.test', 'Editor'),
        ('${IDS.viewer}', 'community-viewer', 'viewer@example.test', 'Viewer'),
        ('${IDS.outsider}', 'community-outsider', 'outsider@example.test', 'Outsider');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${IDS.organization}', 'Community', 'community', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other', 'community-other', '${IDS.outsider}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.editor}', 'member', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.viewer}', 'member', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.outsider}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.outsider}', 'admin', '${IDS.outsider}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Community project', '${IDS.owner}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role) VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.editor}', 'editor'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.viewer}', 'viewer');
      BEGIN;
      INSERT INTO app.governed_resources
        (id, organization_id, project_id, kind, slug, visibility, state,
         current_version_id, owner_user_id, created_by, updated_by)
      VALUES (
        '${IDS.resource}', '${IDS.organization}', '${IDS.project}', 'dataset',
        'community-dataset', 'public', 'published', '${IDS.resourceVersion}',
        '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'
      );
      INSERT INTO app.governed_resource_versions
        (id, organization_id, resource_id, version_number, title, created_by)
      VALUES (
        '${IDS.resourceVersion}', '${IDS.organization}', '${IDS.resource}', 1,
        'Community dataset', '${IDS.owner}'
      );
      COMMIT;
      BEGIN;
      INSERT INTO app.project_discussions
        (id, organization_id, project_id, initial_comment_id, title, created_by)
      VALUES (
        '${IDS.discussion}', '${IDS.organization}', '${IDS.project}',
        '${IDS.comment}', 'Review community dataset', '${IDS.editor}'
      );
      INSERT INTO app.project_discussion_comments
        (id, organization_id, project_id, discussion_id, body, created_by)
      VALUES (
        '${IDS.comment}', '${IDS.organization}', '${IDS.project}', '${IDS.discussion}',
        'Original preserved comment.', '${IDS.editor}'
      );
      COMMIT;
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("keeps exact-version subscriptions private while sealed fan-out returns no identities", async () => {
    for (const userId of [IDS.editor, IDS.viewer]) {
      await inTenant(userId, () => db.query(
        `INSERT INTO app.project_discussion_subscriptions
           (organization_id, project_id, discussion_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [IDS.organization, IDS.project, IDS.discussion, userId]
      ));
    }
    const editorRows = await inTenant(IDS.editor, () => db.query(
      "SELECT user_id, version_number FROM app.project_discussion_subscriptions"
    ));
    assert.deepEqual(editorRows.rows, [{user_id: IDS.editor, version_number: 1}]);

    const fanout = await inTenant(IDS.editor, () => db.query(
      `SELECT app.notify_project_discussion_recipients(
         $1, $2, $3, 1, $4, 'reply', ARRAY[]::uuid[], true
       ) AS result`,
      [IDS.organization, IDS.project, IDS.discussion, IDS.comment]
    ));
    assert.equal(fanout.rows.length, 1);
    assert.ok(fanout.rows[0].result === null || fanout.rows[0].result === "");
    const viewerNotifications = await inTenant(IDS.viewer, () => db.query(
      "SELECT recipient_user_id, kind::text FROM app.project_notifications"
    ));
    assert.deepEqual(viewerNotifications.rows, [{
      recipient_user_id: IDS.viewer,
      kind: "reply"
    }]);

    const unsubscribed = await inTenant(IDS.viewer, () => db.query(
      `WITH moment AS (SELECT clock_timestamp() AS value)
       UPDATE app.project_discussion_subscriptions subscription
       SET version_number = 2, unsubscribed_at = moment.value, updated_at = moment.value
       FROM moment
       WHERE discussion_id = $1
       RETURNING version_number, unsubscribed_at IS NOT NULL AS unsubscribed`,
      [IDS.discussion]
    ));
    assert.deepEqual(unsubscribed.rows, [{version_number: 2, unsubscribed: true}]);
    await assert.rejects(
      inTenant(IDS.viewer, () => db.query(
        "DELETE FROM app.project_discussion_subscriptions WHERE discussion_id = $1",
        [IDS.discussion]
      )),
      /permission denied|append-only/
    );
  });

  it("redacts through one immutable moderator decision without rewriting the comment", async () => {
    await assert.rejects(
      inTenant(IDS.viewer, () => db.query(
        `INSERT INTO app.project_discussion_comment_moderations
           (id, organization_id, project_id, discussion_id, comment_id,
            action, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, 'redact', 'Not authorized.', $6)`,
        [
          IDS.moderation, IDS.organization, IDS.project, IDS.discussion,
          IDS.comment, IDS.viewer
        ]
      )),
      /row-level security|moderator authority/
    );
    await inTenant(IDS.editor, () => db.query(
      `INSERT INTO app.project_discussion_comment_moderations
         (id, organization_id, project_id, discussion_id, comment_id,
          action, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, 'redact', 'Contains a private credential.', $6)`,
      [
        IDS.moderation, IDS.organization, IDS.project, IDS.discussion,
        IDS.comment, IDS.editor
      ]
    ));
    const preserved = await inTenant(IDS.viewer, () => db.query(
      `SELECT comment.body, moderation.reason
       FROM app.project_discussion_comments comment
       JOIN app.project_discussion_comment_moderations moderation
         ON moderation.comment_id = comment.id
       WHERE comment.id = $1`,
      [IDS.comment]
    ));
    assert.deepEqual(preserved.rows, [{
      body: "Original preserved comment.",
      reason: "Contains a private credential."
    }]);
    await assert.rejects(
      inTenant(IDS.editor, () => db.query(
        "UPDATE app.project_discussion_comment_moderations SET reason = 'Changed'"
      )),
      /permission denied|append-only/
    );
  });

  it("keeps one private rating history per user and publishes only its aggregate", async () => {
    await inTenant(IDS.editor, () => db.query(
      `INSERT INTO app.governed_resource_ratings
         (organization_id, project_id, resource_id, user_id, score)
       VALUES ($1, $2, $3, $4, 5)`,
      [IDS.organization, IDS.project, IDS.resource, IDS.editor]
    ));
    await inTenant(IDS.viewer, () => db.query(
      `INSERT INTO app.governed_resource_ratings
         (organization_id, project_id, resource_id, user_id, score)
       VALUES ($1, $2, $3, $4, 3)`,
      [IDS.organization, IDS.project, IDS.resource, IDS.viewer]
    ));
    const viewerPrivate = await inTenant(IDS.viewer, async () => ({
      ratings: (await db.query(
        "SELECT user_id, score FROM app.governed_resource_ratings"
      )).rows,
      revisions: (await db.query(
        "SELECT user_id, score FROM app.governed_resource_rating_revisions"
      )).rows,
      summary: (await db.query(
        "SELECT rating_count, rating_sum FROM app.governed_resource_rating_summaries"
      )).rows
    }));
    assert.deepEqual(viewerPrivate, {
      ratings: [{user_id: IDS.viewer, score: 3}],
      revisions: [{user_id: IDS.viewer, score: 3}],
      summary: [{rating_count: 2, rating_sum: 8}]
    });

    await inTenant(IDS.viewer, () => db.query(
      `WITH moment AS (SELECT clock_timestamp() AS value)
       UPDATE app.governed_resource_ratings rating
       SET score = NULL, version_number = 2,
           withdrawn_at = moment.value, updated_at = moment.value
       FROM moment
       WHERE resource_id = $1`,
      [IDS.resource]
    ));
    const withdrawn = await inTenant(IDS.viewer, async () => ({
      current: (await db.query(
        "SELECT score, version_number FROM app.governed_resource_ratings"
      )).rows,
      revisions: (await db.query(
        `SELECT score, version_number
         FROM app.governed_resource_rating_revisions ORDER BY version_number`
      )).rows,
      summary: (await db.query(
        "SELECT rating_count, rating_sum FROM app.governed_resource_rating_summaries"
      )).rows
    }));
    assert.deepEqual(withdrawn, {
      current: [{score: null, version_number: 2}],
      revisions: [{score: 3, version_number: 1}, {score: null, version_number: 2}],
      summary: [{rating_count: 1, rating_sum: 5}]
    });

    await inTenant(IDS.viewer, () => db.query(
      `WITH moment AS (SELECT clock_timestamp() AS value)
       UPDATE app.governed_resource_ratings rating
       SET score = 2, version_number = 3,
           withdrawn_at = NULL, updated_at = moment.value
       FROM moment
       WHERE resource_id = $1`,
      [IDS.resource]
    ));
    await inTenant(IDS.editor, () => db.query(
      `WITH moment AS (SELECT clock_timestamp() AS value)
       UPDATE app.governed_resource_ratings rating
       SET score = 1, version_number = 2, updated_at = moment.value
       FROM moment
       WHERE resource_id = $1`,
      [IDS.resource]
    ));
    const revisedSummary = await inTenant(IDS.viewer, () => db.query(
      "SELECT rating_count, rating_sum FROM app.governed_resource_rating_summaries"
    ));
    assert.deepEqual(revisedSummary.rows, [{rating_count: 2, rating_sum: 3}]);

    const anonymous = await inTenant("00000000-0000-0000-0000-000000000000", async () => ({
      ratings: (await db.query("SELECT * FROM app.governed_resource_ratings")).rows,
      summaries: (await db.query(
        "SELECT rating_count, rating_sum FROM app.governed_resource_rating_summaries"
      )).rows
    }));
    assert.deepEqual(anonymous, {
      ratings: [],
      summaries: [{rating_count: 2, rating_sum: 3}]
    });
    const crossTenant = await inTenant(
      IDS.outsider,
      () => db.query("SELECT * FROM app.governed_resource_rating_summaries"),
      IDS.otherOrganization
    );
    assert.deepEqual(crossTenant.rows, []);
  });

  it("keeps identity-bearing tables from workers and subscriber identities from runtime", () => {
    assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
    assert.match(migration, /Append-only irreversible moderation decisions/i);
    assert.match(migration, /Identity-free resource rating counts and sums/i);
    assert.match(
      migration,
      /rating_count = summary\.rating_count \+ \(new_count - old_count\)/
    );
    assert.match(
      migration,
      /rating_sum = summary\.rating_sum \+ \(new_sum - old_sum\)/
    );
    assert.doesNotMatch(
      migration,
      /FROM app\.governed_resource_ratings rating\s+WHERE rating\.organization_id = NEW\.organization_id/
    );
    assert.doesNotMatch(migration, /RETURNS TABLE \(user_id uuid\)/);
    assert.match(
      migration,
      /REVOKE ALL ON[\s\S]+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
  });
});
