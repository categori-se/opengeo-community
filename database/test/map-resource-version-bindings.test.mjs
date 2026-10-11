import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {after, afterEach, before, beforeEach, describe, it} from "node:test";
import {PGlite} from "@electric-sql/pglite";

const org = randomUUID(), otherOrg = randomUUID();
const actor = randomUUID(), otherActor = randomUUID();
const project = randomUUID(), otherProject = randomUUID(), foreignProject = randomUUID();
let db;

async function context(organization = org, user = actor) {
  await db.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [organization, user]);
}

async function makeMap({history = true, projectId = project, organization = org} = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO app.maps
    (id, organization_id, project_id, name, created_by, updated_by)
    VALUES ($1, $2, $3, 'Saved map', $4, $4)`, [id, organization, projectId, actor]);
  if (history) await appendMap(id, 1, organization);
  return id;
}

async function appendMap(mapId, number, organization = org) {
  await db.query(`INSERT INTO app.map_versions
    (organization_id, map_id, version, definition, created_by)
    VALUES ($1, $2, $3, $4::jsonb, $5)`,
  [organization, mapId, number, JSON.stringify({layers: [], revision: number}), actor]);
  await db.query("UPDATE app.maps SET version = $1 WHERE id = $2", [number, mapId]);
}

async function makeResource({kind = "map", mapId, projectId = project, organization = org} = {}) {
  if (mapId === undefined && kind === "map") mapId = await makeMap({projectId, organization});
  const id = randomUUID(), versionId = randomUUID();
  await db.query(`INSERT INTO app.governed_resources
    (id, organization_id, project_id, kind, slug, map_id, current_version_id,
     owner_user_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)`,
  [id, organization, projectId, kind, `map-${id}`, mapId ?? null, versionId, actor]);
  await appendVersion(id, 1, {versionId, organization});
  return {id, versionId, mapId};
}

async function appendVersion(resourceId, number, {versionId = randomUUID(), organization = org, creator = actor} = {}) {
  await db.query(`INSERT INTO app.governed_resource_versions
    (id, organization_id, resource_id, version_number, title, provenance, created_by)
    VALUES ($1, $2, $3, $4, 'Map metadata', '{"mapVersion":999,"mapId":"untrusted"}', $5)`,
  [versionId, organization, resourceId, number, creator]);
  return versionId;
}

async function bind(resourceId, versionId, expected = null) {
  const result = await db.query("SELECT app.bind_map_resource_version($1, $2, $3) AS bound", [resourceId, versionId, expected]);
  return result.rows[0].bound;
}

async function binding(versionId) {
  return (await db.query(`SELECT binding.map_id, binding.map_version, history.definition
    FROM app.map_resource_version_bindings binding
    JOIN app.map_versions history ON history.organization_id = binding.organization_id
      AND history.map_id = binding.map_id AND history.version = binding.map_version
    WHERE binding.resource_version_id = $1`, [versionId])).rows[0];
}

async function rejects(sql, parameters = [], pattern = /permission denied/, privileged = false) {
  await db.exec("SAVEPOINT rejected");
  try {
    if (privileged) await db.exec("SET LOCAL ROLE NONE");
    await assert.rejects(db.query(sql, parameters), pattern);
  } finally {
    await db.exec("ROLLBACK TO SAVEPOINT rejected; RELEASE SAVEPOINT rejected");
  }
}

describe("0084 immutable saved-map resource version bindings", () => {
  before(async () => {
    db = new PGlite();
    for (const file of [
      "0001_platform_foundation.sql", "0002_membership_invitations.sql",
      "0003_managed_ingestion_foundation.sql", "0004_worker_execution_boundary.sql",
      "0005_catalog_access.sql", "0006_governed_external_sources.sql",
      "0007_governed_pmtiles_sources.sql", "0008_recoverable_project_imports.sql",
      "0009_governed_resources.sql", "0010_resource_governance.sql",
      "0082_unique_governed_map_resources.sql", "0084_map_resource_version_bindings.sql"
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await db.exec(sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pgcrypto|postgis);\n/gm, ""));
    }
    await db.exec(`
      CREATE ROLE opengeo_connector;
      CREATE ROLE opengeo_observable_coordinator;
      CREATE ROLE opengeo_dataset_verifier;
      CREATE ROLE opengeo_source_archiver;
      CREATE ROLE opengeo_repository_copier;
      INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
        ('${actor}', 'map-binding-owner', 'map-owner@local.invalid', 'Map owner'),
        ('${otherActor}', 'map-binding-editor', 'map-editor@local.invalid', 'Other editor');
      INSERT INTO app.organizations (id, name, slug, created_by) VALUES
        ('${org}', 'Saved maps', 'saved-maps', '${actor}'),
        ('${otherOrg}', 'Other saved maps', 'other-saved-maps', '${actor}');
      INSERT INTO app.organization_memberships (organization_id, user_id, role, invited_by) VALUES
        ('${org}', '${actor}', 'admin', '${actor}'),
        ('${org}', '${otherActor}', 'member', '${actor}'),
        ('${otherOrg}', '${actor}', 'admin', '${actor}');
      INSERT INTO app.projects (id, organization_id, name, created_by) VALUES
        ('${project}', '${org}', 'Saved map project', '${actor}'),
        ('${otherProject}', '${org}', 'Other project', '${actor}'),
        ('${foreignProject}', '${otherOrg}', 'Other tenant project', '${actor}');
    `);
  });
  beforeEach(async () => {
    await db.exec("BEGIN; SET LOCAL ROLE opengeo_runtime");
    await context();
  });
  afterEach(async () => { await db.exec("ROLLBACK; RESET ROLE"); });
  after(async () => { await db.close(); });

  it("pins the first resource version to exact saved history without trusting authored provenance", async () => {
    const resource = await makeResource();
    assert.equal(await bind(resource.id, resource.versionId), true);
    assert.deepEqual(await binding(resource.versionId), {
      map_id: resource.mapId, map_version: 1, definition: {layers: [], revision: 1}
    });
    assert.equal(await bind(resource.id, resource.versionId, 1), false);
  });

  it("inherits metadata-only successors before the resource head advances despite newer map saves", async () => {
    const resource = await makeResource();
    assert.equal(await bind(resource.id, resource.versionId), true);
    await appendMap(resource.mapId, 2);
    const next = await appendVersion(resource.id, 2);
    assert.equal(await bind(resource.id, next), true);
    assert.equal((await binding(next)).map_version, 1);
    const head = await db.query("SELECT current_version_id FROM app.governed_resources WHERE id = $1", [resource.id]);
    assert.equal(head.rows[0].current_version_id, resource.versionId);
  });

  it("inherits the nearest previous binding across gaps and deliberately pins a newly selected revision", async () => {
    const resource = await makeResource();
    assert.equal(await bind(resource.id, resource.versionId), true);
    await appendMap(resource.mapId, 2);
    await appendVersion(resource.id, 2);
    const third = await appendVersion(resource.id, 3);
    assert.equal(await bind(resource.id, third), true);
    assert.equal((await binding(third)).map_version, 1);
    const fourth = await appendVersion(resource.id, 4);
    assert.equal(await bind(resource.id, fourth, 2), true);
    await appendMap(resource.mapId, 3);
    const fifth = await appendVersion(resource.id, 5);
    assert.equal(await bind(resource.id, fifth), true);
    assert.deepEqual(await binding(fifth), {
      map_id: resource.mapId, map_version: 2, definition: {layers: [], revision: 2}
    });
    assert.equal((await binding(resource.versionId)).map_version, 1);
  });

  it("rejects stale, invalid, future and historical expected versions without creating a binding", async () => {
    const resource = await makeResource();
    await appendMap(resource.mapId, 2);
    for (const expected of [0, -1, 1, 3]) assert.equal(await bind(resource.id, resource.versionId, expected), false);
    assert.equal(await binding(resource.versionId), undefined);
    assert.equal(await bind(resource.id, resource.versionId, 2), true);
  });

  it("requires explicit selection for legacy later versions and refuses missing map history", async () => {
    const legacy = await makeResource();
    const later = await appendVersion(legacy.id, 2);
    assert.equal(await bind(legacy.id, later), false);
    assert.equal(await bind(legacy.id, later, 1), true);
    const incomplete = await makeResource({mapId: await makeMap({history: false})});
    assert.equal(await bind(incomplete.id, incomplete.versionId), false);
    assert.equal(await bind(incomplete.id, incomplete.versionId, 1), false);
  });

  it("rejects old targets, wrong authors, mismatched resources and missing context", async () => {
    const resource = await makeResource();
    const next = await appendVersion(resource.id, 2, {creator: otherActor});
    assert.equal(await bind(resource.id, resource.versionId, 1), false);
    assert.equal(await bind(resource.id, next, 1), false);
    const other = await makeResource();
    assert.equal(await bind(resource.id, other.versionId, 1), false);
    await context(org, "");
    assert.equal(await bind(other.id, other.versionId, 1), false);
    await context("", actor);
    assert.equal(await bind(other.id, other.versionId, 1), false);
  });

  it("rejects non-map and unbound map resources and cross-project map identities", async () => {
    for (const options of [{kind: "document"}, {mapId: null}]) {
      const resource = await makeResource(options);
      assert.equal(await bind(resource.id, resource.versionId, 1), false);
    }
    const mapId = await makeMap({projectId: otherProject});
    const resourceId = randomUUID();
    await rejects(`INSERT INTO app.governed_resources
      (id, organization_id, project_id, kind, slug, map_id, current_version_id,
       owner_user_id, created_by, updated_by)
      VALUES ($1, $2, $3, 'map', 'wrong-project', $4, $5, $6, $6, $6)`,
    [resourceId, org, project, mapId, randomUUID(), actor], /foreign key/);
  });

  it("hides tenant bindings and denies cross-tenant attempts inside the definer function", async () => {
    const resource = await makeResource();
    assert.equal(await bind(resource.id, resource.versionId), true);
    const next = await appendVersion(resource.id, 2);
    await context(otherOrg);
    assert.deepEqual((await db.query("SELECT * FROM app.map_resource_version_bindings")).rows, []);
    assert.equal(await bind(resource.id, next, 1), false);
    const foreign = await makeResource({projectId: foreignProject, organization: otherOrg});
    await context();
    assert.equal(await bind(foreign.id, foreign.versionId, 1), false);
  });

  it("rejects forged tenant, project, resource-version and saved-history foreign keys", async () => {
    const resource = await makeResource();
    const other = await makeResource();
    const projectMap = await makeMap({projectId: otherProject});
    const valid = [org, project, resource.id, resource.versionId, resource.mapId, 1];
    for (const [index, value] of [[0, otherOrg], [1, otherProject], [3, other.versionId],
      [4, projectMap], [5, 999]]) {
      const parameters = [...valid];
      parameters[index] = value;
      await rejects(`INSERT INTO app.map_resource_version_bindings
        (organization_id, project_id, resource_id, resource_version_id, map_id, map_version)
        VALUES ($1, $2, $3, $4, $5, $6)`, parameters, /foreign key/, true);
    }
  });

  it("enforces read-only runtime bindings and immutable saved definitions even for privileged SQL", async () => {
    const resource = await makeResource();
    assert.equal(await bind(resource.id, resource.versionId), true);
    await rejects("INSERT INTO app.map_resource_version_bindings SELECT * FROM app.map_resource_version_bindings");
    for (const table of ["map_resource_version_bindings", "map_versions"]) {
      const column = table === "map_versions" ? "definition = '{}'::jsonb" : "map_version = 99";
      await rejects(`UPDATE app.${table} SET ${column}`);
      await rejects(`DELETE FROM app.${table}`);
      await rejects(`UPDATE app.${table} SET ${column}`, [], /history is immutable/, true);
      await rejects(`DELETE FROM app.${table}`, [], /history is immutable/, true);
    }
  });

  it("keeps every background role outside binding reads and execution", async () => {
    const rights = await db.query(`SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid = 'app.bind_map_resource_version(uuid,uuid,bigint)'::regprocedure`);
    assert.equal(rights.rows[0].prosecdef, true);
    assert.deepEqual(rights.rows[0].proconfig, ["search_path=pg_catalog, app", "row_security=off"]);
    for (const role of ["opengeo_worker", "opengeo_connector", "opengeo_observable_coordinator",
      "opengeo_dataset_verifier", "opengeo_source_archiver", "opengeo_repository_copier"]) {
      await db.exec("SET LOCAL ROLE opengeo_runtime");
      const deniedRights = await db.query(`SELECT
        has_table_privilege($1, 'app.map_resource_version_bindings', 'SELECT') AS direct_read,
        has_function_privilege($1, 'app.bind_map_resource_version(uuid,uuid,bigint)', 'EXECUTE') AS bind`, [role]);
      assert.deepEqual(deniedRights.rows, [{direct_read: false, bind: false}]);
      await db.exec(`SET LOCAL ROLE ${role}`);
      await rejects("SELECT * FROM app.map_resource_version_bindings");
      await rejects("SELECT app.bind_map_resource_version($1, $2)", [randomUUID(), randomUUID()]);
    }
    await db.exec("SET LOCAL ROLE opengeo_runtime");
  });
});
