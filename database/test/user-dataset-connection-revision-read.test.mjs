import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const org = "10000000-0000-4000-8000-000000000083";
const owner = "20000000-0000-4000-8000-000000000083";
const collaborator = "20000000-0000-4000-8000-000000000084";
const otherOrg = "10000000-0000-4000-8000-000000000084";
const project = "50000000-0000-4000-8000-000000000083";
const connection = "a0000000-0000-4000-8000-000000000083";
let db, migration, columns, returning;

async function tenant(actor, operation, organization = org) {
  await db.exec("SET ROLE opengeo_runtime; BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [actor]);
    const result = await operation();
    await db.exec("COMMIT; RESET ROLE");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK; RESET ROLE");
    throw error;
  }
}

const list = () => db.query(`SELECT ${columns} FROM app.user_dataset_connections connection`);

describe("0083 runtime connection revision projection", () => {
  before(async () => {
    db = new PGlite();
    const load = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const source = await readFile(new URL("../../services/api/src/opengeo_api/user_connections.py", import.meta.url), "utf8");
    // Use the actual API projections: checking a smaller column subset missed this defect.
    const read = source.match(/def _connection_columns\(alias: str\) -> str:\s+return f"""([\s\S]*?)"""/);
    const write = source.match(/def _connection_returning\(\) -> str:\s+return """([\s\S]*?)"""/);
    assert.ok(read); assert.ok(write);
    columns = read[1].replaceAll("{alias}", "connection");
    returning = write[1];
    await db.exec((await load("0001_platform_foundation.sql")).replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec("CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; CREATE ROLE opengeo_observable_coordinator;");
    for (const name of ["0050_team_project_access.sql", "0051_user_dataset_connections.sql", "0052_user_dataset_connection_verification.sql"]) await db.exec(await load(name));
    migration = await load("0083_user_dataset_connection_revision_read.sql");
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${owner}', 'owner-83', 'owner@local.invalid', 'Owner'),
        ('${collaborator}', 'collaborator-83', 'collaborator@local.invalid', 'Collaborator');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${org}', 'Connection project', 'connection-project-83', '${owner}'),
        ('${otherOrg}', 'Other organization', 'other-organization-83', '${owner}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES
        ('${org}', '${owner}', 'admin', '${owner}'),
        ('${org}', '${collaborator}', 'member', '${owner}'),
        ('${otherOrg}', '${owner}', 'admin', '${owner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
        VALUES ('${project}', '${org}', 'Source review', '${owner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role) VALUES
        ('${org}', '${project}', '${owner}', 'owner'),
        ('${org}', '${project}', '${collaborator}', 'viewer');
    `);
  });
  after(async () => { await db.close(); });

  it("reproduces an empty-list denial then repairs the exact API projection", async () => {
    await assert.rejects(tenant(owner, list), /permission denied for table user_dataset_connections/);
    await db.exec(migration);
    assert.deepEqual((await tenant(owner, list)).rows, []);
    const rights = await db.query(`SELECT
      has_column_privilege('opengeo_runtime', 'app.user_dataset_connections', 'target_revision', 'SELECT') AS revision_read,
      has_column_privilege('opengeo_runtime', 'app.user_dataset_connections', 'target_revision', 'UPDATE') AS revision_write,
      has_column_privilege('opengeo_runtime', 'app.user_dataset_connections', 'secret_arn', 'SELECT') AS secret_read,
      has_table_privilege('opengeo_runtime', 'app.user_dataset_connections', 'SELECT') AS table_read`);
    assert.deepEqual(rights.rows, [{revision_read: true, revision_write: false, secret_read: false, table_read: false}]);
  });
  it("returns trigger-maintained revisions on source creation, read and update", async () => {
    const created = await tenant(owner, () => db.query(`
      INSERT INTO app.user_dataset_connections
        (id, organization_id, owner_user_id, provider, display_name, bucket_name,
         region_name, object_prefix, credential_mode, role_arn, status)
      VALUES ($1, $2, $3, 's3', 'Reviewed source', 'local-pilot.invalid',
        'us-east-1', '', 'assume_role', 'arn:aws:iam::123456789012:role/LocalSourceReader', 'unverified')
      RETURNING ${returning}`, [connection, org, owner]));
    assert.equal(Number(created.rows[0].target_revision), 1);
    assert.deepEqual((await tenant(owner, list)).rows, created.rows);
    const changed = await tenant(owner, () => db.query(`UPDATE app.user_dataset_connections
      SET object_prefix = 'reviewed/' WHERE id = $1 RETURNING ${returning}`, [connection]));
    assert.equal(Number(changed.rows[0].target_revision), 2);
    assert.deepEqual((await tenant(owner, list)).rows, changed.rows);
  });
  it("preserves private sources, explicit project binding and tenant isolation", async () => {
    assert.deepEqual((await tenant(collaborator, list)).rows, []);
    await tenant(owner, () => db.query(`INSERT INTO app.project_dataset_connection_bindings
      (organization_id, project_id, connection_id, display_name, created_by)
      VALUES ($1, $2, $3, 'Reviewed source', $4)`, [org, project, connection, owner]));
    const bound = await tenant(collaborator, () => db.query(`SELECT ${columns}
      FROM app.project_dataset_connection_bindings binding
      JOIN app.user_dataset_connections connection ON connection.organization_id = binding.organization_id
        AND connection.id = binding.connection_id WHERE binding.project_id = $1`, [project]));
    assert.equal(bound.rows.length, 1);
    assert.equal(Number(bound.rows[0].target_revision), 2);
    assert.deepEqual((await tenant(owner, list, otherOrg)).rows, []);
  });
  it("denies broad and secret reads, direct revision writes and worker table reads", async () => {
    for (const sql of ["SELECT secret_arn FROM app.user_dataset_connections", "SELECT * FROM app.user_dataset_connections", "UPDATE app.user_dataset_connections SET target_revision = 100", "UPDATE app.user_dataset_connections SET credential_revision = 100"])
      await assert.rejects(tenant(owner, () => db.query(sql)), /permission denied/);
    for (const role of ["opengeo_worker", "opengeo_connector", "opengeo_observable_coordinator", "opengeo_dataset_verifier"]) {
      await db.exec(`SET ROLE ${role}`);
      try { await assert.rejects(db.query("SELECT target_revision FROM app.user_dataset_connections"), /permission denied/); }
      finally { await db.exec("RESET ROLE"); }
    }
  });
});
