import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000061",
  organizationB: "10000000-0000-4000-8000-000000000062",
  userA: "20000000-0000-4000-8000-000000000061",
  userB: "20000000-0000-4000-8000-000000000062",
  projectA: "50000000-0000-4000-8000-000000000061",
  xyzDataset: "80000000-0000-4000-8000-000000000061",
  uploadDataset: "80000000-0000-4000-8000-000000000062"
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

describe("0006 governed external source migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql",
      "0006_governed_external_sources.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.userA}', 'source-a', 'source-a@example.test', 'Source Admin'),
        ('${IDS.userB}', 'source-b', 'source-b@example.test', 'Other Admin');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Sources A', 'sources-a', '${IDS.userA}'),
        ('${IDS.organizationB}', 'Sources B', 'sources-b', '${IDS.userB}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.userA}', 'admin', '${IDS.userA}'),
        ('${IDS.organizationB}', '${IDS.userB}', 'admin', '${IDS.userB}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.projectA}', '${IDS.organizationA}', 'External sources', '${IDS.userA}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("stores a matching source identity and append-only revisions", async () => {
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => {
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, source_type, format, status,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, 'Public tiles', 'public', 'xyz', 'xyz', 'active', $3, $3, $3)`,
        [IDS.xyzDataset, IDS.organizationA, IDS.userA]
      );
      await db.query(
        `INSERT INTO app.external_sources
           (organization_id, dataset_id, source_type, created_by)
         VALUES ($1, $2, 'xyz', $3)`,
        [IDS.organizationA, IDS.xyzDataset, IDS.userA]
      );
      await db.query(
        `INSERT INTO app.external_source_revisions
           (organization_id, dataset_id, version_number, source_url, configuration, created_by)
         VALUES ($1, $2, 1, 'https://tiles.example.test/{z}/{x}/{y}.png',
                 '{"tile_size":256,"scheme":"xyz"}'::jsonb, $3),
                ($1, $2, 2, 'https://tiles.example.test/v2/{z}/{x}/{y}.png',
                 '{"tile_size":256,"scheme":"xyz"}'::jsonb, $3)`,
        [IDS.organizationA, IDS.xyzDataset, IDS.userA]
      );
      return db.query(
        `SELECT version_number, verification_state::text
         FROM app.external_source_revisions
         WHERE dataset_id = $1 ORDER BY version_number`,
        [IDS.xyzDataset]
      );
    });
    assert.deepEqual(result.rows, [
      {version_number: 1, verification_state: "syntax_only"},
      {version_number: 2, verification_state: "syntax_only"}
    ]);
  });

  it("rejects a source identity that does not match its dataset", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, async () => {
        await db.query(
          `INSERT INTO app.datasets
             (id, organization_id, name, classification, format,
              owner_user_id, created_by, updated_by)
           VALUES ($1, $2, 'Stored file', 'internal', 'geojson', $3, $3, $3)`,
          [IDS.uploadDataset, IDS.organizationA, IDS.userA]
        );
        await db.query(
          `INSERT INTO app.external_sources
             (organization_id, dataset_id, source_type, created_by)
           VALUES ($1, $2, 'xyz', $3)`,
          [IDS.organizationA, IDS.uploadDataset, IDS.userA]
        );
      }),
      /must match an XYZ or WMS dataset/
    );
  });

  it("keeps source rows immutable and hidden from other tenants", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          "UPDATE app.external_source_revisions SET source_url = 'https://evil.example/{z}/{x}/{y}' WHERE dataset_id = $1",
          [IDS.xyzDataset]
        )
      ),
      /permission denied/
    );
    const hidden = await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query("SELECT dataset_id FROM app.external_sources")
    );
    assert.deepEqual(hidden.rows, []);
  });

  it("does not grant the isolated worker direct source access", async () => {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT dataset_id FROM app.external_sources"),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
