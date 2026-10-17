import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {after, before, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const id = n => `01710000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = {org: id(1), otherOrg: id(2), owner: id(3), editor: id(4), viewer: id(5),
  teamViewer: id(6), grantee: id(7), outsider: id(8), project: id(9), extraProject: id(10),
  connection: id(11), discovery: id(12), newerDiscovery: id(13), team: id(14), token: id(15), wrongToken: id(16)};
const secretArn = `arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/${ID.org}/${ID.connection}-AbCd12`;
const keyColumn = {name: "id", type_schema: "pg_catalog", type_name: "int8", not_null: true,
  type_modifier: -1, geometry: null, unique_key: true, primary_key: true};
const geometryColumn = {name: "geom", type_schema: "public", type_name: "geometry", not_null: false,
  type_modifier: 1107460, geometry: {geometry_type: "POLYGON", srid: 4326, postgis_schema: "public"},
  unique_key: false, primary_key: false};
const descriptor = (name = "Parcels", fingerprint = "a".repeat(64)) => ({schema: "public", name, kind: "r",
  columns: [keyColumn, geometryColumn], stable_key: "id", unsupported_reasons: [], schema_fingerprint_sha256: fingerprint});
const bounds = [-74, 40, -70, 44];
let db;
let layer;
let keySequence = 100;
const nextKey = () => id(++keySequence);

async function role(name) { await db.exec(`RESET ROLE; SET ROLE ${name}`); }
async function privileged(sql, params = []) { await db.exec("RESET ROLE"); return db.query(sql, params); }
async function runtime(actor, fn, org = ID.org) {
  await role("opengeo_runtime"); await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [org, actor]);
    const value = await fn(); await db.exec("COMMIT"); return value;
  } catch (error) { await db.exec("ROLLBACK"); throw error; }
}
async function register(options = {}) {
  const p = {actor: ID.owner, discovery: ID.discovery, ordinal: 1, revision: 1, fingerprint: "a".repeat(64),
    geometry: "geom", name: "Selected parcels", description: "Provider parcels", expected: null, key: nextKey(), ...options};
  return (await runtime(p.actor, () => db.query(`SELECT * FROM app.register_external_postgis_layer(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ID.connection, p.discovery, p.ordinal, p.revision, p.fingerprint,
    p.geometry, p.name, p.description, p.expected, p.key]), p.org ?? ID.org)).rows[0];
}
async function prepare(actor = ID.viewer, options = {}) {
  const p = {dataset: layer.dataset_id, version: 2, key: nextKey(), bbox: bounds, ...options};
  return (await runtime(actor, () => db.query("SELECT * FROM app.prepare_external_postgis_preview($1,$2,$3,$4::jsonb)",
    [p.dataset, p.version, p.key, JSON.stringify(p.bbox)]), p.org ?? ID.org)).rows[0];
}
async function claim(preview, token = ID.token) {
  await role("opengeo_connector");
  return (await db.query("SELECT * FROM app.claim_external_postgis_preview($1,$2,20)", [preview, token])).rows[0];
}
async function finish(preview, options = {}) {
  const p = {token: ID.token, returned: 3, truncated: false, error: null, ...options};
  await role("opengeo_connector");
  return (await db.query("SELECT app.complete_external_postgis_preview($1,$2,$3,$4,$5) AS done",
    [preview, p.token, p.returned, p.truncated, p.error])).rows[0].done;
}
async function seedRelation(discovery, ordinal, value) {
  await privileged(`INSERT INTO app.external_connection_catalog_relations
    (organization_id,project_id,discovery_id,ordinal,schema_name,relation_name,schema_fingerprint_sha256,descriptor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [ID.org, ID.project, discovery, ordinal,
    value.schema, value.name, value.schema_fingerprint_sha256, JSON.stringify(value)]);
}

describe("0171 canonical PostGIS Layer registration and feature-free preview leases", {concurrency: false}, () => {
  before(async () => {
    db = new PGlite();
    for (const file of ["0001_platform_foundation.sql", "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql", "0004_worker_execution_boundary.sql", "0005_catalog_access.sql",
      "0006_governed_external_sources.sql", "0047_governed_external_connections.sql", "0048_external_connection_verification.sql"]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec("CREATE ROLE opengeo_observable_coordinator");
    await db.exec(await readFile(new URL("../migrations/0050_team_project_access.sql", import.meta.url), "utf8"));
    const authority = await readFile(new URL("../migrations/0101_background_project_authority.sql", import.meta.url), "utf8");
    await db.exec(authority.slice(authority.indexOf("CREATE FUNCTION app.background_project_role("),
      authority.indexOf("\nREVOKE ALL ON FUNCTION app.background_project_role(")));
    // The unrelated service migrations' prerequisite enum additions are retained;
    // this fixture exercises the actual current source constraints and functions.
    for (const value of ["repository", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver"]) {
      await db.exec(`ALTER TYPE app.dataset_source_type ADD VALUE IF NOT EXISTS '${value}'`);
      await db.exec(`ALTER TYPE app.dataset_format ADD VALUE IF NOT EXISTS '${value}'`);
    }
    for (const file of ["0156_referenced_cog_sources.sql", "0157_referenced_cog_configuration_bounds.sql",
      "0170_external_connection_catalog_discovery.sql", "0171_external_postgis_layers_and_previews.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    for (const [name, user] of Object.entries({owner: ID.owner, editor: ID.editor, viewer: ID.viewer,
      teamViewer: ID.teamViewer, grantee: ID.grantee, outsider: ID.outsider})) {
      await db.query("INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES($1,$2,$3,$2)",
        [user, `postgis-${name}`, `${name.toLowerCase()}@example.test`]);
    }
    await db.exec(`INSERT INTO app.organizations(id,name,slug,created_by) VALUES
      ('${ID.org}','PostGIS','postgis','${ID.owner}'),('${ID.otherOrg}','Other','postgis-other','${ID.outsider}');
      INSERT INTO app.organization_memberships(organization_id,user_id,role,invited_by)
      SELECT '${ID.org}',id,'member','${ID.owner}' FROM app.users;
      INSERT INTO app.organization_memberships(organization_id,user_id,role,invited_by)
      VALUES('${ID.otherOrg}','${ID.outsider}','admin','${ID.outsider}');
      INSERT INTO app.projects(id,organization_id,name,created_by) VALUES
      ('${ID.project}','${ID.org}','Warehouse','${ID.owner}'),('${ID.extraProject}','${ID.org}','Second study','${ID.owner}');
      INSERT INTO app.project_memberships(organization_id,project_id,user_id,role) VALUES
      ('${ID.org}','${ID.project}','${ID.owner}','owner'),('${ID.org}','${ID.project}','${ID.editor}','editor'),
      ('${ID.org}','${ID.project}','${ID.viewer}','viewer');
      INSERT INTO app.teams(id,organization_id,name,created_by) VALUES('${ID.team}','${ID.org}','Readers','${ID.owner}');
      INSERT INTO app.team_memberships(organization_id,team_id,user_id,role,created_by)
      VALUES('${ID.org}','${ID.team}','${ID.teamViewer}','member','${ID.owner}');
      INSERT INTO app.project_team_grants(organization_id,project_id,team_id,role,created_by)
      VALUES('${ID.org}','${ID.project}','${ID.team}','viewer','${ID.owner}');`);
    await db.query(`INSERT INTO app.external_connections(id,organization_id,project_id,provider,display_name,
      endpoint_host,database_name,allowed_schemas,secret_arn,configured_secret_fields,created_by,updated_by)
      VALUES($1,$2,$3,'postgresql','Warehouse','gis.example.test','research',ARRAY['public'],$4,
        ARRAY['password','username'],$5,$5)`, [ID.connection, ID.org, ID.project, secretArn, ID.owner]);
    await db.query(`INSERT INTO app.external_connection_revisions
      (organization_id,project_id,connection_id,revision_number,configuration,change_summary,created_by)
      SELECT organization_id,project_id,id,1,jsonb_build_object('provider',provider::text,
        'endpointHost',endpoint_host,'endpointPort',endpoint_port,'databaseName',database_name,
        'allowedSchemas',to_jsonb(allowed_schemas),'readOnly',read_only,'tlsMode',tls_mode::text,
        'networkMode',network_mode::text),'Initial',$2 FROM app.external_connections WHERE id=$1`, [ID.connection, ID.owner]);
    await db.query("UPDATE app.external_connections SET status='credentials_verified',last_verified_at=clock_timestamp() WHERE id=$1", [ID.connection]);
    for (const [discovery, key] of [[ID.discovery, "first-catalog"], [ID.newerDiscovery, "second-catalog"]]) {
      await db.query(`INSERT INTO app.external_connection_catalog_discoveries
        (id,organization_id,project_id,connection_id,connection_revision_number,request_key,requested_by,
         state,started_at,finished_at,relation_count)
        VALUES($1,$2,$3,$4,1,$5,$6,'completed',clock_timestamp(),clock_timestamp(),1)`,
      [discovery, ID.org, ID.project, ID.connection, key, ID.owner]);
    }
    await seedRelation(ID.discovery, 1, descriptor());
    await seedRelation(ID.newerDiscovery, 1, descriptor("Parcels", "b".repeat(64)));
  });
  after(async () => { await db.exec("RESET ROLE"); await db.close(); });

  it("registers once with canonical identity and replay-safe keys under connection manage authority", async () => {
    await assert.rejects(register({actor: ID.editor}), /manage and source create authority/);
    await assert.rejects(register({actor: ID.viewer}), /manage and source create authority/);
    await assert.rejects(register({actor: ID.outsider, org: ID.otherOrg}), /not found/);
    const key = nextKey();
    layer = await register({key});
    assert.equal(layer.created, true); assert.equal(layer.source_version, 1);
    assert.deepEqual(await register({key}), layer);
    await assert.rejects(register({key, name: "Changed replay"}), error => error.code === "23505");
    const reused = await register();
    assert.deepEqual(reused, {...layer, created: false});
    const row = (await privileged(`SELECT dataset.source_type::text,dataset.format::text,dataset.classification::text,
      source.access_mode::text,source.credential_mode::text,revision.source_url,revision.verification_state::text,revision.configuration
      FROM app.datasets dataset JOIN app.external_sources source ON source.dataset_id=dataset.id
      JOIN app.external_source_revisions revision ON revision.dataset_id=dataset.id WHERE dataset.id=$1`, [layer.dataset_id])).rows[0];
    assert.equal(row.source_type, "postgis"); assert.equal(row.format, "postgis"); assert.equal(row.classification, "internal");
    assert.equal(row.access_mode, "server_mediated"); assert.equal(row.credential_mode, "connection_reference");
    assert.equal(row.verification_state, "catalog_described");
    assert.equal(row.source_url, `urn:opengeo:postgis:${ID.connection}:${ID.discovery}:1`);
    assert.equal(row.configuration.stable_key, "id");
    assert.doesNotMatch(JSON.stringify(row), /secret_arn|password|gis\.example/);
    assert.equal((await privileged("SELECT count(*)::integer AS count FROM app.data_objects")).rows[0].count, 0);
  });

  it("appends changed selections with CAS while preserving metadata, grants and links", async () => {
    await privileged("UPDATE app.datasets SET name='Curated parcels',description='User authored' WHERE id=$1", [layer.dataset_id]);
    await privileged(`INSERT INTO app.dataset_permissions(organization_id,dataset_id,user_id,role,granted_by)
      VALUES($1,$2,$3,'view',$4)`, [ID.org, layer.dataset_id, ID.grantee, ID.owner]);
    await privileged(`INSERT INTO app.project_datasets(organization_id,project_id,dataset_id,linked_by)
      VALUES($1,$2,$3,$4)`, [ID.org, ID.extraProject, layer.dataset_id, ID.owner]);
    const update = {discovery: ID.newerDiscovery, fingerprint: "b".repeat(64)};
    await assert.rejects(register(update), error => error.code === "23505");
    await assert.rejects(register({...update, expected: 9}), error => error.code === "23505");
    const changed = await register({...update, expected: 1});
    assert.deepEqual(changed, {dataset_id: layer.dataset_id, source_version: 2, created: false});
    assert.deepEqual((await privileged("SELECT name,description FROM app.datasets WHERE id=$1", [layer.dataset_id])).rows[0],
      {name: "Curated parcels", description: "User authored"});
    assert.deepEqual((await privileged("SELECT version_number FROM app.external_source_revisions WHERE dataset_id=$1 ORDER BY version_number", [layer.dataset_id])).rows,
      [{version_number: 1}, {version_number: 2}]);
    assert.equal((await privileged("SELECT count(*)::integer AS count FROM app.project_datasets WHERE dataset_id=$1", [layer.dataset_id])).rows[0].count, 2);
    assert.equal((await privileged("SELECT role::text FROM app.dataset_permissions WHERE dataset_id=$1", [layer.dataset_id])).rows[0].role, "view");
    await assert.rejects(privileged("UPDATE app.external_connection_source_bindings SET relation_name='another' WHERE dataset_id=$1", [layer.dataset_id]), /append-only/);
  });

  it("rejects unsupported executable profiles and fabricated private URLs without changing COG allowance", async () => {
    const invalid = [
      {...descriptor("View"), kind: "v"}, {...descriptor("Partitioned"), kind: "p"},
      {...descriptor("NoKey"), stable_key: null, unsupported_reasons: ["stable_key_unavailable"]},
      {...descriptor("WrongSRID"), columns: [keyColumn, {...geometryColumn, geometry: {...geometryColumn.geometry, srid: 3857}}]},
      {...descriptor("ThreeDimensional"), columns: [keyColumn, {...geometryColumn, geometry: {...geometryColumn.geometry, geometry_type: "POLYGONZ"}}]},
      {...descriptor("TwoGeometry"), columns: [keyColumn, geometryColumn, {...geometryColumn, name: "geom2"}]},
      {...descriptor("TooManyColumns"), columns: [keyColumn, geometryColumn,
        ...Array.from({length: 63}, (_, index) => ({...keyColumn, name: `attribute_${index}`, unique_key: false, primary_key: false}))]},
      {...descriptor("CustomAttribute"), columns: [keyColumn, geometryColumn, {...keyColumn, name: "extra", type_name: "jsonb", unique_key: false}]}
    ];
    for (let i = 0; i < invalid.length; i++) {
      await seedRelation(ID.discovery, i + 2, invalid[i]);
      await assert.rejects(register({ordinal: i + 2}), /invalid registered PostGIS source definition/);
    }
    assert.equal((await privileged("SELECT count(*)::integer AS count FROM app.external_connection_source_bindings")).rows[0].count, 1);
    await assert.rejects(runtime(ID.owner, () => db.query(`INSERT INTO app.external_source_revisions
      (organization_id,dataset_id,version_number,source_url,configuration,verification_state,created_by)
      VALUES($1,$2,3,'https://invented.example', '{}'::jsonb,'catalog_described',$3)`, [ID.org, layer.dataset_id, ID.owner])), /permission denied|invalid registered/);
    await assert.rejects(privileged(`INSERT INTO app.datasets(organization_id,name,source_type,format,owner_user_id,created_by,updated_by)
      VALUES($1,'Invalid upload','upload','postgis',$2,$2,$2)`, [ID.org, ID.owner]), /datasets_source_format_match/);
    const cog = id(50);
    await privileged(`INSERT INTO app.datasets(id,organization_id,name,source_type,format,status,owner_user_id,created_by,updated_by)
      VALUES($1,$2,'COG','cog','cog','active',$3,$3,$3)`, [cog, ID.org, ID.owner]);
    await privileged("INSERT INTO app.external_sources(organization_id,dataset_id,source_type,created_by) VALUES($1,$2,'cog',$3)", [ID.org, cog, ID.owner]);
    await assert.rejects(privileged(`INSERT INTO app.external_source_revisions
      (organization_id,dataset_id,version_number,source_url,configuration,created_by) VALUES($1,$2,1,$3,'{}',$4)`,
    [ID.org, cog, `urn:opengeo:postgis:${ID.connection}:${ID.discovery}:1`, ID.owner]), /HTTPS/);
    const configuration = {service_kind: "cog", reference_metadata: {source: {description: "source evidence ".repeat(2000)}}};
    await privileged(`INSERT INTO app.external_source_revisions
      (organization_id,dataset_id,version_number,source_url,configuration,created_by) VALUES($1,$2,1,'https://example.test/image.tif',$3::jsonb,$4)`,
    [ID.org, cog, JSON.stringify(configuration), ID.owner]);
    assert.deepEqual((await privileged("SELECT configuration FROM app.external_source_revisions WHERE dataset_id=$1", [cog])).rows[0].configuration, configuration);
  });

  it("allows actual Layer readers through private connector claims without discovery authority", async () => {
    await assert.rejects(prepare(ID.outsider), error => error.code === "23505");
    await assert.rejects(prepare(ID.outsider, {org: ID.otherOrg}), error => error.code === "23505");
    await assert.rejects(prepare(ID.viewer, {version: 1}), error => error.code === "23505");
    for (const actor of [ID.viewer, ID.teamViewer, ID.grantee]) {
      const prepared = await prepare(actor);
      assert.equal(prepared.state, "queued");
      await assert.rejects(runtime(actor, () => db.query("SELECT * FROM app.claim_external_postgis_preview($1,$2,20)",
        [prepared.preview_id, ID.token])), /permission denied/);
      const claimed = await claim(prepared.preview_id);
      assert.equal(claimed.claim_status, "claimed"); assert.equal(claimed.secret_arn, secretArn);
      assert.equal(claimed.dataset_id, layer.dataset_id); assert.equal(claimed.source_version, 2);
      assert.equal(claimed.source_configuration.schema_fingerprint_sha256, "b".repeat(64));
      assert.deepEqual(claimed.bbox, bounds);
      assert.equal(await finish(prepared.preview_id), true);
      const repeated = await claim(prepared.preview_id);
      assert.equal(repeated.claim_status, "already_completed"); assert.equal(repeated.secret_arn, null);
    }
    await role("opengeo_worker");
    await assert.rejects(db.query("SELECT * FROM app.claim_external_postgis_preview($1,$2,20)", [id(999), ID.token]), /permission denied/);
    await assert.rejects(runtime(ID.owner, () => db.query("SELECT * FROM app.external_postgis_previews")), /permission denied/);
  });

  it("rechecks revocation, membership, connection and revision before secrets and feature delivery", async () => {
    let prepared = await prepare(ID.grantee);
    await privileged("DELETE FROM app.dataset_permissions WHERE organization_id=$1 AND dataset_id=$2 AND user_id=$3", [ID.org, layer.dataset_id, ID.grantee]);
    const revoked = await claim(prepared.preview_id);
    assert.equal(revoked.claim_status, "not_previewable"); assert.equal(revoked.secret_arn, null);
    prepared = await prepare(ID.teamViewer);
    assert.equal((await claim(prepared.preview_id)).claim_status, "claimed");
    await privileged("DELETE FROM app.team_memberships WHERE organization_id=$1 AND user_id=$2", [ID.org, ID.teamViewer]);
    assert.equal(await finish(prepared.preview_id), false);
    prepared = await prepare(ID.viewer);
    assert.equal((await claim(prepared.preview_id)).claim_status, "claimed");
    await privileged("UPDATE app.external_connections SET status='disabled' WHERE id=$1", [ID.connection]);
    assert.equal(await finish(prepared.preview_id), false);
    await privileged("UPDATE app.external_connections SET status='credentials_verified' WHERE id=$1", [ID.connection]);
    prepared = await prepare(ID.viewer);
    await privileged("UPDATE app.organizations SET status='archived' WHERE id=$1", [ID.org]);
    assert.equal((await claim(prepared.preview_id)).secret_arn, null);
    await privileged("UPDATE app.organizations SET status='active' WHERE id=$1", [ID.org]);
    prepared = await prepare(ID.viewer);
    await privileged("DELETE FROM app.organization_memberships WHERE organization_id=$1 AND user_id=$2", [ID.org, ID.viewer]);
    assert.equal((await claim(prepared.preview_id)).secret_arn, null);
    await privileged("INSERT INTO app.organization_memberships(organization_id,user_id,role,invited_by) VALUES($1,$2,'member',$3)", [ID.org, ID.viewer, ID.owner]);
    prepared = await prepare(ID.viewer);
    assert.equal((await claim(prepared.preview_id)).claim_status, "claimed");
    await register({discovery: ID.discovery, fingerprint: "a".repeat(64), expected: 2});
    assert.equal(await finish(prepared.preview_id), false);
    await assert.rejects(prepare(ID.viewer), error => error.code === "23505");
    await register({discovery: ID.newerDiscovery, fingerprint: "b".repeat(64), expected: 3});
    // Restore the current source version for subsequent lease-boundary checks.
  });

  it("bounds requests and one-use leases while persisting only sanitized metadata", async () => {
    for (const bbox of [[1, 2, 1, 3], [-181, 0, 1, 2], [1, -91, 2, 3], [1, 2, 3], ["1", 2, 3, 4], [1, 2, 3, 91]]) {
      await assert.rejects(prepare(ID.viewer, {version: 4, bbox}), /preview request|preview bounds/);
    }
    const key = nextKey();
    const prepared = await prepare(ID.viewer, {version: 4, key});
    assert.deepEqual(await prepare(ID.viewer, {version: 4, key}), prepared);
    await assert.rejects(prepare(ID.viewer, {version: 4}), error => error.code === "23505");
    await assert.rejects(prepare(ID.viewer, {version: 4, key, bbox: [-75, 40, -70, 44]}), error => error.code === "23505");
    await claim(prepared.preview_id);
    assert.equal((await claim(prepared.preview_id, ID.wrongToken)).claim_status, "already_running");
    assert.equal(await finish(prepared.preview_id, {token: ID.wrongToken}), false);
    await assert.rejects(finish(prepared.preview_id, {returned: 101}), /invalid PostGIS preview completion/);
    await assert.rejects(finish(prepared.preview_id, {returned: null, truncated: null, error: "password=do-not-log"}), /invalid PostGIS preview completion/);
    assert.equal(await finish(prepared.preview_id, {returned: null, truncated: null, error: "preview_row_too_large"}), true);
    assert.equal((await prepare(ID.viewer, {version: 4, key})).state, "failed");
    assert.equal((await claim(prepared.preview_id)).secret_arn, null);
    const expired = await prepare(ID.viewer, {version: 4});
    await claim(expired.preview_id);
    await privileged("UPDATE app.external_postgis_previews SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.preview_id]);
    assert.equal(await finish(expired.preview_id), false);
    assert.equal((await claim(expired.preview_id)).claim_status, "already_running");
    const replacement = await prepare(ID.viewer, {version: 4});
    await claim(replacement.preview_id);
    assert.equal(await finish(replacement.preview_id, {returned: 100, truncated: true}), true);
    const columns = (await privileged("SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='external_postgis_previews'")).rows.map(row => row.column_name);
    for (const forbidden of ["geojson", "result", "source_configuration", "secret_arn", "features"]) assert.ok(!columns.includes(forbidden));
    const audit = (await privileged("SELECT payload FROM app.activity_events WHERE event_type LIKE 'dataset.postgis.%'")).rows;
    assert.doesNotMatch(JSON.stringify(audit), /secret_arn|password|gis\.example|coordinates|FeatureCollection/);
    assert.equal((await privileged("SELECT count(*)::integer AS count FROM app.data_objects")).rows[0].count, 0);
  });
});
