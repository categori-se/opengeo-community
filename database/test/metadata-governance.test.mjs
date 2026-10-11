import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-0000000000d1",
  otherOrganization: "10000000-0000-4000-8000-0000000000d2",
  owner: "20000000-0000-4000-8000-0000000000d1",
  otherUser: "20000000-0000-4000-8000-0000000000d2",
  project: "50000000-0000-4000-8000-0000000000d1",
  resource: "a0000000-0000-4000-8000-0000000000d1",
  resourceVersion: "b0000000-0000-4000-8000-0000000000d1",
  resourceVersion2: "b0000000-0000-4000-8000-0000000000d2",
  resourceVersion3: "b0000000-0000-4000-8000-0000000000d3",
  resourceVersion4: "b0000000-0000-4000-8000-0000000000d4",
  resourceVersion5: "b0000000-0000-4000-8000-0000000000d5",
  profile: "c0000000-0000-4000-8000-0000000000d1",
  profileVersion: "d0000000-0000-4000-8000-0000000000d1",
  secondProfile: "c0000000-0000-4000-8000-0000000000d2",
  secondProfileVersion: "d0000000-0000-4000-8000-0000000000d2",
  source: "f0000000-0000-4000-8000-0000000000d1",
  isoSource: "f0000000-0000-4000-8000-0000000000d2"
};

let db;

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

