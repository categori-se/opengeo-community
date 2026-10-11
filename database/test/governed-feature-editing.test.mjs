import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000121",
  otherOrganization: "10000000-0000-4000-8000-000000000122",
  user: "20000000-0000-4000-8000-000000000121",
  otherUser: "20000000-0000-4000-8000-000000000122",
  project: "50000000-0000-4000-8000-000000000121",
  dataset: "80000000-0000-4000-8000-000000000121",
  feature: "90000000-0000-4000-8000-000000000121"
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
  "0078_deleted_feature_restoration.sql"
];

let db;
let productionMigration;
let restorationMigration;

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

function pgliteFeatureMigration(sql) {
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
    .replace("ST_Equals(revision.geometry, NEW.geometry)", "revision.geometry = NEW.geometry");
}

async function insertRevision(version, operation, properties, message) {
  await db.query(
    `INSERT INTO app.dataset_feature_revisions
       (organization_id, dataset_id, feature_id, version_number, operation,
        geometry_type, properties, geometry_geojson, geometry, changed_by,
        change_message, request_id)
     VALUES ($1, $2, $3, $4, $5, 'Point', $6, $7, $7, $8, $9, $10)`,
    [
      IDS.organization,
      IDS.dataset,
      IDS.feature,
      version,
      operation,
      properties,
      {type: "Point", coordinates: [-77.03, 38.9]},
      IDS.user,
      message,
      `feature-request-${version}`
    ]
  );
}

