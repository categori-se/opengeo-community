import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {PublicationWorkspaceDirectory} from "../src/components/PublicationWorkspaceDirectory.js";
import {parsePublicationWorkspace} from "../src/lib/apiClient.js";
const id = "2312ff33-279b-4c62-bc1b-6a81dae57df6";
const payload = {id, kind:"framework",project_id:id,project_name:"NOAA coastal imagery",site_id:id,source_project_id:id,
  title:"NOAA coastal imagery",current_revision:6,hostname:"opengeo.tools",mount_path:"/noaa-coastal-imagery/",
  published_at:"2026-09-11T21:51:28Z",published_revision:6,status:"published",can_manage:true};

it("separates the dedicated publisher tests while retaining their links and ordinary user content", () => {
  const dom = new JSDOM("<!doctype html>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const testId = "62ec8cb7-3e2e-4d36-a20d-89a5f13d52a4";
    const records = [parsePublicationWorkspace({...payload, title:"My test analysis"}),
      parsePublicationWorkspace({...payload, id:testId, site_id:testId, project_id:testId,
        project_name:"Publisher acceptance · Observable Framework", title:"Pages acceptance framework",
        hostname:"pages.studio.opengeo.tools", mount_path:"/p/publisher-check-framework/"})];
    const root = PublicationWorkspaceDirectory({records});
    assert.equal(root.querySelectorAll("tbody tr").length,1);
    assert.match(root.querySelector("tbody").textContent,/My test analysis/);
    assert.match(root.querySelector('[role="status"]').textContent,/1 testing publication hidden/);
    const scope = root.querySelector('[aria-label="Show testing publications"]');
    scope.checked = true; scope.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelectorAll("tbody tr").length,2);
    assert.match(root.querySelector("tbody").textContent,/Testing publication/);
    assert.ok([...root.querySelectorAll('a[target="_blank"]')].some(link=>link.href==="https://pages.studio.opengeo.tools/p/publisher-check-framework/"));
    scope.checked = false; scope.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelectorAll("tbody tr").length,1);
    assert.equal(records[1].status,"published");
  } finally {globalThis.document = previous; dom.window.close();}
});

it("groups destinations by source site, opens the title for editing, and does not infer a root binding", () => {
  const dom = new JSDOM("<!doctype html>", {url:"https://studio.opengeo.tools/workspaces?view=publishing"});
  const original = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const root = PublicationWorkspaceDirectory({records:[parsePublicationWorkspace(payload),
      parsePublicationWorkspace({...payload,mount_path:"/analysis/reading-beyond-visible/",published_revision:5}),
      parsePublicationWorkspace({...payload,kind:"hosted_site",title:"opengeo.tools",project_id:null,site_id:null,source_project_id:null,
        project_name:null,current_revision:0,mount_path:"/",published_at:null,published_revision:null,status:"unmanaged",can_manage:false})]});
    assert.equal(root.querySelectorAll("tbody tr").length,2);
    const titles = [...root.querySelectorAll("tbody td:first-child a")].filter(a => a.textContent === payload.title);
    assert.equal(titles.length,1);
    assert.equal(new URL(titles[0].href).searchParams.get("publication"),id);
    assert.equal(new URL(titles[0].href).searchParams.has("project"),false);
    assert.equal(root.querySelectorAll("thead th").length,3);
    assert.equal(root.querySelectorAll('a[target="_blank"]').length,3);
    assert.match(root.querySelector('[data-status="unmanaged"]').textContent,/No source linked to this destination/);
    assert.equal(root.querySelector('[data-status="unmanaged"] td:first-child a'),null);
    const setup = [...root.querySelectorAll("a")].find(a => a.textContent === "Set up source project");
    assert.equal(new URL(setup.href).searchParams.get("new"), "publication");
    const input = root.querySelector("input"); input.value="/analysis/"; input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelectorAll("tbody tr").length,1);
  } finally {globalThis.document = original; dom.window.close();}
});