describe("0017-0020 metadata governance and immutable source migrations", () => {
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
      "0017_metadata_governance.sql",
      "0018_metadata_source_documents.sql",
      "0019_multilingual_metadata.sql",
      "0020_extended_metadata_exchange.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'metadata-owner', 'owner@example.test', 'Owner'),
        ('${IDS.otherUser}', 'metadata-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Metadata', 'metadata', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other', 'metadata-other', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Metadata project', '${IDS.owner}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("versions a reusable profile and binds one exact validation snapshot", async () => {
    const result = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.metadata_profiles
           (id, organization_id, slug, title, current_version_id, created_by, updated_by)
         VALUES ($1, $2, 'research.core', 'Research core', $3, $4, $4)`,
        [IDS.profile, IDS.organization, IDS.profileVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.metadata_profile_versions
           (id, organization_id, profile_id, version_number, definition,
            checksum_sha256, created_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [
          IDS.profileVersion,
          IDS.organization,
          IDS.profile,
          {schema_version: "1.0.0", required_core: ["title", "license"]},
          "a".repeat(64),
          IDS.owner
        ]
      );
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'document', 'field-methods', $4, $5, $5, $5)`,
        [IDS.resource, IDS.organization, IDS.project, IDS.resourceVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, license,
            metadata_profile, metadata_profile_id, metadata_profile_version_id,
            metadata_validation, created_by)
         VALUES ($1, $2, $3, 1, 'Field methods', 'CC-BY-4.0', 'research.core',
                 $4, $5, $6, $7)`,
        [
          IDS.resourceVersion,
          IDS.organization,
          IDS.resource,
          IDS.profile,
          IDS.profileVersion,
          {schemaVersion: "1.0.0", status: "valid", errors: 0, warnings: 0, issues: []},
          IDS.owner
        ]
      );
      return db.query(
        `SELECT profile.slug, profile_version.version_number,
                resource_version.metadata_validation->>'status' AS status
         FROM app.governed_resource_versions resource_version
         JOIN app.metadata_profiles profile
           ON profile.organization_id = resource_version.organization_id
          AND profile.id = resource_version.metadata_profile_id
         JOIN app.metadata_profile_versions profile_version
           ON profile_version.organization_id = resource_version.organization_id
          AND profile_version.id = resource_version.metadata_profile_version_id
         WHERE resource_version.organization_id = $1 AND resource_version.id = $2`,
        [IDS.organization, IDS.resourceVersion]
      );
    });
    assert.deepEqual(result.rows, [
      {slug: "research.core", version_number: 1, status: "valid"}
    ]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "UPDATE app.metadata_profile_versions SET definition = '{}' WHERE id = $1",
        [IDS.profileVersion]
      )),
      /permission denied/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "UPDATE app.metadata_profiles SET slug = 'changed' WHERE id = $1",
        [IDS.profile]
      )),
      /profile identity is immutable/
    );
  });

  it("rejects cross-profile version bindings and malformed validation snapshots", async () => {
    await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.metadata_profiles
           (id, organization_id, slug, title, current_version_id, created_by, updated_by)
         VALUES ($1, $2, 'journal.core', 'Journal core', $3, $4, $4)`,
        [IDS.secondProfile, IDS.organization, IDS.secondProfileVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.metadata_profile_versions
           (id, organization_id, profile_id, version_number, definition,
            checksum_sha256, created_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [
          IDS.secondProfileVersion,
          IDS.organization,
          IDS.secondProfile,
          {schema_version: "1.0.0"},
          "b".repeat(64),
          IDS.owner
        ]
      );
    });
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_resource_versions
           (organization_id, resource_id, version_number, title, metadata_profile_id,
            metadata_profile_version_id, metadata_validation, created_by)
         VALUES ($1, $2, 2, 'Invalid binding', $3, $4, $5, $6)`,
        [
          IDS.organization,
          IDS.resource,
          IDS.profile,
          IDS.secondProfileVersion,
          {status: "valid"},
          IDS.owner
        ]
      )),
      /foreign key constraint/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_resource_versions
           (organization_id, resource_id, version_number, title, metadata_profile_id,
            metadata_profile_version_id, metadata_validation, created_by)
         VALUES ($1, $2, 2, 'Invalid report', $3, $4, '[]', $5)`,
        [IDS.organization, IDS.resource, IDS.profile, IDS.profileVersion, IDS.owner]
      )),
      /managed_profile_shape/
    );
  });

  it("pins one immutable bounded canonical source document to an exact resource revision", async () => {
    const document = {
      type: "Collection",
      stac_version: "1.1.0",
      id: "field-methods",
      description: "Field methods",
      license: "CC0-1.0",
      extent: {
        spatial: {bbox: [[-180, -90, 180, 90]]},
        temporal: {interval: [[null, null]]}
      }
    };
    const report = {
      schemaVersion: "1.0.0",
      status: "mapped",
      mapped: ["id"],
      defaulted: [],
      derived: [],
      unmapped: [],
      preservedSource: {status: "canonical_json_preserved", syntacticIdentity: false}
    };
    const selected = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_metadata_source_documents
           (id, organization_id, resource_id, resource_version_id, source_format,
            source_version, source_namespace, source_identifier, document,
            checksum_sha256, conversion_report, imported_by)
         VALUES ($1, $2, $3, $4, 'stac_1_1', '1.1.0', 'example.catalog',
                 'field-methods', $5, $6, $7, $8)`,
        [
          IDS.source,
          IDS.organization,
          IDS.resource,
          IDS.resourceVersion,
          JSON.stringify(document),
          "c".repeat(64),
          report,
          IDS.owner
        ]
      );
      return db.query(
        `SELECT source_format::text, source_version, source_namespace,
                source_identifier, document::jsonb AS document, conversion_report
         FROM app.governed_metadata_source_documents
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.source]
      );
    });
    assert.deepEqual(selected.rows, [{
      source_format: "stac_1_1",
      source_version: "1.1.0",
      source_namespace: "example.catalog",
      source_identifier: "field-methods",
      document,
      conversion_report: report
    }]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "UPDATE app.governed_metadata_source_documents SET source_version = 'changed' WHERE id = $1",
        [IDS.source]
      )),
      /permission denied/
    );
    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.governed_resource_versions
         (id, organization_id, resource_id, version_number, title, created_by)
       VALUES ($1, $2, $3, 2, 'Field methods revision', $4)`,
      [IDS.resourceVersion2, IDS.organization, IDS.resource, IDS.owner]
    ));
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_metadata_source_documents
           (organization_id, resource_id, resource_version_id, source_format,
            source_version, source_namespace, source_identifier, document,
            checksum_sha256, conversion_report, imported_by)
         VALUES ($1, $2, $3, 'stac_1_1', '1.1.0', 'example.catalog',
                 'malformed', '{}', $4, '[]', $5)`,
        [IDS.organization, IDS.resource, IDS.resourceVersion2, "d".repeat(64), IDS.owner]
      )),
      /governed_metadata_sources_report_bounded/
    );
  });

  it("freezes bounded multilingual metadata and indexes translated discovery text", async () => {
    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.governed_resource_versions
         (id, organization_id, resource_id, version_number, title,
          localized_metadata, created_by)
       VALUES ($1, $2, $3, 3, 'Field methods translated', $4, $5)`,
      [
        IDS.resourceVersion3,
        IDS.organization,
        IDS.resource,
        {
          fr: {
            title: "Méthodes de terrain",
            abstract: "Méthodes documentées",
            keywords: ["terrain"]
          }
        },
        IDS.owner
      ]
    ));
    const translated = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT localized_metadata->'fr'->>'title' AS title,
              search_document @@ plainto_tsquery('simple', 'terrain') AS searchable
       FROM app.governed_resource_versions
       WHERE organization_id = $1 AND id = $2`,
      [IDS.organization, IDS.resourceVersion3]
    ));
    assert.deepEqual(translated.rows, [{title: "Méthodes de terrain", searchable: true}]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_resource_versions
           (organization_id, resource_id, version_number, title,
            localized_metadata, created_by)
         VALUES ($1, $2, 4, 'Oversized translation', $3, $4)`,
        [
          IDS.organization,
          IDS.resource,
          {fr: {abstract: "x".repeat(17000)}},
          IDS.owner
        ]
      )),
      /localized_metadata_bounded/
    );
  });

  it("preserves exact bounded ISO XML while retaining canonical JSON constraints", async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0" />\n';
    await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, created_by)
         VALUES ($1, $2, $3, 4, 'ISO source revision', $4)`,
        [IDS.resourceVersion4, IDS.organization, IDS.resource, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_metadata_source_documents
           (id, organization_id, resource_id, resource_version_id, source_format,
            source_version, source_namespace, source_identifier, document,
            checksum_sha256, conversion_report, imported_by)
         VALUES ($1, $2, $3, $4, 'iso_19115_3', 'ISO 19115-3:2023',
                 'example.iso', 'field-methods-iso', $5, $6, $7, $8)`,
        [
          IDS.isoSource,
          IDS.organization,
          IDS.resource,
          IDS.resourceVersion4,
          xml,
          "e".repeat(64),
          {status: "mapped", preservedSource: {status: "exact_utf8_preserved"}},
          IDS.owner
        ]
      );
    });
    const selected = await inTenant(IDS.organization, IDS.owner, () => db.query(
      `SELECT source_format::text, document
       FROM app.governed_metadata_source_documents
       WHERE organization_id = $1 AND id = $2`,
      [IDS.organization, IDS.isoSource]
    ));
    assert.deepEqual(selected.rows, [{source_format: "iso_19115_3", document: xml}]);
    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.governed_resource_versions
         (id, organization_id, resource_id, version_number, title, created_by)
       VALUES ($1, $2, $3, 5, 'Invalid source revision', $4)`,
      [IDS.resourceVersion5, IDS.organization, IDS.resource, IDS.owner]
    ));
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_metadata_source_documents
           (organization_id, resource_id, resource_version_id, source_format,
            source_version, source_namespace, source_identifier, document,
            checksum_sha256, conversion_report, imported_by)
         VALUES ($1, $2, $3, 'schema_org_dataset', '30.0', 'example.schema',
                 'invalid-json', '<Dataset/>', $4, '{}', $5)`,
        [IDS.organization, IDS.resource, IDS.resourceVersion5, "f".repeat(64), IDS.owner]
      )),
      /invalid input syntax for type json|governed_metadata_sources_document_bounded/
    );
  });

  it("isolates profiles by tenant and denies the processing worker", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.metadata_profiles")
    );
    assert.deepEqual(hidden.rows, []);
    const hiddenSources = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.governed_metadata_source_documents")
    );
    assert.deepEqual(hiddenSources.rows, []);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () =>
        db.query("DELETE FROM app.metadata_profiles WHERE id = $1", [IDS.profile])
      ),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(db.query("SELECT id FROM app.metadata_profiles"), /permission denied/);
    await assert.rejects(
      db.query("SELECT id FROM app.governed_metadata_source_documents"),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
