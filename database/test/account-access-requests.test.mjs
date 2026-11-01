import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, beforeEach, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const owner = "20000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
const organization = "10000000-0000-4000-8000-000000000001";
let db;

async function runtime(user, operation) {
  await db.exec("SET ROLE opengeo_runtime; BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [organization, user]);
    const result = await operation();
    await db.exec("COMMIT; RESET ROLE");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK; RESET ROLE");
    throw error;
  }
}

async function submit(email = "request@example.test", fingerprint = "a".repeat(64)) {
  return runtime("00000000-0000-0000-0000-000000000000", async () => {
    const result = await db.query("SELECT app.submit_account_access_request($1,$2,$3,$4,$5,$6) AS result",
      [organization, owner, email, "Requested Person", "A regional geospatial analysis.", fingerprint]);
    return result.rows[0].result;
  });
}

describe("0180 account access requests", () => {
  before(async () => {
    db = new PGlite();
    const load = name => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await db.exec((await load("0001_platform_foundation.sql"))
      .replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    await db.exec("CREATE ROLE opengeo_worker");
    await db.exec(await load("0002_membership_invitations.sql"));
    await db.exec(await load("0180_account_access_requests.sql"));
    await db.exec(`INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES
      ('${owner}','owner','owner@example.test','Owner'),
      ('${other}','other','other@example.test','Other');
      INSERT INTO app.organizations(id,name,slug,created_by)
        VALUES ('${organization}','Account','account','${owner}');
      INSERT INTO app.organization_memberships(organization_id,user_id,role)
        VALUES ('${organization}','${owner}','admin'),('${organization}','${other}','admin');`);
  });
  beforeEach(async () => {await db.exec("DELETE FROM app.account_access_requests; DELETE FROM app.account_request_rate_limits");});
  after(async () => {await db.close();});

  it("registers anonymous requests without creating identities, memberships or invitations", async () => {
    assert.equal(await submit(), "pending");
    const result = await db.query(`SELECT (SELECT count(*) FROM app.users)::int AS users,
      (SELECT count(*) FROM app.organization_memberships)::int AS memberships,
      (SELECT count(*) FROM app.membership_invitations)::int AS invitations,
      (SELECT count(*) FROM app.account_access_requests WHERE state='pending')::int AS requests`);
    assert.deepEqual(result.rows, [{users: 2, memberships: 2, invitations: 0, requests: 1}]);
  });

  it("counts duplicate attempts before deduplication and resets the bounded hour window", async () => {
    for (let index = 0; index < 5; index++) assert.equal(await submit(), "pending");
    assert.equal(await submit(), "rate_limited");
    assert.equal(await submit("different@example.test"), "rate_limited");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM app.account_access_requests")).rows[0].count, 1);
    await db.exec("UPDATE app.account_request_rate_limits SET window_started_at = clock_timestamp() - interval '61 minutes'");
    assert.equal(await submit("different@example.test"), "pending");
    assert.equal((await db.query("SELECT attempts FROM app.account_request_rate_limits")).rows[0].attempts, 1);
  });

  it("exposes the request only to its designated reviewer, including among account admins", async () => {
    await submit();
    assert.equal((await runtime(owner, () => db.query("SELECT * FROM app.account_access_requests"))).rows.length, 1);
    assert.equal((await runtime(other, () => db.query("SELECT * FROM app.account_access_requests"))).rows.length, 0);
    assert.equal((await runtime(other, () => db.query("UPDATE app.account_access_requests SET state='rejected',reviewed_at=clock_timestamp() RETURNING id"))).rows.length, 0);
    await db.exec(`UPDATE app.organization_memberships SET role='member' WHERE user_id='${owner}'`);
    try {
      assert.equal((await runtime(owner, () => db.query("SELECT * FROM app.account_access_requests"))).rows.length, 0);
      assert.equal(await submit("second@example.test"), "unavailable");
    } finally {
      await db.exec(`UPDATE app.organization_memberships SET role='admin' WHERE user_id='${owner}'`);
    }
  });

  it("prevents ordinary runtime writes and direct access to private quota state", async () => {
    await assert.rejects(runtime(owner, () => db.query("INSERT INTO app.account_access_requests DEFAULT VALUES")), /permission denied/);
    await assert.rejects(runtime(owner, () => db.query("SELECT * FROM app.account_request_rate_limits")), /permission denied/);
    await db.exec("SET ROLE opengeo_worker");
    try {await assert.rejects(db.query("SELECT * FROM app.account_access_requests"), /permission denied/);}
    finally {await db.exec("RESET ROLE");}
  });
});
