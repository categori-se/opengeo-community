import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const account = "10000000-0000-4000-8000-000000000154";
const otherAccount = "10000000-0000-4000-8000-000000000155";
const admin = "20000000-0000-4000-8000-000000000154";
const member = "20000000-0000-4000-8000-000000000155";
const former = "20000000-0000-4000-8000-000000000156";
const project = "50000000-0000-4000-8000-000000000154";
const map = "60000000-0000-4000-8000-000000000154";
let db;

async function capture(user = admin, selectedAccount = account, snapshot = true) {
  await db.exec(snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  try {
    await db.query("SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)",
      [user, selectedAccount]);
    await db.exec("DECLARE opengeo_account_recovery_inventory NO SCROLL CURSOR FOR SELECT * FROM app.capture_account_recovery_inventory() ORDER BY chunk_index");
    const rows = [];
    while (true) {
      const page = await db.query("FETCH FORWARD 20 FROM opengeo_account_recovery_inventory");
      rows.push(...page.rows);
      if (page.rows.length < 20) break;
    }
    await db.exec("CLOSE opengeo_account_recovery_inventory");
    await db.exec("COMMIT");
    return rows;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

function unpack(rows) {
  return JSON.parse(Buffer.concat(rows.map(row => Buffer.from(row.body))).toString("utf8"));
}

describe("0154 admin account recovery metadata capture", () => {
  before(async () => {
    db = new PGlite();
    const foundation = await readFile(new URL("../migrations/0001_platform_foundation.sql", import.meta.url), "utf8");
    await db.exec(foundation.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    const migration = await readFile(new URL("../migrations/0154_account_recovery_inventory.sql", import.meta.url), "utf8");
    const projections = JSON.parse(migration.match(/v_projections constant jsonb := '([\s\S]*?)'::jsonb;/)[1]);
    const extras = JSON.parse(migration.match(/v_extra constant jsonb := '([\s\S]*?)'::jsonb;/)[1].replaceAll("''", "'"));
    // The established foundation is real. Other fixed projections use bounded
    // schema stubs for this focused security/function test, not full migrations.
    for (const [table, columns] of Object.entries(projections)) {
      const found = await db.query("SELECT to_regclass($1) AS name", [`app.${table}`]);
      const definitions = columns.map(column => `"${column}" ${column === "organization_id" ? "uuid" : "text"}`);
      if (!found.rows[0].name) await db.exec(`CREATE TABLE app."${table}" (${definitions.join(",")})`);
      for (const column of columns) {
        const foundColumn = await db.query("SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2", [`app.${table}`, column]);
        if (!foundColumn.rows.length) await db.exec(`ALTER TABLE app."${table}" ADD COLUMN "${column}" text`);
      }
      const payloads = new Map();
      for (const expression of extras[table] ?? []) {
        for (const match of expression.matchAll(/convert_to\("(\w+)"::text/g)) payloads.set(match[1], "jsonb");
        for (const match of expression.matchAll(/sha256\("(\w+)"\)/g)) payloads.set(match[1], "bytea");
      }
      for (const column of ["definition", "references_json", "manifest", "document", "receipt", "descriptor"]) {
        if ((extras[table] ?? []).some(expression => new RegExp(`\\b${column}\\b`).test(expression))) payloads.set(column, "jsonb");
      }
      for (const [column, type] of payloads) {
        const foundColumn = await db.query("SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2", [`app.${table}`, column]);
        if (!foundColumn.rows.length) await db.exec(`ALTER TABLE app."${table}" ADD COLUMN "${column}" ${type}`);
      }
      if (["external_connections", "user_dataset_connections", "user_basemap_connections"].includes(table)) {
        await db.exec(`ALTER TABLE app."${table}" ADD COLUMN configured_secret_fields text[]`);
      }
    }
    await db.exec(migration);
    await db.exec(`
      INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES
       ('${admin}','admin154','admin154@example.test','Admin'),
       ('${member}','member154','member154@example.test','Member'),
       ('${former}','former154','private-other@example.test','Private other account');
      INSERT INTO app.organizations(id,name,slug,created_by) VALUES
       ('${account}','Recovery account','recovery154','${admin}'),
       ('${otherAccount}','Other account','recovery155','${former}');
      INSERT INTO app.organization_memberships(organization_id,user_id,role,invited_by) VALUES
       ('${account}','${admin}','admin','${admin}'),
       ('${account}','${member}','member','${admin}'),
       ('${otherAccount}','${former}','admin','${former}');
      INSERT INTO app.projects(id,organization_id,name,created_by) VALUES
       ('${project}','${account}','Working project','${admin}');
      INSERT INTO app.maps(id,organization_id,project_id,name,status,definition,created_by,updated_by)
       VALUES ('${map}','${account}','${project}','Archived map','archived',
       '{"layers":[{"datasetId":"80000000-0000-4000-8000-000000000154","sourceVersion":2}],"basemaps":[]}',
       '${admin}','${admin}');
      INSERT INTO app.map_versions(organization_id,map_id,version,definition,created_by)
       VALUES ('${account}','${map}',1,'{"layers":[],"basemaps":[]}','${former}');
      UPDATE app.map_versions SET change_message='Retained first scene' WHERE map_id='${map}';
      INSERT INTO app.observable_build_jobs(organization_id,id,output_prefix,result)
       VALUES ('${account}','a0000000-0000-4000-8000-000000000154','builds/recovery154/',
       '{"outputManifest":{"files":[{"path":"dist/index.html","bucket":"private-test", "objectKey":"builds/recovery154/index.html","s3VersionId":"exact-version","sizeBytes":32,"checksumSha256":"${"a".repeat(64)}"}]}}');
      INSERT INTO app.archive_upload_sessions(organization_id,id,created_by,state)
       VALUES ('${account}','90000000-0000-4000-8000-000000000154','${member}','complete');
      ALTER TABLE app.archive_upload_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.archive_upload_sessions FORCE ROW LEVEL SECURITY;
      CREATE POLICY sessions_creator_only ON app.archive_upload_sessions
       USING (organization_id=app.current_organization_id() AND created_by=app.current_user_id()::text);
      GRANT SELECT ON app.archive_upload_sessions TO opengeo_runtime;
      ALTER TABLE app.user_dataset_connections ADD COLUMN secret_arn text;
      INSERT INTO app.user_dataset_connections(organization_id,id,secret_arn,owner_user_id)
       VALUES ('${account}','c0000000-0000-4000-8000-000000000154','SECRET_MUST_NOT_APPEAR','${member}');
      INSERT INTO app.workspace_collection_entries(organization_id,collection_id,map_id,position)
       VALUES ('${account}','d0000000-0000-4000-8000-000000000154','${map}','1');
      SET ROLE opengeo_runtime;
    `);
  });
  after(async () => { await db.exec("RESET ROLE"); await db.close(); });

  it("captures archived maps, every stored history and creator-private rows without changing normal RLS", async () => {
    const rows = await capture();
    const result = unpack(rows);
    assert.equal(Object.keys(result.tables).length, 170);
    assert.equal(result.tables.maps.records[0].status, "archived");
    assert.equal(result.tables.map_versions.count, 1);
    assert.equal(result.tables.map_versions.records[0].change_message, "Retained first scene");
    assert.equal(result.tables.observable_build_jobs.records[0].output_prefix, "builds/recovery154/");
    assert.equal(result.tables.observable_build_jobs.records[0].compiled_output_objects[0].s3_version_id, "exact-version");
    assert.equal(result.tables.archive_upload_sessions.records[0].created_by, member);
    assert.equal(result.tables.workspace_collection_entries.records[0].map_id, map);
    assert.equal(result.tables.maps.records[0].definition_dependencies[0].source_version, 2);
    assert.equal(result.limits.object_bytes_included, false);
    assert.equal(result.limits.payloads_included, false);
    assert.ok(!JSON.stringify(result).includes("SECRET_MUST_NOT_APPEAR"));
    const actor = result.principals.find(principal => principal.id === former);
    assert.equal(actor.current_member, false);
    assert.equal(actor.email, null);
    assert.equal(actor.display_name, null);
    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [admin, account]);
    assert.equal((await db.query("SELECT * FROM app.archive_upload_sessions")).rows.length, 0);
    await db.exec("ROLLBACK");
  });

  it("denies ordinary members and another account selected by the first admin", async () => {
    await assert.rejects(capture(member), /account_recovery_admin_required/);
    await assert.rejects(capture(admin, otherAccount), /account_recovery_admin_required/);
  });

  it("requires actual transaction modes and exposes no arbitrary caller capture parameters", async () => {
    await assert.rejects(capture(admin, account, false), /account_recovery_snapshot_required/);
    assert.equal((await db.query("SELECT pronargs FROM pg_proc WHERE proname='capture_account_recovery_inventory'")).rows[0].pronargs, 0);
  });

  it("fails closed when a new account table would otherwise be silently omitted", async () => {
    await db.exec("RESET ROLE; CREATE TABLE app.new_account_data(organization_id uuid); SET ROLE opengeo_runtime");
    await assert.rejects(capture(), /account_recovery_schema_changed/);
    await db.exec("RESET ROLE; DROP TABLE app.new_account_data; SET ROLE opengeo_runtime");
  });
});
