import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-0000000000b1",
  otherOrganization: "10000000-0000-4000-8000-0000000000b2",
  owner: "20000000-0000-4000-8000-0000000000b1",
  otherUser: "20000000-0000-4000-8000-0000000000b2",
  project: "50000000-0000-4000-8000-0000000000b1",
  dataset: "80000000-0000-4000-8000-0000000000b1",
  originalObject: "81000000-0000-4000-8000-0000000000b1",
  previewObject: "81000000-0000-4000-8000-0000000000b2",
  outputObject: "81000000-0000-4000-8000-0000000000b3",
  pngOutputObject: "81000000-0000-4000-8000-0000000000b4",
  datasetVersion: "82000000-0000-4000-8000-0000000000b1",
  resource: "a0000000-0000-4000-8000-0000000000b1",
  secondResource: "a0000000-0000-4000-8000-0000000000b2",
  resourceVersion: "a1000000-0000-4000-8000-0000000000b1",
  secondResourceVersion: "a1000000-0000-4000-8000-0000000000b2",
  style: "a2000000-0000-4000-8000-0000000000b1",
  secondStyle: "a2000000-0000-4000-8000-0000000000b2",
  styleVersion: "a3000000-0000-4000-8000-0000000000b1",
  secondStyleVersion: "a3000000-0000-4000-8000-0000000000b2",
  profile: "a4000000-0000-4000-8000-0000000000b1",
  secondProfile: "a4000000-0000-4000-8000-0000000000b2",
  profileVersion: "a5000000-0000-4000-8000-0000000000b1",
  secondProfileVersion: "a5000000-0000-4000-8000-0000000000b2",
  job: "a6000000-0000-4000-8000-0000000000b1",
  pngJob: "a6000000-0000-4000-8000-0000000000b2",
  compositionJob: "a6000000-0000-4000-8000-0000000000b3",
  openCompositionJob: "a6000000-0000-4000-8000-0000000000b4",
  worker: "a7000000-0000-4000-8000-0000000000b1",
  pngWorker: "a7000000-0000-4000-8000-0000000000b2",
  compositionWorker: "a7000000-0000-4000-8000-0000000000b3",
  idempotency: "a8000000-0000-4000-8000-0000000000b1",
  pngIdempotency: "a8000000-0000-4000-8000-0000000000b2",
  compositionIdempotency: "a8000000-0000-4000-8000-0000000000b3",
  openCompositionIdempotency: "a8000000-0000-4000-8000-0000000000b4",
  publication: "a9000000-0000-4000-8000-0000000000b1",
  secondPublication: "a9000000-0000-4000-8000-0000000000b2",
  publicService: "aa000000-0000-4000-8000-0000000000b1",
  secondPublicService: "aa000000-0000-4000-8000-0000000000b2"
};

let db;

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

