import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, beforeEach, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000053",
  organizationB: "10000000-0000-4000-8000-000000000054",
  userA: "20000000-0000-4000-8000-000000000053",
  userA2: "20000000-0000-4000-8000-000000000055",
  userB: "20000000-0000-4000-8000-000000000054",
  projectA: "50000000-0000-4000-8000-000000000053",
  projectB: "50000000-0000-4000-8000-000000000054"
};

let db;
let migration;

async function tenant(organizationId, userId, operation) {
  await db.exec("SET ROLE opengeo_runtime; BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation();
    await db.exec("COMMIT; RESET ROLE");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK; RESET ROLE");
    throw error;
  }
}

function requestId(number) {
  return `a0000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

async function acquire(organizationId, userId, projectId, number) {
  const result = await tenant(organizationId, userId, () => db.query(
    "SELECT app.acquire_kml_network_link_request_slot($1, $2, $3) AS result",
    [requestId(number), projectId, userId]
  ));
  return result.rows[0].result;
}

async function release(organizationId, userId, projectId, number) {
  const result = await tenant(organizationId, userId, () => db.query(
    "SELECT app.release_kml_network_link_request_slot($1, $2, $3) AS released",
    [requestId(number), projectId, userId]
  ));
  return result.rows[0].released;
}

describe("0053 distributed KML NetworkLink request quota", () => {
  before(async () => {
    db = new PGlite();
    const load = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const foundation = await load("0001_platform_foundation.sql");
    const teams = await load("0050_team_project_access.sql");
    migration = await load("0053_kml_network_link_request_quota.sql");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec(
      "CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector; "
      + "CREATE ROLE opengeo_observable_coordinator; "
      + "CREATE ROLE opengeo_dataset_verifier;"
    );
    await db.exec(teams);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${IDS.userA}', 'quota-a', 'quota-a@example.test', 'Quota A'),
        ('${IDS.userA2}', 'quota-a2', 'quota-a2@example.test', 'Quota A2'),
        ('${IDS.userB}', 'quota-b', 'quota-b@example.test', 'Quota B');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${IDS.organizationA}', 'Quota A', 'quota-a-53', '${IDS.userA}'),
        ('${IDS.organizationB}', 'Quota B', 'quota-b-54', '${IDS.userB}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by) VALUES
        ('${IDS.organizationA}', '${IDS.userA}', 'admin', '${IDS.userA}'),
        ('${IDS.organizationA}', '${IDS.userA2}', 'member', '${IDS.userA}'),
        ('${IDS.organizationB}', '${IDS.userB}', 'admin', '${IDS.userB}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${IDS.projectA}', '${IDS.organizationA}', 'Quota project A', '${IDS.userA}'),
        ('${IDS.projectB}', '${IDS.organizationB}', 'Quota project B', '${IDS.userB}');
      INSERT INTO app.project_memberships
        (organization_id, project_id, user_id, role) VALUES
        ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.userA}', 'owner'),
        ('${IDS.organizationA}', '${IDS.projectA}', '${IDS.userA2}', 'viewer'),
        ('${IDS.organizationB}', '${IDS.projectB}', '${IDS.userB}', 'owner');
    `);
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM app.kml_network_link_request_slots");
  });

  after(async () => {
    await db.close();
  });

  it("acquires and idempotently releases one secret-free bounded lease", async () => {
    assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, 1), "acquired");
    assert.equal(await release(IDS.organizationA, IDS.userA, IDS.projectA, 1), true);
    assert.equal(await release(IDS.organizationA, IDS.userA, IDS.projectA, 1), true);

    const stored = await db.query(`
      SELECT organization_id, project_id, user_id,
             lease_expires_at <= started_at + interval '15 seconds' AS bounded,
             released_at IS NOT NULL AS released
      FROM app.kml_network_link_request_slots
    `);
    assert.deepEqual(stored.rows, [{
      organization_id: IDS.organizationA,
      project_id: IDS.projectA,
      user_id: IDS.userA,
      bounded: true,
      released: true
    }]);
    const columns = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'kml_network_link_request_slots'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(columns.rows.map(({column_name}) => column_name), [
      "request_id",
      "organization_id",
      "project_id",
      "user_id",
      "started_at",
      "lease_expires_at",
      "released_at"
    ]);
  });

  it("enforces four active requests per user and project", async () => {
    for (let index = 1; index <= 4; index += 1) {
      assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, index), "acquired");
    }
    assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, 5), "busy");
  });

  it("enforces eight active requests across tenants", async () => {
    for (let index = 1; index <= 4; index += 1) {
      assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, index), "acquired");
      assert.equal(await acquire(IDS.organizationB, IDS.userB, IDS.projectB, index + 10), "acquired");
    }
    assert.equal(await acquire(IDS.organizationA, IDS.userA2, IDS.projectA, 30), "busy");
  });

  it("counts released attempts toward the fixed rolling-minute rate", async () => {
    for (let index = 1; index <= 60; index += 1) {
      assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, index), "acquired");
      assert.equal(await release(IDS.organizationA, IDS.userA, IDS.projectA, index), true);
    }
    assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, 61), "rate_limited");
  });

  it("recovers an expired lease and rejects cross-tenant or unbound access", async () => {
    for (let index = 1; index <= 4; index += 1) {
      assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, index), "acquired");
    }
    await db.exec(`
      UPDATE app.kml_network_link_request_slots
      SET started_at = clock_timestamp() - interval '20 seconds',
          lease_expires_at = clock_timestamp() - interval '5 seconds'
    `);
    assert.equal(await acquire(IDS.organizationA, IDS.userA, IDS.projectA, 5), "acquired");

    await assert.rejects(
      tenant(IDS.organizationB, IDS.userB, () => db.query(
        "SELECT app.acquire_kml_network_link_request_slot($1, $2, $3)",
        [requestId(99), IDS.projectA, IDS.userB]
      )),
      /access denied/
    );
  });

  it("exposes only the two fixed functions to the runtime role", async () => {
    await assert.rejects(
      tenant(IDS.organizationA, IDS.userA, () =>
        db.query("SELECT request_id FROM app.kml_network_link_request_slots")
      ),
      /permission denied/
    );
    assert.match(migration, /60\/minute, four-per-user\/project, and eight-platform-wide/);
  });
});
