import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const id = (prefix, suffix) => `${prefix}000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = {
  org: id("10", 170), otherOrg: id("10", 171), owner: id("20", 170),
  editor: id("20", 171), admin: id("20", 172), teamOwner: id("20", 173),
  outsider: id("20", 174), project: id("50", 170), otherProject: id("50", 171),
  connection: id("70", 170), unverified: id("70", 171), team: id("90", 170),
  token: id("80", 170), otherToken: id("80", 171)
};
const secretArn = `arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/${ID.org}/${ID.connection}-AbCd12`;
const column = (name = "id") => ({
  name, type_schema: "pg_catalog", type_name: "int8", not_null: true,
  type_modifier: -1, geometry: null, unique_key: true, primary_key: true
});
const relation = (name = "roads", schema = "public") => ({
  schema, name, kind: "r", columns: [column()], stable_key: "id",
  unsupported_reasons: ["geometry_unavailable"], schema_fingerprint_sha256: "a".repeat(64)
});
const catalog = (relations = [relation()]) => ({
  schemaVersion: "opengeo.postgis-catalog.1.0.0", relations, truncated: false
});
let db;
let successId;

async function role(name) {
  await db.exec(`RESET ROLE; SET ROLE ${name}`);
}
async function runtime(user, operation, organization = ID.org) {
  await role("opengeo_runtime");
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id', $1, true)", [organization]);
    await db.query("SELECT set_config('app.user_id', $1, true)", [user]);
    const result = await operation();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
async function request(key, user = ID.owner, revision = 1, connection = ID.connection) {
  const result = await runtime(user, () => db.query(
    "SELECT app.request_external_connection_catalog_discovery($1, $2, $3) AS id",
    [connection, revision, key]));
  return result.rows[0].id;
}
async function claim(job, token = ID.token) {
  await role("opengeo_connector");
  return (await db.query(
    "SELECT * FROM app.claim_external_connection_catalog_discovery($1, $2, 20)",
    [job, token])).rows[0];
}
async function complete(job, value = catalog(), error = null, token = ID.token) {
  await role("opengeo_connector");
  return (await db.query(
    "SELECT app.complete_external_connection_catalog_discovery($1, $2, $3, $4) AS done",
    [job, token, value === null ? null : JSON.stringify(value), error])).rows[0].done;
}
async function cancel(job, user = ID.owner) {
  return (await runtime(user, () => db.query(
    "SELECT app.cancel_external_connection_catalog_discovery($1) AS done", [job]))).rows[0].done;
}
async function privileged(sql, parameters = []) {
  await db.exec("RESET ROLE");
  return db.query(sql, parameters);
}
async function jobRow(job) {
  return (await runtime(ID.owner, () => db.query(
    `SELECT state, attempt_count, relation_count, truncated, sanitized_error_code,
      worker_token, lease_expires_at FROM app.external_connection_catalog_discoveries WHERE id = $1`,
    [job]))).rows[0];
}

describe("0170 revision-pinned external PostGIS catalog discovery", {concurrency: false}, () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql", "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql", "0004_worker_execution_boundary.sql",
      "0047_governed_external_connections.sql", "0048_external_connection_verification.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec("CREATE ROLE opengeo_observable_coordinator");
    for (const file of ["0050_team_project_access.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    // Reuse the deployed background-authority helper without loading unrelated
    // GitHub/publisher functions that 0101 subsequently retrofits.
    const authority = await readFile(new URL("../migrations/0101_background_project_authority.sql", import.meta.url), "utf8");
    await db.exec(authority.slice(authority.indexOf("CREATE FUNCTION app.background_project_role("),
      authority.indexOf("\nREVOKE ALL ON FUNCTION app.background_project_role(")));
    await db.exec(await readFile(new URL("../migrations/0170_external_connection_catalog_discovery.sql", import.meta.url), "utf8"));
    for (const [name, user] of Object.entries({owner: ID.owner, editor: ID.editor,
      admin: ID.admin, teamOwner: ID.teamOwner, outsider: ID.outsider})) {
      await db.query("INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES ($1,$2,$3,$2)",
        [user, `catalog-${name}`, `${name.toLowerCase()}@example.test`]);
    }
    await db.exec(`
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${ID.org}', 'Catalog', 'catalog', '${ID.owner}'),
        ('${ID.otherOrg}', 'Other', 'catalog-other', '${ID.outsider}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES
        ('${ID.org}', '${ID.owner}', 'member', '${ID.owner}'),
        ('${ID.org}', '${ID.editor}', 'member', '${ID.owner}'),
        ('${ID.org}', '${ID.admin}', 'admin', '${ID.owner}'),
        ('${ID.org}', '${ID.teamOwner}', 'member', '${ID.owner}'),
        ('${ID.org}', '${ID.outsider}', 'member', '${ID.owner}'),
        ('${ID.otherOrg}', '${ID.outsider}', 'admin', '${ID.outsider}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${ID.project}', '${ID.org}', 'Catalog project', '${ID.owner}'),
        ('${ID.otherProject}', '${ID.org}', 'Other project', '${ID.owner}');
      INSERT INTO app.project_memberships (organization_id, project_id, user_id, role) VALUES
        ('${ID.org}', '${ID.project}', '${ID.owner}', 'owner'),
        ('${ID.org}', '${ID.project}', '${ID.editor}', 'editor'),
        ('${ID.org}', '${ID.otherProject}', '${ID.outsider}', 'owner');
      INSERT INTO app.teams (id, organization_id, name, created_by)
        VALUES ('${ID.team}', '${ID.org}', 'Catalog owners', '${ID.owner}');
      INSERT INTO app.team_memberships (organization_id, team_id, user_id, role, created_by)
        VALUES ('${ID.org}', '${ID.team}', '${ID.teamOwner}', 'member', '${ID.owner}');
      INSERT INTO app.project_team_grants (organization_id, project_id, team_id, role, created_by)
        VALUES ('${ID.org}', '${ID.project}', '${ID.team}', 'owner', '${ID.owner}');
    `);
    for (const connection of [ID.connection, ID.unverified]) {
      await db.query(`INSERT INTO app.external_connections
        (id,organization_id,project_id,provider,display_name,endpoint_host,database_name,
        allowed_schemas,secret_arn,configured_secret_fields,created_by,updated_by)
        VALUES ($1,$2,$3,'postgresql','Warehouse','gis.example.test','research',
          ARRAY['public','Research'],$4,ARRAY['password','username'],$5,$5)`,
      [connection, ID.org, ID.project, secretArn, ID.owner]);
      await db.query(`INSERT INTO app.external_connection_revisions
        (organization_id,project_id,connection_id,revision_number,configuration,change_summary,created_by)
        SELECT organization_id,project_id,id,1,jsonb_build_object('provider',provider::text,
          'endpointHost',endpoint_host,'endpointPort',endpoint_port,'databaseName',database_name,
          'allowedSchemas',to_jsonb(allowed_schemas),'readOnly',read_only,'tlsMode',tls_mode::text,
          'networkMode',network_mode::text),'Initial',$2 FROM app.external_connections WHERE id=$1`,
      [connection, ID.owner]);
    }
    await db.query(`UPDATE app.external_connections SET status='credentials_verified',
      last_verified_at=clock_timestamp() WHERE id=$1`, [ID.connection]);
  });
  after(async () => { await db.exec("RESET ROLE"); await db.close(); });

  it("requires verified owner/admin authority, preserves request keys and rejects competing active requests", async () => {
    await assert.rejects(request("denied", ID.editor), /manage authority/);
    await assert.rejects(request("denied", ID.outsider), /manage authority/);
    await assert.rejects(request("unverified", ID.owner, 1, ID.unverified), /not catalog discoverable/);
    await assert.rejects(request("wrong-revision", ID.owner, 2), /revision conflict/);
    const first = await request("deliberate-request");
    assert.equal(await request("deliberate-request"), first);
    await assert.rejects(request("page-refresh", ID.admin), (error) => error.code === "23505");
    assert.equal(await request("deliberate-request", ID.teamOwner), first);
    await assert.rejects(runtime(ID.outsider, () => db.query(
      "SELECT app.request_external_connection_catalog_discovery($1,1,'other-tenant')", [ID.connection]),
    ID.otherOrg), /not found/);
    assert.equal(await cancel(first, ID.admin), true);
    assert.equal(await request("deliberate-request"), first);
    await assert.rejects(request("deliberate-request", ID.owner, 2), /request key revision conflict/);
  });

  it("exposes secret references only on connector claims and persists paged immutable descriptors", async () => {
    successId = await request("successful-catalog");
    await assert.rejects(runtime(ID.owner, () => db.query(
      "SELECT * FROM app.claim_external_connection_catalog_discovery($1,$2,20)", [successId, ID.token])),
    /permission denied/);
    await assert.rejects(runtime(ID.owner, () => db.query(
      "SELECT secret_arn FROM app.external_connections WHERE id=$1", [ID.connection])), /permission denied/);
    await role("opengeo_worker");
    await assert.rejects(db.query("SELECT * FROM app.claim_external_connection_catalog_discovery($1,$2,20)",
      [successId, ID.token]), /permission denied/);
    const claimed = await claim(successId);
    assert.equal(claimed.claim_status, "claimed");
    assert.equal(claimed.secret_arn, secretArn);
    assert.deepEqual(claimed.allowed_schemas, ["public", "Research"]);
    assert.equal(claimed.connection_revision_number, 1);
    assert.equal((await claim(successId, ID.otherToken)).claim_status, "busy");
    assert.equal((await claim(successId, ID.otherToken)).secret_arn, null);
    await assert.rejects(db.query("SELECT * FROM app.external_connection_catalog_relations"), /permission denied/);
    await assert.rejects(db.query("SELECT secret_arn FROM app.external_connections"), /permission denied/);
    const result = catalog([relation(), relation("Parcels", "Research")]);
    result.truncated = true;
    assert.equal(await complete(successId, result), true);
    assert.equal(await complete(successId, result), false);
    assert.equal(await request("successful-catalog"), successId);
    const rows = (await runtime(ID.editor, () => db.query(
      `SELECT ordinal,descriptor FROM app.external_connection_catalog_relations
        WHERE discovery_id=$1 AND ordinal>0 ORDER BY ordinal LIMIT 10`, [successId]))).rows;
    assert.deepEqual(rows, result.relations.map((descriptor, index) => ({ordinal: index + 1, descriptor})));
    assert.deepEqual(await jobRow(successId), {state: "completed", attempt_count: 1,
      relation_count: 2, truncated: true, sanitized_error_code: null, worker_token: null, lease_expires_at: null});
    for (const sql of [
      "UPDATE app.external_connection_catalog_discoveries SET state='failed' WHERE id=$1",
      "DELETE FROM app.external_connection_catalog_relations WHERE discovery_id=$1",
      "SELECT app.complete_external_connection_catalog_discovery($1,NULL,NULL,'catalog_failed')"
    ]) await assert.rejects(runtime(ID.owner, () => db.query(sql, [successId])), /permission denied/);
  });

  it("rejects malformed, duplicate, out-of-scope and over-limit results atomically; failures retain prior success", async () => {
    const job = await request("invalid-results");
    await claim(job);
    const oversize = relation();
    oversize.columns = Array.from({length: 256}, (_, i) => ({...column(`c${i}`),
      type_schema: "s".repeat(63), type_name: "t".repeat(63)}));
    const many = Array.from({length: 40}, (_, i) => {
      const value = relation(`relation_${i}`);
      value.columns = oversize.columns.slice(0, 120);
      return value;
    });
    assert.ok(JSON.stringify(catalog(many)).length > 1048576);
    for (const invalid of [
      null, {...catalog(), truncated: null}, {...catalog(), secret: "forbidden"},
      catalog([relation(), relation()]), catalog([relation("roads", "research")]),
      catalog([relation("inserted_first"), relation("rejected_second", "research")]),
      catalog([{...relation(), schema_fingerprint_sha256: null}]),
      catalog([{...relation(), unsupported_reasons: [null]}]),
      catalog([{...relation(), columns: [null]}]), catalog([oversize]), catalog(many),
      catalog(Array.from({length: 101}, (_, i) => relation(`r_${i}`)))
    ]) await assert.rejects(complete(job, invalid), /catalog/);
    await assert.rejects(complete(job, null, "password=secret"), /invalid connection catalog error/);
    await assert.rejects(complete(job, catalog(), "catalog_timeout"), /invalid connection catalog error/);
    assert.equal(await complete(job, null, "catalog_timeout"), true);
    const rows = await runtime(ID.owner, () => db.query(
      "SELECT discovery_id,count(*)::int AS count FROM app.external_connection_catalog_relations GROUP BY discovery_id"));
    assert.deepEqual(rows.rows, [{discovery_id: successId, count: 2}]);
    assert.equal((await jobRow(successId)).state, "completed");
    assert.equal((await jobRow(job)).sanitized_error_code, "catalog_timeout");
    const audit = await runtime(ID.owner, () => db.query(
      "SELECT payload FROM app.activity_events WHERE event_type LIKE 'connection.catalog.%'"));
    assert.doesNotMatch(JSON.stringify(audit.rows), /secret_arn|gis\.example|password/i);
  });

  it("rejects stale tokens and expired completion, reclaims leases and bounds dependency retries", async () => {
    const job = await request("retry-catalog");
    assert.equal((await claim(job)).attempt_count, 1);
    assert.equal(await complete(job, catalog(), null, ID.otherToken), false);
    assert.equal(await complete(job, catalog(), null, null), false);
    await privileged("UPDATE app.external_connection_catalog_discoveries SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job]);
    assert.equal(await complete(job), false);
    await role("opengeo_connector");
    assert.equal((await db.query("SELECT app.release_external_connection_catalog_discovery($1,$2,3) AS state",
      [job, ID.token])).rows[0].state, "lost");
    assert.equal((await claim(job, ID.otherToken)).attempt_count, 2);
    assert.equal(await complete(job), false);
    assert.equal((await db.query("SELECT app.release_external_connection_catalog_discovery($1,$2,3) AS state",
      [job, ID.otherToken])).rows[0].state, "queued");
    assert.equal((await claim(job)).attempt_count, 3);
    assert.equal((await db.query("SELECT app.release_external_connection_catalog_discovery($1,$2,3) AS state",
      [job, ID.token])).rows[0].state, "failed");
    assert.equal((await claim(job)).claim_status, "already_failed");
    const expired = await request("expired-final-attempt");
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal((await claim(expired)).attempt_count, attempt);
      await privileged("UPDATE app.external_connection_catalog_discoveries SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired]);
    }
    assert.equal((await claim(expired)).claim_status, "attempts_exhausted");
    assert.equal((await jobRow(expired)).worker_token, null);
    await role("opengeo_connector");
    await assert.rejects(db.query("SELECT * FROM app.claim_external_connection_catalog_discovery($1,$2,NULL)",
      [expired, ID.token]), /invalid connection catalog claim/);
  });

  it("invalidates cancellation, disablement and rotated-revision completions before writing metadata", async () => {
    const cancelled = await request("cancel-catalog");
    await claim(cancelled);
    await assert.rejects(cancel(cancelled, ID.editor), /manage authority/);
    assert.equal(await cancel(cancelled, ID.teamOwner), true);
    assert.equal(await complete(cancelled), false);
    const disabled = await request("disabled-catalog");
    await claim(disabled);
    await privileged("UPDATE app.external_connections SET status='disabled' WHERE id=$1", [ID.connection]);
    assert.equal(await complete(disabled), false);
    assert.equal((await jobRow(disabled)).state, "cancelled");
    assert.equal(await request("successful-catalog"), successId);
    await assert.rejects(request("new-disabled"), /not catalog discoverable/);
    await privileged("UPDATE app.external_connections SET status='credentials_verified' WHERE id=$1", [ID.connection]);
    const rotated = await request("rotated-catalog");
    await claim(rotated);
    await privileged("UPDATE app.external_connections SET current_revision_number=2 WHERE id=$1", [ID.connection]);
    await privileged(`INSERT INTO app.external_connection_revisions
      (organization_id,project_id,connection_id,revision_number,configuration,change_summary,created_by)
      SELECT organization_id,project_id,connection_id,2,configuration,'Rotate',created_by
        FROM app.external_connection_revisions WHERE connection_id=$1 AND revision_number=1`, [ID.connection]);
    assert.equal(await complete(rotated), false);
    assert.equal((await jobRow(rotated)).state, "cancelled");
    const current = await request("current-revision", ID.owner, 2);
    assert.equal((await claim(current)).connection_revision_number, 2);
    assert.equal(await complete(current, catalog([])), true);
  });

  it("enforces project/tenant reads and rechecks requester authority before work and persistence", async () => {
    for (const [user, organization] of [[ID.outsider, ID.org], [ID.outsider, ID.otherOrg]]) {
      const result = await runtime(user, () => db.query(
        `SELECT id FROM app.external_connection_catalog_discoveries
          UNION ALL SELECT discovery_id FROM app.external_connection_catalog_relations`), organization);
      assert.equal(result.rows.length, 0);
    }
    assert.ok((await runtime(ID.admin, () => db.query(
      "SELECT id FROM app.external_connection_catalog_discoveries"))).rows.length > 0);
    assert.equal((await runtime(ID.teamOwner, () => db.query(
      "SELECT ordinal FROM app.external_connection_catalog_relations WHERE discovery_id=$1", [successId]))).rows.length, 2);
    await privileged("UPDATE app.teams SET status='archived' WHERE id=$1", [ID.team]);
    assert.equal((await runtime(ID.teamOwner, () => db.query(
      "SELECT id FROM app.external_connection_catalog_discoveries"))).rows.length, 0);
    await assert.rejects(request("archived-team", ID.teamOwner, 2), /manage authority/);
    const offboarded = await request("offboarded-before-claim", ID.admin, 2);
    await privileged("DELETE FROM app.organization_memberships WHERE organization_id=$1 AND user_id=$2",
      [ID.org, ID.admin]);
    const deniedClaim = await claim(offboarded);
    assert.equal(deniedClaim.claim_status, "not_discoverable");
    assert.equal(deniedClaim.secret_arn, null);
    assert.equal(deniedClaim.attempt_count, 0);
    assert.equal((await jobRow(offboarded)).state, "cancelled");
    const downgraded = await request("downgraded-after-claim", ID.owner, 2);
    assert.equal((await claim(downgraded)).claim_status, "claimed");
    await privileged("UPDATE app.project_memberships SET role='viewer' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",
      [ID.org, ID.project, ID.owner]);
    assert.equal(await complete(downgraded), false);
    assert.equal((await jobRow(downgraded)).state, "cancelled");
    const deniedRows = await runtime(ID.editor, () => db.query(
      "SELECT ordinal FROM app.external_connection_catalog_relations WHERE discovery_id IN ($1,$2)",
      [offboarded, downgraded]));
    assert.equal(deniedRows.rows.length, 0);
    const grants = await privileged(`SELECT
      has_table_privilege('opengeo_runtime','app.external_connection_catalog_relations','INSERT') AS runtime_insert,
      has_table_privilege('opengeo_connector','app.external_connection_catalog_discoveries','SELECT') AS connector_read,
      has_column_privilege('opengeo_runtime','app.external_connections','secret_arn','SELECT') AS runtime_secret`);
    assert.deepEqual(grants.rows[0], {runtime_insert: false, connector_read: false, runtime_secret: false});
  });
});
