import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  project: "50000000-0000-4000-8000-000000000001",
  datasetSuccess: "80000000-0000-4000-8000-000000000001",
  datasetFailure: "80000000-0000-4000-8000-000000000002",
  datasetRetry: "80000000-0000-4000-8000-000000000003",
  datasetKml: "80000000-0000-4000-8000-000000000005",
  datasetInvalid: "80000000-0000-4000-8000-000000000004",
  tokenA: "a0000000-0000-4000-8000-000000000001",
  tokenB: "a0000000-0000-4000-8000-000000000002",
  artifact: "b0000000-0000-4000-8000-000000000001"
};

const SHA256 = "a".repeat(64);
let db;

function idsFor(datasetId) {
  const suffix = datasetId.at(-1);
  return {
    upload: `81000000-0000-4000-8000-00000000000${suffix}`,
    object: `82000000-0000-4000-8000-00000000000${suffix}`,
    version: `83000000-0000-4000-8000-00000000000${suffix}`,
    job: `84000000-0000-4000-8000-00000000000${suffix}`,
    key: `organizations/${IDS.organization}/projects/${IDS.project}/datasets/${datasetId}/uploads/81000000-0000-4000-8000-00000000000${suffix}/original/${datasetId === IDS.datasetKml ? "survey.kml" : "roads.geojson"}`
  };
}

async function claim(datasetId, token = IDS.tokenA) {
  const ids = idsFor(datasetId);
  return db.query(
    `SELECT * FROM app.claim_dataset_ingest($1, $2, 's3-version-1', $3, 900)`,
    ["geodata-test", ids.key, token]
  );
}

