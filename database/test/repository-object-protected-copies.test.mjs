import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000066",
  otherOrganization: "10000000-0000-4000-8000-000000000067",
  owner: "20000000-0000-4000-8000-000000000066",
  otherOwner: "20000000-0000-4000-8000-000000000067",
  project: "50000000-0000-4000-8000-000000000066",
  connection: "a0000000-0000-4000-8000-000000000066",
  sourceDataset: "80000000-0000-4000-8000-000000000066",
  destinationDataset: "81000000-0000-4000-8000-000000000066",
  estimate: "90000000-0000-4000-8000-000000000066",
  job: "91000000-0000-4000-8000-000000000066",
  worker: "92000000-0000-4000-8000-000000000066",
  object: "93000000-0000-4000-8000-000000000066",
  idempotency: "94000000-0000-4000-8000-000000000066"
};
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SOURCE_KEY = "usa/ma/environment/screen.geojson";
const OUTPUT_KEY =
  `organizations/${IDS.organization}/projects/${IDS.project}/` +
  `datasets/${IDS.destinationDataset}/uploads/${IDS.job}/original/source.geojson`;

let db;
let migration;

async function load(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

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

async function asCopier(operation) {
  await db.exec("SET ROLE opengeo_repository_copier");
  try {
    return await operation();
  } finally {
    await db.exec("RESET ROLE");
  }
}

describe("0066 exact repository object protected copies", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await load("0001_platform_foundation.sql");
    await db.exec(foundation.replace(
      /^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm,
      ""
    ));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; " +
      "CREATE ROLE opengeo_observable_coordinator; CREATE ROLE opengeo_source_archiver;"
    );
    await db.exec(await load("0003_managed_ingestion_foundation.sql"));
    await db.exec(await load("0004_worker_execution_boundary.sql"));
    await db.exec(await load("0050_team_project_access.sql"));
    await db.exec(await load("0051_user_dataset_connections.sql"));
    await db.exec(await load("0052_user_dataset_connection_verification.sql"));
    await db.exec(await load("0054_reusable_project_datasets.sql"));
    await db.exec(await load("0055_project_dataset_detach_lock.sql"));
    await db.exec(
      "ALTER TYPE app.dataset_format ADD VALUE 'png'; " +
      "ALTER TYPE app.dataset_format ADD VALUE 'jpeg'; " +
      "ALTER TYPE app.dataset_format ADD VALUE 'pdf'; " +
      "ALTER TYPE app.dataset_format ADD VALUE 'odt'; " +
      "ALTER TYPE app.dataset_format ADD VALUE 'arcgis'; " +
      "ALTER TYPE app.dataset_format ADD VALUE 'wfs'; " +
      "ALTER TYPE app.dataset_source_type ADD VALUE 'pmtiles'; " +
      "ALTER TYPE app.dataset_source_type ADD VALUE 'geojson'; " +
      "ALTER TYPE app.dataset_source_type ADD VALUE 'arcgis'; " +
      "ALTER TYPE app.dataset_source_type ADD VALUE 'wfs';"
    );
    await db.exec(await load("0065_exact_repository_object_sources.sql"));
    migration = await load("0066_repository_object_protected_copies.sql");
    await db.exec(migration);

    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'copy-owner', 'owner@example.test', 'Owner'),
        ('${IDS.otherOwner}', 'copy-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${IDS.organization}', 'Repository copies', 'repository-copies', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other', 'repository-copies-other', '${IDS.otherOwner}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherOwner}', 'admin', '${IDS.otherOwner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'MassGIS', '${IDS.owner}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner');
      INSERT INTO app.user_dataset_connections
        (id, organization_id, owner_user_id, provider, display_name,
         bucket_name, region_name, object_prefix, credential_mode, role_arn,
         secret_arn, configured_secret_fields, credential_revision,
         status, last_verified_at)
      VALUES
        ('${IDS.connection}', '${IDS.organization}', '${IDS.owner}', 's3',
         'Geospatial data', 'example-geodata', 'us-east-1', 'usa/ma/',
         'assume_role',
         'arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader',
         'arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/exact-copy',
         ARRAY['external_id'], 1, 'verified', clock_timestamp());
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES
        ('${IDS.sourceDataset}', '${IDS.organization}', 'MassGIS screen', 'public',
         'repository', 'geojson', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.destinationDataset}', '${IDS.organization}', 'Protected MassGIS screen',
         'internal', 'upload', 'geojson', 'draft', '${IDS.owner}', '${IDS.owner}',
         '${IDS.owner}');
      INSERT INTO app.project_datasets
        (organization_id, project_id, dataset_id, linked_by)
      VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.sourceDataset}', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.destinationDataset}', '${IDS.owner}');
    `);

    await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.repository_object_sources
          (organization_id, dataset_id, connection_id, connection_target_revision,
           provider, bucket_name, region_name, object_prefix, relative_path,
           provider_version_id, size_bytes, last_modified, content_type, etag,
           storage_class, provider_checksum_sha256, created_by)
         VALUES ($1, $2, $3, 1, 's3', 'example-geodata', 'us-east-1', 'usa/ma/',
                 'environment/screen.geojson', 'provider-version-7', 4096,
                 '2026-08-31T12:00:00Z', 'application/geo+json', '"etag-0007"',
                 'STANDARD', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', $4)`,
        [IDS.organization, IDS.sourceDataset, IDS.connection, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.repository_object_copy_estimates
          (id, organization_id, project_id, source_dataset_id, output_format,
           output_content_type, maximum_requests, maximum_output_bytes,
           estimated_cost_usd, estimate_checksum_sha256, created_by, expires_at)
         VALUES ($1, $2, $3, $4, 'geojson', 'application/geo+json', 1, 4096,
                 0.000006, $5, $6, clock_timestamp() + interval '30 minutes')`,
        [IDS.estimate, IDS.organization, IDS.project, IDS.sourceDataset, SHA_A, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.repository_object_copy_jobs
          (id, organization_id, project_id, estimate_id, source_dataset_id,
           destination_dataset_id, destination_bucket, rights_basis, attribution,
           request_checksum_sha256, idempotency_key, request_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'opengeo-geodata-test',
                 'Agency open-data terms permit archival copy', 'Example agency',
                 $7, $8, 'request-copy-66', $9)`,
        [
          IDS.job, IDS.organization, IDS.project, IDS.estimate, IDS.sourceDataset,
          IDS.destinationDataset, SHA_B, IDS.idempotency, IDS.owner
        ]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("keeps request rows tenant-scoped and gives the copier function-only access", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherOwner, () => db.query(
      "SELECT id FROM app.repository_object_copy_jobs"
    ));
    assert.deepEqual(hidden.rows, []);

    const grants = await db.query(`
      SELECT
        has_table_privilege('opengeo_repository_copier',
          'app.repository_object_copy_jobs', 'SELECT') AS table_read,
        has_function_privilege('opengeo_repository_copier',
          'app.claim_repository_object_copy(uuid,uuid,integer)', 'EXECUTE') AS claim,
        has_function_privilege('opengeo_source_archiver',
          'app.claim_repository_object_copy(uuid,uuid,integer)', 'EXECUTE') AS archiver_claim,
        has_function_privilege('opengeo_worker',
          'app.claim_repository_object_copy(uuid,uuid,integer)', 'EXECUTE') AS worker_claim
    `);
    assert.deepEqual(grants.rows, [{
      table_read: false,
      claim: true,
      archiver_claim: false,
      worker_claim: false
    }]);
  });

  it("claims current credentials only for active exact-version work", async () => {
    const claimed = await asCopier(() => db.query(
      "SELECT * FROM app.claim_repository_object_copy($1, $2, 900)",
      [IDS.job, IDS.worker]
    ));
    assert.equal(claimed.rows[0].claim_status, "claimed");
    assert.equal(claimed.rows[0].source_object_key, SOURCE_KEY);
    assert.equal(claimed.rows[0].source_version_id, "provider-version-7");
    assert.match(claimed.rows[0].secret_arn, /opengeo\/test\/exact-copy/);
    assert.equal(claimed.rows[0].output_object_key, OUTPUT_KEY);

    const busy = await asCopier(() => db.query(
      "SELECT * FROM app.claim_repository_object_copy($1, $2, 900)",
      [IDS.job, "92000000-0000-4000-8000-000000000067"]
    ));
    assert.equal(busy.rows[0].claim_status, "busy");
    assert.equal(busy.rows[0].secret_arn, null);
    assert.equal(busy.rows[0].source_bucket, null);
  });

  it("atomically records immutable lineage and starts ordinary ingestion", async () => {
    const completed = await asCopier(() => db.query(
      "SELECT app.complete_repository_object_copy($1, $2, $3)",
      [
        IDS.job,
        IDS.worker,
        JSON.stringify({
          id: IDS.object,
          role: "original",
          bucket: "opengeo-geodata-test",
          object_key: OUTPUT_KEY,
          s3_version_id: "archive-version-1",
          etag: "0123456789abcdef",
          content_type: "application/geo+json",
          size_bytes: 4096,
          checksum_sha256: SHA_A
        })
      ]
    ));
    assert.equal(completed.rows[0].complete_repository_object_copy, true);

    const result = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT job.state, dataset.status, version.state AS version_state,
              processing.state AS processing_state, lineage.source_dataset_id,
              object.s3_version_id
       FROM app.repository_object_copy_jobs job
       JOIN app.datasets dataset ON dataset.id = job.destination_dataset_id
       JOIN app.dataset_versions version ON version.id = job.output_dataset_version_id
       JOIN app.processing_jobs processing
         ON processing.dataset_version_id = version.id
       JOIN app.dataset_version_repository_object_lineage lineage
         ON lineage.copy_job_id = job.id
       JOIN app.data_objects object ON object.id = job.output_object_id
       WHERE job.id = $1`,
      [IDS.job]
    ));
    assert.deepEqual(result.rows, [{
      state: "completed",
      status: "processing",
      version_state: "queued",
      processing_state: "queued",
      source_dataset_id: IDS.sourceDataset,
      s3_version_id: "archive-version-1"
    }]);

    const replay = await asCopier(() => db.query(
      "SELECT * FROM app.get_completed_repository_object_copy_artifact($1)",
      [IDS.job]
    ));
    assert.equal(replay.rows[0].object_key, OUTPUT_KEY);
    assert.equal(replay.rows[0].checksum_sha256, SHA_A);
  });

  it("makes the sealed request, estimate, terminal state, and lineage immutable", async () => {
    await assert.rejects(
      db.query(
        "UPDATE app.repository_object_copy_estimates SET maximum_output_bytes = 1 WHERE id = $1",
        [IDS.estimate]
      ),
      /immutable/
    );
    await assert.rejects(
      db.query(
        "UPDATE app.repository_object_copy_jobs SET attribution = 'Changed' WHERE id = $1",
        [IDS.job]
      ),
      /request seal is immutable|terminal state is immutable/
    );
    await assert.rejects(
      db.query(
        "DELETE FROM app.dataset_version_repository_object_lineage WHERE copy_job_id = $1",
        [IDS.job]
      ),
      /lineage is immutable/
    );
  });

  it("documents exact-version custody and credential isolation", () => {
    assert.match(migration, /separately reviewed custody path/i);
    assert.match(migration, /only the credential-isolated copier/i);
    assert.match(migration, /source authority only after current connection/i);
  });
});
