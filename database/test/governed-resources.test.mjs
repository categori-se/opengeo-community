import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000091",
  otherOrganization: "10000000-0000-4000-8000-000000000092",
  user: "20000000-0000-4000-8000-000000000091",
  otherUser: "20000000-0000-4000-8000-000000000092",
  project: "50000000-0000-4000-8000-000000000091",
  map: "60000000-0000-4000-8000-000000000091",
  dataset: "80000000-0000-4000-8000-000000000091",
  datasetResource: "a0000000-0000-4000-8000-000000000091",
  storyResource: "a0000000-0000-4000-8000-000000000092",
  datasetVersion: "b0000000-0000-4000-8000-000000000091",
  storyVersion: "b0000000-0000-4000-8000-000000000092",
  storyVersion2: "b0000000-0000-4000-8000-000000000093",
  relationship: "c0000000-0000-4000-8000-000000000091"
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

describe("0009/0081/0082 governed resource migrations", () => {
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
      "0081_unique_governed_dataset_resources.sql",
      "0082_unique_governed_map_resources.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.user}', 'resource-user', 'resource@example.test', 'Resource Admin'),
        ('${IDS.otherUser}', 'other-resource-user', 'other-resource@example.test', 'Other Admin');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Resources', 'resources', '${IDS.user}'),
        ('${IDS.otherOrganization}', 'Other Resources', 'other-resources', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.user}', 'admin', '${IDS.user}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Resource project', '${IDS.user}');
      INSERT INTO app.maps
        (id, organization_id, project_id, name, created_by, updated_by)
      VALUES ('${IDS.map}', '${IDS.organization}', '${IDS.project}', 'Resource map', '${IDS.user}', '${IDS.user}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${IDS.dataset}', '${IDS.organization}', 'Resource dataset', 'internal',
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

  it("stores versioned typed resources, external identities, and relationships", async () => {
    const result = await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, dataset_id,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'dataset', 'road-network', $4, $5, $6, $6, $6)`,
        [IDS.datasetResource, IDS.organization, IDS.project, IDS.dataset, IDS.datasetVersion, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, abstract,
            keywords, spatial_extent, metadata_extensions, content, provenance, created_by)
         VALUES ($1, $2, $3, 1, 'Road network', 'Verified roads',
                 ARRAY['roads','transport'], '[-1,-2,3,4]'::jsonb,
                 '{"geonode":{"uuid":"11111111-1111-4111-8111-111111111111"}}'::jsonb,
                 '{"blocks":[]}'::jsonb, '{"source":"geonode"}'::jsonb, $4)`,
        [IDS.datasetVersion, IDS.organization, IDS.datasetResource, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, visibility, state,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'story', 'road-story', 'organization', 'review',
                 $4, $5, $5, $5)`,
        [IDS.storyResource, IDS.organization, IDS.project, IDS.storyVersion, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1, $2, $3, 1, 'Road story',
                 '{"blocks":[{"id":"intro","type":"markdown","markdown":"# Roads"}]}'::jsonb, $4)`,
        [IDS.storyVersion, IDS.organization, IDS.storyResource, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_external_identifiers
           (organization_id, resource_id, namespace, identifier, source_url,
            source_version, source_payload_sha256, imported_by)
         VALUES ($1, $2, 'geonode', '11111111-1111-4111-8111-111111111111',
                 'https://catalog.example.test', '5.1.0', $3, $4)`,
        [IDS.organization, IDS.datasetResource, "a".repeat(64), IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_relationships
           (id, organization_id, project_id, source_resource_id,
            target_resource_id, relation, created_by)
         VALUES ($1, $2, $3, $4, $5, 'references', $6)`,
        [IDS.relationship, IDS.organization, IDS.project, IDS.storyResource, IDS.datasetResource, IDS.user]
      );
      return db.query(
        `SELECT resource.kind::text, resource.slug, version.title,
                relationship.relation::text, external.identifier
         FROM app.governed_resources resource
         JOIN app.governed_resource_versions version
           ON version.organization_id = resource.organization_id
          AND version.resource_id = resource.id
          AND version.id = resource.current_version_id
         LEFT JOIN app.governed_resource_relationships relationship
           ON relationship.organization_id = resource.organization_id
          AND relationship.source_resource_id = resource.id
         LEFT JOIN app.governed_resource_external_identifiers external
           ON external.organization_id = resource.organization_id
          AND external.resource_id = relationship.target_resource_id
         WHERE resource.id = $1`,
        [IDS.storyResource]
      );
    });
    assert.deepEqual(result.rows, [{
      kind: "story",
      slug: "road-story",
      title: "Road story",
      relation: "references",
      identifier: "11111111-1111-4111-8111-111111111111"
    }]);
  });

  it("appends immutable versions under a forward-only resource state", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content,
            change_message, created_by)
         VALUES ($1, $2, $3, 2, 'Road story revised',
                 '{"blocks":[{"id":"intro","type":"markdown","markdown":"# Safer roads"}]}'::jsonb,
                 'Editorial revision', $4)`,
        [IDS.storyVersion2, IDS.organization, IDS.storyResource, IDS.user]
      );
      await db.query(
        `UPDATE app.governed_resources
         SET current_version_id = $1, state = 'published', updated_by = $2
         WHERE organization_id = $3 AND id = $4`,
        [IDS.storyVersion2, IDS.user, IDS.organization, IDS.storyResource]
      );
    });
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.governed_resource_versions SET title = 'mutated'
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.storyVersion]
      )),
      /permission denied/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `UPDATE app.governed_resources SET state = 'draft'
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.storyResource]
      )),
      /forward-only/
    );
  });

  it("prevents external identity collisions and hides all rows cross-tenant", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `INSERT INTO app.governed_resource_external_identifiers
           (organization_id, resource_id, namespace, identifier, source_url,
            source_version, source_payload_sha256, imported_by)
         VALUES ($1, $2, 'geonode', '11111111-1111-4111-8111-111111111111',
                 'https://other.example.test', '5.1.0', $3, $4)`,
        [IDS.organization, IDS.storyResource, "b".repeat(64), IDS.user]
      )),
      /unique|duplicate/i
    );
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.governed_resources")
    );
    assert.deepEqual(hidden.rows, []);
  });

  it("allows one canonical dataset resource while retaining independent service resources", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, dataset_id,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ('a0000000-0000-4000-8000-000000000099', $1, $2, 'dataset',
                 'competing-road-network', $3,
                 'b0000000-0000-4000-8000-000000000099', $4, $4, $4)`,
        [IDS.organization, IDS.project, IDS.dataset, IDS.user]
      )),
      /unique|duplicate/i
    );

    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, dataset_id,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ('a0000000-0000-4000-8000-000000000098', $1, $2, 'service',
                 'road-network-service', $3,
                 'b0000000-0000-4000-8000-000000000098', $4, $4, $4)`,
        [IDS.organization, IDS.project, IDS.dataset, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ('b0000000-0000-4000-8000-000000000098', $1,
                 'a0000000-0000-4000-8000-000000000098', 1,
                 'Road network service', '{"blocks":[]}'::jsonb, $2)`,
        [IDS.organization, IDS.user]
      );
    });

    const bindings = await inTenant(IDS.organization, IDS.user, () => db.query(
      `SELECT kind::text, count(*)::int AS count
       FROM app.governed_resources
       WHERE dataset_id = $1
       GROUP BY kind ORDER BY kind`,
      [IDS.dataset]
    ));
    assert.deepEqual(bindings.rows, [
      {kind: "dataset", count: 1},
      {kind: "service", count: 1}
    ]);
  });

  it("allows only one canonical governed resource for a durable project map", async () => {
    await inTenant(IDS.organization, IDS.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, map_id,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ('a0000000-0000-4000-8000-000000000097', $1, $2, 'map',
                 'resource-map', $3,
                 'b0000000-0000-4000-8000-000000000097', $4, $4, $4)`,
        [IDS.organization, IDS.project, IDS.map, IDS.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ('b0000000-0000-4000-8000-000000000097', $1,
                 'a0000000-0000-4000-8000-000000000097', 1,
                 'Resource map', '{"blocks":[]}'::jsonb, $2)`,
        [IDS.organization, IDS.user]
      );
    });

    await assert.rejects(
      inTenant(IDS.organization, IDS.user, () => db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, map_id,
            current_version_id, owner_user_id, created_by, updated_by)
         VALUES ('a0000000-0000-4000-8000-000000000096', $1, $2, 'map',
                 'competing-resource-map', $3,
                 'b0000000-0000-4000-8000-000000000096', $4, $4, $4)`,
        [IDS.organization, IDS.project, IDS.map, IDS.user]
      )),
      /unique|duplicate/i
    );
  });

  it("keeps the isolated worker outside the governed resource tables", async () => {
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(db.query("SELECT id FROM app.governed_resources"), /permission denied/);
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
