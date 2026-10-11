import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000059",
  otherOrganization: "10000000-0000-4000-8000-000000000159",
  user: "20000000-0000-4000-8000-000000000059",
  otherUser: "20000000-0000-4000-8000-000000000159",
  project: "50000000-0000-4000-8000-000000000059",
  otherProject: "50000000-0000-4000-8000-000000000159",
  dataset: "80000000-0000-4000-8000-000000000059",
  source: "81000000-0000-4000-8000-000000000059",
  coverageJob: "71000000-0000-4000-8000-000000000059",
  pmtilesJob: "93000000-0000-4000-8000-000000000059",
  coverageOutput: "81100000-0000-4000-8000-000000000059",
  pmtilesOutput: "81200000-0000-4000-8000-000000000059",
  coverage: "70000000-0000-4000-8000-000000000059",
  workerToken: "91000000-0000-4000-8000-000000000059"
};

const SHA_SOURCE = "a".repeat(64);
const SHA_COVERAGE = "b".repeat(64);
const SHA_PMTILES = "c".repeat(64);

let db;

async function migration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function tenant(organizationId, userId, operation) {
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

async function asRole(role, operation) {
  await db.exec(`RESET ROLE; SET ROLE ${role}`);
  try {
    return await operation();
  } finally {
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  }
}

describe("0059 immutable processing execution receipts", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql"
    ]) {
      const sql = await migration(file);
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      CREATE TABLE app.spatial_service_coverages (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        data_object_id uuid NOT NULL,
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, data_object_id)
          REFERENCES app.data_objects (organization_id, id)
      );
      CREATE TABLE app.spatial_coverage_derivative_jobs (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        project_id uuid NOT NULL,
        coverage_id uuid NOT NULL,
        dataset_id uuid NOT NULL,
        request_checksum_sha256 text NOT NULL,
        state app.processing_job_state NOT NULL DEFAULT 'queued',
        output_object_id uuid,
        output_checksum_sha256 text,
        worker_token uuid,
        created_by uuid NOT NULL REFERENCES app.users(id),
        finished_at timestamptz,
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, project_id)
          REFERENCES app.projects (organization_id, id),
        FOREIGN KEY (organization_id, coverage_id)
          REFERENCES app.spatial_service_coverages (organization_id, id),
        FOREIGN KEY (organization_id, output_object_id)
          REFERENCES app.data_objects (organization_id, id)
      );
      CREATE TABLE app.pmtiles_derivative_jobs (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        project_id uuid NOT NULL,
        dataset_id uuid NOT NULL,
        source_object_id uuid NOT NULL,
        request_checksum_sha256 text NOT NULL,
        state app.processing_job_state NOT NULL DEFAULT 'queued',
        output_object_id uuid,
        output_checksum_sha256 text,
        worker_token uuid,
        created_by uuid NOT NULL REFERENCES app.users(id),
        finished_at timestamptz,
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, project_id)
          REFERENCES app.projects (organization_id, id),
        FOREIGN KEY (organization_id, source_object_id)
          REFERENCES app.data_objects (organization_id, id),
        FOREIGN KEY (organization_id, output_object_id)
          REFERENCES app.data_objects (organization_id, id)
      );
      CREATE FUNCTION app.complete_spatial_coverage_derivative(
        p_job_id uuid, p_worker_token uuid, p_artifact jsonb, p_metadata jsonb
      ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, app SET row_security = off AS $$
      DECLARE v_job app.spatial_coverage_derivative_jobs%ROWTYPE;
      BEGIN
        SELECT * INTO v_job FROM app.spatial_coverage_derivative_jobs
        WHERE id = p_job_id AND state = 'running'
          AND worker_token = p_worker_token FOR UPDATE;
        IF NOT FOUND OR p_metadata IS NULL THEN RETURN false; END IF;
        INSERT INTO app.data_objects
          (id, organization_id, dataset_id, role, bucket, object_key,
           s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
        VALUES
          ((p_artifact->>'id')::uuid, v_job.organization_id, v_job.dataset_id,
           'derived', p_artifact->>'bucket', p_artifact->>'object_key',
           p_artifact->>'s3_version_id', p_artifact->>'etag',
           p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
           p_artifact->>'checksum_sha256', v_job.created_by);
        UPDATE app.spatial_coverage_derivative_jobs
        SET state = 'completed', output_object_id = (p_artifact->>'id')::uuid,
            output_checksum_sha256 = p_artifact->>'checksum_sha256',
            worker_token = NULL, finished_at = clock_timestamp()
        WHERE id = p_job_id;
        RETURN true;
      END $$;
      CREATE FUNCTION app.complete_pmtiles_derivative(
        p_job_id uuid, p_worker_token uuid, p_artifact jsonb
      ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, app SET row_security = off AS $$
      DECLARE v_job app.pmtiles_derivative_jobs%ROWTYPE;
      BEGIN
        SELECT * INTO v_job FROM app.pmtiles_derivative_jobs
        WHERE id = p_job_id AND state = 'running'
          AND worker_token = p_worker_token FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        INSERT INTO app.data_objects
          (id, organization_id, dataset_id, role, bucket, object_key,
           s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
        VALUES
          ((p_artifact->>'id')::uuid, v_job.organization_id, v_job.dataset_id,
           'tile', p_artifact->>'bucket', p_artifact->>'object_key',
           p_artifact->>'s3_version_id', p_artifact->>'etag',
           p_artifact->>'content_type', (p_artifact->>'size_bytes')::bigint,
           p_artifact->>'checksum_sha256', v_job.created_by);
        UPDATE app.pmtiles_derivative_jobs
        SET state = 'completed', output_object_id = (p_artifact->>'id')::uuid,
            output_checksum_sha256 = p_artifact->>'checksum_sha256',
            worker_token = NULL, finished_at = clock_timestamp()
        WHERE id = p_job_id;
        RETURN true;
      END $$;
      GRANT EXECUTE ON FUNCTION
        app.complete_spatial_coverage_derivative(uuid,uuid,jsonb,jsonb),
        app.complete_pmtiles_derivative(uuid,uuid,jsonb) TO opengeo_worker;
    `);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${ID.user}', 'receipt-user', 'user@example.test', 'User'),
        ('${ID.otherUser}', 'receipt-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${ID.organization}', 'Receipts', 'receipts', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'receipts-other', '${ID.otherUser}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${ID.project}', '${ID.organization}', 'Processing', '${ID.user}'),
        ('${ID.otherProject}', '${ID.otherOrganization}', 'Other', '${ID.otherUser}');
      INSERT INTO app.datasets
        (id, organization_id, name, format, status, owner_user_id, created_by, updated_by)
      VALUES
        ('${ID.dataset}', '${ID.organization}', 'Source', 'geojson', 'active',
         '${ID.user}', '${ID.user}', '${ID.user}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key,
         s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${ID.source}', '${ID.organization}', '${ID.dataset}', 'original',
         'receipt-test', 'source.geojson', 'source-v1', '${"a".repeat(32)}',
         'application/geo+json', 4096, '${SHA_SOURCE}', '${ID.user}');
      INSERT INTO app.spatial_service_coverages
        (id, organization_id, data_object_id)
      VALUES ('${ID.coverage}', '${ID.organization}', '${ID.source}');
      INSERT INTO app.spatial_coverage_derivative_jobs
        (id, organization_id, project_id, coverage_id, dataset_id,
         request_checksum_sha256, state, worker_token, created_by)
      VALUES
        ('${ID.coverageJob}', '${ID.organization}', '${ID.project}', '${ID.coverage}',
         '${ID.dataset}', '${SHA_COVERAGE}', 'running', '${ID.workerToken}', '${ID.user}');
      INSERT INTO app.pmtiles_derivative_jobs
        (id, organization_id, project_id, dataset_id, source_object_id,
         request_checksum_sha256, state, worker_token, created_by)
      VALUES
        ('${ID.pmtilesJob}', '${ID.organization}', '${ID.project}', '${ID.dataset}',
         '${ID.source}', '${SHA_PMTILES}', 'running', '${ID.workerToken}', '${ID.user}');
    `);
    await db.exec(await migration("0059_processing_execution_receipts.sql"));
    await db.exec("SET ROLE opengeo_runtime");
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("atomically records pinned checksum-linked coverage and PMTiles completions", async () => {
    await asRole("opengeo_worker", async () => {
      const coverage = await db.query(
        "SELECT app.complete_spatial_coverage_derivative($1,$2,$3,$4) AS value",
        [
          ID.coverageJob,
          ID.workerToken,
          {
            id: ID.coverageOutput,
            bucket: "receipt-test",
            object_key: "coverage.tif",
            s3_version_id: "coverage-v1",
            etag: "b".repeat(32),
            content_type: "image/tiff",
            size_bytes: 8192,
            checksum_sha256: SHA_COVERAGE
          },
          {crs: "EPSG:3857"}
        ]
      );
      const pmtiles = await db.query(
        "SELECT app.complete_pmtiles_derivative($1,$2,$3) AS value",
        [
          ID.pmtilesJob,
          ID.workerToken,
          {
            id: ID.pmtilesOutput,
            bucket: "receipt-test",
            object_key: "output.pmtiles",
            s3_version_id: "pmtiles-v1",
            etag: "c".repeat(32),
            content_type: "application/vnd.pmtiles",
            size_bytes: 16384,
            checksum_sha256: SHA_PMTILES
          }
        ]
      );
      assert.deepEqual(coverage.rows, [{value: true}]);
      assert.deepEqual(pmtiles.rows, [{value: true}]);
    });

    const records = await tenant(ID.organization, ID.user, () => db.query(`
      SELECT job_kind, tool_id, tool_version, request_checksum_sha256,
             source_object_id, output_object_id, output_checksum_sha256,
             software->>'gdal' AS gdal,
             software->>'projNetwork' AS proj_network,
             jsonb_array_length(logs) AS log_count,
             verification_status,
             receipt_checksum_sha256 ~ '^[0-9a-f]{64}$' AS checksum_valid
      FROM app.processing_execution_receipts ORDER BY job_kind
    `));
    assert.deepEqual(records.rows, [
      {
        job_kind: "coverage-derivative",
        tool_id: "raster-to-cog",
        tool_version: "1.0.0",
        request_checksum_sha256: SHA_COVERAGE,
        source_object_id: ID.source,
        output_object_id: ID.coverageOutput,
        output_checksum_sha256: SHA_COVERAGE,
        gdal: "3.13.0",
        proj_network: "disabled",
        log_count: 3,
        verification_status: "pinned",
        checksum_valid: true
      },
      {
        job_kind: "pmtiles-derivative",
        tool_id: "vector-to-pmtiles",
        tool_version: "1.0.0",
        request_checksum_sha256: SHA_PMTILES,
        source_object_id: ID.source,
        output_object_id: ID.pmtilesOutput,
        output_checksum_sha256: SHA_PMTILES,
        gdal: "3.13.0",
        proj_network: "disabled",
        log_count: 3,
        verification_status: "pinned",
        checksum_valid: true
      }
    ]);
  });

  it("forces tenant isolation and rejects receipt mutation", async () => {
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT count(*)::integer AS value FROM app.processing_execution_receipts"
    ));
    assert.deepEqual(hidden.rows, [{value: 0}]);

    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        "UPDATE app.processing_execution_receipts SET logs = '[]'::jsonb"
      )),
      /permission denied|immutable/
    );

    const privileges = await db.query(`
      SELECT
        has_table_privilege('opengeo_worker', 'app.processing_execution_receipts', 'INSERT')
          AS worker_insert,
        has_function_privilege(
          'opengeo_worker',
          'app.complete_pmtiles_derivative_without_execution_receipt(uuid,uuid,jsonb)',
          'EXECUTE'
        ) AS worker_bypass
    `);
    assert.deepEqual(privileges.rows, [{worker_insert: false, worker_bypass: false}]);
  });
});
