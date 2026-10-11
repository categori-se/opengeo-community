import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {retainStudioAreas} from "../src/lib/retainedStudioAreas.js";
import {retainedPublicationIdentity, retainedPublicationScope, revalidateRetainedPublication} from '../src/lib/retainedProjectScope.js';

it('retains a saved Publication through Home and Catalog while checking access before return', async () => {
  const dom = new JSDOM('<main><section id="editor"><input value="original draft"><a href="/">Home</a></section></main>', {url: 'https://studio.opengeo.tools/workspaces?publication=one'});
  const document = dom.window.document, root = document.querySelector('main'), editor = document.querySelector('#editor');
  let homes = 0, directories = 0, checks = 0;
  const home = document.createElement('section'); home.innerHTML = '<a href="/workspaces?view=data">Catalog</a>';
  const directory = document.createElement('section'); directory.innerHTML = '<a href="/workspaces?publication=one">Publication</a>';
  const dispose = retainStudioAreas({root, mapSurface: editor, mapHref: dom.window.location.href,
    createHome: () => {homes++; return home;}, createDirectory: () => {directories++; return directory;},
    beforeShowMap: async () => {checks++; return true;}});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    for (let visit = 0; visit < 2; visit++) {
      editor.querySelector('a').click(); await tick();
      assert.equal(home.hidden, false); assert.equal(editor.hidden, true);
      home.querySelector('a').click(); await tick();
      assert.equal(directory.hidden, false); assert.equal(home.hidden, true);
      directory.querySelector('a').click();
      assert.equal(editor.hidden, true, 'Fresh access must pass before revealing the retained draft');
      await tick();
      assert.equal(editor.hidden, false);
      assert.equal(editor.querySelector('input').value, 'original draft');
    }
    assert.deepEqual([homes, directories, checks], [1, 1, 2]);
  } finally {dispose(); dom.window.close();}
});

it('rechecks retained Publication authority without repeating session startup or crossing account identity', async () => {
  let token = 'test-token', account = 'account-one';
  const calls = [];
  const expected = {status: 'ready', session: {userId: 'owner-one'}, organization: {id: account, callerRole: 'member'},
    project: {id: 'workspace-one', callerRole: 'owner'}, publication: {id: 'publication-one', resourceType: 'publication', accessContainerId: 'workspace-one'}, projectWarnings: []};
  const adapter = {baseUrl: '/api', tokenProvider: () => token, organizationProvider: () => account,
    getSession() {throw Error('Navigation must not repeat initial session startup');},
    async getCurrentOrganization() {calls.push('account'); return expected.organization;},
    async getPublication() {calls.push('publication'); return expected.publication;},
    async getProject() {calls.push('workspace'); return expected.project;}};
  const identity = await retainedPublicationIdentity(adapter);
  const accepted = await revalidateRetainedPublication(adapter, expected, identity);
  assert.equal(retainedPublicationScope(accepted), retainedPublicationScope(expected));
  assert.deepEqual(calls, ['account', 'publication', 'workspace']);
  account = 'another-account';
  assert.equal((await revalidateRetainedPublication(adapter, expected, identity)).status, 'forbidden');
  assert.equal(calls.length, 3, 'An account change must stop before resource reads');
  account = 'account-one'; token = null;
  assert.equal((await revalidateRetainedPublication(adapter, expected, identity)).status, 'unauthenticated');
  token = 'test-token';
  adapter.getPublication = async () => {throw {status: 403};};
  assert.equal((await revalidateRetainedPublication(adapter, expected, identity)).status, 'forbidden');
});

