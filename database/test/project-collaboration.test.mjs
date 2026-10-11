import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";

import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000079",
  owner: "20000000-0000-4000-8000-000000000079",
  editor: "20000000-0000-4000-8000-000000000080",
  viewer: "20000000-0000-4000-8000-000000000081",
  outsider: "20000000-0000-4000-8000-000000000082",
  project: "50000000-0000-4000-8000-000000000079",
  map: "60000000-0000-4000-8000-000000000079",
  dataset: "70000000-0000-4000-8000-000000000079",
  datasetVersion: "71000000-0000-4000-8000-000000000079",
  feature: "72000000-0000-4000-8000-000000000079",
  resource: "73000000-0000-4000-8000-000000000079",
  resourceVersion: "74000000-0000-4000-8000-000000000079",
  site: "75000000-0000-4000-8000-000000000079",
  siteVersion: "76000000-0000-4000-8000-000000000079",
  discussion: "d5000000-0000-4000-8000-000000000079",
  comment: "c5000000-0000-4000-8000-000000000079",
  reply: "c5000000-0000-4000-8000-000000000080",
  notification: "e5000000-0000-4000-8000-000000000079"
};

let db;
let migration;

async function inTenant(userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function createObjectThread(kind, objectId, version, discussionId = IDS.discussion) {
  const commentId = discussionId === IDS.discussion ? IDS.comment : crypto.randomUUID();
  return inTenant(IDS.editor, async () => {
    await db.query(
      `INSERT INTO app.project_discussions
         (id, organization_id, project_id, initial_comment_id, title, created_by,
          target_kind, target_object_id, target_object_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        discussionId, IDS.organization, IDS.project, commentId,
        `Review ${kind}`, IDS.editor, kind, objectId, version
      ]
    );
    await db.query(
      `INSERT INTO app.project_discussion_comments
         (id, organization_id, project_id, discussion_id, body, created_by)
       VALUES ($1, $2, $3, $4, 'Confirm this exact version.', $5)`,
      [commentId, IDS.organization, IDS.project, discussionId, IDS.editor]
    );
  });
}

describe("0079 project collaboration migration", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readFile(
      new URL("../migrations/0001_platform_foundation.sql", import.meta.url), "utf8"
    );
    const teams = await readFile(
      new URL("../migrations/0050_team_project_access.sql", import.meta.url), "utf8"
    );
    const discussions = await readFile(
      new URL("../migrations/0075_project_discussions.sql", import.meta.url), "utf8"
    );
    const featureTargets = await readFile(
      new URL("../migrations/0077_feature_discussion_targets.sql", import.meta.url), "utf8"
    );
    migration = await readFile(
      new URL("../migrations/0079_project_collaboration.sql", import.meta.url), "utf8"
    );
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
        PRIMARY KEY (organization_id, dataset_id, id),
        FOREIGN KEY (organization_id, dataset_id)
          REFERENCES app.datasets (organization_id, id)
      );
      CREATE TABLE app.governed_resources (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        project_id uuid NOT NULL,
        current_version_id uuid NOT NULL,
        state text NOT NULL DEFAULT 'draft',
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE app.governed_resource_versions (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        resource_id uuid NOT NULL,
        version_number bigint NOT NULL,
        PRIMARY KEY (organization_id, id)
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
        app.project_datasets,
        app.datasets,
        app.dataset_versions,
        app.dataset_features,
        app.governed_resources,
        app.governed_resource_versions,
        app.project_sites,
        app.project_site_versions
      TO opengeo_runtime;
    `);
    await db.exec(teams);
    await db.exec(discussions);
    await db.exec(featureTargets);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'collaboration-owner', 'owner@example.test', 'Owner'),
        ('${IDS.editor}', 'collaboration-editor', 'editor@example.test', 'Editor'),
        ('${IDS.viewer}', 'collaboration-viewer', 'viewer@example.test', 'Viewer'),
        ('${IDS.outsider}', 'collaboration-outsider', 'outsider@example.test', 'Outsider');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'Organization', 'collaboration', '${IDS.owner}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.editor}', 'member', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.viewer}', 'member', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.outsider}', 'member', '${IDS.owner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Project', '${IDS.owner}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role) VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.editor}', 'editor'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.viewer}', 'viewer');
      INSERT INTO app.maps
        (id, organization_id, project_id, name, definition, created_by, updated_by)
      VALUES (
        '${IDS.map}', '${IDS.organization}', '${IDS.project}', 'Review map',
        '{"layers":[]}'::jsonb, '${IDS.owner}', '${IDS.owner}'
      );
      INSERT INTO app.map_versions
        (organization_id, map_id, version, definition, created_by)
      VALUES ('${IDS.organization}', '${IDS.map}', 1, '{"layers":[]}', '${IDS.owner}');
      INSERT INTO app.datasets
        (id, organization_id, current_version_id)
      VALUES ('${IDS.dataset}', '${IDS.organization}', '${IDS.datasetVersion}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number)
      VALUES ('${IDS.datasetVersion}', '${IDS.organization}', '${IDS.dataset}', 1);
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}');
      INSERT INTO app.dataset_features (id, organization_id, dataset_id)
      VALUES ('${IDS.feature}', '${IDS.organization}', '${IDS.dataset}');
      INSERT INTO app.governed_resources
        (id, organization_id, project_id, current_version_id)
      VALUES ('${IDS.resource}', '${IDS.organization}', '${IDS.project}', '${IDS.resourceVersion}');
      INSERT INTO app.governed_resource_versions
        (id, organization_id, resource_id, version_number)
      VALUES ('${IDS.resourceVersion}', '${IDS.organization}', '${IDS.resource}', 1);
      INSERT INTO app.project_sites
        (id, organization_id, project_id, current_version_id, current_version_number)
      VALUES ('${IDS.site}', '${IDS.organization}', '${IDS.project}', '${IDS.siteVersion}', 1);
      INSERT INTO app.project_site_versions
        (id, organization_id, project_id, site_id, version_number)
      VALUES ('${IDS.siteVersion}', '${IDS.organization}', '${IDS.project}', '${IDS.site}', 1);
      SET ROLE opengeo_runtime;
    `);
    await createObjectThread("map", IDS.map, 1);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("accepts exact current map, dataset, resource, and site targets", async () => {
    for (const [kind, objectId] of [
      ["dataset", IDS.dataset],
      ["resource", IDS.resource],
      ["site", IDS.site]
    ]) {
      await createObjectThread(kind, objectId, 1, crypto.randomUUID());
    }
    const result = await inTenant(IDS.viewer, () => db.query(
      `SELECT target_kind::text, target_object_id, target_object_version
       FROM app.project_discussions ORDER BY target_kind::text`
    ));
    assert.deepEqual(result.rows.map(({target_kind}) => target_kind), [
      "dataset", "map", "resource", "site"
    ]);
    await assert.rejects(
      createObjectThread("map", IDS.map, 2, crypto.randomUUID()),
      /exact current object version/
    );
  });

  it("allows one attributed assignment transition only to a project participant", async () => {
    const assigned = await inTenant(IDS.owner, () => db.query(
      `UPDATE app.project_discussions
       SET assigned_to = $2, assigned_by = $3, assigned_at = clock_timestamp(),
           version_number = version_number + 1
       WHERE id = $1
       RETURNING assigned_to, assigned_by, version_number`,
      [IDS.discussion, IDS.viewer, IDS.owner]
    ));
    assert.deepEqual(assigned.rows, [{
      assigned_to: IDS.viewer,
      assigned_by: IDS.owner,
      version_number: 2
    }]);
    await assert.rejects(
      inTenant(IDS.owner, () => db.query(
        `UPDATE app.project_discussions
         SET assigned_to = $2, assigned_by = $3, assigned_at = clock_timestamp(),
             version_number = version_number + 1
         WHERE id = $1`,
        [IDS.discussion, IDS.outsider, IDS.owner]
      )),
      /authorized project participant/
    );
  });

  it("stores append-only mentions and keeps notifications private to the recipient", async () => {
    await inTenant(IDS.editor, async () => {
      await db.query(
        `INSERT INTO app.project_discussion_comments
           (id, organization_id, project_id, discussion_id, body, created_by)
         VALUES ($1, $2, $3, $4, 'Please review.', $5)`,
        [IDS.reply, IDS.organization, IDS.project, IDS.discussion, IDS.editor]
      );
      await db.query(
        `INSERT INTO app.project_discussion_comment_mentions
           (organization_id, project_id, discussion_id, comment_id,
            mentioned_user_id, mentioned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          IDS.organization, IDS.project, IDS.discussion, IDS.reply,
          IDS.viewer, IDS.editor
        ]
      );
      await db.query(
        `INSERT INTO app.project_notifications
           (id, organization_id, project_id, recipient_user_id, actor_user_id,
            discussion_id, discussion_version, comment_id, kind)
         VALUES ($1, $2, $3, $4, $5, $6, 2, $7, 'mention')`,
        [
          IDS.notification, IDS.organization, IDS.project, IDS.viewer,
          IDS.editor, IDS.discussion, IDS.reply
        ]
      );
    });
    const editorNotifications = await inTenant(IDS.editor, () => db.query(
      "SELECT id FROM app.project_notifications"
    ));
    assert.deepEqual(editorNotifications.rows, []);
    const viewerNotifications = await inTenant(IDS.viewer, () => db.query(
      "SELECT id, read_at FROM app.project_notifications"
    ));
    assert.equal(viewerNotifications.rows.length, 1);
    assert.equal(viewerNotifications.rows[0].read_at, null);
    const read = await inTenant(IDS.viewer, () => db.query(
      `UPDATE app.project_notifications
       SET read_at = clock_timestamp(), version_number = 2
       WHERE id = $1 RETURNING version_number, read_at IS NOT NULL AS acknowledged`,
      [IDS.notification]
    ));
    assert.deepEqual(read.rows, [{version_number: 2, acknowledged: true}]);
    await assert.rejects(
      inTenant(IDS.viewer, () => db.query(
        "DELETE FROM app.project_discussion_comment_mentions WHERE comment_id = $1",
        [IDS.reply]
      )),
      /permission denied|append-only/
    );
  });

  it("keeps collaboration helpers closed to public execution and worker access", () => {
    assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
    assert.match(migration, /recipient-private durable assignment, mention, reply, and state/i);
    assert.match(
      migration,
      /REVOKE ALL ON\s+app\.project_discussion_comment_mentions,\s+app\.project_notifications\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
    assert.match(
      migration,
      /REVOKE EXECUTE ON FUNCTION\s+app\.project_discussion_user_has_access\(uuid, uuid, uuid\)/
    );
  });
});
