import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000058",
  otherOrganization: "10000000-0000-4000-8000-000000000059",
  owner: "20000000-0000-4000-8000-000000000058",
  viewer: "20000000-0000-4000-8000-000000000059",
  otherUser: "20000000-0000-4000-8000-000000000060",
  project: "50000000-0000-4000-8000-000000000058",
  otherProject: "50000000-0000-4000-8000-000000000059",
  wmsDataset: "80000000-0000-4000-8000-000000000058",
  xyzDataset: "80000000-0000-4000-8000-000000000059",
  externalPmtilesDataset: "80000000-0000-4000-8000-000000000060",
  arcgisDataset: "80000000-0000-4000-8000-000000000064",
  featureSnapshotDataset: "80000000-0000-4000-8000-000000000065",
  snapshotDataset: "80000000-0000-4000-8000-000000000061",
  cancelledSnapshotDataset: "80000000-0000-4000-8000-000000000062",
  vectorDataset: "80000000-0000-4000-8000-000000000063",
  vectorObject: "82000000-0000-4000-8000-000000000058",
  vectorVersion: "83000000-0000-4000-8000-000000000058",
  wmsEstimate: "90000000-0000-4000-8000-000000000058",
  wmsJob: "91000000-0000-4000-8000-000000000058",
  wmsArtifact: "92000000-0000-4000-8000-000000000058",
  cancelEstimate: "90000000-0000-4000-8000-000000000059",
  cancelSnapshotJob: "91000000-0000-4000-8000-000000000059",
  pmtilesJob: "93000000-0000-4000-8000-000000000058",
  featureEstimate: "90000000-0000-4000-8000-000000000066",
  featureJob: "91000000-0000-4000-8000-000000000066",
  pmtilesArtifact: "94000000-0000-4000-8000-000000000058",
  cancelPmtilesJob: "93000000-0000-4000-8000-000000000059",
  archiverToken: "a0000000-0000-4000-8000-000000000058",
  workerToken: "a0000000-0000-4000-8000-000000000059",
  discoveryJob: "95000000-0000-4000-8000-000000000058",
  discoveryCancelJob: "95000000-0000-4000-8000-000000000059",
  discoveryToken: "a0000000-0000-4000-8000-000000000060"
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const WMS_SCOPE = {
  kind: "bounded_image",
  bounds: [-73.6, 41.2, -69.8, 43.1],
  width: 2048,
  height: 1024
};

let db;
let migration;
let featureMigration;

async function readMigration(file) {
  return readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
}

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

async function asRole(role, operation) {
  await db.exec(`RESET ROLE; SET ROLE ${role}`);
  try {
    return await operation();
  } finally {
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  }
}

async function insertEstimate({
  id,
  sourceDatasetId = IDS.wmsDataset,
  sourceRevisionNumber = 1,
  copyMethod = "bounded_map_capture",
  captureScope = WMS_SCOPE,
  outputFormat = "png",
  outputContentType = "image/png",
  maximumRequests = 1,
  maximumOutputBytes = 64 * 1024 * 1024,
  checksum = SHA_A,
  createdBy = IDS.owner
}) {
  return db.query(
    `INSERT INTO app.external_source_copy_estimates
       (id, organization_id, project_id, source_dataset_id,
        source_revision_number, copy_method, capture_scope, output_format,
        output_content_type, maximum_requests, maximum_output_bytes,
        estimated_cost_usd, estimate_checksum_sha256, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             0.025, $12, $13, clock_timestamp() + interval '15 minutes')`,
    [
      id,
      IDS.organization,
      IDS.project,
      sourceDatasetId,
      sourceRevisionNumber,
      copyMethod,
      JSON.stringify(captureScope),
      outputFormat,
      outputContentType,
      maximumRequests,
      maximumOutputBytes,
      checksum,
      createdBy
    ]
  );
}

async function insertSnapshotJob({
  id,
  estimateId,
  sourceDatasetId = IDS.wmsDataset,
  destinationDatasetId,
  checksum,
  idempotencyKey,
  stagedBase = null
}) {
  return db.query(
    `INSERT INTO app.external_source_snapshot_jobs
       (id, organization_id, project_id, estimate_id, source_dataset_id,
        source_revision_number, destination_dataset_id, destination_bucket,
        rights_basis, attribution, request_checksum_sha256, idempotency_key,
        request_id, created_by, staged_base_version_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'opengeo-geodata-test',
             'MassGIS open-data terms reviewed', 'Office of Geographic Information (MassGIS)',
             $7, $8, $9, $10, $11)`,
    [
      id,
      IDS.organization,
      IDS.project,
      estimateId,
      sourceDatasetId,
      destinationDatasetId,
      checksum,
      idempotencyKey,
      `snapshot-${id}`,
      IDS.owner,
      stagedBase
    ]
  );
}

async function insertPmtilesJob({id, checksum, idempotencyKey}) {
  return db.query(
    `INSERT INTO app.pmtiles_derivative_jobs
       (id, organization_id, project_id, dataset_id, dataset_version_id,
        source_object_id, bounds, minimum_zoom, maximum_zoom, source_layer,
        request_checksum_sha256, idempotency_key, request_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, '[-73.6,41.2,-69.8,43.1]'::jsonb,
             0, 12, 'features', $7, $8, $9, $10)`,
    [
      id,
      IDS.organization,
      IDS.project,
      IDS.vectorDataset,
      IDS.vectorVersion,
      IDS.vectorObject,
      checksum,
      idempotencyKey,
      `pmtiles-${id}`,
      IDS.owner
    ]
  );
}

