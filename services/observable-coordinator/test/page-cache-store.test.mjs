import assert from "node:assert/strict";
import {test} from "node:test";
import {AwsPageCacheStore, configuredPageCacheStore, PAGE_CACHE_PREFIX, PAGE_CACHE_MAX_AGE_SECONDS} from "../src/page-cache-store.mjs";
import {sha256} from "../src/contracts.mjs";

const ids = Array.from({length: 6}, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const settings = {region: "us-east-1", bucket: "source.opengeo.tools",
  compilerImageDigest: `sha256:${"a".repeat(64)}`,
  kmsKeyArn: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000001"};
const scope = {organizationId: ids[0], projectId: ids[1], sourceProjectId: ids[2],
  compilerImageDigest: settings.compilerImageDigest, frameworkVersion: "1.13.4"};
const evidence = {buildJobId: ids[3], sourceRevisionId: ids[4], outputTreeChecksumSha256: "b".repeat(64)};
const cacheOf = text => {const body = Buffer.from(text); return {body, checksumSha256: sha256(body)};};

function fixture() {
  const calls = [], objects = new Map();
  let version = 0;
  const client = {async request(request) {
    calls.push(request);
    assert.equal(request.service, "s3");
    assert.equal(request.host, "s3.us-east-1.amazonaws.com");
    assert(request.path.startsWith(`/source.opengeo.tools/${PAGE_CACHE_PREFIX}`));
    const current = objects.get(request.path);
    if (request.method === "GET") {
      return current ? new Response(current.body, {status: 200, headers: current.headers}) :
        new Response("missing", {status: 404});
    }
    assert.equal(request.method, "PUT");
    const headers = request.headers;
    if (headers["if-none-match"] === "*" ? current !== undefined : headers["if-match"] !== current?.headers.etag) {
      return new Response("conflict", {status: 412});
    }
    assert.equal(headers["x-amz-checksum-sha256"], Buffer.from(sha256(request.body), "hex").toString("base64"));
    const storedHeaders = {...headers, etag: `"etag-${++version}"`, "x-amz-version-id": `v${version}`};
    objects.set(request.path, {body: Buffer.from(request.body), headers: storedHeaders});
    return new Response("", {status: 200, headers: storedHeaders});
  }};
  const makeStore = () => new AwsPageCacheStore(settings, {sourceProjectIds: [scope.sourceProjectId], client});
  return {calls, objects, makeStore, store: makeStore()};
}

test("cache storage is off by default and requires an explicit bounded source-project allowlist", () => {
  assert.equal(configuredPageCacheStore(settings, {}), undefined);
  assert.equal(configuredPageCacheStore(settings, {OPEN_GEO_OBSERVABLE_PAGE_CACHE_SOURCE_PROJECT_IDS: ""}), undefined);
  const store = configuredPageCacheStore(settings, {OPEN_GEO_OBSERVABLE_PAGE_CACHE_SOURCE_PROJECT_IDS: ids[2]});
  assert.equal(store.supports(scope), true);
  assert.equal(store.supports({...scope, sourceProjectId: ids[5]}), false);
  for (const list of [[], [ids[2], ids[2]], ["*"], ["../"], Array(21).fill(ids[2])]) {
    assert.throws(() => new AwsPageCacheStore(settings, {sourceProjectIds: list}), /page_cache_configuration_invalid/);
  }
});

test("one GET and conditional PUT persist a bounded private cache across fresh store instances", async () => {
  const {store, calls, makeStore} = fixture();
  const cache = cacheOf("first compiled snapshot");
  assert.equal(await store.read(scope), null);
  assert.equal((await store.write(scope, cache, evidence)).status, "written");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["if-none-match"], "*");
  assert.equal(calls[1].headers["x-amz-server-side-encryption"], "aws:kms");
  assert.equal(calls[1].headers["x-amz-server-side-encryption-bucket-key-enabled"], "true");
  assert.equal(calls[1].headers["x-amz-server-side-encryption-aws-kms-key-id"], settings.kmsKeyArn);
  assert.equal(calls[0].maximumResponseBytes, 32 * 1024 * 1024);
  assert.equal(calls[1].headers["x-amz-meta-build-id"], evidence.buildJobId);
  assert.deepEqual(await makeStore().read(scope), cache);
  assert.equal(calls.length, 3, "No listing, HEAD or version discovery requests");
});

test('account admission enables a new source only for its verified scope and build evidence', async () => {
  const {calls, store: legacy} = fixture();
  const store = new AwsPageCacheStore(settings, {accountAdmission: true, client: legacy.client});
  const admitted = {...scope, buildJobId: evidence.buildJobId, sourceRevisionId: evidence.sourceRevisionId,
    maxBytes: 33554432, maxAgeSeconds: PAGE_CACHE_MAX_AGE_SECONDS};
  assert.equal(store.supports(scope), false);
  assert.equal(await store.read(scope), null);
  assert.equal(calls.length, 0);
  assert.equal(store.authorize(scope, null, evidence), false);
  for (const changed of [{organizationId: ids[5]}, {projectId: ids[5]}, {sourceProjectId: ids[5]},
    {buildJobId: ids[5]}, {compilerImageDigest: `sha256:${'d'.repeat(64)}`}, {maxBytes: 999999999}, {bucket:'other'}]) {
    assert.throws(()=>store.authorize(scope, {...admitted, ...changed}, evidence), /admission_invalid/);
    assert.equal(store.supports(scope), false);
  }
  assert.equal(store.authorize(scope, admitted, evidence), true);
  assert.equal(store.supports(scope), true);
  assert.equal(store.supports({...scope, organizationId:ids[5]}), false);
  await store.read(scope);
  await assert.rejects(store.write(scope, cacheOf('snapshot'), {...evidence, buildJobId:ids[5]}), /admission_invalid/);
  assert.equal((await store.write(scope, cacheOf('snapshot'), evidence)).status, 'written');
  assert.equal(store.authorize(scope, null, evidence), false, 'a fresh denial clears admission');
  assert.equal((await store.write(scope, cacheOf('snapshot'), evidence)).status, 'disabled');
  assert.equal(configuredPageCacheStore(settings, {OPEN_GEO_OBSERVABLE_PAGE_CACHE_ADMISSION:'account'}).requiresAdmission,true);
  assert.throws(()=>configuredPageCacheStore(settings, {OPEN_GEO_OBSERVABLE_PAGE_CACHE_ADMISSION:'account',OPEN_GEO_OBSERVABLE_PAGE_CACHE_SOURCE_PROJECT_IDS:ids[2]}), /configuration_invalid/);
  assert.throws(()=>configuredPageCacheStore(settings, {OPEN_GEO_OBSERVABLE_PAGE_CACHE_ADMISSION:'all'}), /configuration_invalid/);
});

test("reviewed compiler transitions retain separate cache keys for each exact image", async () => {
  const fixtureState = fixture();
  const replacement = `sha256:${"d".repeat(64)}`;
  const transitioned = new AwsPageCacheStore({...settings, compilerImageDigest: replacement,
    compilerImageDigests: [settings.compilerImageDigest, replacement]},
    {sourceProjectIds: [scope.sourceProjectId], client: fixtureState.store.client});
  const newerScope = {...scope, compilerImageDigest: replacement};
  await transitioned.read(scope);
  await transitioned.write(scope, cacheOf("old compiler"), evidence);
  assert.equal(await transitioned.read(newerScope), null);
  await transitioned.write(newerScope, cacheOf("new compiler"), evidence);
  assert.equal(fixtureState.objects.size, 2);
  assert.deepEqual(await transitioned.read(scope), cacheOf("old compiler"));
  assert.deepEqual(await transitioned.read(newerScope), cacheOf("new compiler"));
  await assert.rejects(() => transitioned.read({...scope, compilerImageDigest: `sha256:${"f".repeat(64)}`}), /page_cache_scope_invalid/);
});

test("unchanged snapshots cause no PUT and changed snapshots use the observed ETag", async () => {
  const {store, calls} = fixture();
  const first = cacheOf("same snapshot");
  await store.read(scope);
  await store.write(scope, first, evidence);
  await store.read(scope);
  assert.equal((await store.write(scope, first, evidence)).status, "unchanged");
  assert.equal(calls.length, 3);
  await store.read(scope);
  await store.write(scope, cacheOf("updated snapshot"), evidence);
  assert.equal(calls.length, 5);
  assert.equal(calls[4].headers["if-match"], '"etag-1"');
  assert.equal(calls[4].headers["if-none-match"], undefined);
});

test("concurrent updates and creates never overwrite a newer observed version or retry", async () => {
  for (const existing of [false, true]) {
    const {store, makeStore, calls} = fixture();
    if (existing) {await store.read(scope); await store.write(scope, cacheOf("initial"), evidence);}
    const rival = makeStore();
    await store.read(scope);
    await rival.read(scope);
    await store.write(scope, cacheOf("winner"), evidence);
    const count = calls.length;
    assert.equal((await rival.write(scope, cacheOf("loser"), evidence)).status, "superseded");
    assert.equal(calls.length, count + 1);
    assert.deepEqual(await makeStore().read(scope), cacheOf("winner"));
  }
});

test("missing-object 403 uses conditional create, never blind overwrite", async () => {
  const calls = [];
  const store = new AwsPageCacheStore(settings, {sourceProjectIds: [ids[2]], client: {async request(request) {
    calls.push(request);
    return new Response("denied or exists", {status: request.method === "GET" ? 403 : 412});
  }}});
  assert.equal(await store.read(scope), null);
  assert.equal((await store.write(scope, cacheOf("new"), evidence)).status, "superseded");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["if-none-match"], "*");
});

