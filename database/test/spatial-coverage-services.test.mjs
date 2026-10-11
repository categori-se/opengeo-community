import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000171",
  otherOrganization: "10000000-0000-4000-8000-000000000172",
  user: "20000000-0000-4000-8000-000000000171",
  otherUser: "20000000-0000-4000-8000-000000000172",
  project: "50000000-0000-4000-8000-000000000171",
  dataset: "80000000-0000-4000-8000-000000000171",
  object: "81000000-0000-4000-8000-000000000171",
  datasetVersion: "82000000-0000-4000-8000-000000000171",
  service: "60000000-0000-4000-8000-000000000171",
  coverage: "70000000-0000-4000-8000-000000000171",
  derivative: "71000000-0000-4000-8000-000000000171",
  reclamation: "71100000-0000-4000-8000-000000000171",
  outputObject: "81100000-0000-4000-8000-000000000171",
  workerToken: "91000000-0000-4000-8000-000000000171"
};

const migrations = [
  "0001_platform_foundation.sql",
  "0002_membership_invitations.sql",
  "0003_managed_ingestion_foundation.sql",
  "0004_worker_execution_boundary.sql",
  "0005_catalog_access.sql",
  "0006_governed_external_sources.sql",
  "0007_governed_pmtiles_sources.sql",
  "0008_recoverable_project_imports.sql",
  "0009_governed_resources.sql",
  "0010_resource_governance.sql",
  "0011_governed_rendering.sql",
  "0012_raster_reprojection.sql",
  "0013_wms_basic_presentation.sql",
  "0014_ordered_map_compositions.sql",
  "0015_governed_wms_publications.sql",
  "0016_public_wms_services.sql",
  "0017_metadata_governance.sql",
  "0018_metadata_source_documents.sql",
  "0019_multilingual_metadata.sql",
  "0020_extended_metadata_exchange.sql",
  "0021_governed_feature_editing.sql",
  "0022_field_capture.sql",
  "0023_spatial_service_catalog.sql",
  "0024_durable_tile_cache.sql",
  "0036_spatial_coverage_services.sql",
  "0037_coverage_derivatives.sql",
  "0038_coverage_range_scaling_lifecycle.sql",
  "0039_coverage_derivative_reclamation.sql"
];

let db;
let productionMigration;
let derivativeMigration;
let lifecycleMigration;
let reclamationMigration;

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

function pgliteSpatialMigration(sql) {
  return sql
    .replaceAll("geometry geometry(Geometry, 4326) NOT NULL", "geometry jsonb NOT NULL")
    .replace(
      /bbox double precision\[\] GENERATED ALWAYS AS \(\s*ARRAY\[\s*ST_XMin\(Box3D\(geometry\)\),\s*ST_YMin\(Box3D\(geometry\)\),\s*ST_XMax\(Box3D\(geometry\)\),\s*ST_YMax\(Box3D\(geometry\)\)\s*\]\s*\) STORED/s,
      "bbox double precision[] NOT NULL"
    )
    .replace(
      /,\s*CONSTRAINT dataset_features_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT dataset_features_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /,\s*CONSTRAINT dataset_feature_revisions_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT dataset_feature_revisions_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /,\s*CONSTRAINT field_submissions_geometry_type_match CHECK \(.*?\)\s*,\s*CONSTRAINT field_submissions_geometry_safe CHECK \(.*?\)\s*,/s,
      ","
    )
    .replace(
      /CREATE INDEX dataset_features_geometry_idx\s+ON app\.dataset_features USING gist \(geometry\)\s+WHERE deleted_at IS NULL;/s,
      ""
    )
    .replaceAll("ST_Equals(revision.geometry, NEW.geometry)", "revision.geometry = NEW.geometry")
    .replaceAll(
      "NOT ST_Equals(OLD.geometry, NEW.geometry)",
      "OLD.geometry IS DISTINCT FROM NEW.geometry"
    );
}

