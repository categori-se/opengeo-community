import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-0000000000a1",
  otherOrganization: "10000000-0000-4000-8000-0000000000a2",
  owner: "20000000-0000-4000-8000-0000000000a1",
  member: "20000000-0000-4000-8000-0000000000a2",
  otherUser: "20000000-0000-4000-8000-0000000000a3",
  project: "50000000-0000-4000-8000-0000000000a1",
  dataset: "80000000-0000-4000-8000-0000000000a1",
  resource: "a0000000-0000-4000-8000-0000000000a1",
  resourceVersion: "b0000000-0000-4000-8000-0000000000a1",
  style: "c0000000-0000-4000-8000-0000000000a1",
  styleVersion: "d0000000-0000-4000-8000-0000000000a1",
  styleVersion2: "d0000000-0000-4000-8000-0000000000a2",
  submitted: "e0000000-0000-4000-8000-0000000000a1",
  published: "e0000000-0000-4000-8000-0000000000a2"
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

describe("0010 resource governance migration", () => {
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
      "0168_draft_resource_archival.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'governance-owner', 'owner@example.test', 'Owner'),
        ('${IDS.member}', 'governance-member', 'member@example.test', 'Member'),
        ('${IDS.otherUser}', 'governance-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'Governance', 'governance', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other', 'governance-other', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.member}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Governed project', '${IDS.owner}');
      INSERT INTO app.datasets
        (id, organization_id, name, classification, source_type, format, status,
         owner_user_id, created_by, updated_by)
      VALUES ('${IDS.dataset}', '${IDS.organization}', 'Roads', 'internal',
              'upload', 'geojson', 'active', '${IDS.owner}', '${IDS.owner}', '${IDS.owner}');
      INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.dataset}', '${IDS.owner}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("binds a staged import exactly once and stores resource grants", async () => {
    const result = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'dataset', 'imported-roads', $4, $5, $5, $5)`,
        [IDS.resource, IDS.organization, IDS.project, IDS.resourceVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, created_by)
         VALUES ($1, $2, $3, 1, 'Imported roads', $4)`,
        [IDS.resourceVersion, IDS.organization, IDS.resource, IDS.owner]
      );
      await db.query(
        `UPDATE app.governed_resources SET dataset_id = $1, updated_by = $2
         WHERE organization_id = $3 AND id = $4`,
        [IDS.dataset, IDS.owner, IDS.organization, IDS.resource]
      );
      await db.query(
        `INSERT INTO app.governed_resource_permissions
           (organization_id, resource_id, user_id, role, granted_by)
         VALUES ($1, $2, $3, 'edit', $4)`,
        [IDS.organization, IDS.resource, IDS.member, IDS.owner]
      );
      return db.query(
        `SELECT resource.dataset_id, permission.role::text
         FROM app.governed_resources resource
         JOIN app.governed_resource_permissions permission
           ON permission.organization_id = resource.organization_id
          AND permission.resource_id = resource.id
         WHERE resource.organization_id = $1 AND resource.id = $2`,
        [IDS.organization, IDS.resource]
      );
    });
    assert.deepEqual(result.rows, [{dataset_id: IDS.dataset, role: "edit"}]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `UPDATE app.governed_resources SET dataset_id = NULL
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.resource]
      )),
      /established binding are immutable/
    );
  });

  it("versions detached portable styles and enforces the editorial path", async () => {
    await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_resource_styles
           (id, organization_id, project_id, resource_id, slug, format,
            current_version_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'roads-default', 'maplibre', $5, $6, $6)`,
        [IDS.style, IDS.organization, IDS.project, IDS.resource, IDS.styleVersion, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_style_versions
           (id, organization_id, style_id, version_number, title, media_type,
            definition, checksum_sha256, created_by)
         VALUES ($1, $2, $3, 1, 'Roads default', 'application/vnd.mapbox.style+json',
                 '{"version":8}', $4, $5)`,
        [IDS.styleVersion, IDS.organization, IDS.style, "a".repeat(64), IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_style_versions
           (id, organization_id, style_id, version_number, title, media_type,
            definition, checksum_sha256, change_message, created_by)
         VALUES ($1, $2, $3, 2, 'Roads revised', 'application/vnd.mapbox.style+json',
                 '{"version":8,"layers":[]}', $4, 'Cartographic review', $5)`,
        [IDS.styleVersion2, IDS.organization, IDS.style, "b".repeat(64), IDS.owner]
      );
      await db.query(
        `UPDATE app.governed_resource_styles SET current_version_id = $1, updated_by = $2
         WHERE organization_id = $3 AND id = $4`,
        [IDS.styleVersion2, IDS.owner, IDS.organization, IDS.style]
      );
    });
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `UPDATE app.governed_resources SET state = 'published'
         WHERE organization_id = $1 AND id = $2`,
        [IDS.organization, IDS.resource]
      )),
      /invalid governed resource state transition/
    );
    const workflow = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `UPDATE app.governed_resources SET state = 'review', updated_by = $1
         WHERE organization_id = $2 AND id = $3`,
        [IDS.owner, IDS.organization, IDS.resource]
      );
      await db.query(
        `INSERT INTO app.governed_resource_workflow_events
           (id, organization_id, project_id, resource_id, source_state,
            target_state, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, 'draft', 'review', 'Ready', $5)`,
        [IDS.submitted, IDS.organization, IDS.project, IDS.resource, IDS.owner]
      );
      await db.query(
        `UPDATE app.governed_resources
         SET state = 'published', visibility = 'organization', updated_by = $1
         WHERE organization_id = $2 AND id = $3`,
        [IDS.owner, IDS.organization, IDS.resource]
      );
      await db.query(
        `INSERT INTO app.governed_resource_workflow_events
           (id, organization_id, project_id, resource_id, source_state,
            target_state, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, 'review', 'published', 'Approved', $5)`,
        [IDS.published, IDS.organization, IDS.project, IDS.resource, IDS.owner]
      );
      return db.query(
        `SELECT target_state::text FROM app.governed_resource_workflow_events
         WHERE organization_id = $1 AND resource_id = $2 ORDER BY created_at, id`,
        [IDS.organization, IDS.resource]
      );
    });
    assert.deepEqual(workflow.rows.map((row) => row.target_state), ["review", "published"]);
  });

  it("archives a draft with attributed history while preserving its version and denying reverse transitions", async () => {
    const resource = "a0000000-0000-4000-8000-0000000000a2";
    const version = "b0000000-0000-4000-8000-0000000000a2";
    const archived = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'service', 'archived-draft', $4, $5, $5, $5)`,
        [resource, IDS.organization, IDS.project, version, IDS.owner]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, created_by)
         VALUES ($1, $2, $3, 1, 'Draft service', $4)`,
        [version, IDS.organization, resource, IDS.owner]
      );
      await db.query("UPDATE app.governed_resources SET state = 'archived' WHERE id = $1", [resource]);
      await db.query(
        `INSERT INTO app.governed_resource_workflow_events
           (organization_id, project_id, resource_id, source_state, target_state,
            reason, actor_user_id)
         VALUES ($1, $2, $3, 'draft', 'archived', 'Acceptance complete', $4)`,
        [IDS.organization, IDS.project, resource, IDS.owner]
      );
      return db.query(
        `SELECT r.state::text, r.visibility::text, r.current_version_id,
                e.source_state::text, e.target_state::text, e.actor_user_id
         FROM app.governed_resources r
         JOIN app.governed_resource_workflow_events e ON e.resource_id = r.id
         WHERE r.id = $1`, [resource]
      );
    });
    assert.deepEqual(archived.rows, [{state: "archived", visibility: "restricted",
      current_version_id: version, source_state: "draft", target_state: "archived",
      actor_user_id: IDS.owner}]);
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "UPDATE app.governed_resources SET state = 'draft' WHERE id = $1", [resource]
      )), /invalid governed resource state transition/
    );
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.governed_resource_workflow_events
           (organization_id, project_id, resource_id, source_state, target_state, actor_user_id)
         VALUES ($1, $2, $3, 'archived', 'draft', $4)`,
        [IDS.organization, IDS.project, resource, IDS.owner]
      )), /governed_resource_workflow_transition_valid/
    );
  });

  it("keeps new governance rows tenant-isolated and unavailable to the worker", async () => {
    const hidden = await inTenant(IDS.otherOrganization, IDS.otherUser, () =>
      db.query("SELECT id FROM app.governed_resource_styles")
    );
    assert.deepEqual(hidden.rows, []);
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT id FROM app.governed_resource_workflow_events"),
      /permission denied/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
});
