import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import * as identity from "../src/identity.js";
import * as collaboration from "../src/collaboration.js";

const corpus = JSON.parse(readFileSync(new URL("../conformance/identity.json", import.meta.url), "utf8"));
const operations = {
  validate_external_identity_link: identity.validateExternalIdentityLink,
  validate_identity_user: identity.validateIdentityUser,
  validate_identity_workspace: identity.validateIdentityWorkspace,
  validate_workspace_participation: identity.validateWorkspaceParticipation,
  validate_collaboration_resource: collaboration.validateCollaborationResource,
  validate_resource_grant: input => collaboration.validateResourceGrant(input.record, {resource: input.resource}),
  external_identity_key: identity.externalIdentityKey,
  resolve_identity_user: identity.resolveIdentityUser,
  resolve_scoped_resource_access: identity.resolveScopedResourceAccess,
  resolve_resource_access: collaboration.resolveResourceAccess,
  authorize_scoped_resource: input => identity.authorizeScopedResource(input.options, input.action),
  normalize_collaboration_actions: collaboration.normalizeCollaborationActions
};

test("portable conformance corpus binds the current contract and unique fixed cases", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(corpus.schema_version, 1);
  assert.equal(corpus.contract, manifest.name);
  assert.equal(corpus.version, manifest.version);
  assert.equal(new Set(corpus.cases.map(row => row.name)).size, corpus.cases.length);
  assert.ok(corpus.cases.length >= 100);
  const schema = JSON.parse(readFileSync(new URL("../schemas/identity.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$defs.revision.maximum, Number.MAX_SAFE_INTEGER);
  assert.ok(manifest.files.includes("python") && manifest.files.includes("conformance"));
});

for (const fixture of corpus.cases) test(`portable conformance: ${fixture.name}`, () => {
  const input = structuredClone(fixture.input), before = structuredClone(input);
  assert.deepEqual(operations[fixture.operation](input), fixture.expected);
  assert.deepEqual(input, before, "original records and identities must remain unchanged");
});

test("constructors preserve supplied identities and reject nonintegral identity revisions", () => {
  assert.deepEqual(identity.createIdentityUser({userId: "original_subject"}), {schema_version: 1, user_id: "original_subject", status: "active", revision: 1});
  for (const revision of [true, false, "1", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => identity.createIdentityUser({userId: "original_subject", revision}));
  }
  assert.throws(() => identity.createIdentityWorkspace({workspaceId: "workspace_original\n"}));
});