function insertCoverage({checksum = "a".repeat(64), version = 4} = {}) {
  return db.query(
    `INSERT INTO app.spatial_service_coverages
       (id, organization_id, project_id, service_id, coverage_name,
        dataset_id, dataset_version_id, data_object_id,
        sealed_dataset_version_number, sealed_crs, sealed_extent,
        sealed_width, sealed_height, sealed_band_count, sealed_bands,
        sealed_bucket, sealed_object_key, sealed_storage_version_id,
        sealed_content_type, sealed_size_bytes, sealed_checksum_sha256,
        title, description, created_by)
     VALUES ($1,$2,$3,$4,'elevation',$5,$6,$7,$8,'EPSG:4326',
             '[-77.25,38.75,-76.75,39.25]',512,256,2,
             '[{"index":1,"data_type":"UInt16","color_interpretation":"Gray"},
               {"index":2,"data_type":"UInt16","color_interpretation":"Alpha"}]',
             'opengeo-coverage-test','uploads/elevation.tif','source-v4',
             'image/tiff',4096,$9,'Elevation','Validated exact COG',$10)`,
    [
      ID.coverage,
      ID.organization,
      ID.project,
      ID.service,
      ID.dataset,
      ID.datasetVersion,
      ID.object,
      version,
      checksum,
      ID.user
    ]
  );
}

