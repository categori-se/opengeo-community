import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000161",
  otherOrganization: "10000000-0000-4000-8000-000000000162",
  user: "20000000-0000-4000-8000-000000000161",
  otherUser: "20000000-0000-4000-8000-000000000162",
  project: "50000000-0000-4000-8000-000000000161",
  dataset: "80000000-0000-4000-8000-000000000161",
  object: "81000000-0000-4000-8000-000000000161",
  datasetVersion: "82000000-0000-4000-8000-000000000161",
  resource: "a0000000-0000-4000-8000-000000000161",
  resourceVersion: "a1000000-0000-4000-8000-000000000161",
  style: "a2000000-0000-4000-8000-000000000161",
  styleVersion: "a3000000-0000-4000-8000-000000000161",
  profile: "a4000000-0000-4000-8000-000000000161",
  profileVersion: "a5000000-0000-4000-8000-000000000161",
  service: "a6000000-0000-4000-8000-000000000161",
  binding: "a7000000-0000-4000-8000-000000000161",
  renderJob: "a8000000-0000-4000-8000-000000000161",
  renderOutput: "a8100000-0000-4000-8000-000000000161",
  previewObject: "a8200000-0000-4000-8000-000000000161",
  seedRenderJob: "a8300000-0000-4000-8000-000000000161",
  seedRenderOutput: "a8400000-0000-4000-8000-000000000161",
  cancelRenderJob: "a8500000-0000-4000-8000-000000000161",
  cache: "a9000000-0000-4000-8000-000000000161",
  cacheVersion: "aa000000-0000-4000-8000-000000000161",
  nextCacheVersion: "ab000000-0000-4000-8000-000000000161",
  nextProfileVersion: "ad000000-0000-4000-8000-000000000161",
  workerToken: "ae000000-0000-4000-8000-000000000161"
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
  "0040_render_cache_reclamation.sql",
  "0041_durable_tile_seed_plans.sql"
];

let db;
let productionMigration;
let tileCacheMigration;
let reclamationMigration;
let tileSeedPlanMigration;

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

async function insertBinding({
  id = ID.binding,
  name = "roads",
  generation = 1,
  profileVersionId = ID.profileVersion,
  profileVersionNumber = 1
} = {}) {
  return db.query(
    `INSERT INTO app.spatial_service_collections
       (id, organization_id, project_id, service_id, collection_name,
        dataset_id, resource_id, default_profile_id, sealed_feature_generation,
        sealed_profile_version_id, sealed_profile_version_number, title, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Road network',$12)`,
    [
      id,
      ID.organization,
      ID.project,
      ID.service,
      name,
      ID.dataset,
      ID.resource,
      ID.profile,
      generation,
      profileVersionId,
      profileVersionNumber,
      ID.user
    ]
  );
}

