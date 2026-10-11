import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000168",
  otherOrganization: "10000000-0000-4000-8000-000000000268",
  user: "20000000-0000-4000-8000-000000000168",
  otherUser: "20000000-0000-4000-8000-000000000268",
  project: "50000000-0000-4000-8000-000000000168",
  dataset: "80000000-0000-4000-8000-000000000168",
  object: "81000000-0000-4000-8000-000000000168",
  datasetVersion: "82000000-0000-4000-8000-000000000168",
  resource: "a0000000-0000-4000-8000-000000000168",
  resourceVersion: "a1000000-0000-4000-8000-000000000168",
  style: "a2000000-0000-4000-8000-000000000168",
  styleVersion: "a3000000-0000-4000-8000-000000000168",
  alternateStyle: "a2100000-0000-4000-8000-000000000168",
  alternateStyleVersion: "a3100000-0000-4000-8000-000000000168",
  profile: "a4000000-0000-4000-8000-000000000168",
  profileVersion: "a5000000-0000-4000-8000-000000000168",
  alternateProfile: "a4100000-0000-4000-8000-000000000168",
  alternateProfileVersion: "a5100000-0000-4000-8000-000000000168",
  service: "a6000000-0000-4000-8000-000000000168",
  collection: "a7000000-0000-4000-8000-000000000168",
  upgradedService: "a6100000-0000-4000-8000-000000000168",
  upgradedCollection: "a7100000-0000-4000-8000-000000000168",
  upgradedBinding: "ab200000-0000-4000-8000-000000000168",
  metadataVersion: "a8000000-0000-4000-8000-000000000168",
  group: "a9000000-0000-4000-8000-000000000168",
  groupVersion: "aa000000-0000-4000-8000-000000000168",
  alternateBinding: "ab000000-0000-4000-8000-000000000168",
  replacementBinding: "ab100000-0000-4000-8000-000000000168",
  connection: "c1000000-0000-4000-8000-000000000168",
  connectionVerification: "c2000000-0000-4000-8000-000000000168"
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
  "0023_spatial_service_catalog.sql",
  "0047_governed_external_connections.sql",
  "0048_external_connection_verification.sql"
];

let db;
let migration;

async function load(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
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
      /CREATE INDEX dataset_features_geometry_idx\s+ON app\.dataset_features USING gist \(geometry\)\s+WHERE deleted_at IS NULL;/s,
      ""
    )
    .replaceAll("ST_Equals(revision.geometry, NEW.geometry)", "revision.geometry = NEW.geometry")
    .replaceAll(
      "NOT ST_Equals(OLD.geometry, NEW.geometry)",
      "OLD.geometry IS DISTINCT FROM NEW.geometry"
    );
}