describe("0058, 0061, and 0062 durable source custody migrations", () => {
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
      const sql = await readMigration(file);
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec("ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS 'png'");
    await db.exec(
      "CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator; " +
      "CREATE ROLE opengeo_dataset_verifier;"
    );
    await db.exec(await readMigration("0050_team_project_access.sql"));
    await db.exec(await readMigration("0054_reusable_project_datasets.sql"));
    await db.exec(await readMigration("0055_project_dataset_detach_lock.sql"));
    migration = await readMigration("0058_durable_data_preservation.sql");
    await db.exec(migration);
    await db.exec(await readMigration("0060_governed_geojson_archives.sql"));
    featureMigration = await readMigration("0061_bounded_feature_source_archives.sql");
    await db.exec(featureMigration);
    // PGlite does not bundle pgcrypto. The migration-chain/baseline verifier
    // exercises the real digest function; this deterministic stub lets the
    // RLS and lifecycle suite exercise the trigger contract.
    await db.exec(`
      CREATE FUNCTION public.digest(bytea, text) RETURNS bytea
      LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', 32), 'hex') $$;
    `);
    await db.exec(await readMigration("0062_external_source_discovery_jobs.sql"));
    const governed = await readMigration("0009_governed_resources.sql");
    await db.exec(governed.match(/CREATE FUNCTION app\.reject_governed_resource_history_mutation\(\)[\s\S]*?\$\$;/)[0]);
    await db.exec(await readMigration("0144_source_capture_count_evidence.sql"));
    await db.exec(await readMigration("0141_staged_upload_intents.sql"));
    await db.exec(await readMigration("0145_staged_source_captures.sql"));


    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'preservation-owner', 'owner@example.test', 'Owner'),
        ('${IDS.viewer}', 'preservation-viewer', 'viewer@example.test', 'Viewer'),
        ('${IDS.otherUser}', 'preservation-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Preservation', 'preservation', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other', 'preservation-other', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.viewer}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.project}', '${IDS.organization}', 'MassGIS', '${IDS.owner}'),
        ('${IDS.otherProject}', '${IDS.otherOrganization}', 'Hidden', '${IDS.otherUser}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES
        ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner'),
        ('${IDS.organization}', '${IDS.project}', '${IDS.viewer}', 'viewer');

      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES
        ('${IDS.wmsDataset}', '${IDS.organization}', 'MassGIS WMS', 'public',
         'wms', 'wms', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.xyzDataset}', '${IDS.organization}', 'Public XYZ', 'public',
         'xyz', 'xyz', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.externalPmtilesDataset}', '${IDS.organization}', 'Public PMTiles', 'public',
         'pmtiles', 'pmtiles', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.arcgisDataset}', '${IDS.organization}', 'MassGIS features', 'public',
         'arcgis', 'arcgis', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.featureSnapshotDataset}', '${IDS.organization}', 'MassGIS feature copy', 'internal',
         'upload', 'geojson', 'draft', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.snapshotDataset}', '${IDS.organization}', 'MassGIS protected copy', 'internal',
         'upload', 'png', 'draft', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.cancelledSnapshotDataset}', '${IDS.organization}', 'Cancelled copy', 'internal',
         'upload', 'png', 'draft', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}'),
        ('${IDS.vectorDataset}', '${IDS.organization}', 'Managed vectors', 'internal',
         'upload', 'geojson', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}');
      INSERT INTO app.project_datasets
        (organization_id, project_id, dataset_id, linked_by)
      SELECT '${IDS.organization}', '${IDS.project}', id, '${IDS.owner}'
      FROM app.datasets WHERE organization_id = '${IDS.organization}';
      INSERT INTO app.external_sources
        (organization_id, dataset_id, source_type, created_by)
      VALUES
        ('${IDS.organization}', '${IDS.wmsDataset}', 'wms', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.xyzDataset}', 'xyz', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.externalPmtilesDataset}', 'pmtiles', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.arcgisDataset}', 'arcgis', '${IDS.owner}');
      INSERT INTO app.external_source_revisions
        (organization_id, dataset_id, version_number, source_url, configuration, created_by)
      VALUES
        ('${IDS.organization}', '${IDS.wmsDataset}', 1,
         'https://maps.massgis.digital.mass.gov/geoserver/wms',
         '{"layers":["massgis:water_quality"],"format":"image/png"}', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.wmsDataset}', 2,
         'https://maps.massgis.digital.mass.gov/geoserver/wms',
         '{"layers":["massgis:water_quality"],"format":"image/jpeg"}', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.xyzDataset}', 1,
         'https://tiles.example.test/{z}/{x}/{y}.png',
         '{"scheme":"xyz","tile_size":256}', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.externalPmtilesDataset}', 1,
         'https://data.example.test/source.pmtiles', '{}', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.arcgisDataset}', 1,
         'https://services.example.test/arcgis/rest/services/screening/FeatureServer/0',
         '{"object_id_field":"OBJECTID","fields":["OBJECTID","name"],"geometry_type":"Polygon","page_size":1000,"attribution":"MassGIS"}',
         '${IDS.owner}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key,
         s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${IDS.vectorObject}', '${IDS.organization}', '${IDS.vectorDataset}', 'original',
         'opengeo-geodata-test',
         'organizations/${IDS.organization}/projects/${IDS.project}/datasets/${IDS.vectorDataset}/uploads/source/original/features.geojson',
         'source-version-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'application/geo+json', 8192, '${SHA_A}', '${IDS.owner}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number, original_object_id,
         state, change_message, created_by)
      VALUES
        ('${IDS.vectorVersion}', '${IDS.organization}', '${IDS.vectorDataset}', 1,
         '${IDS.vectorObject}', 'active', 'Exact source version', '${IDS.owner}');
      UPDATE app.datasets SET current_version_id = '${IDS.vectorVersion}'
      WHERE id = '${IDS.vectorDataset}';
      SET ROLE opengeo_runtime;
    `);

    await inTenant(IDS.organization, IDS.owner, async () => {
      await insertEstimate({id: IDS.wmsEstimate, checksum: SHA_A});
      await insertSnapshotJob({
        id: IDS.wmsJob,
        estimateId: IDS.wmsEstimate,
        destinationDatasetId: IDS.snapshotDataset,
        checksum: SHA_B,
        idempotencyKey: "b0000000-0000-4000-8000-000000000058"
      });
      await insertPmtilesJob({
        id: IDS.pmtilesJob,
        checksum: SHA_C,
        idempotencyKey: "c0000000-0000-4000-8000-000000000058"
      });
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("creates forced-RLS tables and keeps worker and archiver privileges separate", async () => {
    const rls = await db.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'app'::regnamespace
        AND relname IN (
          'external_source_copy_estimates', 'external_source_snapshot_jobs',
          'pmtiles_derivative_jobs', 'dataset_version_external_source_lineage',
          'dataset_version_derivative_lineage'
        )
      ORDER BY relname
    `);
    assert.equal(rls.rows.length, 5);
    assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));

    const grants = await db.query(`
      SELECT
        has_table_privilege('opengeo_worker', 'app.pmtiles_derivative_jobs', 'SELECT')
          AS worker_table,
        has_table_privilege('opengeo_source_archiver', 'app.external_source_snapshot_jobs', 'SELECT')
          AS archiver_table,
        has_function_privilege('opengeo_worker',
          'app.claim_pmtiles_derivative(uuid,uuid,integer)', 'EXECUTE') AS worker_pmtiles,
        has_function_privilege('opengeo_worker',
          'app.claim_external_source_snapshot(uuid,uuid,integer)', 'EXECUTE') AS worker_snapshot,
        has_function_privilege('opengeo_source_archiver',
          'app.claim_external_source_snapshot(uuid,uuid,integer)', 'EXECUTE') AS archiver_snapshot,
        has_function_privilege('opengeo_source_archiver',
          'app.get_completed_external_source_snapshot_artifact(uuid)', 'EXECUTE')
          AS archiver_snapshot_replay,
        has_function_privilege('opengeo_worker',
          'app.get_completed_external_source_snapshot_artifact(uuid)', 'EXECUTE')
          AS worker_snapshot_replay,
        has_function_privilege('opengeo_source_archiver',
          'app.claim_pmtiles_derivative(uuid,uuid,integer)', 'EXECUTE') AS archiver_pmtiles
    `);
    assert.deepEqual(grants.rows, [{
      worker_table: false,
      archiver_table: false,
      worker_pmtiles: true,
      worker_snapshot: false,
      archiver_snapshot: true,
      archiver_snapshot_replay: true,
      worker_snapshot_replay: false,
      archiver_pmtiles: false
    }]);
  });

  it("accepts only source-specific, closed, bounded capture estimates", async () => {
    await inTenant(IDS.organization, IDS.owner, async () => {
      await insertEstimate({
        id: "90000000-0000-4000-8000-000000000061",
        sourceDatasetId: IDS.externalPmtilesDataset,
        copyMethod: "exact_object_copy",
        captureScope: {kind: "exact_object"},
        outputFormat: "pmtiles",
        outputContentType: "application/vnd.pmtiles",
        maximumRequests: 1,
        maximumOutputBytes: 536870912,
        checksum: SHA_C
      });
    });

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000064",
        sourceDatasetId: IDS.externalPmtilesDataset,
        copyMethod: "exact_object_copy",
        captureScope: {kind: "exact_object"},
        outputFormat: "pmtiles",
        outputContentType: "application/vnd.pmtiles",
        maximumRequests: 1,
        maximumOutputBytes: 536870913,
        checksum: SHA_D
      })),
      /external_source_copy_estimates_bytes_bounded/
    );

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000060",
        sourceDatasetId: IDS.xyzDataset,
        copyMethod: "bounded_tile_capture",
        captureScope: {
          kind: "bounded_tiles",
          bounds: [-73.6, 41.2, -69.8, 43.1],
          minZoom: 3,
          maxZoom: 10,
          maximumTiles: 512
        },
        outputFormat: "pmtiles",
        outputContentType: "application/vnd.pmtiles",
        maximumRequests: 512,
        checksum: SHA_B
      })),
      /does not match the project source/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000062",
        captureScope: {...WMS_SCOPE, unsealed: true},
        checksum: SHA_D
      })),
      /does not match the project source/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000064",
        sourceRevisionNumber: 2,
        checksum: SHA_D
      })),
      /does not match the project source/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000065",
        captureScope: {...WMS_SCOPE, bounds: [-73.6, 41.2, -69.8, 86]},
        checksum: SHA_D
      })),
      /does not match the project source/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.viewer, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000063",
        checksum: SHA_D,
        createdBy: IDS.viewer
      })),
      /requires project edit access/
    );
    assert.match(migration, /maximum_requests BETWEEN 1 AND 4096/);
    assert.match(migration, /> 10737418240/);
    assert.match(migration, /state IN \('queued', 'running'\)\) >= 4/g);
  });

  it("admits one bounded feature estimate and assigns only a GeoJSON archive path", async () => {
    const scope = {
      kind: "bounded_features",
      bounds: [-73.6, 41.2, -69.8, 43.1],
      maximum_features: 10_000,
      page_size: 1_000
    };
    await inTenant(IDS.organization, IDS.owner, async () => {
      await insertEstimate({
        id: IDS.featureEstimate,
        sourceDatasetId: IDS.arcgisDataset,
        copyMethod: "bounded_feature_capture",
        captureScope: scope,
        outputFormat: "geojson",
        outputContentType: "application/geo+json",
        maximumRequests: 10,
        maximumOutputBytes: 134_217_728,
        checksum: SHA_D
      });
      await insertSnapshotJob({
        id: IDS.featureJob,
        estimateId: IDS.featureEstimate,
        sourceDatasetId: IDS.arcgisDataset,
        destinationDatasetId: IDS.featureSnapshotDataset,
        checksum: SHA_C,
        idempotencyKey: "b0000000-0000-4000-8000-000000000066"
      });
    });

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000067",
        sourceDatasetId: IDS.arcgisDataset,
        copyMethod: "bounded_feature_capture",
        captureScope: {...scope, maximum_features: 50_000, page_size: 500},
        outputFormat: "geojson",
        outputContentType: "application/geo+json",
        maximumRequests: 100,
        maximumOutputBytes: 134_217_728,
        checksum: SHA_A
      })),
      /does not match the project source/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertEstimate({
        id: "90000000-0000-4000-8000-000000000068",
        sourceDatasetId: IDS.arcgisDataset,
        copyMethod: "bounded_feature_capture",
        captureScope: {...scope, page_size: 1_500},
        outputFormat: "geojson",
        outputContentType: "application/geo+json",
        maximumRequests: 7,
        maximumOutputBytes: 134_217_728,
        checksum: SHA_B
      })),
      /does not match the project source/
    );

    await asRole("opengeo_source_archiver", async () => {
      const claim = await db.query(
        "SELECT * FROM app.claim_external_source_snapshot($1, $2, 300)",
        [IDS.featureJob, IDS.archiverToken]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      assert.equal(claim.rows[0].source_type, "arcgis");
      assert.equal(claim.rows[0].copy_method, "bounded_feature_capture");
      assert.equal(claim.rows[0].output_content_type, "application/geo+json");
      assert.deepEqual(claim.rows[0].capture_scope, scope);
      assert.match(claim.rows[0].output_object_key, /\/snapshot\.geojson$/);
      const artifact = {
        id: "92000000-0000-4000-8000-000000000066", role: "original",
        bucket: "opengeo-geodata-test", object_key: claim.rows[0].output_object_key,
        s3_version_id: "feature-v1", etag: "b".repeat(32),
        content_type: "application/geo+json", size_bytes: 1024, checksum_sha256: SHA_B,
        count_evidence: {
          schemaVersion: "opengeo.feature-capture-counts.1.0.0", scope, sourceType: "arcgis",
          fetchedCount: 3, numberMatched: 3, countStatus: "matched_bounded_scope",
          limitedByMaximumFeatures: false
        }
      };
      for (const patch of [{fetchedCount: 2}, {scope: {...scope, maximum_features: 5000}},
        {sourceType: "wfs"}, {numberMatched: true}, {numberMatched: null},
        {limitedByMaximumFeatures: true}]) {
        await assert.rejects(db.query(
          "SELECT app.complete_external_source_snapshot($1,$2,$3)",
          [IDS.featureJob, IDS.archiverToken, {...artifact, count_evidence: {...artifact.count_evidence, ...patch}}]
        ), /count|evidence/);
      }
      await assert.rejects(db.query(
        "SELECT app.complete_external_source_snapshot_without_counts($1,$2,$3)",
        [IDS.featureJob, IDS.archiverToken, artifact]), /permission denied/);
      const completed = await db.query("SELECT app.complete_external_source_snapshot($1,$2,$3) AS value",
        [IDS.featureJob, IDS.archiverToken, artifact]);
      assert.deepEqual(completed.rows, [{value: true}]);
      const replay = await db.query("SELECT app.complete_external_source_snapshot($1,$2,$3) AS value",
        [IDS.featureJob, IDS.archiverToken, artifact]);
      assert.deepEqual(replay.rows, [{value: false}]);
    });
    await inTenant(IDS.organization, IDS.owner, async () => {
      const rows = await db.query(`SELECT evidence, original_object_id, dataset_version_id
        FROM app.source_capture_count_evidence WHERE snapshot_job_id=$1`, [IDS.featureJob]);
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].evidence.fetchedCount, 3);
      assert.equal(rows.rows[0].original_object_id, "92000000-0000-4000-8000-000000000066");
      assert.ok(rows.rows[0].dataset_version_id);
      const bound = await db.query(`SELECT count(*)::integer AS n
        FROM app.source_capture_count_evidence e
        JOIN app.external_source_snapshot_jobs j ON j.id=e.snapshot_job_id
          AND j.output_object_id=e.original_object_id
          AND j.output_dataset_version_id=e.dataset_version_id
        JOIN app.dataset_versions v ON v.id=e.dataset_version_id
          AND v.original_object_id=e.original_object_id AND v.dataset_id=e.dataset_id
        WHERE e.snapshot_job_id=$1`, [IDS.featureJob]);
      assert.equal(bound.rows[0].n, 1);

    });
    await assert.rejects(db.query("UPDATE app.source_capture_count_evidence SET evidence='{}'"), /permission denied/);
    await db.exec("RESET ROLE");
    try {
      await assert.rejects(db.query("DELETE FROM app.source_capture_count_evidence"), /immutable/);
    } finally {
      await db.exec("SET ROLE opengeo_runtime");
    }

    await inTenant(IDS.otherOrganization, IDS.otherUser, async () => {
      assert.equal((await db.query("SELECT * FROM app.source_capture_count_evidence")).rows.length, 0);
    });
    assert.match(featureMigration, /bounded_feature_capture/);
    assert.match(featureMigration, /snapshot\.geojson/);
  });

  it("stages a captured replacement without changing its managed Layer or active version", async () => {
    await db.exec("RESET ROLE");
    const base = (await db.query("SELECT output_dataset_version_id AS id FROM app.external_source_snapshot_jobs WHERE id=$1", [IDS.featureJob])).rows[0].id;
    // Synthetic worker completion; this case tests custody/staging, not GIS processing.
    await db.query("UPDATE app.dataset_versions SET state='active' WHERE id=$1", [base]);
    await db.query("UPDATE app.datasets SET status='active' WHERE id=$1", [IDS.featureSnapshotDataset]);
    await db.exec("SET ROLE opengeo_runtime");
    const estimateId = "90000000-0000-4000-8000-000000000070";
    const jobId = "91000000-0000-4000-8000-000000000070";
    const scope = {kind: "bounded_features", bounds: [-73.6,41.2,-69.8,43.1], maximum_features: 10000, page_size: 1000};
    await inTenant(IDS.organization, IDS.owner, async () => {
      await insertEstimate({id: estimateId, sourceDatasetId: IDS.arcgisDataset,
        copyMethod: "bounded_feature_capture", captureScope: scope, outputFormat: "geojson",
        outputContentType: "application/geo+json", maximumRequests: 10,
        maximumOutputBytes: 134217728, checksum: "e".repeat(64)});
      await insertSnapshotJob({id: jobId, estimateId, sourceDatasetId: IDS.arcgisDataset,
        destinationDatasetId: IDS.featureSnapshotDataset, checksum: "f".repeat(64),
        idempotencyKey: "b0000000-0000-4000-8000-000000000070", stagedBase: base});
    });
    await asRole("opengeo_source_archiver", async () => {
      const claim = (await db.query("SELECT * FROM app.claim_external_source_snapshot($1,$2,300)",[jobId,IDS.archiverToken])).rows[0];
      assert.equal(claim.claim_status,"claimed");
      const result = await db.query("SELECT app.complete_external_source_snapshot($1,$2,$3) AS value", [jobId,IDS.archiverToken,{
        id: "92000000-0000-4000-8000-000000000070", role:"original", bucket:"opengeo-geodata-test",
        object_key:claim.output_object_key,s3_version_id:"refresh-v2",etag:"c".repeat(32),
        content_type:"application/geo+json",size_bytes:1200,checksum_sha256:SHA_C,
        count_evidence:{schemaVersion:"opengeo.feature-capture-counts.1.0.0",scope,sourceType:"arcgis",
          fetchedCount:4,numberMatched:4,countStatus:"matched_bounded_scope",limitedByMaximumFeatures:false}
      }]);
      assert.equal(result.rows[0].value,true);
    });
    await inTenant(IDS.organization,IDS.owner,async()=>{
      const current=(await db.query("SELECT current_version_id,status FROM app.datasets WHERE id=$1",[IDS.featureSnapshotDataset])).rows[0];
      assert.equal(current.current_version_id,base); assert.equal(current.status,"active");
      const candidate=(await db.query(`SELECT v.parent_version_id,v.version_number,v.state,i.staged_base_version_id
        FROM app.dataset_versions v JOIN app.upload_intents i ON i.completed_object_id=v.original_object_id
        WHERE i.id=$1`,[jobId])).rows[0];
      assert.equal(candidate.parent_version_id,base); assert.equal(candidate.staged_base_version_id,base);
      assert.equal(candidate.version_number,2); assert.equal(candidate.state,"queued");
    });
    for (const [offset, mode] of [[71,"cancel"],[72,"fail"],[73,"release"]]) {
      const estimate = `90000000-0000-4000-8000-0000000000${offset}`;
      const job = `91000000-0000-4000-8000-0000000000${offset}`;
      await inTenant(IDS.organization,IDS.owner,async()=>{
        await insertEstimate({id:estimate,sourceDatasetId:IDS.arcgisDataset,
          copyMethod:"bounded_feature_capture",captureScope:scope,outputFormat:"geojson",
          outputContentType:"application/geo+json",maximumRequests:10,maximumOutputBytes:134217728,
          checksum:String(offset).repeat(32)});
        await insertSnapshotJob({id:job,estimateId:estimate,sourceDatasetId:IDS.arcgisDataset,
          destinationDatasetId:IDS.featureSnapshotDataset,checksum:String(offset).repeat(32),
          idempotencyKey:`b0000000-0000-4000-8000-0000000000${offset}`,stagedBase:base});
      });
      if (mode==="cancel") {
        await inTenant(IDS.organization,IDS.owner,()=>db.query(
          "SELECT app.cancel_external_source_snapshot($1,$2,$3,$4,'cancel-refresh')",
          [IDS.organization,IDS.project,job,IDS.owner]));
      } else {
        await asRole("opengeo_source_archiver",async()=>{
          for(let n=0;n<(mode==="release"?3:1);n++) {
            await db.query("SELECT * FROM app.claim_external_source_snapshot($1,$2,300)",[job,IDS.archiverToken]);
            await db.query(`SELECT app.${mode==="release"?"release":"fail"}_external_source_snapshot($1,$2,'fixture_cleanup')`,[job,IDS.archiverToken]);
          }
        });
      }
      await inTenant(IDS.organization,IDS.owner,async()=>{
        const kept=(await db.query(`SELECT d.current_version_id,d.status FROM app.datasets d
          JOIN app.project_datasets p ON p.dataset_id=d.id AND p.organization_id=d.organization_id
          WHERE d.id=$1 AND p.project_id=$2`,[IDS.featureSnapshotDataset,IDS.project])).rows;
        assert.equal(kept.length,1); assert.equal(kept[0].current_version_id,base);
        assert.equal(kept[0].status,"active");
      });
    }
  });

  it("hides queued work across tenants", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query(`
        SELECT
          (SELECT count(*)::integer FROM app.external_source_snapshot_jobs) AS snapshots,
          (SELECT count(*)::integer FROM app.pmtiles_derivative_jobs) AS derivatives
      `)
    );
    assert.deepEqual(hidden.rows, [{snapshots: 0, derivatives: 0}]);
  });

  it("serializes organization quota admission and uses rolling attempt windows", () => {
    const quotaLocks = migration.match(
      /'opengeo:data-preservation-quota:' \|\| NEW\.organization_id::text/g
    ) ?? [];
    assert.equal(quotaLocks.length, 2);
    assert.match(
      migration,
      /job\.source_dataset_id = NEW\.source_dataset_id\s+AND job\.created_at >= clock_timestamp\(\) - interval '24 hours'\) >= 64/
    );
    assert.match(
      migration,
      /job\.dataset_version_id = NEW\.dataset_version_id\s+AND job\.created_at >= clock_timestamp\(\) - interval '24 hours'\) >= 64/
    );
    assert.match(
      migration,
      /job\.state IN \('queued', 'running'\)\) >= 4/g
    );
    assert.match(migration, /> 10737418240/);
  });

  it("blocks direct SQL detach for every active preservation job role", async () => {
    for (const datasetId of [
      IDS.wmsDataset,
      IDS.snapshotDataset,
      IDS.vectorDataset
    ]) {
      await assert.rejects(
        inTenant(IDS.organization, IDS.owner, () => db.query(
          `DELETE FROM app.project_datasets
           WHERE organization_id = $1 AND project_id = $2 AND dataset_id = $3`,
          [IDS.organization, IDS.project, datasetId]
        )),
        /project dataset has active preservation work/
      );
    }

    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `DELETE FROM app.project_datasets
       WHERE organization_id = $1 AND project_id = $2 AND dataset_id = $3`,
      [IDS.organization, IDS.project, IDS.xyzDataset]
    ));
    const detached = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT count(*)::integer AS value FROM app.project_datasets
       WHERE organization_id = $1 AND project_id = $2 AND dataset_id = $3`,
      [IDS.organization, IDS.project, IDS.xyzDataset]
    ));
    assert.deepEqual(detached.rows, [{value: 0}]);
  });

  it("archives one exact source revision to a server-generated path and lineage", async () => {
    const expectedKey =
      `organizations/${IDS.organization}/projects/${IDS.project}/datasets/${IDS.snapshotDataset}` +
      `/uploads/${IDS.wmsJob}/original/snapshot.png`;
    await asRole("opengeo_source_archiver", async () => {
      await assert.rejects(
        db.query("SELECT * FROM app.external_source_snapshot_jobs"),
        /permission denied/
      );
      const beforeCompletion = await db.query(
        "SELECT * FROM app.get_completed_external_source_snapshot_artifact($1)",
        [IDS.wmsJob]
      );
      assert.deepEqual(beforeCompletion.rows, []);
      const claim = await db.query(
        "SELECT * FROM app.claim_external_source_snapshot($1, $2, 300)",
        [IDS.wmsJob, IDS.archiverToken]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      assert.equal(claim.rows[0].source_revision_number, 1);
      assert.equal(
        claim.rows[0].source_url,
        "https://maps.massgis.digital.mass.gov/geoserver/wms"
      );
      assert.equal(claim.rows[0].maximum_requests, 1);
      assert.equal(claim.rows[0].output_object_key, expectedKey);

      await assert.rejects(
        db.query("SELECT app.complete_external_source_snapshot($1, $2, $3) AS completed", [
          IDS.wmsJob,
          IDS.archiverToken,
          {
            id: IDS.wmsArtifact,
            role: "original",
            bucket: "opengeo-geodata-test",
            object_key: `${expectedKey}.wrong`,
            s3_version_id: "snapshot-version-1",
            etag: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            content_type: "image/png",
            size_bytes: 4096,
            checksum_sha256: SHA_B
          }
        ]),
        /invalid source snapshot artifact/
      );
      const completed = await db.query(
        "SELECT app.complete_external_source_snapshot($1, $2, $3) AS completed",
        [
          IDS.wmsJob,
          IDS.archiverToken,
          {
            id: IDS.wmsArtifact,
            role: "original",
            bucket: "opengeo-geodata-test",
            object_key: expectedKey,
            s3_version_id: "snapshot-version-1",
            etag: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            content_type: "image/png",
            size_bytes: 4096,
            checksum_sha256: SHA_B
          }
        ]
      );
      assert.deepEqual(completed.rows, [{completed: true}]);
      const replay = await db.query(
        "SELECT * FROM app.get_completed_external_source_snapshot_artifact($1)",
        [IDS.wmsJob]
      );
      assert.deepEqual(replay.rows, [{
        snapshot_job_id: IDS.wmsJob,
        bucket: "opengeo-geodata-test",
        object_key: expectedKey,
        s3_version_id: "snapshot-version-1",
        etag: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        content_type: "image/png",
        size_bytes: 4096,
        checksum_sha256: SHA_B
      }]);
    });

    const evidence = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT job.state::text, object.object_key, object.role::text,
              version.state::text AS version_state,
              ingest.state::text AS ingest_state,
              lineage.source_dataset_id, lineage.source_revision_number,
              lineage.destination_dataset_version_id,
              intent.state::text AS intent_state
       FROM app.external_source_snapshot_jobs job
       JOIN app.data_objects object
         ON object.organization_id = job.organization_id AND object.id = job.output_object_id
       JOIN app.dataset_versions version
         ON version.organization_id = job.organization_id
        AND version.id = job.output_dataset_version_id
       JOIN app.processing_jobs ingest
         ON ingest.organization_id = version.organization_id
        AND ingest.dataset_version_id = version.id
        AND ingest.job_type = 'dataset.ingest'
       JOIN app.dataset_version_external_source_lineage lineage
         ON lineage.organization_id = version.organization_id
        AND lineage.destination_dataset_version_id = version.id
       JOIN app.upload_intents intent
         ON intent.organization_id = job.organization_id AND intent.id = job.id
       WHERE job.id = $1`,
      [IDS.wmsJob]
    ));
    assert.deepEqual(evidence.rows, [{
      state: "completed",
      object_key: expectedKey,
      role: "original",
      version_state: "queued",
      ingest_state: "queued",
      source_dataset_id: IDS.wmsDataset,
      source_revision_number: 1,
      destination_dataset_version_id: evidence.rows[0].destination_dataset_version_id,
      intent_state: "completed"
    }]);
  });

  it("converts one exact managed object to PMTiles without outbound-source access", async () => {
    const expectedKey =
      `organizations/${IDS.organization}/projects/${IDS.project}/datasets/${IDS.vectorDataset}` +
      `/versions/${IDS.vectorVersion}/derivatives/tiles/custom/${IDS.pmtilesJob}.pmtiles`;
    await asRole("opengeo_worker", async () => {
      await assert.rejects(
        db.query("SELECT app.claim_external_source_snapshot($1, $2, 300)", [
          IDS.wmsJob,
          IDS.workerToken
        ]),
        /permission denied/
      );
      const claim = await db.query(
        "SELECT * FROM app.claim_pmtiles_derivative($1, $2, 900)",
        [IDS.pmtilesJob, IDS.workerToken]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      assert.equal(claim.rows[0].source_object_id, IDS.vectorObject);
      assert.equal(claim.rows[0].source_checksum_sha256, SHA_A);
      assert.equal(claim.rows[0].output_object_key, expectedKey);
      const completed = await db.query(
        "SELECT app.complete_pmtiles_derivative($1, $2, $3) AS completed",
        [
          IDS.pmtilesJob,
          IDS.workerToken,
          {
            id: IDS.pmtilesArtifact,
            role: "tile",
            bucket: "opengeo-geodata-test",
            object_key: expectedKey,
            s3_version_id: "pmtiles-version-1",
            etag: "cccccccccccccccccccccccccccccccc",
            content_type: "application/vnd.pmtiles",
            size_bytes: 16384,
            checksum_sha256: SHA_C
          }
        ]
      );
      assert.deepEqual(completed.rows, [{completed: true}]);
    });

    const evidence = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT job.state::text, object.object_key, object.role::text,
              lineage.dataset_version_id, lineage.source_object_id,
              lineage.output_object_id, lineage.recipe
       FROM app.pmtiles_derivative_jobs job
       JOIN app.data_objects object
         ON object.organization_id = job.organization_id AND object.id = job.output_object_id
       JOIN app.dataset_version_derivative_lineage lineage
         ON lineage.organization_id = job.organization_id
        AND lineage.pmtiles_job_id = job.id
       WHERE job.id = $1`,
      [IDS.pmtilesJob]
    ));
    assert.deepEqual(evidence.rows, [{
      state: "completed",
      object_key: expectedKey,
      role: "tile",
      dataset_version_id: IDS.vectorVersion,
      source_object_id: IDS.vectorObject,
      output_object_id: IDS.pmtilesArtifact,
      recipe: "gdal-pmtiles-v1"
    }]);
  });

  it("allows an editor to cancel queued work and denies a viewer", async () => {
    await inTenant(IDS.organization, IDS.owner, async () => {
      await insertEstimate({id: IDS.cancelEstimate, checksum: SHA_D});
      await insertSnapshotJob({
        id: IDS.cancelSnapshotJob,
        estimateId: IDS.cancelEstimate,
        destinationDatasetId: IDS.cancelledSnapshotDataset,
        checksum: SHA_D,
        idempotencyKey: "d0000000-0000-4000-8000-000000000058"
      });
      await insertPmtilesJob({
        id: IDS.cancelPmtilesJob,
        checksum: SHA_D,
        idempotencyKey: "d0000000-0000-4000-8000-000000000059"
      });
    });

    const denied = await inTenant(IDS.organization, IDS.viewer, async () => ({
      snapshot: (await db.query(
        "SELECT app.cancel_external_source_snapshot($1,$2,$3,$4,$5) AS value",
        [IDS.organization, IDS.project, IDS.cancelSnapshotJob, IDS.viewer, "viewer-snapshot"]
      )).rows[0].value,
      pmtiles: (await db.query(
        "SELECT app.cancel_pmtiles_derivative($1,$2,$3,$4,$5,$6) AS value",
        [
          IDS.organization,
          IDS.project,
          IDS.vectorDataset,
          IDS.cancelPmtilesJob,
          IDS.viewer,
          "viewer-pmtiles"
        ]
      )).rows[0].value
    }));
    assert.deepEqual(denied, {snapshot: false, pmtiles: false});

    const cancelled = await inTenant(IDS.organization, IDS.owner, async () => ({
      snapshot: (await db.query(
        "SELECT app.cancel_external_source_snapshot($1,$2,$3,$4,$5) AS value",
        [IDS.organization, IDS.project, IDS.cancelSnapshotJob, IDS.owner, "owner-snapshot"]
      )).rows[0].value,
      pmtiles: (await db.query(
        "SELECT app.cancel_pmtiles_derivative($1,$2,$3,$4,$5,$6) AS value",
        [
          IDS.organization,
          IDS.project,
          IDS.vectorDataset,
          IDS.cancelPmtilesJob,
          IDS.owner,
          "owner-pmtiles"
        ]
      )).rows[0].value
    }));
    assert.deepEqual(cancelled, {snapshot: true, pmtiles: true});

    const states = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT 'snapshot' AS kind, state::text, error_code
       FROM app.external_source_snapshot_jobs WHERE id = $1
       UNION ALL
       SELECT 'pmtiles', state::text, error_code
       FROM app.pmtiles_derivative_jobs WHERE id = $2
       ORDER BY kind`,
      [IDS.cancelSnapshotJob, IDS.cancelPmtilesJob]
    ));
    assert.deepEqual(states.rows, [
      {kind: "pmtiles", state: "cancelled", error_code: "cancelled_by_user"},
      {kind: "snapshot", state: "cancelled", error_code: "cancelled_by_user"}
    ]);
    const destination = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT dataset.status::text,
              EXISTS (
                SELECT 1 FROM app.project_datasets link
                WHERE link.organization_id = dataset.organization_id
                  AND link.project_id = $2 AND link.dataset_id = dataset.id
              ) AS linked
       FROM app.datasets dataset
       WHERE dataset.organization_id = $1 AND dataset.id = $3`,
      [IDS.organization, IDS.project, IDS.cancelledSnapshotDataset]
    ));
    assert.deepEqual(destination.rows, [{status: "archived", linked: false}]);
  });

  it("enforces the four-active-derivatives execution bound", async () => {
    await inTenant(IDS.organization, IDS.owner, async () => {
      for (let index = 0; index < 4; index += 1) {
        await insertPmtilesJob({
          id: `93000000-0000-4000-8000-00000000006${index}`,
          checksum: String(index + 1).repeat(64),
          idempotencyKey: `e0000000-0000-4000-8000-00000000006${index}`
        });
      }
    });
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => insertPmtilesJob({
        id: "93000000-0000-4000-8000-000000000064",
        checksum: "5".repeat(64),
        idempotencyKey: "e0000000-0000-4000-8000-000000000064"
      })),
      /PMTiles derivative quota exceeded/
    );
    const active = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT count(*)::integer AS value FROM app.pmtiles_derivative_jobs
       WHERE dataset_id = $1 AND state IN ('queued', 'running')`,
      [IDS.vectorDataset]
    ));
    assert.deepEqual(active.rows, [{value: 4}]);
  });

  it("seals, claims, and completes one bounded source discovery through fixed functions", async () => {
    const serviceUrl = "https://services.example.com/arcgis/rest/services/facilities/FeatureServer";
    const checksum = "0".repeat(64);
    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.external_source_discovery_jobs
         (id, organization_id, project_id, source_type, discovery_kind,
          service_url, collection_ref, request_checksum_sha256,
          idempotency_key, request_id, created_by)
       VALUES ($1, $2, $3, 'arcgis', 'catalog', $4, NULL, $5, $6,
               'source-discovery-create', $7)`,
      [
        IDS.discoveryJob,
        IDS.organization,
        IDS.project,
        serviceUrl,
        checksum,
        "f0000000-0000-4000-8000-000000000058",
        IDS.owner
      ]
    ));

    await asRole("opengeo_source_archiver", async () => {
      await assert.rejects(
        db.query("SELECT id FROM app.external_source_discovery_jobs"),
        /permission denied/
      );
      const claim = await db.query(
        "SELECT * FROM app.claim_external_source_discovery($1, $2, 60)",
        [IDS.discoveryJob, IDS.discoveryToken]
      );
      assert.deepEqual(claim.rows, [{
        claim_status: "claimed",
        job_id: IDS.discoveryJob,
        source_type: "arcgis",
        discovery_kind: "catalog",
        service_url: serviceUrl,
        collection_ref: null,
        attempt_count: 1
      }]);
      await assert.rejects(
        db.query(
          "SELECT app.complete_external_source_discovery($1, $2, $3)",
          [IDS.discoveryJob, IDS.discoveryToken, {schema_version: "wrong"}]
        ),
        /invalid source discovery result/
      );
      const result = {
        schema_version: "opengeo.external-source-discovery-result.1.0.0",
        source_type: "arcgis",
        kind: "catalog",
        service_url: serviceUrl,
        collections: [{
          ref: "0",
          name: "Facilities",
          title: "Facilities",
          geometry_type: "Point",
          bounds: null
        }],
        source_definition: null,
        limitations: ["Select one layer to inspect its fields and stable identity."]
      };
      const completed = await db.query(
        "SELECT app.complete_external_source_discovery($1, $2, $3) AS value",
        [IDS.discoveryJob, IDS.discoveryToken, result]
      );
      assert.deepEqual(completed.rows, [{value: true}]);
    });

    const visible = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT state::text, result->>'schema_version' AS schema_version,
              jsonb_array_length(result->'collections') AS collections
       FROM app.external_source_discovery_jobs WHERE id = $1`,
      [IDS.discoveryJob]
    ));
    assert.deepEqual(visible.rows, [{
      state: "completed",
      schema_version: "opengeo.external-source-discovery-result.1.0.0",
      collections: 1
    }]);
  });

  it("denies viewer creation and permits pre-dispatch owner cancellation", async () => {
    const serviceUrl = "https://maps.example.com/geoserver/wfs";
    const checksum = "0".repeat(64);
    const insert = (createdBy) => db.query(
      `INSERT INTO app.external_source_discovery_jobs
         (id, organization_id, project_id, source_type, discovery_kind,
          service_url, collection_ref, request_checksum_sha256,
          idempotency_key, request_id, created_by)
       VALUES ($1, $2, $3, 'wfs', 'collection', $4, 'public:facilities',
               $5, $6, 'source-discovery-cancel', $7)`,
      [
        IDS.discoveryCancelJob,
        IDS.organization,
        IDS.project,
        serviceUrl,
        checksum,
        "f0000000-0000-4000-8000-000000000059",
        createdBy
      ]
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.viewer, () => insert(IDS.viewer)),
      /row-level security|project edit access/
    );
    await inTenant(IDS.organization, IDS.owner, () => insert(IDS.owner));
    const denied = await inTenant(IDS.organization, IDS.viewer, () => db.query(
      "SELECT app.cancel_external_source_discovery($1,$2,$3,$4,$5) AS value",
      [IDS.organization, IDS.project, IDS.discoveryCancelJob, IDS.viewer, "viewer-cancel"]
    ));
    assert.deepEqual(denied.rows, [{value: false}]);
    const cancelled = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.cancel_external_source_discovery($1,$2,$3,$4,$5) AS value",
      [IDS.organization, IDS.project, IDS.discoveryCancelJob, IDS.owner, "owner-cancel"]
    ));
    assert.deepEqual(cancelled.rows, [{value: true}]);
  });
});
