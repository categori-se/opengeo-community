import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  projectA: "50000000-0000-4000-8000-000000000001",
  projectB: "50000000-0000-4000-8000-000000000002",
  dataset: "80000000-0000-4000-8000-000000000001"
};

let db;

async function migration(name) {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  return sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
}

async function inTenant(operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [IDS.user]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

describe("0054/0055 reusable project dataset references", () => {
  before(async () => {
    db = new PGlite();
    for (const name of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql"
    ]) await db.exec(await migration(name));
    await db.exec(`
      CREATE ROLE opengeo_worker NOLOGIN;
      CREATE ROLE opengeo_connector NOLOGIN;
      CREATE ROLE opengeo_observable_coordinator NOLOGIN;
      CREATE ROLE opengeo_dataset_verifier NOLOGIN;
    `);
    await db.exec(await migration("0054_reusable_project_datasets.sql"));
    await db.exec(await migration("0055_project_dataset_detach_lock.sql"));
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.user}', 'reusable-owner', 'owner@example.test', 'Dataset Owner');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'Reusable Data', 'reusable-data', '${IDS.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.projectA}', '${IDS.organization}', 'Project A', '${IDS.user}'),
        ('${IDS.projectB}', '${IDS.organization}', 'Project B', '${IDS.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, format, owner_user_id, created_by, updated_by)
      VALUES
        ('${IDS.dataset}', '${IDS.organization}', 'Shared roads', 'internal', 'geojson', '${IDS.user}', '${IDS.user}', '${IDS.user}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organization}', '${IDS.projectA}', '${IDS.dataset}', '${IDS.user}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("lets the API runtime attach and detach one dataset without copying its record", async () => {
    await inTenant(() => db.query(
      `INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
       VALUES ($1, $2, $3, $4)`,
      [IDS.organization, IDS.projectB, IDS.dataset, IDS.user]
    ));
    const linked = await inTenant(() => db.query(
      "SELECT project_id FROM app.project_datasets WHERE dataset_id = $1 ORDER BY project_id",
      [IDS.dataset]
    ));
    assert.deepEqual(linked.rows, [{project_id: IDS.projectA}, {project_id: IDS.projectB}]);

    await inTenant(() => db.query(
      "DELETE FROM app.project_datasets WHERE project_id = $1 AND dataset_id = $2",
      [IDS.projectB, IDS.dataset]
    ));
    const remaining = await inTenant(() => db.query(
      "SELECT project_id FROM app.project_datasets WHERE dataset_id = $1",
      [IDS.dataset]
    ));
    assert.deepEqual(remaining.rows, [{project_id: IDS.projectA}]);
  });

  it("keeps detach authority away from background service roles", async () => {
    await db.exec("RESET ROLE");
    const privileges = await db.query(`
      SELECT
        has_table_privilege('opengeo_runtime', 'app.project_datasets', 'DELETE') AS runtime_delete,
        has_table_privilege('opengeo_worker', 'app.project_datasets', 'DELETE') AS worker_delete,
        has_table_privilege('opengeo_connector', 'app.project_datasets', 'DELETE') AS connector_delete,
        has_table_privilege('opengeo_observable_coordinator', 'app.project_datasets', 'DELETE') AS coordinator_delete,
        has_table_privilege('opengeo_dataset_verifier', 'app.project_datasets', 'DELETE') AS verifier_delete,
        has_column_privilege('opengeo_runtime', 'app.project_datasets', 'linked_at', 'UPDATE') AS runtime_lock,
        has_column_privilege('opengeo_worker', 'app.project_datasets', 'linked_at', 'UPDATE') AS worker_lock,
        has_column_privilege('opengeo_connector', 'app.project_datasets', 'linked_at', 'UPDATE') AS connector_lock,
        has_column_privilege('opengeo_observable_coordinator', 'app.project_datasets', 'linked_at', 'UPDATE') AS coordinator_lock,
        has_column_privilege('opengeo_dataset_verifier', 'app.project_datasets', 'linked_at', 'UPDATE') AS verifier_lock
    `);
    assert.deepEqual(privileges.rows, [{
      runtime_delete: true,
      worker_delete: false,
      connector_delete: false,
      coordinator_delete: false,
      verifier_delete: false,
      runtime_lock: true,
      worker_lock: false,
      connector_lock: false,
      coordinator_lock: false,
      verifier_lock: false
    }]);
    await db.exec("SET ROLE opengeo_runtime");
  });
});
