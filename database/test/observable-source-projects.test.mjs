import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000451",
  otherOrganization: "10000000-0000-4000-8000-000000000452",
  user: "20000000-0000-4000-8000-000000000451",
  otherUser: "20000000-0000-4000-8000-000000000452",
  project: "50000000-0000-4000-8000-000000000451",
  site: "a0000000-0000-4000-8000-000000000451",
  siteVersion: "a1000000-0000-4000-8000-000000000451",
  sourceProject: "b0000000-0000-4000-8000-000000000451",
  markdownUpload: "c0000000-0000-4000-8000-000000000451",
  lockUpload: "c0000000-0000-4000-8000-000000000452",
  markdownObject: "d0000000-0000-4000-8000-000000000451",
  lockObject: "d0000000-0000-4000-8000-000000000452",
  revision: "e0000000-0000-4000-8000-000000000451",
  build: "f0000000-0000-4000-8000-000000000451",
  retryBuild: "f0000000-0000-4000-8000-000000000452",
  coordinator: "f1000000-0000-4000-8000-000000000451",
  coordinator2: "f1000000-0000-4000-8000-000000000452",
  coordinator3: "f1000000-0000-4000-8000-000000000453",
  coordinator4: "f1000000-0000-4000-8000-000000000454"
};

const limits = {
  cpuMillis: 1000,
  memoryMiB: 2048,
  timeoutSeconds: 120,
  maxInputFiles: 128,
  maxInputBytes: 16_777_216,
  maxOutputFiles: 512,
  maxOutputBytes: 33_554_432
};

let db;
let manifestChecksum;
let requestChecksum;

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

function sourceKey(uploadId, path) {
  return `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/uploads/${uploadId}/files/${path}`;
}

function manifest() {
  return {
    schemaVersion: "opengeo.observable-source-revision.1.0.0",
    sourceProjectId: ID.sourceProject,
    revisionId: ID.revision,
    revisionNumber: 1,
    entryPath: "src/index.md",
    lockfilePath: "package-lock.json",
    files: [
      {
        path: "package-lock.json",
        objectId: ID.lockObject,
        bucket: "source.opengeo.tools",
        objectKey: sourceKey(ID.lockUpload, "package-lock.json"),
        s3VersionId: "lock-v1",
        etag: "lock-etag",
        contentType: "application/json",
        sizeBytes: 18,
        checksumSha256: "b".repeat(64)
      },
      {
        path: "src/index.md",
        objectId: ID.markdownObject,
        bucket: "source.opengeo.tools",
        objectKey: sourceKey(ID.markdownUpload, "src/index.md"),
        s3VersionId: "markdown-v1",
        etag: "markdown-etag",
        contentType: "text/markdown",
        sizeBytes: 12,
        checksumSha256: "a".repeat(64)
      }
    ]
  };
}

function buildRequest() {
  return {
    schemaVersion: "opengeo.observable-build-request.1.0.0",
    sourceProjectId: ID.sourceProject,
    sourceRevisionId: ID.revision,
    sourceRevisionNumber: 1,
    sourceManifestChecksumSha256: manifestChecksum,
    purpose: "preview",
    compilerImageDigest: `sha256:${"c".repeat(64)}`,
    frameworkVersion: "1.13.4",
    lockfileFormat: "npm-package-lock-v3",
    lockfileChecksumSha256: "b".repeat(64),
    networkPolicy: "deny_all",
    resourceLimits: limits
  };
}

function pgliteChecksumMigration(sql) {
  return sql
    .replace(
      /NEW\.manifest_checksum_sha256 := encode\(\s*digest\(convert_to\(NEW\.manifest::text, 'UTF8'\), 'sha256'\),\s*'hex'\s*\);/s,
      "NEW.manifest_checksum_sha256 := NEW.manifest_checksum_sha256;"
    )
    .replace(
      /NEW\.request_checksum_sha256 := encode\(\s*digest\(convert_to\(NEW\.request::text, 'UTF8'\), 'sha256'\),\s*'hex'\s*\);/s,
      "NEW.request_checksum_sha256 := NEW.request_checksum_sha256;"
    )
    .replace(
      /NEW\.result_checksum_sha256 := encode\(\s*digest\(convert_to\(NEW\.result::text, 'UTF8'\), 'sha256'\),\s*'hex'\s*\);/s,
      "NEW.result_checksum_sha256 := repeat('f', 64);"
    );
}