it("keeps an imported root draft manageable without claiming it is linked or published", () => {
  const dom = new JSDOM("<!doctype html>", {url:"https://studio.opengeo.tools/workspaces?view=publishing"});
  const original = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const rootProject = "5d7ce4c9-0d58-408a-996b-19e5201e4aa7";
    const root = PublicationWorkspaceDirectory({records:[
      parsePublicationWorkspace(payload),
      parsePublicationWorkspace({...payload,mount_path:"/analysis/reading-beyond-visible/",published_revision:5}),
      parsePublicationWorkspace({...payload,kind:"hosted_site",title:"opengeo.tools",project_id:null,site_id:null,source_project_id:null,
        project_name:null,current_revision:0,mount_path:"/",published_at:null,published_revision:null,status:"unmanaged",can_manage:false}),
      parsePublicationWorkspace({...payload,id:rootProject,site_id:rootProject,project_id:rootProject,title:"OpenGeo.tools · index",project_name:"OpenGeo.tools · index",
        current_revision:1,hostname:null,mount_path:null,published_at:null,published_revision:null,status:"draft"})
    ]});
    assert.match(root.textContent,/3 publications/);
    const draft = root.querySelector('[data-status="draft"]');
    assert.match(draft.textContent,/No destination assigned/);
    assert.match(draft.textContent,/Draft · not published/);
    assert.equal(draft.querySelectorAll('a[target="_blank"]').length,0);
    assert.equal(new URL(draft.querySelector('a').href).searchParams.get('publication'),rootProject);
    assert.equal(root.querySelectorAll('a[target="_blank"]').length,3);
    assert.match(root.querySelector('[data-status="unmanaged"]').textContent,/may already appear as a separate draft/);
    assert.doesNotMatch(root.textContent,/Source not registered/);
  } finally {globalThis.document = original; dom.window.close();}
});

it("loads additional publication pages on demand and retries the same offset after failure", async () => {
  const dom = new JSDOM("<!doctype html>"), original = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const base = parsePublicationWorkspace(payload), calls = [];
    let fail = true;
    const root = PublicationWorkspaceDirectory({records: Array.from({length: 100}, (_, i) => ({...base, id: String(i), siteId: `10000000-0000-4000-8000-${String(i).padStart(12,"0")}`})),
      loadPage: async page => {calls.push(page); if (fail) throw new Error("temporary"); return [{...base, id: "next", siteId: "10000000-0000-4000-8000-999999999999", title: "Root Framework"}];}});
    const button = root.querySelector("button");
    assert.equal(calls.length, 0); assert.equal(button.hidden, false);
    button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelectorAll("tbody tr").length, 100);
    assert.match(root.textContent, /Retry to continue/);
    fail = false; button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{limit: 100, offset: 100}, {limit: 100, offset: 100}]);
    assert.equal(root.querySelectorAll("tbody tr").length, 101); assert.equal(button.hidden, true);
    const search = root.querySelector("input"); search.value = "Root Framework";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelectorAll("tbody tr").length, 1);
  } finally {globalThis.document = original; dom.window.close();}
});

it("rejects unsafe delivery addresses and does not create a public link for draft output", () => {
  for (const hostname of ["evil.test/@opengeo.tools", "user@host.test", "opengeo.tools:443"]) assert.throws(() => parsePublicationWorkspace({...payload,hostname}));
  for (const mount_path of ["//other.test/", "/../", "/?x=1", "/thing#fragment/"]) assert.throws(() => parsePublicationWorkspace({...payload,mount_path}));
  assert.equal(parsePublicationWorkspace({...payload,status:"draft",published_at:null,published_revision:null}).publicUrl,null);
});

it("shows an adopted root once without calling its imported source published", () => {
  const dom = new JSDOM("<!doctype html>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const record = parsePublicationWorkspace({...payload, title: "opengeo.tools", mount_path: "/",
      status: "adopted", published_at: null, published_revision: null});
    const root = PublicationWorkspaceDirectory({records: [record]});
    assert.equal(root.querySelectorAll("tbody tr").length, 1);
    assert.equal(root.querySelector('a[target="_blank"]').href, "https://opengeo.tools/");
    assert.match(root.textContent, /Existing hosted release · source changes not published/);
    assert.doesNotMatch(root.textContent, /Published revision/);
    assert.throws(() => parsePublicationWorkspace({...payload, status: "adopted"}));
  } finally {globalThis.document = previous; dom.window.close();}
});


it("opens a map-and-page draft through its independent Publication identity", () => {
  const dom = new JSDOM("<!doctype html>");
  const original = globalThis.document; globalThis.document = dom.window.document;
  try {
    const record = parsePublicationWorkspace({...payload, kind: "site", source_project_id: null,
      hostname: null, mount_path: null, published_at: null, published_revision: null, status: "draft"});
    const root = PublicationWorkspaceDirectory({records: [record]});
    assert.match(root.textContent, /Maps and pages/);
    assert.match(root.textContent, /Draft/);
    const link = root.querySelector("tbody td:first-child a");
    assert.equal(link.textContent, record.title);
    assert.equal(new URL(link.getAttribute("href"), "https://studio.example").searchParams.get("publication"), id);
    assert.equal(root.querySelector('a[target="_blank"]'), null);
  } finally {globalThis.document = original; dom.window.close();}
});

