import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000421",
  otherOrganization: "10000000-0000-4000-8000-000000000422",
  user: "20000000-0000-4000-8000-000000000421",
  otherUser: "20000000-0000-4000-8000-000000000422",
  project: "50000000-0000-4000-8000-000000000421",
  resource: "a0000000-0000-4000-8000-000000000421",
  version1: "b0000000-0000-4000-8000-000000000421",
  version2: "b0000000-0000-4000-8000-000000000422",
  upload: "c0000000-0000-4000-8000-000000000421",
  source: "d0000000-0000-4000-8000-000000000421",
  edition: "e0000000-0000-4000-8000-000000000421"
};

let db;
let sourceMigration;
let rendererMigration;

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

describe("0042/0044 governed page sources and pinned structural renderer", () => {
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
      "0042_governed_page_sources.sql",
      "0044_structural_page_blocks.sql"
    ]) {
      if (file === "0042_governed_page_sources.sql") {
        await db.exec(`
          CREATE TABLE app.project_site_editions (
            id uuid PRIMARY KEY,
            organization_id uuid NOT NULL,
            manifest jsonb NOT NULL
          );
          GRANT SELECT, INSERT ON app.project_site_editions TO opengeo_runtime;
        `);
      }
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      if (file === "0042_governed_page_sources.sql") sourceMigration = sql;
      if (file === "0044_structural_page_blocks.sql") rendererMigration = sql;
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'page-author', 'author@example.test', 'Page Author'),
        ('${ID.otherUser}', 'other-author', 'other@example.test', 'Other Author');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Authoring', 'authoring', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-authoring', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Page project', '${ID.user}');
      SET ROLE opengeo_runtime;
    `);
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.governed_resources
           (id, organization_id, project_id, kind, slug, current_version_id,
            owner_user_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'story', 'road-story', $4, $5, $5, $5)`,
        [ID.resource, ID.organization, ID.project, ID.version1, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content, created_by)
         VALUES ($1, $2, $3, 1, 'Road story',
                 '{"blocks":[{"id":"intro","type":"markdown","markdown":"# Roads"}]}'::jsonb,
                 $4)`,
        [ID.version1, ID.organization, ID.resource, ID.user]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("atomically binds one exact private source object to its intended resource version", async () => {
    const key = `organizations/${ID.organization}/projects/${ID.project}/pages/${ID.resource}/versions/2/uploads/${ID.upload}/source.md`;
    const row = await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.page_source_upload_intents
           (id, organization_id, project_id, resource_id, expected_resource_version,
            source_block_id, expected_size_bytes, expected_sha256, bucket, object_key,
            created_by, expires_at)
         VALUES ($1, $2, $3, $4, 1, 'intro', 7, $5,
                 'source.opengeo.tools', $6, $7, clock_timestamp() + interval '15 minutes')`,
        [ID.upload, ID.organization, ID.project, ID.resource, "a".repeat(64), key, ID.user]
      );
      await db.query(
        `INSERT INTO app.governed_resource_versions
           (id, organization_id, resource_id, version_number, title, content,
            change_message, created_by)
         VALUES ($1, $2, $3, 2, 'Road story',
                 '{"blocks":[{"id":"intro","type":"markdown","markdown":"# Roads"}]}'::jsonb,
                 'Clarify road access', $4)`,
        [ID.version2, ID.organization, ID.resource, ID.user]
      );
      await db.query(
        `INSERT INTO app.page_source_objects
           (id, organization_id, project_id, resource_id, resource_version_id,
            upload_intent_id, source_block_id, bucket, object_key, s3_version_id,
            etag, content_type, size_bytes, checksum_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'intro', 'source.opengeo.tools', $7,
                 'immutable-v1', 'source-etag', 'text/markdown', 7, $8, $9)`,
        [
          ID.source, ID.organization, ID.project, ID.resource, ID.version2,
          ID.upload, key, "a".repeat(64), ID.user
        ]
      );
      await db.query(
        `UPDATE app.governed_resources SET current_version_id = $1, updated_by = $2
         WHERE organization_id = $3 AND id = $4`,
        [ID.version2, ID.user, ID.organization, ID.resource]
      );
      await db.query(
        `UPDATE app.page_source_upload_intents
         SET state = 'completed', completed_source_object_id = $1,
             completed_at = clock_timestamp()
         WHERE organization_id = $2 AND id = $3`,
        [ID.source, ID.organization, ID.upload]
      );
      return db.query(
        `SELECT version.version_number, version.change_message, source.bucket,
                source.object_key, source.s3_version_id, source.checksum_sha256,
                source.dialect, source.dialect_version, source.compiler_version,
                intent.state::text
         FROM app.page_source_objects source
         JOIN app.governed_resource_versions version
           ON version.organization_id = source.organization_id
          AND version.id = source.resource_version_id
         JOIN app.page_source_upload_intents intent
           ON intent.organization_id = source.organization_id
          AND intent.id = source.upload_intent_id
         WHERE source.organization_id = $1 AND source.id = $2`,
        [ID.organization, ID.source]
      );
    });

    assert.equal(row.rows[0].version_number, 2);
    assert.equal(row.rows[0].change_message, "Clarify road access");
    assert.equal(row.rows[0].bucket, "source.opengeo.tools");
    assert.equal(row.rows[0].s3_version_id, "immutable-v1");
    assert.equal(row.rows[0].checksum_sha256, "a".repeat(64));
    assert.equal(row.rows[0].dialect, "opengeo-markdown");
    assert.equal(row.rows[0].compiler_version, "opengeo-page-renderer-1.1.0");
    assert.equal(row.rows[0].state, "completed");
  });

  it("rejects source history mutation and hides it across tenant context", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        "UPDATE app.page_source_objects SET etag = 'rewritten' WHERE id = $1",
        [ID.source]
      )),
      /permission denied for table page_source_objects|governed resource history is immutable/
    );
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT id FROM app.page_source_objects WHERE id = $1",
      [ID.source]
    ));
    assert.equal(hidden.rows.length, 0);
  });

  it("requires the one pinned renderer identity on every new site edition", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO app.project_site_editions (id, organization_id, manifest)
         VALUES ($1, $2, '{}'::jsonb)`,
        [ID.edition, ID.organization]
      ),
      /site edition renderer identity is missing or unsupported/
    );
    const manifest = {
      rendererVersion: "opengeo-page-renderer-1.1.0",
      pages: [{
        resourceId: ID.resource,
        resourceVersionId: ID.version2,
        pageSource: {
          sourceId: ID.source,
          sourceBlockId: "intro",
          s3VersionId: "immutable-v1",
          etag: "source-etag",
          contentType: "text/markdown",
          sizeBytes: 7,
          checksumSha256: "a".repeat(64),
          dialect: "opengeo-markdown",
          dialectVersion: "1.0.0",
          compilerVersion: "opengeo-page-renderer-1.1.0"
        }
      }]
    };
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.project_site_editions (id, organization_id, manifest)
         VALUES ($1, $2, $3::jsonb)`,
        [ID.edition, ID.organization, JSON.stringify({
          ...manifest,
          pages: [{...manifest.pages[0], pageSource: null}]
        })]
      )),
      /site edition page source seal is missing or mismatched/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.project_site_editions (id, organization_id, manifest)
         VALUES ($1, $2, $3::jsonb)`,
        [ID.edition, ID.organization, JSON.stringify({
          ...manifest,
          rendererVersion: "opengeo-page-renderer-1.0.0"
        })]
      )),
      /site edition renderer identity is missing or unsupported/
    );
    await tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.project_site_editions (id, organization_id, manifest)
       VALUES ($1, $2, $3::jsonb)`,
      [ID.edition, ID.organization, JSON.stringify(manifest)]
    ));
    const stored = await db.query(
      "SELECT manifest->>'rendererVersion' AS renderer FROM app.project_site_editions WHERE id=$1",
      [ID.edition]
    );
    assert.equal(stored.rows[0].renderer, "opengeo-page-renderer-1.1.0");
  });

  it("declares forced RLS, bounded exact facts, immutable history, and no worker access", () => {
    assert.match(sourceMigration, /page_source_objects_exact_facts/);
    assert.match(sourceMigration, /page_source_objects_compiler_identity/);
    assert.match(sourceMigration, /project_site_editions_require_page_renderer/);
    assert.match(sourceMigration, /ALTER TABLE app\.page_source_objects FORCE ROW LEVEL SECURITY/);
    assert.match(sourceMigration, /page_source_objects_are_immutable/);
    assert.match(sourceMigration, /REVOKE ALL ON app\.page_source_upload_intents, app\.page_source_objects FROM opengeo_worker/);
    assert.match(rendererMigration, /ALTER COLUMN compiler_version SET DEFAULT 'opengeo-page-renderer-1\.1\.0'/);
    assert.match(rendererMigration, /'opengeo-page-renderer-1\.0\.0'/);
    assert.match(rendererMigration, /'opengeo-page-renderer-1\.1\.0'/);
    assert.match(rendererMigration, /REVOKE EXECUTE ON FUNCTION app\.enforce_page_renderer_identity/);
  });
});
