import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {collectionDefinitionFromApi} from "../src/lib/collectionReferences.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {CollectionDirectory} from "../src/components/CollectionDirectory.js";

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseUrl = "https://api.example.invalid/api";
const response = value => new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
const wireRecord = () => ({id: id(2), title: "Shared studies", description: "", revision: 1,
  owner_user_id: id(3), created_by: id(4), role: "owner", visibility: "account", members: [
    {entry_id: id(5), available: true, kind: "project", target_id: id(6), title: "Survey", workspace_id: id(7)},
    {entry_id: id(8), available: false, target_id: id(9), title: "Hidden", workspace_id: id(10)},
    {entry_id: id(11), available: true, kind: "publication", target_id: id(12), title: "Report", workspace_id: id(13)}
  ]});

it("qualifies account context, user ownership and ordered member scopes independently", () => {
  const raw = wireRecord();
  for (const [visibility, kind] of [["private", "restricted"], ["account", "scope"], ["public", "public"]]) {
    const definition = collectionDefinitionFromApi({...raw, visibility}, {baseUrl, organizationId: id(1)});
    assert.equal(definition.reference.authority, baseUrl);
    assert.equal(definition.reference.workspace_id, `account:${id(1)}`);
    assert.deepEqual(definition.owner, {authority: baseUrl, principal_type: "user", principal_id: id(3)});
    assert.deepEqual(definition.contexts, []);
    assert.equal(definition.audience.kind, kind);
    assert.deepEqual(definition.audience.scope, kind === "scope" ? {schema_version: 1, authority: baseUrl,
      resource_type: "workspace", resource_id: `account:${id(1)}`, workspace_id: `account:${id(1)}`} : null);
    assert.deepEqual(definition.entries.map(entry => entry.entry_id), [id(5), id(8), id(11)]);
    assert.equal(definition.entries[0].reference.workspace_id, `project:${id(7)}`);
    assert.equal(definition.entries[2].reference.resource_type, "publication");
    assert.equal(definition.entries[2].reference.workspace_id, `project:${id(13)}`);
    assert.deepEqual(definition.entries[1], {entry_id: id(8), reference: null});
    assert.equal(JSON.stringify(definition).includes("Hidden"), false);
    assert.equal(JSON.stringify(definition).includes(id(9)), false);
    assert.equal(Object.isFrozen(definition.entries), true);
  }
  assert.equal(raw.members[1].title, "Hidden");
  assert.equal(collectionDefinitionFromApi(raw, {baseUrl: "/api", locationHref: "https://studio.example.invalid/workspaces",
    organizationId: id(1)}).reference.authority, "https://studio.example.invalid/api");
});

it("adapts explicit User, Team and Organization owners without changing audience or unavailable entries", async () => {
  const raw = wireRecord();
  for (const principal_type of ["user", "team", "organization"]) {
    const principal_id = principal_type === "organization" ? id(1) : id(3);
    const owner = {principal_type, principal_id};
    const record = {...raw, owner, owner_name: `${principal_type} owner`,
      owner_user_id: principal_type === "user" ? principal_id : null};
    const definition = collectionDefinitionFromApi(record, {baseUrl, organizationId: id(1)});
    assert.deepEqual(definition.owner, {authority: baseUrl, ...owner});
    assert.equal(definition.audience.kind, "scope");
    assert.deepEqual(definition.entries[1], {entry_id: id(8), reference: null});
    const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => "fixture", organizationProvider: () => id(1),
      fetchImplementation: async () => response(record)});
    const saved = await client.getCollection(raw.id);
    assert.deepEqual(saved.owner, owner); assert.equal(saved.owner_name, record.owner_name);
    assert.equal(saved.created_by, id(4)); assert.equal(saved.owner_user_id, record.owner_user_id);
    assert.deepEqual(saved.definition.owner, definition.owner);
  }
});

it("rejects conflicting, unqualified and cross-account supplied owner metadata", async () => {
  const raw = wireRecord();
  const invalid = [
    {...raw, owner: {principal_type: "user", principal_id: id(14)}},
    {...raw, owner: {principal_type: "team", principal_id: id(3)}},
    {...raw, owner_user_id: null, owner: {principal_type: "organization", principal_id: id(14)}},
    {...raw, owner_user_id: null, owner: {principal_type: "agency", principal_id: id(1)}},
    {...raw, owner_user_id: null, owner: {principal_type: "team", principal_id: `${id(3)}\n`}},
    {...raw, owner: {principal_type: "user", principal_id: id(3), authority: baseUrl}},
    {...raw, owner: null}
  ];
  for (const record of invalid) {
    assert.throws(() => collectionDefinitionFromApi(record, {baseUrl, organizationId: id(1)}), /owner/i);
    const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => "fixture", organizationProvider: () => id(1),
      fetchImplementation: async () => response(record)});
    await assert.rejects(client.getCollection(raw.id), error => error.code === "invalid_api_response");
  }
});