describe("0045 durable Observable source projects and credential-free build boundary", {concurrency: false}, () => {
  before(async () => {
    db = new PGlite();
    // The focused migration subset omits the connector implementation; 0050
    // still explicitly revokes its access to team membership tables.
    await db.exec("CREATE ROLE opengeo_connector NOLOGIN");
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
      "0025_portable_site_publications.sql",
      "0045_observable_source_projects.sql",
      "0046_observable_preview_capabilities.sql",
      "0049_observable_coordinator_runtime.sql",
      "0050_team_project_access.sql",
      "0086_observable_data_attachments.sql",
      "0087_observable_revision_data_bindings.sql",
      "0088_observable_archive_preview_staging.sql",
      "0090_github_publication_connections.sql",
      "0091_github_build_dispatch.sql",
      "0092_framework_publication_reviews.sql",
      "0093_framework_publisher_runtime.sql",
      "0094_github_source_sync.sql",
      "0095_github_build_logs.sql",
      "0096_observable_source_path_collation.sql",
      "0098_static_html_publication_entries.sql",
      "0099_jupyter_publication_entries.sql",
      "0100_publication_destination_reservations.sql",
      "0101_background_project_authority.sql",
      "0102_observable_compiler_transitions.sql",
      "0103_delegated_publication_addresses.sql",
      "0104_observable_cache_admission.sql",
      "0158_opengeo_publication_build_sources.sql",
      "0160_observable_tiff_archive_bindings.sql",
      "0176_observable_preview_membership_history.sql"
    ]) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      if (file === "0045_observable_source_projects.sql") sql = pgliteChecksumMigration(sql);
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'source-author', 'source@example.test', 'Source Author'),
        ('${ID.otherUser}', 'other-source-author', 'other@example.test', 'Other Author');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Source authoring', 'source-authoring', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other source authoring', 'other-source-authoring', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'admin', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Observable source project', '${ID.user}');
      SET ROLE opengeo_runtime;
    `);
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.project_sites
           (id, organization_id, project_id, slug, current_version_id,
            current_version_number, state, created_by, updated_by)
         VALUES ($1, $2, $3, 'field-report', $4, 1, 'draft', $5, $5)`,
        [ID.site, ID.organization, ID.project, ID.siteVersion, ID.user]
      );
      await db.query(
        `INSERT INTO app.project_site_versions
           (id, organization_id, project_id, site_id, version_number,
            title, theme, created_by)
         VALUES ($1, $2, $3, $4, 1, 'Field report', 'paper', $5)`,
        [ID.siteVersion, ID.organization, ID.project, ID.site, ID.user]
      );
      await db.query(
        `INSERT INTO app.observable_source_projects
           (id, organization_id, project_id, site_id, route_namespace, title,
            rights_status, owner_user_id, compiler_image_digest, resource_limits,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'field-report', 'Field report source',
                 'unreviewed', $5, $6, $7::jsonb, $5, $5)`,
        [
          ID.sourceProject,
          ID.organization,
          ID.project,
          ID.site,
          ID.user,
          `sha256:${"c".repeat(64)}`,
          JSON.stringify(limits)
        ]
      );
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("GitHub connections require an operator grant and keep project bindings immutable", async () => {
    const connection = "a9000000-0000-4000-8000-000000000490";
    await db.exec("RESET ROLE");
    await db.query(`INSERT INTO app.github_publication_connections
      (id, organization_id, installation_id, repository_id, repository, enabled, verified_at, verified_by)
      VALUES ($1, $2, 7, 123, 'owner/private-source', true, now(), $3)`,
      [connection, ID.organization, ID.user]);
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(tenant(ID.organization, ID.user, () => db.query(`
      INSERT INTO app.github_publication_connections
      (organization_id, installation_id, repository_id, repository, verified_at, verified_by)
      VALUES ($1, 8, 456, 'unapproved/source', now(), $2)`, [ID.organization, ID.user])), /permission denied/);
    await tenant(ID.organization, ID.user, () => db.query(`
      INSERT INTO app.observable_github_links
      (organization_id, project_id, source_project_id, connection_id, created_by)
      VALUES ($1, $2, $3, $4, $5)`, [ID.organization, ID.project, ID.sourceProject, connection, ID.user]));
    await assert.rejects(tenant(ID.organization, ID.user, () => db.query(`
      UPDATE app.observable_github_links SET connection_id = $1`, [connection])), /permission denied|immutable/);
    const foreign = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT * FROM app.observable_github_links"));
    assert.equal(foreign.rows.length, 0);
  });

  it("binds TIFF archives with exact metadata and the existing 64 MiB and access boundaries", async () => {
    await db.exec("BEGIN; RESET ROLE");
    try {
      const dataset = "60000000-0000-4000-8000-000000000986";
      const version = "70000000-0000-4000-8000-000000000986";
      const object = "80000000-0000-4000-8000-000000000986";
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization, ID.user]);
      await db.query(`INSERT INTO app.datasets (id, organization_id, name, format, status, owner_user_id, created_by, updated_by)
        VALUES ($1, $2, 'Exact TIFF archive', 'cog', 'active', $3, $3, $3)`, [dataset, ID.organization, ID.user]);
      await db.query(`INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
        VALUES ($1, $2, $3, 'original', 'storage.opengeo.tools', 'archive/elevation.tif', 'archive-tiff-v1', 'etag', 'image/tiff', 67108864, $4, $5)`,
      [object, ID.organization, dataset, "a".repeat(64), ID.user]);
      await db.query(`INSERT INTO app.dataset_versions (id, organization_id, dataset_id, version_number, original_object_id, state, created_by)
        VALUES ($1, $2, $3, 1, $4, 'active', $5)`, [version, ID.organization, dataset, object, ID.user]);
      await db.query("INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by) VALUES ($1, $2, $3, $4)", [ID.organization, ID.project, dataset, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const archive = (await db.query(`INSERT INTO app.observable_data_attachments
        (organization_id, project_id, source_project_id, dataset_id, dataset_version_id, data_object_id, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [ID.organization, ID.project, ID.sourceProject, dataset, version, object, ID.user])).rows[0];
      const pin = {path: "src/data/elevation.tif", attachmentId: archive.id, datasetId: dataset,
        datasetVersionId: version, dataObjectId: object, s3VersionId: archive.s3_version_id,
        checksumSha256: archive.checksum_sha256, sizeBytes: Number(archive.size_bytes), contentType: archive.content_type};
      const bound = {...manifest(), schemaVersion: "opengeo.observable-source-revision.2.0.0", dataAttachments: [pin]};
      const validate = value => db.query("SELECT app.validate_observable_revision_data_bindings($1, $2, $3, $4::jsonb) AS pins", [ID.organization, ID.project, ID.sourceProject, JSON.stringify(value)]);
      assert.deepEqual((await validate(bound)).rows[0].pins, [pin]);
      const media = (await db.query(`SELECT app.observable_archive_media_is_supported('elevation.TIFF', 'image/geotiff') AS geo,
        app.observable_archive_media_is_supported('elevation.tif', 'text/javascript') AS executable,
        app.observable_source_media_is_supported('elevation.tif', 'image/tiff') AS uploaded_source`)).rows[0];
      assert.deepEqual(media, {geo: true, executable: false, uploaded_source: false});
      const reject = async (value, pattern) => {
        await db.exec("SAVEPOINT rejected_tiff");
        await assert.rejects(validate(value), pattern);
        await db.exec("ROLLBACK TO SAVEPOINT rejected_tiff");
      };
      await reject({...bound, dataAttachments: [{...pin, s3VersionId: "latest"}]}, /exact registered facts/);
      await reject({...bound, dataAttachments: [{...pin, path: "src/data/elevation.js"}]}, /unsafe/);
      await reject({...bound, dataAttachments: [pin, {...pin, path: "src/data/second.tif"}]}, /64 MiB/);
      await db.query("SELECT set_config('app.user_id', $1, true)", [ID.otherUser]);
      await reject(bound, /manage access/);
    } finally {await db.exec("ROLLBACK; SET ROLE opengeo_runtime");}
  });

  it("registers exact archived data without copying it, rejects invalid pins and retains immutable history", async () => {
    const dataset = "60000000-0000-4000-8000-000000000486";
    const version = "70000000-0000-4000-8000-000000000486";
    const object = "80000000-0000-4000-8000-000000000486";
    await db.exec("RESET ROLE");
    await db.query(`INSERT INTO app.datasets
      (id, organization_id, name, format, status, owner_user_id, created_by, updated_by)
      VALUES ($1, $2, 'Large archived GeoJSON', 'geojson', 'active', $3, $3, $3)`,
      [dataset, ID.organization, ID.user]);
    await db.query(`INSERT INTO app.data_objects
      (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id, etag,
       content_type, size_bytes, checksum_sha256, created_by)
      VALUES ($1, $2, $3, 'original', 'storage.opengeo.tools', 'archive/water.geojson',
        'archive-version-1', 'archive-etag', 'application/geo+json', 18930972, $4, $5)`,
      [object, ID.organization, dataset, "a".repeat(64), ID.user]);
    await db.query(`INSERT INTO app.dataset_versions
      (id, organization_id, dataset_id, version_number, original_object_id, state, created_by)
      VALUES ($1, $2, $3, 1, $4, 'active', $5)`, [version, ID.organization, dataset, object, ID.user]);
    await db.query(`INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
      VALUES ($1, $2, $3, $4)`, [ID.organization, ID.project, dataset, ID.user]);
    await db.query(`INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ($1, $2, 'member', $3)`, [ID.organization, ID.otherUser, ID.user]);
    await db.query(`INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES ($1, $2, $3, 'viewer')`, [ID.organization, ID.project, ID.otherUser]);
    await db.exec("SET ROLE opengeo_runtime");
    const register = (objectId = object, versionId = version, actor = ID.user) => tenant(ID.organization, actor, () => db.query(`
      INSERT INTO app.observable_data_attachments
        (organization_id, project_id, source_project_id, dataset_id, dataset_version_id, data_object_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (organization_id, source_project_id, dataset_version_id, data_object_id) DO NOTHING
      RETURNING *`, [ID.organization, ID.project, ID.sourceProject, dataset, versionId, objectId, actor]));
    await assert.rejects(register(ID.markdownObject), /active exact project dataset object/);
    await assert.rejects(register(object, ID.revision), /active exact project dataset object/);
    const row = (await register()).rows[0];
    assert.equal(Number(row.size_bytes), 18930972);
    assert.equal(row.checksum_sha256, "a".repeat(64));
    assert.equal(row.s3_version_id, "archive-version-1");
    assert.equal(row.content_type, "application/geo+json");
    const repository = await readFile(new URL("../../services/api/src/opengeo_api/observable_sources.py", import.meta.url), "utf8");
    const selection = repository.match(/def _attachment_select\(\) -> str:\s+return """([\s\S]*?)"""/)[1];
    const availability = actor => tenant(ID.organization, actor, () => db.query(
      `${selection} WHERE attachment.id = $1`, [row.id]));
    assert.equal((await availability(ID.user)).rows[0].available, true);
    assert.equal((await availability(ID.otherUser)).rows[0].available, false, "A viewer does not gain download access through the library");
    assert.equal((await register()).rows.length, 0, "A repeated registration is not a second capture");
    await assert.rejects(register(object, version, ID.otherUser), /manage access/);
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT id FROM app.observable_data_attachments WHERE id = $1", [row.id]));
    assert.equal(hidden.rows.length, 0);
    for (const statement of ["UPDATE app.observable_data_attachments SET size_bytes = 1 WHERE id = $1", "DELETE FROM app.observable_data_attachments WHERE id = $1"]) {
      await assert.rejects(tenant(ID.organization, ID.user, () => db.query(statement, [row.id])), /permission denied|immutable/);
    }

    // Metadata-only fixtures exercise the registry bound; no data bytes exist.
    await db.exec("BEGIN; RESET ROLE");
    try {
      await db.query(`INSERT INTO app.data_objects
        (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id, etag,
         content_type, size_bytes, checksum_sha256, created_by)
        SELECT ('80000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
          $1, $2, 'derived', 'storage.opengeo.tools', 'archive/bound-' || i,
          'immutable-v1', 'etag', 'application/geo+json', 64, $3, $4
        FROM generate_series(1, 128) i`, [ID.organization, dataset, "b".repeat(64), ID.user]);
      await db.query(`INSERT INTO app.dataset_version_objects
        SELECT $1, $2, $3, ('80000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
        FROM generate_series(1, 128) i`, [ID.organization, dataset, version]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization, ID.user]);
      const bulk = maximum => db.query(`INSERT INTO app.observable_data_attachments
        (organization_id, project_id, source_project_id, dataset_id, dataset_version_id, data_object_id, created_by)
        SELECT $1, $2, $3, $4, $5, ('80000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, $6
        FROM generate_series(1, $7::integer) i
        ON CONFLICT (organization_id, source_project_id, dataset_version_id, data_object_id) DO NOTHING`,
        [ID.organization, ID.project, ID.sourceProject, dataset, version, ID.user, maximum]);
      await bulk(127);
      assert.equal(Number((await db.query("SELECT count(*) FROM app.observable_data_attachments")).rows[0].count), 128);
      await bulk(127); // Re-registering at the cap remains idempotent.
      await assert.rejects(bulk(128), /attachment limit reached/);
    } finally {
      await db.exec("ROLLBACK; SET ROLE opengeo_runtime");
    }
    // Later full-schema administration owns unlinking; this focused migration
    // subset grants no runtime DELETE on project_datasets.
    await db.exec("RESET ROLE");
    await db.query(
      "DELETE FROM app.project_datasets WHERE organization_id = $1 AND project_id = $2 AND dataset_id = $3",
      [ID.organization, ID.project, dataset]);
    await db.exec("SET ROLE opengeo_runtime");
    await assert.rejects(register(), /active exact project dataset object/);
    const retained = await tenant(ID.organization, ID.user, () => db.query(
      "SELECT id FROM app.observable_data_attachments WHERE id = $1", [row.id]));
    assert.equal(retained.rows.length, 1, "Unlinking data does not rewrite attachment history");
    assert.equal((await availability(ID.user)).rows[0].available, false);
  });

  it("rejects generated, secret-oriented, traversal, and unsupported source paths", async () => {
    const checks = await db.query(
      `SELECT
         app.observable_source_path_is_safe('src/index.md') AS safe,
         app.observable_source_path_is_safe('../secret.env') AS traversal,
         app.observable_source_path_is_safe('node_modules/pkg/index.js') AS generated,
         app.observable_source_path_is_safe('credentials.json') AS credential,
         app.observable_source_media_is_supported('src/index.md', 'text/javascript') AS wrong_media,
         app.observable_output_path_is_safe('_observablehq/client.js') AS missing_dist,
         app.observable_output_path_is_safe('dist/_observablehq/client.1234abcd.js') AS framework_output,
         app.observable_output_path_is_safe('dist/_npm/@observablehq/plot@0.6.17/_esm.js') AS scoped_npm_output,
         app.observable_output_path_is_safe('dist/.observablehq/cache.js') AS hidden_output`
    );
    assert.equal(checks.rows[0].safe, true);
    assert.equal(checks.rows[0].traversal, false);
    assert.equal(checks.rows[0].generated, false);
    assert.equal(checks.rows[0].credential, false);
    assert.equal(checks.rows[0].wrong_media, false);
    assert.equal(checks.rows[0].missing_dist, false);
    assert.equal(checks.rows[0].framework_output, true);
    assert.equal(checks.rows[0].scoped_npm_output, true);
    assert.equal(checks.rows[0].hidden_output, false);
  });

  it("commits a sorted immutable revision from exact upload object facts", async () => {
    const row = await tenant(ID.organization, ID.user, async () => {
      for (const [uploadId, path, contentType, size, checksum] of [
        [ID.markdownUpload, "src/index.md", "text/markdown", 12, "a".repeat(64)],
        [ID.lockUpload, "package-lock.json", "application/json", 18, "b".repeat(64)]
      ]) {
        await db.query(
          `INSERT INTO app.observable_source_file_upload_intents
             (id, organization_id, project_id, source_project_id, relative_path,
              expected_content_type, expected_size_bytes, expected_sha256,
              bucket, object_key, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   'source.opengeo.tools', $9, $10,
                   clock_timestamp() + interval '15 minutes')`,
          [
            uploadId, ID.organization, ID.project, ID.sourceProject, path,
            contentType, size, checksum, sourceKey(uploadId, path), ID.user
          ]
        );
      }
      for (const [objectId, uploadId, path, contentType, size, checksum, version, etag] of [
        [ID.markdownObject, ID.markdownUpload, "src/index.md", "text/markdown", 12, "a".repeat(64), "markdown-v1", "markdown-etag"],
        [ID.lockObject, ID.lockUpload, "package-lock.json", "application/json", 18, "b".repeat(64), "lock-v1", "lock-etag"]
      ]) {
        await db.query(
          `INSERT INTO app.observable_source_objects
             (id, organization_id, project_id, source_project_id, upload_intent_id,
              relative_path, bucket, object_key, s3_version_id, etag,
              content_type, size_bytes, checksum_sha256, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'source.opengeo.tools', $7,
                   $8, $9, $10, $11, $12, $13)`,
          [
            objectId, ID.organization, ID.project, ID.sourceProject, uploadId,
            path, sourceKey(uploadId, path), version, etag, contentType, size,
            checksum, ID.user
          ]
        );
      }
      await db.query(
        `INSERT INTO app.observable_source_revisions
           (id, organization_id, project_id, source_project_id, revision_number,
            parent_revision_id, title, rights_status, entry_path, lockfile_path,
            manifest, manifest_checksum_sha256, change_summary, created_by)
         VALUES ($1, $2, $3, $4, 1, NULL, 'Field report source', 'unreviewed',
                 'src/index.md', 'package-lock.json', $5::jsonb, $6,
                 'Import the exact reviewed source tree', $7)`,
        [
          ID.revision, ID.organization, ID.project, ID.sourceProject,
          JSON.stringify(manifest()), "f".repeat(64), ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.observable_source_revision_files
           (organization_id, project_id, source_project_id, source_revision_id,
            relative_path, source_object_id, position, created_by)
         VALUES
           ($1, $2, $3, $4, 'package-lock.json', $5, 0, $7),
           ($1, $2, $3, $4, 'src/index.md', $6, 1, $7)`,
        [
          ID.organization, ID.project, ID.sourceProject, ID.revision,
          ID.lockObject, ID.markdownObject, ID.user
        ]
      );
      await db.query(
        `UPDATE app.observable_source_projects
         SET current_revision_id = $1, current_revision_number = 1,
             title = 'Field report source', rights_status = 'unreviewed',
             updated_by = $2
         WHERE organization_id = $3 AND id = $4`,
        [ID.revision, ID.user, ID.organization, ID.sourceProject]
      );
      await db.query(
        `UPDATE app.observable_source_file_upload_intents intent
         SET state = 'committed',
             completed_object_id = object.id,
             completed_at = clock_timestamp()
         FROM app.observable_source_objects object
         WHERE intent.organization_id = object.organization_id
           AND intent.id = object.upload_intent_id
           AND intent.organization_id = $1
           AND intent.source_project_id = $2`,
        [ID.organization, ID.sourceProject]
      );
      return db.query(
        `SELECT project.current_revision_number, revision.manifest,
                revision.manifest_checksum_sha256,
                array_agg(file.relative_path ORDER BY file.position) AS paths,
                sum(object.size_bytes)::bigint AS size_bytes
         FROM app.observable_source_projects project
         JOIN app.observable_source_revisions revision
           ON revision.organization_id = project.organization_id
          AND revision.id = project.current_revision_id
         JOIN app.observable_source_revision_files file
           ON file.organization_id = revision.organization_id
          AND file.source_revision_id = revision.id
         JOIN app.observable_source_objects object
           ON object.organization_id = file.organization_id
          AND object.id = file.source_object_id
         WHERE project.organization_id = $1 AND project.id = $2
         GROUP BY project.current_revision_number, revision.manifest,
                  revision.manifest_checksum_sha256`,
        [ID.organization, ID.sourceProject]
      );
    });
    manifestChecksum = row.rows[0].manifest_checksum_sha256;
    assert.equal(row.rows[0].current_revision_number, 1);
    assert.deepEqual(row.rows[0].paths, ["package-lock.json", "src/index.md"]);
    assert.equal(row.rows[0].size_bytes, 30);
    assert.equal(row.rows[0].manifest.schemaVersion, "opengeo.observable-source-revision.1.0.0");
    assert.match(manifestChecksum, /^[0-9a-f]{64}$/);
    assert.notEqual(manifestChecksum, "0".repeat(64));
  });

  it("saving stays private in OpenGeo and only an explicit request stages a resumable GitHub export", async () => {
    const token = "aa940000-0000-4000-8000-000000000001";
    await tenant(ID.organization, ID.user, async () => {
      const rows = await db.query("SELECT stage, requested_by FROM app.observable_github_syncs WHERE source_revision_id = $1", [ID.revision]);
      assert.equal(rows.rows.length, 0, "Saving a linked source must not export private draft history to GitHub");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.observable_build_jobs")).rows[0].n, 0);
      assert.equal((await db.query("SELECT app.request_github_source_sync($1) AS pending", [ID.revision])).rows[0].pending, true);
      assert.deepEqual((await db.query("SELECT stage, requested_by FROM app.observable_github_syncs WHERE source_revision_id = $1", [ID.revision])).rows,
        [{stage: "pending", requested_by: ID.user}]);
    });
    const claim = lease => db.query("SELECT app.claim_github_source_sync($1, $2) AS job", [ID.revision, lease]);
    assert.equal((await claim(token)).rows[0].job.status, "claimed");
    assert.equal((await claim(ID.coordinator)).rows[0].job.status, "busy");
    assert.equal((await db.query("SELECT app.finish_github_source_sync($1, $2, 'github_retry') AS done", [ID.revision, token])).rows[0].done, false, "No exact receipt means no completed sync");
    assert.equal((await claim(token)).rows[0].job.source_revision_id, ID.revision);
    await db.query("SELECT app.finish_github_source_sync($1, $2)", [ID.revision, token]);
    await assert.rejects(tenant(ID.otherOrganization, ID.otherUser, () => db.query("SELECT app.request_github_source_sync($1)", [ID.revision])), /project management/);
    assert.equal((await tenant(ID.otherOrganization, ID.otherUser, () => db.query("SELECT * FROM app.observable_github_syncs"))).rows.length, 0);
  });

  it("seals a new revision referencing existing immutable source objects without copies", async () => {
    const revisionId = "e0000000-0000-4000-8000-000000000499";
    const next = {...manifest(), revisionId, revisionNumber: 2};
    // Roll back the test revision so subsequent build fixtures retain revision 1.
    const rollback = new Error("rollback reuse fixture");
    await assert.rejects(tenant(ID.organization, ID.user, async () => {
      await db.query(`INSERT INTO app.observable_source_revisions
        (id, organization_id, project_id, source_project_id, revision_number,
         parent_revision_id, title, rights_status, entry_path, lockfile_path,
         manifest, manifest_checksum_sha256, change_summary, created_by)
        VALUES ($1, $2, $3, $4, 2, $5, 'Retained source', 'unreviewed',
          'src/index.md', 'package-lock.json', $6::jsonb, $7, 'Metadata edit', $8)`,
      [revisionId, ID.organization, ID.project, ID.sourceProject, ID.revision,
        JSON.stringify(next), "0".repeat(64), ID.user]);
      await db.query(`INSERT INTO app.observable_source_revision_files
        (organization_id, project_id, source_project_id, source_revision_id,
         relative_path, source_object_id, position, created_by)
        VALUES ($1, $2, $3, $4, 'package-lock.json', $5, 0, $7),
               ($1, $2, $3, $4, 'src/index.md', $6, 1, $7)`,
      [ID.organization, ID.project, ID.sourceProject, revisionId,
        ID.lockObject, ID.markdownObject, ID.user]);
      await db.query(`UPDATE app.observable_source_projects
        SET current_revision_id = $1, current_revision_number = 2,
            title = 'Retained source', rights_status = 'unreviewed', updated_by = $2
        WHERE organization_id = $3 AND id = $4`,
      [revisionId, ID.user, ID.organization, ID.sourceProject]);
      const result = await db.query(`SELECT manifest FROM app.observable_source_revisions WHERE id = $1`, [revisionId]);
      assert.deepEqual(result.rows[0].manifest.files, manifest().files);
      const count = await db.query(`SELECT count(*)::int AS count FROM app.observable_source_objects
        WHERE organization_id = $1 AND source_project_id = $2`, [ID.organization, ID.sourceProject]);
      assert.equal(count.rows[0].count, 2, "Reuse creates no additional storage object rows");
      throw rollback;
    }), error => error === rollback);
  });

  it("binds exact archives in an immutable v2 revision without weakening v1 or silently building incomplete data", async () => {
    await db.exec("BEGIN; RESET ROLE");
    try {
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization, ID.user]);
      const archive = (await db.query("SELECT * FROM app.observable_data_attachments WHERE source_project_id = $1", [ID.sourceProject])).rows[0];
      await db.query(`INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
        VALUES ($1, $2, $3, $4)`, [ID.organization, ID.project, archive.dataset_id, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const pin = {path: "src/data/water.geojson", attachmentId: archive.id, datasetId: archive.dataset_id,
        datasetVersionId: archive.dataset_version_id, dataObjectId: archive.data_object_id,
        s3VersionId: archive.s3_version_id, checksumSha256: archive.checksum_sha256,
        sizeBytes: Number(archive.size_bytes), contentType: archive.content_type};
      const revisionId = "e0000000-0000-4000-8000-000000000487";
      const version2 = {...manifest(), schemaVersion: "opengeo.observable-source-revision.2.0.0",
        revisionId, revisionNumber: 2, dataAttachments: [pin]};
      const validate = value => db.query("SELECT app.validate_observable_revision_data_bindings($1, $2, $3, $4::jsonb) AS pins",
        [ID.organization, ID.project, ID.sourceProject, JSON.stringify(value)]);
      const reject = async (operation, pattern) => {
        await db.exec("SAVEPOINT rejected_binding");
        await assert.rejects(operation(), pattern);
        await db.exec("ROLLBACK TO SAVEPOINT rejected_binding");
      };
      assert.deepEqual((await validate(version2)).rows[0].pins, [pin]);
      for (const changed of [{checksumSha256: "c".repeat(64)}, {s3VersionId: "latest"}, {sizeBytes: 1},
        {datasetId: ID.project}, {dataObjectId: ID.markdownObject}, {bucket: "caller-asserted"}]) {
        await reject(() => validate({...version2, dataAttachments: [{...pin, ...changed}]}), /exact registered facts/);
      }
      await reject(() => validate({...version2, dataAttachments: [{...pin, attachmentId: ID.otherOrganization}]}), /unavailable/);
      for (const path of ["../water.geojson", "src/data/run.js", "package.json", "src/data/page.html"]) {
        await reject(() => validate({...version2, dataAttachments: [{...pin, path}]}), /unsafe/);
      }
      await reject(() => validate({...version2, files: [...version2.files, {path: "SRC/DATA/WATER.GEOJSON"}]}), /collide/);
      await reject(() => validate({...version2, files: [...version2.files, {path: "src/data/water.geojson-extra"}, {path: "src/data/water.geojson/child.csv"}]}), /collide/);
      await reject(() => validate({...version2, dataAttachments: [pin, pin]}), /unsorted/);
      await reject(() => validate({...version2, dataAttachments: Array.from({length: 4}, (_, index) => ({...pin, path: `src/data/${index}.geojson`}))}), /64 MiB/);
      await db.query("SELECT set_config('app.user_id', $1, true)", [ID.otherUser]);
      await reject(() => validate(version2), /manage access/);
      await db.query("SELECT set_config('app.user_id', $1, true)", [ID.user]);

      await db.query(`INSERT INTO app.observable_source_revisions
        (id, organization_id, project_id, source_project_id, revision_number, parent_revision_id,
         title, rights_status, entry_path, lockfile_path, manifest, manifest_checksum_sha256, change_summary, created_by)
        VALUES ($1, $2, $3, $4, 2, $5, 'Field report source', 'unreviewed', 'src/index.md',
          'package-lock.json', $6::jsonb, $7, 'Bind archived water data', $8)`,
        [revisionId, ID.organization, ID.project, ID.sourceProject, ID.revision, JSON.stringify(version2), "0".repeat(64), ID.user]);
      await db.query(`INSERT INTO app.observable_source_revision_files
        (organization_id, project_id, source_project_id, source_revision_id, relative_path, source_object_id, position, created_by)
        SELECT organization_id, project_id, source_project_id, $1, relative_path, source_object_id, position, created_by
        FROM app.observable_source_revision_files WHERE source_revision_id = $2`, [revisionId, ID.revision]);
      await db.query(`UPDATE app.observable_source_projects SET current_revision_id = $1,
        current_revision_number = 2, updated_by = $2 WHERE id = $3`, [revisionId, ID.user, ID.sourceProject]);
      const saved = (await db.query("SELECT manifest, manifest_checksum_sha256 FROM app.observable_source_revisions WHERE id = $1", [revisionId])).rows[0];
      assert.deepEqual(saved.manifest, version2);
      assert.notEqual(saved.manifest_checksum_sha256, manifestChecksum);
      await reject(() => db.query("UPDATE app.observable_source_revisions SET manifest = $1 WHERE id = $2", [JSON.stringify(manifest()), revisionId]), /immutable|permission denied/);
      const dataJob = "f0000000-0000-4000-8000-000000000488";
      const outputPrefix = `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${dataJob}/output/`;
      const request = {...buildRequest(), sourceRevisionId: revisionId, sourceRevisionNumber: 2,
        sourceManifestChecksumSha256: saved.manifest_checksum_sha256};
      const insertBuild = purpose => db.query(`INSERT INTO app.observable_build_jobs
        (id, organization_id, project_id, source_project_id, source_revision_id, source_revision_number,
         purpose, request, request_checksum_sha256, output_prefix, created_by)
        VALUES ($1, $2, $3, $4, $5, 2, $6, $7::jsonb, $8, $9, $10)`,
        [dataJob, ID.organization, ID.project, ID.sourceProject, revisionId, purpose,
          JSON.stringify({...request, purpose}), "b".repeat(64), outputPrefix, ID.user]);
      await reject(() => insertBuild("release_candidate"), /publication rights/);
      await insertBuild("preview");
      await reject(() => db.query("SELECT app.resolve_observable_build_data($1, $2)", [dataJob, ID.coordinator]), /permission denied/);
      await db.exec("SET LOCAL ROLE opengeo_observable_coordinator");
      await db.query("SELECT * FROM app.claim_observable_build_runtime($1, $2, 900)", [dataJob, ID.coordinator]);
      const resolve = token => db.query("SELECT app.resolve_observable_build_data($1, $2) AS files", [dataJob, token]);
      assert.deepEqual((await resolve(ID.coordinator)).rows[0].files, [{...pin,
        bucket: "storage.opengeo.tools", objectKey: "archive/water.geojson", etag: "archive-etag"}]);
      await reject(() => resolve(ID.coordinator2), /live build lease/);
      await db.exec("RESET ROLE");
      // The resolver must use the job's actor, not caller-supplied tenant
      // settings or a permission snapshot captured when the job was queued.
      await db.exec("SAVEPOINT revoked_actor");
      await db.query("UPDATE app.organization_memberships SET role = 'guest' WHERE organization_id = $1 AND user_id = $2", [ID.organization, ID.user]);
      await db.query("DELETE FROM app.project_memberships WHERE project_id = $1 AND user_id = $2", [ID.project, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_observable_coordinator");
      await reject(() => resolve(ID.coordinator), /manage access/);
      await reject(() => db.query("SELECT app.complete_observable_build($1, $2, '{}'::jsonb)", [dataJob, ID.coordinator]), /manage access/);
      await db.exec("ROLLBACK TO SAVEPOINT revoked_actor; RESET ROLE");
      await db.query("DELETE FROM app.project_datasets WHERE project_id = $1 AND dataset_id = $2", [ID.project, archive.dataset_id]);
      await db.exec("SET LOCAL ROLE opengeo_observable_coordinator");
      await reject(() => resolve(ID.coordinator), /unavailable/);
      await reject(() => db.query("SELECT app.complete_observable_build($1, $2, '{}'::jsonb)", [dataJob, ID.coordinator]), /unavailable/);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await reject(() => validate(version2), /unavailable/);
      assert.deepEqual((await db.query("SELECT manifest FROM app.observable_source_revisions WHERE id = $1", [revisionId])).rows[0].manifest, version2);
      await db.exec("RESET ROLE");
      await db.query(`INSERT INTO app.project_datasets (organization_id, project_id, dataset_id, linked_by)
        VALUES ($1, $2, $3, $4)`, [ID.organization, ID.project, archive.dataset_id, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_observable_coordinator");
      const result = {schemaVersion: "opengeo.observable-build-result.1.0.0", buildJobId: dataJob,
        requestChecksumSha256: "b".repeat(64), compilerImageDigest: request.compilerImageDigest,
        inputManifestChecksumSha256: saved.manifest_checksum_sha256, outputPrefix,
        outputTreeChecksumSha256: "c".repeat(64), sandbox: {credentialMode: "none", networkPolicy: "deny_all",
          readOnlyInputs: true, readOnlyBaseImage: true, unprivilegedUser: true, dockerSocket: false},
        networkRequests: [], validationReport: {scope: "metadata-only migration fixture"},
        routeManifest: [{path: "/", file: "dist/index.html"}],
        outputManifest: {files: [{path: "dist/water.geojson", bucket: "source.opengeo.tools",
          objectKey: outputPrefix + "water.geojson", s3VersionId: "output-v1", etag: "output-etag",
          contentType: "application/geo+json", sizeBytes: 18930972, checksumSha256: "a".repeat(64)},
          {path: "dist/index.html", bucket: "source.opengeo.tools", objectKey: outputPrefix + "index.html",
            s3VersionId: "html-v1", etag: "html-etag", contentType: "text/html", sizeBytes: 64, checksumSha256: "d".repeat(64)}]}};
      const tooLarge = structuredClone(result);
      tooLarge.outputManifest.files[0].sizeBytes = 33554433;
      await reject(() => db.query("SELECT app.complete_observable_build($1, $2, $3::jsonb)",
        [dataJob, ID.coordinator, JSON.stringify(tooLarge)]), /invalid Observable build output file/);
      assert.equal((await db.query("SELECT app.complete_observable_build($1, $2, $3::jsonb) AS completed",
        [dataJob, ID.coordinator, JSON.stringify(result)])).rows[0].completed, true);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const capability = "f2000000-0000-4000-8000-000000000488";
      const issue = () => db.query(`INSERT INTO app.observable_preview_capabilities
        (id, organization_id, project_id, build_job_id, requested_by, token_checksum_sha256, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '60 seconds')`,
        [capability, ID.organization, ID.project, dataJob, ID.user, "e".repeat(64)]);
      const exchange = () => db.query("SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)",
        [capability, ID.organization, ID.user, "e".repeat(64)]);
      await issue();
      await db.exec("SAVEPOINT withdrawn_preview; RESET ROLE");
      await db.query("DELETE FROM app.project_datasets WHERE project_id = $1 AND dataset_id = $2", [ID.project, archive.dataset_id]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await reject(exchange, /unavailable/);
      await reject(issue, /unavailable/);
      await db.exec("ROLLBACK TO SAVEPOINT withdrawn_preview");
      assert.equal((await exchange()).rows.length, 1);
      assert.equal((await exchange()).rows.length, 0, "Preview capability remains single-use");
    } finally {
      await db.exec("ROLLBACK; SET ROLE opengeo_runtime");
    }
  });

  it("seals a pending build request but blocks an unreviewed release candidate", async () => {
    const request = buildRequest();
    const outputPrefix = `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${ID.build}/output/`;
    const row = await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.observable_build_jobs
           (id, organization_id, project_id, source_project_id,
            source_revision_id, source_revision_number, purpose, request,
            request_checksum_sha256, output_prefix, created_by)
         VALUES ($1, $2, $3, $4, $5, 1, 'preview', $6::jsonb, $7, $8, $9)`,
        [
          ID.build, ID.organization, ID.project, ID.sourceProject, ID.revision,
          JSON.stringify(request), "d".repeat(64), outputPrefix, ID.user
        ]
      );
      return db.query(
        `SELECT state::text, request_checksum_sha256, request, output_prefix
         FROM app.observable_build_jobs WHERE id = $1`,
        [ID.build]
      );
    });
    requestChecksum = row.rows[0].request_checksum_sha256;
    assert.equal(row.rows[0].state, "pending");
    assert.equal(row.rows[0].request.networkPolicy, "deny_all");
    assert.match(requestChecksum, /^[0-9a-f]{64}$/);
    assert.notEqual(requestChecksum, "0".repeat(64));
    assert.equal(row.rows[0].output_prefix, outputPrefix);
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `INSERT INTO app.observable_build_jobs
           (organization_id, project_id, source_project_id, source_revision_id,
            source_revision_number, purpose, request, request_checksum_sha256,
            output_prefix, created_by)
         VALUES ($1, $2, $3, $4, 1, 'release_candidate', $5::jsonb, $6,
                 'invalid', $7)`,
        [
          ID.organization, ID.project, ID.sourceProject, ID.revision,
          JSON.stringify({...request, purpose: "release_candidate"}),
          "0".repeat(64), ID.user
        ]
      )),
      /does not seal an eligible exact source revision/
    );
  });

  it("records reviewed compiler transitions without changing source revisions or historical builds", async () => {
    await db.exec("RESET ROLE; BEGIN");
    const original = `sha256:${"c".repeat(64)}`, upgraded = `sha256:${"a".repeat(64)}`;
    const transition = (previous = original, next = upgraded, project = ID.project) => db.query(
      "SELECT app.record_observable_compiler_transition($1,$2,$3,$4,$5,$6) AS sequence",
      [ID.organization, project, ID.sourceProject, previous, next, "review/exact-image-test"]);
    const reject = async (operation, pattern) => {
      await db.exec("SAVEPOINT rejected_transition");
      await assert.rejects(operation, pattern);
      await db.exec("ROLLBACK TO SAVEPOINT rejected_transition");
    };
    try {
      await db.query("SELECT set_config('app.organization_id',$1,true), set_config('app.user_id',$2,true)", [ID.organization, ID.user]);
      const snapshot = async () => (await db.query(`SELECT
        (SELECT to_jsonb(s) FROM app.observable_source_projects s WHERE id=$1) AS source,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM app.observable_source_revisions r WHERE source_project_id=$1) AS revisions,
        (SELECT to_jsonb(b) FROM app.observable_build_jobs b WHERE id=$2) AS historical`, [ID.sourceProject, ID.build])).rows;
      const before = await snapshot();
      assert.equal(Number((await transition()).rows[0].sequence), 1);
      await reject(() => transition(), /baseline changed/);
      await reject(() => transition(upgraded, original, randomUUID()), /source not found/);
      await reject(() => transition(upgraded, "not-an-exact-digest"), /check constraint/);
      await reject(() => db.query("DELETE FROM app.observable_compiler_transitions"), /append-only/);
      await reject(() => db.query("UPDATE app.observable_compiler_transitions SET approval_reference='replacement'"), /append-only/);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await reject(() => transition(upgraded, original), /permission denied/);
      await reject(() => db.query("INSERT INTO app.observable_compiler_transitions DEFAULT VALUES"), /permission denied/);
      assert.equal((await db.query("SELECT app.observable_effective_compiler_digest($1,$2) AS digest", [ID.organization, ID.sourceProject])).rows[0].digest, upgraded);
      assert.equal((await db.query(`SELECT app.observable_effective_compiler_digest(source.organization_id,source.id) AS digest
        FROM app.observable_source_projects source WHERE source.organization_id=$1 AND source.id=$2 FOR SHARE OF source`,
      [ID.organization, ID.sourceProject])).rows[0].digest, upgraded);
      const insert = digest => {
        const id = randomUUID();
        return db.query(`INSERT INTO app.observable_build_jobs
          (id,organization_id,project_id,source_project_id,source_revision_id,source_revision_number,purpose,request,request_checksum_sha256,output_prefix,created_by)
          VALUES ($1,$2,$3,$4,$5,1,'preview',$6::jsonb,$7,$8,$9) RETURNING id,request`,
          [id, ID.organization, ID.project, ID.sourceProject, ID.revision,
            JSON.stringify({...buildRequest(), compilerImageDigest:digest}), "d".repeat(64),
            `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${id}/output/`, ID.user]);
      };
      await reject(() => insert(original), /does not seal an eligible exact source revision/);
      const candidate = (await insert(upgraded)).rows[0];
      assert.equal(candidate.request.compilerImageDigest, upgraded);
      await db.exec("SAVEPOINT old_pinned_job; RESET ROLE; SET LOCAL ROLE opengeo_observable_coordinator");
      const claimed = (await db.query("SELECT * FROM app.claim_observable_build_runtime($1,$2,900)", [ID.build, randomUUID()])).rows[0];
      assert.equal(claimed.claim_status, "claimed");
      assert.equal(claimed.request.compilerImageDigest, original);
      await db.exec("ROLLBACK TO SAVEPOINT old_pinned_job; RESET ROLE; SET LOCAL ROLE opengeo_runtime");
      await db.query("SELECT set_config('app.organization_id',$1,true)", [ID.otherOrganization]);
      assert.equal((await db.query("SELECT * FROM app.observable_compiler_transitions")).rows.length, 0);
      assert.equal((await db.query("SELECT app.observable_effective_compiler_digest($1,$2) AS digest", [ID.organization, ID.sourceProject])).rows[0].digest, null);
      await db.exec("RESET ROLE");
      await db.query("SELECT set_config('app.organization_id',$1,true)", [ID.organization]);
      assert.equal(Number((await transition(upgraded, original)).rows[0].sequence), 2);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await db.query("SELECT request FROM app.observable_build_jobs WHERE id=$1", [candidate.id])).rows[0].request.compilerImageDigest, upgraded);
    } finally {await db.exec("ROLLBACK; SET ROLE opengeo_runtime");}
  });

  it("claims an unlinked private OpenGeo source without GitHub commits and fails closed on account grants or revoked authority", async () => {
    await db.exec("RESET ROLE; BEGIN");
    const source = randomUUID(), revision = randomUUID(), build = randomUUID(), site = randomUUID(), siteVersion = randomUUID();
    const token = randomUUID(), foreignConnection = randomUUID(), ambiguousConnection = randomUUID();
    const claim = async () => (await db.query("SELECT app.claim_github_build_dispatch($1,$2) AS value", [build, token])).rows[0].value;
    const advance = async () => (await db.query("SELECT app.advance_github_build_dispatch($1,$2,'dispatching') AS value", [build, token])).rows[0].value;
    try {
      await db.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [ID.organization, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await db.query(`INSERT INTO app.project_sites
        (id,organization_id,project_id,slug,current_version_id,current_version_number,state,created_by,updated_by)
        VALUES($1,$2,$3,'opengeo-only',$4,1,'draft',$5,$5)`, [site, ID.organization, ID.project, siteVersion, ID.user]);
      await db.query(`INSERT INTO app.project_site_versions
        (id,organization_id,project_id,site_id,version_number,title,theme,created_by)
        VALUES($1,$2,$3,$4,1,'OpenGeo only','paper',$5)`, [siteVersion, ID.organization, ID.project, site, ID.user]);
      await db.query(`INSERT INTO app.observable_source_projects
        (id,organization_id,project_id,site_id,route_namespace,title,rights_status,owner_user_id,
         compiler_image_digest,resource_limits,created_by,updated_by)
        VALUES($1,$2,$3,$4,'opengeo-only','Private OpenGeo draft','unreviewed',$5,$6,$7::jsonb,$5,$5)`,
      [source, ID.organization, ID.project, site, ID.user, `sha256:${"c".repeat(64)}`, JSON.stringify(limits)]);
      const files = [];
      for (const original of manifest().files) {
        const uploadId = randomUUID(), objectId = randomUUID();
        const key = sourceKey(uploadId, original.path).replace(ID.sourceProject, source);
        await db.query(`INSERT INTO app.observable_source_file_upload_intents
          (id,organization_id,project_id,source_project_id,relative_path,expected_content_type,
           expected_size_bytes,expected_sha256,bucket,object_key,created_by,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '15 minutes')`,
        [uploadId, ID.organization, ID.project, source, original.path, original.contentType,
          original.sizeBytes, original.checksumSha256, original.bucket, key, ID.user]);
        await db.query(`INSERT INTO app.observable_source_objects
          (id,organization_id,project_id,source_project_id,upload_intent_id,relative_path,bucket,
           object_key,s3_version_id,etag,content_type,size_bytes,checksum_sha256,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [objectId, ID.organization, ID.project, source, uploadId, original.path, original.bucket,
          key, original.s3VersionId, original.etag, original.contentType, original.sizeBytes, original.checksumSha256, ID.user]);
        files.push({...original, objectId, objectKey: key});
      }
      const exactManifest = {...manifest(), sourceProjectId: source, revisionId: revision, files};
      await db.query(`INSERT INTO app.observable_source_revisions
        (id,organization_id,project_id,source_project_id,revision_number,title,rights_status,entry_path,
         lockfile_path,manifest,manifest_checksum_sha256,change_summary,created_by)
        VALUES($1,$2,$3,$4,1,'Private OpenGeo draft','unreviewed','src/index.md','package-lock.json',$5::jsonb,$6,'Save draft',$7)`,
      [revision, ID.organization, ID.project, source, JSON.stringify(exactManifest), "f".repeat(64), ID.user]);
      for (const [position, file] of files.entries()) await db.query(`INSERT INTO app.observable_source_revision_files
        (organization_id,project_id,source_project_id,source_revision_id,relative_path,source_object_id,position,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [ID.organization, ID.project, source, revision, file.path, file.objectId, position, ID.user]);
      await db.query(`UPDATE app.observable_source_projects SET current_revision_id=$1,current_revision_number=1,updated_by=$2 WHERE id=$3`, [revision, ID.user, source]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.observable_github_syncs WHERE source_revision_id=$1", [revision])).rows[0].n, 0, "Saving unlinked drafts creates no GitHub export");
      // Connect remains deliberate but no longer exports source automatically.
      await db.exec("SAVEPOINT connect_without_export");
      await db.query(`INSERT INTO app.observable_github_links(organization_id,project_id,source_project_id,connection_id,created_by)
        SELECT $1,$2,$3,id,$4 FROM app.github_publication_connections WHERE organization_id=$1`, [ID.organization, ID.project, source, ID.user]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.observable_github_syncs WHERE source_revision_id=$1", [revision])).rows[0].n, 0, "Connecting a saved draft must not create a GitHub export");
      await db.exec("ROLLBACK TO SAVEPOINT connect_without_export");
      const sourceChecksum = (await db.query("SELECT manifest_checksum_sha256 FROM app.observable_source_revisions WHERE id=$1", [revision])).rows[0].manifest_checksum_sha256;
      const request = {...buildRequest(), sourceProjectId: source, sourceRevisionId: revision, sourceManifestChecksumSha256: sourceChecksum};
      await db.query(`INSERT INTO app.observable_build_jobs
        (id,organization_id,project_id,source_project_id,source_revision_id,source_revision_number,purpose,
         request,request_checksum_sha256,output_prefix,created_by)
        VALUES($1,$2,$3,$4,$5,1,'preview',$6::jsonb,$7,$8,$9)`,
      [build, ID.organization, ID.project, source, revision, JSON.stringify(request), "d".repeat(64),
        `organizations/${ID.organization}/projects/${ID.project}/source-projects/${source}/builds/${build}/output/`, ID.user]);
      await db.exec("RESET ROLE");
      const snapshot = async () => (await db.query(`SELECT
        (SELECT to_jsonb(s) FROM app.observable_source_projects s WHERE id=$1) AS source,
        (SELECT to_jsonb(r) FROM app.observable_source_revisions r WHERE id=$2) AS revision,
        (SELECT jsonb_agg(to_jsonb(f) ORDER BY relative_path) FROM app.observable_source_revision_files f WHERE source_project_id=$1) AS files,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY relative_path) FROM app.observable_source_objects o WHERE source_project_id=$1) AS objects,
        (SELECT to_jsonb(j) FROM app.observable_build_jobs j WHERE id=$3) AS job,
        (SELECT count(*)::int FROM app.observable_github_links) AS links,
        (SELECT count(*)::int FROM app.observable_github_revision_receipts) AS receipts,
        (SELECT count(*)::int FROM app.observable_github_syncs WHERE source_revision_id=$2) AS exports`, [source, revision, build])).rows[0];
      const before = await snapshot();
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.observable_github_links WHERE source_project_id=$1", [source])).rows[0].n, 0);
      const unavailable = async () => {
        assert.equal((await claim()).status, "unavailable");
        assert.equal((await db.query("SELECT count(*)::int AS n FROM app.observable_github_dispatches WHERE build_job_id=$1", [build])).rows[0].n, 0, "Denied configuration cannot create a dispatch");
      };
      await db.exec("SELECT set_config('app.organization_id','',true),set_config('app.user_id','',true)");
      await unavailable(); // No enabled connection with a reviewed runtime yet.
      await db.query(`INSERT INTO app.github_publication_connections
        (id,organization_id,installation_id,repository_id,repository,enabled,verified_at,verified_by,build_workflow_id,runtime_sha)
        VALUES($1,$2,8,456,'other/compiler',true,now(),$3,42,$4)`, [foreignConnection, ID.otherOrganization, ID.otherUser, "a".repeat(40)]);
      await unavailable(); // Another account's grant cannot authorize this source.
      await db.query("UPDATE app.github_publication_connections SET build_workflow_id=42,runtime_sha=$1,enabled=false WHERE organization_id=$2", ["a".repeat(40), ID.organization]);
      await unavailable();
      await db.query("UPDATE app.github_publication_connections SET enabled=true WHERE organization_id=$1", [ID.organization]);
      await db.exec("SAVEPOINT ambiguous_build_grant");
      await db.query(`INSERT INTO app.github_publication_connections
        (id,organization_id,installation_id,repository_id,repository,enabled,verified_at,verified_by,build_workflow_id,runtime_sha)
        VALUES($1,$2,9,789,'owner/second-compiler',true,now(),$3,42,$4)`, [ambiguousConnection, ID.organization, ID.user, "a".repeat(40)]);
      await unavailable();
      await db.exec("ROLLBACK TO SAVEPOINT ambiguous_build_grant; SET LOCAL ROLE opengeo_runtime");
      const claimed = await claim();
      assert.equal(claimed.status, "claimed"); assert.equal(claimed.stage, "ready");
      assert.equal(claimed.source_mode, "opengeo"); assert.equal(claimed.source_commit, null);
      assert.equal(claimed.organization_id, ID.organization); assert.equal(claimed.source_project_id, source);
      assert.equal(claimed.source_revision_id, revision);
      await db.exec("RESET ROLE");
      await db.query("UPDATE app.github_publication_connections SET enabled=false WHERE organization_id=$1", [ID.organization]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal((await claim()).status, "unavailable"); assert.equal(await advance(), false);
      await db.exec("RESET ROLE");
      await db.query("UPDATE app.github_publication_connections SET enabled=true WHERE organization_id=$1", [ID.organization]);
      await db.query("UPDATE app.organization_memberships SET role='guest' WHERE organization_id=$1 AND user_id=$2", [ID.organization, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal((await claim()).status, "unavailable"); assert.equal(await advance(), false, "Revoked author edit authority cannot dispatch an existing lease");
      await db.exec("RESET ROLE");
      await db.query("UPDATE app.organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [ID.organization, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal(await advance(), true, "A valid S3 build advances without a GitHub revision receipt");
      await db.exec("RESET ROLE");
      assert.deepEqual(await snapshot(), before, "Claims and dispatch do not rewrite private source files, build requests or source-export history");
      assert.deepEqual((await db.query("SELECT source_mode,source_commit,stage FROM app.observable_github_dispatches WHERE build_job_id=$1", [build])).rows,
        [{source_mode: "opengeo", source_commit: null, stage: "dispatching"}]);
    } finally {await db.exec("ROLLBACK; SET ROLE opengeo_runtime");}
  });

  it("background claims authorize a guest project owner without browser context and honor revocation", async () => {
    await db.exec("RESET ROLE; BEGIN");
    try {
      await db.query("UPDATE app.organization_memberships SET role='guest' WHERE organization_id=$1 AND user_id=$2", [ID.organization, ID.user]);
      await db.query("INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'owner')", [ID.organization, ID.project, ID.user]);
      await db.query("UPDATE app.github_publication_connections SET build_workflow_id=42,runtime_sha=$1", ['a'.repeat(40)]);
      await db.exec("SELECT set_config('app.organization_id','',true), set_config('app.user_id','',true)");
      const role = async (org=ID.organization, user=ID.user) => (await db.query("SELECT app.background_project_role($1,$2,$3)::text AS role", [org,ID.project,user])).rows[0].role;
      assert.equal((await db.query("SELECT app.effective_project_role($1,$2) AS role",[ID.project,ID.user])).rows[0].role,null,'Original helper cannot resolve a background actor');
      assert.equal(await role(),'owner');
      assert.equal(await role(ID.otherOrganization),null);
      assert.equal(await role(ID.organization,ID.otherUser),'viewer','An existing viewer grant is not promoted to edit authority');
      for (const roleName of ['opengeo_runtime','opengeo_worker','opengeo_observable_coordinator','opengeo_framework_publisher'])
        assert.equal((await db.query("SELECT has_function_privilege($1,'app.background_project_role(uuid,uuid,uuid)','EXECUTE') AS allowed",[roleName])).rows[0].allowed,false);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const sync = async () => (await db.query("SELECT app.claim_github_source_sync($1,$2) AS result",[ID.revision,ID.coordinator])).rows[0].result;
      const build = async () => (await db.query("SELECT app.claim_github_build_dispatch($1,$2) AS result",[ID.build,ID.coordinator])).rows[0].result;
      assert.equal((await sync()).status,'claimed');
      assert.equal((await build()).status,'claimed');
      await db.query("SELECT app.finish_github_source_sync($1,$2,'test_release')",[ID.revision,ID.coordinator]);
      await db.query("SELECT app.advance_github_build_dispatch($1,$2,'release')",[ID.build,ID.coordinator]);
      await db.exec("RESET ROLE");
      await db.query("DELETE FROM app.project_memberships WHERE project_id=$1 AND user_id=$2",[ID.project,ID.user]);
      assert.equal(await role(),null);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal((await sync()).status,'failed');
      assert.equal((await build()).status,'unavailable');
      await db.exec("RESET ROLE");
      const team = randomUUID();
      await db.query("INSERT INTO app.teams(id,organization_id,name,created_by) VALUES($1,$2,'Background editors',$3)",[team,ID.organization,ID.user]);
      await db.query("INSERT INTO app.team_memberships(organization_id,team_id,user_id,role,created_by) VALUES($1,$2,$3,'member',$3)",[ID.organization,team,ID.user]);
      await db.query("INSERT INTO app.project_team_grants(organization_id,project_id,team_id,role,created_by) VALUES($1,$2,$3,'editor',$4)",[ID.organization,ID.project,team,ID.user]);
      assert.equal(await role(),'editor','Active team grants remain usable by background workers');
      await db.query("UPDATE app.teams SET status='archived' WHERE id=$1",[team]);
      assert.equal(await role(),null,'Archived teams confer no authority');
      await db.query("UPDATE app.teams SET status='active' WHERE id=$1",[team]);
      await db.query("UPDATE app.organizations SET status='archived' WHERE id=$1",[ID.organization]);
      assert.equal(await role(),null,'Team membership cannot confer access through an archived organization');
    } finally {await db.exec("ROLLBACK; SET ROLE opengeo_runtime");}
  });

  it("GitHub dispatch leases retain the original run and its terminal failure", async () => {
    await db.exec("RESET ROLE; BEGIN");
    try {
      await db.query("UPDATE app.github_publication_connections SET build_workflow_id = 42, runtime_sha = $1", ["a".repeat(40)]);
      // A historical dispatch predates S3-only claims and retains its exact
      // GitHub link/receipt contract throughout lease and run recovery.
      await db.query(`INSERT INTO app.observable_github_dispatches
        (build_job_id, organization_id, project_id, source_project_id, connection_id,
         workflow_id, workflow_sha, source_mode, stage)
        SELECT $1, $2, $3, $4, id, build_workflow_id, runtime_sha, 'github', 'syncing'
        FROM app.github_publication_connections WHERE organization_id = $2`,
        [ID.build, ID.organization, ID.project, ID.sourceProject]);
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization, ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const claim = token => db.query("SELECT app.claim_github_build_dispatch($1, $2) AS value", [ID.build, token]);
      const advance = (stage, extra = []) => db.query(
        "SELECT app.advance_github_build_dispatch($1, $2, $3, $4, $5::bigint, $6::integer, $7, $8, $9) AS value",
        [ID.build, ID.coordinator, stage, ...Array.from({length: 6}, (_, i) => extra[i] ?? null)]);
      const historical = (await claim(ID.coordinator)).rows[0].value;
      assert.equal(historical.stage, "syncing");
      assert.equal(historical.source_mode, "github");
      assert.equal((await claim(ID.coordinator2)).rows[0].value.status, "busy");
      await db.query(`INSERT INTO app.observable_github_revision_receipts
        (organization_id, project_id, source_project_id, source_revision_id, connection_id,
         repository_id, commit_sha, tree_sha, git_ref, manifest_sha256, created_by)
        SELECT $1, $2, $3, $4, id, repository_id, $5, $5, $6, $7, $8
        FROM app.github_publication_connections WHERE organization_id = $1`,
        [ID.organization, ID.project, ID.sourceProject, ID.revision, "b".repeat(40),
          `heads/studio/sources/${ID.sourceProject}/revisions/${ID.revision}`, "c".repeat(64), ID.user]);
      assert.equal((await advance("ready", ["b".repeat(40)])).rows[0].value, true);
      await db.exec("SAVEPOINT guest_dispatch; RESET ROLE");
      await db.query("UPDATE app.organization_memberships SET role='guest' WHERE organization_id=$1 AND user_id=$2",[ID.organization,ID.user]);
      await db.exec("SELECT set_config('app.organization_id','',true),set_config('app.user_id','',true); SET LOCAL ROLE opengeo_runtime");
      assert.equal((await advance('dispatching')).rows[0].value,false,'Guest without project authority cannot dispatch');
      await db.exec("RESET ROLE");
      await db.query("INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",[ID.organization,ID.project,ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      assert.equal((await advance('dispatching')).rows[0].value,true,'Owner can dispatch without browser context');
      await db.exec("ROLLBACK TO SAVEPOINT guest_dispatch");
      assert.equal((await advance("dispatching")).rows[0].value, true);
      assert.equal((await advance("dispatched", [null, 456, 1])).rows[0].value, true);
      await advance("release");
      const recovered = (await claim(ID.coordinator)).rows[0].value;
      assert.equal(recovered.stage, "dispatched");
      assert.equal(recovered.run_id, 456);
      assert.equal((await advance("dispatched", [null, 456, 1, null, "in_progress"])).rows[0].value, true);
      const logs = {state: "retained", text: "Compile failed", truncated: false,
        captured_at: "2026-09-10T00:00:00Z", checksum_sha256: "d".repeat(64)};
      const retain = (run, token, value = logs) => db.query(
        "SELECT app.retain_github_build_logs($1, $2, $3, 1, $4::jsonb) AS value",
        [ID.build, token, run, JSON.stringify(value)]);
      assert.equal((await retain(999, ID.coordinator)).rows[0].value, false);
      assert.equal((await retain(456, ID.coordinator2)).rows[0].value, false);
      await db.exec("SAVEPOINT invalid_logs");
      await assert.rejects(retain(456, ID.coordinator, {...logs, state: undefined}), /Invalid retained GitHub/);
      await db.exec("ROLLBACK TO SAVEPOINT invalid_logs");
      assert.equal((await retain(456, ID.coordinator)).rows[0].value, true);
      assert.equal((await retain(456, ID.coordinator, {...logs, text: "Changed"})).rows[0].value, true);
      assert.deepEqual((await db.query("SELECT retained_logs FROM app.observable_github_dispatches WHERE build_job_id = $1", [ID.build])).rows[0].retained_logs, logs);
      assert.equal((await advance("failed", [null, 456, 1, "github_run_failure", "completed", "failure"])).rows[0].value, true);
      await advance("release");
      assert.equal((await claim(ID.coordinator2)).rows[0].value.status, "failed");
      const record = (await db.query("SELECT run_status, run_conclusion, error_code FROM app.observable_github_dispatches WHERE build_job_id = $1", [ID.build])).rows[0];
      assert.deepEqual(record, {run_status: "completed", run_conclusion: "failure", error_code: "github_run_failure"});
    } finally {
      await db.exec("ROLLBACK; SET ROLE opengeo_runtime");
    }
  });

  it('admits a cache only from a live claimed job and bounded account entitlement', async () => {
    await db.exec('RESET ROLE; BEGIN');
    const token=randomUUID();
    const admit=(job=ID.build, claimToken=token)=>db.query('SELECT app.admit_observable_page_cache($1,$2) AS value',[job,claimToken]);
    const reject=async(operation,pattern)=>{
      await db.exec('SAVEPOINT denied_cache');
      await assert.rejects(operation,pattern);
      await db.exec('ROLLBACK TO SAVEPOINT denied_cache');
    };
    try {
      await db.exec('SET LOCAL ROLE opengeo_observable_coordinator');
      assert.equal((await admit()).rows[0].value,null,'unclaimed job cannot reserve storage');
      assert.equal((await db.query('SELECT claim_status FROM app.claim_observable_build_runtime($1,$2,900)',[ID.build,token])).rows[0].claim_status,'claimed');
      assert.equal((await admit()).rows[0].value,null,'no entitlement means no cache');
      await reject(()=>db.query('INSERT INTO app.observable_cache_entitlements VALUES ($1,true,1)',[ID.organization]),/permission denied/);
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO app.observable_cache_entitlements VALUES ($1,true,1)',[ID.organization]);
      await db.query(`INSERT INTO app.observable_cache_admissions
        (organization_id,project_id,source_project_id,compiler_image_digest) VALUES ($1,$2,$3,$4)`,[ID.organization,ID.project,ID.sourceProject,`sha256:${'d'.repeat(64)}`]);
      await db.exec('SET LOCAL ROLE opengeo_observable_coordinator');
      assert.equal((await admit()).rows[0].value,null,'another compiler already consumes the slot');
      await db.exec('RESET ROLE');
      await db.query('UPDATE app.observable_cache_entitlements SET max_entries=2 WHERE organization_id=$1',[ID.organization]);
      await db.exec('SET LOCAL ROLE opengeo_observable_coordinator');
      assert.equal((await admit(ID.build,randomUUID())).rows[0].value,null,'wrong lease token');
      assert.equal((await admit(randomUUID())).rows[0].value,null,'unknown job');
      const expected={organizationId:ID.organization,projectId:ID.project,sourceProjectId:ID.sourceProject,
        compilerImageDigest:`sha256:${'c'.repeat(64)}`,frameworkVersion:'1.13.4',buildJobId:ID.build,
        sourceRevisionId:ID.revision,maxBytes:33554432,maxAgeSeconds:604800};
      assert.deepEqual((await admit()).rows[0].value,expected);
      assert.deepEqual((await admit()).rows[0].value,expected,'idempotent even at capacity');
      await db.exec('RESET ROLE');
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM app.observable_cache_admissions')).rows[0].n),2);
      await db.query('UPDATE app.observable_cache_entitlements SET enabled=false WHERE organization_id=$1',[ID.organization]);
      await db.exec('SET LOCAL ROLE opengeo_observable_coordinator');
      assert.equal((await admit()).rows[0].value,null,'disabled accounts cannot reuse an admission');
      await db.exec('RESET ROLE; SET LOCAL ROLE opengeo_runtime');
      await reject(()=>admit(),/permission denied for function/);
    } finally { await db.exec('ROLLBACK; SET ROLE opengeo_runtime'); }
  });

  it("seals an expired third runtime lease before a fourth execution", async () => {
    const outputPrefix = `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${ID.retryBuild}/output/`;
    await tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.observable_build_jobs
         (id, organization_id, project_id, source_project_id,
          source_revision_id, source_revision_number, purpose, request,
          request_checksum_sha256, output_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5, 1, 'preview', $6::jsonb, $7, $8, $9)`,
      [
        ID.retryBuild, ID.organization, ID.project, ID.sourceProject, ID.revision,
        JSON.stringify(buildRequest()), "d".repeat(64), outputPrefix, ID.user
      ]
    ));
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_observable_coordinator");
    for (const token of [ID.coordinator, ID.coordinator2]) {
      const claim = await db.query(
        "SELECT claim_status FROM app.claim_observable_build_runtime($1, $2, 60)",
        [ID.retryBuild, token]
      );
      assert.equal(claim.rows[0].claim_status, "claimed");
      const release = await db.query(
        "SELECT app.release_observable_build($1, $2, 's3_unavailable', 3) AS status",
        [ID.retryBuild, token]
      );
      assert.equal(release.rows[0].status, "pending");
    }
    const third = await db.query(
      "SELECT claim_status, attempt_count FROM app.claim_observable_build_runtime($1, $2, 60)",
      [ID.retryBuild, ID.coordinator3]
    );
    assert.deepEqual(third.rows[0], {claim_status: "claimed", attempt_count: 3});
    await db.exec("RESET ROLE");
    await db.query(
      `UPDATE app.observable_build_jobs
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [ID.retryBuild]
    );
    await db.exec("SET ROLE opengeo_observable_coordinator");
    const exhausted = await db.query(
      "SELECT claim_status, attempt_count FROM app.claim_observable_build_runtime($1, $2, 60)",
      [ID.retryBuild, ID.coordinator4]
    );
    assert.deepEqual(exhausted.rows[0], {claim_status: "already_failed", attempt_count: 3});
    await db.exec("RESET ROLE");
    const sealed = await db.query(
      "SELECT state::text, attempt_count, error_code FROM app.observable_build_jobs WHERE id = $1",
      [ID.retryBuild]
    );
    assert.deepEqual(sealed.rows[0], {
      state: "failed", attempt_count: 3, error_code: "build_retry_exhausted"
    });
    await db.exec("SET ROLE opengeo_runtime");
  });

  it("keeps API coordination ungranted and gives only the coordinator the fixed functions", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        "SELECT * FROM app.claim_observable_build_runtime($1, $2, 60)",
        [ID.build, ID.coordinator]
      )),
      /permission denied for function claim_observable_build_runtime/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_observable_coordinator");
    await assert.rejects(
      db.query("SELECT id FROM app.observable_build_jobs WHERE id = $1", [ID.build]),
      /permission denied for (?:table observable_build_jobs|function current_organization_id)/
    );
    const claim = await db.query(
      "SELECT * FROM app.claim_observable_build_runtime($1, $2, 60)",
      [ID.build, ID.coordinator]
    );
    assert.equal(claim.rows[0].claim_status, "claimed");
    assert.equal(claim.rows[0].request_checksum_sha256, requestChecksum);
    assert.equal(claim.rows[0].input_manifest_checksum_sha256, manifestChecksum);
    assert.equal(claim.rows[0].request.networkPolicy, "deny_all");
    const outputPrefix = claim.rows[0].output_prefix;
    const result = {
      schemaVersion: "opengeo.observable-build-result.1.0.0",
      buildJobId: ID.build,
      requestChecksumSha256: requestChecksum,
      compilerImageDigest: `sha256:${"c".repeat(64)}`,
      inputManifestChecksumSha256: manifestChecksum,
      outputPrefix,
      outputTreeChecksumSha256: "d".repeat(64),
      sandbox: {
        credentialMode: "none",
        networkPolicy: "deny_all",
        readOnlyInputs: true,
        readOnlyBaseImage: true,
        unprivilegedUser: true,
        dockerSocket: false
      },
      networkRequests: [],
      validationReport: {status: "valid", scanner: "not-executed-in-this-migration-test"},
      routeManifest: [{path: "/", file: "dist/index.html"}],
      outputManifest: {
        files: [{
          path: "dist/index.html",
          bucket: "source.opengeo.tools",
          objectKey: `${outputPrefix}index.html`,
          s3VersionId: "output-v1",
          etag: "output-etag",
          contentType: "text/html",
          sizeBytes: 128,
          checksumSha256: "e".repeat(64)
        }]
      }
    };
    const completed = await db.query(
      "SELECT app.complete_observable_build($1, $2, $3::jsonb) AS completed",
      [ID.build, ID.coordinator, JSON.stringify(result)]
    );
    assert.equal(completed.rows[0].completed, true);
    await db.exec("RESET ROLE");
    const sealed = await db.query(
      `SELECT state::text, result_checksum_sha256,
              result->'sandbox'->>'credentialMode' AS credential_mode,
              jsonb_array_length(result->'networkRequests') AS network_requests
       FROM app.observable_build_jobs WHERE id = $1`,
      [ID.build]
    );
    assert.equal(sealed.rows[0].state, "succeeded");
    assert.match(sealed.rows[0].result_checksum_sha256, /^[0-9a-f]{64}$/);
    assert.equal(sealed.rows[0].credential_mode, "none");
    assert.equal(sealed.rows[0].network_requests, 0);
    await db.exec("SET ROLE opengeo_observable_coordinator");
    await assert.rejects(
      db.query(
        `SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)`,
        [ID.build, ID.organization, ID.user, "9".repeat(64)]
      ),
      /permission denied for function consume_observable_preview_capability/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });

  it("is tenant isolated, append-only, and unavailable to the existing GIS worker", async () => {
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT id FROM app.observable_source_projects WHERE id = $1",
      [ID.sourceProject]
    ));
    assert.equal(hidden.rows.length, 0);
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        "DELETE FROM app.observable_source_revisions WHERE id = $1",
        [ID.revision]
      )),
      /permission denied for table observable_source_revisions|governed resource history is immutable/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT id FROM app.observable_build_jobs WHERE id = $1", [ID.build]),
      /permission denied for (?:table observable_build_jobs|function current_organization_id)/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });

  it("Framework publication requires exact output, preview, current destination and independent authority", async () => {
    const origin = "ac000000-0000-4000-8000-000000000492";
    const mount = "ad000000-0000-4000-8000-000000000492";
    const review = "ae000000-0000-4000-8000-000000000492";
    const capability = "af000000-0000-4000-8000-000000000492";
    await db.exec("RESET ROLE; BEGIN");
    try {
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization, ID.user]);
      await db.query(`INSERT INTO app.framework_publication_origins
        (id, organization_id, hostname, bucket, distribution_id, origin_id, active_release_prefix, enabled, verified_by, verified_at)
        VALUES ($1, $2, 'opengeo.tools', 'opengeo.tools', 'EXAMPLE', 'public-origin', 'releases/previous', true, $3, now())`, [origin, ID.organization, ID.user]);
      await db.query(`INSERT INTO app.framework_publication_mounts
        (id, organization_id, project_id, source_project_id, origin_id, mount_path, enabled, verified_by, verified_at)
        VALUES ($1, $2, $3, $4, $5, '/analysis/reading-beyond-visible/', true, $6, now())`, [mount, ID.organization, ID.project, ID.sourceProject, origin, ID.user]);
      await db.query("UPDATE app.framework_publication_origins SET self_service_prefix='/publications/', generation=generation+1 WHERE id=$1", [origin]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const reservation = randomUUID();
      const reserve = id => db.query("SELECT app.reserve_framework_publication_mount($1,$2,$3,$4,'atlas','reserve-address-without-publishing') AS id", [id, ID.project, ID.sourceProject, origin]);
      assert.equal((await reserve(reservation)).rows[0].id, reservation);
      const prepare = checksum => db.query("SELECT app.review_framework_publication($1, $2, $3, $4, $5) AS id", [review, ID.project, ID.build, mount, checksum]);
      const approve = () => db.query("SELECT app.approve_framework_publication($1, $2, 'publish-exact-previewed-output') AS id", [review, ID.project]);
      async function rejected(operation, message) {
        await db.exec("SAVEPOINT rejected");
        await assert.rejects(operation(), message);
        await db.exec("ROLLBACK TO SAVEPOINT rejected");
      }
      await rejected(() => prepare("0".repeat(64)), /Exact successful/);
      await rejected(() => prepare("f".repeat(64)), /rights approval/);
      // Seed approved rights on this isolated fixture, after proving that the
      // unreviewed revision cannot enter publication. Production revisions stay immutable.
      await db.exec("RESET ROLE; ALTER TABLE app.observable_source_revisions DISABLE TRIGGER USER");
      await db.query("UPDATE app.observable_source_revisions SET rights_status = 'approved' WHERE id = $1", [ID.revision]);
      await db.exec("ALTER TABLE app.observable_source_revisions ENABLE TRIGGER USER; SET LOCAL ROLE opengeo_runtime");
      assert.equal((await prepare("f".repeat(64))).rows[0].id, review);
      assert.equal((await prepare("f".repeat(64))).rows[0].id, review, "Lost review responses reuse the same record");
      await rejected(approve, /private preview/);
      await db.query(`INSERT INTO app.observable_preview_capabilities
        (id, organization_id, project_id, build_job_id, requested_by, token_checksum_sha256, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '90 seconds')`, [capability, ID.organization, ID.project, ID.build, ID.user, "9".repeat(64)]);
      await db.query("SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)", [capability, ID.organization, ID.user, "9".repeat(64)]);
      await db.exec("SAVEPOINT newer_release; RESET ROLE");
      await db.query("UPDATE app.framework_publication_origins SET generation = generation + 1 WHERE id = $1", [origin]);
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      await rejected(approve, /Public release changed/);
      await db.exec("ROLLBACK TO SAVEPOINT newer_release");
      assert.equal((await approve()).rows[0].id, review);
      assert.equal((await approve()).rows[0].id, review, "Lost approval responses never approve another build");
      await rejected(() => db.query("UPDATE app.framework_publication_origins SET generation = 9"), /permission denied/);
      await db.query("SELECT set_config('app.user_id', $1, true)", [ID.otherUser]);
      await rejected(approve, /publication authority/);
      await db.exec("RESET ROLE; SET LOCAL ROLE opengeo_framework_publisher");
      await rejected(() => db.query("SELECT * FROM app.observable_source_revisions"), /permission denied/);
      const token = "af100000-0000-4000-8000-000000000493";
      const claim = async lease => (await db.query("SELECT app.claim_framework_publication($1, $2) AS job", [review, lease])).rows[0].job;
      await db.exec("SAVEPOINT guest_authority; RESET ROLE");
      await db.query("UPDATE app.organization_memberships SET role='guest' WHERE organization_id=$1 AND user_id=$2", [ID.organization,ID.user]);
      await db.query("INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",[ID.organization,ID.project,ID.user]);
      await db.exec("SELECT set_config('app.organization_id','',true),set_config('app.user_id','',true); SET LOCAL ROLE opengeo_framework_publisher");
      assert.equal((await claim(token)).status,'claimed','Project-owner publication works without browser context');
      await db.exec("RESET ROLE");
      await db.query("DELETE FROM app.project_memberships WHERE project_id=$1 AND user_id=$2",[ID.project,ID.user]);
      await db.exec("SET LOCAL ROLE opengeo_framework_publisher");
      assert.equal((await claim(token)).status,'unavailable','Revocation is checked even with an existing lease');
      await db.exec("ROLLBACK TO SAVEPOINT guest_authority");
      const claimed = await claim(token);
      assert.equal(claimed.status, "claimed");
      assert.equal(claimed.source_project_id, ID.sourceProject);
      assert.equal((await claim(ID.coordinator)).status, "busy");
      await db.exec("RESET ROLE; SET LOCAL ROLE opengeo_runtime");
      await db.query("SELECT set_config('app.user_id', $1, true)", [ID.user]);
      assert.equal((await reserve(reservation)).rows[0].id, reservation, "An existing reservation remains recoverable during delivery");
      await rejected(() => reserve(randomUUID()), /delivery is busy/);
      await db.exec("RESET ROLE; SET LOCAL ROLE opengeo_framework_publisher");
      const plan = {reviewId: review, buildId: ID.build, mountPath: claimed.mount_path,
        previousPrefix: "releases/previous", targetPrefix: `releases/framework-${review}`,
        bucket: "opengeo.tools", files: [{path: "analysis/reading-beyond-visible/index.html"}]};
      const seal = () => db.query("SELECT app.seal_framework_publication_plan($1, $2, $3::jsonb, $4::jsonb) AS ok", [review, token, JSON.stringify(plan), JSON.stringify({etag: "edge-v1"})]);
      assert.equal((await seal()).rows[0].ok, true);
      assert.equal((await seal()).rows[0].ok, true);
      assert.equal((await db.query("SELECT app.activate_framework_publication($1, $2) AS ok", [review, token])).rows[0].ok, false);
      await rejected(() => db.query("SELECT app.checkpoint_framework_publication($1, $2, 2)", [review, token]), /checkpoint invalid/);
      assert.equal((await db.query("SELECT app.checkpoint_framework_publication($1, $2, 1) AS ok", [review, token])).rows[0].ok, true);
      await db.query("SELECT app.release_framework_publication($1, $2)", [review, token]);
      const resumed = await claim(token);
      assert.equal(resumed.completed_files, 1);
      assert.deepEqual(resumed.plan, plan);
      assert.equal((await db.query("SELECT app.activate_framework_publication($1, $2) AS ok", [review, token])).rows[0].ok, true);
      const receipt = {targetPrefix: plan.targetPrefix, previousPrefix: plan.previousPrefix,
        distributionId: "EXAMPLE", status: "Deployed", invalidationStatus: "Completed"};
      assert.equal((await db.query("SELECT app.complete_framework_publication($1, $2, $3::jsonb) AS ok", [review, token, JSON.stringify(receipt)])).rows[0].ok, true);
      assert.equal((await claim(token)).status, "deployed", "Lost completion responses must not republish");
      await db.exec("RESET ROLE");
      const activated = (await db.query("SELECT active_release_prefix, active_publication_id FROM app.framework_publication_origins WHERE id = $1", [origin])).rows[0];
      assert.equal(activated.active_release_prefix, plan.targetPrefix);
      assert.equal(activated.active_publication_id, null);
    } finally {
      await db.exec("ROLLBACK; SET ROLE opengeo_runtime");
    }
  });

  it("issues hashed owner-bound preview capabilities and consumes each exactly once", async () => {
    const capabilityId = "f2000000-0000-4000-8000-000000000451";
    const tokenChecksum = "9".repeat(64);
    await tenant(ID.organization, ID.user, () => db.query(
      `INSERT INTO app.observable_preview_capabilities
         (id, organization_id, project_id, build_job_id, requested_by,
          token_checksum_sha256, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               clock_timestamp() + interval '60 seconds')`,
      [
        capabilityId, ID.organization, ID.project, ID.build, ID.user,
        tokenChecksum
      ]
    ));
    const rawTokenAbsent = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT token_checksum_sha256, consumed_at
       FROM app.observable_preview_capabilities WHERE id = $1`,
      [capabilityId]
    ));
    assert.equal(rawTokenAbsent.rows[0].token_checksum_sha256, tokenChecksum);
    assert.equal(rawTokenAbsent.rows[0].consumed_at, null);
    const invalid = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)`,
      [capabilityId, ID.organization, ID.user, "8".repeat(64)]
    ));
    assert.equal(invalid.rows.length, 0);
    const consumed = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)`,
      [capabilityId, ID.organization, ID.user, tokenChecksum]
    ));
    assert.equal(consumed.rows.length, 1);
    assert.equal(consumed.rows[0].output_prefix.endsWith(`/builds/${ID.build}/output/`), true);
    assert.equal(consumed.rows[0].entry_file, "dist/index.html");
    assert.ok(consumed.rows[0].cookie_expires_at instanceof Date);
    const replay = await tenant(ID.organization, ID.user, () => db.query(
      `SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)`,
      [capabilityId, ID.organization, ID.user, tokenChecksum]
    ));
    assert.equal(replay.rows.length, 0);
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () => db.query(
      "SELECT id FROM app.observable_preview_capabilities WHERE id = $1",
      [capabilityId]
    ));
    assert.equal(hidden.rows.length, 0);
    await assert.rejects(
      tenant(ID.organization, ID.user, () => db.query(
        `UPDATE app.observable_preview_capabilities
         SET consumed_at = NULL WHERE id = $1`,
        [capabilityId]
      )),
      /permission denied|immutable or already consumed/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_worker");
    await assert.rejects(
      db.query(
        `SELECT * FROM app.consume_observable_preview_capability($1, $2, $3, $4)`,
        [capabilityId, ID.organization, ID.user, tokenChecksum]
      ),
      /permission denied for function consume_observable_preview_capability/
    );
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE opengeo_runtime");
  });
  it("offboards a preview requester without erasing capability history or permitting new issue/exchange", async () => {
    const reviewer=randomUUID(),consumed=randomUUID(),pending=randomUUID();
    const consumedChecksum=randomUUID().replaceAll('-','').repeat(2);
    const pendingChecksum=randomUUID().replaceAll('-','').repeat(2);
    await db.exec('RESET ROLE; BEGIN');
    try {
      await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [ID.organization,reviewer]);
      await db.query(`INSERT INTO app.users (id,cognito_subject,email,display_name)
        VALUES ($1,$2,$3,'Temporary preview reviewer')`,[reviewer,`preview-${reviewer}`,`${reviewer}@example.test`]);
      await db.query(`INSERT INTO app.organization_memberships (organization_id,user_id,role,invited_by)
        VALUES ($1,$2,'guest',$3)`,[ID.organization,reviewer,ID.user]);
      await db.query(`INSERT INTO app.project_memberships (organization_id,project_id,user_id,role)
        VALUES ($1,$2,$3,'viewer')`,[ID.organization,ID.project,reviewer]);
      await db.exec('SET LOCAL ROLE opengeo_runtime');
      const issue=(id,checksum)=>db.query(`INSERT INTO app.observable_preview_capabilities
        (id,organization_id,project_id,build_job_id,requested_by,token_checksum_sha256,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '60 seconds')`,
        [id,ID.organization,ID.project,ID.build,reviewer,checksum]);
      const exchange=(id,checksum)=>db.query('SELECT * FROM app.consume_observable_preview_capability($1,$2,$3,$4)',
        [id,ID.organization,reviewer,checksum]);
      await issue(consumed,consumedChecksum);await issue(pending,pendingChecksum);
      assert.equal((await exchange(consumed,consumedChecksum)).rows.length,1);
      const history=()=>db.query(`SELECT * FROM app.observable_preview_capabilities WHERE id=ANY($1::uuid[]) ORDER BY id`,[[consumed,pending]]);
      const before=(await history()).rows;
      await db.exec('RESET ROLE');
      assert.equal((await db.query('DELETE FROM app.project_memberships WHERE organization_id=$1 AND project_id=$2 AND user_id=$3',
        [ID.organization,ID.project,reviewer])).affectedRows,1);
      assert.equal((await db.query('DELETE FROM app.organization_memberships WHERE organization_id=$1 AND user_id=$2',
        [ID.organization,reviewer])).affectedRows,1);
      assert.deepEqual((await history()).rows,before,'Consumed and unused capability audit rows survive unchanged');
      assert.equal((await db.query('SELECT role FROM app.organization_memberships WHERE organization_id=$1 AND user_id=$2',
        [ID.organization,ID.user])).rows[0].role,'admin');
      await db.exec('SET LOCAL ROLE opengeo_runtime');
      assert.equal((await exchange(pending,pendingChecksum)).rows.length,0,'An unconsumed capability loses exchange authority immediately');
      await db.exec('SAVEPOINT denied_reissue');
      await assert.rejects(issue(randomUUID(),randomUUID().replaceAll('-','').repeat(2)),/current organization membership/);
      await db.exec('ROLLBACK TO SAVEPOINT denied_reissue');
      assert.deepEqual((await history()).rows,before,'Denied issuance/exchange does not alter retained history');
    } finally {
      await db.exec('ROLLBACK; SET ROLE opengeo_runtime');
    }
  });
  it("commits HTML and native Jupyter revisions through the installed source-head validator", async () => {
    for (const [path, contentType] of [['index.html', 'text/html'], ['analysis.ipynb', 'application/x-ipynb+json'], ['analysis.ipynb', 'application/json']]) {
      const revisionId = randomUUID(), uploadId = randomUUID(), objectId = randomUUID();
      await tenant(ID.organization, ID.user, async () => {
        const head = (await db.query('SELECT * FROM app.observable_source_projects WHERE id = $1', [ID.sourceProject])).rows[0];
        const next = head.current_revision_number + 1;
        const objectKey = sourceKey(uploadId, path);
        await db.query(`INSERT INTO app.observable_source_file_upload_intents
          (id, organization_id, project_id, source_project_id, relative_path, expected_content_type,
           expected_size_bytes, expected_sha256, bucket, object_key, created_by, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,12,$7,'source.opengeo.tools',$8,$9,clock_timestamp()+interval '15 minutes')`,
          [uploadId, ID.organization, ID.project, ID.sourceProject, path, contentType, 'a'.repeat(64), objectKey, ID.user]);
        await db.query(`INSERT INTO app.observable_source_objects
          (id, organization_id, project_id, source_project_id, upload_intent_id, relative_path,
           bucket, object_key, s3_version_id, etag, content_type, size_bytes, checksum_sha256, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,'source.opengeo.tools',$7,'v1','etag',$8,12,$9,$10)`,
          [objectId, ID.organization, ID.project, ID.sourceProject, uploadId, path, objectKey, contentType, 'a'.repeat(64), ID.user]);
        const exact = {schemaVersion: 'opengeo.observable-source-revision.1.0.0', sourceProjectId: ID.sourceProject,
          revisionId, revisionNumber: next, entryPath: path, lockfilePath: null,
          files: [{path, objectId, bucket: 'source.opengeo.tools', objectKey, s3VersionId: 'v1', etag: 'etag', contentType,
            sizeBytes: 12, checksumSha256: 'a'.repeat(64)}]};
        await db.query(`INSERT INTO app.observable_source_revisions
          (id, organization_id, project_id, source_project_id, revision_number, parent_revision_id,
           title, rights_status, entry_path, lockfile_path, manifest, manifest_checksum_sha256, change_summary, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::jsonb,$11,'Native publication source',$12)`,
          [revisionId, ID.organization, ID.project, ID.sourceProject, next, head.current_revision_id,
            head.title, head.rights_status, path, JSON.stringify(exact), 'f'.repeat(64), ID.user]);
        await db.query(`INSERT INTO app.observable_source_revision_files
          (organization_id, project_id, source_project_id, source_revision_id, relative_path, source_object_id, position, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,0,$7)`, [ID.organization, ID.project, ID.sourceProject, revisionId, path, objectId, ID.user]);
        await db.query(`UPDATE app.observable_source_projects SET current_revision_id=$1,current_revision_number=$2,updated_by=$3 WHERE id=$4`,
          [revisionId, next, ID.user, ID.sourceProject]);
        await db.query(`UPDATE app.observable_source_file_upload_intents SET state='committed',completed_object_id=$1,completed_at=clock_timestamp() WHERE id=$2`, [objectId, uploadId]);
      });
      const committed = await tenant(ID.organization, ID.user, () => db.query('SELECT current_revision_id FROM app.observable_source_projects WHERE id=$1', [ID.sourceProject]));
      assert.equal(committed.rows[0].current_revision_id, revisionId);
    }
  });

  it('reserves destinations only within explicitly delegated public prefixes, without publishing or reviving retired URLs', async () => {
    const origin = randomUUID(), mount = randomUUID(), rootMount = randomUUID();
    const ack = 'reserve-address-without-publishing';
    // Execute the installer's actual statements against the existing schema and runtime role.
    const extraction = spawnSync('python3', ['-c',
      "import ast,json,sys;from pathlib import Path;t=ast.parse(Path(sys.argv[1]).read_text());print(json.dumps({n.targets[0].id:ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id.endswith('_SQL')}))",
      fileURLToPath(new URL('../scripts/bootstrap_publication_origin.py', import.meta.url))],
      {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
    assert.equal(extraction.status, 0, extraction.stderr);
    const statements = JSON.parse(extraction.stdout);
    const setupQuery = (name, values) => {
      const names = [];
      const sql = statements[name].replace(/(?<!:):([a-z_]+)/g, (_, parameter) => {
        if (!names.includes(parameter)) names.push(parameter);
        return `$${names.indexOf(parameter) + 1}`;
      });
      return db.query(sql, names.map(name => values[name]));
    };
    const reserve = (id = mount, slug = 'atlas', acknowledgment = ack, source = ID.sourceProject) => db.query(
      'SELECT app.reserve_framework_publication_mount($1,$2,$3,$4,$5,$6) AS id', [id, ID.project, source, origin, slug, acknowledgment]);
    await db.exec('RESET ROLE');
    await db.query(`INSERT INTO app.organization_memberships (organization_id,user_id,role,invited_by)
      VALUES ($1,$2,'member',$3) ON CONFLICT (organization_id,user_id) DO UPDATE SET role='member'`, [ID.organization,ID.otherUser,ID.user]);
    await db.query(`INSERT INTO app.project_memberships (organization_id,project_id,user_id,role)
      VALUES ($1,$2,$3,'viewer') ON CONFLICT (organization_id,project_id,user_id) DO UPDATE SET role='viewer'`, [ID.organization,ID.project,ID.otherUser]);
    assert.deepEqual((await setupQuery('AUTHORITY_SQL', {subject:'source-author',email:'source@example.test',organization_id:ID.organization})).rows,
      [{user_id:ID.user}]);
    assert.deepEqual((await setupQuery('AUTHORITY_SQL', {subject:'other-source-author',email:'other@example.test',organization_id:ID.organization})).rows, []);
    const registration = {id:origin,organization_id:ID.organization,hostname:'publications.example.test',bucket:'public-bucket',
      distribution_id:'EXAMPLE',origin_id:'public',release_prefix:'releases/unchanged',enabled:false,user_id:ID.user,
      self_service_prefix:'/publications/',project_reservation_limit:0};
    const registered = (await setupQuery('INSERT_SQL', registration)).rows[0];
    assert.equal(Number(registered.generation),1);
    assert.equal(registered.active_release_prefix,'releases/unchanged');
    assert.equal((await setupQuery('ORIGIN_SQL',{id:origin,hostname:registration.hostname})).rows.length,1);
    assert.deepEqual((await setupQuery('MOUNTS_SQL',{id:origin})).rows,[{count:0}]);
    await db.query(`INSERT INTO app.framework_publication_mounts
      (id,organization_id,project_id,source_project_id,origin_id,mount_path,enabled,verified_by,verified_at)
      VALUES ($1,$2,$3,$4,$5,'/',true,$6,now())`, [rootMount,ID.organization,ID.project,ID.sourceProject,origin,ID.user]);
    await db.exec('SET ROLE opengeo_runtime');
    await assert.rejects(tenant(ID.organization,ID.user,() => reserve()), /not authorized/);
    await assert.rejects(tenant(ID.organization,ID.user,() => db.query("UPDATE app.framework_publication_origins SET self_service_prefix='/publications/',generation=generation+1 WHERE id=$1",[origin])), /permission denied/);
    await db.exec('RESET ROLE');
    const currentGeneration = Number((await db.query('SELECT generation FROM app.framework_publication_origins WHERE id=$1',[origin])).rows[0].generation);
    assert.equal((await setupQuery('UPDATE_SQL',{...registration,enabled:true,expected_generation:currentGeneration-1})).rows.length,0);
    const enabled = (await setupQuery('UPDATE_SQL',{...registration,enabled:true,expected_generation:currentGeneration})).rows[0];
    assert.equal(Number(enabled.generation),currentGeneration+1);
    assert.equal(enabled.active_release_prefix,registration.release_prefix);
    await db.exec('SET ROLE opengeo_runtime');
    const principal = (await setupQuery('PRINCIPAL_SQL',{subject:'source-author',organization_id:ID.organization})).rows;
    assert.deepEqual(principal,[{user_id:ID.user,email:'source@example.test',role:'admin'}]);
    await tenant(ID.organization,ID.user,async () => {
      await setupQuery('CONTEXT_SQL',{organization_id:ID.organization,user_id:ID.user});
      assert.deepEqual((await setupQuery('READBACK_SQL',{id:origin,organization_id:ID.organization})).rows,[enabled]);
    });
    assert.deepEqual((await tenant(ID.otherOrganization,ID.otherUser,() => setupQuery('READBACK_SQL',{id:origin,organization_id:ID.organization}))).rows,[]);
    await db.exec('RESET ROLE');
    const before = (await db.query('SELECT generation,active_release_prefix FROM app.framework_publication_origins WHERE id=$1',[origin])).rows[0];
    const jobs = (await db.query('SELECT count(*) AS count FROM app.framework_publication_jobs')).rows[0].count;
    await db.exec('SET ROLE opengeo_runtime');
    for (const slug of ['../atlas','/atlas/','atlas/nested','Atlas','',null]) await assert.rejects(tenant(ID.organization,ID.user,() => reserve(randomUUID(),slug)), /Invalid publication destination/);
    await assert.rejects(tenant(ID.organization,ID.user,() => reserve(mount,'atlas','publish')), /Invalid publication destination/);
    await assert.rejects(tenant(ID.organization,ID.user,() => reserve(mount,'atlas',ack,randomUUID())), /Source project not found/);
    assert.equal((await tenant(ID.organization,ID.user,() => reserve())).rows[0].id,mount);
    assert.equal((await tenant(ID.organization,ID.user,() => reserve())).rows[0].id,mount);
    await assert.rejects(tenant(ID.organization,ID.user,() => reserve(randomUUID())), /already reserved/);
    await assert.rejects(tenant(ID.organization,ID.user,() => reserve(mount,'another')), /identity conflict/);
    await assert.rejects(tenant(ID.otherOrganization,ID.otherUser,() => reserve(randomUUID(),'foreign')), /authority required/);
    await db.exec('RESET ROLE');
    const after = (await db.query('SELECT generation,active_release_prefix FROM app.framework_publication_origins WHERE id=$1',[origin])).rows[0];
    assert.equal(Number(after.generation),Number(before.generation)+1);
    assert.equal(after.active_release_prefix,before.active_release_prefix);
    assert.equal((await db.query('SELECT count(*) AS count FROM app.framework_publication_jobs')).rows[0].count,jobs);
    assert.equal((await db.query('SELECT mount_path FROM app.framework_publication_mounts WHERE id=$1',[rootMount])).rows[0].mount_path,'/');
    for (const path of ['/publications/retired/','/publications/busy/child/']) await db.query(`INSERT INTO app.framework_publication_mounts
      (organization_id,project_id,source_project_id,origin_id,mount_path,enabled,verified_by,verified_at)
      VALUES ($1,$2,$3,$4,$5,false,$6,now())`,[ID.organization,ID.project,ID.sourceProject,origin,path,ID.user]);
    assert.equal((await db.query('SELECT role FROM app.organization_memberships WHERE organization_id=$1 AND user_id=$2',[ID.organization,ID.otherUser])).rows[0].role,'member');
    await db.query(`UPDATE app.project_memberships SET role='owner' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`,[ID.organization,ID.project,ID.otherUser]);
    await db.exec('SET ROLE opengeo_runtime');
    for (const slug of ['retired','busy']) await assert.rejects(tenant(ID.organization,ID.user,() => reserve(randomUUID(),slug)), /already reserved/);
    await assert.rejects(tenant(ID.organization,ID.otherUser,() => reserve(randomUUID(),'owner')), /delegation required/);
    await assert.rejects(tenant(ID.organization,ID.otherUser,() => db.query('UPDATE app.framework_publication_origins SET project_reservation_limit=10,generation=generation+1 WHERE id=$1',[origin])), /permission denied/);
    await db.exec('RESET ROLE');
    await assert.rejects(db.query('UPDATE app.framework_publication_origins SET project_reservation_limit=5 WHERE id=$1',[origin]), /advance generation/);
    // Three existing addresses (including retired paths) consume capacity.
    await db.query('UPDATE app.framework_publication_origins SET project_reservation_limit=5,generation=generation+1 WHERE id=$1',[origin]);
    const ownerMount=randomUUID(), reviewerMount=randomUUID();
    await db.exec('SET ROLE opengeo_runtime');
    assert.equal((await tenant(ID.organization,ID.otherUser,() => reserve(ownerMount,'owner'))).rows[0].id,ownerMount);
    await db.exec('RESET ROLE');
    await db.query("UPDATE app.project_memberships SET role='reviewer' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",[ID.organization,ID.project,ID.otherUser]);
    await db.exec('SET ROLE opengeo_runtime');
    assert.equal((await tenant(ID.organization,ID.otherUser,() => reserve(reviewerMount,'reviewer'))).rows[0].id,reviewerMount);
    assert.equal((await tenant(ID.organization,ID.otherUser,() => reserve(reviewerMount,'reviewer'))).rows[0].id,reviewerMount);
    for(const user of [ID.user,ID.otherUser]) await assert.rejects(tenant(ID.organization,user,() => reserve(randomUUID(),'over-limit')), /capacity reached/);
    await db.exec('RESET ROLE');
    await db.query("UPDATE app.project_memberships SET role='editor' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",[ID.organization,ID.project,ID.otherUser]);
    await db.exec('SET ROLE opengeo_runtime');
    await assert.rejects(tenant(ID.organization,ID.otherUser,() => reserve(randomUUID(),'editor')), /authority required/);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*) AS count FROM app.framework_publication_jobs')).rows[0].count,jobs);
    await db.exec('RESET ROLE; SET ROLE opengeo_worker');
    await assert.rejects(reserve(randomUUID(),'worker'), /permission denied for function/);
    await db.exec('RESET ROLE');
    await assert.rejects(db.query(`INSERT INTO app.framework_publication_origins
      (organization_id,hostname,bucket,distribution_id,origin_id,active_release_prefix,enabled,verified_by,verified_at,self_service_prefix)
      VALUES ($1,'studio.opengeo.tools','public-bucket','EXAMPLE','studio','releases/unchanged',true,$2,now(),'/publications/')`,[ID.organization,ID.user]), /check constraint/);
    await db.exec('SET ROLE opengeo_runtime');
  });
});