describe("0021 governed feature editing migration", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (file === "0021_governed_feature_editing.sql") {
        productionMigration = sql;
        sql = pgliteFeatureMigration(sql);
      }
      if (file === "0078_deleted_feature_restoration.sql") {
        restorationMigration = sql;
        sql = sql.replace(
          "ST_Equals(revision.geometry, NEW.geometry)",
          "revision.geometry = NEW.geometry"
        );
      }
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.user}', 'feature-user', 'feature@example.test', 'Feature Editor'),
        ('${IDS.otherUser}', 'other-feature-user', 'other@example.test', 'Other User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Features', 'features', '${IDS.user}'),
        ('${IDS.otherOrganization}', 'Other Features', 'other-features', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Feature project', '${IDS.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${IDS.dataset}', '${IDS.organization}', 'Survey points', 'internal',
              'upload', 'geojson', 'active', '${IDS.user}', '${IDS.user}', '${IDS.user}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}', '${IDS.user}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("uses PostGIS geometry, spatial indexing, and WGS84 validity checks in production", () => {
    assert.match(productionMigration, /geometry geometry\(Geometry, 4326\) NOT NULL/);
    assert.match(productionMigration, /USING gist \(geometry\)/);
    assert.match(productionMigration, /ST_IsValid\(geometry\)/);
    assert.match(productionMigration, /ST_NDims\(geometry\) = 2/);
    assert.match(productionMigration, /ST_Equals\(revision\.geometry, NEW\.geometry\)/);
    assert.match(restorationMigration, /ADD VALUE IF NOT EXISTS 'restore'/);
    assert.match(restorationMigration, /ST_Equals\(revision\.geometry, NEW\.geometry\)/);
    assert.match(restorationMigration, /deleted feature head can only transition/);
  });

  it("stores stable heads only when a matching immutable revision is appended", async () => {
    const result = await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.feature_collections
           (organization_id, dataset_id, geometry_type, schema_definition,
            generation, feature_count, created_by, updated_by)
         VALUES ($1, $2, 'Point', $3, 1, 1, $4, $4)`,
        [
          IDS.organization,
          IDS.dataset,
          {schemaVersion: "1.0.0", fields: [{name: "name", type: "string", required: true}]},
          IDS.user
        ]
      );
      await db.query(
        `INSERT INTO app.dataset_features
           (id, organization_id, dataset_id, geometry_type, properties,
            geometry_geojson, geometry, bbox, created_by, updated_by)
         VALUES ($1, $2, $3, 'Point', $4, $5, $5, $6, $7, $7)`,
        [
          IDS.feature,
          IDS.organization,
          IDS.dataset,
          {name: "Station"},
          {type: "Point", coordinates: [-77.03, 38.9]},
          [-77.03, 38.9, -77.03, 38.9],
          IDS.user
        ]
      );
      await insertRevision(1, "create", {name: "Station"}, "Initial survey import");
      return db.query(
        `SELECT feature.id, feature.version_number, collection.generation,
                collection.feature_count
         FROM app.dataset_features feature
         JOIN app.feature_collections collection
           ON collection.organization_id = feature.organization_id
          AND collection.dataset_id = feature.dataset_id`
      );
    });

    assert.deepEqual(result.rows, [{
      id: IDS.feature,
      version_number: 1,
      generation: 1,
      feature_count: 1
    }]);
  });

  it("enforces exact optimistic increments and preserves append-only history", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.dataset_features
         SET version_number = 2, properties = $1, updated_by = $2
         WHERE organization_id = $3 AND dataset_id = $4 AND id = $5
           AND version_number = 1`,
        [{name: "Station revised"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      );
      await insertRevision(2, "update", {name: "Station revised"}, "Verified in field");
      await db.query(
        `UPDATE app.feature_collections
         SET generation = 2, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3 AND generation = 1`,
        [IDS.user, IDS.organization, IDS.dataset]
      );
    });

    const stale = await inTenant(IDS.organization, IDS.user, () => db.query(
      `UPDATE app.dataset_features SET version_number = 3, properties = $1, updated_by = $2
       WHERE organization_id = $3 AND dataset_id = $4 AND id = $5 AND version_number = 1`,
      [{name: "Stale"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
    ));
    assert.equal(stale.affectedRows, 0);
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.dataset_features SET version_number = 4, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      )),
      /increase exactly once/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.dataset_feature_revisions SET change_message = 'rewritten'
         WHERE feature_id = $1 AND version_number = 1`,
        [IDS.feature]
      )),
      /permission denied/
    );
  });

  it("rejects an unhistoried mutation at commit and hides rows cross-tenant", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.dataset_features
         SET version_number = 3, properties = $1, updated_by = $2
         WHERE organization_id = $3 AND dataset_id = $4 AND id = $5`,
        [{name: "No history"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      )),
      /requires one matching immutable revision/
    );
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.dataset_features")
    );
    assert.deepEqual(hidden.rows, []);
  });

  it("restores a tombstone only through a matching append-only restore revision", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.dataset_features
         SET version_number = 3, updated_by = $1,
             deleted_by = $1, deleted_at = clock_timestamp()
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      );
      await insertRevision(3, "delete", {name: "Station revised"}, "Remove duplicate");
    });

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.dataset_features
         SET version_number = 4, properties = $1, updated_by = $2
         WHERE organization_id = $3 AND dataset_id = $4 AND id = $5`,
        [{name: "Rewrite tombstone"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      )),
      /deleted feature head can only transition/
    );

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, async () => {
        await db.query(
          `UPDATE app.dataset_features
           SET version_number = 4, properties = $1, updated_by = $2,
               deleted_by = NULL, deleted_at = NULL
           WHERE organization_id = $3 AND dataset_id = $4 AND id = $5`,
          [{name: "Station"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
        );
        await insertRevision(4, "update", {name: "Station"}, "Wrong operation");
      }),
      /requires one matching immutable revision/
    );

    const restored = await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.dataset_features
         SET version_number = 4, properties = $1, updated_by = $2,
             deleted_by = NULL, deleted_at = NULL
         WHERE organization_id = $3 AND dataset_id = $4 AND id = $5`,
        [{name: "Station"}, IDS.user, IDS.organization, IDS.dataset, IDS.feature]
      );
      await insertRevision(4, "restore", {name: "Station"}, "Recover original capture");
      return db.query(
        `SELECT feature.version_number, feature.properties, feature.deleted_at,
                array_agg(revision.operation::text ORDER BY revision.version_number) AS operations
         FROM app.dataset_features feature
         JOIN app.dataset_feature_revisions revision
           ON revision.organization_id = feature.organization_id
          AND revision.dataset_id = feature.dataset_id
          AND revision.feature_id = feature.id
         WHERE feature.organization_id = $1 AND feature.dataset_id = $2
           AND feature.id = $3
         GROUP BY feature.version_number, feature.properties, feature.deleted_at`,
        [IDS.organization, IDS.dataset, IDS.feature]
      );
    });

    assert.deepEqual(restored.rows, [{
      version_number: 4,
      properties: {name: "Station"},
      deleted_at: null,
      operations: ["create", "update", "delete", "restore"]
    }]);
  });

  it("keeps the isolated worker outside feature heads and revision history", async () => {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(db.query("SELECT id FROM app.dataset_features"), /permission denied/);
    await assert.rejects(
      db.query("SELECT id FROM app.dataset_feature_revisions"),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