test("corrupt, foreign-scope and incorrectly encrypted cache records are not returned", async () => {
  for (const mutate of [object => {object.body = Buffer.from("tampered");},
    object => {object.headers["x-amz-meta-scope-sha256"] = "0".repeat(64);},
    object => {object.headers["x-amz-server-side-encryption"] = "AES256";},
    object => {delete object.headers["x-amz-meta-build-id"];},
    object => {object.headers["x-amz-meta-sha256"] = "bad";}]) {
    const {store, objects} = fixture();
    await store.read(scope); await store.write(scope, cacheOf("original"), evidence);
    mutate([...objects.values()][0]);
    assert.equal(await store.read(scope), null);
    assert.equal((await store.write(scope, cacheOf("repaired"), evidence)).status, "written");
    assert.deepEqual(await store.read(scope), cacheOf("repaired"));
  }
});

test("invalid scopes, evidence, oversized data and unselected projects cause no storage writes", async () => {
  const {store, calls} = fixture();
  for (const changes of [{organizationId: "../elsewhere"}, {compilerImageDigest: `sha256:${"f".repeat(64)}`},
    {frameworkVersion: "other"}, {bucket: "other-bucket"}]) {
    await assert.rejects(store.read({...scope, ...changes}), /page_cache_scope_invalid/);
  }
  const disabled = {...scope, sourceProjectId: ids[5]};
  assert.equal(await store.read(disabled), null);
  assert.equal((await store.write(disabled, cacheOf("any"), evidence)).status, "disabled");
  assert.equal(calls.length, 0);
  assert.equal((await store.write(scope, cacheOf("any"), evidence)).status, "not_observed");
  await assert.rejects(store.write(scope, cacheOf("any"), {...evidence, buildJobId: "bad"}), /admission_invalid/);
  const body = Buffer.alloc(32 * 1024 * 1024 + 1);
  await assert.rejects(store.write(scope, {body, checksumSha256: sha256(body)}, evidence), /admission_invalid/);
  assert.equal(calls.length, 0);
});

