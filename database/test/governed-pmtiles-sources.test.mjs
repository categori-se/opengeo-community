import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000071",
  user: "20000000-0000-4000-8000-000000000071",
  project: "50000000-0000-4000-8000-000000000071",
  external: "80000000-0000-4000-8000-000000000071",
  upload: "80000000-0000-4000-8000-000000000072"
};

let db;

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

describe("0007 governed PMTiles source migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql",
      "0006_governed_external_sources.sql",
      "0007_governed_pmtiles_sources.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.user}', 'pmtiles-user', 'pmtiles@example.test', 'PMTiles Admin');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'PMTiles', 'pmtiles', '${IDS.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'PMTiles project', '${IDS.user}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("stores an append-only PMTiles identity and syntax-only revision", async () => {
    const result = await inTenant(async () => {
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, source_type, format, status,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, 'Public archive', 'public', 'pmtiles', 'pmtiles', 'active', $3, $3, $3)`,
        [IDS.external, IDS.organization, IDS.user]
      );
      await db.query(
        `INSERT INTO app.external_sources
           (organization_id, dataset_id, source_type, created_by)
         VALUES ($1, $2, 'pmtiles', $3)`,
        [IDS.organization, IDS.external, IDS.user]
      );
      await db.query(
        `INSERT INTO app.external_source_revisions
           (organization_id, dataset_id, version_number, source_url, configuration, created_by)
         VALUES ($1, $2, 1, 'https://data.example.test/public.pmtiles',
                 '{"tile_type":"vector","source_layer":"public","geometry_type":"Polygon"}'::jsonb, $3)`,
        [IDS.organization, IDS.external, IDS.user]
      );
      return db.query(
        `SELECT source.source_type::text, revision.verification_state::text,
                revision.configuration->>'tile_type' AS tile_type
         FROM app.external_sources source
         JOIN app.external_source_revisions revision USING (organization_id, dataset_id)
         WHERE source.dataset_id = $1`,
        [IDS.external]
      );
    });
    assert.deepEqual(result.rows, [{source_type: "pmtiles", verification_state: "syntax_only", tile_type: "vector"}]);
  });

  it("keeps managed PMTiles uploads valid and rejects mismatched external identities", async () => {
    await inTenant(() => db.query(
      `INSERT INTO app.datasets
         (id, organization_id, name, classification, source_type, format, status,
          owner_user_id, created_by, updated_by)
       VALUES ($1, $2, 'Uploaded archive', 'internal', 'upload', 'pmtiles', 'draft', $3, $3, $3)`,
      [IDS.upload, IDS.organization, IDS.user]
    ));
    await assert.rejects(
      inTenant(() => db.query(
        `INSERT INTO app.external_sources
           (organization_id, dataset_id, source_type, created_by)
         VALUES ($1, $2, 'pmtiles', $3)`,
        [IDS.organization, IDS.upload, IDS.user]
      )),
      /must match an XYZ, WMS, or PMTiles dataset/
    );
  });

  it("keeps PMTiles source rows hidden from the isolated worker", async () => {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(db.query("SELECT dataset_id FROM app.external_sources"), /permission denied/);
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
