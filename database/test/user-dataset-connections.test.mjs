import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000051",
  otherOrganization: "10000000-0000-4000-8000-000000000052",
  owner: "20000000-0000-4000-8000-000000000051",
  collaborator: "20000000-0000-4000-8000-000000000052",
  otherUser: "20000000-0000-4000-8000-000000000053",
  project: "50000000-0000-4000-8000-000000000051",
  team: "90000000-0000-4000-8000-000000000051",
  connection: "a0000000-0000-4000-8000-000000000051",
  binding: "a1000000-0000-4000-8000-000000000051"
};

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/user-connections/profile/version-AbCd12";

let db;
let migration;

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

describe("0051 user dataset connections migration", () => {
  before(async () => {
    db = new PGlite();
    const readMigration = (name) => readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8"
    );
    const foundation = await readMigration("0001_platform_foundation.sql");
    const teams = await readMigration("0050_team_project_access.sql");
    migration = await readMigration("0051_user_dataset_connections.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator;"
    );
    await db.exec(teams);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'owner-51', 'owner@example.test', 'Aaron Dennis'),
        ('${IDS.collaborator}', 'collaborator-51', 'collaborator@example.test', 'Collaborator'),
        ('${IDS.otherUser}', 'other-51', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organization}', 'OpenGeo Development', 'opengeo-development', '${IDS.owner}'),
        ('${IDS.otherOrganization}', 'Other tenant', 'other-tenant-51', '${IDS.otherUser}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.collaborator}', 'member', '${IDS.owner}'),
        ('${IDS.otherOrganization}', '${IDS.otherUser}', 'admin', '${IDS.otherUser}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Nepal data', '${IDS.owner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner');
      INSERT INTO app.teams (id, organization_id, name, created_by)
      VALUES ('${IDS.team}', '${IDS.organization}', 'Reviewers', '${IDS.owner}');
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

  it("persists reusable S3 metadata without requiring credentials", async () => {
    const result = await inTenant(IDS.organization, IDS.owner, async () => {
      await db.query(
        `INSERT INTO app.user_dataset_connections
          (id, organization_id, owner_user_id, provider, display_name, bucket_name,
           region_name, object_prefix, credential_mode, role_arn, status)
         VALUES ($1, $2, $3, 's3', 'Geospatial data', 'example-geodata',
                 'us-east-1', '', 'assume_role',
                 'arn:aws:iam::222222222222:role/OpenGeoDatasetReader', 'unverified')`,
        [IDS.connection, IDS.organization, IDS.owner]
      );
      return db.query(
        `SELECT display_name, bucket_name, region_name, credential_mode::text,
                configured_secret_fields, credential_revision, status::text
         FROM app.user_dataset_connections WHERE id = $1`,
        [IDS.connection]
      );
    });

    assert.deepEqual(result.rows, [{
      display_name: "Geospatial data",
      bucket_name: "example-geodata",
      region_name: "us-east-1",
      credential_mode: "assume_role",
      configured_secret_fields: [],
      credential_revision: 0,
      status: "unverified"
    }]);
  });

  it("keeps an unbound connection private and exposes it only through an explicit project binding", async () => {
    const beforeBinding = await inTenant(IDS.organization, IDS.collaborator, () =>
      db.query("SELECT id FROM app.user_dataset_connections")
    );
    assert.deepEqual(beforeBinding.rows, []);

    await inTenant(IDS.organization, IDS.owner, () => db.query(
      `INSERT INTO app.project_dataset_connection_bindings
        (id, organization_id, project_id, connection_id, display_name, created_by)
       VALUES ($1, $2, $3, $4, 'Shared geospatial data', $5)`,
      [IDS.binding, IDS.organization, IDS.project, IDS.connection, IDS.owner]
    ));

    const shared = await inTenant(IDS.organization, IDS.collaborator, () => db.query(
      "SELECT id, bucket_name FROM app.user_dataset_connections"
    ));
    assert.deepEqual(shared.rows, [{id: IDS.connection, bucket_name: "example-geodata"}]);
  });

  it("rotates opaque credential references optimistically without exposing secret values", async () => {
    const prepared = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT * FROM app.prepare_user_dataset_connection_credential_rotation($1)",
      [IDS.connection]
    ));
    assert.deepEqual(prepared.rows, [{
      credential_mode: "assume_role",
      current_secret_arn: null,
      credential_revision: 0
    }]);

    const committed = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.commit_user_dataset_connection_credential_rotation($1, 0, $2, ARRAY['external_id']) AS committed",
      [IDS.connection, SECRET_ARN]
    ));
    assert.equal(committed.rows[0].committed, true);

    const stale = await inTenant(IDS.organization, IDS.owner, () => db.query(
      "SELECT app.commit_user_dataset_connection_credential_rotation($1, 0, $2, ARRAY['external_id']) AS committed",
      [IDS.connection, SECRET_ARN]
    ));
    assert.equal(stale.rows[0].committed, false);

    await assert.rejects(
      inTenant(IDS.organization, IDS.owner, () =>
        db.query("SELECT secret_arn FROM app.user_dataset_connections WHERE id = $1", [IDS.connection])
      ),
      /permission denied/
    );
  });

  it("documents write-only secrets and excludes non-API runtimes", () => {
    assert.match(migration, /Credential values live only in Secrets Manager/i);
    assert.doesNotMatch(
      migration.match(/GRANT SELECT \([\s\S]*?\) ON app\.user_dataset_connections/)[0],
      /secret_arn/
    );
    assert.match(
      migration,
      /REVOKE ALL ON\s+app\.user_dataset_connections,\s+app\.project_dataset_connection_bindings\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
  });
});
