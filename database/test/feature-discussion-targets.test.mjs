import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";

import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000077",
  owner: "20000000-0000-4000-8000-000000000077",
  project: "50000000-0000-4000-8000-000000000077",
  map: "60000000-0000-4000-8000-000000000077",
  dataset: "80000000-0000-4000-8000-000000000077",
  feature: "90000000-0000-4000-8000-000000000077",
  projectDiscussion: "d5000000-0000-4000-8000-000000000077",
  projectComment: "c5000000-0000-4000-8000-000000000077",
  featureDiscussion: "d5000000-0000-4000-8000-000000000078",
  featureComment: "c5000000-0000-4000-8000-000000000078"
};

let db;
let migration;

async function inTenant(operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [IDS.owner]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function createDiscussion({
  discussionId,
  commentId,
  target = false,
  layerId = "wetlands",
  mapVersion = 1,
  featureId = IDS.feature
}) {
  return inTenant(async () => {
    await db.query(
      `INSERT INTO app.project_discussions
         (id, organization_id, project_id, initial_comment_id, title, created_by,
          target_kind, target_map_id, target_map_version, target_layer_id,
          target_dataset_id, target_feature_id)
       VALUES ($1, $2, $3, $4, 'Review mapped feature', $5,
               $6, $7, $8, $9, $10, $11)`,
      [
        discussionId,
        IDS.organization,
        IDS.project,
        commentId,
        IDS.owner,
        target ? "feature" : "project",
        target ? IDS.map : null,
        target ? mapVersion : null,
        target ? layerId : null,
        target ? IDS.dataset : null,
        target ? featureId : null
      ]
    );
    await db.query(
      `INSERT INTO app.project_discussion_comments
         (id, organization_id, project_id, discussion_id, body, created_by)
       VALUES ($1, $2, $3, $4, 'Confirm the mapped boundary.', $5)`,
      [commentId, IDS.organization, IDS.project, discussionId, IDS.owner]
    );
  });
}

describe("0077 feature discussion targets migration", () => {
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
    const discussions = await readFile(
      new URL("../migrations/0075_project_discussions.sql", import.meta.url),
      "utf8"
    );
    migration = await readFile(
      new URL("../migrations/0077_feature_discussion_targets.sql", import.meta.url),
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
      CREATE TABLE app.datasets (
        id uuid NOT NULL,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        PRIMARY KEY (organization_id, id)
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
        version_number bigint NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        PRIMARY KEY (organization_id, dataset_id, id),
        FOREIGN KEY (organization_id, dataset_id)
          REFERENCES app.datasets (organization_id, id)
      );
      GRANT SELECT ON app.project_datasets, app.dataset_features TO opengeo_runtime;
    `);
    await db.exec(teams);
    await db.exec(discussions);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.owner}', 'feature-discussion-owner', 'owner@example.test', 'Owner');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'Organization', 'feature-discussions', '${IDS.owner}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Project', '${IDS.owner}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner');
      INSERT INTO app.datasets (id, organization_id)
      VALUES ('${IDS.dataset}', '${IDS.organization}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}');
      INSERT INTO app.dataset_features (id, organization_id, dataset_id)
      VALUES ('${IDS.feature}', '${IDS.organization}', '${IDS.dataset}');
      INSERT INTO app.maps
        (id, organization_id, project_id, name, definition, created_by, updated_by)
      VALUES (
        '${IDS.map}', '${IDS.organization}', '${IDS.project}', 'Wetlands map',
        '{"layers":[{"layerId":"wetlands","datasetId":"${IDS.dataset}","title":"Wetlands"}]}'::jsonb,
        '${IDS.owner}', '${IDS.owner}'
      );
      INSERT INTO app.map_versions
        (organization_id, map_id, version, definition, created_by)
      SELECT organization_id, id, version, definition, '${IDS.owner}'
      FROM app.maps WHERE id = '${IDS.map}';
      SET ROLE opengeo_runtime;
    `);
    await createDiscussion({
      discussionId: IDS.projectDiscussion,
      commentId: IDS.projectComment
    });
    await createDiscussion({
      discussionId: IDS.featureDiscussion,
      commentId: IDS.featureComment,
      target: true
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("preserves project threads and one exact map-layer-feature target", async () => {
    const result = await inTenant(() => db.query(
      `SELECT id, target_kind::text, target_map_id, target_map_version,
              target_layer_id, target_dataset_id, target_feature_id
       FROM app.project_discussions ORDER BY id`
    ));
    assert.deepEqual(result.rows, [
      {
        id: IDS.projectDiscussion,
        target_kind: "project",
        target_map_id: null,
        target_map_version: null,
        target_layer_id: null,
        target_dataset_id: null,
        target_feature_id: null
      },
      {
        id: IDS.featureDiscussion,
        target_kind: "feature",
        target_map_id: IDS.map,
        target_map_version: 1,
        target_layer_id: "wetlands",
        target_dataset_id: IDS.dataset,
        target_feature_id: IDS.feature
      }
    ]);
  });

  it("rejects a nonexistent map version or mismatched layer before commit", async () => {
    await assert.rejects(
      createDiscussion({
        discussionId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        target: true,
        mapVersion: 2
      }),
      /feature discussion target must reference/
    );
    await assert.rejects(
      createDiscussion({
        discussionId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        target: true,
        layerId: "roads"
      }),
      /feature discussion target must reference/
    );
  });

  it("rejects a deleted feature and makes an accepted target immutable", async () => {
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE app.dataset_features SET deleted_at = clock_timestamp() WHERE id = $1",
      [IDS.feature]
    );
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(
      createDiscussion({
        discussionId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        target: true
      }),
      /feature discussion target must reference/
    );
    await db.exec("RESET ROLE");
    await db.query("UPDATE app.dataset_features SET deleted_at = NULL WHERE id = $1", [IDS.feature]);
    await db.exec("SET ROLE opengeo_runtime");

    await db.exec("RESET ROLE");
    await assert.rejects(
      inTenant(() => db.query(
        `UPDATE app.project_discussions
         SET target_layer_id = 'roads', state = 'resolved', version_number = 2,
             resolved_by = $2, resolved_at = clock_timestamp()
         WHERE id = $1`,
        [IDS.featureDiscussion, IDS.owner]
      )),
      /target is immutable/
    );
    await db.exec("SET ROLE opengeo_runtime");
  });

  it("retains the ordinary optimistic resolve transition", async () => {
    const result = await inTenant(() => db.query(
      `UPDATE app.project_discussions
       SET state = 'resolved', version_number = 2,
           resolved_by = $2, resolved_at = clock_timestamp()
       WHERE id = $1
       RETURNING state::text, version_number, target_layer_id`,
      [IDS.featureDiscussion, IDS.owner]
    ));
    assert.deepEqual(result.rows, [{
      state: "resolved",
      version_number: 2,
      target_layer_id: "wetlands"
    }]);
  });

  it("documents target validation and closed trigger execution", () => {
    assert.match(migration, /CROSS JOIN LATERAL jsonb_array_elements/);
    assert.match(migration, /feature\.deleted_at IS NULL/);
    assert.match(migration, /project discussion target is immutable/);
    assert.match(
      migration,
      /REVOKE EXECUTE ON FUNCTION\s+app\.validate_project_discussion_target\(\),\s+app\.reject_project_discussion_target_change\(\)\s+FROM PUBLIC/
    );
  });
});
