import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  adaptResourceReference, assertResourceReference, createResourceEnvelope, createResourceReference,
  resourceReferenceKey, validatePortableData, validateResourceEnvelope, validateResourceReference
} from "../src/index.js";

const reference = createResourceReference({authority: "urn:example:archive", resourceId: "asset_1",
  resourceType: "asset", workspaceId: "workspace_a", versionId: "sha256:abc"});

test("portable identity survives serialization and does not collapse authority, scope or version", () => {
  const envelope = createResourceEnvelope({reference, extensions: {"esia:review": {observed_at: null, status: "unreviewed"}},
    relationships: [{type: "derived_from", target: reference}]});
  assert.deepEqual(validateResourceEnvelope(JSON.parse(JSON.stringify(envelope))), []);
  assert.ok(Object.isFrozen(envelope.extensions["esia:review"]));
  assert.equal(envelope.extensions["esia:review"].observed_at, null);
  for (const patch of [{authority: "urn:example:other"}, {workspace_id: "workspace_b"}, {version_id: "v2"}]) {
    assert.notEqual(resourceReferenceKey(reference), resourceReferenceKey({...reference, ...patch}));
  }
  assert.equal(resourceReferenceKey(reference, {includeVersion: false}),
    resourceReferenceKey({...reference, version_id: "v2"}, {includeVersion: false}));
});

test("legacy adapters require an explicit verified scope and selected existing version", () => {
  const legacy = {id: "document_1", accountId: "account_a", revision: "revision_3", original: {title: "Untouched"}};
  const mapping = {authority: "urn:example:esia", resourceType: "document", workspaceId: "workspace_a",
    idField: "id", scopeField: "accountId", expectedScope: "account_a", versionField: "revision"};
  const before = structuredClone(legacy);
  assert.equal(adaptResourceReference(legacy, mapping).version_id, "revision_3");
  assert.deepEqual(legacy, before);
  assert.throws(() => adaptResourceReference(legacy, {...mapping, expectedScope: "account_b"}), /matching scope/);
  assert.throws(() => adaptResourceReference(legacy, {...mapping, versionField: "missing"}), /version is missing/);
  assert.throws(() => adaptResourceReference(Object.create(legacy), mapping), /mapping/);
});

test("immutable references require a real version; unknown boundary fields are rejected", () => {
  assert.deepEqual(validateResourceReference(reference, {immutable: true}), []);
  const {version_id, ...unversioned} = reference;
  assert.throws(() => assertResourceReference(unversioned, {immutable: true}), /version/);
  for (const patch of [{schema_version: "1"}, {version_id: " "}, {workspace_id: ""}, {permissions: ["edit"]}]) {
    assert.ok(validateResourceReference({...reference, ...patch}).length);
  }
  assert.throws(() => createResourceEnvelope({reference, aliases: [reference, reference]}), /duplicate alias/);
  assert.throws(() => createResourceEnvelope({reference, extensions: {unqualified: {}}}), /namespaced/);
});

test("portable records reject secrets, signed addresses, non-JSON data and excessive depth/bytes", () => {
  for (const value of [{api_key: "synthetic"}, {"provider:token": "synthetic"}, {url: "https://user:pass@example.invalid"},
    {url: "https://example.invalid/file?X-Amz-Signature=synthetic"}, {value: NaN}, {value: new Date()},
    {value: undefined}, {value: Array(2)}, {value: "界".repeat(22000)}]) {
    assert.ok(validatePortableData(value).length, "unsafe portable value must be rejected");
  }
  const cycle = {}; cycle.self = cycle;
  assert.ok(validatePortableData(cycle).length);
  assert.ok(validateResourceEnvelope(cycle).length);
  const shared = {status: "known"};
  assert.deepEqual(validatePortableData({a: shared, b: shared}), []);
  let deep = {}; for (let i = 0; i < 26; i++) deep = {next: deep};
  assert.ok(validatePortableData(deep).length);
  const getter = Object.defineProperty({}, "value", {enumerable: true, get() { throw Error("must not execute"); }});
  assert.ok(validatePortableData(getter).length);
});

test("versioned conformance fixtures exercise the runtime boundary", () => {
  const cases = JSON.parse(readFileSync(new URL("./interoperability-fixtures.json", import.meta.url)));
  for (const fixture of cases) {
    const errors = fixture.kind === "envelope" ? validateResourceEnvelope(fixture.value) :
      validateResourceReference(fixture.value, {immutable: fixture.kind === "immutableReference"});
    assert.equal(errors.length === 0, fixture.valid, fixture.name);
  }
});
