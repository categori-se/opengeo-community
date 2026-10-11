import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000141",
  otherOrganization: "10000000-0000-4000-8000-000000000142",
  user: "20000000-0000-4000-8000-000000000141",
  otherUser: "20000000-0000-4000-8000-000000000142",
  project: "50000000-0000-4000-8000-000000000141",
  dataset: "80000000-0000-4000-8000-000000000141",
  form: "a0000000-0000-4000-8000-000000000141",
  conditionalDataset: "80000000-0000-4000-8000-000000000143",
  conditionalForm: "a0000000-0000-4000-8000-000000000143",
  targetFeature: "90000000-0000-4000-8000-000000000143",
  updateSubmission: "b0000000-0000-4000-8000-000000000143",
  submission: "b0000000-0000-4000-8000-000000000141",
  correction: "b0000000-0000-4000-8000-000000000142"
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
  "0072_conditional_feature_fields.sql",
  "0073_field_submission_updates.sql",
  "0074_nested_repeating_feature_groups.sql"
];

let db;
let productionMigration;

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
    .replaceAll("NOT ST_Equals(OLD.geometry, NEW.geometry)", "OLD.geometry IS DISTINCT FROM NEW.geometry");
}

async function insertSubmission(id, supersedes = null) {
  const geometry = {type: "Point", coordinates: [-77.03, 38.9]};
  await db.query(
    `INSERT INTO app.field_submissions
       (id, organization_id, dataset_id, form_id, form_version,
        supersedes_submission_id, payload_sha256, geometry_type, properties,
        geometry_geojson, geometry, submitted_by)
     VALUES ($1, $2, $3, $4, 1, $5, $6, 'Point', $7, $8, $8, $9)`,
    [
      id,
      IDS.organization,
      IDS.dataset,
      IDS.form,
      supersedes,
      id === IDS.submission ? "a".repeat(64) : "b".repeat(64),
      {name: id === IDS.submission ? "Station" : "Corrected station"},
      geometry,
      IDS.user
    ]
  );
  await insertSubmissionEvent(id, 1, null, "submitted", null);
}

