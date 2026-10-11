import assert from "node:assert/strict";
import {it} from "node:test";
import {ApiContractError, OpenGeoApiClient, parseMap} from "../src/lib/apiClient.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const ownerUserId = "20000000-0000-4000-8000-000000000002";
const accessContainerId = "50000000-0000-4000-8000-000000000001";
const compositionId = "60000000-0000-4000-8000-000000000001";
const summary = {id: compositionId, resource_type: "project", access_container_id: accessContainerId,
  access_container_name: "Shared access", name: "Analysis", description: null, status: "active",
  version: 2, updated_at: "2026-10-07T12:00:00Z"};
const composition = {...summary, definition: {layers: []}, created_at: "2026-10-07T11:00:00Z"};
const response = value => new Response(JSON.stringify(value), {status: 200, headers: {"Content-Type": "application/json"}});
const client = fetchImplementation => new OpenGeoApiClient({tokenProvider: () => "test-token",
  organizationProvider: () => organizationId, fetchImplementation});

it("preserves the authoritative owner on canonical list/get and forwards cancellation", async () => {
  const requests = [];
  const signal = new AbortController().signal;
  const adapter = client(async (url, options) => {
    requests.push([url, options]);
    return response(url.includes("?") ? [{...summary, owner_user_id: ownerUserId}]
      : {...composition, owner_user_id: ownerUserId});
  });
  const listed = await adapter.listCompositions({status: "all", signal});
  const current = await adapter.getComposition(compositionId, {signal});
  assert.equal(listed[0].ownerUserId, ownerUserId);
  assert.equal(current.ownerUserId, ownerUserId);
  assert.equal(current.accessContainerId, accessContainerId);
  assert.equal(current.id, compositionId);
  assert.equal(requests.length, 2);
  assert.equal(requests[0][0], "/api/compositions?limit=50&offset=0&q=&status=all");
  assert.equal(requests[1][0], `/api/compositions/${compositionId}`);
  assert.ok(requests.every(([, options]) => options.signal === signal));
  assert.ok(requests.every(([, options]) => options.headers.get("X-OpenGeo-Organization") === organizationId));
});

it("keeps absent owners unknown instead of inferring creator, permissions or access-container ownership", async () => {
  const inferred = {created_by: ownerUserId, owner: ownerUserId, can_manage: true};
  for (const owner of [{}, {owner_user_id: null}]) {
    const adapter = client(async url => response(url.includes("?") ? [{...summary, ...inferred, ...owner}]
      : {...composition, ...inferred, ...owner}));
    assert.equal((await adapter.listCompositions())[0].ownerUserId, null);
    assert.equal((await adapter.getComposition(compositionId)).ownerUserId, null);
    assert.equal(parseMap({...composition, project_id: accessContainerId, ...inferred, ...owner}).ownerUserId, null);
  }
});

it("rejects malformed explicit owner identities in canonical list/get and MapRecord parsing", async () => {
  for (const owner_user_id of ["creator", {}, 3]) {
    const adapter = client(async url => response(url.includes("?") ? [{...summary, owner_user_id}]
      : {...composition, owner_user_id}));
    await assert.rejects(adapter.listCompositions(), ApiContractError);
    await assert.rejects(adapter.getComposition(compositionId), ApiContractError);
    assert.throws(() => parseMap({...composition, project_id: accessContainerId, owner_user_id}), ApiContractError);
  }
});