it("retains the same Studio surfaces when navigation comes from the application header", async () => {
  const dom = new JSDOM('<header><a href="/workspaces?view=data">Catalog</a><a href="/">Home</a></header><main><section id="map"><input value="unsaved"></section></main>', {url: "https://studio.opengeo.tools/"});
  const document = dom.window.document, root = document.querySelector('main'), map = document.querySelector('#map');
  let opens = 0;
  const directory = document.createElement('section');
  const dispose = retainStudioAreas({root, mapSurface: map, createDirectory: () => {opens++; return directory;}});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    for (let visit = 0; visit < 2; visit++) {
      const catalogClick = new dom.window.MouseEvent('click', {button: 0, bubbles: true, cancelable: true});
      document.querySelector('header a[href*="workspaces"]').dispatchEvent(catalogClick);
      assert.equal(catalogClick.defaultPrevented, true, 'Header navigation must not reload the document');
      await tick();
      assert.equal(directory.hidden, false);
      assert.equal(map.hidden, true);
      document.querySelector('header a[href="/"]').click();
      assert.equal(map.hidden, false);
      assert.equal(map.querySelector('input').value, 'unsaved');
    }
    assert.equal(opens, 1);
    assert.equal(map.isConnected, true);
  } finally {dispose(); dom.window.close();}
});

it('keeps supported new Project and Publication routes in the mounted directory', async () => {
  const dom = new JSDOM('<header></header><main></main>', {url: 'https://studio.opengeo.tools/workspaces'});
  const document = dom.window.document, root = document.querySelector('main');
  const directory = document.createElement('section');
  let opens = 0;
  const visited = [];
  directory.navigateTo = target => visited.push(target.pathname + target.search);
  const dispose = retainStudioAreas({root, startAtDirectory: true, createDirectory: () => {opens++; return directory;}});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const navigate = href => {
    const link = document.createElement('a'); link.href = href; document.querySelector('header').append(link);
    const event = new dom.window.MouseEvent('click', {button: 0, bubbles: true, cancelable: true});
    const retained = link.dispatchEvent(event) === false;
    link.remove();
    return retained;
  };
  try {
    await tick();
    for (const href of ['/workspaces?new=map', '/workspaces?view=publishing&new=publication', '/workspaces']) {
      assert.equal(navigate(href), true, 'Supported creation routes must keep the same Studio document');
      await tick();
      assert.equal(directory.hidden, false);
    }
    assert.equal(opens, 1);
    assert.deepEqual(visited, ['/workspaces?new=map', '/workspaces?view=publishing&new=publication', '/workspaces']);
    for (const href of ['/workspaces?new=unsupported', '/workspaces?project=another&new=map', '/workspaces?new=map&adapter=fixture']) {
      const link = document.createElement('a'); link.href = href; document.querySelector('header').append(link);
      let retained;
      document.addEventListener('click', event => {retained = event.defaultPrevented; event.preventDefault();}, {once: true});
      link.dispatchEvent(new dom.window.MouseEvent('click', {button: 0, bubbles: true, cancelable: true}));
      assert.equal(retained, false, 'Unsupported detail and adapter routes must retain ordinary navigation');
      link.remove();
    }
    assert.equal(opens, 1);
    assert.equal(visited.length, 3);
  } finally {dispose(); dom.window.close();}
});

it("opens direct directories without a map and tolerates leaving a pending map import", async () => {
  const dom = new JSDOM('<main></main>', {url: "https://studio.opengeo.tools/workspaces?view=data"});
  const root = dom.window.document.querySelector("main");
  const dir = dom.window.document.createElement("section");
  dir.innerHTML = '<a href="/">Home</a>';
  let maps = 0, release;
  const dispose = retainStudioAreas({root, startAtDirectory: true, createDirectory: () => dir,
    createMap: () => {maps++; return new Promise(resolve => {release = resolve;});}});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    await tick();
    assert.equal(maps, 0);
    assert.equal(dir.hidden, false);
    dir.querySelector("a").click(); await tick();
    assert.equal(maps, 1);
    root.querySelector('.platform-state a').click();
    assert.equal(dir.hidden, false);
    const map = dom.window.document.createElement("section");
    release(map); await tick();
    assert.equal(map.hidden, true);
    dir.querySelector("a").click();
    assert.equal(map.hidden, false);
    assert.equal(maps, 1);
  } finally {dispose(); dom.window.close();}
});