async function tenant(organizationId, userId, operation) {
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

describe("0068-0069 native spatial catalog administration and render consumption", () => {
  before(async () => {
    db = new PGlite();
    for (const name of migrations) {
      let sql = await load(name);
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (name === "0021_governed_feature_editing.sql") sql = pgliteSpatialMigration(sql);
      await db.exec(sql);
    }
    await db.exec("CREATE ROLE opengeo_source_archiver;");
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${ID.user}', 'catalog-admin', 'catalog@example.test', 'Catalog Admin'),
        ('${ID.otherUser}', 'other-catalog', 'other@example.test', 'Other Admin');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${ID.organization}', 'Catalog', 'catalog', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-catalog', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Catalog project', '${ID.user}');
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
              'catalog-test', 'roads.geojson', 'v1', '0123456789abcdef',
              'application/geo+json', 100, '${"1".repeat(64)}', '${ID.user}');
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
              '{"schemaVersion":"1.0.0","fields":[]}', 1, 0,
              '${ID.user}', '${ID.user}');

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
              'roads-default', 'maplibre', '${ID.styleVersion}', '${ID.user}', '${ID.user}'),
             ('${ID.alternateStyle}', '${ID.organization}', '${ID.project}', '${ID.resource}',
              'roads-night', 'maplibre', '${ID.alternateStyleVersion}',
              '${ID.user}', '${ID.user}');
      INSERT INTO app.governed_resource_style_versions
        (id, organization_id, style_id, version_number, title, media_type,
         definition, checksum_sha256, created_by)
      VALUES ('${ID.styleVersion}', '${ID.organization}', '${ID.style}', 1,
              'Roads default', 'application/vnd.mapbox.style+json',
              '{"version":8,"sources":{},"layers":[]}', '${"2".repeat(64)}', '${ID.user}'),
             ('${ID.alternateStyleVersion}', '${ID.organization}', '${ID.alternateStyle}', 1,
              'Roads night', 'application/vnd.mapbox.style+json',
              '{"version":8,"sources":{},"layers":[]}', '${"4".repeat(64)}', '${ID.user}');
      INSERT INTO app.map_render_profiles
        (id, organization_id, project_id, resource_id, slug, current_version_id,
         created_by, updated_by)
      VALUES ('${ID.profile}', '${ID.organization}', '${ID.project}', '${ID.resource}',
              'roads-map', '${ID.profileVersion}', '${ID.user}', '${ID.user}'),
             ('${ID.alternateProfile}', '${ID.organization}', '${ID.project}', '${ID.resource}',
              'roads-night-map', '${ID.alternateProfileVersion}', '${ID.user}', '${ID.user}');
      INSERT INTO app.map_render_profile_versions
        (id, organization_id, profile_id, resource_id, resource_version_id,
         dataset_id, dataset_version_id, style_id, style_version_id,
         version_number, title, configuration, checksum_sha256, created_by)
      VALUES ('${ID.profileVersion}', '${ID.organization}', '${ID.profile}', '${ID.resource}',
              '${ID.resourceVersion}', '${ID.dataset}', '${ID.datasetVersion}', '${ID.style}',
              '${ID.styleVersion}', 1, 'Roads map',
              '{"schema":"opengeo.render.v1","geometry":{"type":"line"}}',
              '${"3".repeat(64)}', '${ID.user}'),
             ('${ID.alternateProfileVersion}', '${ID.organization}',
              '${ID.alternateProfile}', '${ID.resource}', '${ID.resourceVersion}',
              '${ID.dataset}', '${ID.datasetVersion}', '${ID.alternateStyle}',
              '${ID.alternateStyleVersion}', 1, 'Roads night map',
              '{"schema":"opengeo.render.v1","geometry":{"type":"line"}}',
              '${"5".repeat(64)}', '${ID.user}');
      INSERT INTO app.spatial_services
        (id, organization_id, project_id, slug, title, description, created_by)
      VALUES ('${ID.service}', '${ID.organization}', '${ID.project}',
              'research-atlas', 'Research atlas', 'Initial description', '${ID.user}'),
             ('${ID.upgradedService}', '${ID.organization}', '${ID.project}',
              'upgraded-atlas', 'Upgraded atlas', '0068 default replacement', '${ID.user}');
      INSERT INTO app.spatial_service_collections
        (id, organization_id, project_id, service_id, collection_name,
         dataset_id, resource_id, default_profile_id, sealed_feature_generation,
         sealed_profile_version_id, sealed_profile_version_number, title, created_by)
      VALUES ('${ID.collection}', '${ID.organization}', '${ID.project}', '${ID.service}',
              'roads', '${ID.dataset}', '${ID.resource}', '${ID.profile}', 1,
              '${ID.profileVersion}', 1, 'Roads', '${ID.user}'),
             ('${ID.upgradedCollection}', '${ID.organization}', '${ID.project}',
              '${ID.upgradedService}', 'roads', '${ID.dataset}', '${ID.resource}',
              '${ID.profile}', 1, '${ID.profileVersion}', 1, 'Roads', '${ID.user}');
      COMMIT;
    `);
    migration = await load("0068_spatial_catalog_administration.sql");
    await db.exec(migration);
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `UPDATE app.spatial_service_collection_styles
         SET withdrawn_by=$1, withdrawn_at=clock_timestamp()
         WHERE organization_id=$2 AND collection_id=$3
           AND is_default AND withdrawn_at IS NULL`,
        [ID.user, ID.organization, ID.upgradedCollection]
      );
      await db.query(
        `INSERT INTO app.spatial_service_collection_styles
           (id, organization_id, project_id, service_id, collection_id,
            style_name, style_id, sealed_style_version_id,
            sealed_style_version_number, is_default, created_by)
         VALUES ($1,$2,$3,$4,$5,'roads-night',$6,$7,1,true,$8)`,
        [ID.upgradedBinding, ID.organization, ID.project, ID.upgradedService,
          ID.upgradedCollection, ID.alternateStyle, ID.alternateStyleVersion,
          ID.user]
      );
    });
    const renderMigration = await load("0069_spatial_catalog_render_profiles.sql");
    await db.exec(renderMigration);
    migration += renderMigration;
    await db.exec(`
      INSERT INTO app.external_connections
        (id, organization_id, project_id, provider, display_name, endpoint_host,
         database_name, allowed_schemas, secret_arn, configured_secret_fields,
         created_by, updated_by)
      VALUES ('${ID.connection}', '${ID.organization}', '${ID.project}', 'postgresql',
              'Verified research PostGIS', 'db.example.test', 'research', ARRAY['public'],
              'arn:aws:secretsmanager:us-east-1:123456789012:secret:opengeo/catalog/test',
              ARRAY['password','username'], '${ID.user}', '${ID.user}');
      INSERT INTO app.external_connection_revisions
        (organization_id, project_id, connection_id, revision_number,
         configuration, change_summary, created_by)
      VALUES ('${ID.organization}', '${ID.project}', '${ID.connection}', 1,
              '{"provider":"postgresql","endpointHost":"db.example.test","endpointPort":5432,"databaseName":"research","allowedSchemas":["public"],"readOnly":true,"tlsMode":"verify_full","networkMode":"public_internet"}',
              'Initial read-only connection', '${ID.user}');
      INSERT INTO app.external_connection_verifications
        (id, organization_id, project_id, connection_id,
         connection_revision_number, state, attempt_count, requested_by,
         request_id, network_reachable, tls_verified, credentials_verified,
         postgis_verified, duration_ms, started_at, finished_at)
      VALUES ('${ID.connectionVerification}', '${ID.organization}', '${ID.project}',
              '${ID.connection}', 1, 'succeeded', 1, '${ID.user}',
              'catalog-resolution-verification', true, true, true, true, 25,
              clock_timestamp() - interval '1 second', clock_timestamp());
      UPDATE app.external_connections
      SET status='credentials_verified', last_verified_at=clock_timestamp()
      WHERE organization_id='${ID.organization}' AND id='${ID.connection}';
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("backfills one metadata revision, managed store, and exact default style", async () => {
    const result = await tenant(ID.organization, ID.user, () => db.query(`
      SELECT service.current_metadata_version_number,
             metadata.title, store.slug, store.kind::text,
             binding.store_id = store.id AS store_bound,
             style_binding.style_name, style_binding.is_default,
             style_binding.sealed_style_version_number,
             style_binding.render_profile_id,
             style_binding.sealed_profile_version_number
      FROM app.spatial_services service
      JOIN app.spatial_service_metadata_versions metadata
        ON metadata.organization_id = service.organization_id
       AND metadata.id = service.current_metadata_version_id
      JOIN app.spatial_service_stores store
        ON store.organization_id = service.organization_id
       AND store.service_id = service.id
      JOIN app.spatial_service_collections binding
        ON binding.organization_id = service.organization_id
       AND binding.service_id = service.id
      JOIN app.spatial_service_collection_styles style_binding
        ON style_binding.organization_id = binding.organization_id
       AND style_binding.collection_id = binding.id
      WHERE service.id = '${ID.service}'
    `));
    assert.deepEqual(result.rows, [{
      current_metadata_version_number: 1,
      title: "Research atlas",
      slug: "managed",
      kind: "managed_project",
      store_bound: true,
      style_name: "roads-default",
      is_default: true,
      sealed_style_version_number: 1,
      render_profile_id: ID.profile,
      sealed_profile_version_number: 1
    }]);
  });

  it("resolves a pre-0069 replacement default by its exact style revision", async () => {
    const result = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT style_name, style_id, render_profile_id,
              sealed_profile_version_id, sealed_profile_version_number
       FROM app.spatial_service_collection_styles
       WHERE organization_id=$1 AND collection_id=$2
         AND is_default AND withdrawn_at IS NULL`,
      [ID.organization, ID.upgradedCollection]
    ));
    assert.deepEqual(result.rows, [{
      style_name: "roads-night",
      style_id: ID.alternateStyle,
      render_profile_id: ID.alternateProfile,
      sealed_profile_version_id: ID.alternateProfileVersion,
      sealed_profile_version_number: 1
    }]);
  });

  it("advances service metadata and ordered layer groups with exact CAS heads", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.exec("SET CONSTRAINTS ALL DEFERRED");
      await db.query(
        `INSERT INTO app.spatial_service_metadata_versions
           (id, organization_id, project_id, service_id, version_number,
            title, abstract, namespace_uri, keywords, access_constraints,
            contact, enabled_protocols, change_message, created_by)
         VALUES ($1,$2,$3,$4,2,'Research catalog','Current catalog metadata',
                 'https://example.test/ns/research',ARRAY['roads'],ARRAY['none'],
                 '{"name":"Catalog Admin"}',ARRAY['wms_1_3','wfs_2_0'],
                 'Add service metadata',$5)`,
        [ID.metadataVersion, ID.organization, ID.project, ID.service, ID.user]
      );
      await db.query(
        `UPDATE app.spatial_services
         SET current_metadata_version_id=$1, current_metadata_version_number=2,
             updated_by=$2, updated_at=updated_at + interval '1 second'
         WHERE organization_id=$3 AND id=$4`,
        [ID.metadataVersion, ID.user, ID.organization, ID.service]
      );
      await db.query(
        `INSERT INTO app.spatial_service_layer_groups
           (id, organization_id, project_id, service_id, slug,
            current_version_id, current_version_number, created_by, updated_by)
         VALUES ($1,$2,$3,$4,'transport',$5,1,$6,$6)`,
        [ID.group, ID.organization, ID.project, ID.service, ID.groupVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.spatial_service_layer_group_versions
           (id, organization_id, project_id, service_id, group_id,
            version_number, title, mode, member_collection_ids, created_by)
         VALUES ($1,$2,$3,$4,$5,1,'Transport','named',ARRAY[$6]::uuid[],$7)`,
        [ID.groupVersion, ID.organization, ID.project, ID.service,
          ID.group, ID.collection, ID.user]
      );
    });
    const current = await tenant(ID.organization, ID.user, () => db.query(`
      SELECT service.current_metadata_version_number, metadata.title,
             group_head.current_version_number, version.member_collection_ids
      FROM app.spatial_services service
      JOIN app.spatial_service_metadata_versions metadata
        ON metadata.organization_id=service.organization_id
       AND metadata.id=service.current_metadata_version_id
      JOIN app.spatial_service_layer_groups group_head
        ON group_head.organization_id=service.organization_id
       AND group_head.service_id=service.id
      JOIN app.spatial_service_layer_group_versions version
        ON version.organization_id=group_head.organization_id
       AND version.id=group_head.current_version_id
      WHERE service.id='${ID.service}'
    `));
    assert.deepEqual(current.rows, [{
      current_metadata_version_number: 2,
      title: "Research catalog",
      current_version_number: 1,
      member_collection_ids: [ID.collection]
    }]);
  });

  it("rejects cross-service members, duplicate ordering, and in-use store disable", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.spatial_service_layer_group_versions
           (organization_id, project_id, service_id, group_id, version_number,
            title, mode, member_collection_ids, created_by)
         VALUES ($1,$2,$3,$4,2,'Invalid','named',ARRAY[$5]::uuid[],$6)`,
        [ID.organization, ID.project, ID.service, ID.group,
          "ffffffff-ffff-4fff-8fff-ffffffffffff", ID.user]
      )),
      /not an active same-service collection/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.spatial_service_layer_group_versions
           (organization_id, project_id, service_id, group_id, version_number,
            title, mode, member_collection_ids, created_by)
         VALUES ($1,$2,$3,$4,2,'Duplicate','named',ARRAY[$5,$5]::uuid[],$6)`,
        [ID.organization, ID.project, ID.service, ID.group, ID.collection, ID.user]
      )),
      /spatial_service_layer_group_members_bounded/
    );
    const store = await tenant(ID.organization, ID.user, () => db.query(
      "SELECT id FROM app.spatial_service_stores WHERE service_id=$1",
      [ID.service]
    ));
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `UPDATE app.spatial_service_stores
         SET disabled_by=$1, disabled_at=clock_timestamp()
         WHERE organization_id=$2 AND id=$3`,
        [ID.user, ID.organization, store.rows[0].id]
      )),
      /active collections cannot be disabled/
    );
  });

  it("assigns exact alternate styles and fails closed for stale revisions", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.spatial_service_collection_styles
           (organization_id, project_id, service_id, collection_id, style_name,
            style_id, sealed_style_version_id, sealed_style_version_number,
            is_default, created_by)
         VALUES ($1,$2,$3,$4,'stale',$5,$6,2,false,$7)`,
        [ID.organization, ID.project, ID.service, ID.collection,
          ID.alternateStyle, ID.alternateStyleVersion, ID.user]
      )),
      /must seal current same-resource style and profile revisions/
    );
    await tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.spatial_service_collection_styles
         (id, organization_id, project_id, service_id, collection_id, style_name,
          style_id, sealed_style_version_id, sealed_style_version_number,
          render_profile_id, sealed_profile_version_id,
          sealed_profile_version_number, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,'roads-night',$6,$7,1,$8,$9,1,false,$10)`,
      [ID.alternateBinding, ID.organization, ID.project, ID.service,
        ID.collection, ID.alternateStyle, ID.alternateStyleVersion,
        ID.alternateProfile, ID.alternateProfileVersion, ID.user]
    ));
    const styles = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT style_name, is_default, render_profile_id,
              sealed_profile_version_number
       FROM app.spatial_service_collection_styles
       WHERE collection_id=$1 ORDER BY is_default DESC, style_name`,
      [ID.collection]
    ));
    assert.deepEqual(styles.rows, [
      {
        style_name: "roads-default", is_default: true,
        render_profile_id: ID.profile, sealed_profile_version_number: 1
      },
      {
        style_name: "roads-night", is_default: false,
        render_profile_id: ID.alternateProfile, sealed_profile_version_number: 1
      }
    ]);
  });

  it("replaces an active published name while preserving immutable binding history", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `UPDATE app.spatial_service_collection_styles
         SET withdrawn_by=$1, withdrawn_at=clock_timestamp()
         WHERE organization_id=$2 AND collection_id=$3
           AND withdrawn_at IS NULL
           AND (is_default OR lower(style_name)=lower('roads-night'))`,
        [ID.user, ID.organization, ID.collection]
      );
      await db.query(
        `INSERT INTO app.spatial_service_collection_styles
           (id, organization_id, project_id, service_id, collection_id, style_name,
            style_id, sealed_style_version_id, sealed_style_version_number,
            render_profile_id, sealed_profile_version_id,
            sealed_profile_version_number, is_default, created_by)
         VALUES ($1,$2,$3,$4,$5,'roads-night',$6,$7,1,$8,$9,1,true,$10)`,
        [ID.replacementBinding, ID.organization, ID.project, ID.service,
          ID.collection, ID.alternateStyle, ID.alternateStyleVersion,
          ID.alternateProfile, ID.alternateProfileVersion, ID.user]
      );
    });
    const styles = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT id, style_name, is_default, render_profile_id,
              withdrawn_at IS NULL AS active
       FROM app.spatial_service_collection_styles
       WHERE collection_id=$1
       ORDER BY created_at, id`,
      [ID.collection]
    ));
    assert.equal(styles.rows.length, 3);
    assert.deepEqual(styles.rows.filter((style) => style.active), [{
      id: ID.replacementBinding,
      style_name: "roads-night",
      is_default: true,
      render_profile_id: ID.alternateProfile,
      active: true
    }]);
    assert.equal(styles.rows.filter((style) => !style.active).length, 2);
  });

  it("accepts only an exact verified read-only PostGIS store resolution", async () => {
    const store = await tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.spatial_service_stores
         (organization_id, project_id, service_id, slug, title, kind,
          external_connection_id, sealed_connection_revision_number,
          configuration, created_by)
       VALUES ($1,$2,$3,'research-postgis','Research PostGIS',
               'postgresql_connection',$4,1,'{"schema":"public"}',$5)
       RETURNING slug, kind::text, sealed_connection_revision_number`,
      [ID.organization, ID.project, ID.service, ID.connection, ID.user]
    ));
    assert.deepEqual(store.rows, [{
      slug: "research-postgis",
      kind: "postgresql_connection",
      sealed_connection_revision_number: 1
    }]);
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.spatial_service_stores
           (organization_id, project_id, service_id, slug, title, kind,
            external_connection_id, sealed_connection_revision_number,
            configuration, created_by)
         VALUES ($1,$2,$3,'stale-postgis','Stale PostGIS',
                 'postgresql_connection',$4,2,'{"schema":"public"}',$5)`,
        [ID.organization, ID.project, ID.service, ID.connection, ID.user]
      )),
      /must seal a verified read-only PostGIS connection/
    );
  });

  it("forces tenant RLS and denies worker, connector, and archiver table access", async () => {
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT id FROM app.spatial_service_stores"
    ));
    assert.deepEqual(hidden.rows, []);
    const grants = await db.query(`
      SELECT
        has_table_privilege('opengeo_runtime','app.spatial_service_stores','SELECT') AS runtime_read,
        has_table_privilege('opengeo_worker','app.spatial_service_stores','SELECT') AS worker_read,
        has_table_privilege('opengeo_connector','app.spatial_service_stores','SELECT') AS connector_read,
        has_table_privilege('opengeo_source_archiver','app.spatial_service_stores','SELECT') AS archiver_read
    `);
    assert.deepEqual(grants.rows, [{
      runtime_read: true,
      worker_read: false,
      connector_read: false,
      archiver_read: false
    }]);
    assert.match(migration, /first member draws on top/);
    assert.match(migration, /all operations commit together|history is immutable/);
  });
});
