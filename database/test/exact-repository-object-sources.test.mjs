import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000065",
  otherOrganization: "10000000-0000-4000-8000-000000000066",
  owner: "20000000-0000-4000-8000-000000000065",
  otherOwner: "20000000-0000-4000-8000-000000000066",
  project: "50000000-0000-4000-8000-000000000065",
  otherProject: "50000000-0000-4000-8000-000000000066",
  connection: "a0000000-0000-4000-8000-000000000065",
  dataset: "80000000-0000-4000-8000-000000000065",
  uploadDataset: "80000000-0000-4000-8000-000000000066"
};

let db;
let migration;

async function inTenant(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE opengeo_runtime");
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

async function insertExactSource(datasetId = IDS.dataset, versionId = "version-0001") {
  return inTenant(IDS.organization, IDS.owner, () => db.query(
    `INSERT INTO app.repository_object_sources
      (organization_id, dataset_id, connection_id, connection_target_revision,
       provider, bucket_name, region_name, object_prefix, relative_path,
       provider_version_id, size_bytes, last_modified, content_type, etag,
       storage_class, provider_checksum_sha256, created_by)
     VALUES ($1, $2, $3, 1, 's3', 'example-geodata', 'us-east-1', 'usa/ma/',
             'environment/screen.geojson', $4, 4096, '2026-08-31T12:00:00Z',
             'application/geo+json', '"etag-0001"', 'STANDARD',
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', $5)
     RETURNING provider_version_id, connection_target_revision, relative_path`,
    [IDS.organization, datasetId, IDS.connection, versionId, IDS.owner]
  ));
}

describe("0065 exact repository object sources", () => {
  before(async () => {
    db = new PGlite();
    const load = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const foundation = await load("0001_platform_foundation.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; "
      + "CREATE ROLE opengeo_observable_coordinator;"
    );
    await db.exec(await load("0003_managed_ingestion_foundation.sql"));
    await db.exec(await load("0050_team_project_access.sql"));
    await db.exec(await load("0051_user_dataset_connections.sql"));
    await db.exec(await load("0052_user_dataset_connection_verification.sql"));
    await db.exec(
      "ALTER TYPE app.dataset_source_type ADD VALUE 'pmtiles'; "
      + "ALTER TYPE app.dataset_source_type ADD VALUE 'geojson'; "
      + "ALTER TYPE app.dataset_source_type ADD VALUE 'arcgis'; "
      + "ALTER TYPE app.dataset_source_type ADD VALUE 'wfs'; "
      + "ALTER TYPE app.dataset_format ADD VALUE 'arcgis'; "
      + "ALTER TYPE app.dataset_format ADD VALUE 'wfs';"
    );
    migration = await load("0065_exact_repository_object_sources.sql");
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'owner-65', 'owner@example.test', 'Owner'),
        ('${IDS.otherOwner}', 'other-owner-65', 'other@example.test', 'Other Owner');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${IDS.organization}', 'OpenGeo Development', 'opengeo-development-65', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other tenant', 'other-tenant-65', '${IDS.otherOwner}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherOwner}', 'admin', '${IDS.otherOwner}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${IDS.project}', '${IDS.organization}', 'MassGIS', '${IDS.owner}'),
        ('${IDS.otherProject}', '${IDS.otherOrganization}', 'Other project', '${IDS.otherOwner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role) VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner'),
        ('${IDS.otherOrganization}', '${IDS.otherProject}', '${IDS.otherOwner}', 'owner');
      INSERT INTO app.user_dataset_connections
        (id, organization_id, owner_user_id, provider, display_name, bucket_name,
         region_name, object_prefix, credential_mode, role_arn, status, last_verified_at)
      VALUES
        ('${IDS.connection}', '${IDS.organization}', '${IDS.owner}', 's3',
         'Geospatial data', 'example-geodata', 'us-east-1', 'usa/ma/', 'assume_role',
         'arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader',
         'verified', clock_timestamp());
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES
        ('${IDS.dataset}', '${IDS.organization}', 'MassGIS screen', 'public',
         'repository', 'geojson', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.uploadDataset}', '${IDS.organization}', 'Upload', 'internal',
         'upload', 'geojson', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}');
      INSERT INTO app.project_datasets
        (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}', '${IDS.owner}');
    `);
  });

  after(async () => {
    await db.close();
  });

  it("stores one exact immutable provider version without credentials", async () => {
    const result = await insertExactSource();
    assert.deepEqual(result.rows, [{
      provider_version_id: "version-0001",
      connection_target_revision: 1,
      relative_path: "environment/screen.geojson"
    }]);

    const visible = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT bucket_name, object_prefix, relative_path, provider_version_id,
              provider_checksum_sha256
       FROM app.repository_object_sources WHERE dataset_id = $1`,
      [IDS.dataset]
    ));
    assert.equal(visible.rows.length, 1);
    assert.equal(Object.hasOwn(visible.rows[0], "secret_arn"), false);
  });

  it("rejects a mutable null version and a non-repository dataset", async () => {
    await assert.rejects(insertExactSource(IDS.uploadDataset, "version-upload"), /repository dataset/);
    await assert.rejects(insertExactSource(IDS.dataset, "null"), /exact_version_required/);
  });

  it("prevents source mutation and deletion", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "UPDATE app.repository_object_sources SET etag = '\"changed\"' WHERE dataset_id = $1",
        [IDS.dataset]
      )),
      /permission denied/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "DELETE FROM app.repository_object_sources WHERE dataset_id = $1",
        [IDS.dataset]
      )),
      /permission denied/
    );
    await assert.rejects(
      db.query(
        "UPDATE app.repository_object_sources SET etag = '\"changed\"' WHERE dataset_id = $1",
        [IDS.dataset]
      ),
      /immutable/
    );
    await assert.rejects(
      db.query("DELETE FROM app.repository_object_sources WHERE dataset_id = $1", [IDS.dataset]),
      /immutable/
    );
  });

  it("retains the connection target snapshot when the reusable connection changes", async () => {
    await inTenant(IDS.organization, IDS.owner, () => db.query(
      "UPDATE app.user_dataset_connections SET object_prefix = 'usa/ma/revised/' WHERE id = $1",
      [IDS.connection]
    ));
    const result = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT connection_target_revision, object_prefix
       FROM app.repository_object_sources WHERE dataset_id = $1`,
      [IDS.dataset]
    ));
    assert.deepEqual(result.rows, [{connection_target_revision: 1, object_prefix: "usa/ma/"}]);
  });

  it("enforces tenant isolation and excludes execution roles", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherOwner, () => db.query(
      "SELECT dataset_id FROM app.repository_object_sources"
    ));
    assert.deepEqual(hidden.rows, []);

    for (const role of [
      "opengeo_worker",
      "opengeo_connector",
      "opengeo_observable_coordinator",
      "opengeo_dataset_verifier"
    ]) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(
        db.query("SELECT dataset_id FROM app.repository_object_sources"),
        /permission denied/
      );
      await db.exec("RESET ROLE");
    }
  });

  it("documents exact-version, snapshot, and insert-only semantics", () => {
    assert.match(migration, /exact non-null S3 VersionId/i);
    assert.match(migration, /Target facts are snapshotted without credentials/i);
    assert.match(migration, /BEFORE UPDATE OR DELETE/);
    assert.doesNotMatch(migration, /secret_arn/);
  });
});
