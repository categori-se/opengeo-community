import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";
import {loadProjectContext} from "../src/lib/platform.js";
import {compositionHref} from "../src/lib/applicationRoutes.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
const catalog = JSON.parse(await readFile(new URL('../src/data/catalog.json', import.meta.url), 'utf8'));
it('resolves an exact authored identity and keeps its access container separate', async () => {
  const adapter = new FixturePlatformAdapter(catalog);
  const binding = FIXTURE_PROJECTS[0];
  const state = await loadProjectContext(adapter, null, null, {surface: 'maps', compositionId: binding.mapId});
  assert.equal(state.status, 'ready');
  assert.equal(state.project.id, binding.projectId);
  assert.equal(state.selectedMap.id, binding.mapId);
  assert.equal(state.selectedMap.accessContainerId, binding.projectId);
  assert.equal(state.selectedMap.resourceType, 'project');
  assert.equal(compositionHref(binding.mapId), `/workspaces?composition=${binding.mapId}`);
  const missing = await loadProjectContext(adapter, binding.projectId, null, {compositionId: '10000000-0000-4000-8000-999999999999'});
  assert.notEqual(missing.status, 'ready');
  assert.equal(missing.selectedMap, undefined);
});
it('rejects substituted identity and retains explicit compatibility access context', async () => {
  const binding = FIXTURE_PROJECTS[0];
  let body;
  const adapter = new OpenGeoApiClient({tokenProvider: () => 'fixture', organizationProvider: () => "10000000-0000-4000-8000-000000000001",
    fetchImplementation: async () => new Response(JSON.stringify(body), {status:200})});
  const fixture = new FixturePlatformAdapter(catalog);
  const map = await fixture.getMap(binding.projectId,binding.mapId);
  body = {id:map.id, resource_type:'project', access_container_id:map.projectId, name:map.name, description:map.description,
    status:map.status, definition:map.definition, version:map.version, created_at:map.createdAt, updated_at:map.updatedAt};
  assert.equal((await adapter.getComposition(map.id)).accessContainerId, map.projectId);
  body.id = '10000000-0000-4000-8000-999999999999';
  await assert.rejects(adapter.getComposition(map.id), {code:'invalid_api_response'});
});

it('opens the requested Publication rather than its first sibling and performs no creation', async () => {
  const adapter = new FixturePlatformAdapter(catalog);
  const {projectId} = FIXTURE_PROJECTS[0];
  const resource = (await adapter.listResources(projectId))[0];
  const draft = {title: 'First publication', slug: 'first', language:'en', theme:'paper', themeOptions:{},
    pages:[{slug:'home', navigationLabel:'Home', resourceId:resource.id, resourceVersion:resource.versionNumber, isHome:true}]};
  const first = await adapter.createSite(projectId, draft);
  const second = await adapter.createSite(projectId, {...draft, title:'Second publication', slug:'second'});
  adapter.createSite = () => {throw Error('Inspection must not create');};
  adapter.createMap = () => {throw Error('Publication must not create a composition');};
  const state = await loadProjectContext(adapter, null, null, {publicationId:second.id});
  assert.equal(state.status,'ready');
  assert.equal(state.project.id,projectId);
  assert.equal(state.publication.id,second.id);
  assert.deepEqual(state.sites.map(site=>site.id),[second.id]);
  assert.equal(state.selectedMap,null);
  assert.equal((await adapter.listSites(projectId)).length,2);
  assert.notEqual(first.id,second.id);
});