async function insertSubmissionEvent(submissionId, version, fromState, toState, message) {
  await db.query(
    `INSERT INTO app.field_submission_events
       (organization_id, dataset_id, submission_id, submission_version,
        from_state, to_state, actor_user_id, message, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      IDS.organization,
      IDS.dataset,
      submissionId,
      version,
      fromState,
      toState,
      IDS.user,
      message,
      `field-capture-request-${version}`
    ]
  );
}

describe("0022 and 0072–0074 field capture migrations", () => {
  before(async () => {
    db = new PGlite();
    for (const file of migrations) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if ([
        "0021_governed_feature_editing.sql",
        "0022_field_capture.sql",
        "0073_field_submission_updates.sql"
      ].includes(file)) {
        if (file === "0022_field_capture.sql") productionMigration = sql;
        sql = pgliteSpatialMigration(sql);
      }
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.user}', 'capture-user', 'capture@example.test', 'Capture Editor'),
        ('${IDS.otherUser}', 'other-capture-user', 'other@example.test', 'Other User');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Capture', 'capture', '${IDS.user}'),
        ('${IDS.otherOrganization}', 'Other Capture', 'other-capture', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Field project', '${IDS.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${IDS.dataset}', '${IDS.organization}', 'Survey points', 'internal',
              'upload', 'geojson', 'active', '${IDS.user}', '${IDS.user}', '${IDS.user}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}', '${IDS.user}');
      INSERT INTO app.feature_collections
        (organization_id, dataset_id, geometry_type, schema_definition,
         generation, feature_count, created_by, updated_by)
      VALUES ('${IDS.organization}', '${IDS.dataset}', 'Point',
              '{"schemaVersion":"1.0.0","fields":[{"name":"name","type":"string","required":true}]}',
              1, 0, '${IDS.user}', '${IDS.user}');
      SET ROLE opengeo_runtime;
    `);

    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.field_forms
           (id, organization_id, dataset_id, current_version, created_by, updated_by)
         VALUES ($1, $2, $3, 1, $4, $4)`,
        [IDS.form, IDS.organization, IDS.dataset, IDS.user]
      );
      await db.query(
        `INSERT INTO app.field_form_versions
           (organization_id, dataset_id, form_id, version_number, title,
            instructions, collection_generation, geometry_type,
            schema_definition, created_by)
         VALUES ($1, $2, $3, 1, 'Station survey', 'Capture one station', 1,
                 'Point', $4, $5)`,
        [
          IDS.organization,
          IDS.dataset,
          IDS.form,
          {schemaVersion: "1.0.0", fields: [{name: "name", type: "string", required: true}]},
          IDS.user
        ]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("uses PostGIS validation in production and denies the processing worker", () => {
    assert.match(productionMigration, /geometry geometry\(Geometry, 4326\) NOT NULL/);
    assert.match(productionMigration, /ST_IsValid\(geometry\)/);
    assert.match(productionMigration, /payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
    assert.match(productionMigration, /FROM opengeo_worker/);
    assert.match(productionMigration, /DEFERRABLE INITIALLY DEFERRED/);
  });

  it("stores immutable exact-base update submissions separately from creates", async () => {
    const geometry = {type: "Point", coordinates: [-77.04, 38.91]};
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.dataset_features
          (id, organization_id, dataset_id, geometry_type, properties,
           geometry_geojson, geometry, bbox, created_by, updated_by)
         VALUES ($1, $2, $3, 'Point', $4, $5, $5, $6, $7, $7)`,
        [
          IDS.targetFeature,
          IDS.organization,
          IDS.dataset,
          {name: "Existing station"},
          geometry,
          [-77.04, 38.91, -77.04, 38.91],
          IDS.user
        ]
      );
      await db.query(
        `INSERT INTO app.dataset_feature_revisions
          (organization_id, dataset_id, feature_id, version_number, operation,
           geometry_type, properties, geometry_geojson, geometry, changed_by,
           change_message, request_id)
         VALUES ($1, $2, $3, 1, 'create', 'Point', $4, $5, $5, $6, $7, $8)`,
        [
          IDS.organization,
          IDS.dataset,
          IDS.targetFeature,
          {name: "Existing station"},
          geometry,
          IDS.user,
          "Seed exact-base update target",
          "field-update-target-seed"
        ]
      );
      await db.query(
        `UPDATE app.feature_collections
         SET generation = 2, feature_count = 1, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3 AND generation = 1`,
        [IDS.user, IDS.organization, IDS.dataset]
      );
      await db.query(
        `INSERT INTO app.field_submissions
          (id, organization_id, dataset_id, form_id, form_version,
           operation, target_feature_id, target_feature_version,
           payload_sha256, geometry_type, properties, geometry_geojson,
           geometry, submitted_by)
         VALUES ($1, $2, $3, $4, 1, 'update', $5, 1, $6, 'Point', $7, $8, $8, $9)`,
        [
          IDS.updateSubmission,
          IDS.organization,
          IDS.dataset,
          IDS.form,
          IDS.targetFeature,
          "c".repeat(64),
          {name: "Inspected station"},
          geometry,
          IDS.user
        ]
      );
      await insertSubmissionEvent(IDS.updateSubmission, 1, null, "submitted", null);
    });

    const stored = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT operation::text, target_feature_id, target_feature_version,
                promoted_feature_id
         FROM app.field_submissions WHERE id = $1`,
        [IDS.updateSubmission]
      )
    );
    assert.deepEqual(stored.rows, [{
      operation: "update",
      target_feature_id: IDS.targetFeature,
      target_feature_version: 1,
      promoted_feature_id: null
    }]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `UPDATE app.field_submissions SET target_feature_version = 2
           WHERE id = $1`,
          [IDS.updateSubmission]
        )
      ),
      /field submission identity and payload are immutable/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `INSERT INTO app.field_submissions
            (id, organization_id, dataset_id, form_id, form_version,
             operation, target_feature_id, payload_sha256, geometry_type,
             properties, geometry_geojson, geometry, submitted_by)
           VALUES ($1, $2, $3, $4, 1, 'update', $5, $6, 'Point', $7, $8, $8, $9)`,
          [
            "b0000000-0000-4000-8000-000000000144",
            IDS.organization,
            IDS.dataset,
            IDS.form,
            IDS.targetFeature,
            "d".repeat(64),
            {name: "Missing base"},
            geometry,
            IDS.user
          ]
        )
      ),
      /field_submissions_operation_shape/
    );
  });

  it("accepts an update only with one matching head revision and no count increase", async () => {
    const geometry = {type: "Point", coordinates: [-77.04, 38.91]};
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'in_review', review_version = 2, reviewed_by = $1,
             reviewed_at = clock_timestamp()
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.updateSubmission]
      );
      await insertSubmissionEvent(
        IDS.updateSubmission, 2, "submitted", "in_review", null
      );
      await db.query(
        `UPDATE app.dataset_features
         SET version_number = 2, properties = $1, geometry_geojson = $2,
             geometry = $2, updated_by = $3
         WHERE organization_id = $4 AND dataset_id = $5 AND id = $6
           AND version_number = 1`,
        [
          {name: "Inspected station"},
          geometry,
          IDS.user,
          IDS.organization,
          IDS.dataset,
          IDS.targetFeature
        ]
      );
      await db.query(
        `INSERT INTO app.dataset_feature_revisions
          (organization_id, dataset_id, feature_id, version_number, operation,
           geometry_type, properties, geometry_geojson, geometry, changed_by,
           change_message, request_id)
         VALUES ($1, $2, $3, 2, 'update', 'Point', $4, $5, $5, $6, $7, $8)`,
        [
          IDS.organization,
          IDS.dataset,
          IDS.targetFeature,
          {name: "Inspected station"},
          geometry,
          IDS.user,
          `Accepted field update submission ${IDS.updateSubmission}`,
          "field-update-review-3"
        ]
      );
      await db.query(
        `UPDATE app.feature_collections
         SET generation = 3, feature_count = 1, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3 AND generation = 2`,
        [IDS.user, IDS.organization, IDS.dataset]
      );
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'accepted', review_version = 3, reviewed_by = $1,
             reviewed_at = clock_timestamp(), review_message = 'Verified update',
             promoted_feature_id = target_feature_id
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.updateSubmission]
      );
      await insertSubmissionEvent(
        IDS.updateSubmission, 3, "in_review", "accepted", "Verified update"
      );
    });

    const result = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT submission.state::text, submission.promoted_feature_id,
                feature.version_number, collection.generation, collection.feature_count
         FROM app.field_submissions submission
         JOIN app.dataset_features feature
           ON feature.organization_id = submission.organization_id
          AND feature.dataset_id = submission.dataset_id
          AND feature.id = submission.promoted_feature_id
         JOIN app.feature_collections collection
           ON collection.organization_id = submission.organization_id
          AND collection.dataset_id = submission.dataset_id
         WHERE submission.id = $1`,
        [IDS.updateSubmission]
      )
    );
    assert.deepEqual(result.rows, [{
      state: "accepted",
      promoted_feature_id: IDS.targetFeature,
      version_number: 2,
      generation: 3,
      feature_count: 1
    }]);
  });

  it("accepts schema 1.1 conditions and bounded schema 1.2 group snapshots", async () => {
    const conditionalSchema = {
      schemaVersion: "1.1.0",
      fields: [
        {name: "kind", type: "string", required: true, choices: ["Road", "Trail"]},
        {
          name: "surface",
          type: "string",
          required: true,
          visible_when: {field: "kind", equals: "Road"}
        }
      ]
    };
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.datasets
          (id, organization_id, name, classification, source_type, format, status,
           owner_user_id, created_by, updated_by)
         VALUES ($1, $2, 'Conditional survey', 'internal', 'upload', 'geojson',
                 'active', $3, $3, $3)`,
        [IDS.conditionalDataset, IDS.organization, IDS.user]
      );
      await db.query(
        `INSERT INTO app.feature_collections
          (organization_id, dataset_id, geometry_type, schema_definition,
           generation, feature_count, created_by, updated_by)
         VALUES ($1, $2, 'Point', $3, 1, 0, $4, $4)`,
        [IDS.organization, IDS.conditionalDataset, conditionalSchema, IDS.user]
      );
      await db.query(
        `INSERT INTO app.field_forms
          (id, organization_id, dataset_id, current_version, created_by, updated_by)
         VALUES ($1, $2, $3, 1, $4, $4)`,
        [IDS.conditionalForm, IDS.organization, IDS.conditionalDataset, IDS.user]
      );
      await db.query(
        `INSERT INTO app.field_form_versions
          (organization_id, dataset_id, form_id, version_number, title,
           collection_generation, geometry_type, schema_definition, created_by)
         VALUES ($1, $2, $3, 1, 'Conditional survey', 1, 'Point', $4, $5)`,
        [
          IDS.organization,
          IDS.conditionalDataset,
          IDS.conditionalForm,
          conditionalSchema,
          IDS.user
        ]
      );
    });

    const stored = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT schema_definition->>'schemaVersion' AS schema_version
         FROM app.feature_collections WHERE dataset_id = $1`,
        [IDS.conditionalDataset]
      )
    );
    assert.deepEqual(stored.rows, [{schema_version: "1.1.0"}]);

    const groupedSchema = {
      schemaVersion: "1.2.0",
      fields: [{
        name: "samples",
        type: "group",
        repeat: true,
        min_items: 1,
        max_items: 4,
        fields: [{name: "value", type: "number", required: true}]
      }]
    };
    await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `INSERT INTO app.field_form_versions
          (organization_id, dataset_id, form_id, version_number, title,
           collection_generation, geometry_type, schema_definition, created_by)
         VALUES ($1, $2, $3, 2, 'Grouped', 1, 'Point', $4, $5)`,
        [
          IDS.organization,
          IDS.conditionalDataset,
          IDS.conditionalForm,
          groupedSchema,
          IDS.user
        ]
      )
    );
    const grouped = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT schema_definition FROM app.field_form_versions
         WHERE form_id = $1 AND version_number = 2`,
        [IDS.conditionalForm]
      )
    );
    assert.deepEqual(grouped.rows, [{schema_definition: groupedSchema}]);

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `INSERT INTO app.field_form_versions
            (organization_id, dataset_id, form_id, version_number, title,
             collection_generation, geometry_type, schema_definition, created_by)
           VALUES ($1, $2, $3, 3, 'Unsupported', 1, 'Point', $4, $5)`,
          [
            IDS.organization,
            IDS.conditionalDataset,
            IDS.conditionalForm,
            {...groupedSchema, schemaVersion: "1.3.0"},
            IDS.user
          ]
        )
      ),
      /field_form_versions_schema_object/
    );

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `INSERT INTO app.field_form_versions
            (organization_id, dataset_id, form_id, version_number, title,
             collection_generation, geometry_type, schema_definition, created_by)
           VALUES ($1, $2, $3, 3, 'Missing version', 1, 'Point', $4, $5)`,
          [
            IDS.organization,
            IDS.conditionalDataset,
            IDS.conditionalForm,
            {fields: conditionalSchema.fields},
            IDS.user
          ]
        )
      ),
      /field_form_versions_schema_object/
    );
  });

  it("keeps replay-safe submissions quarantined and tenant isolated", async () => {
    await inTenant(IDS.organization, IDS.user, () => insertSubmission(IDS.submission));

    const own = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT id, state::text, promoted_feature_id
         FROM app.field_submissions WHERE id = $1`,
        [IDS.submission]
      )
    );
    const other = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.field_submissions")
    );
    const features = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT id FROM app.dataset_features WHERE id IN ($1, $2)`,
        [IDS.submission, IDS.correction]
      )
    );

    assert.deepEqual(own.rows, [{id: IDS.submission, state: "submitted", promoted_feature_id: null}]);
    assert.deepEqual(other.rows, []);
    assert.deepEqual(features.rows, []);
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => insertSubmission(IDS.submission)),
      /duplicate key/
    );
  });

  it("requires exact review transitions and append-only matching events", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'in_review', review_version = 2, reviewed_by = $1,
             reviewed_at = clock_timestamp()
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.submission]
      );
      await insertSubmissionEvent(IDS.submission, 2, "submitted", "in_review", null);
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'changes_requested', review_version = 3, reviewed_by = $1,
             reviewed_at = clock_timestamp(), review_message = 'Correct the sign text'
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.submission]
      );
      await insertSubmissionEvent(
        IDS.submission, 3, "in_review", "changes_requested", "Correct the sign text"
      );
      await insertSubmission(IDS.correction, IDS.submission);
    });

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `UPDATE app.field_submissions SET properties = '{"name":"forged"}'
           WHERE organization_id = $1 AND dataset_id = $2 AND id = $3`,
          [IDS.organization, IDS.dataset, IDS.submission]
        )
      ),
      /identity and payload are immutable/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () =>
        db.query(
          `UPDATE app.field_submissions
           SET state = 'accepted', review_version = 2, reviewed_by = $1,
               reviewed_at = clock_timestamp(), promoted_feature_id = id
           WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
          [IDS.user, IDS.organization, IDS.dataset, IDS.correction]
        )
      ),
      /invalid field submission review transition/
    );
  });

  it("accepts a corrected submission only with its feature and revision atomically", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'in_review', review_version = 2, reviewed_by = $1,
             reviewed_at = clock_timestamp()
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.correction]
      );
      await insertSubmissionEvent(IDS.correction, 2, "submitted", "in_review", null);
      const geometry = {type: "Point", coordinates: [-77.03, 38.9]};
      await db.query(
        `INSERT INTO app.dataset_features
           (id, organization_id, dataset_id, geometry_type, properties,
            geometry_geojson, geometry, bbox, created_by, updated_by)
         VALUES ($1, $2, $3, 'Point', $4, $5, $5, $6, $7, $7)`,
        [
          IDS.correction,
          IDS.organization,
          IDS.dataset,
          {name: "Corrected station"},
          geometry,
          [-77.03, 38.9, -77.03, 38.9],
          IDS.user
        ]
      );
      await db.query(
        `INSERT INTO app.dataset_feature_revisions
           (organization_id, dataset_id, feature_id, version_number, operation,
            geometry_type, properties, geometry_geojson, geometry, changed_by,
            change_message, request_id)
         VALUES ($1, $2, $3, 1, 'create', 'Point', $4, $5, $5, $6, $7, $8)`,
        [
          IDS.organization,
          IDS.dataset,
          IDS.correction,
          {name: "Corrected station"},
          geometry,
          IDS.user,
          `Accepted field submission ${IDS.correction}`,
          "field-capture-request-3"
        ]
      );
      await db.query(
        `UPDATE app.feature_collections
         SET generation = 4, feature_count = 2, updated_by = $1
         WHERE organization_id = $2 AND dataset_id = $3 AND generation = 3`,
        [IDS.user, IDS.organization, IDS.dataset]
      );
      await db.query(
        `UPDATE app.field_submissions
         SET state = 'accepted', review_version = 3, reviewed_by = $1,
             reviewed_at = clock_timestamp(), review_message = 'Verified',
             promoted_feature_id = id
         WHERE organization_id = $2 AND dataset_id = $3 AND id = $4`,
        [IDS.user, IDS.organization, IDS.dataset, IDS.correction]
      );
      await insertSubmissionEvent(IDS.correction, 3, "in_review", "accepted", "Verified");
    });

    const result = await inTenant(IDS.organization, IDS.user, () =>
      db.query(
        `SELECT submission.state::text, submission.promoted_feature_id,
                feature.version_number, collection.generation, collection.feature_count
         FROM app.field_submissions submission
         JOIN app.dataset_features feature
           ON feature.organization_id = submission.organization_id
          AND feature.dataset_id = submission.dataset_id
          AND feature.id = submission.promoted_feature_id
         JOIN app.feature_collections collection
           ON collection.organization_id = submission.organization_id
          AND collection.dataset_id = submission.dataset_id
         WHERE submission.id = $1`,
        [IDS.correction]
      )
    );
    assert.deepEqual(result.rows, [{
      state: "accepted",
      promoted_feature_id: IDS.correction,
      version_number: 1,
      generation: 4,
      feature_count: 2
    }]);
  });
});