it("keeps country publications and near-matching user titles visible in a compact local-search table", () => {
  const dom=new JSDOM("<!doctype html>"),previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    const records=[{...parsePublicationWorkspace(payload),id:"10000000-0000-4000-8000-000000000001",siteId:"10000000-0000-4000-8000-000000000001",title:"Bhutan forests"},
      {...parsePublicationWorkspace(payload),id:"10000000-0000-4000-8000-000000000002",siteId:"10000000-0000-4000-8000-000000000002",title:"Nepal wetlands",canManage:false},
      {...parsePublicationWorkspace(payload),id:"10000000-0000-4000-8000-000000000003",siteId:"10000000-0000-4000-8000-000000000003",title:"Publisher acceptance · my test",hostname:"pages.studio.opengeo.tools",mountPath:"/p/my-test/",projectName:"Publisher acceptance · My analysis"}];
    const root=PublicationWorkspaceDirectory({records});
    assert.equal(root.querySelectorAll("tbody tr").length,3);
    assert.equal(root.querySelector("caption").textContent,"Accessible publications");
    assert.equal(root.querySelector('[aria-label="Publications table"]').tabIndex,0);
    assert.ok([...root.querySelectorAll("thead th")].every(heading=>heading.scope==="col"));
    assert.equal(root.querySelector('[aria-label="Publication list"]'),null);
    assert.equal(root.querySelectorAll("tbody .platform-button").length,0);
    const search=root.querySelector('input[type="search"]');search.value="nepal";search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelectorAll("tbody tr").length,1);assert.match(root.querySelector("tbody").textContent,/Nepal wetlands/);
    search.value="missing";search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelectorAll("tbody tr").length,0);assert.equal(root.querySelector('.publication-directory-empty').hidden,false);
    assert.match(root.querySelector('.publication-directory-empty').textContent,/loaded records/);
  } finally {globalThis.document=previous;dom.window.close();}
});

it("recognizes only the exact current production publisher-check endpoints with their acceptance source label", () => {
  const dom=new JSDOM("<!doctype html>"),previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    const base=parsePublicationWorkspace(payload);
    const accepted=["framework","html","jupyter","map","notebook"].map((kind,index)=>({...base,
      id:`10000000-0000-4000-8000-${String(index).padStart(12,"0")}`,siteId:`10000000-0000-4000-8000-${String(index).padStart(12,"0")}`,
      title:`${kind} acceptance`,projectName:`Publisher acceptance · ${kind}`,hostname:"opengeo.tools",mountPath:`/publisher-check/${kind}/`,publicUrl:`https://opengeo.tools/publisher-check/${kind}/`}));
    const normal=[{...base,id:"normal",siteId:"20000000-0000-4000-8000-000000000001",title:"My test publication",projectName:"My research",hostname:"opengeo.tools",mountPath:"/publisher-check/map/"},
      {...base,id:"near",siteId:"20000000-0000-4000-8000-000000000002",title:"Publisher test notes",projectName:"Publisher acceptance · My notes",hostname:"opengeo.tools",mountPath:"/publisher-check/my-map/"}];
    const root=PublicationWorkspaceDirectory({records:[...accepted,...normal]});
    assert.equal(root.querySelectorAll("tbody tr").length,2);assert.match(root.querySelector("tbody").textContent,/My test publication/);
    assert.match(root.querySelector('[role="status"]').textContent,/5 testing publications hidden/);
    const toggle=root.querySelector('[aria-label="Show testing publications"]');toggle.checked=true;toggle.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelectorAll("tbody tr").length,7);
    assert.ok([...root.querySelectorAll('a[target="_blank"]')].some(link=>link.href==="https://opengeo.tools/publisher-check/map/"));
  } finally {globalThis.document=previous;dom.window.close();}
});

it("hides known invented-location drafts, preserves real test-named work, and filters exact project relationships", () => {
  const dom = new JSDOM("<!doctype html>", {url:"https://studio.opengeo.tools/workspaces"});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const dummy="b4e31918-d219-424d-9ac4-d32c7fc2c6b6";
    const records=[parsePublicationWorkspace({...payload,title:"My test analysis"}),
      parsePublicationWorkspace({...payload,id:dummy,site_id:dummy,project_id:dummy,title:"Invented locations",project_name:"Invented locations",hostname:null,mount_path:null,published_revision:null,status:"draft"})];
    const root=PublicationWorkspaceDirectory({records,projectContext:id});
    assert.equal(root.querySelectorAll("tbody tr").length,1);
    assert.match(root.textContent,/My test analysis/);
    const project=root.querySelector("a.publication-source-link[href*=project]");
    assert.equal(new URL(project.href).searchParams.get("project"),id);
    assert.equal(new URL(root.querySelector('a').href).searchParams.has("projectContext"),false);
    const all=PublicationWorkspaceDirectory({records});
    assert.equal(all.querySelectorAll("tbody tr").length,1);
    const toggle=all.querySelector('[aria-label="Show testing publications"]'); toggle.checked=true;toggle.dispatchEvent(new dom.window.Event("change"));
    assert.equal(all.querySelectorAll("tbody tr").length,2);
    assert.equal(records[1].status,"draft");
  } finally {globalThis.document=previous;dom.window.close();}
});