describe("0011-0016, 0070 and 0085 governed rendering and WMS publication migrations", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
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
      "0070_repeated_map_composition_layers.sql",
      "0084_map_resource_version_bindings.sql",
      "0085_saved_map_render_jobs.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.owner}', 'render-owner', 'owner@example.test', 'Owner'),
        ('${ID.otherUser}', 'render-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Rendering', 'rendering', '${ID.owner}'),
        ('${ID.otherOrganization}', 'Other', 'rendering-other', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.owner}', 'admin', '${ID.owner}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Render project', '${ID.owner}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES
        ('${ID.dataset}', '${ID.organization}', 'Roads', 'internal', 'upload',
         'geojson', 'active', '${ID.owner}', '${ID.owner}', '${ID.owner}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${ID.organization}', '${ID.project}', '${ID.dataset}', '${ID.owner}');
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
         etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${ID.originalObject}', '${ID.organization}', '${ID.dataset}', 'original',
         'opengeo-render-test', 'uploads/original.geojson', 'source-v1',
         '0123456789abcdef', 'application/geo+json', 100,
         '${"1".repeat(64)}', '${ID.owner}');
      INSERT INTO app.dataset_versions
        (id, organization_id, dataset_id, version_number, original_object_id, state,
         extent, crs, geometry_type, created_by)
      VALUES
        ('${ID.datasetVersion}', '${ID.organization}', '${ID.dataset}', 1,
         '${ID.originalObject}', 'active', '[-1,-1,1,1]', 'EPSG:4326',
         'LineString', '${ID.owner}');
      UPDATE app.datasets SET current_version_id = '${ID.datasetVersion}'
      WHERE organization_id = '${ID.organization}' AND id = '${ID.dataset}';
      INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
         etag, content_type, size_bytes, checksum_sha256, created_by)
      VALUES
        ('${ID.previewObject}', '${ID.organization}', '${ID.dataset}', 'derived',
         'opengeo-render-test',
         'organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/preview/preview.geojson',
         'preview-v1', 'fedcba9876543210', 'application/geo+json', 512,
         '${"2".repeat(64)}', '${ID.owner}');
      INSERT INTO app.dataset_version_objects
        (organization_id, dataset_id, dataset_version_id, data_object_id)
      VALUES
        ('${ID.organization}', '${ID.dataset}', '${ID.datasetVersion}', '${ID.previewObject}');

      BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO app.governed_resources
        (id, organization_id, project_id, kind, slug, dataset_id, visibility, state,
         current_version_id, owner_user_id, created_by, updated_by)
      VALUES
        ('${ID.resource}', '${ID.organization}', '${ID.project}', 'dataset',
         'roads', '${ID.dataset}', 'organization', 'review', '${ID.resourceVersion}',
         '${ID.owner}', '${ID.owner}', '${ID.owner}'),
        ('${ID.secondResource}', '${ID.organization}', '${ID.project}', 'dataset',
         'lakes', '${ID.dataset}', 'organization', 'review', '${ID.secondResourceVersion}',
         '${ID.owner}', '${ID.owner}', '${ID.owner}');
      INSERT INTO app.governed_resource_versions
        (id, organization_id, resource_id, version_number, title, content,
         created_by)
      VALUES
        ('${ID.resourceVersion}', '${ID.organization}', '${ID.resource}', 1,
         'Roads', '{"blocks":[]}', '${ID.owner}'),
        ('${ID.secondResourceVersion}', '${ID.organization}', '${ID.secondResource}', 1,
         'Lakes', '{"blocks":[]}', '${ID.owner}');
      INSERT INTO app.governed_resource_styles
        (id, organization_id, project_id, resource_id, slug, format,
         current_version_id, created_by, updated_by)
      VALUES
        ('${ID.style}', '${ID.organization}', '${ID.project}', '${ID.resource}',
         'roads-default', 'maplibre', '${ID.styleVersion}', '${ID.owner}', '${ID.owner}'),
        ('${ID.secondStyle}', '${ID.organization}', '${ID.project}', '${ID.secondResource}',
         'lakes-default', 'maplibre', '${ID.secondStyleVersion}', '${ID.owner}', '${ID.owner}');
      INSERT INTO app.governed_resource_style_versions
        (id, organization_id, style_id, version_number, title, media_type,
         definition, checksum_sha256, created_by)
      VALUES
        ('${ID.styleVersion}', '${ID.organization}', '${ID.style}', 1,
         'Roads default', 'application/vnd.mapbox.style+json',
         '{"version":8,"sources":{},"layers":[]}', '${"3".repeat(64)}', '${ID.owner}'),
        ('${ID.secondStyleVersion}', '${ID.organization}', '${ID.secondStyle}', 1,
         'Lakes default', 'application/vnd.mapbox.style+json',
         '{"version":8,"sources":{},"layers":[]}', '${"9".repeat(64)}', '${ID.owner}');
      COMMIT;
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => db?.close());

  it("stores immutable exact-version profiles and idempotent bounded jobs", async () => {
    await tenant(ID.organization, ID.owner, async () => {
      await db.exec("SET CONSTRAINTS ALL DEFERRED");
      await db.query(`
        INSERT INTO app.map_render_profiles
          (id, organization_id, project_id, resource_id, slug, current_version_id,
           created_by, updated_by)
        VALUES ($1,$2,$3,$4,'roads-svg',$5,$6,$6)
      `, [ID.profile, ID.organization, ID.project, ID.resource, ID.profileVersion, ID.owner]);
      await db.query(`
        INSERT INTO app.map_render_profile_versions
          (id, organization_id, profile_id, resource_id, resource_version_id,
           dataset_id, dataset_version_id, style_id, style_version_id,
           version_number, title, configuration, checksum_sha256, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'Roads SVG',$10,$11,$12)
      `, [
        ID.profileVersion, ID.organization, ID.profile, ID.resource, ID.resourceVersion,
        ID.dataset, ID.datasetVersion, ID.style, ID.styleVersion,
        JSON.stringify({schema: "opengeo.render.v1", geometry: {type: "line", color: "#123456"}}),
        "4".repeat(64), ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_profiles
          (id, organization_id, project_id, resource_id, slug, current_version_id,
           created_by, updated_by)
        VALUES ($1,$2,$3,$4,'lakes-svg',$5,$6,$6)
      `, [
        ID.secondProfile, ID.organization, ID.project, ID.secondResource,
        ID.secondProfileVersion, ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_profile_versions
          (id, organization_id, profile_id, resource_id, resource_version_id,
           dataset_id, dataset_version_id, style_id, style_version_id,
           version_number, title, configuration, checksum_sha256, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'Lakes SVG',$10,$11,$12)
      `, [
        ID.secondProfileVersion, ID.organization, ID.secondProfile, ID.secondResource,
        ID.secondResourceVersion, ID.dataset, ID.datasetVersion, ID.secondStyle,
        ID.secondStyleVersion,
        JSON.stringify({schema: "opengeo.render.v1", geometry: {type: "fill", color: "#357edd"}}),
        "a".repeat(64), ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_jobs
          (id, organization_id, project_id, resource_id, profile_id,
           profile_version_id, idempotency_key, bbox, width, height, format,
           request_checksum_sha256, created_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'[-1,-1,1,1]',640,480,'svg',$8,$9,'render-request-1')
      `, [
        ID.job, ID.organization, ID.project, ID.resource, ID.profile,
        ID.profileVersion, ID.idempotency, "5".repeat(64), ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_jobs
          (id, organization_id, project_id, resource_id, profile_id,
           profile_version_id, idempotency_key, bbox, crs, width, height, format,
           background_color, transparent, request_checksum_sha256, created_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,
                '[-1000000,-1000000,1000000,1000000]','EPSG:3857',1,1,'png',
                '#102030',true,$8,$9,'render-request-png')
      `, [
        ID.pngJob, ID.organization, ID.project, ID.resource, ID.profile,
        ID.profileVersion, ID.pngIdempotency, "7".repeat(64), ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_jobs
          (id, organization_id, project_id, resource_id, profile_id,
           profile_version_id, idempotency_key, bbox, width, height, format,
           request_checksum_sha256, composition_sealed, created_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'[-1,-1,1,1]',256,256,'png',$8,false,$9,
                'render-request-composition')
      `, [
        ID.compositionJob, ID.organization, ID.project, ID.resource, ID.profile,
        ID.profileVersion, ID.compositionIdempotency, "b".repeat(64), ID.owner
      ]);
      await db.query(`
        INSERT INTO app.map_render_job_layers
          (organization_id, render_job_id, position, resource_id, profile_id,
           profile_version_id)
        VALUES ($1,$2,2,$3,$4,$5)
      `, [
        ID.organization, ID.compositionJob, ID.secondResource, ID.secondProfile,
        ID.secondProfileVersion
      ]);
      const sealed = await db.query(
        "SELECT app.seal_map_render_composition($1) AS sealed",
        [ID.compositionJob]
      );
      assert.equal(sealed.rows[0].sealed, true);
      await db.query(`
        INSERT INTO app.map_render_jobs
          (id, organization_id, project_id, resource_id, profile_id,
           profile_version_id, idempotency_key, bbox, width, height, format,
           request_checksum_sha256, composition_sealed, created_by, request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'[-1,-1,1,1]',256,256,'svg',$8,false,$9,
                'render-request-open-composition')
      `, [
        ID.openCompositionJob, ID.organization, ID.project, ID.resource, ID.profile,
        ID.profileVersion, ID.openCompositionIdempotency, "c".repeat(64), ID.owner
      ]);
    });
    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.organization_id', $1, true)", [ID.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [ID.owner]);
    await assert.rejects(
      db.query("UPDATE app.map_render_profile_versions SET title='Changed' WHERE id=$1", [ID.profileVersion]),
      /permission denied/
    );
    await db.exec("ROLLBACK");
  });

  it("hides rendering records across tenants and keeps the worker function-only", async () => {
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.map_render_jobs WHERE id=$1", [ID.job])
    );
    assert.equal(hidden.rows.length, 0);
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT * FROM app.map_render_jobs"),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("seals ordered multi-layer snapshots before worker claim", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.otherUser, () => db.query(`
        INSERT INTO app.map_render_job_layers
          (organization_id, render_job_id, position, resource_id, profile_id,
           profile_version_id)
        VALUES ($1,$2,2,$3,$4,$5)
      `, [
        ID.organization, ID.openCompositionJob, ID.secondResource, ID.secondProfile,
        ID.secondProfileVersion
      ])),
      /composition creator mismatch/
    );
    await tenant(ID.organization, ID.owner, async () => {
      await db.query(`
        INSERT INTO app.map_render_job_layers
          (organization_id, render_job_id, position, resource_id, profile_id,
           profile_version_id)
        VALUES ($1,$2,2,$3,$4,$5)
      `, [
        ID.organization, ID.openCompositionJob, ID.resource, ID.profile,
        ID.profileVersion
      ]);
      const sealed = await db.query(
        "SELECT app.seal_map_render_composition($1) AS sealed",
        [ID.openCompositionJob]
      );
      assert.equal(sealed.rows[0].sealed, true);
    });
    const repeated = await tenant(ID.organization, ID.owner, () => db.query(`
      SELECT array_agg(layer.resource_id ORDER BY layer.position) AS resources,
             array_agg(layer.profile_id ORDER BY layer.position) AS profiles
      FROM app.map_render_job_layers layer
      WHERE layer.render_job_id=$1
    `, [ID.openCompositionJob]));
    assert.deepEqual(repeated.rows[0], {
      resources: [ID.resource, ID.resource],
      profiles: [ID.profile, ID.profile]
    });
    const composition = await tenant(ID.organization, ID.owner, () => db.query(`
      SELECT job.composition_sealed,
             array_agg(layer.position ORDER BY layer.position) AS positions,
             array_agg(layer.resource_id ORDER BY layer.position) AS resources
      FROM app.map_render_jobs job
      JOIN app.map_render_job_layers layer
        ON layer.organization_id=job.organization_id AND layer.render_job_id=job.id
      WHERE job.id=$1
      GROUP BY job.composition_sealed
    `, [ID.compositionJob]));
    assert.deepEqual(composition.rows[0], {
      composition_sealed: true,
      positions: [1, 2],
      resources: [ID.resource, ID.secondResource]
    });
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.map_render_job_layers
          (organization_id, render_job_id, position, resource_id, profile_id,
           profile_version_id)
        VALUES ($1,$2,3,$3,$4,$5)
      `, [
        ID.organization, ID.compositionJob, ID.secondResource, ID.secondProfile,
        ID.secondProfileVersion
      ])),
      /composition is sealed/
    );

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claimed = await db.query(
      "SELECT claim_status FROM app.claim_map_render($1,$2,900)",
      [ID.compositionJob, ID.compositionWorker]
    );
    assert.equal(claimed.rows[0].claim_status, "claimed");
    const layers = await db.query(
      "SELECT * FROM app.get_map_render_layers($1,$2)",
      [ID.compositionJob, ID.compositionWorker]
    );
    assert.deepEqual(layers.rows.map((layer) => ({
      position: layer.layer_position,
      resource: layer.resource_id,
      profile: layer.profile_id,
      source: layer.source_object_id
    })), [
      {position: 1, resource: ID.resource, profile: ID.profile, source: ID.previewObject},
      {
        position: 2,
        resource: ID.secondResource,
        profile: ID.secondProfile,
        source: ID.previewObject
      }
    ]);
    const failed = await db.query(
      "SELECT app.fail_map_render($1,$2,'composition-test') AS failed",
      [ID.compositionJob, ID.compositionWorker]
    );
    assert.equal(failed.rows[0].failed, true);
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("publishes exact WMS names only for published targets and makes withdrawal one-way", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.wms_layer_publications
          (id, organization_id, project_id, resource_id, wms_name,
           default_profile_id, created_by)
        VALUES ($1,$2,$3,$4,'cite:RoadSegments',$5,$6)
      `, [
        ID.publication, ID.organization, ID.project, ID.resource, ID.profile, ID.owner
      ])),
      /target must be a published map resource/
    );

    await tenant(ID.organization, ID.owner, async () => {
      await db.query(
        "UPDATE app.governed_resources SET state='published' WHERE id IN ($1,$2)",
        [ID.resource, ID.secondResource]
      );
      await db.query(`
        INSERT INTO app.wms_layer_publications
          (id, organization_id, project_id, resource_id, wms_name,
           default_profile_id, created_by)
        VALUES ($1,$2,$3,$4,'cite:RoadSegments',$5,$6)
      `, [
        ID.publication, ID.organization, ID.project, ID.resource, ID.profile, ID.owner
      ]);
    });

    const publication = await tenant(ID.organization, ID.owner, () => db.query(`
      SELECT wms_name, resource_id, default_profile_id,
             withdrawn_by, withdrawn_at
      FROM app.wms_layer_publications WHERE id=$1
    `, [ID.publication]));
    assert.deepEqual(publication.rows[0], {
      wms_name: "cite:RoadSegments",
      resource_id: ID.resource,
      default_profile_id: ID.profile,
      withdrawn_by: null,
      withdrawn_at: null
    });

    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.wms_layer_publications
          (id, organization_id, project_id, resource_id, wms_name,
           default_profile_id, created_by)
        VALUES ($1,$2,$3,$4,'CITE:roadsegments',$5,$6)
      `, [
        ID.secondPublication, ID.organization, ID.project, ID.secondResource,
        ID.secondProfile, ID.owner
      ])),
      /duplicate key/
    );
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(
        "UPDATE app.wms_layer_publications SET wms_name='cite:Roads' WHERE id=$1",
        [ID.publication]
      )),
      /identity is immutable/
    );
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(
        "DELETE FROM app.wms_layer_publications WHERE id=$1", [ID.publication]
      )),
      /permission denied/
    );
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.wms_layer_publications
          (id, organization_id, project_id, resource_id, wms_name,
           default_profile_id, created_by)
        VALUES ($1,$2,$3,$4,'cite:Lakes',$5,$6)
      `, [
        ID.secondPublication, ID.organization, ID.project, ID.secondResource,
        ID.secondProfile, ID.otherUser
      ])),
      /creator mismatch/
    );

    await tenant(ID.organization, ID.owner, () => db.query(`
      UPDATE app.wms_layer_publications
      SET withdrawn_by=$1, withdrawn_at=clock_timestamp()
      WHERE id=$2
    `, [ID.owner, ID.publication]));
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        UPDATE app.wms_layer_publications
        SET withdrawn_by=NULL, withdrawn_at=NULL WHERE id=$1
      `, [ID.publication])),
      /one-way and actor-bound/
    );

    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.wms_layer_publications WHERE id=$1", [ID.publication])
    );
    assert.equal(hidden.rows.length, 0);
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT * FROM app.wms_layer_publications"),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("enables a read-only public WMS service only for active public layers", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.public_wms_services
          (id, organization_id, project_id, title, created_by)
        VALUES ($1,$2,$3,'Public CITE WMS',$4)
      `, [ID.publicService, ID.organization, ID.project, ID.owner])),
      /requires an active public layer publication/
    );

    await tenant(ID.organization, ID.owner, async () => {
      await db.query(
        "UPDATE app.governed_resources SET visibility='public' WHERE id=$1",
        [ID.secondResource]
      );
      await db.query(`
        INSERT INTO app.wms_layer_publications
          (id, organization_id, project_id, resource_id, wms_name,
           default_profile_id, created_by)
        VALUES ($1,$2,$3,$4,'cite:Lakes',$5,$6)
      `, [
        ID.secondPublication, ID.organization, ID.project, ID.secondResource,
        ID.secondProfile, ID.owner
      ]);
      await db.query(`
        INSERT INTO app.public_wms_services
          (id, organization_id, project_id, title, created_by)
        VALUES ($1,$2,$3,'Public CITE WMS',$4)
      `, [ID.publicService, ID.organization, ID.project, ID.owner]);
    });

    const service = await tenant(ID.organization, ID.owner, () => db.query(`
      SELECT title, created_by, disabled_by, disabled_at
      FROM app.public_wms_services WHERE id=$1
    `, [ID.publicService]));
    assert.deepEqual(service.rows[0], {
      title: "Public CITE WMS",
      created_by: ID.owner,
      disabled_by: null,
      disabled_at: null
    });
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(
        "UPDATE app.public_wms_services SET title='Changed' WHERE id=$1",
        [ID.publicService]
      )),
      /identity is immutable/
    );
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(
        "DELETE FROM app.public_wms_services WHERE id=$1", [ID.publicService]
      )),
      /permission denied/
    );
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.public_wms_services WHERE id=$1", [ID.publicService])
    );
    assert.equal(hidden.rows.length, 0);

    await tenant(ID.organization, ID.owner, () => db.query(`
      UPDATE app.public_wms_services
      SET disabled_by=$1, disabled_at=clock_timestamp()
      WHERE id=$2
    `, [ID.owner, ID.publicService]));
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        UPDATE app.public_wms_services
        SET disabled_by=NULL, disabled_at=NULL WHERE id=$1
      `, [ID.publicService])),
      /one-way and actor-bound/
    );
    await assert.rejects(
      tenant(ID.organization, ID.owner, () => db.query(`
        INSERT INTO app.public_wms_services
          (id, organization_id, project_id, title, created_by)
        VALUES ($1,$2,$3,'Replacement public WMS',$4)
      `, [ID.secondPublicService, ID.organization, ID.project, ID.otherUser])),
      /creator mismatch/
    );

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT * FROM app.public_wms_services"),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("claims and completes one exact preview render with immutable output lineage", async () => {
    const source = await tenant(ID.organization, ID.owner, () => db.query(`
      SELECT object.id, object.role::text, object.content_type, object.object_key
      FROM app.map_render_jobs job
      JOIN app.map_render_profile_versions profile
        ON profile.organization_id=job.organization_id
       AND profile.profile_id=job.profile_id AND profile.id=job.profile_version_id
      JOIN app.dataset_version_objects link
        ON link.organization_id=profile.organization_id
       AND link.dataset_id=profile.dataset_id
       AND link.dataset_version_id=profile.dataset_version_id
      JOIN app.data_objects object
        ON object.organization_id=link.organization_id AND object.id=link.data_object_id
      WHERE job.id=$1 AND object.role='derived'
        AND object.content_type='application/geo+json'
        AND object.object_key LIKE '%/derivatives/preview/preview.geojson'
    `, [ID.job]));
    assert.equal(source.rows[0].id, ID.previewObject);
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claimed = await db.query(
      "SELECT * FROM app.claim_map_render($1,$2,900)",
      [ID.job, ID.worker]
    );
    assert.equal(claimed.rows[0].claim_status, "claimed");
    assert.equal(claimed.rows[0].source_object_id, ID.previewObject);
    assert.equal(claimed.rows[0].style_version_id, ID.styleVersion);
    assert.equal(claimed.rows[0].request_format, "svg");
    assert.equal(
      await db.query("SELECT app.heartbeat_map_render($1,$2,900) AS active", [ID.job, ID.worker])
        .then((result) => result.rows[0].active),
      true
    );
    const key = `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/renders/${ID.job}.svg`;
    const completed = await db.query(
      "SELECT app.complete_map_render($1,$2,$3) AS completed",
      [ID.job, ID.worker, JSON.stringify({
        id: ID.outputObject,
        role: "derived",
        bucket: "opengeo-render-test",
        object_key: key,
        s3_version_id: "render-v1",
        etag: "aaaaaaaaaaaaaaaa",
        content_type: "image/svg+xml",
        size_bytes: 2048,
        checksum_sha256: "6".repeat(64)
      })]
    );
    assert.equal(completed.rows[0].completed, true);
    const duplicate = await db.query(
      "SELECT claim_status FROM app.claim_map_render($1,$2,900)",
      [ID.job, ID.worker]
    );
    assert.equal(duplicate.rows[0].claim_status, "already_completed");
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const result = await tenant(ID.organization, ID.owner, () =>
      db.query(`
        SELECT job.state::text, object.checksum_sha256,
               EXISTS (
                 SELECT 1 FROM app.activity_events event
                 WHERE event.event_type='map.render.completed' AND event.resource_id=$1
               ) AS audited
        FROM app.map_render_jobs job
        JOIN app.data_objects object
          ON object.organization_id=job.organization_id AND object.id=job.output_object_id
        WHERE job.id=$2
      `, [ID.resource, ID.job])
    );
    assert.deepEqual(result.rows[0], {
      state: "completed",
      checksum_sha256: "6".repeat(64),
      audited: true
    });
  });

  it("claims and completes an exact EPSG:3857 PNG with format-specific lineage", async () => {
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    const claimed = await db.query(
      "SELECT * FROM app.claim_map_render($1,$2,900)",
      [ID.pngJob, ID.pngWorker]
    );
    assert.equal(claimed.rows[0].claim_status, "claimed");
    assert.equal(claimed.rows[0].request_crs, "EPSG:3857");
    assert.equal(claimed.rows[0].request_format, "png");
    assert.equal(claimed.rows[0].request_width, 1);
    assert.equal(claimed.rows[0].request_height, 1);
    assert.deepEqual(claimed.rows[0].request_bbox, [-1000000, -1000000, 1000000, 1000000]);
    const presentation = await db.query(
      "SELECT * FROM app.get_map_render_presentation($1,$2)",
      [ID.pngJob, ID.pngWorker]
    );
    assert.deepEqual(presentation.rows[0], {
      background_color: "#102030",
      transparent: true
    });
    const hiddenPresentation = await db.query(
      "SELECT * FROM app.get_map_render_presentation($1,$2)",
      [ID.pngJob, ID.worker]
    );
    assert.equal(hiddenPresentation.rows.length, 0);
    const key = `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.dataset}/versions/${ID.datasetVersion}/derivatives/renders/${ID.pngJob}.png`;
    const completed = await db.query(
      "SELECT app.complete_map_render($1,$2,$3) AS completed",
      [ID.pngJob, ID.pngWorker, JSON.stringify({
        id: ID.pngOutputObject,
        role: "derived",
        bucket: "opengeo-render-test",
        object_key: key,
        s3_version_id: "render-png-v1",
        etag: "bbbbbbbbbbbbbbbb",
        content_type: "image/png",
        size_bytes: 4096,
        checksum_sha256: "8".repeat(64)
      })]
    );
    assert.equal(completed.rows[0].completed, true);
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    const result = await tenant(ID.organization, ID.owner, () =>
      db.query(`
        SELECT job.crs, job.format::text, object.content_type,
               event.payload->>'crs' AS audit_crs,
               event.payload->>'format' AS audit_format
        FROM app.map_render_jobs job
        JOIN app.data_objects object
          ON object.organization_id=job.organization_id AND object.id=job.output_object_id
        JOIN app.activity_events event
          ON event.organization_id=job.organization_id
         AND event.event_type='map.render.completed'
         AND event.payload->>'render_job_id'=job.id::text
        WHERE job.id=$1
      `, [ID.pngJob])
    );
    assert.deepEqual(result.rows[0], {
      crs: "EPSG:3857",
      format: "png",
      content_type: "image/png",
      audit_crs: "EPSG:3857",
      audit_format: "png"
    });
  });
});
