import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {PlatformDirectory, renderDirectoryState, catalogTable} from "../src/components/PlatformDirectory.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {FixturePlatformAdapter} from "../src/lib/fixturePlatform.js";
import {retainedPublicationIdentity} from "../src/lib/retainedProjectScope.js";

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces"
  });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  harness = {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    }
  };
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe("project directory interaction", () => {
  it("overlaps returning account and access inventory reads without showing unverified or changed-login records", async () => {
    const state = directoryState(), accounts = [], inventories = [];
    let token = 'owner-token';
    const adapter = {...state.adapter, tokenProvider: () => token, organizationProvider: () => state.organization.id,
      getSession() {assert.fail('Returning navigation must not bootstrap a session');},
      getCurrentOrganization: () => new Promise(resolve => accounts.push(resolve)),
      listProjects: options => new Promise(resolve => inventories.push({options, resolve}))};
    const identity = await retainedPublicationIdentity(adapter);
    const root = PlatformDirectory({adapter, view: 'access', initialDirectory: {...state, adapter}, initialIdentity: identity});
    document.body.append(root);
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const records = [{...state.projects[0], name: 'Parallel private workspace'}];
    try {
      await tick();
      assert.equal(accounts.length, 1); assert.equal(inventories.length, 1, 'Inventory starts while current permissions are pending');
      assert.equal(inventories[0].options.limit, 100);
      assert(inventories[0].options.signal instanceof AbortSignal);
      inventories[0].resolve(records); await tick();
      assert.doesNotMatch(root.textContent, /Parallel private workspace/);
      assert.equal(root.querySelector('.platform-project-directory'), null);
      accounts[0](state.organization); await tick();
      assert.match(root.textContent, /Parallel private workspace/);
      root.navigateTo(new URL('/workspaces?view=access', location.href)); await tick();
      assert.equal(accounts.length, 2); assert.equal(inventories.length, 2);
      assert.doesNotMatch(root.textContent, /Parallel private workspace/);
      token = 'different-login-token';
      inventories[1].resolve(records); accounts[1](state.organization); await tick();
      assert.equal(root.querySelector('.platform-project-directory'), null);
      assert.doesNotMatch(root.textContent, /Parallel private workspace/);
      assert.equal(inventories[1].options.signal.aborted, true);
    } finally {root.dispose();}
  });

  it("reuses mounted directory identity beyond30seconds with fresh account and area reads", async () => {
    const state = directoryState(), calls = [], oldNow = Date.now;
    let now = oldNow();
    Date.now = () => now;
    const adapter = {...state.adapter, tokenProvider: () => 'owner-token', organizationProvider: () => state.organization.id,
      getSession() {assert.fail('An authorized mounted return must not bootstrap the session');},
      getCurrentOrganization: async () => {calls.push('account'); return state.organization;},
      listCompositions: async () => {calls.push('projects'); return [];},
      listLocations: async () => {calls.push('locations'); return [];}};
    const directory = {...state, adapter};
    const identity = await retainedPublicationIdentity(adapter);
    const root = PlatformDirectory({adapter, initialDirectory: directory, initialIdentity: identity});
    document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls, ['account', 'projects']);
      now += 60_000;
      root.querySelector('.studio-navigation a[href="/workspaces?view=locations"]').click();
      assert.doesNotMatch(root.textContent, /Opening Studio/);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls, ['account', 'projects', 'account', 'locations']);
      assert.equal(root.querySelector('h1')?.textContent, 'Geographic tags');
      assert.equal(root.querySelector('.platform-directory-loading'), null);
    } finally {root.dispose(); Date.now = oldNow;}
  });

  it("hides old directory records and rejects a changed login during current account read", async () => {
    const state = directoryState(); let token = 'owner-token', release;
    const adapter = {...state.adapter, tokenProvider: () => token, organizationProvider: () => state.organization.id,
      getSession() {assert.fail('A changed retained identity must not bootstrap silently');},
      getCurrentOrganization: () => new Promise(resolve => {release = resolve;}),
      listCompositions() {assert.fail('A changed login must not load owner Projects');}};
    const identity = await retainedPublicationIdentity(adapter);
    const root = PlatformDirectory({adapter, initialDirectory: {...state, adapter}, initialIdentity: identity});
    document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.doesNotMatch(root.textContent, /Aaron Dennis|MassGIS Property Tax Parcels/);
      token = 'different-login-token'; release(state.organization);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector('.composition-directory'), null);
      assert.doesNotMatch(root.textContent, /Aaron Dennis|MassGIS Property Tax Parcels/);
      assert.equal(root.querySelector('.platform-directory-loading'), null);
    } finally {root.dispose();}
  });

  it("does not display or fetch directory resources after revoked account membership", async () => {
    const state = directoryState(); let accounts = 0;
    const adapter = {...state.adapter, tokenProvider: () => 'owner-token', organizationProvider: () => state.organization.id,
      getSession() {assert.fail('A denied mounted return must not retry session startup');},
      getCurrentOrganization: async () => {accounts++; throw Object.assign(Error('Revoked'), {status:403});},
      listCompositions() {assert.fail('Revoked access must not read Projects');}};
    const identity = await retainedPublicationIdentity(adapter);
    const root = PlatformDirectory({adapter, initialDirectory: {...state, adapter}, initialIdentity: identity});
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(accounts, 1);
      assert.equal(root.querySelector('.composition-directory'), null);
      assert.doesNotMatch(root.textContent, /Aaron Dennis|MassGIS Property Tax Parcels/);
    } finally {root.dispose();}
  });

  it("searches authorized inventory beyond the first100 only on submission through the authenticated client", async () => {
    const state = directoryState(), original = state.projects[0], requests = [];
    const records = Array.from({length: 100}, (_, i) => ({...original, id: `c85a6d5e-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name: `Workspace ${i}`}));
    const target = {...state.projects[1], name: "Later archived workspace", status: "archived"}; records.push(target);
    const fixture = Object.create(FixturePlatformAdapter.prototype);
    fixture.projectBindings = records.map((_, index) => ({index}));
    fixture.projectForBinding = binding => records[binding.index];
    fixture.getCurrentOrganization = async () => ({callerRole: "admin"});
    fixture.listClients = async () => [];
    const client = new OpenGeoApiClient({tokenProvider: () => "fixture-token", organizationProvider: () => state.organization.id,
      fetchImplementation: async (url, options) => {
        requests.push({url, options}); const params = new URL(url, location.href).searchParams;
        const rows = await fixture.listProjects({q: params.get("q") ?? "", status: params.get("status") ?? "all", limit: Number(params.get("limit")), offset: Number(params.get("offset"))});
        return new Response(JSON.stringify(rows.map(r => ({id:r.id, name:r.name, client_id:null, project_code:r.projectCode ?? null,
          description:r.description, status:r.status, created_at:r.updatedAt, updated_at:r.updatedAt, caller_role:r.callerRole, visibility:r.visibility}))), {status:200, headers:{"Content-Type":"application/json"}});
      }});
    state.projects = records.slice(0,100); state.adapter.listProjects = client.listProjects.bind(client);
    const root = document.createElement("section"); renderDirectoryState(root, state, () => {}, null, {view:"access"});
    const search = root.querySelector('input[type="search"]'), status = root.querySelector('[aria-label="Access workspace status"]');
    search.value = "  Later archived  "; search.dispatchEvent(new harness.dom.window.Event("input"));
    status.value = "archived"; status.dispatchEvent(new harness.dom.window.Event("change"));
    assert.equal(requests.length,0);
    root.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable:true}));
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(requests.length,1); const params = new URL(requests[0].url,location.href).searchParams;
    assert.equal(params.get("q"),"Later archived"); assert.equal(params.get("status"),"archived");
    assert.equal(params.get("limit"),"100"); assert.equal(params.get("offset"),"0");
    assert.equal(requests[0].options.headers.get("Authorization"),"Bearer fixture-token");
    assert.equal(requests[0].options.headers.get("X-OpenGeo-Organization"),state.organization.id);
    assert.equal(requests[0].options.credentials,"omit");
    assert.equal(new URL(root.querySelector(".platform-project-directory-results a").href).searchParams.get("project"),target.id);
    assert.equal(state.projects.length,100); assert.equal(state.projects.includes(target),false);
    root.querySelector('[aria-label="Clear access workspace search"]').click(); await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(new URL(requests[1].url,location.href).searchParams.get("offset"),"0");
    assert.equal(new URL(requests[1].url,location.href).searchParams.has("q"),false);
    assert.equal(root.querySelectorAll(".platform-project-directory-results a").length,100);
    await assert.rejects(client.listProjects({q:"x".repeat(201)}),/200/);
    await assert.rejects(client.listProjects({status:"deleted"}),/status/); assert.equal(requests.length,2);
    fixture.getCurrentOrganization = async () => ({callerRole:"guest"});
    fixture.listClients = () => assert.fail("Guest search must not read client names");
    assert.deepEqual(await fixture.listProjects({q:"restricted client"}),[]);
    root.accessDirectory.dispose();
  });

  it("keeps applied filters for pagination, retained rows on errors and ignores superseded search results", async () => {
    const state = directoryState(), initial = state.projects.slice(), requests = [], releases = new Map();
    const rows = Array.from({length:100},(_,i) => ({...initial[0],id:`c85a6d5e-0000-4000-8000-${String(i + 1).padStart(12,"0")}`,name:`Alpha ${i}`}));
    state.adapter.listProjects = options => {
      requests.push(options);
      if (options.offset) return Promise.resolve([{...initial[1],name:"Alpha later"}]);
      if (options.q === "Alpha") return Promise.resolve(rows);
      return new Promise((resolve,reject) => releases.set(options.q,{resolve,reject,signal:options.signal}));
    };
    state.adapter.createProject = () => assert.fail("Search cannot write");
    const root = document.createElement("section"); renderDirectoryState(root,state,()=>{},null,{view:"access"});
    const search = root.querySelector('input[type="search"]'), form = root.querySelector("form");
    const submit = q => {search.value=q; search.dispatchEvent(new harness.dom.window.Event("input")); form.dispatchEvent(new harness.dom.window.Event("submit",{cancelable:true}));};
    submit("Alpha"); await new Promise(resolve => setTimeout(resolve,0));
    search.value="Beta"; search.dispatchEvent(new harness.dom.window.Event("input"));
    assert.equal(root.querySelectorAll(".platform-project-directory-results a").length,100);
    root.querySelector('[aria-label="Load more access workspaces"]').click(); await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(requests[1].q,"Alpha"); assert.equal(requests[1].status,"active"); assert.equal(requests[1].offset,100);
    assert.equal(root.querySelectorAll(".platform-project-directory-results a").length,101);
    submit("Beta"); assert.equal(root.querySelectorAll(".platform-project-directory-results a").length,101);
    releases.get("Beta").reject(Error("unavailable")); await new Promise(resolve => setTimeout(resolve,0));
    assert.match(root.querySelector('.platform-project-directory [role="status"]').textContent,/101 workspaces retained/);
    submit("Gamma"); submit("Delta"); assert.equal(releases.get("Gamma").signal.aborted,true);
    releases.get("Gamma").resolve([{...initial[1],name:"Stale Gamma"}]);
    releases.get("Delta").resolve([{...initial[1],name:"Delta accepted"}]); await new Promise(resolve => setTimeout(resolve,0));
    assert.doesNotMatch(root.textContent,/Stale Gamma/); assert.match(root.textContent,/Delta accepted/);
    assert.deepEqual(state.projects,initial); root.accessDirectory.dispose();
  });

  it("preserves applied server search and draft filters across delayed directory supplements", async () => {
    const state = directoryState(); let releaseClients; const requests=[];
    const target={...state.projects[1],name:"Later authorized workspace"};
    const adapter={...state.adapter, getSession:async()=>({...state.session,selectedOrganizationId:state.organization.id,memberships:[]}),
      selectOrganization() {}, getCurrentOrganization:async()=>state.organization,
      listClients:()=>new Promise(resolve=>{releaseClients=resolve;}),
      listProjects:async options=>{requests.push(options); return options.q ? [target] : state.projects;}};
    const root=PlatformDirectory({adapter,view:"access"}); document.body.append(root);
    try {
    await new Promise(resolve=>setTimeout(resolve,0));
    const search=root.querySelector('input[type="search"]'); search.value="Later";
    root.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit",{cancelable:true}));
    await new Promise(resolve=>setTimeout(resolve,0)); search.value="Unsubmitted"; search.dispatchEvent(new harness.dom.window.Event("input"));
    releaseClients([]); await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(root.querySelector('input[type="search"]').value,"Unsubmitted");
    assert.match(root.querySelector(".platform-project-directory-results").textContent,/Later authorized workspace/);
    assert.equal(requests.length,2); assert.equal(root.querySelector('[aria-label="Load more access workspaces"]'),null);
    } finally {root.dispose();}
  });

  it("loads and finds the 101st authorized access workspace while retaining filters and unique rows", async () => {
    const state = directoryState(), requests = [];
    const projects = Array.from({length: 100}, (_, index) => ({...state.projects[0],
      id: `c85a6d5e-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: `Workspace ${index + 1}`}));
    const target = {...state.projects[1], name: "Later archived workspace", status: "archived"};
    let release;
    const adapter = {...state.adapter, kind: "api", organizationId: state.organization.id,
      getSession: async () => ({...state.session, selectedOrganizationId: state.organization.id, memberships: []}),
      selectOrganization(id) {this.organizationId = id;}, getCurrentOrganization: async () => state.organization,
      listProjects(options) {
        assert.equal(this.organizationId, state.organization.id); requests.push(options);
        return options.offset ? new Promise(resolve => {release = resolve;}) : Promise.resolve(projects);
      },
      getProject: async id => {assert.equal(adapter.organizationId, state.organization.id); assert.equal(id, target.id); return target;}
    };
    const root = PlatformDirectory({adapter, view: "access"}); document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const search = root.querySelector('[aria-label="Search access workspaces or clients"]');
      const status = root.querySelector('[aria-label="Access workspace status"]');
      search.value = "Later archived"; search.dispatchEvent(new harness.dom.window.Event("input"));
      status.value = "archived"; status.dispatchEvent(new harness.dom.window.Event("change"));
      assert.equal(root.querySelectorAll(".platform-project-directory-results a").length, 0);
      const more = root.querySelector('[aria-label="Load more access workspaces"]'); assert.ok(more);
      more.focus(); assert.equal(document.activeElement, more);
      more.click(); more.click();
      assert.equal(requests.length, 2); assert.equal(requests[0].limit, 100);
      assert.equal(requests[1].limit, 100); assert.equal(requests[1].offset, 100); assert.equal(more.disabled, true);
      document.body.tabIndex = -1; document.body.focus();
      assert.equal(document.activeElement, document.body, "Native disabled controls may release focus while the page loads");
      release([projects[0], target]); await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(search.value, "Later archived"); assert.equal(status.value, "archived");
      assert.match(root.querySelector(".platform-project-directory-heading").textContent, /101 data access containers loaded/);
      const link = root.querySelector(".platform-project-directory-results a"); assert.ok(link);
      assert.equal(new URL(link.href).searchParams.get("project"), target.id);
      assert.equal((await adapter.getProject(new URL(link.href).searchParams.get("project"))).id, target.id);
      assert.equal(root.querySelector('[aria-label="Load more access workspaces"]'), null);
      assert.equal(document.activeElement, root.querySelector('[aria-label="Search authorized access workspaces"]'));
      search.value = ""; search.dispatchEvent(new harness.dom.window.Event("input"));
      status.value = "all"; status.dispatchEvent(new harness.dom.window.Event("change"));
      assert.equal(root.querySelectorAll(".platform-project-directory-results a").length, 101);
    } finally {root.dispose();}
  });

  it("preserves moved focus while the final access-workspace page loads", async () => {
    const state = directoryState();
    state.projects = Array.from({length: 100}, (_, index) => ({...state.projects[0],
      id: `c85a6d5e-0000-4000-8000-${String(index + 1).padStart(12, "0")}`}));
    let release;
    state.adapter.listProjects = () => new Promise(resolve => {release = resolve;});
    const root = document.createElement("section"); document.body.append(root);
    renderDirectoryState(root, state, () => {}, null, {view: "access"});
    try {
      const more = root.querySelector('[aria-label="Load more access workspaces"]');
      more.focus(); more.click();
      const status = root.querySelector('[aria-label="Access workspace status"]'); status.focus();
      release([state.projects[1]]); await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector('[aria-label="Load more access workspaces"]'), null);
      assert.equal(document.activeElement, status);
    } finally {root.accessDirectory.dispose(); root.remove();}
  });

  it("retains loaded access workspaces and retries only the failed page on deliberate request", async () => {
    const state = directoryState(), requests = [];
    const recovered = {...state.projects[1], name: "Recovered workspace"};
    state.projects = Array.from({length: 100}, (_, index) => ({...state.projects[0],
      id: `c85a6d5e-0000-4000-8000-${String(index + 1).padStart(12, "0")}`}));
    state.adapter.listProjects = async options => {
      requests.push(options);
      if (requests.length === 1) throw Error("page unavailable");
      return [recovered];
    };
    state.adapter.createProject = () => assert.fail("Page retry cannot write");
    const root = document.createElement("section"); renderDirectoryState(root, state, () => {}, null, {view: "access"});
    const more = root.querySelector('[aria-label="Load more access workspaces"]');
    more.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(root.querySelector('.platform-project-directory [role="status"]').textContent, /100 workspaces retained/);
    assert.equal(root.querySelectorAll(".platform-project-directory-results a").length, 100);
    assert.equal(more.disabled, false);
    more.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(requests.map(({offset}) => offset), [100, 100]);
    assert.equal(root.querySelectorAll(".platform-project-directory-results a").length, 101);
    root.accessDirectory.dispose();
  });

  it("discards pending access-workspace pages and searches after account switch or disposal", async () => {
    for (const outcome of ["account", "dispose", "search-account", "search-dispose"]) {
      const state = directoryState(), otherAccount = "10000000-0000-4000-8000-000000000002";
      const projects = Array.from({length: 100}, (_, index) => ({...state.projects[0],
        id: `c85a6d5e-0000-4000-8000-${String(index + 1).padStart(12, "0")}`}));
      let release, signal;
      const adapter = {...state.adapter, organizationId: state.organization.id,
        getSession: async () => ({...state.session, selectedOrganizationId: adapter.organizationId,
          memberships: [{organizationId: state.organization.id, role: "admin"}, {organizationId: otherAccount, role: "admin"}]}),
        selectOrganization(id) {this.organizationId = id;},
        getCurrentOrganization: async () => ({...state.organization, id: adapter.organizationId}),
        listProjects(options) {
          if (options.offset || options.q) {signal = options.signal; return new Promise(resolve => {release = resolve;});}
          return Promise.resolve(this.organizationId === otherAccount ? [{...state.projects[0], name: "New account workspace"}] : projects);
        }};
      const root = PlatformDirectory({adapter, view: "access"}); document.body.append(root);
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (outcome.startsWith("search-")) {
          root.querySelector('input[type="search"]').value="Pending";
          root.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit",{cancelable:true}));
        } else root.querySelector('[aria-label="Load more access workspaces"]').click();
        if (outcome.endsWith("account")) {
          const account = root.querySelector('[aria-label="Studio account"]'); account.value = otherAccount;
          account.dispatchEvent(new harness.dom.window.Event("change"));
          await new Promise(resolve => setTimeout(resolve, 0));
        } else root.dispose();
        assert.equal(signal.aborted, true);
        release([{...state.projects[1], name: "Stale workspace"}]);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.doesNotMatch(root.textContent, /Stale workspace/);
        if (outcome.endsWith("account")) assert.match(root.textContent, /New account workspace/);
      } finally {root.dispose(); root.remove();}
    }
  });

  it("shares an unfinished account load when switching areas", async () => {
    const state = directoryState();
    let release, sessions = 0, signal;
    const root = PlatformDirectory({adapter: {...state.adapter,
      getSession: options => {sessions++; signal = options.signal; return new Promise(resolve => {release = resolve;});},
      selectOrganization() {}, getCurrentOrganization: async () => state.organization,
      listProjects: async () => state.projects,
      searchLayers: async () => [], listPublicationWorkspaces: async () => []
    }});
    document.body.append(root);
    try {
      const loading = root.querySelector(".platform-directory-loading");
      root.querySelector('.studio-navigation a[href="/workspaces?view=data"]').click();
      root.querySelector('.studio-navigation a[href="/workspaces?view=publishing"]').click();
      assert.equal(sessions, 1);
      assert.equal(signal.aborted, false);
      assert.equal(root.querySelector(".platform-directory-loading"), loading);
      release({...state.session, selectedOrganizationId: state.organization.id, memberships: []});
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(location.search, "?view=publishing");
      assert.equal(root.querySelector('.studio-navigation [aria-current="page"]').textContent, "Publications");
      assert.equal(root.querySelector(".platform-directory-loading"), null);
      assert.equal(sessions, 1);
    } finally {root.dispose();}
  });
  it("opens Projects without legacy inventory, client or team requests", async () => {
    const state = directoryState();
    let reads = 0;
    const forbidden = async () => {reads++; throw Error("unneeded request");};
    const root = PlatformDirectory({adapter: {...state.adapter,
      getSession: async () => ({...state.session, selectedOrganizationId: state.organization.id, memberships: []}),
      selectOrganization() {}, getCurrentOrganization: async () => state.organization,
      listProjects: forbidden, listClients: forbidden, listTeams: forbidden,
      listCompositions: async () => []
    }});
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector(".composition-directory")?.dataset.state, "ready");
      assert.equal(reads, 0);
      assert.equal(root.querySelector(".platform-project-directory"), null);
    } finally {root.dispose();}
  });
  it("opens independent account areas while access inventory is stalled and loads it only for the current account", async () => {
    const state = directoryState(), otherAccount = "10000000-0000-4000-8000-000000000002";
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const inventoryReads = [], resourceReads = [];
    let sessions = 0;
    const adapter = {...state.adapter, organizationId: state.organization.id,
      getSession: async () => {
        sessions++;
        return {...state.session, selectedOrganizationId: adapter.organizationId,
          memberships: [{organizationId: state.organization.id, role: "admin"}, {organizationId: otherAccount, role: "admin"}]};
      },
      selectOrganization(id) {this.organizationId = id;},
      getCurrentOrganization: async () => ({...state.organization, id: adapter.organizationId}),
      listProjects(options) {
        return new Promise(resolve => inventoryReads.push({organizationId: this.organizationId, options, resolve}));
      },
      listCollections: async () => {resourceReads.push(["collections", adapter.organizationId]); return [];},
      listLocations: async () => {resourceReads.push(["locations", adapter.organizationId]); return [];},
      listPublicationWorkspaces: async () => {resourceReads.push(["publishing", adapter.organizationId]); return [];}
    };
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=access");
    const root = PlatformDirectory({adapter, view: "access"}); document.body.append(root);
    try {
      await tick();
      assert.equal(inventoryReads.length, 1);
      for (const [view, selector, title] of [
        ["collections", ".collection-directory", "Collections"],
        ["locations", ".location-directory", "Geographic tags"],
        ["publishing", ".publication-workspace-directory", "Publications"]
      ]) {
        root.querySelector(`.studio-navigation a[href="/workspaces?view=${view}"]`).click();
        await tick();
        assert.equal(root.querySelector("h1")?.textContent, title);
        assert.ok(root.querySelector(selector));
        assert.equal(inventoryReads.length, 1, `${title} must not start or await an access inventory request`);
      }
      assert.deepEqual(resourceReads, [
        ["collections", state.organization.id], ["locations", state.organization.id], ["publishing", state.organization.id]
      ]);
      assert.equal(sessions, 1);
      const account = root.querySelector('[aria-label="Studio account"]');
      account.value = otherAccount; account.dispatchEvent(new harness.dom.window.Event("change"));
      await tick();
      assert.equal(sessions, 2, "Changing accounts must recheck authentication rather than reuse the prior account core");
      assert.equal(resourceReads.at(-1)[1], otherAccount);
      assert.equal(inventoryReads.length, 1);
      root.querySelector('a[href="/workspaces?view=access"]').click();
      await tick();
      assert.equal(inventoryReads.length, 2);
      assert.equal(inventoryReads[1].organizationId, otherAccount);
      inventoryReads[0].resolve([{...state.projects[0], name: "Stale prior account workspace"}]);
      await tick();
      assert.doesNotMatch(root.textContent, /Stale prior account workspace/);
      inventoryReads[1].resolve([{...state.projects[0], name: "Current account workspace"}]);
      await tick();
      assert.match(root.querySelector(".platform-project-directory-results").textContent, /Current account workspace/);
      assert.equal(sessions, 2);
    } finally {root.dispose();}
  });
  it("still waits for access inventory before explicit publication creation", async () => {
    const state = directoryState();
    let releaseInventory, inventoryReads = 0;
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=publishing&new=publication");
    const root = PlatformDirectory({adapter: {...state.adapter,
      getSession: async () => ({...state.session, selectedOrganizationId: state.organization.id, memberships: []}),
      selectOrganization() {}, getCurrentOrganization: async () => state.organization,
      listProjects: () => {inventoryReads++; return new Promise(resolve => {releaseInventory = resolve;});},
      listPublicationWorkspaces: async () => []
    }, view: "publishing"});
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(inventoryReads, 1);
      assert.equal(root.querySelector(".platform-project-creation-form"), null);
      releaseInventory(state.projects);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(root.querySelector(".platform-project-creation-form"));
    } finally {root.dispose();}
  });
  it("opens and preserves private publication creation while optional directories finish", async () => {
    const state = directoryState(), calls = [];
    let releasePublications, releasePublicSites;
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=publishing&new=publication");
    const root = PlatformDirectory({adapter: {...state.adapter,
      getSession: async () => {calls.push("session"); return {...state.session,
        userId: "20000000-0000-4000-8000-000000000001", selectedOrganizationId: state.organization.id, memberships: []};},
      selectOrganization() {},
      getCurrentOrganization: async () => {calls.push("account"); return state.organization;},
      listProjects: async () => {calls.push("projects"); return state.projects;},
      listPublicationWorkspaces: () => {calls.push("publication directory"); return new Promise(resolve => {releasePublications = resolve;});},
      listPublicSites: () => {calls.push("public directory"); return new Promise(resolve => {releasePublicSites = resolve;});},
      listClients() {assert.fail("New publication must not add a client inventory read");},
      listTeams() {assert.fail("New publication must not add a team inventory read");},
      createProject() {assert.fail("Opening the form must not create anything");}
    }, view: "publishing"});
    document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const form = root.querySelector(".platform-project-creation-form");
      assert.ok(form);
      assert.equal(form.querySelector('[aria-label="Project client"]').value, "");
      assert.equal(form.querySelector('[aria-label="Share new project with team"]').value, "");
      assert.doesNotMatch(root.textContent, /Loading the client and team choices/);
      assert.deepEqual(calls, ["session", "account", "projects", "publication directory", "public directory"]);
      const name = form.querySelector('[aria-label="New project name"]');
      const title = form.querySelector('[aria-label="Publication title"]');
      const slug = form.querySelector('[aria-label="Source identifier"]');
      name.value = "Private project draft";
      name.dispatchEvent(new harness.dom.window.Event("input"));
      title.value = "Private publication draft";
      title.dispatchEvent(new harness.dom.window.Event("input"));
      slug.value = "private-source-draft";
      slug.dispatchEvent(new harness.dom.window.Event("input"));
      slug.focus(); slug.setSelectionRange(3, 9);
      releasePublications([]); releasePublicSites({records: []});
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector(".platform-project-creation-form"), form);
      assert.equal(name.value, "Private project draft");
      assert.equal(title.value, "Private publication draft");
      assert.equal(slug.value, "private-source-draft");
      assert.equal(document.activeElement, slug);
      assert.deepEqual([slug.selectionStart, slug.selectionEnd], [3, 9]);
    } finally {root.dispose(); releasePublications([]); releasePublicSites({records: []});}
  });
  it("clears a pending private publication form when the login identity changes", async () => {
    const state = directoryState();
    let releasePublications, releasePublicSites, token = "initial-user-token";
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=publishing&new=publication");
    const root = PlatformDirectory({adapter: {...state.adapter,
      tokenProvider: () => token, organizationProvider: () => state.organization.id,
      getSession: async () => ({...state.session, userId: "20000000-0000-4000-8000-000000000001",
        selectedOrganizationId: state.organization.id, memberships: []}),
      selectOrganization() {}, getCurrentOrganization: async () => state.organization,
      listProjects: async () => state.projects,
      listPublicationWorkspaces: () => new Promise(resolve => {releasePublications = resolve;}),
      listPublicSites: () => new Promise(resolve => {releasePublicSites = resolve;}),
      createProject() {assert.fail("Completing directories must not submit the draft");}
    }, view: "publishing"});
    document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const form = root.querySelector(".platform-project-creation-form");
      assert.ok(form);
      form.querySelector('[aria-label="New project name"]').value = "Previous login private draft";
      token = "different-user-token";
      releasePublications([]); releasePublicSites({records: []});
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector(".platform-project-creation-form"), null);
      assert.equal(root.querySelector(".platform-state")?.dataset.state, "forbidden");
      assert.doesNotMatch(root.textContent, /Previous login private draft/);
    } finally {root.dispose();}
  });
  it("creates a fresh publication form after an account switch and ignores the old directory completion", async () => {
    const state = directoryState(), otherAccount = "10000000-0000-4000-8000-000000000002", reads = [];
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=publishing&new=publication");
    const adapter = {...state.adapter, organizationId: state.organization.id,
      getSession: async () => ({...state.session, userId: "20000000-0000-4000-8000-000000000001",
        selectedOrganizationId: adapter.organizationId,
        memberships: [{organizationId: state.organization.id, role: "admin"}, {organizationId: otherAccount, role: "admin"}]}),
      selectOrganization(id) {this.organizationId = id;},
      getCurrentOrganization: async () => ({...state.organization, id: adapter.organizationId}),
      listProjects: async () => [],
      listPublicationWorkspaces: () => new Promise(resolve => {reads.push({account: adapter.organizationId, resolve});}),
      listPublicSites: async () => ({records: []}),
      createProject() {assert.fail("Switching accounts must not create a publication");}
    };
    const root = PlatformDirectory({adapter, view: "publishing"}); document.body.append(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const previousForm = root.querySelector(".platform-project-creation-form");
      assert.ok(previousForm);
      previousForm.querySelector('[aria-label="New project name"]').value = "Prior account private draft";
      const account = root.querySelector('[aria-label="Studio account"]'); account.value = otherAccount;
      account.dispatchEvent(new harness.dom.window.Event("change"));
      assert.equal(root.querySelector(".platform-project-creation-form"), null);
      await new Promise(resolve => setTimeout(resolve, 0));
      const currentForm = root.querySelector(".platform-project-creation-form");
      assert.ok(currentForm); assert.notEqual(currentForm, previousForm);
      assert.equal(currentForm.querySelector('[aria-label="New project name"]').value, "");
      assert.deepEqual(reads.map(read => read.account), [state.organization.id, otherAccount]);
      reads[0].resolve([{title: "Stale prior account publication"}]);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector(".platform-project-creation-form"), currentForm);
      assert.doesNotMatch(root.textContent, /Prior account private draft|Stale prior account publication/);
      reads[1].resolve([]);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector(".platform-project-creation-form"), currentForm);
    } finally {root.dispose();}
  });
  it("defers the public endpoint when creating a private publication", () => {
    globalThis.location = {href: "https://studio.opengeo.tools/workspaces?new=publication", origin: "https://studio.opengeo.tools"};
    const state = directoryState();
    state.adapter.saveObservableSourceRevision = async () => {};
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {});
    const form = root.querySelector(".platform-project-creation-form");
    assert.ok(form.querySelector('[aria-label="Source identifier"]'));
    assert.match(form.textContent, /Choose a public address later in Publish/);
    assert.doesNotMatch(form.textContent, /Planned address:|https:\/\/opengeo.tools\//);
    assert.deepEqual([...form.querySelectorAll('[aria-label="Publication format"] option')].map(option => option.value),
      ["framework", "html", "map", "notebook", "jupyter"]);
  });
  it("switches directory views without restarting account loading and handles browser history", async () => {
    const state = directoryState();
    let sessions = 0;
    const root = PlatformDirectory({adapter: {...state.adapter,
      getSession: async () => {sessions++; return {...state.session, selectedOrganizationId: state.organization.id, memberships: []};},
      selectOrganization() {}, getCurrentOrganization: async () => state.organization,
      listProjects: async () => state.projects,
      searchLayers: async () => [], listPublicationWorkspaces: async () => []
    }});
    document.body.append(root);
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    await tick(); await tick();
    root.querySelector('.studio-navigation a[href="/workspaces?view=data"]').click();
    await tick();
    assert.equal(location.search, "?view=data");
    assert.equal(root.querySelector("h1").textContent, "Catalog");
    assert.equal(root.querySelector(".platform-directory-loading"), null);
    root.querySelector('.studio-navigation a[href="/workspaces?view=publishing"]').click();
    await tick();
    assert.equal(sessions, 1);
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=data");
    harness.dom.window.dispatchEvent(new harness.dom.window.PopStateEvent("popstate"));
    await tick();
    assert.equal(root.querySelector("h1").textContent, "Catalog");
    root.dispose();
  });

  it("keeps shared Studio navigation across account views", () => {
    for (const view of ["projects", "data", "sources", "publishing", "teams"]) {
      const root = document.createElement("section");
      renderDirectoryState(root, directoryState(), () => {}, null, {view});
      const nav = root.querySelector('nav[aria-label="Studio navigation"]');
      assert.ok(nav);
      assert.deepEqual([...nav.querySelectorAll("a")].map(a => a.textContent),
        ["OpenGeo Studio", "Home", "Projects", "Catalog", "Styles", "Geographic tags", "Collections", "Publications"]);
      assert.equal(nav.querySelector('a[href="/workspaces?view=publishing"]')?.textContent, "Publications");
      assert.equal(root.querySelector('select[aria-label="Catalog layout"]'), null);
    }
  });

  it("browses grouped layers in bounded fifty-entry pages", async () => {
    const state = directoryState(), requests = [];
    state.adapter.searchLayers = async options => {
      requests.push(options);
      return Array.from({length: options.offset ? 1 : 51}, (_, i) => ({
        datasetId: "dataset", projectId: state.projects[0].id,
        projectName: "MassGIS", datasetName: "Screening", title: `Layer ${options.offset + i}`,
        layerId: String(i), format: "geojson"
      }));
    };
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "data"});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector('select[aria-label="Catalog entries"]').value, "datasets");
    assert.equal(requests.length, 0, "resource inventory does not enumerate map presentations");
    const entries = root.querySelector('select[aria-label="Catalog entries"]');
    entries.value = "layers";
    entries.dispatchEvent(new harness.dom.window.Event("change"));
    root.querySelector(".platform-catalog-controls").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests[0].limit, 51);
    assert.equal(root.querySelectorAll(".layer-catalog-entry").length, 50);
    assert.equal(root.querySelectorAll(".catalog-dataset-group").length, 1);
    assert.equal(root.querySelector(".catalog-dataset-group").open, true);
    [...root.querySelectorAll("button")].find(b => b.textContent === "Next page").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests.at(-1).offset, 50);
    assert.equal(root.querySelectorAll(".layer-catalog-entry").length, 1);
  });

  it("groups loaded resources by library identity and retains rows and disclosures when more arrive", () => {
    const record = (id, projectId) => ({id, projectId, name:"Same dataset title", format:"geojson",
      classification:"public", updatedAt:"2026-10-08T12:00:00Z"});
    const root = catalogTable([record("first", "library-a"), record("second", "library-b")],
      [{id:"library-a", name:"Same library title"}, {id:"library-b", name:"Same library title"}]);
    const groups = [...root.querySelectorAll(".platform-catalog-resource-group")];
    assert.equal(groups.length, 2, "similar titles never merge distinct library identities");
    assert.ok(groups.every(group => group.open), "initial resources are visible without opening each library");
    const row = groups[0].querySelector(".platform-catalog-resource-row");
    groups[0].open = false;
    root.appendRecords([record("third", "library-a"), record("first", "library-a")]);
    assert.equal(groups[0].querySelector(".platform-catalog-resource-row"), row);
    assert.equal(groups[0].open, false);
    assert.equal(root.querySelectorAll(".platform-catalog-resource-row").length, 3);
    assert.match(groups[0].querySelector("summary").textContent, /2 loaded datasets/);
    assert.match(groups[1].querySelector("summary").textContent, /1 loaded dataset/);
    const metadataLinks = [...root.querySelectorAll(".platform-catalog-resource-row td:first-child > a:first-child")];
    assert.equal(metadataLinks.length, 3, "each dataset keeps its own metadata route");
    assert.equal(new Set(metadataLinks.map(link => link.href)).size, 3);
    assert.equal(groups[0].querySelector('[role="region"]').tabIndex, 0);
    assert.ok([...root.querySelectorAll("th")].every(heading => heading.scope === "col"));
  });

  it("keeps catalog groups visible initially and preserves disclosure choices on search", async () => {
    const state = directoryState(), requests = [];
    state.adapter.searchDatasets = async filters => {
      requests.push(filters);
      return [{id:"dataset-a", projectId:state.projects[0].id, name:"Matching layer", format:"geojson",
        classification:"public", updatedAt:"2026-10-08T12:00:00Z"}];
    };
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view:"data"});
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    await tick();
    const group = root.querySelector(".platform-catalog-resource-group");
    assert.equal(group.open, true);
    group.open = false;
    group.dispatchEvent(new harness.dom.window.Event("toggle"));
    await tick();
    assert.equal(requests.length, 1, "group disclosure stays local");
    const query = root.querySelector('[aria-label="Search organization datasets"]');
    query.value = "Matching";
    query.dispatchEvent(new harness.dom.window.Event("input"));
    root.querySelector(".platform-catalog-controls").dispatchEvent(new harness.dom.window.Event("submit", {cancelable:true}));
    await tick();
    assert.equal(requests.at(-1).query, "Matching");
    assert.equal(root.querySelector(".platform-catalog-resource-group").open, false);
    assert.match(root.textContent, /counts show loaded records/);
    assert.equal(root.querySelector('[aria-label="Dataset catalog pages"] button:last-child').disabled, true);
  });

  it("keeps catalog rows stable while filters are edited and searches all accessible pages on demand", async () => {
    const state = directoryState(), requests = [];
    let releaseSearch;
    harness.dom.window.IntersectionObserver = class {constructor() {assert.fail("Catalog opening must not start a page-loading observer");}};
    const record = (id, name) => ({id, name, projectId:state.projects[0].id, format:"geojson",
      classification:"public", updatedAt:"2026-10-09T12:00:00Z", catalogMatchCount:1000});
    state.adapter.searchDatasets = filters => {
      requests.push(filters);
      if (filters.query === "NOAA") return new Promise(resolve => {releaseSearch = resolve;});
      if (filters.query === "unavailable") return Promise.reject({code:"service_unavailable"});
      return Promise.resolve(Array.from({length:25}, (_, i) => record(`dataset-${i}`, `ICIMOD ${i}`)));
    };
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view:"data"});
    document.body.append(root);
    const tick = () => new Promise(resolve => setTimeout(resolve,0));
    await tick(); await tick();
    assert.equal(requests.length,1,"opening a catalog loads one bounded page");
    assert.equal(requests[0].limit,25);
    assert.equal(requests[0].projectId,null,"initial discovery searches all accessible libraries");
    assert.match(root.textContent,/1,000 matching records.*24 loaded.*load more available/);
    const row = root.querySelector(".platform-catalog-resource-row");
    const group = root.querySelector(".platform-catalog-resource-group");
    group.open = false;
    const query = root.querySelector('[aria-label="Search organization datasets"]');
    const submit = root.querySelector(".platform-catalog-controls");
    query.value = "NOAA"; query.dispatchEvent(new harness.dom.window.Event("input"));
    assert.equal(root.querySelector(".platform-catalog-resource-row"),row,"typing keeps the existing rows mounted");
    assert.equal(requests.length,1,"filter editing does not search before Submit");
    submit.dispatchEvent(new harness.dom.window.Event("submit",{cancelable:true}));
    assert.equal(root.querySelector(".platform-catalog-resource-row"),row,"pending search keeps the visible list");
    releaseSearch([record("noaa","NOAA coastal imagery")]); await tick();
    assert.equal(requests.at(-1).query,"NOAA");
    assert.equal(requests.at(-1).offset,0,"text search is global rather than filtering loaded rows");
    assert.equal(root.querySelectorAll(".platform-catalog-resource-row").length,1);
    assert.equal(root.querySelector(".platform-catalog-resource-group").open,false,"the same library retains the user's collapse choice");
    assert.match(root.textContent,/NOAA coastal imagery/);
    query.value = "unavailable"; query.dispatchEvent(new harness.dom.window.Event("input"));
    submit.dispatchEvent(new harness.dom.window.Event("submit",{cancelable:true})); await tick();
    assert.match(root.textContent,/NOAA coastal imagery/);
    assert.match(root.textContent,/Current results retained/);
    root.catalogDirectory.dispose();
  });

  for (const intent of ["map", "publication"]) {
    it(`completes ${intent} setup once and opens the created workspace`, async () => {
      globalThis.location = {href: `https://studio.opengeo.tools/workspaces?new=${intent}`, origin: "https://studio.opengeo.tools"};
      const state = directoryState();
      const calls = [];
      for (const method of ["createProject", "createMap", "createResource", "createSite", "createObservableSourceProject"]) {
        state.adapter[method] = async (...args) => {
          calls.push({method, args});
          return {id: method === "createProject" ? state.projects[0].id : method === "createMap" ? "60000000-0000-4000-8000-000000000099" : method === "createSite" ? "b0000000-0000-4000-8000-000000000099" : `${method}-id`, name: "My project", version: 1, versionNumber: 1};
        };
      }
      const root = document.createElement("section");
      renderDirectoryState(root, state, () => {});
      const form = root.querySelector(".platform-project-creation-form");
      const name = form.querySelector('input[aria-label="New project name"]');
      name.value = "My project";
      name.dispatchEvent(new harness.dom.window.Event("input"));
      const submit = () => form.dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
      submit();
      submit();
      await new Promise(resolve => setTimeout(resolve, 0));
      submit();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls.map(call => call.method), intent === "map"
        ? ["createProject", "createMap"]
        : ["createProject", "createResource", "createSite", "createObservableSourceProject"]);
      assert.equal(calls[0].args[0].name, "My project");
      const target = new URL(location.href);
      if (intent === "publication") {
        assert.equal(target.searchParams.get("publication"), "b0000000-0000-4000-8000-000000000099");
        assert.equal(target.searchParams.has("project"), false);
        assert.equal(calls[2].args[1].pages[0].resourceId, "createResource-id");
        assert.equal(calls[3].args[1], "b0000000-0000-4000-8000-000000000099");
      } else {
        assert.equal(target.searchParams.get("composition"), "60000000-0000-4000-8000-000000000099");
        assert.equal(target.searchParams.has("project"), false);
        assert.equal(target.searchParams.has("map"), false);
      }
    });
  }

  for (const [intent, failedStep] of [
    ["map", "createMap"],
    ["publication", "createResource"],
    ["publication", "createSite"],
    ["publication", "createObservableSourceProject"],
    ["publication", "createProjectTeamGrant"]
  ]) {
    it(`opens the existing ${intent} project after ${failedStep} fails without replaying creation`, async () => {
      harness.dom.reconfigure({url: `https://studio.opengeo.tools/workspaces?new=${intent}`});
      const state = directoryState();
      const calls = [];
      for (const method of ["createProject", "createMap", "createResource", "createSite", "createObservableSourceProject", "createProjectTeamGrant"]) {
        state.adapter[method] = async () => {
          calls.push(method);
          if (method === failedStep) throw Object.assign(new Error("Response lost"), {status: 0, code: "request_failed"});
          return {id: method === "createProject" ? state.projects[0].id : method === "createMap" ? "60000000-0000-4000-8000-000000000099" : `${method}-id`, name: "My project", versionNumber: 1};
        };
      }
      state.teams = [{id: "team-1", name: "Review team"}];
      const root = document.createElement("section");
      renderDirectoryState(root, state, () => {});
      const form = root.querySelector(".platform-project-creation-form");
      form.querySelector('input[aria-label="New project name"]').value = "My project";
      if (failedStep === "createProjectTeamGrant") form.querySelector('select[aria-label="Share new project with team"]').value = "team-1";
      const submit = () => form.dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
      submit();
      submit(); // A second event while the first request is pending must be ignored.
      await new Promise(resolve => setTimeout(resolve, 0));
      submit(); // A stale form submission after partial success must also be ignored.
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(calls.filter(method => method === "createProject").length, 1);
      assert.equal(calls.filter(method => method === failedStep).length, 1);
      assert.equal(calls.at(-1), failedStep);
      assert.equal(form.querySelector('button[type="submit"]'), null);
      const recovery = [...form.querySelectorAll("a")].find(anchor => anchor.textContent === "Open existing project");
      assert.ok(recovery);
      const target = new URL(recovery.href);
      assert.equal(target.searchParams.get("project"), state.projects[0].id);
      if (failedStep === "createObservableSourceProject") assert.equal(target.hash, "#framework-source");
      if (failedStep === "createProjectTeamGrant") {
        assert.equal(target.searchParams.get("manage"), "settings");
        assert.equal(target.hash, "#project-settings");
        assert.match(form.textContent, /Team access could not be confirmed/);
      }
      assert.ok([...form.querySelectorAll("input, select, textarea")].every(field => field.disabled));
    });
  }

  for (const status of [0, 500, 503, 400, 403, 422]) {
    it(`handles an initial project creation error with HTTP status ${status} without inventing an outcome`, async () => {
      harness.dom.reconfigure({url: "https://studio.opengeo.tools/workspaces?new=map"});
      const state = directoryState();
      let calls = 0;
      state.adapter.createProject = async () => {
        calls++;
        throw Object.assign(new Error("Request failed"), {status, code: "test_failure"});
      };
      const root = document.createElement("section");
      renderDirectoryState(root, state, () => {});
      const form = root.querySelector(".platform-project-creation-form");
      const submit = () => form.dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
      submit();
      await new Promise(resolve => setTimeout(resolve, 0));
      const ambiguous = status === 0 || status >= 500;
      if (ambiguous) {
        assert.match(form.textContent, /could not confirm whether the project was created/);
        const recovery = [...form.querySelectorAll("a")].find(anchor => anchor.textContent === "Check projects");
        assert.equal(recovery?.href, "https://studio.opengeo.tools/workspaces");
      } else {
        assert.match(form.textContent, /request was rejected/);
        assert.equal(form.querySelector('input[aria-label="New project name"]').disabled, false);
        assert.equal(form.querySelector('select[aria-label="Team project role"]').disabled, true);
        assert.equal(form.querySelector('button[type="submit"]').disabled, false);
      }
      submit();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(calls, ambiguous ? 1 : 2);
    });
  }

  it("keeps the chosen archive filter while optional team details finish loading", async () => {
    const ready = directoryState();
    ready.projects[1].status = "archived";
    let finishTeams;
    const teams = new Promise(resolve => { finishTeams = resolve; });
    const root = PlatformDirectory({view: "access", adapter: {
      kind: "api",
      getSession: async () => ({...ready.session, memberships: [{organizationId: ready.organization.id}], selectedOrganizationId: ready.organization.id}),
      selectOrganization() {},
      getCurrentOrganization: async () => ready.organization,
      listProjects: async () => ready.projects,
      listClients: async () => [],
      listTeams: () => teams
    }});
    await new Promise(resolve => setTimeout(resolve, 0));
    const status = root.querySelector('select[aria-label="Access workspace status"]');
    assert.ok(status);
    status.value = "archived";
    status.dispatchEvent(new harness.dom.window.Event("change"));
    finishTeams([]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector('select[aria-label="Access workspace status"]').value, "archived");
    assert.equal(root.querySelectorAll(".platform-project-row").length, 1);
    assert.match(root.querySelector(".platform-project-row").getAttribute("href"), /manage=settings/);
  });

  it("finds archived projects separately and opens their settings for restoration", () => {
    const root = document.createElement("section");
    const state = directoryState();
    state.projects[1].status = "archived";
    renderDirectoryState(root, state, () => {}, null, {view: "access"});
    assert.equal(root.querySelectorAll(".platform-project-row").length, 1);
    const status = root.querySelector('select[aria-label="Access workspace status"]');
    status.value = "archived";
    status.dispatchEvent(new harness.dom.window.Event("change"));
    const row = root.querySelector(".platform-project-row");
    assert.equal(root.querySelectorAll(".platform-project-row").length, 1);
    assert.equal(row.getAttribute("href"), `/workspaces?project=${state.projects[1].id}&manage=settings#project-settings`);
    status.value = "all";
    status.dispatchEvent(new harness.dom.window.Event("change"));
    assert.equal(root.querySelectorAll(".platform-project-row").length, 2);
  });

  it("makes people administration discoverable to admins without exposing it as a member action", () => {
    for (const kind of ["api", "fixture"]) {
      for (const role of ["admin", "member", "guest"]) {
        const root = document.createElement("section");
        const state = directoryState();
        state.adapter.kind = kind;
        state.organization.callerRole = role;
        renderDirectoryState(root, state, () => {}, null, {view: "teams"});
        const accessLinks = [...root.querySelectorAll('a[href^="/admin"]')];
        assert.equal(accessLinks.length, role === "admin" ? 2 : 0);
        for (const entry of accessLinks) {
          assert.equal(entry.getAttribute("href"), kind === "api" ? "/admin" : "/admin?adapter=fixture");
        }
        if (role === "admin") {
          assert.deepEqual(accessLinks.map(({textContent}) => textContent), [
            "People and access", "Invite people and manage access"
          ]);
        }
      }
    }
  });

  it("makes each full row the open target and removes the arbitrary first-project action", () => {
    const root = document.createElement("section");
    const state = directoryState();

    renderDirectoryState(root, state, () => {});

    assert.equal(root.querySelectorAll(".platform-directory-action").length, 1);
    assert.match(root.querySelector(".platform-directory-action")?.textContent ?? "", /New Project/);
    assert.equal(
      [...root.querySelectorAll(".platform-directory-action strong")]
        .some(({textContent}) => textContent === "Open project"),
      false
    );
    assert.equal(root.querySelectorAll("a.platform-project-row").length, 0);
    assert.ok(root.querySelector(".composition-directory"));
    const accessRoot = document.createElement("section");
    renderDirectoryState(accessRoot, state, () => {}, null, {view: "access"});
    const rows = [...accessRoot.querySelectorAll("a.platform-project-row")];
    assert.equal(rows.length, 2);
    assert.match(rows[0].getAttribute("href"), /manage=settings/);
    assert.match(accessRoot.querySelector(".platform-project-directory-heading").textContent, /2 data access containers/);
    assert.equal(root.querySelector(".platform-resource-navigation"), null);
    assert.match(root.querySelector(".platform-account-menu")?.textContent ?? "", /Account settings.*People and access.*Teams.*Connections/);
    assert.equal(
      root.querySelector('.studio-navigation a[aria-current="page"]')?.getAttribute("href"),
      "/workspaces"
    );
  });

  it("opens data, sources, publishing, and teams as first-class directory views", async () => {
    const state = directoryState();
    state.adapter.searchDatasets = async (request) => {
      assert.equal(request.limit, 25);
      return [{
        id: "dataset-1",
        name: "MassEnviroScreen",
        projectId: state.projects[0].id,
        format: "GeoJSON",
        classification: "public",
        updatedAt: "2026-08-30T12:00:00Z"
      }];
    };

    const dataRoot = document.createElement("section");
    renderDirectoryState(dataRoot, state, () => {}, null, {view: "data"});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dataRoot.querySelector("h1")?.textContent, "Catalog");
    assert.equal(dataRoot.querySelector("#data")?.hidden, false);
    assert.match(dataRoot.querySelector(".platform-catalog-table")?.textContent ?? "", /MassEnviroScreen/);
    assert.equal(
      dataRoot.querySelector(".platform-catalog-table a")?.getAttribute("href"),
      "/layers?id=dataset-1"
    );
    assert.equal(dataRoot.querySelector(".platform-project-directory"), null);
    assert.equal(dataRoot.querySelector("h2")?.textContent, "Layers, datasets and files");
    assert.deepEqual(
      [...dataRoot.querySelector('[aria-label="Catalog project"]').options].map(option => option.value),
      ["", ...state.projects.map(project => project.id)]
    );
    assert.equal(
      dataRoot.querySelector('.studio-navigation a[aria-current="page"]')?.getAttribute("href"),
      "/workspaces?view=data"
    );

    const sourcesRoot = document.createElement("section");
    renderDirectoryState(sourcesRoot, state, () => {}, null, {view: "sources"});
    assert.equal(sourcesRoot.querySelector("h1")?.textContent, "Connections");
    assert.equal(sourcesRoot.querySelector("#source-capabilities"), null);
    assert.equal(sourcesRoot.querySelector('.platform-account-navigation [aria-current="page"]')?.textContent, "Connections");
    assert.equal(sourcesRoot.querySelector('.studio-navigation [aria-current="page"]'), null);
    assert.equal(sourcesRoot.querySelector("#connections")?.open, true);
    assert.match(sourcesRoot.querySelector("#connections")?.textContent ?? "", /Your connections/);

    const publishingRoot = document.createElement("section");
    renderDirectoryState(publishingRoot, state, () => {}, null, {view: "publishing"});
    assert.equal(publishingRoot.querySelector("h1")?.textContent, "Publications");
    assert.equal(publishingRoot.querySelectorAll(".publication-workspace-table tbody tr").length, 1);
    assert.match(
      publishingRoot.querySelector(".publication-workspace-table")?.textContent ?? "",
      /MassGIS public atlas.*Primary home.*MassGIS Property Tax Parcels/s
    );
    assert.equal(
      publishingRoot.querySelector(".publication-endpoint a")?.getAttribute("href"),
      `/api/public/organizations/${state.organization.id}/publications/massgis-atlas`
    );
    assert.equal(
      [...publishingRoot.querySelectorAll(".publication-workspace-table a")]
        .find(({textContent}) => textContent === "MassGIS public atlas")?.getAttribute("href"),
      `/workspaces?publication=b0000000-0000-4000-8000-000000000071`
    );
    assert.equal(
      publishingRoot.querySelector('.studio-navigation a[aria-current="page"]')
        ?.getAttribute("href"),
      "/workspaces?view=publishing"
    );

    const teamsRoot = document.createElement("section");
    renderDirectoryState(teamsRoot, state, () => {}, null, {view: "teams"});
    assert.equal(teamsRoot.querySelector("h1")?.textContent, "Account teams");
    assert.equal(teamsRoot.querySelector("#teams")?.open, true);
    assert.match(teamsRoot.querySelector("#teams")?.textContent ?? "", /Organization teams/);
  });

  for (const outcome of ["empty", "failed"]) {
    it(`keeps the Data route distinct from projects when catalog lookup is ${outcome}`, async () => {
      harness.dom.reconfigure({url: "https://studio.opengeo.tools/workspaces?view=data"});
      const state = directoryState();
      state.adapter.searchDatasets = async () => {
        if (outcome === "failed") throw Object.assign(new Error("Unavailable"), {code: "service_unavailable"});
        return [];
      };
      const root = document.createElement("section");
      renderDirectoryState(root, state, () => {});
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(root.querySelector("h2")?.textContent, "Layers, datasets and files");
      assert.equal(root.querySelector(".platform-project-directory"), null);
      assert.equal(root.querySelector(".platform-catalog-table"), null);
      assert.match(root.querySelector("#data").textContent, outcome === "empty"
        ? /0 matching records/
        : /Catalog search failed safely \(service_unavailable\)/);
      assert.equal(root.querySelector('[aria-label="Dataset catalog pages"] button:last-child').disabled, true);
      assert.ok(root.querySelector('.studio-navigation a[href="/workspaces"]'));
    });
  }

  it("pages authorized files without truncating at the first 100 and discards late filtered responses", async () => {
    const state = directoryState();
    const requests = [];
    let releaseOld;
    state.adapter.searchDatasets = async filters => {
      requests.push(filters);
      if (filters.query === "old") return await new Promise(resolve => {releaseOld = resolve;});
      return Array.from({length: filters.offset === 0 ? 25 : 2}, (_, index) => ({
        id: `dataset-${filters.offset + index}`, name: `File ${filters.offset + index}`,
        projectId: state.projects[0].id, format: "GeoJSON", classification: "public", updatedAt: "2026-09-09T12:00:00Z"
      }));
    };
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "data"});
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    await tick();
    const pager = root.querySelector('[aria-label="Dataset catalog pages"]');
    pager.querySelector("button:last-child").click();
    await tick();
    assert.equal(requests.at(-1).offset, 24);
    assert.match(root.querySelector(".platform-catalog-table").textContent, /File 24/);
    assert.equal(pager.querySelector("button:last-child").disabled, true);
    const query = root.querySelector('[aria-label="Search organization datasets"]');
    query.value = "old";
    query.dispatchEvent(new harness.dom.window.Event("input"));
    root.querySelector(".platform-catalog-search form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    await tick();
    query.value = "new";
    query.dispatchEvent(new harness.dom.window.Event("input"));
    releaseOld([{id: "old", name: "Stale private result"}]);
    await tick();
    assert.doesNotMatch(root.textContent, /Stale private result/);
    assert.equal(pager.querySelector("button:last-child").disabled, true);
  });

  it("reuses the data view for an anonymous-safe published catalog", async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const state = directoryState();
    const calls = [];
    const detailHref = `/public/organizations/${state.organization.id}/projects/${state.projects[0].id}/resources/90000000-0000-4000-8000-000000000068`;
    state.adapter.baseUrl = "/api";
    state.adapter.searchDatasets = async () => [];
    state.adapter.listPublicResources = async (organizationId, filters) => {
      calls.push({organizationId, filters});
      return {
        schemaVersion: "opengeo.public-catalog.1.5.0",
        numberReturned: 1,
        numberMatched: 1,
        limit: 24,
        offset: 0,
        nextOffset: null,
        facetSampleSize: 1,
        facetsTruncated: false,
        facets: {
          kind: [{value: "dataset", label: "Dataset", count: 1}],
          project: [{value: state.projects[0].id, label: state.projects[0].name, count: 1}],
          license: [{value: "CC-BY-4.0", label: "CC-BY-4.0", count: 1}],
          keyword: [{value: "parcels", label: "parcels", count: 1}],
          origin: [{value: "massgis", label: "MassGIS", count: 1}]
        },
        records: [{
          id: "90000000-0000-4000-8000-000000000068",
          kind: "dataset",
          title: "Property Tax Parcels",
          license: "CC-BY-4.0",
          community: {
            organizationId: state.organization.id,
            organizationName: "OpenGeo.tools",
            projectId: state.projects[0].id,
            projectName: state.projects[0].name
          },
          preview: {kind: "dataset", href: `${detailHref}/spatial-preview`},
          freshness: {catalogUpdatedAt: "2026-09-01T14:00:00Z"},
          provenance: {namespace: "massgis"},
          relationships: {publicCount: 2, detailHref},
          ratings: {count: 4, average: 4.5}
        }]
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "data"});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const audience = root.querySelector('[aria-label="Catalog audience"]');
    audience.value = "published";
    audience.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(root.querySelector('[aria-label="Catalog client"]').hidden, true);
    assert.equal(root.querySelector('[aria-label="Catalog sensitivity"]').hidden, true);
    assert.equal(root.querySelector('[aria-label="Published resource type"]').hidden, false);
    root.querySelector('[aria-label="Search published resources"]').value = "parcel";
    root.querySelector('[aria-label="Published resource type"]').value = "dataset";
    const bounds = root.querySelector('[aria-label="Catalog bounds west,south,east,north"]');
    assert.equal(bounds.disabled, false);
    bounds.value = "-73,40,-69,44";
    root.querySelector('[aria-label="Catalog time from (UTC)"]').value = "2025-01-01T00:00";
    root.querySelector('[aria-label="Catalog time through (UTC)"]').value = "2026-01-01T00:00";
    assert.equal(root.querySelector('[aria-label="Catalog place identity URL"]').disabled, true);
    root.querySelector(".platform-catalog-search form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{
      organizationId: state.organization.id,
      filters: {
        query: "parcel",
        projectId: null,
        kind: "dataset",
        bbox: [-73,40,-69,44],
        temporalStart: "2025-01-01T00:00Z",
        temporalEnd: "2026-01-01T00:00Z",
        limit: 24,
        offset: 0
      }
    }]);
    assert.match(root.querySelector(".platform-public-catalog-results")?.textContent ?? "", /Property Tax Parcels/);
    assert.match(root.querySelector(".platform-public-catalog-results")?.textContent ?? "", /MassGIS/);
    assert.match(
      root.querySelector(".platform-public-catalog-results")?.textContent ?? "",
      /Rated 4\.5 of 5 · 4 ratings/
    );
    assert.equal(
      root.querySelector(".platform-public-catalog-table a")?.getAttribute("href"),
      `/workspaces?view=data&publicProject=${state.projects[0].id}&publicResource=90000000-0000-4000-8000-000000000068`
    );
    assert.doesNotMatch(root.textContent, /bucket|object key|owner user/i);
    bounds.value = "170,0,-170,10";
    root.querySelector(".platform-catalog-search form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    await tick(); assert.equal(calls.length, 1);
    assert.match(root.textContent, /catalog_bbox_invalid/);
    bounds.value = "";
    root.querySelector('[aria-label="Catalog time from (UTC)"]').value = "2027-01-01T00:00";
    root.querySelector(".platform-catalog-search form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    await tick(); assert.equal(calls.length, 1);
    assert.match(root.textContent, /catalog_time_invalid/);
  });

  it("keeps canonical dataset update-time filters distinct from resource coverage and disables presentation-only filters", async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const state = directoryState(), calls = [];
    state.adapter.searchDatasets = async filters => {calls.push(filters); return [];};
    state.adapter.searchLayers = async () => [];
    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "data"});
    await tick(); calls.length = 0;
    const field = label => root.querySelector(`[aria-label="${label}"]`);
    field("Catalog bounds west,south,east,north").value = "170,0,-170,10";
    field("Catalog updated after (UTC)").value = "2025-01-01T00:00";
    field("Catalog updated before (UTC)").value = "2026-01-01T00:00";
    root.querySelector(".platform-catalog-search form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    await tick(); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].bbox, [170,0,-170,10]);
    assert.equal(calls[0].updatedAfter, "2025-01-01T00:00Z");
    assert.equal(calls[0].updatedBefore, "2026-01-01T00:00Z");
    assert.equal(Object.hasOwn(calls[0], "temporalStart"), false);
    field("Catalog entries").value = "layers";
    field("Catalog entries").dispatchEvent(new harness.dom.window.Event("change"));
    assert.equal(field("Catalog bounds west,south,east,north").disabled, true);
    assert.equal(field("Catalog updated after (UTC)").disabled, true);
  });

  it("opens a persistent public resource detail without sending people to raw JSON", async () => {
    const state = directoryState();
    const projectId = state.projects[0].id;
    const resourceId = "90000000-0000-4000-8000-000000000068";
    const apiHref = `/public/organizations/${state.organization.id}/projects/${projectId}/resources/${resourceId}`;
    const calls = [];
    state.adapter.baseUrl = "/api";
    state.adapter.getPublicResource = async (organizationId, requestedProjectId, requestedResourceId) => {
      calls.push({kind: "record", organizationId, projectId: requestedProjectId, resourceId: requestedResourceId});
      return {
        id: resourceId,
        kind: "dataset",
        slug: "property-tax-parcels",
        versionNumber: 3,
        title: "Property Tax Parcels",
        abstract: "Published parcel coverage with reviewed source provenance.",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "MassGIS",
        keywords: ["parcels", "Massachusetts"],
        spatialExtent: [-73.51, 41.24, -69.93, 42.89],
        temporalStart: null,
        temporalEnd: null,
        createdAt: "2026-08-29T12:00:00Z",
        community: {
          organizationId: state.organization.id,
          organizationSlug: "opengeo-tools",
          organizationName: "OpenGeo.tools",
          projectId,
          projectName: state.projects[0].name
        },
        preview: {kind: "dataset", href: `${apiHref}/spatial-preview`},
        freshness: {
          catalogUpdatedAt: "2026-09-01T14:00:00Z",
          sourceObservedAt: "2026-08-29T12:00:00Z",
          sourceVersion: "2026-08-29"
        },
        provenance: {namespace: "massgis", identifier: "property-tax-parcels"},
        relationships: {publicCount: 2, detailHref: apiHref},
        ratings: {count: 4, average: 4.5}
      };
    };
    state.adapter.getPublicSpatialPreview = async (
      organizationId,
      requestedProjectId,
      requestedResourceId
    ) => {
      calls.push({
        kind: "preview",
        organizationId,
        projectId: requestedProjectId,
        resourceId: requestedResourceId
      });
      return {
        schemaVersion: "opengeo.public-spatial-preview.1.0.0",
        resourceId,
        resourceVersionNumber: 3,
        numberReturned: 2,
        numberMatched: 5_109,
        mayBeTruncated: true,
        geojson: {
          type: "FeatureCollection",
          bbox: [-73.51, 41.24, -69.93, 42.89],
          features: [
            {
              type: "Feature",
              id: "parcel-1",
              geometry: {
                type: "Polygon",
                coordinates: [[
                  [-73.1, 41.5], [-72.7, 41.5], [-72.7, 41.9],
                  [-73.1, 41.9], [-73.1, 41.5]
                ]]
              },
              properties: {municipality: "Example"}
            },
            {
              type: "Feature",
              id: "parcel-2",
              geometry: {type: "Point", coordinates: [-71.1, 42.3]},
              properties: {}
            }
          ]
        }
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {
      view: "data",
      publicResourceTarget: {projectId, resourceId}
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [
      {kind: "record", organizationId: state.organization.id, projectId, resourceId},
      {kind: "preview", organizationId: state.organization.id, projectId, resourceId}
    ]);
    const detail = root.querySelector(".platform-public-resource-detail");
    assert.match(
      detail?.textContent ?? "",
      /Property Tax Parcels.*Published parcel coverage.*MassGIS Property Tax Parcels.*CC-BY-4\.0.*MassGIS.*2026-08-29.*2.*4\.5 of 5 from 4 ratings.*parcels.*Massachusetts/s
    );
    assert.equal(
      detail?.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
      "Public feature preview showing 2 of 2 returned features"
    );
    assert.match(
      detail?.querySelector("figcaption")?.textContent ?? "",
      /Rendered 2 of 2 returned features from 5,109 source features.*bounded sample.*saved map styles are not applied/
    );
    assert.ok(detail?.querySelector(".platform-public-resource-feature-polygons"));
    assert.ok(detail?.querySelector(".platform-public-resource-feature-points"));
    assert.equal(
      [...detail.querySelectorAll("a")]
        .find(({textContent}) => textContent === "Back to data catalog")?.getAttribute("href"),
      "/workspaces?view=data"
    );
    assert.equal(
      [...detail.querySelectorAll("a")]
        .find(({textContent}) => textContent === "Open metadata JSON")?.getAttribute("href"),
      `/api${apiHref}`
    );
    assert.equal(
      [...detail.querySelectorAll("a")]
        .find(({textContent}) => textContent === "Open preview GeoJSON")?.getAttribute("href"),
      `/api${apiHref}/spatial-preview`
    );
    assert.equal(root.querySelector('[aria-label="Catalog audience"]')?.value, "published");
    assert.equal(root.querySelector('[aria-label="Catalog audience"]')?.disabled, false);
    assert.doesNotMatch(detail?.textContent ?? "", /bucket|object key|owner user/i);
  });

  it("renders a published map as an ordered multi-layer composition", async () => {
    const state = directoryState();
    const projectId = state.projects[0].id;
    const resourceId = "90000000-0000-4000-8000-000000000068";
    const apiHref = `/public/organizations/${state.organization.id}/projects/${projectId}/resources/${resourceId}`;
    const calls = [];
    state.adapter.baseUrl = "/api";
    state.adapter.getPublicResource = async () => ({
      id: resourceId,
      kind: "map",
      slug: "review-map",
      versionNumber: 8,
      title: "Reviewed road and watershed map",
      abstract: "Two exact-version layers in saved draw order.",
      language: "en",
      license: "CC-BY-4.0",
      attribution: "Public Lab",
      keywords: ["roads", "watersheds"],
      spatialExtent: [-73, 40, -69, 44],
      temporalStart: null,
      temporalEnd: null,
      createdAt: "2026-08-29T12:00:00Z",
      community: {
        organizationId: state.organization.id,
        organizationSlug: "opengeo-tools",
        organizationName: "OpenGeo.tools",
        projectId,
        projectName: state.projects[0].name
      },
      preview: {kind: "map", href: `${apiHref}/map-preview`},
      freshness: {
        catalogUpdatedAt: "2026-09-01T14:00:00Z",
        sourceObservedAt: null,
        sourceVersion: null
      },
      provenance: {namespace: null, identifier: null},
      relationships: {publicCount: 2, detailHref: apiHref},
      ratings: {count: 0, average: null}
    });
    state.adapter.getPublicMapPreview = async (
      organizationId,
      requestedProjectId,
      requestedResourceId
    ) => {
      calls.push({organizationId, projectId: requestedProjectId, resourceId: requestedResourceId});
      return {
        schemaVersion: "opengeo.public-map-preview.1.0.0",
        resourceId,
        resourceVersionNumber: 8,
        mapVersion: 4,
        projection: "mercator",
        colorMode: "dark",
        layers: [
          {
            layerId: "roads",
            title: "Roads",
            visible: true,
            opacity: 0.8,
            order: 0,
            style: {stroke: "#155e63", strokeWidth: 2},
            labels: {enabled: false, field: null},
            numberReturned: 1,
            numberMatched: 4,
            mayBeTruncated: true,
            geojson: {
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                id: "road-1",
                geometry: {type: "LineString", coordinates: [[-72, 41], [-70, 43]]},
                properties: {}
              }]
            }
          },
          {
            layerId: "watersheds",
            title: "Watersheds",
            visible: false,
            opacity: 1,
            order: 1,
            style: {fill: "#2563eb"},
            labels: {enabled: true, field: "name"},
            numberReturned: 1,
            numberMatched: 1,
            mayBeTruncated: false,
            geojson: {
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                id: "watershed-1",
                geometry: {type: "Polygon", coordinates: [[
                  [-72, 41], [-71, 41], [-71, 42], [-72, 41]
                ]]},
                properties: {}
              }]
            }
          }
        ]
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {
      view: "data",
      publicResourceTarget: {projectId, resourceId}
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{
      organizationId: state.organization.id,
      projectId,
      resourceId
    }]);
    const preview = root.querySelector('.platform-public-resource-preview[data-preview-kind="map"]');
    assert.equal(
      preview?.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
      "Published map composition with 1 visible layer"
    );
    assert.equal(preview?.querySelectorAll("svg g").length, 1);
    assert.equal(
      preview?.querySelector('svg g[data-layer-id="roads"] path')?.getAttribute("stroke"),
      "#155e63"
    );
    assert.deepEqual(
      [...preview.querySelectorAll(".platform-public-map-legend li")].map((item) => item.textContent),
      ["Roads1 shown", "Watershedshidden"]
    );
    assert.equal(
      preview?.querySelector('.platform-public-map-legend li[data-visible="false"] span:nth-child(2)')?.textContent,
      "Watersheds"
    );
    assert.match(preview?.querySelector("figcaption")?.textContent ?? "", /map v4.*2 exact-version layers.*1 visible.*2 preview features.*saved draw order/);
    assert.equal(
      [...root.querySelectorAll("a")]
        .find(({textContent}) => textContent === "Open map composition JSON")?.getAttribute("href"),
      `/api${apiHref}/map-preview`
    );
    assert.doesNotMatch(root.querySelector(".platform-catalog-search").textContent, /dataset id|object key|bucket|connection/i);
  });

  it("presents a published PDF dataset with visual pages and semantic text", async () => {
    const state = directoryState();
    const projectId = state.projects[0].id;
    const resourceId = "90000000-0000-4000-8000-000000000068";
    const apiHref = `/public/organizations/${state.organization.id}/projects/${projectId}/resources/${resourceId}`;
    const calls = [];
    state.adapter.baseUrl = "/api";
    state.adapter.getPublicResource = async () => ({
      id: resourceId,
      kind: "dataset",
      slug: "field-report",
      versionNumber: 3,
      title: "Published field report",
      abstract: "Reviewed findings and page presentation.",
      language: "en",
      license: "CC-BY-4.0",
      attribution: "Public Lab",
      keywords: ["report"],
      spatialExtent: null,
      temporalStart: null,
      temporalEnd: null,
      createdAt: "2026-08-29T12:00:00Z",
      community: {
        organizationId: state.organization.id,
        organizationSlug: "opengeo-tools",
        organizationName: "OpenGeo.tools",
        projectId,
        projectName: state.projects[0].name
      },
      preview: {kind: "dataset-document", href: `${apiHref}/dataset-document-preview`},
      freshness: {
        catalogUpdatedAt: "2026-09-01T14:00:00Z",
        sourceObservedAt: null,
        sourceVersion: null
      },
      provenance: {namespace: "field-archive", identifier: "report-7"},
      relationships: {publicCount: 0, detailHref: apiHref},
      ratings: {count: 0, average: null}
    });
    state.adapter.getPublicDatasetDocumentPreview = async (
      organizationId,
      requestedProjectId,
      requestedResourceId
    ) => {
      calls.push({organizationId, projectId: requestedProjectId, resourceId: requestedResourceId});
      return {
        schemaVersion: "opengeo.public-dataset-document-preview.1.0.0",
        resourceId,
        resourceVersionNumber: 3,
        datasetVersionNumber: 6,
        sourceFormat: "pdf",
        presentationKind: "visual",
        presentation: {
          schemaVersion: "opengeo.pdf-visual-presentation.1.0.0",
          sourceFormat: "pdf",
          pdfVersion: "1.7",
          title: "Published field report",
          language: "en",
          extraction: {
            engine: "poppler-pdftotext",
            mode: "layout",
            ocrPerformed: false,
            readingOrder: "heuristic",
            tagged: true,
            textAvailable: true
          },
          rendering: {
            engine: "poppler-pdftoppm",
            mediaType: "image/jpeg",
            annotationsHidden: true,
            colorSpace: "rgb",
            pageCount: 1,
            targetMaximumDimension: 1000,
            totalPixels: 6,
            totalImageBytes: 4
          },
          pages: [{
            number: 1,
            width: 2,
            height: 3,
            imageBase64: "/9j/2Q==",
            imageSha256: "a".repeat(64),
            blocks: [{type: "paragraph", text: "Reviewed findings."}]
          }]
        }
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {
      view: "data",
      publicResourceTarget: {projectId, resourceId}
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{
      organizationId: state.organization.id,
      projectId,
      resourceId
    }]);
    const preview = root.querySelector(
      '.platform-public-resource-preview[data-preview-kind="dataset-document"]'
    );
    assert.equal(
      preview?.querySelector(".platform-public-dataset-document-page")?.getAttribute("src"),
      "data:image/jpeg;base64,/9j/2Q=="
    );
    assert.match(preview?.textContent ?? "", /Published field report.*Page 1.*Reviewed findings/s);
    assert.match(preview?.querySelector("figcaption")?.textContent ?? "", /dataset v6.*bounded.*semantic text/s);
    assert.equal(
      [...root.querySelectorAll("a")]
        .find(({textContent}) => textContent === "Open document presentation JSON")
        ?.getAttribute("href"),
      `/api${apiHref}/dataset-document-preview`
    );
    assert.doesNotMatch(preview?.textContent ?? "", /dataset id|object key|bucket|storage/i);
  });

  it("presents published authored content in an inert frame on the data detail", async () => {
    const state = directoryState();
    const projectId = state.projects[0].id;
    const resourceId = "90000000-0000-4000-8000-000000000068";
    const apiHref = `/public/organizations/${state.organization.id}/projects/${projectId}/resources/${resourceId}`;
    const calls = [];
    const html = '<!doctype html><html><body data-renderer-version="opengeo-page-renderer-1.1.0"><h1>Field account</h1></body></html>';
    state.adapter.getPublicResource = async () => ({
      id: resourceId,
      kind: "story",
      slug: "field-account",
      versionNumber: 7,
      title: "Field account",
      abstract: "Published observations from the road survey.",
      language: "en",
      license: "CC-BY-4.0",
      attribution: "Public Lab",
      keywords: ["roads"],
      spatialExtent: null,
      temporalStart: null,
      temporalEnd: null,
      createdAt: "2026-08-29T12:00:00Z",
      community: {
        organizationId: state.organization.id,
        organizationSlug: "opengeo-tools",
        organizationName: "OpenGeo.tools",
        projectId,
        projectName: state.projects[0].name
      },
      preview: {kind: "document", href: `${apiHref}/document-preview`},
      freshness: {
        catalogUpdatedAt: "2026-09-01T14:00:00Z",
        sourceObservedAt: null,
        sourceVersion: null
      },
      provenance: {namespace: null, identifier: null},
      relationships: {publicCount: 0, detailHref: apiHref},
      ratings: {count: 0, average: null}
    });
    state.adapter.getPublicDocumentPreview = async (organizationId, requestedProjectId, requestedResourceId) => {
      calls.push({organizationId, projectId: requestedProjectId, resourceId: requestedResourceId});
      return {
        schemaVersion: "opengeo.public-document-preview.1.0.0",
        resourceId,
        resourceVersionNumber: 7,
        resourceKind: "story",
        rendererVersion: "opengeo-page-renderer-1.1.0",
        dependencyReferencesOmitted: 2,
        html
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {
      view: "data",
      publicResourceTarget: {projectId, resourceId}
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{
      organizationId: state.organization.id,
      projectId,
      resourceId
    }]);
    const frame = root.querySelector(".platform-public-resource-document-frame");
    assert.equal(frame?.getAttribute("sandbox"), "");
    assert.equal(frame?.referrerPolicy, "no-referrer");
    assert.equal(frame?.getAttribute("srcdoc"), html);
    assert.match(
      root.querySelector(".platform-public-resource-preview figcaption")?.textContent ?? "",
      /published version 7.*2 embedded references are omitted.*sealed publication/
    );
    assert.doesNotMatch(root.textContent, /object key|bucket|resource id/i);
  });

  it("browses a verified repository as bounded folders and object metadata", async () => {
    const state = directoryState();
    const connectionId = "a0000000-0000-4000-8000-000000000051";
    state.userConnections = [{
      id: connectionId,
      displayName: "Geospatial archive",
      bucketName: "example-geodata",
      regionName: "us-east-1",
      objectPrefix: "",
      credentialMode: "workload_identity",
      roleArn: null,
      configuredSecretFields: [],
      credentialRevision: 0,
      targetRevision: 1,
      credentialReady: true,
      status: "verified",
      lastVerifiedAt: "2026-08-30T12:00:00Z",
      sanitizedErrorCode: null,
      ownedByCaller: true,
      verificationAvailable: true,
      repositoryBrowseAvailable: true
    }];
    const calls = [];
    state.adapter.browseMyDatasetConnectionRepository = async (id, request) => {
      calls.push({id, request});
      if (request.prefix === "usa/") {
        return {
          connectionId,
          prefix: "usa/",
          parentPrefix: "",
          entries: [{
            kind: "object",
            relativePath: "usa/catalog.geojson",
            name: "catalog.geojson",
            sizeBytes: 2048,
            lastModified: "2026-08-30T12:00:00Z",
            storageClass: "STANDARD",
            versionId: null
          }],
          truncated: false,
          nextCursor: null
        };
      }
      return {
        connectionId,
        prefix: "",
        parentPrefix: null,
        entries: [{
          kind: "prefix",
          relativePath: "usa/",
          name: "usa",
          sizeBytes: null,
          lastModified: null,
          storageClass: null,
          versionId: null
        }],
        truncated: false,
        nextCursor: null
      };
    };
    state.adapter.inspectMyDatasetConnectionRepositoryObject = async (
      id,
      relativePath,
      versionId = null
    ) => {
      calls.push({id, inspect: relativePath, versionId});
      return {
        connectionId,
        relativePath,
        name: "catalog.geojson",
        sizeBytes: versionId === null ? 2048 : 1024,
        lastModified: versionId === null
          ? "2026-08-30T12:00:00Z"
          : "2026-08-29T12:00:00Z",
        contentType: "application/geo+json",
        etag: versionId === null ? '"etag-value"' : '"etag-older"',
        storageClass: "STANDARD",
        versionId: versionId ?? "version-4",
        checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      };
    };
    state.adapter.listMyDatasetConnectionRepositoryObjectVersions = async (
      id,
      relativePath,
      request
    ) => {
      calls.push({id, versions: relativePath, request});
      return {
        connectionId,
        relativePath,
        entries: [
          {
            versionId: "version-4",
            isLatest: true,
            isDeleteMarker: false,
            lastModified: "2026-08-30T12:00:00Z",
            sizeBytes: 2048,
            etag: '"etag-value"',
            storageClass: "STANDARD"
          },
          {
            versionId: "version-3",
            isLatest: false,
            isDeleteMarker: false,
            lastModified: "2026-08-29T12:00:00Z",
            sizeBytes: 1024,
            etag: '"etag-older"',
            storageClass: "STANDARD"
          },
          {
            versionId: "delete-2",
            isLatest: false,
            isDeleteMarker: true,
            lastModified: "2026-08-28T12:00:00Z",
            sizeBytes: null,
            etag: null,
            storageClass: null
          }
        ],
        truncated: false,
        nextCursor: null
      };
    };
    state.adapter.registerMyDatasetConnectionRepositoryObject = async (id, draft) => {
      calls.push({id, register: draft});
      return {
        datasetId: "80000000-0000-4000-8000-000000000065",
        projectId: draft.projectId,
        name: draft.name,
        classification: draft.classification,
        format: draft.format,
        created: true,
        attached: true,
        source: {
          connectionId: id,
          relativePath: draft.relativePath,
          providerVersionId: draft.versionId
        }
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "sources"});
    const browse = [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Browse repository");
    assert.ok(browse);
    browse.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const browser = root.querySelector(".platform-repository-browser");
    assert.equal(browser.hidden, false);
    assert.equal(browser.querySelector(".platform-repository-location")?.textContent, "/");
    assert.match(browser.textContent, /Folder usa/);
    assert.doesNotMatch(browser.textContent, /geospatial\.data|us-east-1|credential/i);
    browser.querySelector(".platform-repository-folder").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(browser.querySelector(".platform-repository-location")?.textContent, "/usa/");
    assert.match(browser.textContent, /catalog\.geojson.*2\.0 KiB.*STANDARD/s);
    browser.querySelector(".platform-repository-object-name").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const detail = browser.querySelector(".platform-repository-object-detail");
    assert.equal(detail.hidden, false);
    assert.match(detail.textContent, /Current versioned object/);
    assert.match(detail.textContent, /application\/geo\+json/);
    assert.match(detail.textContent, /version-4/);
    assert.match(detail.textContent, /Metadata only/);
    assert.doesNotMatch(detail.textContent, /geospatial\.data|us-east-1|credential/i);
    [...detail.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Version history")
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(detail.textContent, /Version history · catalog\.geojson/);
    assert.match(detail.textContent, /latest/);
    assert.match(detail.textContent, /deletion marker/);
    detail.querySelector('[aria-label="Inspect version version-3"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(detail.textContent, /Exact historical object version/);
    assert.match(detail.textContent, /version-3/);
    assert.match(detail.textContent, /1\.0 KiB/);
    assert.match(detail.textContent, /Use in a project/);
    const registration = detail.querySelector(".platform-repository-registration-form");
    assert.ok(registration);
    assert.equal(registration.querySelector('select')?.value, state.projects[0].id);
    assert.equal(registration.querySelector('input')?.value, "catalog");
    registration.querySelectorAll("input")[1].value = "massgis, source";
    registration.dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(detail.textContent, /Dataset registered/);
    assert.equal(
      detail.querySelector(".platform-repository-registration a")?.getAttribute("href"),
      `/workspaces?project=${state.projects[0].id}&manage=data&dataset=80000000-0000-4000-8000-000000000065#project-data`
    );
    assert.deepEqual(calls, [
      {id: connectionId, request: {prefix: "", cursor: null, limit: 100}},
      {id: connectionId, request: {prefix: "usa/", cursor: null, limit: 100}},
      {id: connectionId, inspect: "usa/catalog.geojson", versionId: null},
      {
        id: connectionId,
        versions: "usa/catalog.geojson",
        request: {cursor: null, limit: 50}
      },
      {id: connectionId, inspect: "usa/catalog.geojson", versionId: "version-3"},
      {
        id: connectionId,
        register: {
          projectId: state.projects[0].id,
          relativePath: "usa/catalog.geojson",
          versionId: "version-3",
          name: "catalog",
          description: null,
          classification: "internal",
          format: "geojson",
          tags: ["massgis", "source"]
        }
      }
    ]);
  });

  it("does not offer immutable registration for the S3 null version", async () => {
    const state = directoryState();
    const connectionId = "a0000000-0000-4000-8000-000000000051";
    state.userConnections = [{
      id: connectionId,
      displayName: "Unversioned archive",
      bucketName: "example-geodata",
      regionName: "us-east-1",
      objectPrefix: "",
      credentialMode: "workload_identity",
      roleArn: null,
      configuredSecretFields: [],
      credentialRevision: 0,
      targetRevision: 1,
      credentialReady: true,
      status: "verified",
      lastVerifiedAt: "2026-08-30T12:00:00Z",
      sanitizedErrorCode: null,
      ownedByCaller: true,
      verificationAvailable: true,
      repositoryBrowseAvailable: true
    }];
    state.adapter.browseMyDatasetConnectionRepository = async () => ({
      connectionId,
      prefix: "",
      parentPrefix: null,
      entries: [{
        kind: "object",
        relativePath: "current.geojson",
        name: "current.geojson",
        sizeBytes: 100,
        lastModified: "2026-08-30T12:00:00Z",
        storageClass: "STANDARD",
        versionId: "null"
      }],
      truncated: false,
      nextCursor: null
    });
    state.adapter.inspectMyDatasetConnectionRepositoryObject = async () => ({
      connectionId,
      relativePath: "current.geojson",
      name: "current.geojson",
      sizeBytes: 100,
      lastModified: "2026-08-30T12:00:00Z",
      contentType: "application/geo+json",
      etag: '"etag"',
      storageClass: "STANDARD",
      versionId: "null",
      checksumSha256: null
    });
    state.adapter.listMyDatasetConnectionRepositoryObjectVersions = async () => ({
      connectionId,
      relativePath: "current.geojson",
      entries: [],
      truncated: false,
      nextCursor: null
    });

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "sources"});
    [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Browse repository")
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    root.querySelector(".platform-repository-object-name").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const detail = root.querySelector(".platform-repository-object-detail");
    assert.match(detail.textContent, /no immutable S3 version identifier/);
    assert.match(detail.textContent, /Preserve or version it before registering/);
    assert.equal(detail.querySelector(".platform-repository-registration-form"), null);
  });

  it("shows revision-aware source health and every visible project reference", async () => {
    const state = directoryState();
    const connectionId = "a0000000-0000-4000-8000-000000000051";
    state.userConnections = [{
      id: connectionId,
      displayName: "Geospatial archive",
      bucketName: "example-geodata",
      regionName: "us-east-1",
      objectPrefix: "",
      credentialMode: "workload_identity",
      roleArn: null,
      configuredSecretFields: [],
      credentialRevision: 0,
      targetRevision: 2,
      credentialReady: true,
      status: "verified",
      lastVerifiedAt: "2026-08-30T12:00:00Z",
      sanitizedErrorCode: null,
      ownedByCaller: true,
      verificationAvailable: false,
      repositoryBrowseAvailable: false
    }];
    state.adapter.getMyDatasetConnectionOverview = async (id) => {
      assert.equal(id, connectionId);
      return {
        connectionId,
        targetRevision: 2,
        credentialRevision: 0,
        health: "healthy",
        latestVerification: {
          id: "b0000000-0000-4000-8000-000000000051",
          connectionId,
          targetRevision: 2,
          credentialRevision: 0,
          state: "succeeded",
          attemptCount: 1,
          bucketAccessConfirmed: true,
          objectAccessConfirmed: true,
          denyCanariesConfirmed: true,
          objectsObserved: 1,
          sanitizedErrorCode: null,
          durationMs: 740,
          requestedBy: "20000000-0000-4000-8000-000000000001",
          createdAt: "2026-08-30T12:00:00Z",
          startedAt: "2026-08-30T12:00:00Z",
          finishedAt: "2026-08-30T12:00:01Z"
        },
        projectReferences: [{
          id: "a1000000-0000-4000-8000-000000000051",
          projectId: state.projects[0].id,
          projectName: state.projects[0].name,
          projectStatus: "active",
          displayName: "MassGIS archive",
          createdAt: "2026-08-30T12:00:00Z"
        }]
      };
    };

    const root = document.createElement("section");
    renderDirectoryState(root, state, () => {}, null, {view: "sources"});
    const record = root.querySelector(".platform-connection-record");
    record.open = true;
    record.dispatchEvent(new harness.dom.window.Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overview = root.querySelector(".platform-connection-verification");
    assert.match(overview.textContent, /Healthy for target 2 and credentials 0/);
    assert.match(overview.textContent, /bucket list · object metadata · denial canaries · 740 ms/);
    assert.match(overview.textContent, /Used by 1 visible project/);
    assert.equal(
      overview.querySelector(".platform-source-projects a")?.getAttribute("href"),
      `/workspaces?project=${state.projects[0].id}&manage=data#project-data`
    );
    assert.doesNotMatch(overview.textContent, /geospatial\.data|role arn|secret/i);
  });

  it("identifies the current managed site and navigates to another site without transferring credentials", () => {
    const root = document.createElement("section");
    const state = directoryState();

    renderDirectoryState(root, state, () => {}, null, {
      view: "access",
      deployment: {
        id: "opengeo-tools",
        name: "OpenGeo.tools",
        origin: "https://studio.opengeo.tools",
        mode: "managed"
      },
      federation: [
        {
          id: "opengeo-tools",
          name: "OpenGeo.tools",
          origin: "https://studio.opengeo.tools",
          description: "Primary site"
        },
        {
          id: "opengeo-demo",
          name: "OpenGeo public demo",
          origin: "https://demo.studio.opengeo.tools",
          description: "Managed demonstration site"
        }
      ]
    });

    assert.match(root.querySelector(".platform-site-switcher > summary")?.textContent ?? "", /OpenGeo\.tools/);
    assert.equal(
      root.querySelector("a.platform-site-switcher-item")?.href,
      "https://demo.studio.opengeo.tools/workspaces"
    );
    assert.match(root.querySelector(".platform-site-switcher-list")?.textContent ?? "", /never transferred/);
    assert.match(root.querySelectorAll(".platform-project-row")[0].textContent, /Published/);
    assert.match(root.querySelectorAll(".platform-project-row")[1].textContent, /Internal/);
  });
});

function directoryState() {
  return {
    status: "ready",
    adapter: {kind: "api"},
    session: {displayName: "Aaron Dennis"},
    organization: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "OpenGeo.tools",
      callerRole: "admin"
    },
    projects: [
      {
        id: "c85a6d5e-0000-4000-8000-000000000001",
        name: "MassGIS Property Tax Parcels",
        projectCode: "MASSGIS-DEMO",
        description: "Reviewed Massachusetts source workspace",
        clientId: null,
        callerRole: "owner",
        visibility: "published",
        status: "active",
        updatedAt: "2026-08-29T12:00:00Z"
      },
      {
        id: "0fa80698-eb22-44ff-9127-8a31bb479c5e",
        name: "3 Band CIR 8 Bit Imagery",
        description: "Private imagery workspace",
        clientId: null,
        callerRole: "owner",
        visibility: "internal",
        status: "active",
        updatedAt: "2026-08-29T11:00:00Z"
      }
    ],
    clients: [],
    clientsRestricted: false,
    teams: [],
    userConnections: [],
    userBasemapConnections: [],
    publicSiteDirectory: {
      schemaVersion: "opengeo.public-site-directory.1.0.0",
      numberReturned: 1,
      numberMatched: 1,
      limit: 100,
      offset: 0,
      nextOffset: null,
      records: [{
        projectId: "c85a6d5e-0000-4000-8000-000000000001",
        projectName: "MassGIS Property Tax Parcels",
        siteId: "b0000000-0000-4000-8000-000000000071",
        editionId: "b4000000-0000-4000-8000-000000000071",
        listedSlug: "massgis-atlas",
        title: "MassGIS public atlas",
        description: "Reviewed Massachusetts publication",
        language: "en",
        theme: "atlas",
        pageCount: 4,
        publishedAt: "2026-09-02T12:00:00Z",
        isPrimary: true,
        href: "/public/organizations/10000000-0000-4000-8000-000000000001/publications/massgis-atlas",
        primaryHref: "/public/organizations/10000000-0000-4000-8000-000000000001/publication"
      }]
    },
    directoryWarnings: []
  };
}

it("keeps a Collection draft across directory links, Back navigation and sign-out", async () => {
  const state = directoryState(); let signOuts = 0;
  const id = "10000000-0000-4000-8000-000000000001";
  harness.dom.window.history.replaceState(null, "", `/workspaces?view=collections&collection=${id}`);
  const adapter = {...state.adapter, kind: "api",
    getSession: async () => ({...state.session, selectedOrganizationId: state.organization.id, memberships: []}),
    selectOrganization() {}, getCurrentOrganization: async () => state.organization,
    listProjects: async () => state.projects, searchLayers: async () => [], listPublicationWorkspaces: async () => [],
    listCollections: async () => [], getCollection: async () => ({id, title: "Saved Collection", description: "", revision: 1, role: "owner", members: []})};
  const root = PlatformDirectory({adapter, view: "collections", auth: {signOut: async () => {signOuts++;}}});
  document.body.append(root);
  try {
    for (let i=0;i<50&&!root.querySelector('[aria-label="Collection title"]');i++) await new Promise(resolve=>setTimeout(resolve,5));
    const title = root.querySelector('[aria-label="Collection title"]'); assert.ok(title);
    title.value = "Unfinished research"; title.dispatchEvent(new harness.dom.window.Event("input"));
    root.querySelector('.studio-navigation a[href="/workspaces?view=data"]').click();
    assert.equal(root.querySelector('[aria-label="Collection title"]').value, "Unfinished research");
    harness.dom.window.history.replaceState(null, "", "/workspaces?view=data");
    harness.dom.window.dispatchEvent(new harness.dom.window.PopStateEvent("popstate"));
    assert.match(harness.dom.window.location.search, /collection=/);
    assert.equal(root.querySelector('[aria-label="Collection title"]').value, "Unfinished research");
    root.querySelector('[data-action="sign-out"]').click();
    assert.equal(signOuts,0);
    assert.match(root.collectionDirectory.querySelector('[role="status"]').textContent,/before signing out/);
  } finally {root.dispose();}
});