describe("0004 worker execution boundary migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0128_kml_source_ingestion.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.user}', 'worker-user', 'worker@example.test', 'Worker User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'Worker Organization', 'worker-organization', '${IDS.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Worker Project', '${IDS.user}');
    `);

    for (const datasetId of [
      IDS.datasetSuccess,
      IDS.datasetFailure,
      IDS.datasetRetry,
      IDS.datasetInvalid,
      IDS.datasetKml
    ]) {
      const ids = idsFor(datasetId);
      const format = datasetId === IDS.datasetKml ? "kml" : "geojson";
      const mime = format === "kml" ? "application/vnd.google-earth.kml+xml" : "application/geo+json";
      const filename = format === "kml" ? "survey.kml" : "roads.geojson";
      await db.query(
        `INSERT INTO app.datasets
           (id, organization_id, name, classification, format, status,
            owner_user_id, current_version_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'internal', '${format}', 'processing', $4, NULL, $4, $4)`,
        [datasetId, IDS.organization, `Dataset ${datasetId.at(-1)}`, IDS.user]
      );
      await db.query(
        `INSERT INTO app.project_datasets
           (organization_id, project_id, dataset_id, linked_by)
         VALUES ($1, $2, $3, $4)`,
        [IDS.organization, IDS.project, datasetId, IDS.user]
      );
      await db.query(
        `INSERT INTO app.upload_intents
           (id, organization_id, project_id, dataset_id, created_by,
            original_filename, content_type, expected_size_bytes, expected_sha256,
            bucket, object_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, '${filename}', '${mime}',
                 1234, $6, 'geodata-test', $7, '2099-01-01T00:00:00Z')`,
        [ids.upload, IDS.organization, IDS.project, datasetId, IDS.user, SHA256, ids.key]
      );
      await db.query(
        `INSERT INTO app.data_objects
           (id, organization_id, dataset_id, role, bucket, object_key,
            s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
         VALUES ($1, $2, $3, 'original', 'geodata-test', $4, 's3-version-1',
                 'etag-1', '${mime}', 1234, $5, $6)`,
        [ids.object, IDS.organization, datasetId, ids.key, SHA256, IDS.user]
      );
      await db.query(
        `UPDATE app.upload_intents
         SET state = 'completed', completed_at = clock_timestamp(), completed_object_id = $1
         WHERE id = $2`,
        [ids.object, ids.upload]
      );
      await db.query(
        `INSERT INTO app.dataset_versions
           (id, organization_id, dataset_id, version_number, original_object_id,
            state, change_message, created_by)
         VALUES ($1, $2, $3, 1, $4, 'queued', 'Initial upload', $5)`,
        [ids.version, IDS.organization, datasetId, ids.object, IDS.user]
      );
      await db.query(
        `UPDATE app.datasets SET current_version_id = $1 WHERE id = $2`,
        [ids.version, datasetId]
      );
      await db.query(
        `INSERT INTO app.processing_jobs
           (id, organization_id, project_id, dataset_id, dataset_version_id,
            job_type, parameters, created_by)
         VALUES ($1, $2, $3, $4, $5, 'dataset.ingest', '{}', $6)`,
        [ids.job, IDS.organization, IDS.project, datasetId, ids.version, IDS.user]
      );
    }
    await db.exec("SET ROLE opengeo_worker");
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("grants the worker only its fixed functions and no tenant tables", async () => {
    const tableAccess = await db.query(`
      SELECT
        has_table_privilege('opengeo_worker', 'app.datasets', 'SELECT') AS datasets,
        has_table_privilege('opengeo_worker', 'app.processing_jobs', 'UPDATE') AS jobs,
        has_table_privilege('opengeo_runtime', 'app.processing_jobs', 'UPDATE') AS runtime_jobs
    `);
    assert.deepEqual(tableAccess.rows, [{datasets: false, jobs: false, runtime_jobs: false}]);
    await assert.rejects(
      db.query("SELECT * FROM app.processing_jobs"),
      /permission denied/
    );
    const functionAccess = await db.query(`
      SELECT has_function_privilege(
        'opengeo_worker',
        'app.claim_dataset_ingest(text,text,text,uuid,integer)',
        'EXECUTE'
      ) AS claim
    `);
    assert.deepEqual(functionAccess.rows, [{claim: true}]);
  });

  it("claims only the exact completed S3 version and leases it once", async () => {
    const ids = idsFor(IDS.datasetSuccess);
    const wrong = await db.query(
      `SELECT claim_status FROM app.claim_dataset_ingest(
         'geodata-test', $1, 'wrong-version', $2, 900
       )`,
      [ids.key, IDS.tokenA]
    );
    assert.deepEqual(wrong.rows, [{claim_status: "not_ready"}]);

    const claimed = await claim(IDS.datasetSuccess);
    assert.equal(claimed.rows[0].claim_status, "claimed");
    assert.equal(claimed.rows[0].job_id, ids.job);
    assert.equal(claimed.rows[0].attempt_count, 1);
    assert.equal(claimed.rows[0].checksum_sha256, SHA256);
    assert.equal(
      claimed.rows[0].output_prefix,
      `organizations/${IDS.organization}/projects/${IDS.project}/datasets/${IDS.datasetSuccess}/versions/${ids.version}/derivatives/`
    );

    const busy = await claim(IDS.datasetSuccess, IDS.tokenB);
    assert.equal(busy.rows[0].claim_status, "busy");
    assert.deepEqual(
      (await db.query(
        "SELECT app.heartbeat_dataset_ingest($1, $2, 900) AS heartbeat",
        [ids.job, IDS.tokenB]
      )).rows,
      [{heartbeat: false}]
    );
    assert.deepEqual(
      (await db.query(
        "SELECT app.heartbeat_dataset_ingest($1, $2, 900) AS heartbeat",
        [ids.job, IDS.tokenA]
      )).rows,
      [{heartbeat: true}]
    );
  });

  it("atomically records bounded derivatives and activates the logical version", async () => {
    const ids = idsFor(IDS.datasetSuccess);
    const artifactKey = `${(
      await claim(IDS.datasetSuccess)
    ).rows[0].output_prefix}preview.geojson`;
    const metadata = {
      feature_count: 6,
      extent: [85.21, 27.58, 85.43, 27.76],
      crs: "EPSG:4326",
      geometry_type: "LineString",
      schema_definition: {layers: [{name: "roads"}]},
      quality_results: {valid: true, warnings: []}
    };
    const artifacts = [{
      id: IDS.artifact,
      role: "derived",
      bucket: "geodata-test",
      object_key: artifactKey,
      s3_version_id: "derived-version-1",
      etag: "derived-etag",
      content_type: "application/geo+json",
      size_bytes: 321,
      checksum_sha256: "b".repeat(64)
    }];

    const completed = await db.query(
      "SELECT app.complete_dataset_ingest($1, $2, $3, $4) AS completed",
      [ids.job, IDS.tokenA, JSON.stringify(metadata), JSON.stringify(artifacts)]
    );
    assert.deepEqual(completed.rows, [{completed: true}]);

    const replay = await claim(IDS.datasetSuccess, IDS.tokenB);
    assert.equal(replay.rows[0].claim_status, "already_completed");

    await db.exec("RESET ROLE");
    const state = await db.query(
      `SELECT dataset.status::text AS dataset_state,
              version.state::text AS version_state,
              version.feature_count,
              job.state::text AS job_state,
              job.worker_token,
              (SELECT count(*)::integer FROM app.data_objects object
               WHERE object.dataset_id = dataset.id AND object.role = 'derived') AS derivatives,
              (SELECT count(*)::integer FROM app.activity_events event
               WHERE event.resource_id = dataset.id
                 AND event.event_type = 'dataset.ingest.completed') AS activities
       FROM app.datasets dataset
       JOIN app.dataset_versions version ON version.id = dataset.current_version_id
       JOIN app.processing_jobs job ON job.dataset_version_id = version.id
       WHERE dataset.id = $1`,
      [IDS.datasetSuccess]
    );
    assert.deepEqual(state.rows, [{
      dataset_state: "active",
      version_state: "active",
      feature_count: 6,
      job_state: "completed",
      worker_token: null,
      derivatives: 1,
      activities: 1
    }]);
    await db.exec("SET ROLE opengeo_worker");
  });

  it("rejects derivative paths outside the exact version prefix without partial writes", async () => {
    const ids = idsFor(IDS.datasetInvalid);
    await claim(IDS.datasetInvalid);
    const invalidArtifact = [{
      id: "b0000000-0000-4000-8000-000000000004",
      role: "derived",
      bucket: "geodata-test",
      object_key: `organizations/${IDS.organization}/other-tenant/preview.geojson`,
      s3_version_id: "derived-version-4",
      etag: "etag-4",
      content_type: "application/geo+json",
      size_bytes: 12,
      checksum_sha256: "c".repeat(64)
    }];
    await assert.rejects(
      db.query(
        "SELECT app.complete_dataset_ingest($1, $2, $3, $4)",
        [
          ids.job,
          IDS.tokenA,
          JSON.stringify({schema_definition: {}, quality_results: {}}),
          JSON.stringify(invalidArtifact)
        ]
      ),
      /invalid ingestion artifact/
    );

    await db.exec("RESET ROLE");
    const state = await db.query(
      `SELECT state::text, worker_token,
              (SELECT count(*)::integer FROM app.data_objects WHERE dataset_id = $2) AS objects
       FROM app.processing_jobs WHERE id = $1`,
      [ids.job, IDS.datasetInvalid]
    );
    assert.deepEqual(state.rows, [{state: "running", worker_token: IDS.tokenA, objects: 1}]);
    await db.exec("SET ROLE opengeo_worker");
  });

  it("records deterministic validation failure without exposing storage facts", async () => {
    const ids = idsFor(IDS.datasetFailure);
    await claim(IDS.datasetFailure);
    const failed = await db.query(
      "SELECT app.fail_dataset_ingest($1, $2, 'archive_path_traversal', $3) AS failed",
      [ids.job, IDS.tokenA, JSON.stringify({valid: false, errors: [{code: "archive_path_traversal"}]})]
    );
    assert.deepEqual(failed.rows, [{failed: true}]);

    await db.exec("RESET ROLE");
    const state = await db.query(
      `SELECT dataset.status::text AS dataset_state,
              version.state::text AS version_state,
              job.state::text AS job_state,
              job.error_code,
              event.payload
       FROM app.datasets dataset
       JOIN app.dataset_versions version ON version.id = dataset.current_version_id
       JOIN app.processing_jobs job ON job.dataset_version_id = version.id
       JOIN app.activity_events event ON event.resource_id = dataset.id
        AND event.event_type = 'dataset.ingest.failed'
       WHERE dataset.id = $1`,
      [IDS.datasetFailure]
    );
    assert.equal(state.rows[0].dataset_state, "failed");
    assert.equal(state.rows[0].version_state, "failed");
    assert.equal(state.rows[0].job_state, "failed");
    assert.equal(state.rows[0].error_code, "archive_path_traversal");
    assert.deepEqual(Object.keys(state.rows[0].payload).sort(), [
      "dataset_version_id",
      "error_code",
      "processing_job_id"
    ]);
    await db.exec("SET ROLE opengeo_worker");
  });

  it("requeues transient failures and terminates at the bounded attempt count", async () => {
    const ids = idsFor(IDS.datasetRetry);
    await claim(IDS.datasetRetry);
    const first = await db.query(
      "SELECT app.release_dataset_ingest($1, $2, 's3_temporarily_unavailable', 2) AS state",
      [ids.job, IDS.tokenA]
    );
    assert.deepEqual(first.rows, [{state: "queued"}]);

    await claim(IDS.datasetRetry, IDS.tokenB);
    const second = await db.query(
      "SELECT app.release_dataset_ingest($1, $2, 's3_temporarily_unavailable', 2) AS state",
      [ids.job, IDS.tokenB]
    );
    assert.deepEqual(second.rows, [{state: "failed"}]);

    await db.exec("RESET ROLE");
    const state = await db.query(
      "SELECT state::text, attempt_count, error_code FROM app.processing_jobs WHERE id = $1",
      [ids.job]
    );
    assert.deepEqual(state.rows, [{
      state: "failed",
      attempt_count: 2,
      error_code: "processing_retry_exhausted"
    }]);
    await db.exec("SET ROLE opengeo_worker");
  });
  it("activates KML with a report artifact while preserving unknown geometry and original identity", async () => {
    const ids = idsFor(IDS.datasetKml);
    const claimed = (await claim(IDS.datasetKml)).rows[0];
    assert.equal(claimed.claim_status, "claimed");
    const metadata = {feature_count:null, extent:null, crs:null, geometry_type:null,
      schema_definition:{fields:[],kml_source:{inspection_method:"bounded_xml_structure",links_resolved:false,source_sha256:SHA256}},
      quality_results:{kml_inspection:{status:"structure_only",rendering_status:"not_established"}}};
    const artifacts = [{id:"b0000000-0000-4000-8000-000000000005",role:"derived",bucket:"geodata-test",
      object_key:`${claimed.output_prefix}kml-source-inspection.json`,s3_version_id:"report-1",etag:"report-etag",
      content_type:"application/json",size_bytes:512,checksum_sha256:"c".repeat(64)}];
    assert.deepEqual((await db.query("SELECT app.complete_dataset_ingest($1,$2,$3,$4) AS completed",
      [ids.job,IDS.tokenB,JSON.stringify(metadata),JSON.stringify(artifacts)])).rows,[{completed:false}]);
    assert.deepEqual((await db.query("SELECT app.complete_dataset_ingest($1,$2,$3,$4) AS completed",
      [ids.job,IDS.tokenA,JSON.stringify(metadata),JSON.stringify(artifacts)])).rows,[{completed:true}]);
    await db.exec("RESET ROLE");
    const result = await db.query(`SELECT d.format::text,d.status::text,v.feature_count,v.extent,v.crs,
      v.original_object_id,o.checksum_sha256,o.content_type FROM app.datasets d
      JOIN app.dataset_versions v ON v.id=d.current_version_id
      JOIN app.data_objects o ON o.id=v.original_object_id WHERE d.id=$1`,[IDS.datasetKml]);
    assert.deepEqual(result.rows,[{format:"kml",status:"active",feature_count:null,extent:null,crs:null,
      original_object_id:ids.object,checksum_sha256:SHA256,content_type:"application/vnd.google-earth.kml+xml"}]);
    await db.exec("SET ROLE opengeo_worker");
    assert.equal((await claim(IDS.datasetKml)).rows[0].claim_status,"already_completed");
  });

});
