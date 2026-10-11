import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000052",
  owner: "20000000-0000-4000-8000-000000000052",
  project: "50000000-0000-4000-8000-000000000052",
  connection: "a0000000-0000-4000-8000-000000000052",
  worker: "b0000000-0000-4000-8000-000000000052"
};

let db;
let migration;

async function tenant(operation) {
  await db.exec("SET ROLE opengeo_runtime; BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [IDS.owner]);
    const result = await operation();
    await db.exec("COMMIT; RESET ROLE");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK; RESET ROLE");
    throw error;
  }
}

async function verifier(sql, parameters) {
  await db.exec("SET ROLE opengeo_dataset_verifier");
  try {
    return await db.query(sql, parameters);
  } finally {
    await db.exec("RESET ROLE");
  }
}

describe("0052 user dataset connection verification migration", () => {
  before(async () => {
    db = new PGlite();
    const load = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const foundation = await load("0001_platform_foundation.sql");
    const teams = await load("0050_team_project_access.sql");
    const connections = await load("0051_user_dataset_connections.sql");
    migration = await load("0052_user_dataset_connection_verification.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; "
      + "CREATE ROLE opengeo_observable_coordinator;"
    );
    await db.exec(teams);
    await db.exec(connections);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES ('${IDS.owner}', 'owner-52', 'owner@example.test', 'Owner');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'OpenGeo Development', 'opengeo-development-52', '${IDS.owner}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by)
      VALUES ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}');
      INSERT INTO app.projects (id, organization_id, name, created_by)
      VALUES ('${IDS.project}', '${IDS.organization}', 'Dataset verification', '${IDS.owner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
      VALUES ('${IDS.organization}', '${IDS.project}', '${IDS.owner}', 'owner');
      INSERT INTO app.user_dataset_connections
        (id, organization_id, owner_user_id, provider, display_name, bucket_name,
         region_name, object_prefix, credential_mode, role_arn, secret_arn,
         configured_secret_fields, credential_revision, status)
      VALUES
        ('${IDS.connection}', '${IDS.organization}', '${IDS.owner}', 's3',
         'Geospatial data', 'example-geodata', 'us-east-1', '', 'assume_role',
         'arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader',
         'arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/user-connections/profile-AbCd12',
         ARRAY['external_id'], 1, 'unverified');
    `);
  });

  after(async () => {
    await db.close();
  });

  it("leases only an idempotent owner-requested attempt and persists no object key", async () => {
    const first = await tenant(() => db.query(
      "SELECT * FROM app.request_user_dataset_connection_verification($1, $2, 'request-52')",
      [IDS.connection, IDS.owner]
    ));
    const second = await tenant(() => db.query(
      "SELECT * FROM app.request_user_dataset_connection_verification($1, $2, 'request-52-repeat')",
      [IDS.connection, IDS.owner]
    ));
    assert.equal(first.rows[0].created, true);
    assert.deepEqual(second.rows, [{verification_id: first.rows[0].verification_id, created: false}]);

    const claim = await verifier(
      "SELECT * FROM app.claim_user_dataset_connection_verification($1, $2, 30)",
      [first.rows[0].verification_id, IDS.worker]
    );
    assert.equal(claim.rows[0].claim_status, "claimed");
    assert.equal(claim.rows[0].bucket_name, "example-geodata");
    assert.equal(claim.rows[0].credential_mode, "assume_role");
    assert.equal(claim.rows[0].attempt_count, 1);
    assert.doesNotMatch(migration, /object_key|sample_key/i);
  });

  it("requires all positive and negative probes before marking the current revision verified", async () => {
    const active = await tenant(() => db.query(
      "SELECT id FROM app.user_dataset_connection_verifications WHERE connection_id = $1",
      [IDS.connection]
    ));
    const verificationId = active.rows[0].id;
    const completion = await verifier(
      `SELECT app.complete_user_dataset_connection_verification(
         $1, $2, true, true, true, 1, NULL, 125
       ) AS completed`,
      [verificationId, IDS.worker]
    );
    assert.equal(completion.rows[0].completed, true);

    const state = await tenant(() => db.query(
      `SELECT connection.status::text, connection.last_verified_at IS NOT NULL AS verified_at,
              verification.state::text, verification.bucket_access_confirmed,
              verification.object_access_confirmed, verification.deny_canaries_confirmed,
              verification.objects_observed
       FROM app.user_dataset_connections connection
       JOIN app.user_dataset_connection_verifications verification
         ON verification.connection_id = connection.id
       WHERE connection.id = $1`,
      [IDS.connection]
    ));
    assert.deepEqual(state.rows, [{
      status: "verified",
      verified_at: true,
      state: "succeeded",
      bucket_access_confirmed: true,
      object_access_confirmed: true,
      deny_canaries_confirmed: true,
      objects_observed: 1
    }]);
  });

  it("invalidates verified state and target revision when the target changes", async () => {
    const changed = await tenant(() => db.query(
      `UPDATE app.user_dataset_connections SET object_prefix = 'nepal/'
       WHERE id = $1 RETURNING status::text, last_verified_at`,
      [IDS.connection]
    ));
    assert.deepEqual(changed.rows, [{
      status: "unverified",
      last_verified_at: null
    }]);
    const revision = await db.query(
      "SELECT target_revision FROM app.user_dataset_connections WHERE id = $1",
      [IDS.connection]
    );
    assert.equal(revision.rows[0].target_revision, 2);
  });

  it("gives the verifier fixed functions but no table reads", async () => {
    await assert.rejects(
      verifier("SELECT id FROM app.user_dataset_connections", []),
      /permission denied/
    );
    assert.match(migration, /object keys and credentials are never persisted/i);
    assert.doesNotMatch(
      migration.match(/GRANT SELECT \([\s\S]*?\) ON app\.user_dataset_connection_verifications/)[0],
      /worker_token|lease_expires_at/
    );
  });
});
