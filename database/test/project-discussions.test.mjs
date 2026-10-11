import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000075",
  organizationB: "10000000-0000-4000-8000-000000000076",
  owner: "20000000-0000-4000-8000-000000000075",
  viewer: "20000000-0000-4000-8000-000000000076",
  reviewer: "20000000-0000-4000-8000-000000000077",
  outsider: "20000000-0000-4000-8000-000000000078",
  otherTenant: "20000000-0000-4000-8000-000000000079",
  projectA: "50000000-0000-4000-8000-000000000075",
  projectB: "50000000-0000-4000-8000-000000000076",
  discussion: "d5000000-0000-4000-8000-000000000075",
  initialComment: "c5000000-0000-4000-8000-000000000075",
  viewerComment: "c5000000-0000-4000-8000-000000000076",
  missingCommentDiscussion: "d5000000-0000-4000-8000-000000000077",
  missingComment: "c5000000-0000-4000-8000-000000000077",
  otherDiscussion: "d5000000-0000-4000-8000-000000000078",
  otherComment: "c5000000-0000-4000-8000-000000000078"
};

let db;
let migration;

async function inTenant(organizationId, userId, operation) {
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

async function createThread({
  organizationId = IDS.organizationA,
  projectId = IDS.projectA,
  userId = IDS.owner,
  discussionId = IDS.discussion,
  commentId = IDS.initialComment,
  title = "Review the flood layer",
  body = "Check the source date."
} = {}) {
  return inTenant(organizationId, userId, async () => {
    await db.query(
      `INSERT INTO app.project_discussions
         (id, organization_id, project_id, initial_comment_id, title, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [discussionId, organizationId, projectId, commentId, title, userId]
    );
    await db.query(
      `INSERT INTO app.project_discussion_comments
         (id, organization_id, project_id, discussion_id, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [commentId, organizationId, projectId, discussionId, body, userId]
    );
  });
}

describe("0075 project discussions migration", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readFile(
      new URL("../migrations/0001_platform_foundation.sql", import.meta.url),
      "utf8"
    );
    const teams = await readFile(
      new URL("../migrations/0050_team_project_access.sql", import.meta.url),
      "utf8"
    );
    migration = await readFile(
      new URL("../migrations/0075_project_discussions.sql", import.meta.url),
      "utf8"
    );
    await db.exec(foundation.replace(
      /^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm,
      ""
    ));
    await db.exec(`
      CREATE ROLE opengeo_worker;
      CREATE ROLE opengeo_connector;
      CREATE ROLE opengeo_observable_coordinator;
    `);
    await db.exec(teams);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'discussion-owner', 'owner@example.test', 'Owner'),
        ('${IDS.viewer}', 'discussion-viewer', 'viewer@example.test', 'Viewer'),
        ('${IDS.reviewer}', 'discussion-reviewer', 'reviewer@example.test', 'Reviewer'),
        ('${IDS.outsider}', 'discussion-outsider', 'outsider@example.test', 'Outsider'),
        ('${IDS.otherTenant}', 'discussion-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Organization A', 'discussion-a', '${IDS.owner}'),
        ('${IDS.organizationB}', 'Organization B', 'discussion-b', '${IDS.otherTenant}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.viewer}', 'member', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.reviewer}', 'member', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.outsider}', 'member', '${IDS.owner}'),
        ('${IDS.organizationB}', '${IDS.otherTenant}', 'admin', '${IDS.otherTenant}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.projectA}', '${IDS.organizationA}', 'Project A', '${IDS.owner}'),
        ('${IDS.projectB}', '${IDS.organizationB}', 'Project B', '${IDS.otherTenant}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role)
      VALUES
        ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.owner}', 'owner'),
        ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.viewer}', 'viewer'),
        ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.reviewer}', 'reviewer'),
        ('${IDS.organizationB}', '${IDS.projectB}', '${IDS.otherTenant}', 'owner');
      SET ROLE opengeo_runtime;
    `);
    await createThread();
    await createThread({
      organizationId: IDS.organizationB,
      projectId: IDS.projectB,
      userId: IDS.otherTenant,
      discussionId: IDS.otherDiscussion,
      commentId: IDS.otherComment,
      title: "Other tenant thread",
      body: "Private to the other tenant."
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("binds every thread to one exact initial comment at commit", async () => {
    const result = await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      `SELECT discussion.id, discussion.state::text, discussion.version_number,
              comment.body
       FROM app.project_discussions discussion
       JOIN app.project_discussion_comments comment
         ON comment.id = discussion.initial_comment_id
       WHERE discussion.id = $1`,
      [IDS.discussion]
    ));
    assert.deepEqual(result.rows, [{
      id: IDS.discussion,
      state: "open",
      version_number: 1,
      body: "Check the source date."
    }]);

    await assert.rejects(
      inTenant(IDS.organizationA, IDS.owner, () => db.query(
        `INSERT INTO app.project_discussions
           (id, organization_id, project_id, initial_comment_id, title, created_by)
         VALUES ($1, $2, $3, $4, 'Incomplete thread', $5)`,
        [
          IDS.missingCommentDiscussion,
          IDS.organizationA,
          IDS.projectA,
          IDS.missingComment,
          IDS.owner
        ]
      )),
      /project_discussions_initial_comment_fk|foreign key constraint/
    );
  });

  it("permits members to reply but makes comments append-only", async () => {
    await inTenant(IDS.organizationA, IDS.viewer, () => db.query(
      `INSERT INTO app.project_discussion_comments
         (id, organization_id, project_id, discussion_id, body, created_by)
       VALUES ($1, $2, $3, $4, 'Ready for review.', $5)`,
      [
        IDS.viewerComment,
        IDS.organizationA,
        IDS.projectA,
        IDS.discussion,
        IDS.viewer
      ]
    ));
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.viewer, () => db.query(
        "UPDATE app.project_discussion_comments SET body = 'Changed' WHERE id = $1",
        [IDS.viewerComment]
      )),
      /permission denied|append-only/
    );
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.viewer, () => db.query(
        "DELETE FROM app.project_discussion_comments WHERE id = $1",
        [IDS.viewerComment]
      )),
      /permission denied|append-only/
    );
  });

  it("allows reviewer resolution, enforces versioning, and blocks closed replies", async () => {
    const viewerResolution = await inTenant(
      IDS.organizationA,
      IDS.viewer,
      () => db.query(
        `UPDATE app.project_discussions
         SET state = 'resolved', version_number = 2,
             resolved_by = $2, resolved_at = clock_timestamp()
         WHERE id = $1
         RETURNING id`,
        [IDS.discussion, IDS.viewer]
      )
    );
    assert.deepEqual(viewerResolution.rows, []);
    const resolved = await inTenant(IDS.organizationA, IDS.reviewer, () => db.query(
      `UPDATE app.project_discussions
       SET state = 'resolved', version_number = 2,
           resolved_by = $2, resolved_at = clock_timestamp()
       WHERE id = $1
       RETURNING state::text, version_number, resolved_by`,
      [IDS.discussion, IDS.reviewer]
    ));
    assert.deepEqual(resolved.rows, [{
      state: "resolved",
      version_number: 2,
      resolved_by: IDS.reviewer
    }]);
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.viewer, () => db.query(
        `INSERT INTO app.project_discussion_comments
           (id, organization_id, project_id, discussion_id, body, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'Too late', $4)`,
        [IDS.organizationA, IDS.projectA, IDS.discussion, IDS.viewer]
      )),
      /row-level security policy/
    );
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.reviewer, () => db.query(
        `UPDATE app.project_discussions
         SET state = 'open', version_number = 4,
             resolved_by = NULL, resolved_at = NULL
         WHERE id = $1`,
        [IDS.discussion]
      )),
      /next version/
    );
  });

  it("keeps project and tenant access inside explicit roles", async () => {
    const visible = await inTenant(IDS.organizationA, IDS.viewer, async () => ({
      discussions: (await db.query(
        "SELECT id FROM app.project_discussions ORDER BY id"
      )).rows,
      comments: (await db.query(
        "SELECT id FROM app.project_discussion_comments ORDER BY id"
      )).rows
    }));
    assert.deepEqual(visible, {
      discussions: [{id: IDS.discussion}],
      comments: [{id: IDS.initialComment}, {id: IDS.viewerComment}]
    });
    const outsider = await inTenant(IDS.organizationA, IDS.outsider, () => db.query(
      "SELECT id FROM app.project_discussions"
    ));
    assert.deepEqual(outsider.rows, []);
  });

  it("denies non-API runtime roles and documents the narrow collaboration boundary", () => {
    assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
    assert.match(migration, /comments are append-only/i);
    assert.match(
      migration,
      /REVOKE ALL ON\s+app\.project_discussions,\s+app\.project_discussion_comments\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
  });
});
