import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000011",
  organizationB: "10000000-0000-4000-8000-000000000012",
  userA: "20000000-0000-4000-8000-000000000011",
  userB: "20000000-0000-4000-8000-000000000012",
  memberA: "20000000-0000-4000-8000-000000000013",
  projectA: "50000000-0000-4000-8000-000000000011",
  datasetA: "80000000-0000-4000-8000-000000000011",
  originalA: "82000000-0000-4000-8000-000000000011",
  derivativeA: "82000000-0000-4000-8000-000000000012",
  versionA: "83000000-0000-4000-8000-000000000011",
  jobA: "84000000-0000-4000-8000-000000000011"
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

describe("0005 catalog access migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.userA}', 'catalog-a', 'catalog-a@example.test', 'Catalog Admin'),
        ('${IDS.userB}', 'catalog-b', 'catalog-b@example.test', 'Other Tenant'),
        ('${IDS.memberA}', 'catalog-member', 'member-a@example.test', 'Catalog Member');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Catalog A', 'catalog-a', '${IDS.userA}'),
        ('${IDS.organizationB}', 'Catalog B', 'catalog-b', '${IDS.userB}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.userA}', 'admin', '${IDS.userA}'),
        ('${IDS.organizationA}', '${IDS.memberA}', 'member', '${IDS.userA}'),
        ('${IDS.organizationB}', '${IDS.userB}', 'admin', '${IDS.userB}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.projectA}', '${IDS.organizationA}', 'Rainfall', '${IDS.userA}');
      INSERT INTO app.datasets
        (id, organization_id, name, description, classification, format,
         owner_user_id, created_by, updated_by)
      VALUES
        ('${IDS.datasetA}', '${IDS.organizationA}', 'CHIRPS Rainfall',
         'Historical precipitation', 'restricted', 'geopackage',
         '${IDS.userA}', '${IDS.userA}', '${IDS.userA}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.datasetA}', '${IDS.userA}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key,
         s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${IDS.originalA}', '${IDS.organizationA}', '${IDS.datasetA}', 'original',
         'geodata-test', 'organizations/a/original/rainfall.gpkg', 'source-version',
         'etag-source', 'application/geopackage+sqlite3', 100, '${"a".repeat(64)}', '${IDS.userA}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number, original_object_id,
         state, change_message, created_by)
      VALUES
        ('${IDS.versionA}', '${IDS.organizationA}', '${IDS.datasetA}', 1,
         '${IDS.originalA}', 'active', 'Initial import', '${IDS.userA}');
      UPDATE app.datasets SET current_version_id = '${IDS.versionA}', status = 'active'
      WHERE id = '${IDS.datasetA}';
      INSERT INTO app.processing_jobs
        (id, organization_id, project_id, dataset_id, dataset_version_id,
         job_type, state, created_by, worker_token, lease_expires_at,
         last_heartbeat_at)
      VALUES
        ('${IDS.jobA}', '${IDS.organizationA}', '${IDS.projectA}', '${IDS.datasetA}',
         '${IDS.versionA}', 'dataset.ingest', 'running', '${IDS.userA}',
         '86000000-0000-4000-8000-000000000011', clock_timestamp() + interval '5 minutes',
         clock_timestamp());
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key,
         s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${IDS.derivativeA}', '${IDS.organizationA}', '${IDS.datasetA}', 'derived',
         'geodata-test', 'organizations/a/derivatives/rainfall.parquet', 'derived-version',
         'etag-derived', 'application/vnd.apache.parquet', 80, '${"b".repeat(64)}', '${IDS.userA}');
      UPDATE app.processing_jobs
      SET state = 'completed', worker_token = NULL, lease_expires_at = NULL,
          last_heartbeat_at = NULL, result = jsonb_build_object(
        'artifacts', jsonb_build_array(jsonb_build_object('id', '${IDS.derivativeA}'))
      )
      WHERE id = '${IDS.jobA}';
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("indexes bounded catalog text and links original and derivative objects", async () => {
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      search: await db.query(
        "SELECT id FROM app.datasets WHERE search_document @@ websearch_to_tsquery('simple', 'rainfall')"
      ),
      links: await db.query(
        `SELECT object.role::text
         FROM app.dataset_version_objects link
         JOIN app.data_objects object ON object.id = link.data_object_id
         WHERE link.dataset_version_id = $1 ORDER BY object.role`,
        [IDS.versionA]
      )
    }));
    assert.deepEqual(result.search.rows, [{id: IDS.datasetA}]);
    assert.deepEqual(result.links.rows, [{role: "original"}, {role: "derived"}]);
  });

  it("keeps grants tenant bound and invisible across tenant contexts", async () => {
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        `INSERT INTO app.dataset_permissions
           (organization_id, dataset_id, user_id, role, granted_by)
         VALUES ($1, $2, $3, 'download', $4)`,
        [IDS.organizationA, IDS.datasetA, IDS.memberA, IDS.userA]
      )
    );
    const visible = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query("SELECT role::text FROM app.dataset_permissions")
    );
    const hidden = await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query("SELECT role::text FROM app.dataset_permissions")
    );
    assert.deepEqual(visible.rows, [{role: "download"}]);
    assert.deepEqual(hidden.rows, []);

    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          `INSERT INTO app.dataset_permissions
             (organization_id, dataset_id, user_id, role, granted_by)
           VALUES ($1, $2, $3, 'view', $4)`,
          [IDS.organizationA, IDS.datasetA, IDS.userB, IDS.userA]
        )
      ),
      /foreign key|row-level security/
    );
  });

  it("does not let the runtime forge logical-version object associations", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          `INSERT INTO app.dataset_version_objects
             (organization_id, dataset_id, dataset_version_id, data_object_id)
           VALUES ($1, $2, $3, $4)`,
          [IDS.organizationA, IDS.datasetA, IDS.versionA, IDS.originalA]
        )
      ),
      /permission denied/
    );
  });

  it("removes an explicit grant when organization membership is revoked", async () => {
    await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query(
        "DELETE FROM app.organization_memberships WHERE organization_id = $1 AND user_id = $2",
        [IDS.organizationA, IDS.memberA]
      )
    );
    const remaining = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query("SELECT user_id FROM app.dataset_permissions WHERE user_id = $1", [IDS.memberA])
    );
    assert.deepEqual(remaining.rows, []);
  });
});