describe("0036 spatial coverage service seals", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (["0021_governed_feature_editing.sql", "0022_field_capture.sql"].includes(file)) {
        sql = pgliteSpatialMigration(sql);
      }
      if (file === "0036_spatial_coverage_services.sql") productionMigration = sql;
      if (file === "0037_coverage_derivatives.sql") derivativeMigration = sql;
      if (file === "0038_coverage_range_scaling_lifecycle.sql") lifecycleMigration = sql;
      if (file === "0039_coverage_derivative_reclamation.sql") reclamationMigration = sql;
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'coverage-user', 'coverage@example.test', 'Coverage Publisher'),
        ('${ID.otherUser}', 'other-coverage-user', 'other@example.test', 'Other User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Coverage', 'coverage', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-coverage', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Coverage project', '${ID.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${ID.dataset}', '${ID.organization}', 'Elevation', 'internal', 'upload',
              'cog', 'active', '${ID.user}', '${ID.user}', '${ID.user}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${ID.organization}', '${ID.project}', '${ID.dataset}', '${ID.user}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
         etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES ('${ID.object}', '${ID.organization}', '${ID.dataset}', 'original',
              'opengeo-coverage-test', 'uploads/elevation.tif', 'source-v4',
              '0123456789abcdef', 'image/tiff', 4096, '${"a".repeat(64)}', '${ID.user}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number, original_object_id, state,
         extent, crs, geometry_type, schema_definition, quality_results, created_by)
      VALUES ('${ID.datasetVersion}', '${ID.organization}', '${ID.dataset}', 4,
              '${ID.object}', 'active', '[-77.25,38.75,-76.75,39.25]', 'EPSG:4326',
              'raster',
              '{"raster":{"width":512,"height":256,"band_count":2,
                "bands":[{"index":1,"data_type":"UInt16","color_interpretation":"Gray"},
                         {"index":2,"data_type":"UInt16","color_interpretation":"Alpha"}]}}',
              '{"valid":true,"checks":[{"code":"format_verified","status":"passed"},
                {"code":"cog_layout_verified","status":"passed"}]}', '${ID.user}');
      UPDATE app.datasets SET current_version_id = '${ID.datasetVersion}'
      WHERE organization_id = '${ID.organization}' AND id = '${ID.dataset}';
      SET ROLE opengeo_runtime;
    `);
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `INSERT INTO app.spatial_services
           (id, organization_id, project_id, slug, title, description, created_by)
         VALUES ($1,$2,$3,'earth-observation','Earth observation','Exact research rasters',$4)`,
        [ID.service, ID.organization, ID.project, ID.user]
      )
    );
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("defines forced-RLS immutable exact-object seals and denies the worker", () => {
    assert.match(productionMigration, /FORCE ROW LEVEL SECURITY/);
    assert.match(productionMigration, /FROM opengeo_worker/);
    assert.match(productionMigration, /reads never dispatch processing/);
    assert.match(productionMigration, /version\.quality_results @>/);
    assert.match(productionMigration, /object\.s3_version_id = NEW\.sealed_storage_version_id/);
    assert.match(productionMigration, /REVOKE DELETE/);
    assert.match(derivativeMigration, /spatial_service_collection_ids/);
    assert.match(derivativeMigration, /discovery and reads never create jobs/);
    assert.match(derivativeMigration, /TO opengeo_worker/);
    assert.match(derivativeMigration, /REVOKE UPDATE, DELETE/);
    assert.match(lifecycleMigration, /valid_coverage_band_indexes/);
    assert.match(lifecycleMigration, /active-job quota exceeded/);
    assert.match(lifecycleMigration, /cancel_spatial_coverage_derivative/);
    assert.match(reclamationMigration, /reads and timers never create work/);
    assert.match(reclamationMigration, /delete_started_at/);
    assert.match(reclamationMigration, /selected-band jobs/);
  });

  it("rejects forged seals and accepts only the current validated COG original", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () => insertCoverage({checksum: "b".repeat(64)})),
      /must seal current validated COG original/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () => insertCoverage({version: 3})),
      /must seal current validated COG original/
    );
    await tenant(ID.organization, ID.user, () => insertCoverage());
    const result = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT coverage_name, sealed_dataset_version_number, sealed_storage_version_id,
                sealed_checksum_sha256, sealed_width, sealed_height, sealed_band_count
         FROM app.spatial_service_coverages WHERE id = $1`,
        [ID.coverage]
      )
    );
    assert.deepEqual(result.rows[0], {
      coverage_name: "elevation",
      sealed_dataset_version_number: 4,
      sealed_storage_version_id: "source-v4",
      sealed_checksum_sha256: "a".repeat(64),
      sealed_width: 512,
      sealed_height: 256,
      sealed_band_count: 2
    });
  });

  it("reserves the coverage collection id and accepts only explicit bounded transforms", async () => {
    const reservation = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT collection_id, resource_kind, resource_id
         FROM app.spatial_service_collection_ids WHERE service_id = $1`,
        [ID.service]
      )
    );
    assert.deepEqual(reservation.rows[0], {
      collection_id: "elevation",
      resource_kind: "coverage",
      resource_id: ID.coverage
    });

    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_coverage_derivative_jobs
             (id, organization_id, project_id, service_id, coverage_id,
              subset_extent, target_crs, target_width, target_height,
              resampling, request_schema_version, band_indexes, scale_mode,
              requested_resolution, request_checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,$5,'[-77.25,38.75,-76.75,39.25]',
                   'EPSG:4326',512,256,'nearest',1,'[1,2]','size',NULL,$6,$7)`,
          [ID.derivative, ID.organization, ID.project, ID.service, ID.coverage,
            "b".repeat(64), ID.user]
        )
      ),
      /identical to the exact source/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_coverage_derivative_jobs
             (id, organization_id, project_id, service_id, coverage_id,
              subset_extent, target_crs, target_width, target_height,
              resampling, request_schema_version, band_indexes, scale_mode,
              requested_resolution, request_checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,$5,'[-78,38.75,-76.75,39.25]',
                   'EPSG:3857',256,128,'bilinear',1,'[1,2]','size',NULL,$6,$7)`,
          [ID.derivative, ID.organization, ID.project, ID.service, ID.coverage,
            "b".repeat(64), ID.user]
        )
      ),
      /exceeds the sealed raster bounds/
    );
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `INSERT INTO app.spatial_coverage_derivative_jobs
           (id, organization_id, project_id, service_id, coverage_id,
            subset_extent, target_crs, target_width, target_height,
            resampling, request_schema_version, band_indexes, scale_mode,
            requested_resolution, request_checksum_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,'[-77.2,38.8,-76.8,39.2]',
                 'EPSG:3857',256,128,'bilinear',2,'[1]','size',NULL,$6,$7)`,
        [ID.derivative, ID.organization, ID.project, ID.service, ID.coverage,
          "b".repeat(64), ID.user]
      )
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          "UPDATE app.spatial_coverage_derivative_jobs SET target_width = 128 WHERE id = $1",
          [ID.derivative]
        )
      ),
      /permission denied/
    );
  });

  it("lets only worker functions lease and seal the exact derivative artifact", async () => {
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claimed = await db.query(
      "SELECT * FROM app.claim_spatial_coverage_derivative($1,$2,900)",
      [ID.derivative, ID.workerToken]
    );
    assert.equal(claimed.rows[0].claim_status, "claimed");
    assert.equal(claimed.rows[0].source_s3_version_id, "source-v4");
    assert.deepEqual(claimed.rows[0].subset_extent, [-77.2, 38.8, -76.8, 39.2]);
    assert.equal(claimed.rows[0].target_crs, "EPSG:3857");
    assert.equal(claimed.rows[0].request_schema_version, 2);
    assert.deepEqual(claimed.rows[0].band_indexes, [1]);
    assert.equal(claimed.rows[0].scale_mode, "size");
    assert.equal(claimed.rows[0].attempt_count, 1);
    const completed = await db.query(
      `SELECT app.complete_spatial_coverage_derivative($1,$2,$3,$4) AS completed`,
      [
        ID.derivative,
        ID.workerToken,
        JSON.stringify({
          id: ID.outputObject,
          role: "derived",
          bucket: "opengeo-coverage-test",
          object_key: `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/coverages/${ID.derivative}.tif`,
          s3_version_id: "derived-v1",
          etag: "fedcba9876543210",
          content_type: "image/tiff",
          size_bytes: 8192,
          checksum_sha256: "c".repeat(64)
        }),
        JSON.stringify({
          cog_layout_verified: true,
          crs: "EPSG:3857",
          extent: [-8590000, 4690000, -8550000, 4750000],
          width: 256,
          height: 128,
          band_count: 1,
          bands: [
            {
              index: 1,
              source_index: 1,
              data_type: "UInt16",
              color_interpretation: "Gray"
            }
          ]
        })
      ]
    );
    assert.equal(completed.rows[0].completed, true);
    await assert.rejects(
      db.query("SELECT id FROM app.spatial_coverage_derivative_jobs"),
      /permission denied/
    );
    const replay = await db.query(
      "SELECT claim_status FROM app.claim_spatial_coverage_derivative($1,$2,900)",
      [ID.derivative, ID.workerToken]
    );
    assert.equal(replay.rows[0].claim_status, "already_completed");

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const sealed = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT state, output_object_id, output_crs, output_width,
                output_height, output_checksum_sha256
         FROM app.spatial_coverage_derivative_jobs WHERE id = $1`,
        [ID.derivative]
      )
    );
    assert.deepEqual(sealed.rows[0], {
      state: "completed",
      output_object_id: ID.outputObject,
      output_crs: "EPSG:3857",
      output_width: 256,
      output_height: 128,
      output_checksum_sha256: "c".repeat(64)
    });
  });

  it("queues and completes preview-confirmed exact-version reclamation without losing history", async () => {
    await db.exec(`
      RESET ROLE;
      SET session_replication_role = replica;
      UPDATE app.spatial_coverage_derivative_jobs
      SET finished_at = clock_timestamp() - interval '25 hours'
      WHERE id = '${ID.derivative}';
      SET session_replication_role = origin;
      SET ROLE opengeo_runtime;
    `);
    const queued = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT app.queue_spatial_coverage_derivative_reclamation(
           $1,$2,$3,$4,$5,$6,clock_timestamp() + interval '10 minutes',
           $7,'coverage-reclaim-1'
         ) AS id`,
        [
          ID.organization,
          ID.project,
          ID.service,
          ID.coverage,
          ID.derivative,
          "f".repeat(64),
          ID.user
        ]
      )
    );
    const reclamationId = queued.rows[0].id;
    assert.match(reclamationId, /^[0-9a-f-]{36}$/);
    const hidden = await tenant(ID.organization, ID.user, () =>
      db.query("SELECT id FROM app.data_objects WHERE id = $1", [ID.outputObject])
    );
    assert.equal(hidden.rows.length, 0);

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claim = await db.query(
      "SELECT * FROM app.claim_spatial_coverage_derivative_reclamation($1,$2,900)",
      [reclamationId, ID.workerToken]
    );
    assert.equal(claim.rows[0].claim_status, "claimed");
    assert.equal(claim.rows[0].storage_version_id, "derived-v1");
    assert.equal(
      claim.rows[0].object_key,
      `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/coverages/${ID.derivative}.tif`
    );
    const started = await db.query(
      "SELECT app.start_spatial_coverage_derivative_delete($1,$2) AS started",
      [reclamationId, ID.workerToken]
    );
    assert.equal(started.rows[0].started, true);
    await db.exec(`
      RESET ROLE;
      SET session_replication_role = replica;
      UPDATE app.data_objects SET size_bytes = size_bytes + 1
      WHERE id = '${ID.outputObject}';
      SET session_replication_role = origin;
      SET ROLE opengeo_worker;
    `);
    const refusedMismatch = await db.query(
      "SELECT app.complete_spatial_coverage_derivative_reclamation($1,$2) AS completed",
      [reclamationId, ID.workerToken]
    );
    assert.equal(refusedMismatch.rows[0].completed, false);
    await db.exec("RESET ROLE");
    const associationAfterMismatch = await db.query(
      "SELECT 1 FROM app.dataset_version_objects WHERE data_object_id = $1",
      [ID.outputObject]
    );
    assert.equal(associationAfterMismatch.rows.length, 1);
    await db.exec(`
      SET session_replication_role = replica;
      UPDATE app.data_objects SET size_bytes = size_bytes - 1
      WHERE id = '${ID.outputObject}';
      SET session_replication_role = origin;
      SET ROLE opengeo_worker;
    `);
    const completed = await db.query(
      "SELECT app.complete_spatial_coverage_derivative_reclamation($1,$2) AS completed",
      [reclamationId, ID.workerToken]
    );
    assert.equal(completed.rows[0].completed, true);

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const history = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT job.output_object_id, reclamation.state,
                reclamation.delete_started_at IS NOT NULL AS delete_started
         FROM app.spatial_coverage_derivative_jobs job
         JOIN app.spatial_coverage_derivative_reclamations reclamation
           ON reclamation.organization_id = job.organization_id
          AND reclamation.derivative_job_id = job.id
         WHERE job.id = $1`,
        [ID.derivative]
      )
    );
    assert.deepEqual(history.rows[0], {
      output_object_id: ID.outputObject,
      state: "completed",
      delete_started: true
    });
  });

  it("binds range/resolution semantics, enforces active quota, and cancels queued work", async () => {
    const rangeJob = "71000000-0000-4000-8000-000000000172";
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_coverage_derivative_jobs
             (id, organization_id, project_id, service_id, coverage_id,
              subset_extent, target_crs, target_width, target_height,
              resampling, request_schema_version, band_indexes, scale_mode,
              requested_resolution, request_checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,$5,'[-77.2,38.8,-76.8,39.2]',
                   'EPSG:4326',40,40,'cubic',2,'[3]','resolution',
                   '[0.01,0.01]',$6,$7)`,
          [rangeJob, ID.organization, ID.project, ID.service, ID.coverage,
            "d".repeat(64), ID.user]
        )
      ),
      /range subset is invalid/
    );
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `INSERT INTO app.spatial_coverage_derivative_jobs
           (id, organization_id, project_id, service_id, coverage_id,
            subset_extent, target_crs, target_width, target_height,
            resampling, request_schema_version, band_indexes, scale_mode,
            requested_resolution, request_checksum_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,'[-77.2,38.8,-76.8,39.2]',
                 'EPSG:4326',40,40,'cubic',2,'[1]','resolution',
                 '[0.01,0.01]',$6,$7)`,
        [rangeJob, ID.organization, ID.project, ID.service, ID.coverage,
          "d".repeat(64), ID.user]
      )
    );
    const cancelled = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT app.cancel_spatial_coverage_derivative(
           $1,$2,$3,$4,$5,$6,'coverage-cancel-1'
         ) AS cancelled`,
        [ID.organization, ID.project, ID.service, ID.coverage, rangeJob, ID.user]
      )
    );
    assert.equal(cancelled.rows[0].cancelled, true);
    const cancelledJob = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT state, error_code, finished_at IS NOT NULL AS finished
         FROM app.spatial_coverage_derivative_jobs WHERE id = $1`,
        [rangeJob]
      )
    );
    assert.deepEqual(cancelledJob.rows[0], {
      state: "cancelled",
      error_code: "cancelled_by_user",
      finished: true
    });

    for (let index = 0; index < 4; index += 1) {
      await tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_coverage_derivative_jobs
             (id, organization_id, project_id, service_id, coverage_id,
              subset_extent, target_crs, target_width, target_height,
              resampling, request_schema_version, band_indexes, scale_mode,
              requested_resolution, request_checksum_sha256, created_by)
           VALUES ($1,$2,$3,$4,$5,'[-77.2,38.8,-76.8,39.2]',
                   'EPSG:3857',$6,64,'nearest',2,'[1]','size',NULL,$7,$8)`,
          [`71000000-0000-4000-8000-${String(173 + index).padStart(12, "0")}`,
            ID.organization, ID.project, ID.service, ID.coverage, 64 + index,
            "e".repeat(64), ID.user]
        )
      );
    }
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_coverage_derivative_jobs
             (id, organization_id, project_id, service_id, coverage_id,
              subset_extent, target_crs, target_width, target_height,
              resampling, request_schema_version, band_indexes, scale_mode,
              requested_resolution, request_checksum_sha256, created_by)
           VALUES ('71000000-0000-4000-8000-000000000177',$1,$2,$3,$4,
                   '[-77.2,38.8,-76.8,39.2]','EPSG:3857',68,64,'nearest',
                   2,'[1]','size',NULL,$5,$6)`,
          [ID.organization, ID.project, ID.service, ID.coverage,
            "f".repeat(64), ID.user]
        )
      ),
      /active-job quota exceeded/
    );
  });

  it("keeps seals immutable and makes withdrawal actor-bound and irreversible", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          "UPDATE app.spatial_service_coverages SET title = 'Changed' WHERE id = $1",
          [ID.coverage]
        )
      ),
      /coverage seal is immutable/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.spatial_service_coverages
           SET withdrawn_by = $1, withdrawn_at = clock_timestamp() WHERE id = $2`,
          [ID.otherUser, ID.coverage]
        )
      ),
      /withdrawal is one-way and actor-bound/
    );
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `UPDATE app.spatial_service_coverages
         SET withdrawn_by = $1, withdrawn_at = clock_timestamp() WHERE id = $2`,
        [ID.user, ID.coverage]
      )
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.spatial_service_coverages
           SET withdrawn_by = NULL, withdrawn_at = NULL WHERE id = $1`,
          [ID.coverage]
        )
      ),
      /withdrawal is one-way and actor-bound/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query("DELETE FROM app.spatial_service_coverages WHERE id = $1", [ID.coverage])
      ),
      /permission denied/
    );
  });

  it("isolates other tenants and grants the worker no coverage-table access", async () => {
    const isolated = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.spatial_service_coverages")
    );
    assert.equal(isolated.rows.length, 0);

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT id FROM app.spatial_service_coverages"),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });
});
