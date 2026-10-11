import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000081",
  otherOrganization: "10000000-0000-4000-8000-000000000082",
  user: "20000000-0000-4000-8000-000000000081",
  otherUser: "20000000-0000-4000-8000-000000000082",
  project: "50000000-0000-4000-8000-000000000081",
  map: "60000000-0000-4000-8000-000000000081",
  operation: "90000000-0000-4000-8000-000000000081",
  idempotency: "91000000-0000-4000-8000-000000000081",
  dataset: "80000000-0000-4000-8000-000000000081"
};

let db;

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

describe("0008 recoverable project import migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql",
      "0006_governed_external_sources.sql",
      "0007_governed_pmtiles_sources.sql",
      "0008_recoverable_project_imports.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.user}', 'import-user', 'import@example.test', 'Import Admin'),
        ('${IDS.otherUser}', 'other-import-user', 'other-import@example.test', 'Other Admin');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Imports', 'imports', '${IDS.user}'),
        ('${IDS.otherOrganization}', 'Other Imports', 'other-imports', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Import project', '${IDS.user}');
      INSERT INTO app.maps
        (id, organization_id, project_id, name, created_by, updated_by)
      VALUES ('${IDS.map}', '${IDS.organization}', '${IDS.project}', 'Target map', '${IDS.user}', '${IDS.user}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("stores an idempotent bounded plan and single-assignment import item", async () => {
    const result = await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.project_import_operations
           (id, organization_id, project_id, map_id, idempotency_key,
            source_product, source_version, source_sha256, plan_digest,
            expected_map_version, map_definition, conversion_report, created_by)
         VALUES ($1, $2, $3, $4, $5, 'geolibre', '2.6.0', $6, $7, 1,
                 '{"layers":[{"importRef":"geolibre:embedded"}]}'::jsonb,
                 '{"summary":{"status":"lossless"}}'::jsonb, $8)`,
        [
          IDS.operation,
          IDS.organization,
          IDS.project,
          IDS.map,
          IDS.idempotency,
          "a".repeat(64),
          "b".repeat(64),
          IDS.user
        ]
      );
      await db.query(
        `INSERT INTO app.project_import_items
           (organization_id, import_id, import_ref, kind,
            expected_source_type, expected_format, candidate)
         VALUES ($1, $2, 'geolibre:embedded', 'embedded_dataset',
                 'upload', 'geojson', '{"checksumSha256":"${"c".repeat(64)}"}'::jsonb)`,
        [IDS.organization, IDS.operation]
      );
      return db.query(
        `SELECT operation.state::text AS operation_state,
                item.state::text AS item_state, item.dataset_id
         FROM app.project_import_operations operation
         JOIN app.project_import_items item
           ON item.organization_id = operation.organization_id
          AND item.import_id = operation.id
         WHERE operation.id = $1`,
        [IDS.operation]
      );
    });
    assert.deepEqual(result.rows, [{operation_state: "open", item_state: "pending", dataset_id: null}]);
  });

  it("binds a real dataset once and permits only forward operation completion", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, source_type, format,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, 'Embedded', 'internal', 'upload', 'geojson', $3, $3, $3)`,
        [IDS.dataset, IDS.organization, IDS.user]
      );
      await db.query(
        `UPDATE app.project_import_items
         SET state = 'bound', dataset_id = $1, bound_at = clock_timestamp()
         WHERE organization_id = $2 AND import_id = $3 AND import_ref = 'geolibre:embedded'`,
        [IDS.dataset, IDS.organization, IDS.operation]
      );
      await db.query(
        `UPDATE app.project_import_operations
         SET state = 'completed', completed_at = clock_timestamp()
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.operation]
      );
    });
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.project_import_items SET dataset_id = $1
         WHERE organization_id = $2 AND import_id = $3 AND import_ref = 'geolibre:embedded'`,
        [IDS.dataset, IDS.organization, IDS.operation]
      )),
      /single-assignment/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.project_import_operations SET state = 'open', completed_at = NULL
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.operation]
      )),
      /forward-only/
    );
  });

  it("hides plans from other tenants and the isolated worker", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.project_import_operations")
    );
    assert.deepEqual(hidden.rows, []);

    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT id FROM app.project_import_operations"),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
