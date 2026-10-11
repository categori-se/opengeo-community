import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000711",
  user: "20000000-0000-4000-8000-000000000711",
  project: "50000000-0000-4000-8000-000000000711",
  otherProject: "50000000-0000-4000-8000-000000000712",
  site: "b0000000-0000-4000-8000-000000000711",
  siteVersion: "b1000000-0000-4000-8000-000000000711",
  otherSite: "b0000000-0000-4000-8000-000000000712",
  otherSiteVersion: "b1000000-0000-4000-8000-000000000712",
  duplicateSite: "b0000000-0000-4000-8000-000000000713",
  duplicateSiteVersion: "b1000000-0000-4000-8000-000000000713"
});

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
  "0025_portable_site_publications.sql"
];

let db;
let productionMigration;

async function tenant(operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [ID.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [ID.user]);
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

async function insertSite(projectId, siteId, versionId, slug) {
  await db.exec("SET CONSTRAINTS ALL DEFERRED");
  await db.query(
    `INSERT INTO app.project_sites
       (id, organization_id, project_id, slug, current_version_id,
        current_version_number, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
    [siteId, ID.organization, projectId, slug, versionId, ID.user]
  );
  await db.query(
    `INSERT INTO app.project_site_versions
       (id, organization_id, project_id, site_id, version_number,
        title, theme, created_by)
     VALUES ($1,$2,$3,$4,1,$5,'paper',$6)`,
    [versionId, ID.organization, projectId, siteId, `${slug} site`, ID.user]
  );
}

describe("0071 publication destinations", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (["0021_governed_feature_editing.sql", "0022_field_capture.sql"].includes(file)) {
        sql = pgliteSpatialMigration(sql);
      }
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${ID.user}', 'publication-owner', 'publisher@example.test', 'Publisher');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${ID.organization}', 'Publishing', 'publishing', '${ID.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${ID.project}', '${ID.organization}', 'Primary publication', '${ID.user}'),
        ('${ID.otherProject}', '${ID.organization}', 'Second publication', '${ID.user}');
      SET ROLE opengeo_runtime;
    `);
    await tenant(() => insertSite(ID.project, ID.site, ID.siteVersion, "atlas"));
    await db.exec(`
      RESET ROLE;
      CREATE ROLE opengeo_connector NOLOGIN;
      CREATE ROLE opengeo_observable_coordinator NOLOGIN;
    `);
    productionMigration = await readFile(
      new URL("../migrations/0071_publication_destinations.sql", import.meta.url),
      "utf8"
    );
    await db.exec(productionMigration);
    await db.exec("SET ROLE opengeo_runtime");
  });

  after(async () => db.close());

  it("reserves account paths, versions destination intent, and permits one primary", async () => {
    const initial = await tenant(() => db.query(
      `SELECT revision, reach::text, listed_slug, is_primary
       FROM app.project_site_publication_destinations
       WHERE site_id=$1`,
      [ID.site]
    ));
    assert.deepEqual(initial.rows[0], {
      revision: 1,
      reach: "unpublished",
      listed_slug: "atlas",
      is_primary: false
    });

    await tenant(async () => {
      await db.query(
        `UPDATE app.project_site_publication_destinations
         SET revision=2, reach='listed', is_primary=true,
             configured_by=$1, configured_at=clock_timestamp()
         WHERE organization_id=$2 AND project_id=$3 AND site_id=$4`,
        [ID.user, ID.organization, ID.project, ID.site]
      );
      await db.query(
        `INSERT INTO app.project_site_publication_destination_events
           (organization_id, project_id, site_id, destination_revision,
            source_reach, target_reach, source_listed_slug, target_listed_slug,
            source_is_primary, target_is_primary, request_id, actor_user_id)
         VALUES ($1,$2,$3,2,'unpublished','listed','atlas','atlas',false,true,$4,$5)`,
        [ID.organization, ID.project, ID.site, "destination-2", ID.user]
      );
    });
    const configured = await tenant(() => db.query(
      `SELECT destination.revision, destination.reach::text, destination.is_primary,
              event.request_id
       FROM app.project_site_publication_destinations destination
       JOIN app.project_site_publication_destination_events event
         ON event.organization_id=destination.organization_id
        AND event.site_id=destination.site_id
        AND event.destination_revision=destination.revision
       WHERE destination.site_id=$1`,
      [ID.site]
    ));
    assert.deepEqual(configured.rows[0], {
      revision: 2,
      reach: "listed",
      is_primary: true,
      request_id: "destination-2"
    });

    await assert.rejects(
      tenant(() => insertSite(
        ID.otherProject,
        ID.duplicateSite,
        ID.duplicateSiteVersion,
        "atlas"
      )),
      /project_site_publication_destinations_slug_idx/
    );
    await tenant(() => insertSite(
      ID.otherProject,
      ID.otherSite,
      ID.otherSiteVersion,
      "journal"
    ));
    await assert.rejects(
      tenant(() => db.query(
        `UPDATE app.project_site_publication_destinations
         SET revision=2, reach='unlisted', configured_by=$1,
             configured_at=clock_timestamp()
         WHERE organization_id=$2 AND project_id=$3 AND site_id=$4`,
        [ID.user, ID.organization, ID.otherProject, ID.otherSite]
      )),
      /destination update must record its event/
    );
    await assert.rejects(
      tenant(() => db.query(
        `UPDATE app.project_site_publication_destinations
         SET revision=2, reach='listed', is_primary=true,
             configured_by=$1, configured_at=clock_timestamp()
         WHERE organization_id=$2 AND project_id=$3 AND site_id=$4`,
        [ID.user, ID.organization, ID.otherProject, ID.otherSite]
      )),
      /project_site_publication_destinations_primary_idx/
    );

    assert.match(productionMigration, /FORCE ROW LEVEL SECURITY/);
    assert.match(productionMigration, /unlisted_token ~ '\^\[0-9a-f\]\{32\}\$'/);
    assert.match(productionMigration, /FROM opengeo_worker, opengeo_connector/);
    assert.match(productionMigration, /edition publication destination is immutable/);
    assert.match(productionMigration, /published listed project site path is immutable/);
    assert.match(productionMigration, /destination event source mismatch/);
    assert.match(productionMigration, /DEFERRABLE INITIALLY DEFERRED/);
  });
});