it("uses exact owner candidate pages and sends ownership only through create or explicit revisioned transfer", async () => {
  const calls = [], owner = {principal_type: "team", principal_id: id(15)};
  const client = new OpenGeoApiClient({baseUrl, organizationProvider: () => id(1)});
  client.request = async (path, options) => {
    calls.push({path, ...options});
    return path.includes("owner-candidates") ? [{...owner, name: "Survey team"}] : {id: id(2), revision: 2};
  };
  assert.deepEqual(await client.listCollectionOwnerCandidates("team", {collectionId: id(2), offset: 50}), [{...owner, name: "Survey team"}]);
  const query = new URL(calls[0].path, baseUrl).searchParams;
  assert.equal(query.get("kind"), "team"); assert.equal(query.get("collection_id"), id(2));
  assert.equal(query.get("offset"), "50"); assert.equal(calls[0].organizationId, id(1));
  await client.createCollection({title: "Team work", owner});
  assert.deepEqual(calls[1].body, {title: "Team work", description: "", owner});
  await client.createCollection({title: "My work"});
  assert.deepEqual(calls[2].body, {title: "My work", description: ""});
  await client.transferCollectionOwner(id(2), {expected_revision: 1, owner});
  assert.equal(calls[3].path, `/collections/${id(2)}/owner`);
  assert.deepEqual(calls[3].body, {expected_revision: 1, owner});
  await assert.rejects(client.transferCollectionOwner(id(2), {expected_revision: 1,
    owner: {principal_type: "organization", principal_id: id(14)}}), /account/);
  assert.equal(calls.length, 4);
  client.request = async () => [{principal_type: "user", principal_id: id(3), name: "Wrong type"}];
  await assert.rejects(client.listCollectionOwnerCandidates("team"), error => error.code === "invalid_api_response");
});

it("pins the original owner-action token and denies a sign-in change during the account await before dispatch", async () => {
  for (const action of ["create", "transfer", "candidates"]) {
    let token = "original-session", accountReads = 0, dispatched = 0;
    const tokenProvider = () => token;
    const organizationProvider = () => {
      accountReads++;
      // Two account reads validate the original view, then the client's request
      // account await sees the changed sign-in before it can dispatch a write.
      if (accountReads === 3) token = "replacement-session";
      return id(1);
    };
    const client = new OpenGeoApiClient({baseUrl, tokenProvider, organizationProvider,
      fetchImplementation: async () => {dispatched++; return response({id: id(2), revision: 2});}});
    const context = {tokenProvider, organizationProvider, baseUrl, token, organization: id(1)};
    const owner = {principal_type: "team", principal_id: id(15)};
    const pending = action === "create" ? client.createCollection({title: "Scoped grouping", owner}, {context})
      : action === "transfer" ? client.transferCollectionOwner(id(2), {expected_revision: 1, owner}, {context})
      : client.listCollectionOwnerCandidates("team", {context});
    await assert.rejects(pending, error => error.code === "collection_context_changed");
    assert.equal(dispatched, 0, action);
  }
});

it("never dispatches a bound owner action to a transient replacement account", async () => {
  let accountReads = 0, dispatched = 0;
  const tokenProvider = () => "original-session";
  const organizationProvider = () => ++accountReads === 3 ? id(14) : id(1);
  const client = new OpenGeoApiClient({baseUrl, tokenProvider, organizationProvider,
    fetchImplementation: async (_, options) => {
      dispatched++; assert.equal(options.headers.get("X-OpenGeo-Organization"), id(1));
      return response({id: id(2), revision: 1});
    }});
  const context = {tokenProvider, organizationProvider, baseUrl, token: "original-session", organization: id(1)};
  await assert.rejects(client.createCollection({title: "Original account only"}, {context}), error => error.code === "collection_context_changed");
  assert.equal(dispatched, 0);
  assert.equal(client.collectionRequestOptions(id(14), context).organizationId, id(1));
});

