import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000056",
  otherOrganization: "10000000-0000-4000-8000-000000000057",
  owner: "20000000-0000-4000-8000-000000000056",
  collaborator: "20000000-0000-4000-8000-000000000057",
  otherUser: "20000000-0000-4000-8000-000000000058",
  project: "50000000-0000-4000-8000-000000000056",
  otherProject: "50000000-0000-4000-8000-000000000057",
  team: "90000000-0000-4000-8000-000000000056",
  connection: "c0000000-0000-4000-8000-000000000056",
  forgedConnection: "c0000000-0000-4000-8000-000000000057",
  binding: "c1000000-0000-4000-8000-000000000056"
};

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/browser-connections/profile/version-AbCd12";

let db;
let migration;

async function readMigration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

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

describe("0056-0057 user basemap provider connections migrations", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readMigration("0001_platform_foundation.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(`
      CREATE ROLE opengeo_worker;
      CREATE ROLE opengeo_connector;
      CREATE ROLE opengeo_observable_coordinator;
      CREATE ROLE opengeo_dataset_verifier;
    `);
    await db.exec(await readMigration("0050_team_project_access.sql"));
    await db.exec(await readMigration("0051_user_dataset_connections.sql"));
    migration = await readMigration("0056_user_basemap_connections.sql");
    await db.exec(migration);
    await db.exec(await readMigration("0057_carto_basemap_connections.sql"));
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'owner-56', 'owner@example.test', 'Owner'),
        ('${IDS.collaborator}', 'collaborator-56', 'collaborator@example.test', 'Collaborator'),
        ('${IDS.otherUser}', 'other-56', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'OpenGeo Development', 'opengeo-dev-56', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other tenant', 'other-tenant-56', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.collaborator}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES
        ('${IDS.project}', '${IDS.organization}', 'Connected maps', '${IDS.owner}'),
        ('${IDS.otherProject}', '${IDS.otherOrganization}', 'Other maps', '${IDS.otherUser}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner');
      INSERT INTO app.teams (id, organization_id, name, created_by)
      VALUES ('${IDS.team}', '${IDS.organization}', 'Map viewers', '${IDS.owner}');
      INSERT INTO app.team_memberships (organization_id, team_id, user_id, role, created_by)
      VALUES ('${IDS.organization}', '${IDS.team}', '${IDS.collaborator}', 'member', '${IDS.owner}');
      INSERT INTO app.project_team_grants
        (organization_id, project_id, team_id, role, created_by)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.team}', 'viewer', '${IDS.owner}');
      SET ROLE opengeo_runtime;
    `);
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("persists only browser-provider metadata until a key version is committed", async () => {
    const result = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.user_basemap_connections
          (id, organization_id, owner_user_id, provider, display_name,
           allowed_origins, status)
         VALUES ($1, $2, $3, 'protomaps', 'Protomaps hosted API',
                 ARRAY['https://studio.opengeo.tools'], 'draft')`,
        [IDS.connection, IDS.organization, IDS.owner]
      );
      return db.query(
        `SELECT display_name, provider::text, allowed_origins,
                configured_secret_fields, credential_revision, status::text
         FROM app.user_basemap_connections WHERE id = $1`,
        [IDS.connection]
      );
    });

    assert.deepEqual(result.rows, [{
      display_name: "Protomaps hosted API",
      provider: "protomaps",
      allowed_origins: ["https://studio.opengeo.tools"],
      configured_secret_fields: [],
      credential_revision: 0,
      status: "draft"
    }]);
  });

  it("accepts CARTO only as an explicit reusable provider connection", async () => {
    const result = await inTenant(IDS.organization, IDS.owner, async () => db.query(
      `INSERT INTO app.user_basemap_connections
        (organization_id, owner_user_id, provider, display_name,
         allowed_origins, status)
       VALUES ($1, $2, 'carto', 'CARTO basemaps',
               ARRAY['https://studio.opengeo.tools'], 'draft')
       RETURNING provider::text, display_name, configured_secret_fields,
                 credential_revision, status::text`,
      [IDS.organization, IDS.owner]
    ));

    assert.deepEqual(result.rows, [{
      provider: "carto",
      display_name: "CARTO basemaps",
      configured_secret_fields: [],
      credential_revision: 0,
      status: "draft"
    }]);
  });

  it("rejects an origin path at the database limit", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `UPDATE app.user_basemap_connections
         SET allowed_origins = ARRAY['https://studio.opengeo.tools/path']
         WHERE id = $1`,
        [IDS.connection]
      )),
      /user_basemap_connections_origins_safe/
    );

    for (const origins of [
      ["https://studio.opengeo.tools", "https://STUDIO.OPENGeo.tools"],
      ["http://localhost:0"],
      ["http://localhost:65536"]
    ]) {
      await assert.rejects(
        inTenant(IDS.organization, IDS.owner, () => db.query(
          `UPDATE app.user_basemap_connections
           SET allowed_origins = $2
           WHERE id = $1`,
          [IDS.connection, origins]
        )),
        /user_basemap_connections_origins_safe/
      );
    }
  });

  it("can disable and re-enable draft metadata before a browser key exists", async () => {
    const statuses = [];
    for (const status of ["disabled", "draft"]) {
      const result = await inTenant(IDS.organization, IDS.owner, () => db.query(
        `UPDATE app.user_basemap_connections
         SET status = $2
         WHERE id = $1
         RETURNING status::text`,
        [IDS.connection, status]
      ));
      statuses.push(result.rows[0].status);
    }
    assert.deepEqual(statuses, ["disabled", "draft"]);
  });

  it("rotates an opaque reference without granting secret-column access", async () => {
    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.user_basemap_connections
          (id, organization_id, owner_user_id, provider, display_name,
           allowed_origins, secret_arn, configured_secret_fields,
           credential_revision, status)
         VALUES ($1, $2, $3, 'protomaps', 'Forged secret reference',
                 ARRAY['https://studio.opengeo.tools'], $4,
                 ARRAY['api_key'], 1, 'configured')`,
        [IDS.forgedConnection, IDS.organization, IDS.owner, SECRET_ARN]
      )),
      /permission denied/
    );

    const prepared = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT * FROM app.prepare_user_basemap_connection_credential_rotation($1)",
      [IDS.connection]
    ));
    assert.deepEqual(prepared.rows, [{current_secret_arn: null, credential_revision: 0}]);

    const committed = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.commit_user_basemap_connection_credential_rotation($1, 0, $2) AS committed",
      [IDS.connection, SECRET_ARN]
    ));
    assert.equal(committed.rows[0].committed, true);

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        "SELECT secret_arn FROM app.user_basemap_connections WHERE id = $1",
        [IDS.connection]
      )),
      /permission denied/
    );
  });

  it("shares metadata and style resolution only through an accessible project binding", async () => {
    const privateBeforeBinding = await inTenant(
      IDS.organization,
      IDS.collaborator,
      () => db.query("SELECT id FROM app.user_basemap_connections")
    );
    assert.deepEqual(privateBeforeBinding.rows, []);

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () => db.query(
        `INSERT INTO app.project_basemap_connection_bindings
          (organization_id, project_id, connection_id, display_name, created_by)
         VALUES ($1, $2, $3, 'False creator', $4)`,
        [IDS.organization, IDS.project, IDS.connection, IDS.collaborator]
      )),
      /row-level security policy/
    );

    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.project_basemap_connection_bindings
        (id, organization_id, project_id, connection_id, display_name, created_by)
       VALUES ($1, $2, $3, $4, 'Project basemap', $5)`,
      [IDS.binding, IDS.organization, IDS.project, IDS.connection, IDS.owner]
    ));

    const shared = await inTenant(IDS.organization, IDS.collaborator, () => db.query(
      "SELECT id, display_name FROM app.user_basemap_connections"
    ));
    assert.deepEqual(shared.rows, [{
      id: IDS.connection,
      display_name: "Protomaps hosted API"
    }]);

    const resolution = await inTenant(IDS.organization, IDS.collaborator, () => db.query(
      "SELECT * FROM app.prepare_project_basemap_style_resolution($1, $2)",
      [IDS.project, IDS.binding]
    ));
    assert.deepEqual(resolution.rows, [{
      provider: "protomaps",
      connection_id: IDS.connection,
      connection_name: "Protomaps hosted API",
      secret_arn: SECRET_ARN,
      credential_revision: 1
    }]);

    const crossTenant = await inTenant(
      IDS.otherOrganization,
      IDS.otherUser,
      () => db.query(
        "SELECT * FROM app.prepare_project_basemap_style_resolution($1, $2)",
        [IDS.project, IDS.binding]
      )
    );
    assert.deepEqual(crossTenant.rows, []);
  });

  it("documents client visibility and excludes background runtimes", () => {
    assert.match(migration, /disclosed only by an authorized project style resolution/i);
    assert.doesNotMatch(
      migration.match(/GRANT SELECT \([\s\S]*?\) ON app\.user_basemap_connections/)[0],
      /secret_arn/
    );
    assert.match(
      migration,
      /REVOKE ALL ON\s+app\.user_basemap_connections,\s+app\.project_basemap_connection_bindings\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator,\s+opengeo_dataset_verifier/
    );
  });
});