describe("0023 administered spatial service catalog", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (["0021_governed_feature_editing.sql", "0022_field_capture.sql"].includes(file)) {
        sql = pgliteSpatialMigration(sql);
      }
      if (file === "0023_spatial_service_catalog.sql") productionMigration = sql;
      if (file === "0024_durable_tile_cache.sql") tileCacheMigration = sql;
      if (file === "0040_render_cache_reclamation.sql") reclamationMigration = sql;
      if (file === "0041_durable_tile_seed_plans.sql") tileSeedPlanMigration = sql;
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'service-user', 'service@example.test', 'Service Publisher'),
        ('${ID.otherUser}', 'other-service-user', 'other@example.test', 'Other User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Services', 'services', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-services', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Service project', '${ID.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${ID.dataset}', '${ID.organization}', 'Roads', 'internal', 'upload',
              'geojson', 'active', '${ID.user}', '${ID.user}', '${ID.user}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${ID.organization}', '${ID.project}', '${ID.dataset}', '${ID.user}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
         etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES ('${ID.object}', '${ID.organization}', '${ID.dataset}', 'original',
              'opengeo-service-test', 'uploads/roads.geojson', 'source-v1',
              '0123456789abcdef', 'application/geo+json', 100,
              '${"1".repeat(64)}', '${ID.user}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number, original_object_id, state,
         extent, crs, geometry_type, created_by)
      VALUES ('${ID.datasetVersion}', '${ID.organization}', '${ID.dataset}', 1,
              '${ID.object}', 'active', '[-1,-1,1,1]', 'EPSG:4326', 'LineString',
              '${ID.user}');
      UPDATE app.datasets SET current_version_id = '${ID.datasetVersion}'
      WHERE organization_id = '${ID.organization}' AND id = '${ID.dataset}';
      INSERT INTO app.feature_collections
        (organization_id, dataset_id, geometry_type, schema_definition,
         generation, feature_count, created_by, updated_by)
      VALUES ('${ID.organization}', '${ID.dataset}', 'LineString',
              '{"schemaVersion":"1.0.0","fields":[{"name":"name","type":"string","required":true}]}',
              1, 0, '${ID.user}', '${ID.user}');

      BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO app.governed_resources
        (id, organization_id, project_id, kind, slug, dataset_id, visibility, state,
         current_version_id, owner_user_id, created_by, updated_by)
      VALUES ('${ID.resource}', '${ID.organization}', '${ID.project}', 'dataset',
              'roads', '${ID.dataset}', 'organization', 'published',
              '${ID.resourceVersion}', '${ID.user}', '${ID.user}', '${ID.user}');
      INSERT INTO app.governed_resource_versions
        (id, organization_id, resource_id, version_number, title, content, created_by)
      VALUES ('${ID.resourceVersion}', '${ID.organization}', '${ID.resource}', 1,
              'Roads', '{"blocks":[]}', '${ID.user}');
      INSERT INTO app.governed_resource_styles
        (id, organization_id, project_id, resource_id, slug, format,
         current_version_id, created_by, updated_by)
      VALUES ('${ID.style}', '${ID.organization}', '${ID.project}', '${ID.resource}',
              'roads-default', 'maplibre', '${ID.styleVersion}', '${ID.user}', '${ID.user}');
      INSERT INTO app.governed_resource_style_versions
        (id, organization_id, style_id, version_number, title, media_type,
         definition, checksum_sha256, created_by)
      VALUES ('${ID.styleVersion}', '${ID.organization}', '${ID.style}', 1,
              'Roads default', 'application/vnd.mapbox.style+json',
              '{"version":8,"sources":{},"layers":[]}', '${"2".repeat(64)}', '${ID.user}');
      INSERT INTO app.map_render_profiles
        (id, organization_id, project_id, resource_id, slug, current_version_id,
         created_by, updated_by)
      VALUES ('${ID.profile}', '${ID.organization}', '${ID.project}', '${ID.resource}',
              'roads-map', '${ID.profileVersion}', '${ID.user}', '${ID.user}');
      INSERT INTO app.map_render_profile_versions
        (id, organization_id, profile_id, resource_id, resource_version_id,
         dataset_id, dataset_version_id, style_id, style_version_id,
         version_number, title, configuration, checksum_sha256, created_by)
      VALUES ('${ID.profileVersion}', '${ID.organization}', '${ID.profile}', '${ID.resource}',
              '${ID.resourceVersion}', '${ID.dataset}', '${ID.datasetVersion}', '${ID.style}',
              '${ID.styleVersion}', 1, 'Roads map',
              '{"schema":"opengeo.render.v1","geometry":{"type":"line","color":"#123456"}}',
              '${"3".repeat(64)}', '${ID.user}');
      COMMIT;
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("defines immutable forced-RLS service seals and denies the worker", () => {
    assert.match(productionMigration, /FORCE ROW LEVEL SECURITY/);
    assert.match(productionMigration, /FROM opengeo_worker/);
    assert.match(productionMigration, /Protocol identifiers are reserved forever/);
    assert.match(productionMigration, /sealed_feature_generation/);
    assert.match(productionMigration, /sealed_profile_version_id/);
    assert.match(productionMigration, /resource\.state = 'published'/);
    assert.match(tileCacheMigration, /FORCE ROW LEVEL SECURITY/g);
    assert.match(tileCacheMigration, /FROM opengeo_worker/);
    assert.match(tileCacheMigration, /reads never create work/);
    assert.match(tileCacheMigration, /entry must target the current version/);
    assert.match(reclamationMigration, /at most 64 unreachable retired-cache render outputs/);
    assert.match(reclamationMigration, /render_cache_output_is_referenced/);
    assert.match(reclamationMigration, /reads and timers never create work/);
    assert.match(tileSeedPlanMigration, /at most 64 exact tiles/);
    assert.match(tileSeedPlanMigration, /previews, reads, and timers never create work/);
    assert.match(tileSeedPlanMigration, /never a second rendering system/);
  });

  it("indexes exact tile renders and invalidates them by advancing immutable policy", async () => {
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `INSERT INTO app.spatial_services
           (id, organization_id, project_id, slug, title, description, created_by)
         VALUES ($1,$2,$3,'research-atlas','Research atlas','Feature map tile pilot',$4)`,
        [ID.service, ID.organization, ID.project, ID.user]
      )
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () => insertBinding({generation: 2})),
      /must seal current governed targets/
    );
    await tenant(ID.organization, ID.user, () => insertBinding());
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.map_render_jobs
           (id, organization_id, project_id, resource_id, profile_id,
            profile_version_id, idempotency_key, bbox, crs, width, height,
            format, background_color, transparent, request_checksum_sha256,
            created_by, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,'ac000000-0000-4000-8000-000000000161',
                 $7,'EPSG:3857',256,256,'png',NULL,true,$8,$9,'tile-cache-test')`,
        [
          ID.renderJob,
          ID.organization,
          ID.project,
          ID.resource,
          ID.profile,
          ID.profileVersion,
          JSON.stringify([
            -20037508.342789244,
            -20037508.342789244,
            20037508.342789244,
            20037508.342789244
          ]),
          "4".repeat(64),
          ID.user
        ]
      );
      await db.exec("SET CONSTRAINTS ALL DEFERRED");
      await db.query(
        `INSERT INTO app.spatial_tile_caches
           (id, organization_id, project_id, service_id, binding_id,
            current_version_id, current_version_number, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7)`,
        [ID.cache, ID.organization, ID.project, ID.service, ID.binding,
          ID.cacheVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.spatial_tile_cache_versions
           (id, organization_id, cache_id, version_number, minimum_tile_matrix,
            maximum_tile_matrix, maximum_entries, change_message, created_by)
         VALUES ($1,$2,$3,1,0,12,100,'Initial bounded cache',$4)`,
        [ID.cacheVersion, ID.organization, ID.cache, ID.user]
      );
      await db.query(
        `INSERT INTO app.spatial_tile_cache_entries
           (organization_id, project_id, cache_id, cache_version_id,
            cache_version_number, tile_matrix, tile_row, tile_col,
            render_job_id, seeded_by)
         VALUES ($1,$2,$3,$4,1,0,0,0,$5,$6)`,
        [ID.organization, ID.project, ID.cache, ID.cacheVersion,
          ID.renderJob, ID.user]
      );
    });

    const visible = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT version.maximum_tile_matrix, entry.render_job_id
         FROM app.spatial_tile_caches cache
         JOIN app.spatial_tile_cache_versions version
           ON version.organization_id = cache.organization_id
          AND version.cache_id = cache.id AND version.id = cache.current_version_id
         JOIN app.spatial_tile_cache_entries entry
           ON entry.organization_id = cache.organization_id
          AND entry.cache_id = cache.id
          AND entry.cache_version_id = cache.current_version_id`
      )
    );
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.spatial_tile_caches")
    );
    assert.deepEqual(visible.rows, [{maximum_tile_matrix: 12, render_job_id: ID.renderJob}]);
    assert.deepEqual(hidden.rows, []);

    await tenant(ID.organization, ID.user, async () => {
      await db.exec("SET CONSTRAINTS ALL DEFERRED");
      await db.query(
        `INSERT INTO app.spatial_tile_cache_versions
           (id, organization_id, cache_id, version_number, minimum_tile_matrix,
            maximum_tile_matrix, maximum_entries, change_message, created_by)
         VALUES ($1,$2,$3,2,0,12,100,'Invalidate exact old tiles',$4)`,
        [ID.nextCacheVersion, ID.organization, ID.cache, ID.user]
      );
      await db.query(
        `UPDATE app.spatial_tile_caches
         SET current_version_id = $1, current_version_number = 2,
             updated_by = $2, updated_at = clock_timestamp()
         WHERE organization_id = $3 AND id = $4`,
        [ID.nextCacheVersion, ID.user, ID.organization, ID.cache]
      );
    });
    const currentEntries = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT entry.id FROM app.spatial_tile_caches cache
         JOIN app.spatial_tile_cache_entries entry
           ON entry.organization_id = cache.organization_id
          AND entry.cache_id = cache.id
          AND entry.cache_version_id = cache.current_version_id`
      )
    );
    assert.deepEqual(currentEntries.rows, []);
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.spatial_tile_cache_entries SET tile_col = 1
           WHERE organization_id = $1 AND cache_id = $2`,
          [ID.organization, ID.cache]
        )
      ),
      /permission denied|history is immutable/
    );
  });

  it("creates one exact current seal and isolates it by tenant", async () => {
    const own = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT service.slug, binding.collection_name,
                binding.sealed_feature_generation,
                binding.sealed_profile_version_number
         FROM app.spatial_services service
         JOIN app.spatial_service_collections binding
           ON binding.organization_id = service.organization_id
          AND binding.service_id = service.id`
      )
    );
    const other = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.spatial_services")
    );
    assert.deepEqual(own.rows, [{
      slug: "research-atlas",
      collection_name: "roads",
      sealed_feature_generation: 1,
      sealed_profile_version_number: 1
    }]);
    assert.deepEqual(other.rows, []);
  });

  it("reserves, publishes, resumes, completes, and pre-dispatch cancels bounded seed plans", async () => {
    await db.exec("RESET ROLE");
    await db.query(
      `INSERT INTO app.data_objects
         (id, organization_id, dataset_id, role, bucket, object_key,
          s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
       VALUES ($1,$2,$3,'derived','opengeo-service-test',
               'organizations/test/derivatives/preview/preview.geojson','preview-v1',
               'bbbbbbbbbbbbbbbb','application/geo+json',128,$4,$5)`,
      [ID.previewObject, ID.organization, ID.dataset, "a".repeat(64), ID.user]
    );
    await db.query(
      `INSERT INTO app.dataset_version_objects
         (organization_id, dataset_id, dataset_version_id, data_object_id)
       VALUES ($1,$2,$3,$4)`,
      [ID.organization, ID.dataset, ID.datasetVersion, ID.previewObject]
    );
    await db.exec("SET ROLE opengeo_runtime");
    const plan = await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.map_render_jobs
           (id, organization_id, project_id, resource_id, profile_id,
            profile_version_id, idempotency_key, bbox, crs, width, height,
            format, background_color, transparent, request_checksum_sha256,
            created_by, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,'a8600000-0000-4000-8000-000000000161',
                 $7,'EPSG:3857',256,256,'png',NULL,true,$8,$9,'seed-plan-test')`,
        [ID.seedRenderJob, ID.organization, ID.project, ID.resource, ID.profile,
          ID.profileVersion, JSON.stringify([
            -20037508.342789244, 0, 0, 20037508.342789244
          ]), "b".repeat(64), ID.user]
      );
      const queued = await db.query(
        `SELECT app.queue_spatial_tile_seed_plan(
           $1,$2,$3,$4,2,'tiles',NULL,1,1,
           ARRAY[1],ARRAY[0],ARRAY[0],1,0,$5,
           clock_timestamp() + interval '10 minutes',$6
         ) AS id`,
        [ID.organization, ID.project, ID.service, ID.binding, "c".repeat(64), ID.user]
      );
      const planId = queued.rows[0].id;
      const resumed = await db.query(
        `SELECT app.queue_spatial_tile_seed_plan(
           $1,$2,$3,$4,2,'tiles',NULL,1,1,
           ARRAY[1],ARRAY[0],ARRAY[0],1,0,$5,
           (SELECT preview_expires_at FROM app.spatial_tile_seed_plans WHERE id=$6),$7
         ) AS id`,
        [ID.organization, ID.project, ID.service, ID.binding,
          "c".repeat(64), planId, ID.user]
      );
      assert.equal(resumed.rows[0].id, planId);
      await db.query(
        "SELECT app.attach_spatial_tile_seed_plan_render($1,$2,1,$3,$4)",
        [ID.organization, planId, ID.seedRenderJob, ID.user]
      );
      const before = await db.query(
        `SELECT count(*)::integer AS count FROM app.spatial_tile_cache_entries
         WHERE cache_id=$1 AND cache_version_number=2`,
        [ID.cache]
      );
      assert.equal(before.rows[0].count, 0);
      const started = await db.query(
        "SELECT app.begin_spatial_tile_seed_plan_dispatch($1,$2,$3) AS state",
        [ID.organization, planId, ID.user]
      );
      assert.equal(started.rows[0].state, "queued");
      return planId;
    });

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claimed = await db.query(
      "SELECT claim_status FROM app.claim_map_render($1,$2,900)",
      [ID.seedRenderJob, ID.workerToken]
    );
    assert.equal(claimed.rows[0].claim_status, "claimed");
    const outputKey = `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/renders/${ID.seedRenderJob}.png`;
    const completed = await db.query(
      "SELECT app.complete_map_render($1,$2,$3) AS completed",
      [ID.seedRenderJob, ID.workerToken, JSON.stringify({
        id: ID.seedRenderOutput,
        role: "derived",
        bucket: "opengeo-service-test",
        object_key: outputKey,
        s3_version_id: "seed-render-v1",
        etag: "cccccccccccccccc",
        content_type: "image/png",
        size_bytes: 256,
        checksum_sha256: "d".repeat(64)
      })]
    );
    assert.equal(completed.rows[0].completed, true);

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const completedPlan = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT plan.state, item.state AS item_state, entry.render_job_id
       FROM app.spatial_tile_seed_plans plan
       JOIN app.spatial_tile_seed_plan_items item
         ON item.organization_id=plan.organization_id AND item.plan_id=plan.id
       JOIN app.spatial_tile_cache_entries entry
         ON entry.organization_id=item.organization_id
        AND entry.cache_id=item.cache_id
        AND entry.cache_version_number=item.cache_version_number
        AND entry.tile_matrix=item.tile_matrix
        AND entry.tile_row=item.tile_row AND entry.tile_col=item.tile_col
       WHERE plan.id=$1`,
      [plan]
    ));
    assert.deepEqual(completedPlan.rows[0], {
      state: "completed",
      item_state: "completed",
      render_job_id: ID.seedRenderJob
    });

    const cancelledPlan = await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.map_render_jobs
           (id, organization_id, project_id, resource_id, profile_id,
            profile_version_id, idempotency_key, bbox, crs, width, height,
            format, background_color, transparent, request_checksum_sha256,
            created_by, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,'a8700000-0000-4000-8000-000000000161',
                 $7,'EPSG:3857',256,256,'png',NULL,true,$8,$9,'seed-cancel-test')`,
        [ID.cancelRenderJob, ID.organization, ID.project, ID.resource, ID.profile,
          ID.profileVersion, JSON.stringify([
            0, -20037508.342789244, 20037508.342789244, 0
          ]), "e".repeat(64), ID.user]
      );
      const queued = await db.query(
        `SELECT app.queue_spatial_tile_seed_plan(
           $1,$2,$3,$4,2,'tiles',NULL,1,1,
           ARRAY[1],ARRAY[1],ARRAY[1],1,0,$5,
           clock_timestamp() + interval '10 minutes',$6
         ) AS id`,
        [ID.organization, ID.project, ID.service, ID.binding, "f".repeat(64), ID.user]
      );
      await db.query(
        "SELECT app.attach_spatial_tile_seed_plan_render($1,$2,1,$3,$4)",
        [ID.organization, queued.rows[0].id, ID.cancelRenderJob, ID.user]
      );
      await db.query(
        "SELECT app.cancel_spatial_tile_seed_plan($1,$2,$3)",
        [ID.organization, queued.rows[0].id, ID.user]
      );
      return queued.rows[0].id;
    });
    const cancelled = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT plan.state, item.state AS item_state,
              EXISTS (
                SELECT 1 FROM app.spatial_tile_cache_entries entry
                WHERE entry.cache_id=plan.cache_id
                  AND entry.cache_version_number=plan.cache_version_number
                  AND entry.tile_matrix=item.tile_matrix
                  AND entry.tile_row=item.tile_row AND entry.tile_col=item.tile_col
              ) AS cache_entry_exists
       FROM app.spatial_tile_seed_plans plan
       JOIN app.spatial_tile_seed_plan_items item
         ON item.organization_id=plan.organization_id AND item.plan_id=plan.id
       WHERE plan.id=$1`,
      [cancelledPlan]
    ));
    assert.deepEqual(cancelled.rows[0], {
      state: "cancelled", item_state: "cancelled", cache_entry_exists: false
    });
  });

  it("reclaims an obsolete retired-generation render as one exact worker batch", async () => {
    const objectKey = `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/renders/${ID.renderJob}.png`;
    await db.exec("RESET ROLE");
    await db.query(
      `INSERT INTO app.data_objects
         (id, organization_id, dataset_id, role, bucket, object_key,
          s3_version_id, etag, content_type, size_bytes,
          checksum_sha256, created_by)
       VALUES ($1,$2,$3,'derived','opengeo-service-test',$4,'render-v1',
               'abcdef0123456789','image/png',256,$5,$6)`,
      [ID.renderOutput, ID.organization, ID.dataset, objectKey,
        "5".repeat(64), ID.user]
    );
    await db.query(
      `INSERT INTO app.dataset_version_objects
         (organization_id, dataset_id, dataset_version_id, data_object_id)
       VALUES ($1,$2,$3,$4)`,
      [ID.organization, ID.dataset, ID.datasetVersion, ID.renderOutput]
    );
    await db.exec("SET session_replication_role = replica");
    await db.query(
      `UPDATE app.map_render_jobs
       SET state = 'completed', output_object_id = $1, attempt_count = 1,
           started_at = clock_timestamp() - interval '26 hours',
           finished_at = clock_timestamp() - interval '25 hours'
       WHERE id = $2`,
      [ID.renderOutput, ID.renderJob]
    );
    await db.query(
      `INSERT INTO app.map_render_profile_versions
         (id, organization_id, profile_id, resource_id, resource_version_id,
          dataset_id, dataset_version_id, style_id, style_version_id,
          version_number, title, configuration, checksum_sha256, created_by)
       SELECT $1, organization_id, profile_id, resource_id, resource_version_id,
              dataset_id, dataset_version_id, style_id, style_version_id,
              2, 'Roads map revised', configuration, $2, created_by
       FROM app.map_render_profile_versions WHERE id = $3`,
      [ID.nextProfileVersion, "6".repeat(64), ID.profileVersion]
    );
    await db.query(
      "UPDATE app.map_render_profiles SET current_version_id = $1 WHERE id = $2",
      [ID.nextProfileVersion, ID.profile]
    );
    await db.query(
      `UPDATE app.spatial_tile_cache_entries
       SET seeded_at = clock_timestamp() - interval '25 hours'
       WHERE render_job_id = $1`,
      [ID.renderJob]
    );
    await db.query(
      `UPDATE app.spatial_tile_cache_versions
       SET created_at = clock_timestamp() - interval '25 hours'
       WHERE id = $1`,
      [ID.nextCacheVersion]
    );
    await db.exec("SET session_replication_role = origin; SET ROLE opengeo_runtime");

    const queued = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT app.queue_spatial_tile_cache_reclamation(
         $1,$2,$3,$4,$5,$6::uuid[],$7,
         clock_timestamp() + interval '10 minutes',$8,'tile-reclaim-1'
       ) AS id`,
      [ID.organization, ID.project, ID.service, ID.binding, ID.cacheVersion,
        [ID.renderJob], "7".repeat(64), ID.user]
    ));
    const reclamationId = queued.rows[0].id;
    const hidden = await tenant(ID.organization, ID.user, () =>
      db.query("SELECT id FROM app.data_objects WHERE id = $1", [ID.renderOutput])
    );
    assert.deepEqual(hidden.rows, []);

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claim = await db.query(
      "SELECT * FROM app.claim_spatial_tile_cache_reclamation($1,$2,900)",
      [reclamationId, ID.workerToken]
    );
    assert.equal(claim.rows[0].claim_status, "claimed");
    assert.equal(claim.rows[0].target_count, 1);
    const targets = await db.query(
      "SELECT * FROM app.get_spatial_tile_cache_reclamation_targets($1,$2)",
      [reclamationId, ID.workerToken]
    );
    assert.equal(targets.rows[0].storage_version_id, "render-v1");
    assert.equal(targets.rows[0].object_key, objectKey);
    const started = await db.query(
      "SELECT app.start_spatial_tile_cache_reclamation_item_delete($1,1,$2) AS started",
      [reclamationId, ID.workerToken]
    );
    assert.equal(started.rows[0].started, true);
    const completed = await db.query(
      "SELECT app.complete_spatial_tile_cache_reclamation_item($1,1,$2) AS completed",
      [reclamationId, ID.workerToken]
    );
    assert.equal(completed.rows[0].completed, true);
    const finished = await db.query(
      "SELECT app.finish_spatial_tile_cache_reclamation($1,$2) AS state",
      [reclamationId, ID.workerToken]
    );
    assert.equal(finished.rows[0].state, "completed");

    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const history = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT job.output_object_id, reclamation.state, item.state AS item_state
       FROM app.map_render_jobs job
       JOIN app.spatial_tile_cache_reclamation_items item
         ON item.organization_id = job.organization_id
        AND item.render_job_id = job.id
       JOIN app.spatial_tile_cache_reclamations reclamation
         ON reclamation.organization_id = item.organization_id
        AND reclamation.id = item.reclamation_id
       WHERE job.id = $1`,
      [ID.renderJob]
    ));
    assert.deepEqual(history.rows[0], {
      output_object_id: ID.renderOutput,
      state: "completed",
      item_state: "completed"
    });
  });

  it("makes target drift observable and prevents seal rewriting", async () => {
    await tenant(ID.organization, ID.user, () =>
      db.query(
        `UPDATE app.feature_collections
         SET generation = 2, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3`,
        [ID.user, ID.organization, ID.dataset]
      )
    );
    const result = await tenant(ID.organization, ID.user, () =>
      db.query(
        `SELECT binding.sealed_feature_generation, collection.generation,
                binding.sealed_profile_version_id = profile.current_version_id AS profile_current
         FROM app.spatial_service_collections binding
         JOIN app.feature_collections collection
           ON collection.organization_id = binding.organization_id
          AND collection.dataset_id = binding.dataset_id
         JOIN app.map_render_profiles profile
           ON profile.organization_id = binding.organization_id
          AND profile.id = binding.default_profile_id
         WHERE binding.id = $1`,
        [ID.binding]
      )
    );
    assert.deepEqual(result.rows, [{
      sealed_feature_generation: 1,
      generation: 2,
      profile_current: false
    }]);
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.spatial_service_collections SET sealed_feature_generation = 2
           WHERE organization_id = $1 AND id = $2`,
          [ID.organization, ID.binding]
        )
      ),
      /collection seal is immutable/
    );
  });

  it("withdraws and disables forward-only while preserving protocol identities", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `UPDATE app.spatial_service_collections
         SET withdrawn_by = $1, withdrawn_at = clock_timestamp()
         WHERE organization_id = $2 AND id = $3`,
        [ID.user, ID.organization, ID.binding]
      );
      await db.query(
        `UPDATE app.spatial_services
         SET disabled_by = $1, disabled_at = clock_timestamp()
         WHERE organization_id = $2 AND id = $3`,
        [ID.user, ID.organization, ID.service]
      );
    });
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `UPDATE app.spatial_services SET disabled_at = NULL, disabled_by = NULL
           WHERE organization_id = $1 AND id = $2`,
          [ID.organization, ID.service]
        )
      ),
      /disable is one-way/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.spatial_services
             (organization_id, project_id, slug, title, created_by)
           VALUES ($1,$2,'research-atlas','Replacement',$3)`,
          [ID.organization, ID.project, ID.user]
        )
      ),
      /duplicate key/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          "DELETE FROM app.spatial_services WHERE organization_id = $1 AND id = $2",
          [ID.organization, ID.service]
        )
      ),
      /permission denied/
    );
  });
});
