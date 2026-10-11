import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000431",
  user: "20000000-0000-4000-8000-000000000431",
  collaborator: "20000000-0000-4000-8000-000000000432",
  project: "50000000-0000-4000-8000-000000000431",
  resource: "a0000000-0000-4000-8000-000000000431",
  version: "b0000000-0000-4000-8000-000000000431",
  draft: "c0000000-0000-4000-8000-000000000431",
  revision: "d0000000-0000-4000-8000-000000000431"
};

const CONTENT = {blocks: [{id: "intro", type: "markdown", markdown: "# Roads"}]};
const METADATA = {
  title: "Road story",
  abstract: null,
  language: "en",
  license: null,
  attribution: null,
  keywords: [],
  spatial_extent: null,
  temporal_start: null,
  temporal_end: null,
  profile: "opengeo.core.v1",
  extensions: {},
  translations: {},
  managed_profile_id: null,
  managed_profile_version: null
};

let db;
let migration;

async function tenant(userId, operation) {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [ID.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function createDraft() {
  await db.query(
    `INSERT INTO app.page_working_drafts
       (id, organization_id, project_id, resource_id, owner_user_id,
        base_resource_version)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [ID.draft, ID.organization, ID.project, ID.resource, ID.user]
  );
  await db.query(
    `INSERT INTO app.page_working_draft_revisions
       (id, organization_id, project_id, resource_id, draft_id, owner_user_id,
        base_resource_version, revision_number, visibility, metadata, content,
        provenance, source_block_id, source_markdown, document_checksum_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'restricted', $7::jsonb,
             $8::jsonb, '{}'::jsonb, 'intro', '# Roads', $9)`,
    [
      ID.revision,
      ID.organization,
      ID.project,
      ID.resource,
      ID.draft,
      ID.user,
      JSON.stringify(METADATA),
      JSON.stringify(CONTENT),
      "a".repeat(64)
    ]
  );
  await db.query(
    `UPDATE app.page_working_drafts
     SET current_revision_number = 1, current_document_checksum_sha256 = $1
     WHERE organization_id = $2 AND id = $3`,
    ["a".repeat(64), ID.organization, ID.draft]
  );
}

describe("0043 recoverable page drafts", () => {
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
      "0043_recoverable_page_drafts.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      if (file === "0043_recoverable_page_drafts.sql") migration = sql;
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'draft-author', 'author@example.test', 'Draft Author'),
        ('${ID.collaborator}', 'draft-collaborator', 'collaborator@example.test', 'Collaborator');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${ID.organization}', 'Drafts', 'drafts', '${ID.user}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.organization}', '${ID.collaborator}', 'member', '${ID.user}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Draft project', '${ID.user}');
      SET ROLE opengeo_runtime;
    `);
    await tenant(ID.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'story', 'road-story', $4, $5, $5, $5)`,
        [ID.resource, ID.organization, ID.project, ID.version, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1, $2, $3, 1, 'Road story', $4::jsonb, $5)`,
        [ID.version, ID.organization, ID.resource, JSON.stringify(CONTENT), ID.user]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("appends an exact full-document revision and advances its private head", async () => {
    const result = await tenant(ID.user, async () => {
      await createDraft();
      return db.query(
        `SELECT head.base_resource_version, head.current_revision_number,
                head.current_document_checksum_sha256, revision.visibility::text,
                revision.metadata, revision.content, revision.source_markdown
         FROM app.page_working_drafts head
         JOIN app.page_working_draft_revisions revision
           ON revision.organization_id = head.organization_id
          AND revision.draft_id = head.id
          AND revision.revision_number = head.current_revision_number
         WHERE head.organization_id = $1 AND head.resource_id = $2`,
        [ID.organization, ID.resource]
      );
    });
    assert.equal(result.rows[0].base_resource_version, 1);
    assert.equal(result.rows[0].current_revision_number, 1);
    assert.equal(result.rows[0].current_document_checksum_sha256, "a".repeat(64));
    assert.equal(result.rows[0].visibility, "restricted");
    assert.deepEqual(result.rows[0].content, CONTENT);
    assert.equal(result.rows[0].source_markdown, "# Roads");
  });

  it("hides one author's recovery state from a collaborator in the same tenant", async () => {
    const hidden = await tenant(ID.collaborator, () => db.query(
      "SELECT id FROM app.page_working_drafts WHERE resource_id = $1",
      [ID.resource]
    ));
    assert.equal(hidden.rows.length, 0);
    await assert.rejects(
      tenant(ID.collaborator, () => db.query(
        `SELECT app.discard_page_working_draft($1, $2, $3, $4, 1, 1)`,
        [ID.organization, ID.project, ID.resource, ID.user]
      )),
      /discard scope is invalid/
    );
  });

  it("rejects direct history mutation and stale discard compare-and-swap", async () => {
    await assert.rejects(
      tenant(ID.user, () => db.query(
        "UPDATE app.page_working_draft_revisions SET source_markdown = '# Rewritten' WHERE id = $1",
        [ID.revision]
      )),
      /permission denied for table page_working_draft_revisions|revisions are immutable/
    );
    await assert.rejects(
      tenant(ID.user, () => db.query(
        `SELECT app.discard_page_working_draft($1, $2, $3, $4, 1, 0)`,
        [ID.organization, ID.project, ID.resource, ID.user]
      )),
      /revision conflict/
    );
    const stillPresent = await tenant(ID.user, () => db.query(
      "SELECT current_revision_number FROM app.page_working_drafts WHERE id = $1",
      [ID.draft]
    ));
    assert.equal(stillPresent.rows[0].current_revision_number, 1);
  });

  it("deletes the private recovery history only through an exact explicit discard", async () => {
    const discarded = await tenant(ID.user, () => db.query(
      `SELECT app.discard_page_working_draft($1, $2, $3, $4, 1, 1) AS discarded`,
      [ID.organization, ID.project, ID.resource, ID.user]
    ));
    assert.equal(discarded.rows[0].discarded, true);
    const rows = await tenant(ID.user, () => db.query(
      `SELECT
         (SELECT count(*)::int FROM app.page_working_drafts) AS heads,
         (SELECT count(*)::int FROM app.page_working_draft_revisions) AS revisions`
    ));
    assert.deepEqual(rows.rows[0], {heads: 0, revisions: 0});
  });

  it("declares owner-scoped forced RLS, bounded revisions, no worker access, and scoped cleanup", () => {
    assert.match(migration, /current_revision_number BETWEEN 0 AND 512/);
    assert.match(migration, /page_working_draft_revisions_are_immutable/);
    assert.match(migration, /owner_user_id = app\.current_user_id\(\)/);
    assert.match(migration, /ALTER TABLE app\.page_working_drafts FORCE ROW LEVEL SECURITY/);
    assert.match(migration, /SECURITY DEFINER/);
    assert.match(migration, /REVOKE ALL ON app\.page_working_drafts, app\.page_working_draft_revisions\s+FROM opengeo_worker/);
  });
});