it("retains historical omissions without inferring identities and rejects malformed supplied metadata", async () => {
  const raw = wireRecord(), noOwner = structuredClone(raw), noMemberScope = structuredClone(raw);
  delete noOwner.owner_user_id; delete noMemberScope.members[0].workspace_id;
  assert.equal(collectionDefinitionFromApi(noOwner, {baseUrl, organizationId: id(1)}), undefined);
  assert.equal(collectionDefinitionFromApi(noMemberScope, {baseUrl, organizationId: id(1)}), undefined);
  assert.equal(collectionDefinitionFromApi(raw, {baseUrl, organizationId: null}), undefined);
  assert.throws(() => collectionDefinitionFromApi({...noOwner, members: [{...raw.members[0], workspace_id: "bad"}]},
    {baseUrl, organizationId: id(1)}), /workspace/);
  assert.throws(() => collectionDefinitionFromApi({...noOwner, members: [{...raw.members[0], target_id: "bad"}]},
    {baseUrl, organizationId: id(1)}), /member/);
  assert.throws(() => collectionDefinitionFromApi({...noOwner, visibility: "agency"},
    {baseUrl, organizationId: id(1)}), /visibility/);
  assert.throws(() => collectionDefinitionFromApi({...raw, owner_user_id: null}, {baseUrl, organizationId: id(1)}), /owner/);
  for (const member of [{...raw.members[0], available: "true"}, {...raw.members[0], kind: "ogc-collection"}]) {
    assert.throws(() => collectionDefinitionFromApi({...raw, members: [member]}, {baseUrl, organizationId: id(1)}), /member/);
  }
  assert.throws(() => collectionDefinitionFromApi({id: raw.id, title: raw.title, description: "", visibility: "public",
    members: [{kind: "publication", title: "Listed report", href: "/public/report"}]}, {baseUrl, organizationId: id(1)}), /revision/);
  assert.throws(() => collectionDefinitionFromApi({...raw, members: {}}, {baseUrl, organizationId: id(1)}), /authoring/);
  for (const unsafeUrl of ["https://user:password@example.invalid/api", `${baseUrl}?token=secret`, `${baseUrl}#fragment`]) {
    assert.throws(() => collectionDefinitionFromApi(raw, {baseUrl: unsafeUrl, organizationId: id(1)}), /credential-free/);
  }
  let served = noOwner;
  const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => "local-fixture", organizationProvider: () => id(1),
    fetchImplementation: async () => response(served)});
  assert.equal(Object.hasOwn(await client.getCollection(raw.id), "definition"), false);
  served = {...raw, owner_user_id: "not-a-user-id"};
  await assert.rejects(client.getCollection(raw.id), error => error.code === "invalid_api_response");
});

it("pins the request account while awaiting authentication and rejects a changed-account response", async () => {
  let selected = id(1), releaseToken, tokenStarted, calls = 0;
  const started = new Promise(resolve => {tokenStarted = resolve;});
  const token = new Promise(resolve => {releaseToken = resolve;});
  const client = new OpenGeoApiClient({baseUrl, organizationProvider: () => selected,
    tokenProvider: () => {tokenStarted(); return token;}, fetchImplementation: async (url, options) => {
      calls++;
      assert.equal(url, `${baseUrl}/collections/${id(2)}`);
      assert.equal(options.headers.get("X-OpenGeo-Organization"), id(1));
      return response(wireRecord());
    }});
  const pending = client.getCollection(id(2));
  await started; selected = id(14); releaseToken("local-fixture");
  await assert.rejects(pending, error => error.code === "organization_scope_changed" && error.status === 409);
  assert.equal(calls, 1);

  const stable = new OpenGeoApiClient({baseUrl, tokenProvider: () => "local-fixture", organizationProvider: () => id(1),
    fetchImplementation: async (_, options) => {
      assert.equal(options.headers.get("X-OpenGeo-Organization"), id(1));
      return response(wireRecord());
    }});
  const record = await stable.getCollection(id(2));
  assert.equal(record.definition.reference.workspace_id, `account:${id(1)}`);
  assert.deepEqual(record.members[1], {entry_id: id(8), available: false});
  assert.equal(record.role, "owner");
});

