import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";

const PROJECT_ID = "60000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const summary = version => ({version, definition_bytes: 20, change_message: null,
  created_by: USER_ID, created_at: "2026-10-05T12:00:00Z"});
const response = value => new Response(JSON.stringify(value), {status: 200, headers: {"Content-Type": "application/json"}});
function client(fetchImplementation) {
  return new OpenGeoApiClient({tokenProvider: () => "local-test",
    organizationProvider: () => "10000000-0000-4000-8000-000000000001", fetchImplementation});
}

it("lists bounded Project history metadata by exact descending cursor without reading definitions", async () => {
  const calls = [];
  const adapter = client(async (url, options) => {calls.push([url, options]); return response([summary(3), summary(1)]);});
  const versions = await adapter.listCompositionVersions(PROJECT_ID, {limit: 2, beforeVersion: 4});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `/api/compositions/${PROJECT_ID}/versions?limit=2&before_version=4`);
  assert.equal(calls[0][1].method, "GET");
  assert.deepEqual(versions.map(item => item.version), [3, 1]);
  assert.equal(versions[0].createdBy, USER_ID);
  assert.equal(Object.hasOwn(versions[0], "definition"), false);
});

it("rejects invalid request bounds before network and inconsistent history order or cursor", async () => {
  const adapter = client(() => assert.fail("No request expected"));
  for (const options of [{limit: 0}, {limit: 101}, {limit: 1.5}, {beforeVersion: 0}]) {
    await assert.rejects(adapter.listCompositionVersions(PROJECT_ID, options), TypeError);
  }
  for (const payload of [[summary(1), summary(2)], [summary(2), summary(2)], [summary(5)], [summary(3), summary(2), summary(1)]]) {
    await assert.rejects(client(async () => response(payload)).listCompositionVersions(PROJECT_ID, {limit: 2, beforeVersion: 5}),
      {code: "invalid_api_response"});
  }
});

it("returns an exact retained definition without normalizing historical schema or extension fields", async () => {
  const definition = {schemaVersion: "opengeo.map-definition.1.0.0", mapViews: [], extensions: {unknown: {value: "é🌏"}}};
  let request;
  const adapter = client(async (url, options) => {request = [url, options]; return response({...summary(2), definition});});
  const retained = await adapter.getCompositionVersion(PROJECT_ID, 2);
  assert.equal(request[0], `/api/compositions/${PROJECT_ID}/versions/2`);
  assert.equal(request[1].method, "GET");
  assert.deepEqual(retained.definition, definition);
  assert.equal(retained.version, 2);
});

it("uses PostgreSQL character bounds for Unicode change messages", async () => {
  const change_message = "🌏".repeat(500);
  const retained = await client(async () => response({...summary(2), change_message, definition: {}}))
    .getCompositionVersion(PROJECT_ID, 2);
  assert.equal(retained.changeMessage, change_message);
  await assert.rejects(client(async () => response({...summary(2), change_message: change_message + "x", definition: {}}))
    .getCompositionVersion(PROJECT_ID, 2), {code: "invalid_api_response"});
});

it("rejects a substituted, missing or oversized exact definition and propagates current access denial", async () => {
  for (const payload of [{...summary(3), definition: {}}, summary(2), {...summary(2), definition: {value: "x".repeat(524_288)}},
    {...summary(2), definition_bytes: 524_289, definition: {}}]) {
    await assert.rejects(client(async () => response(payload)).getCompositionVersion(PROJECT_ID, 2), {code: "invalid_api_response"});
  }
  const revoked = client(async () => new Response(JSON.stringify({detail: "composition_not_found"}), {status: 404}));
  await assert.rejects(revoked.getCompositionVersion(PROJECT_ID, 2), error => error.status === 404);
});

it("keeps fixture history detached and immutable across saves and current access removal", async () => {
  const catalog = JSON.parse(await readFile(new URL("../src/data/catalog.json", import.meta.url), "utf8"));
  const adapter = new FixturePlatformAdapter(catalog);
  const {projectId, mapId} = FIXTURE_PROJECTS[0];
  const baseline = await adapter.getCompositionVersion(mapId, 1);
  const map = await adapter.getComposition(mapId);
  const definition = {...map.definition, extensions: {retained: "original"}};
  await adapter.updateMap(projectId, mapId, {expectedVersion: 1, changes: {definition}, changeMessage: "Use exact pin"});
  definition.extensions.retained = "mutated";
  const versions = await adapter.listCompositionVersions(mapId, {limit: 1});
  assert.equal(versions[0].version, 2);
  assert.equal(versions[0].changeMessage, "Use exact pin");
  assert.equal(Object.hasOwn(versions[0], "definition"), false);
  assert.deepEqual(await adapter.listCompositionVersions(mapId, {beforeVersion: 2}), [{
    version: baseline.version, definitionBytes: baseline.definitionBytes, changeMessage: baseline.changeMessage,
    createdBy: baseline.createdBy, createdAt: baseline.createdAt
  }]);
  const retained = await adapter.getCompositionVersion(mapId, 2);
  assert.equal(retained.definition.extensions.retained, "original");
  retained.definition.extensions.retained = "outside mutation";
  assert.equal((await adapter.getCompositionVersion(mapId, 2)).definition.extensions.retained, "original");
  assert.deepEqual(await adapter.getCompositionVersion(mapId, 1), baseline);
  adapter.projectBindings = adapter.projectBindings.filter(binding => binding.projectId !== projectId);
  await assert.rejects(adapter.listCompositionVersions(mapId));
  await assert.rejects(adapter.getCompositionVersion(mapId, 2));
});
