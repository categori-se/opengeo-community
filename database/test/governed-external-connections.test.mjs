import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const ID = {
  organization: "10000000-0000-4000-8000-000000000471",
  otherOrganization: "10000000-0000-4000-8000-000000000472",
  user: "20000000-0000-4000-8000-000000000471",
  otherUser: "20000000-0000-4000-8000-000000000472",
  project: "50000000-0000-4000-8000-000000000471",
  connection: "70000000-0000-4000-8000-000000000471",
  revision: "71000000-0000-4000-8000-000000000471"
};

const secretArn =
  "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/" +
  `${ID.organization}/${ID.connection}-AbCd12`;

let db;

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

function configuration(host = "gis.example.test") {
  return {
    provider: "postgresql",
    endpointHost: host,
    endpointPort: 5432,
    databaseName: "research",
    allowedSchemas: ["public", "observations"],
    readOnly: true,
    tlsMode: "verify_full",
    networkMode: "public_internet"
  };
}

describe("0047 governed credentialed external connection boundary", {concurrency: false}, () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql",
      "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql",
      "0004_worker_execution_boundary.sql",
      "0047_governed_external_connections.sql"
    ]) {
      let sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, "");
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${ID.user}', 'connection-owner', 'owner@example.test', 'Connection Owner'),
        ('${ID.otherUser}', 'other-owner', 'other@example.test', 'Other Owner');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${ID.organization}', 'Connections', 'connections', '${ID.user}'),
        ('${ID.otherOrganization}', 'Other', 'other-connections', '${ID.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${ID.organization}', '${ID.user}', 'member', '${ID.user}'),
        ('${ID.otherOrganization}', '${ID.otherUser}', 'admin', '${ID.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${ID.project}', '${ID.organization}', 'Connection project', '${ID.user}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role)
      VALUES ('${ID.organization}', '${ID.project}', '${ID.user}', 'owner');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("stores one secret-separated read-only PostgreSQL configuration and immutable revision", async () => {
    await tenant(ID.organization, ID.user, async () => {
      await db.query(
        `INSERT INTO app.external_connections
           (id, organization_id, project_id, provider, display_name,
            endpoint_host, endpoint_port, database_name, allowed_schemas,
            secret_arn, configured_secret_fields, created_by, updated_by)
         VALUES ($1, $2, $3, 'postgresql', 'Research warehouse',
                 'gis.example.test', 5432, 'research', $4,
                 $5, ARRAY['password', 'username'], $6, $6)`,
        [
          ID.connection,
          ID.organization,
          ID.project,
          ["public", "observations"],
          secretArn,
          ID.user
        ]
      );
      await db.query(
        `INSERT INTO app.external_connection_revisions
           (id, organization_id, project_id, connection_id, revision_number,
            configuration, change_summary, created_by)
         VALUES ($1, $2, $3, $4, 1, $5::jsonb, 'Initial connection registration', $6)`,
        [
          ID.revision,
          ID.organization,
          ID.project,
          ID.connection,
          JSON.stringify(configuration()),
          ID.user
        ]
      );
      const visible = await db.query(
        `SELECT provider::text, display_name, endpoint_host, read_only,
                tls_mode::text, network_mode::text, status::text,
                configured_secret_fields, current_revision_number
         FROM app.external_connections WHERE id = $1`,
        [ID.connection]
      );
      assert.deepEqual(visible.rows[0], {
        provider: "postgresql",
        display_name: "Research warehouse",
        endpoint_host: "gis.example.test",
        read_only: true,
        tls_mode: "verify_full",
        network_mode: "public_internet",
        status: "configuration_valid",
        configured_secret_fields: ["password", "username"],
        current_revision_number: 1
      });
    });
  });

  it("does not grant the runtime role read access to the secret reference", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query("SELECT secret_arn FROM app.external_connections WHERE id = $1", [ID.connection])
      ),
      /permission denied/
    );
  });

  it("enforces tenant isolation and denies worker access", async () => {
    const hidden = await tenant(ID.otherOrganization, ID.otherUser, () =>
      db.query("SELECT id FROM app.external_connections")
    );
    assert.equal(hidden.rows.length, 0);

    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    await assert.rejects(
      db.query("SELECT id FROM app.external_connections"),
      /permission denied/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
  });

  it("rejects unsafe hosts, writable mode, duplicate schemas, and secret-shaped revision fields", async () => {
    for (const [host, schemas, readOnly] of [
      ["127.0.0.1", ["public"], true],
      ["metadata.internal", ["public"], true],
      ["safe.example.test", ["public", "public"], true],
      ["safe.example.test", ["public"], false]
    ]) {
      await assert.rejects(
        tenant(ID.organization, ID.user, () =>
          db.query(
            `INSERT INTO app.external_connections
               (organization_id, project_id, provider, display_name, endpoint_host,
                database_name, allowed_schemas, read_only, secret_arn,
                configured_secret_fields, created_by, updated_by)
             VALUES ($1, $2, 'postgresql', 'Unsafe', $3, 'research', $4, $5,
                     $6, ARRAY['password', 'username'], $7, $7)`,
            [ID.organization, ID.project, host, schemas, readOnly, secretArn, ID.user]
          )
        ),
        /violates check constraint/
      );
    }

    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.external_connection_revisions
             (organization_id, project_id, connection_id, revision_number,
              configuration, change_summary, created_by)
           VALUES ($1, $2, $3, 2, $4::jsonb, 'Unsafe revision', $5)`,
          [
            ID.organization,
            ID.project,
            ID.connection,
            JSON.stringify({...configuration(), password: "do-not-store"}),
            ID.user
          ]
        )
      ),
      /must match its governed connection/
    );

    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          `INSERT INTO app.external_connection_revisions
             (organization_id, project_id, connection_id, revision_number,
              configuration, change_summary, created_by)
           VALUES ($1, $2, $3, 1, $4::jsonb, 'Mismatched revision', $5)`,
          [
            ID.organization,
            ID.project,
            ID.connection,
            JSON.stringify(configuration("other.example.test")),
            ID.user
          ]
        )
      ),
      /must match its governed connection/
    );
  });

  it("prevents revision update and deletion", async () => {
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query(
          "UPDATE app.external_connection_revisions SET change_summary = 'rewrite' WHERE id = $1",
          [ID.revision]
        )
      ),
      /permission denied/
    );
    await assert.rejects(
      tenant(ID.organization, ID.user, () =>
        db.query("DELETE FROM app.external_connection_revisions WHERE id = $1", [ID.revision])
      ),
      /permission denied/
    );

    await db.exec("RESET ROLE");
    await assert.rejects(
      db.query(
        "UPDATE app.external_connection_revisions SET change_summary = 'rewrite' WHERE id = $1",
        [ID.revision]
      ),
      /append-only/
    );
    await db.exec("SET ROLE opengeo_runtime");
  });
});