it("creates, orders, saves and reopens through the existing directory and actual client", async () => {
  const dom = new JSDOM("<body></body>", {url: "https://studio.example.invalid/workspaces?view=collections"});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  let stored = null, revoked = false, root;
  const writes = [], reads = [];
  const current = () => ({...structuredClone(stored), members: stored.members.map(member => revoked && member.kind === "project"
    ? {entry_id: member.entry_id, available: false} : {...member, available: true})});
  const targets = {project: {id: id(6), title: "Survey", workspace_id: id(7)},
    publication: {id: id(12), title: "Report", workspace_id: id(13)}};
  const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => "local-fixture", organizationProvider: () => id(1),
    fetchImplementation: async (url, options) => {
      assert.equal(options.headers.get("X-OpenGeo-Organization"), id(1));
      const request = new URL(url), body = options.body === undefined ? null : JSON.parse(options.body);
      const path = request.pathname.slice("/api".length);
      if (path === "/collections" && options.method === "POST") {
        stored = {id: id(2), title: body.title, description: body.description, revision: 1,
          owner_user_id: id(3), created_by: id(3), role: "owner", visibility: "private", members: []};
        return response({id: stored.id, revision: stored.revision});
      }
      if (path === "/collections" && options.method === "GET") return response(stored ? [current()] : []);
      if (path === "/collections/member-candidates") return response([targets[request.searchParams.get("kind")]]);
      if (path === `/collections/${id(2)}` && options.method === "GET") return response(current());
      if (path === `/collections/${id(2)}` && options.method === "PUT") {
        writes.push(body); assert.equal(body.expected_revision, stored.revision);
        stored.members = body.members.map((member, index) => member.entry_id
          ? stored.members.find(existing => existing.entry_id === member.entry_id)
          : {entry_id: id(20 + index), kind: member.kind, target_id: member.target_id,
            title: targets[member.kind].title, workspace_id: targets[member.kind].workspace_id});
        stored = {...stored, title: body.title, description: body.description, revision: stored.revision + 1};
        return response({id: stored.id, revision: stored.revision});
      }
      assert.fail(`Unexpected request: ${options.method} ${path}`);
    }});
  client.kind = "api";
  const originalRead = client.getCollection.bind(client);
  client.getCollection = async (...args) => {const record = await originalRead(...args); reads.push(record); return record;};
  const settle = async condition => {
    for (let attempt = 0; attempt < 100; attempt++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5));}
    assert.fail("Collection directory did not settle");
  };
  const click = label => {
    const button = [...root.querySelectorAll("button")].find(item => item.textContent === label);
    assert.ok(button, label); assert.equal(button.disabled, false, label); button.click();
  };
  try {
    root = CollectionDirectory({adapter: client}); document.body.append(root);
    await settle(() => root.textContent.includes("No Collections yet"));
    root.querySelector('[aria-label="New Collection title"]').value = "Shared studies";
    click("Create Collection"); await settle(() => root.querySelector("h3"));
    assert.equal(reads.at(-1).definition.owner.principal_id, id(3));
    click("Browse members"); await settle(() => [...root.querySelectorAll("button")].some(button => button.textContent === "Survey"));
    click("Survey");
    const memberType = root.querySelector('[aria-label="Member type"]');
    memberType.value = "publication"; memberType.dispatchEvent(new dom.window.Event("change"));
    click("Browse members"); await settle(() => [...root.querySelectorAll("button")].some(button => button.textContent === "Report"));
    click("Report"); root.querySelectorAll("ol li")[1].querySelector("button").click();
    click("Save Collection"); await settle(() => writes.length === 1 && !root.hasUnsavedChanges());
    assert.deepEqual(writes[0].members, [{kind: "publication", target_id: id(12)}, {kind: "project", target_id: id(6)}]);
    assert.deepEqual(reads.at(-1).definition.entries.map(entry => entry.reference.resource_type), ["publication", "project"]);
    revoked = true;
    root.dispose(); root.remove();
    root = CollectionDirectory({adapter: client, initialCollectionId: id(2)}); document.body.append(root);
    await settle(() => root.textContent.includes("Unavailable member"));
    assert.deepEqual(reads.at(-1).definition.entries[1], {entry_id: id(21), reference: null});
    root.querySelectorAll("ol li")[1].querySelector("button").click();
    click("Save Collection"); await settle(() => writes.length === 2 && !root.hasUnsavedChanges());
    assert.deepEqual(writes[1].members, [{entry_id: id(21)}, {entry_id: id(20)}]);
    assert.deepEqual(reads.at(-1).definition.entries[0], {entry_id: id(21), reference: null});
    assert.deepEqual(Object.keys(writes[1]).sort(), ["description", "expected_revision", "members", "title"]);
    assert.equal(stored.members.find(member => member.kind === "project").target_id, id(6));
  } finally {root?.dispose(); globalThis.document = previous; dom.window.close();}
});