test("oversized GET is stopped and a transient read failure cannot authorize a cache write", async () => {
  const store = new AwsPageCacheStore(settings, {sourceProjectIds: [ids[2]], client: {async request() {
    return new Response("x", {headers: {etag: '"v1"', "content-length": String(32 * 1024 * 1024 + 1)}});
  }}});
  await assert.rejects(store.read(scope));
  let requests = 0;
  const unavailable = new AwsPageCacheStore(settings, {sourceProjectIds: [ids[2]], client: {async request() {
    requests++; return new Response("unavailable", {status: 503});
  }}});
  await assert.rejects(unavailable.read(scope), /page_cache_read_unavailable/);
  assert.equal((await unavailable.write(scope, cacheOf("new"), evidence)).status, "not_observed");
  assert.equal(requests, 1);
});

test('expired snapshots are rebuilt and conditionally refreshed, not silently reused', async () => {
  const {store, calls, objects} = fixture();
  let now = Date.parse('2026-09-15T00:00:00.000Z');
  store.now = () => now;
  const cache = cacheOf('same compiled output');
  await store.read(scope);
  await store.write(scope, cache, evidence);
  const first = [...objects.values()][0];
  assert.equal(first.headers['x-amz-meta-created-at'], '2026-09-15T00:00:00.000Z');
  assert.equal(first.headers['x-amz-meta-expires-at'], '2026-09-22T00:00:00.000Z');
  now += PAGE_CACHE_MAX_AGE_SECONDS * 1000 - 1;
  assert.deepEqual(await store.read(scope), cache);
  assert.equal((await store.write(scope, cache, evidence)).status, 'unchanged');
  now++;
  assert.equal(await store.read(scope), null);
  assert.equal((await store.write(scope, cache, evidence)).status, 'written');
  assert.equal(calls.at(-1).headers['if-match'], first.headers.etag);
  assert.deepEqual(await store.read(scope), cache);
});

test('legacy, future-dated and overlong cache lifetimes are rejected without trusting content hashes', async () => {
  for (const mutate of [
    headers => {delete headers['x-amz-meta-created-at']; delete headers['x-amz-meta-expires-at'];},
    headers => {headers['x-amz-meta-created-at'] = '2026-09-16T00:00:00.000Z';},
    headers => {headers['x-amz-meta-expires-at'] = '2027-09-15T00:00:00.000Z';},
    headers => {headers['x-amz-meta-expires-at'] = 'invalid';},
    headers => {headers['x-amz-meta-expires-at'] = '2026-09-14T00:00:00.000Z';}
  ]) {
    const {store, objects} = fixture();
    store.now = () => Date.parse('2026-09-15T00:00:00.000Z');
    await store.read(scope);
    await store.write(scope, cacheOf('snapshot'), evidence);
    mutate([...objects.values()][0].headers);
    assert.equal(await store.read(scope), null);
  }
});
