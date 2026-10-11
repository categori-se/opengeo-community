import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000064",
  owner: "20000000-0000-4000-8000-000000000064",
  other: "20000000-0000-4000-8000-000000000065",
  connection: "a0000000-0000-4000-8000-000000000064"
};

let db;
let migration;

async function verifier(sql, parameters = []) {
  await db.exec("SET ROLE opengeo_dataset_verifier");
  try {
    return await db.query(sql, parameters);
  } finally {
    await db.exec("RESET ROLE");
  }
}

describe("0064 isolated user dataset repository target", () => {
  before(async () => {
    db = new PGlite();
    const load = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const foundation = await load("0001_platform_foundation.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; "
      + "CREATE ROLE opengeo_observable_coordinator;"
    );
    await db.exec(await load("0050_team_project_access.sql"));
    await db.exec(await load("0051_user_dataset_connections.sql"));
    await db.exec(await load("0052_user_dataset_connection_verification.sql"));
    migration = await load("0064_user_dataset_repository_browser.sql");
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.owner}', 'owner-64', 'owner@example.test', 'Owner'),
        ('${IDS.other}', 'other-64', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES ('${IDS.organization}', 'OpenGeo Development', 'opengeo-development-64', '${IDS.owner}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organization}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organization}', '${IDS.other}', 'member', '${IDS.owner}');
      INSERT INTO app.user_dataset_connections
        (id, organization_id, owner_user_id, provider, display_name, bucket_name,
         region_name, object_prefix, credential_mode, role_arn, secret_arn,
         configured_secret_fields, credential_revision, status, last_verified_at)
      VALUES
        ('${IDS.connection}', '${IDS.organization}', '${IDS.owner}', 's3',
         'Geospatial data', 'example-geodata', 'us-east-1', 'usa/', 'assume_role',
         'arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader',
         'arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/user-connections/profile-AbCd12',
         ARRAY['external_id'], 1, 'verified', clock_timestamp());
    `);
  });

  after(async () => {
    await db.close();
  });

  it("returns only the exact current verified owner target", async () => {
    const exact = await verifier(
      "SELECT * FROM app.resolve_user_dataset_repository_target($1, $2, $3)",
      [IDS.organization, IDS.owner, IDS.connection]
    );
    assert.equal(exact.rows.length, 1);
    assert.equal(exact.rows[0].bucket_name, "example-geodata");
    assert.equal(exact.rows[0].object_prefix, "usa/");
    assert.equal(exact.rows[0].credential_mode, "assume_role");
    assert.equal(exact.rows[0].secret_arn.includes("user-connections"), true);

    const wrongOwner = await verifier(
      "SELECT * FROM app.resolve_user_dataset_repository_target($1, $2, $3)",
      [IDS.organization, IDS.other, IDS.connection]
    );
    assert.deepEqual(wrongOwner.rows, []);
  });

  it("fails closed immediately when the target leaves verified state", async () => {
    await db.query(
      "UPDATE app.user_dataset_connections SET status = 'disabled' WHERE id = $1",
      [IDS.connection]
    );
    const hidden = await verifier(
      "SELECT * FROM app.resolve_user_dataset_repository_target($1, $2, $3)",
      [IDS.organization, IDS.owner, IDS.connection]
    );
    assert.deepEqual(hidden.rows, []);
  });

  it("keeps the runtime function-only with no direct connection-table read", async () => {
    await assert.rejects(
      verifier("SELECT secret_arn FROM app.user_dataset_connections"),
      /permission denied/
    );
    assert.match(migration, /SECURITY DEFINER/);
    assert.match(migration, /connection\.status = 'verified'/);
    assert.doesNotMatch(migration, /GRANT SELECT .*user_dataset_connections/is);
  });
});
