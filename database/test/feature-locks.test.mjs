import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";

import {PGlite} from "@electric-sql/pglite";

const IDS = {
  organizationA: "10000000-0000-4000-8000-000000000076",
  organizationB: "10000000-0000-4000-8000-000000000077",
  owner: "20000000-0000-4000-8000-000000000076",
  colleague: "20000000-0000-4000-8000-000000000077",
  otherTenant: "20000000-0000-4000-8000-000000000078",
  datasetA: "80000000-0000-4000-8000-000000000076",
  datasetB: "80000000-0000-4000-8000-000000000077",
  featureA: "90000000-0000-4000-8000-000000000076",
  featureB: "90000000-0000-4000-8000-000000000077",
  tokenA: "a0000000-0000-4000-8000-000000000076",
  tokenB: "a0000000-0000-4000-8000-000000000077"
};

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

async function insertLock({
  organizationId = IDS.organizationA,
  datasetId = IDS.datasetA,
  featureId = IDS.featureA,
  featureVersion = 1,
  token = IDS.tokenA,
  userId = IDS.owner,
  lease = "2 minutes"
} = {}) {
  return inTenant(organizationId, userId, () => db.query(
    `INSERT INTO app.dataset_feature_locks
       (organization_id, dataset_id, feature_id, feature_version,
        lock_token, locked_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + $7::interval)
     RETURNING feature_id, feature_version, lock_token, locked_by`,
    [organizationId, datasetId, featureId, featureVersion, token, userId, lease]
  ));
}

