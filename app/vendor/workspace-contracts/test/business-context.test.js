import assert from "node:assert/strict";
import test from "node:test";
import {assertProjectBusinessContext, createProjectBusinessContext, normalizeProjectAccountIds,
  validateProjectBusinessContext} from "../src/business-context.js";

const options = {projectId: "project_joint", workspaceId: "workspace_private", homeAccountId: "account_storage",
  relatedAccountIds: ["account_client", "account_consultant", "account_client"]};

test("multiple business accounts retain one explicit security/storage scope and caller order", () => {
  const context = createProjectBusinessContext(options);
  assert.deepEqual(context, {schema_version: 1, project_id: "project_joint", workspace_id: "workspace_private",
    home_account_id: "account_storage", related_account_ids: ["account_client", "account_consultant"]});
  assert.equal(Object.isFrozen(context), true); assert.equal(Object.isFrozen(context.related_account_ids), true);
  assert.equal(options.relatedAccountIds.length, 3);
});

test("personal projects need no business account and a home account is not an implicit relation", () => {
  assert.deepEqual(createProjectBusinessContext({projectId: "project_personal", workspaceId: "workspace_personal"}).related_account_ids, []);
  assert.deepEqual(createProjectBusinessContext({...options, relatedAccountIds: []}).related_account_ids, []);
  assert.equal(createProjectBusinessContext({projectId: "project_personal", workspaceId: "workspace_personal"}).home_account_id, null);
});

test("malformed relations, guessed scopes and excessive raw input are rejected", () => {
  for (const relatedAccountIds of [null, {}, "client", [""], [" client"], ["client@example.org"], [1], Array(21).fill("client")]) {
    assert.throws(() => createProjectBusinessContext({...options, relatedAccountIds}), TypeError);
  }
  for (const value of [{workspaceId: null}, {workspaceId: undefined}, {projectId: ""}, {homeAccountId: "client/other"}]) {
    assert.throws(() => createProjectBusinessContext({...options, ...value}), TypeError);
  }
  assert.deepEqual(normalizeProjectAccountIds(["Client_A", "client_a", "Client_A"]), ["Client_A", "client_a"]);
});

test("wire records reject duplicate relations, missing fields and permission/credential additions", () => {
  const valid = createProjectBusinessContext(options);
  for (const value of [{...valid, related_account_ids: ["client", "client"]}, {...valid, related_account_ids: undefined},
    {...valid, home_account_id: undefined}, {...valid, permissions: ["view"]}, {...valid, access_token: "private"},
    {...valid, schema_version: 2}]) assert.ok(validateProjectBusinessContext(value).length);
  const copy = assertProjectBusinessContext(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(copy, valid); assert.notEqual(copy, valid);
});
