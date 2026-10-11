import assert from "node:assert/strict";
import test from "node:test";
import {createCollectionDefinition, validateCollectionDefinition} from "../src/collections.js";
import {createResourceReference} from "../src/interoperability.js";
const ref = (resourceId, resourceType = "project", workspaceId = "workspace_a", versionId) => createResourceReference({authority: "urn:categori:fixture", resourceId, resourceType, workspaceId, versionId});
const owner = {authority: "urn:categori:fixture", principal_type: "user", principal_id: "owner_a"};
const options = {reference: ref("collection_a", "collection"), owner, title: "Joint research", entries: [
  {entry_id: "entry_b", reference: ref("project_b", "project", "workspace_b")},
  {entry_id: "entry_a", reference: ref("project_a")}, {entry_id: "entry_unavailable", reference: null}]};

test("Collection preserves its own identity, ordered foreign-scope references and unavailable slots", () => {
  const value = createCollectionDefinition(options);
  assert.equal(value.reference.workspace_id, "workspace_a");
  assert.deepEqual(value.entries.map(entry => entry.entry_id), ["entry_b", "entry_a", "entry_unavailable"]);
  assert.equal(value.entries[0].reference.workspace_id, "workspace_b");
  assert.equal(value.entries[2].reference, null);
  assert.deepEqual(value.audience, {kind: "restricted", scope: null});
  assert.deepEqual(value.owner, owner);
  assert.equal(value.owner.workspace_id, undefined);
  assert.equal(Object.isFrozen(value.entries[0].reference), true);
  assert.notEqual(value.entries, options.entries);
});
test("Public audience metadata preserves exact edition identities without accepting grant fields", () => {
  const value = createCollectionDefinition({...options, audience: {kind: "public", scope: null}, entries: [
    {entry_id: "edition_a", reference: ref("asset", "document", "workspace_a", "revision_a")},
    {entry_id: "edition_b", reference: ref("asset", "document", "workspace_a", "revision_b")}]});
  assert.equal(value.entries.length, 2); assert.equal(value.permissions, undefined);
  assert.ok(validateCollectionDefinition({...value, grants: ["view"]}).length);
});
test("Malformed, duplicated, excessive and authority-less Collection records are rejected", () => {
  for (const change of [{entries: Array(201).fill(options.entries[0])}, {entries: [options.entries[0], options.entries[0]]},
    {entries: [{...options.entries[0], reference: {resource_id: "unknown"}}]}, {entries: [{entry_id: "missing"}]},
    {recordRevision: 0}, {title: " "}, {owner: {...owner, principal_id: "owner\n"}}, {audience: {kind: "account", scope: null}},
    {reference: ref("collection_a", "handoff_collection")}, {reference: ref("collection_a", "collection", "workspace_a", "edition") }]) {
    assert.throws(() => createCollectionDefinition({...options, ...change}), TypeError);
  }
  const duplicateReference = [...options.entries.slice(0, 1), {...options.entries[0], entry_id: "other_entry"}];
  assert.throws(() => createCollectionDefinition({...options, entries: duplicateReference}), /duplicate exact resource/);
});

test("Scoped audience requires exact owning authority and workspace; context does not relabel ownership", () => {
  const scope = ref("workspace_a", "workspace");
  const agency = ref("agency_a", "organization", "agency_workspace");
  const value = createCollectionDefinition({...options, audience: {kind: "scope", scope}, contexts: [agency]});
  assert.deepEqual(value.owner, owner);
  assert.deepEqual(value.contexts, [agency]);
  assert.equal(value.entries[0].reference.workspace_id, "workspace_b");
  for (const wrongScope of [{...scope, authority: "urn:categori:other"}, {...scope, resource_id: "other"},
    {...scope, workspace_id: "other"}, {...scope, resource_type: "organization"}, {...scope, version_id: "edition"}]) {
    assert.throws(() => createCollectionDefinition({...options, audience: {kind: "scope", scope: wrongScope}}), /owning security workspace/);
  }
  assert.throws(() => createCollectionDefinition({...options, audience: {kind: "public", scope}}), /null scope/);
  assert.throws(() => createCollectionDefinition({...options, contexts: [agency, agency]}), /duplicate context/);
});

test("Owner metadata permits declared principal kinds without inventing identity or authorization fields", () => {
  for (const principal_type of ["user", "team", "organization"]) {
    const value = createCollectionDefinition({...options, owner: {...owner, principal_type}});
    assert.equal(value.owner.principal_type, principal_type);
    assert.deepEqual(value.contexts, []);
  }
  for (const change of [{authority: "https://user:password@example.test/api"}, {authority: "https://example.test/api?token=secret"},
    {authority: "https://example.test/api#fragment"}, {principal_type: "agency"}, {principal_id: ""}, {workspace_id: "invented"}, {role: "owner"}]) {
    assert.throws(() => createCollectionDefinition({...options, owner: {...owner, ...change}}), TypeError);
  }
  assert.throws(() => createCollectionDefinition({...options, entries: [{entry_id: "unavailable", reference: null, title: "private target"}]}), /unsupported field/);
});
