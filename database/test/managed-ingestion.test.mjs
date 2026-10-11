import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000001",
  organizationB: "10000000-0000-4000-8000-000000000002",
  userA: "20000000-0000-4000-8000-000000000001",
  userB: "20000000-0000-4000-8000-000000000002",
  projectA: "50000000-0000-4000-8000-000000000001",
  projectB: "50000000-0000-4000-8000-000000000002",
  datasetA: "80000000-0000-4000-8000-000000000001",
  uploadA: "81000000-0000-4000-8000-000000000001",
  objectA: "82000000-0000-4000-8000-000000000001",
  versionA: "83000000-0000-4000-8000-000000000001",
  jobA: "84000000-0000-4000-8000-000000000001",
  rollbackDataset: "80000000-0000-4000-8000-000000000002",
  rollbackUpload: "81000000-0000-4000-8000-000000000002",
  rollbackObject: "82000000-0000-4000-8000-000000000002",
  rollbackVersion: "83000000-0000-4000-8000-000000000002",
  rollbackJob: "84000000-0000-4000-8000-000000000002"
};

const SHA256 = "a".repeat(64);
let db;

async function inTenant(organizationId, userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [
      organizationId
    ]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function createUpload(datasetId, uploadId, suffix) {
  return inTenant(IDS.organizationA, IDS.userA, async () => {
    await db.query(
      `INSERT INTO app.datasets
         (id, organization_id, name, classification, format, owner_user_id,
          created_by, updated_by)
       VALUES ($1, $2, $3, 'restricted', 'geopackage', $4, $4, $4)`,
      [datasetId, IDS.organizationA, `Roads ${suffix}`, IDS.userA]
    );
    await db.query(
      `INSERT INTO app.project_datasets
         (organization_id, project_id, dataset_id, linked_by)
       VALUES ($1, $2, $3, $4)`,
      [IDS.organizationA, IDS.projectA, datasetId, IDS.userA]
    );
    return db.query(
      `INSERT INTO app.upload_intents
         (id, organization_id, project_id, dataset_id, created_by,
          original_filename, content_type, expected_size_bytes, expected_sha256,
          bucket, object_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'roads.gpkg',
               'application/geopackage+sqlite3', 1234, $6,
               'geodata-test', $7, '2099-01-01T00:00:00Z')`,
      [
        uploadId,
        IDS.organizationA,
        IDS.projectA,
        datasetId,
        IDS.userA,
        SHA256,
        `organizations/${IDS.organizationA}/uploads/${uploadId}/roads.gpkg`
      ]
    );
  });
}

async function completeUpload({
  datasetId,
  uploadId,
  objectId,
  versionId,
  jobId,
  requestId,
  eventType = "dataset.upload.completed"
}) {
  return inTenant(IDS.organizationA, IDS.userA, async () => {
    const intent = await db.query(
      `SELECT bucket, object_key, content_type, expected_size_bytes, expected_sha256
       FROM app.upload_intents
       WHERE organization_id = $1 AND project_id = $2 AND id = $3
       FOR UPDATE`,
      [IDS.organizationA, IDS.projectA, uploadId]
    );
    assert.equal(intent.rows.length, 1);
    const expected = intent.rows[0];
    await db.query(
      `INSERT INTO app.data_objects
         (id, organization_id, dataset_id, role, bucket, object_key,
          s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
       VALUES ($1, $2, $3, 'original', $4, $5, 's3-version-1', 'etag-1',
               $6, $7, $8, $9)`,
      [
        objectId,
        IDS.organizationA,
        datasetId,
        expected.bucket,
        expected.object_key,
        expected.content_type,
        expected.expected_size_bytes,
        expected.expected_sha256,
        IDS.userA
      ]
    );
    await db.query(
      `INSERT INTO app.dataset_versions
         (id, organization_id, dataset_id, version_number, original_object_id,
          state, change_message, created_by)
       VALUES ($1, $2, $3, 1, $4, 'queued', 'Initial upload', $5)`,
      [versionId, IDS.organizationA, datasetId, objectId, IDS.userA]
    );
    await db.query(
      `UPDATE app.datasets
       SET status = 'processing', current_version_id = $1, updated_by = $2
       WHERE organization_id = $3 AND id = $4`,
      [versionId, IDS.userA, IDS.organizationA, datasetId]
    );
    await db.query(
      `UPDATE app.upload_intents
       SET state = 'completed', completed_at = clock_timestamp(),
           completed_object_id = $1
       WHERE organization_id = $2 AND id = $3`,
      [objectId, IDS.organizationA, uploadId]
    );
    await db.query(
      `INSERT INTO app.processing_jobs
         (id, organization_id, project_id, dataset_id, dataset_version_id,
          job_type, parameters, created_by)
       VALUES ($1, $2, $3, $4, $5, 'dataset.ingest', $6, $7)`,
      [
        jobId,
        IDS.organizationA,
        IDS.projectA,
        datasetId,
        versionId,
        JSON.stringify({upload_id: uploadId}),
        IDS.userA
      ]
    );
    await db.query(
      `INSERT INTO app.activity_events
         (organization_id, actor_user_id, project_id, event_type,
          resource_type, resource_id, request_id)
       VALUES ($1, $2, $3, $4, 'dataset', $5, $6)`,
      [IDS.organizationA, IDS.userA, IDS.projectA, eventType, datasetId, requestId]
    );
  });
}

describe("0003 managed ingestion foundation migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(
        sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "")
      );
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.userA}', 'user-a', 'a@example.test', 'User A'),
        ('${IDS.userB}', 'user-b', 'b@example.test', 'User B');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Organization A', 'organization-a', '${IDS.userA}'),
        ('${IDS.organizationB}', 'Organization B', 'organization-b', '${IDS.userB}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.userA}', 'admin', '${IDS.userA}'),
        ('${IDS.organizationB}', '${IDS.userB}', 'admin', '${IDS.userB}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.projectA}', '${IDS.organizationA}', 'Project A', '${IDS.userA}'),
        ('${IDS.projectB}', '${IDS.organizationB}', 'Project B', '${IDS.userB}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("installs tenant-owned catalog, version, object, upload, tag, and job tables", async () => {
    const result = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'app'
        AND table_name IN (
          'datasets', 'project_datasets', 'tags', 'dataset_tags',
          'upload_intents', 'data_objects', 'dataset_versions', 'processing_jobs'
        )
      ORDER BY table_name
    `);
    assert.deepEqual(
      result.rows.map(({table_name}) => table_name),
      [
        "data_objects",
        "dataset_tags",
        "dataset_versions",
        "datasets",
        "processing_jobs",
        "project_datasets",
        "tags",
        "upload_intents"
      ]
    );
  });

  it("isolates catalog records and rejects cross-tenant project links", async () => {
    await createUpload(IDS.datasetA, IDS.uploadA, "A");
    const visible = await inTenant(IDS.organizationA, IDS.userA, () =>
      db.query("SELECT id FROM app.datasets")
    );
    const hidden = await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query("SELECT id FROM app.datasets")
    );
    assert.deepEqual(visible.rows, [{id: IDS.datasetA}]);
    assert.deepEqual(hidden.rows, []);

    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          `INSERT INTO app.project_datasets
             (organization_id, project_id, dataset_id, linked_by)
           VALUES ($1, $2, $3, $4)`,
          [IDS.organizationA, IDS.projectB, IDS.datasetA, IDS.userA]
        )
      ),
      /foreign key|row-level security/
    );
  });

  it("records one exact S3 version separately from logical dataset version one", async () => {
    await completeUpload({
      datasetId: IDS.datasetA,
      uploadId: IDS.uploadA,
      objectId: IDS.objectA,
      versionId: IDS.versionA,
      jobId: IDS.jobA,
      requestId: "request-complete"
    });
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      dataset: await db.query(
        "SELECT status::text, current_version_id FROM app.datasets WHERE id = $1",
        [IDS.datasetA]
      ),
      version: await db.query(
        `SELECT version_number, state::text, original_object_id
         FROM app.dataset_versions WHERE id = $1`,
        [IDS.versionA]
      ),
      object: await db.query(
        `SELECT s3_version_id, checksum_sha256
         FROM app.data_objects WHERE id = $1`,
        [IDS.objectA]
      ),
      job: await db.query(
        "SELECT state::text, job_type FROM app.processing_jobs WHERE id = $1",
        [IDS.jobA]
      ),
      activity: await db.query(
        "SELECT request_id FROM app.activity_events WHERE resource_id = $1",
        [IDS.datasetA]
      )
    }));
    assert.deepEqual(result.dataset.rows, [
      {status: "processing", current_version_id: IDS.versionA}
    ]);
    assert.deepEqual(result.version.rows, [
      {version_number: 1, state: "queued", original_object_id: IDS.objectA}
    ]);
    assert.deepEqual(result.object.rows, [
      {s3_version_id: "s3-version-1", checksum_sha256: SHA256}
    ]);
    assert.deepEqual(result.job.rows, [{state: "queued", job_type: "dataset.ingest"}]);
    assert.deepEqual(result.activity.rows, [{request_id: "request-complete"}]);
  });

  it("prevents replayed jobs and mutation/deletion of completed upload facts", async () => {
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          `INSERT INTO app.processing_jobs
             (organization_id, project_id, dataset_id, dataset_version_id,
              job_type, created_by)
           VALUES ($1, $2, $3, $4, 'dataset.ingest', $5)`,
          [
            IDS.organizationA,
            IDS.projectA,
            IDS.datasetA,
            IDS.versionA,
            IDS.userA
          ]
        )
      ),
      /unique|duplicate/
    );
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          "UPDATE app.upload_intents SET state = 'pending' WHERE id = $1",
          [IDS.uploadA]
        )
      ),
      /forward-only/
    );
    for (const table of ["upload_intents", "data_objects", "dataset_versions"]) {
      await assert.rejects(
        inTenant(IDS.organizationA, IDS.userA, () =>
          db.query(`DELETE FROM app.${table} WHERE organization_id = $1`, [
            IDS.organizationA
          ])
        ),
        /permission denied/
      );
    }
  });

  it("normalizes tags and keeps them tenant scoped", async () => {
    await inTenant(IDS.organizationA, IDS.userA, async () => {
      const tag = await db.query(
        `INSERT INTO app.tags (organization_id, name, created_by)
         VALUES ($1, 'transport', $2)
         RETURNING id`,
        [IDS.organizationA, IDS.userA]
      );
      await db.query(
        `INSERT INTO app.dataset_tags
           (organization_id, dataset_id, tag_id, tagged_by)
         VALUES ($1, $2, $3, $4)`,
        [IDS.organizationA, IDS.datasetA, tag.rows[0].id, IDS.userA]
      );
    });
    const hidden = await inTenant(IDS.organizationB, IDS.userB, () =>
      db.query("SELECT name FROM app.tags")
    );
    assert.deepEqual(hidden.rows, []);
    await assert.rejects(
      inTenant(IDS.organizationA, IDS.userA, () =>
        db.query(
          "INSERT INTO app.tags (organization_id, name, created_by) VALUES ($1, 'Not Normal', $2)",
          [IDS.organizationA, IDS.userA]
        )
      ),
      /tags_normalized|check constraint/
    );
  });

  it("rolls the entire completion back when activity attribution fails", async () => {
    await createUpload(IDS.rollbackDataset, IDS.rollbackUpload, "rollback");
    await assert.rejects(
      completeUpload({
        datasetId: IDS.rollbackDataset,
        uploadId: IDS.rollbackUpload,
        objectId: IDS.rollbackObject,
        versionId: IDS.rollbackVersion,
        jobId: IDS.rollbackJob,
        requestId: "request-rollback",
        eventType: "INVALID EVENT"
      }),
      /activity_event_type_format|request_id|violates check constraint/
    );
    const result = await inTenant(IDS.organizationA, IDS.userA, async () => ({
      dataset: await db.query(
        "SELECT status::text, current_version_id FROM app.datasets WHERE id = $1",
        [IDS.rollbackDataset]
      ),
      upload: await db.query(
        "SELECT state::text, completed_object_id FROM app.upload_intents WHERE id = $1",
        [IDS.rollbackUpload]
      ),
      objects: await db.query(
        "SELECT id FROM app.data_objects WHERE dataset_id = $1",
        [IDS.rollbackDataset]
      ),
      versions: await db.query(
        "SELECT id FROM app.dataset_versions WHERE dataset_id = $1",
        [IDS.rollbackDataset]
      ),
      jobs: await db.query(
        "SELECT id FROM app.processing_jobs WHERE dataset_id = $1",
        [IDS.rollbackDataset]
      )
    }));
    assert.deepEqual(result.dataset.rows, [{status: "draft", current_version_id: null}]);
    assert.deepEqual(result.upload.rows, [{state: "pending", completed_object_id: null}]);
    assert.deepEqual(result.objects.rows, []);
    assert.deepEqual(result.versions.rows, []);
    assert.deepEqual(result.jobs.rows, []);
  });
});