describe("0076 short-lived feature locks migration", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readFile(
      new URL("../migrations/0001_platform_foundation.sql", import.meta.url),
      "utf8"
    );
    migration = await readFile(
      new URL("../migrations/0076_short_lived_feature_locks.sql", import.meta.url),
      "utf8"
    );
    await db.exec(foundation.replace(
      /^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm,
      ""
    ));
    await db.exec(`
      CREATE ROLE opengeo_worker;
      CREATE ROLE opengeo_connector;
      CREATE ROLE opengeo_observable_coordinator;
      CREATE TABLE app.dataset_features (
        id uuid NOT NULL,
        organization_id uuid NOT NULL REFERENCES app.organizations(id),
        dataset_id uuid NOT NULL,
        version_number bigint NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        PRIMARY KEY (organization_id, dataset_id, id)
      );
    `);
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users (id, cognito_subject, email, display_name)
      VALUES
        ('${IDS.owner}', 'lock-owner', 'owner@example.test', 'Owner'),
        ('${IDS.colleague}', 'lock-colleague', 'colleague@example.test', 'Colleague'),
        ('${IDS.otherTenant}', 'lock-other', 'other@example.test', 'Other');
      INSERT INTO app.organizations (id, name, slug, created_by)
      VALUES
        ('${IDS.organizationA}', 'Organization A', 'locks-a', '${IDS.owner}'),
        ('${IDS.organizationB}', 'Organization B', 'locks-b', '${IDS.otherTenant}');
      INSERT INTO app.organization_memberships
        (organization_id, user_id, role, invited_by)
      VALUES
        ('${IDS.organizationA}', '${IDS.owner}', 'admin', '${IDS.owner}'),
        ('${IDS.organizationA}', '${IDS.colleague}', 'member', '${IDS.owner}'),
        ('${IDS.organizationB}', '${IDS.otherTenant}', 'admin', '${IDS.otherTenant}');
      INSERT INTO app.dataset_features
        (id, organization_id, dataset_id, version_number)
      VALUES
        ('${IDS.featureA}', '${IDS.organizationA}', '${IDS.datasetA}', 1),
        ('${IDS.featureB}', '${IDS.organizationB}', '${IDS.datasetB}', 3);
      SET ROLE opengeo_runtime;
    `);
    await insertLock();
    await insertLock({
      organizationId: IDS.organizationB,
      datasetId: IDS.datasetB,
      featureId: IDS.featureB,
      featureVersion: 3,
      token: IDS.tokenB,
      userId: IDS.otherTenant
    });
  });

  after(async () => {
    await db.exec("RESET ROLE");
    await db.close();
  });

  it("keeps one exact feature lease tenant-isolated and version-bound", async () => {
    const visible = await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      `SELECT feature_id, feature_version, lock_token, locked_by
       FROM app.dataset_feature_locks ORDER BY feature_id`
    ));
    assert.deepEqual(visible.rows, [{
      feature_id: IDS.featureA,
      feature_version: 1,
      lock_token: IDS.tokenA,
      locked_by: IDS.owner
    }]);
    await assert.rejects(insertLock(), /duplicate key|unique constraint/);
  });

  it("bounds positive versions and every lease interval to five minutes", async () => {
    await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      "DELETE FROM app.dataset_feature_locks WHERE feature_id = $1",
      [IDS.featureA]
    ));
    await assert.rejects(
      insertLock({featureVersion: 0}),
      /dataset_feature_locks_version_positive|check constraint/
    );
    await assert.rejects(
      insertLock({lease: "6 minutes"}),
      /dataset_feature_locks_duration_bounded|check constraint/
    );
    await insertLock();
  });

  it("prevents active takeover but permits deterministic expired takeover", async () => {
    const activeTakeover = await inTenant(
      IDS.organizationA,
      IDS.colleague,
      () => db.query(
        `UPDATE app.dataset_feature_locks
         SET lock_token = $2, locked_by = $3
         WHERE feature_id = $1
         RETURNING feature_id`,
        [IDS.featureA, IDS.tokenB, IDS.colleague]
      )
    );
    assert.deepEqual(activeTakeover.rows, []);

    await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      `UPDATE app.dataset_feature_locks
       SET acquired_at = clock_timestamp() - interval '6 minutes',
           expires_at = clock_timestamp() - interval '2 minutes'
       WHERE feature_id = $1`,
      [IDS.featureA]
    ));
    const takeover = await inTenant(IDS.organizationA, IDS.colleague, () => db.query(
      `INSERT INTO app.dataset_feature_locks
         (organization_id, dataset_id, feature_id, feature_version,
          lock_token, locked_by, expires_at)
       VALUES ($1, $2, $3, 1, $4, $5, clock_timestamp() + interval '2 minutes')
       ON CONFLICT (organization_id, dataset_id, feature_id)
       DO UPDATE SET lock_token = EXCLUDED.lock_token,
                     locked_by = EXCLUDED.locked_by,
                     acquired_at = EXCLUDED.acquired_at,
                     expires_at = EXCLUDED.expires_at
       WHERE dataset_feature_locks.expires_at <= clock_timestamp()
       RETURNING lock_token, locked_by`,
      [IDS.organizationA, IDS.datasetA, IDS.featureA, IDS.tokenB, IDS.colleague]
    ));
    assert.deepEqual(takeover.rows, [{lock_token: IDS.tokenB, locked_by: IDS.colleague}]);
  });

  it("allows only the holder or an expiry cleanup to delete a lease", async () => {
    const denied = await inTenant(IDS.organizationA, IDS.owner, () => db.query(
      `DELETE FROM app.dataset_feature_locks
       WHERE feature_id = $1 RETURNING feature_id`,
      [IDS.featureA]
    ));
    assert.deepEqual(denied.rows, []);
    const released = await inTenant(IDS.organizationA, IDS.colleague, () => db.query(
      `DELETE FROM app.dataset_feature_locks
       WHERE feature_id = $1 RETURNING feature_id`,
      [IDS.featureA]
    ));
    assert.deepEqual(released.rows, [{feature_id: IDS.featureA}]);
  });

  it("keeps lease rows unavailable to non-API runtimes", async () => {
    assert.match(migration, /FORCE ROW LEVEL SECURITY/);
    assert.match(migration, /expires_at <= clock_timestamp\(\)/);
    assert.match(
      migration,
      /REVOKE ALL ON app\.dataset_feature_locks\s+FROM opengeo_worker, opengeo_connector, opengeo_observable_coordinator/
    );
    await db.exec("RESET ROLE; SET ROLE opengeo_worker");
    try {
      await assert.rejects(
        db.query("SELECT * FROM app.dataset_feature_locks"),
        /permission denied/
      );
    } finally {
      await db.exec("RESET ROLE; SET ROLE opengeo_runtime");
    }
  });
});