it("retains map drafts and one directory through clicks, delayed loading and history", async () => {
  const dom = new JSDOM('<main><section id="map"><input value="unsaved"><a href="/workspaces?view=data">Catalog</a></section></main>', {url: "https://studio.opengeo.tools/"});
  const {document, history, PopStateEvent} = dom.window;
  const root = document.querySelector("main"), map = document.querySelector("#map");
  const draft = map.querySelector("input");
  let opens = 0, release, disposed = 0, blocked = false;
  const views = [];
  const dir = document.createElement("section");
  dir.innerHTML = '<a href="/">Home</a><a href="/workspaces?view=collections">Collections</a>';
  dir.navigateTo = target => views.push(target.search);
  dir.shouldBlockNavigation = () => blocked;
  dir.dispose = () => disposed++;
  const dispose = retainStudioAreas({root, mapSurface: map, createDirectory: () => {
    opens++; return new Promise(resolve => {release = resolve;});
  }});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    map.querySelector("a").click(); await tick();
    assert.equal(map.hidden, true);
    assert.equal(map.isConnected, true);
    root.querySelector('.platform-state a').click();
    assert.equal(map.hidden, false);
    release(dir); await tick();
    assert.equal(dir.hidden, true);
    map.querySelector("a").click(); await tick();
    assert.equal(opens, 1);
    assert.equal(dir.hidden, false);
    dir.querySelector('a[href*="collections"]').click(); await tick();
    assert.deepEqual(views, ["?view=data", "?view=collections"]);
    blocked = true;
    dir.querySelector('a[href="/"]').click();
    assert.equal(map.hidden, true);
    assert.equal(dom.window.location.search, "?view=collections");
    blocked = false;
    dir.querySelector('a[href="/"]').click();
    assert.equal(map.querySelector("input"), draft);
    assert.equal(draft.value, "unsaved");
    history.replaceState(null, "", "/workspaces?view=collections");
    dom.window.dispatchEvent(new PopStateEvent("popstate"));
    assert.equal(map.hidden, true);
    assert.equal(dir.hidden, false);
    assert.equal(opens, 1);
  } finally {dispose(); dom.window.close();}
  assert.equal(disposed, 1);
});

it("checks saved Project authority before revealing drafts and ignores abandoned checks", async () => {
  const dom = new JSDOM('<main><section id="map"><input value="draft"><a href="/workspaces?view=data">Catalog</a></section></main>', {url: "https://studio.opengeo.tools/workspaces?composition=one"});
  const {document, history, PopStateEvent} = dom.window;
  const root = document.querySelector("main"), map = document.querySelector("#map");
  const dir = document.createElement("section");
  dir.innerHTML = '<a href="/workspaces?composition=one">Back to open Project</a>';
  const checks = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const dispose = retainStudioAreas({root, mapSurface: map, mapHref: dom.window.location.href,
    createDirectory: () => dir,
    beforeShowMap: ({signal}) => new Promise(resolve => checks.push({signal, resolve}))});
  try {
    map.querySelector("a").click(); await tick();
    dir.querySelector("a").click();
    assert.equal(map.hidden, true);
    assert.equal(map.isConnected, true);
    checks[0].resolve(false); await tick();
    assert.equal(map.hidden, true);
    assert.match(root.querySelector('[role="status"]').textContent, /could not be reopened safely/);
    root.querySelector('.platform-state a').click();
    history.replaceState(null, "", "/workspaces?view=data");
    dom.window.dispatchEvent(new PopStateEvent("popstate"));
    assert.equal(checks[1].signal.aborted, true);
    checks[1].resolve(true); await tick();
    assert.equal(map.hidden, true);
    assert.equal(dir.hidden, false);
    dir.querySelector("a").click();
    checks[2].resolve(true); await tick();
    assert.equal(map.hidden, false);
    assert.equal(map.querySelector("input").value, "draft");
    map.querySelector("a").click(); await tick();
    dir.querySelector("a").click();
    dispose();
    assert.equal(checks[3].signal.aborted, true);
    checks[3].resolve(true); await tick();
    assert.equal(map.hidden, true);
  } finally {dispose(); dom.window.close();}
});
