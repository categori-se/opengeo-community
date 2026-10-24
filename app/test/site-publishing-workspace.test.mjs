import assert from "node:assert/strict";
import {beforeEach, afterEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectPublishingWorkspace} from "../src/components/ProjectSites.js";
import {guardAuthoredMetadata} from "../src/components/AuthoredResourceMetadata.js";
import {SitePagePreview} from "../src/components/SitePagePreview.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

let dom, previous, previousMutationObserver;
beforeEach(() => { previous = globalThis.document; previousMutationObserver = globalThis.MutationObserver; dom = new JSDOM("<!doctype html><body></body>", {url:'https://studio.example.test'}); globalThis.document = dom.window.document; globalThis.MutationObserver = dom.window.MutationObserver; });
afterEach(() => {globalThis.document = previous; if (previousMutationObserver) globalThis.MutationObserver = previousMutationObserver; else delete globalThis.MutationObserver; dom.window.close();});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll("button")].find(node => node.textContent === label);
const field = (root, label) => [...root.querySelectorAll("label")]
  .find(node => node.querySelector(":scope > span")?.textContent === label)?.querySelector("input");

async function draftFixture({source = '# Original', save, supportsFileReuse = false} = {}) {
  const state = fixture();
  const sourceProject = {id: 'source', siteId: 'atlas', title: 'Draft', currentRevisionId: 'saved-1',
    currentRevisionNumber: 1, rightsStatus: 'unreviewed', buildPolicy: {}};
  state.observableSourceProjects = [sourceProject];
  const saves = [];
  const revision = draft => ({id: `saved-${draft.expectedRevision + 1}`, sourceProjectId: 'source',
    revisionNumber: draft.expectedRevision + 1, rightsStatus: draft.rightsStatus,
    files: draft.files.map(file => ({relativePath: file.relativePath, contentType: file.contentType,
      sizeBytes: file.blob.size, sourceObjectId: 'object', checksumSha256: 'a'.repeat(64)}))});
  state.adapter = {tokenProvider: () => 'owner-token', organizationProvider: () => 'org', baseUrl: '/api',
    listObservableSourceRevisions: async () => [{id: 'saved-1', sourceProjectId: 'source', title: 'Draft',
      revisionNumber: 1, rightsStatus: 'unreviewed', entryPath: 'index.md', lockfilePath: null,
      supportsFileReuse, dataAttachments: [], files: [{relativePath: 'index.md', contentType: 'text/markdown', sizeBytes: source.length}]}],
    readObservableSourceRevisionFile: async () => ({blob: new Blob([source], {type: 'text/markdown'})}),
    saveObservableSourceRevision: async (_project, _source, draft, options) => {
      options.assertCurrent(); saves.push(draft);
      assert.equal(options.context.token, 'owner-token');
      return save ? save(draft, revision, options) : revision(draft);
    }};
  const root = ProjectPublishingWorkspace({state, refresh: async () => {throw Error('Autosave must retain the editor');}});
  document.body.append(root); await tick(); await tick();
  return {state, sourceProject, root, saves, editor: root.querySelector('[aria-label="Framework source editor"]')};
}
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };
const editDraft = (editor, value) => {editor.value = value; editor.dispatchEvent(new dom.window.Event('input'));};

it('autosaves private drafts after quiet typing and preserves edits made during a single in-flight save', async t => {
  let finish;
  const {root, editor, saves, sourceProject} = await draftFixture({save: (draft, revision) =>
    saves.length === 1 ? new Promise(resolve => {finish = () => resolve(revision(draft));}) : revision(draft)});
  t.mock.timers.enable({apis: ['setTimeout']});
  editDraft(editor, '# First'); t.mock.timers.tick(7000);
  editDraft(editor, '# Second'); t.mock.timers.tick(7999); await drain();
  assert.equal(saves.length, 0);
  t.mock.timers.tick(1); await drain();
  assert.equal(saves.length, 1);
  assert.equal(await saves[0].files[0].blob.text(), '# Second');
  assert.equal(editor.disabled, false, 'typing stays available while autosave runs');
  editDraft(editor, '# Newer pending edit');
  button(root, 'Save draft').click(); await drain();
  assert.equal(saves.length, 1, 'manual Save cannot overlap autosave');
  finish(); await drain();
  assert.equal(editor.value, '# Newer pending edit');
  assert.equal(sourceProject.currentRevisionNumber, 2);
  assert.match(root.querySelector('.publication-draft-status').textContent, /Unsaved changes/);
  t.mock.timers.tick(8000); await drain();
  assert.equal(saves.length, 2);
  assert.equal(saves[1].expectedRevision, 2);
  assert.equal(await saves[1].files[0].blob.text(), '# Newer pending edit');
  assert.match(root.querySelector('.publication-draft-status').textContent, /Draft saved · version 3/);
  assert.equal(root.querySelector('iframe[title="Saved publication preview"]')?.getAttribute('src') ?? null, null,
    'draft saves do not render or build a published preview');
  assert.match(root.textContent, /public version stays unchanged|Draft saved\. Review Preview, then Publish/);
});

it('pauses failed or stale autosave without discarding the draft or retrying on later edits', async t => {
  const {state, root, editor, saves} = await draftFixture({save: async () => {throw Error('Version conflict');}});
  t.mock.timers.enable({apis: ['setTimeout']});
  editDraft(editor, '# Retained'); t.mock.timers.tick(8000); await drain();
  assert.equal(saves.length, 1);
  assert.match(root.querySelector('.publication-draft-status').textContent, /Autosave paused/);
  editDraft(editor, '# Still retained'); t.mock.timers.tick(32000); await drain();
  assert.equal(saves.length, 1);
  assert.equal(editor.value, '# Still retained');
  state.project.callerRole = 'reader';
  button(root, 'Save draft').click(); await drain();
  assert.equal(saves.length, 1, 'withdrawn edit authority cannot write');
});

it('keeps large drafts in the editor until explicit Save when unchanged-file reuse is unavailable', async t => {
  const {root, editor, saves} = await draftFixture({source: '# ' + 'a'.repeat(128 * 1024)});
  t.mock.timers.enable({apis: ['setTimeout']});
  editDraft(editor, editor.value + '\nChange'); t.mock.timers.tick(8000); await drain();
  assert.equal(saves.length, 0);
  assert.match(root.textContent, /Autosave is limited to 128 KiB/);
  assert.match(root.querySelector('.publication-draft-status').textContent, /Save draft required/);
  t.mock.timers.tick(32000); await drain();
  assert.equal(saves.length, 0);
});

it("opens the saved file tree automatically and reads only selected files", async () => {
  const calls = [];
  const saved = [];
  const files = [{relativePath: "src/index.md", contentType: "text/markdown", sizeBytes: 7},
    {relativePath: "src/methods.md", contentType: "text/markdown", sizeBytes: 9},
    {relativePath: "src/untouched.md", contentType: "text/markdown", sizeBytes: 9}];
  const state = {project: {id: "project", callerRole: "owner"}, organization: {callerRole: "member"},
    sites: [{id: "site", title: "NOAA", slug: "noaa"}],
    observableSourceProjects: [{id: "source", siteId: "site", title: "NOAA", currentRevisionId: "revision",
      currentRevisionNumber: 6, rightsStatus: "approved", buildPolicy: {}}],
    adapter: {saveObservableSourceRevision: async (_p, _s, draft) => saved.push(draft),
      listObservableSourceRevisions: async () => [{id: "revision", title: "NOAA", revisionNumber: 6,
      entryPath: "src/index.md", lockfilePath: null, dataAttachments: [], files}],
      readObservableSourceRevisionFile: async (_p, _s, _r, path) => {
        calls.push(path); return {blob: new Blob([path === "src/index.md" ? "# Index" : "# Methods"], {type: "text/markdown"})};
      }}};
  const root = ProjectPublishingWorkspace({state, refresh: async () => {}});
  document.body.append(root); await tick(); await tick();
  assert.equal(root.querySelectorAll('[data-source-path]').length, 3);
  assert.deepEqual(calls, ["src/index.md"]);
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, "# Index");
  root.querySelector('[data-source-path="src/methods.md"]').click(); await tick();
  assert.deepEqual(calls, ["src/index.md", "src/methods.md"]);
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, "# Methods");
  const editor = root.querySelector('[aria-label="Framework source editor"]');
  editor.value = "# Revised methods";
  editor.dispatchEvent(new dom.window.Event("input"));
  button(root, "Save draft").click(); await tick(); await tick();
  assert.equal(saved.length, 1);
  assert.deepEqual(calls, ["src/index.md", "src/methods.md", "src/untouched.md"]);
  assert.ok(saved[0].files.every(file => file.blob instanceof Blob));
  assert.equal(await saved[0].files.find(file => file.relativePath === "src/methods.md").blob.text(), "# Revised methods");
  assert.equal(await saved[0].reuseRevision.files.length, 3);
});

for (const scenario of ['reuse', 'unsupported', 'wrong-parent', 'stale-parent',
  'changed-path', 'changed-type', 'changed-size', 'changed-checksum', 'changed-object']) {
  it(`native source Save keeps deferred companions exact: ${scenario}`, async () => {
    const reads = [], uploaded = [], committed = [];
    const companionId = 'c0000000-0000-4000-8000-000000000001';
    const entryId = 'c0000000-0000-4000-8000-000000000002';
    const sha = async body => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await body.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const bodies = new Map([['index.md', new Blob(['# Original'], {type: 'text/markdown'})],
      ['plot.png', new Blob([new Uint8Array([137, 80, 78, 71])], {type: 'image/png'})]]);
    const files = await Promise.all([...bodies].map(async ([relativePath, blob]) => ({relativePath,
      sourceObjectId: relativePath === 'plot.png' ? companionId : entryId,
      contentType: blob.type, sizeBytes: blob.size, checksumSha256: await sha(blob)})));
    const parent = {id: 'revision', sourceProjectId: scenario === 'wrong-parent' ? 'other-source' : 'source',
      revisionNumber: scenario === 'stale-parent' ? 5 : 6, supportsFileReuse: scenario !== 'unsupported',
      title: 'NOAA', rightsStatus: 'approved', entryPath: 'index.md', lockfilePath: null, dataAttachments: [], files};
    const adapter = new OpenGeoApiClient({tokenProvider: () => 'owner-token'});
    adapter.listObservableSourceRevisions = async () => [parent];
    adapter.readObservableSourceRevisionFile = async (_p, _s, _r, path) => {
      reads.push(path); return {blob: bodies.get(path)};
    };
    adapter.requestObservableSourceFileUpload = async (_p, _s, file) => {
      uploaded.push(file); return {uploadId: entryId,
        expiresAt: new Date(Date.now() + 60000).toISOString(), upload: {}};
    };
    adapter.uploadFile = async () => {};
    adapter.createObservableSourceRevision = async (_p, _s, draft) => {committed.push(draft); return draft;};
    const state = {project: {id: 'project', callerRole: 'owner'}, organization: {callerRole: 'member'},
      sites: [{id: 'site', title: 'NOAA', slug: 'noaa'}], observableSourceProjects: [{id: 'source', siteId: 'site',
        title: 'NOAA', currentRevisionId: 'revision', currentRevisionNumber: 6, rightsStatus: 'approved', buildPolicy: {}}], adapter};
    const root = ProjectPublishingWorkspace({state, refresh: async () => {}});
    document.body.append(root); await drain(); await drain();
    assert.deepEqual(reads, ['index.md']);
    const original = {...files[1]};
    const changes = {'changed-path': ['relativePath', 'other.png'], 'changed-type': ['contentType', 'image/jpeg'],
      'changed-size': ['sizeBytes', 5], 'changed-checksum': ['checksumSha256', 'b'.repeat(64)],
      'changed-object': ['sourceObjectId', entryId]};
    if (changes[scenario]) {
      const [key, value] = changes[scenario]; files[1][key] = value;
    }
    const editor = root.querySelector('[aria-label="Framework source editor"]');
    editor.value = '# Modified'; editor.dispatchEvent(new dom.window.Event('input'));
    button(root, 'Save draft').click();
    for (let turn = 0; turn < 200 && !committed.length; turn++) await tick();
    assert.equal(committed.length, 1, root.querySelector('.publication-draft-status').textContent);
    assert.deepEqual(reads, scenario === 'reuse' ? ['index.md'] : ['index.md', 'plot.png']);
    assert.equal(uploaded[0].relativePath, 'index.md');
    assert.equal(await uploaded[0].blob.text(), '# Modified');
    assert.equal(uploaded[0].checksumSha256, await sha(uploaded[0].blob));
    const saved = committed[0].files.find(file => file.relativePath === 'plot.png');
    assert.deepEqual(saved, scenario === 'reuse'
      ? {relativePath: 'plot.png', sourceObjectId: original.sourceObjectId}
      : scenario === 'unsupported' || scenario === 'wrong-parent' || scenario === 'stale-parent'
        || ['changed-path', 'changed-type', 'changed-size', 'changed-checksum'].includes(scenario)
        ? {relativePath: 'plot.png', uploadId: entryId}
        : {relativePath: 'plot.png', sourceObjectId: entryId});
  });
}
function fixture(adapter = {}) {
  const page = {slug: "home", navigationLabel: "Home", position: 0, isHome: true,
    resourceId: "page", resourceTitle: "Methods", resourceKind: "document", resourceVersionNumber: 2,
    resourceState: "published", resourceVisibility: "public", content: {blocks: [{id: "intro", type: "markdown", markdown: "# Methods"}]}};
  const site = {id: "atlas", slug: "atlas", title: "Atlas", description: "Study", language: "en",
    state: "draft", versionNumber: 3, theme: "paper", themeOptions: {}, printLayout: null,
    pages: [page], activeEdition: null, publicationDestination: {revision: 1, reach: "unpublished", listedSlug: "atlas", isPrimary: false}};
  return {project: {id: "project", callerRole: "owner"}, organization: {id: "org", callerRole: "member"},
    resources: [{id: "page", slug: "home", title: "Methods", kind: "document", versionNumber: 2}],
    sites: [site], observableSourceProjects: [], adapter};
}

it('links a public release into a saved page and keeps the selected Publication after saving', async () => {
  const id='11111111-1111-4111-8111-111111111111';
  const url=`https://api.example.test/public/organizations/${id}/artifact-releases/${id}/view`;
  let saved=null, releaseReads=0, revisionNumber=1, source='# Report';
  const state=fixture({
    listObservableSourceRevisions:async()=>[{id:'revision',title:'Report',revisionNumber,
      entryPath:'index.md',lockfilePath:null,dataAttachments:[],files:[{relativePath:'index.md',contentType:'text/markdown',sizeBytes:source.length}]}],
    readObservableSourceRevisionFile:async()=>({blob:new Blob([source],{type:'text/markdown'})}),
    readPublicationArtifactReferences:async()=>({revision:0,references:[]}),
    listResources:async()=>[{id:'map',title:'Field map'}],
    readArtifactEdition:async()=>({id,current_version_number:null,editions:[{version_number:1}]}),
    listArtifactReleases:async()=>{releaseReads++;return {has_more:false,records:[
      {id,title:'Public map',version_number:1,license:'CC0-1.0',revoked_at:null},
      {id:'withdrawn',title:'Withdrawn',version_number:1,license:'CC0-1.0',revoked_at:'2026-10-01'}]};},
    publicArtifactReleaseUrl:async releaseId=>{assert.equal(releaseId,id);return url;},
    saveObservableSourceRevision:async(_p,_s,draft)=>{
      saved=draft;source=await draft.files[0].blob.text();revisionNumber++;
      state.observableSourceProjects[0].currentRevisionNumber=revisionNumber;
    }
  });
  state.sites.push({...state.sites[0],id:'report',title:'Report'});
  state.observableSourceProjects=[{id:'source',siteId:'report',title:'Report',currentRevisionId:'revision',
    currentRevisionNumber:1,rightsStatus:'approved',buildPolicy:{}}];
  let root;
  const refresh=async()=>{root?.remove();root=ProjectPublishingWorkspace({state,refresh});document.body.append(root);};
  await refresh();
  const choice=root.querySelector('[aria-label="Publication"]');choice.value='report';choice.dispatchEvent(new dom.window.Event('change'));
  await tick();await tick();
  let card=root.querySelector('.observable-source-project');
  button(card,'Settings').click();
  assert.equal(releaseReads,0,'opening settings does not fetch public maps');
  for(const label of ['Load map resources','Load retained editions','Load public releases']) {button(card,label).click();await tick();}
  assert.equal(card.querySelector('[aria-label="Public Artifact release"]').options.length,1);
  button(card,'Insert public release into page').click();await tick();
  assert.equal(card.querySelector('[role="tab"][aria-selected="true"]').textContent,'Files');
  assert.ok(card.querySelector('[aria-label="Framework source editor"]').value.includes(url));
  assert.equal(saved,null,'insertion changes only the draft');
  button(card,'Save draft').click();await tick();await tick();
  assert.equal(saved.files.length,1,'a public link does not copy the map into the source tree');
  assert.equal(root.querySelector('[aria-label="Publication"]').value,'report');
  card=root.querySelector('.observable-source-project');
  assert.ok(card.querySelector('[aria-label="Framework source editor"]').value.includes(url));
  assert.equal(releaseReads,1,'saving and reopening do not poll release history');
});

for (const [entry,initial] of [['index.md','# Atlas'],['index.html','<!doctype html><notebook><title>Atlas</title><script id="7" type="text/markdown"># Atlas</script></notebook>']])
it(`inserts an exported Studio map into ${entry} only after distribution consent`, async () => {
  const saved = [];
  const state = fixture({saveObservableSourceRevision: async (_p, _s, draft) => saved.push(draft)});
  state.observableSourceProjects = [{id: "source", siteId: "atlas", title: "Atlas", currentRevisionId: null,
    currentRevisionNumber: 0, rightsStatus: "approved", buildPolicy: {}}];
  const root = ProjectPublishingWorkspace({state, refresh: async () => {}}); document.body.append(root);
  const input = [...root.querySelectorAll('input[type="file"]')].find(node => !node.accept && !node.hasAttribute('webkitdirectory'));
  Object.defineProperty(input, 'files', {value: [new File([initial], entry, {type: entry.endsWith('.md') ? 'text/markdown' : 'text/html'})]});
  input.dispatchEvent(new dom.window.Event('change')); await tick();
  const mapInput = root.querySelector('[aria-label="Studio map HTML export"]');
  Object.defineProperty(mapInput, 'files', {value: [new File(['<!doctype html><h1>Map</h1>'], 'survey.html', {type: 'text/html'})]});
  mapInput.dispatchEvent(new dom.window.Event('change'));
  const insert = button(root, 'Insert exported map'); assert.equal(insert.disabled, true);
  const consent = [...root.querySelectorAll('label')].find(label => label.textContent.includes('I may publish the data')).querySelector('input');
  consent.checked = true; consent.dispatchEvent(new dom.window.Event('change')); insert.click();
  assert.ok(root.querySelector('[data-source-path="maps/survey.html"]'));
  assert.match(root.querySelector('textarea').value, /FileAttachment\("\.\/maps\/survey.html"\)/);
  if (entry.endsWith('.html')) {
    const parsed = new dom.window.DOMParser().parseFromString(root.querySelector('textarea').value,'text/html');
    assert.equal(parsed.querySelector('script[id="7"]').textContent,'# Atlas');
    assert.match(parsed.querySelector('script[id="8"]').textContent,/import \{html as mapView\} from "htl"/);
  }
  assert.equal(saved.length, 0);
  button(root, 'Save draft').click(); await tick(); await tick();
  assert.equal(saved.length, 1);
  assert.equal(await saved[0].files.find(file => file.relativePath === 'maps/survey.html').blob.text(), '<!doctype html><h1>Map</h1>');
});

it("retains page and settings edits across shared tabs and renders only a requested saved preview", async () => {
  const previews = [], saves = [], destinationWrites = [];
  const state = fixture({updateSite: async (...args) => saves.push(args),
    configureSitePublicationDestination: async (...args) => destinationWrites.push(args), previewPageVersion: async (...args) => {
      previews.push(args); return {html: "<h1>Methods</h1>"};
    }});
  const root = ProjectPublishingWorkspace({state, refresh: async () => {}}); document.body.append(root);
  assert.deepEqual([...root.querySelectorAll('[role="tab"]')].map(n => n.textContent), ["Pages", "Preview", "Publish", "Settings"]);
  const title = field(root, "Site title"); title.value = "Edited atlas";
  button(root, "Settings").click();
  const accent = field(root, "Accent color"); accent.value = "#123456";
  button(root, "Preview").click(); assert.equal(previews.length, 0);
  button(root, "Preview saved page").click(); await tick();
  assert.deepEqual(previews[0], ["project", "page", 2, {title: "Methods", abstract: null, content: state.sites[0].pages[0].content}]);
  assert.equal(root.querySelector("iframe").getAttribute("sandbox"), "");
  assert.equal(root.querySelector("iframe").hidden, false);
  button(root, "Publish").click();
  const destination = root.querySelector(".project-site-destination");
  assert.ok(destination); assert.equal(destination.closest('[role="tabpanel"]').hidden, true);
  button(root, "Configure public addresses…").click();
  assert.equal(root.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Settings');
  assert.equal(destination.closest('[role="tabpanel"]').hidden, false);
  assert.equal(destination.closest('.publication-address-settings').open, true);
  assert.equal(destinationWrites.length, 0, 'opening public-address configuration does not save a destination');
  assert.equal(saves.length, 0);
  button(root, "Pages").click(); assert.equal(title.value, "Edited atlas");
  button(root, "Settings").click(); assert.equal(accent.value, "#123456");
  button(root, "Save draft revision").click(); await tick();
  assert.equal(saves.length, 1); assert.equal(saves[0][2].title, "Edited atlas");
  assert.equal(saves[0][2].themeOptions.accentColor, "#123456");
  assert.equal(saves[0][2].expectedVersion, 3);
});

it("does not offer draft editing to viewers or claim map-only pages have been previewed", () => {
  const state = fixture(); state.project.callerRole = "viewer";
  state.sites[0].pages[0].resourceKind = "map";
  const root = ProjectPublishingWorkspace({state, refresh: async () => {}});
  assert.equal(button(root, "Save draft revision"), undefined);
  button(root, "Preview").click();
  assert.equal(button(root, "Preview saved page").disabled, true);
  assert.match(root.textContent, /contains maps only/);
});

it("ignores a previous page's late preview and clears failed output", async () => {
  let complete;
  const state = fixture({previewPageVersion: async (_p, id) => {
    if (id === "page") return new Promise(resolve => {complete = resolve;});
    throw Object.assign(new Error(), {code: "access_denied"});
  }});
  const site = state.sites[0]; site.pages.push({...site.pages[0], slug: "other", resourceId: "other"});
  const root = SitePagePreview({state, site});
  button(root, "Preview saved page").click();
  const select = root.querySelector("select"); select.value = "other";
  select.dispatchEvent(new dom.window.Event("change"));
  complete({html: "<p>Old response</p>"}); await tick();
  assert.equal(root.querySelector("iframe").hasAttribute("srcdoc"), false);
  button(root, "Preview saved page").click(); await tick();
  assert.match(root.textContent, /access_denied/);
  assert.equal(root.querySelector("iframe").hidden, true);
});


it("retains Artifact reference drafts across Publication switching, navigation and pending saves", async () => {
  let writes = 0, finish;
  const state = fixture({
    readPublicationArtifactReferences: async () => ({revision: 1, references: [{path: 'maps/a.html', artifact_id: 'artifact', mode: 'current', version: null}]}),
    savePublicationArtifactReferences: async (_p, _s, revision, references) => {
      writes++; assert.equal(revision, 1);
      await new Promise(resolve => {finish = resolve;});
      return {revision: 2, references};
    }
  });
  state.sites.push({...state.sites[0], id: 'second', title: 'Second'});
  state.observableSourceProjects = state.sites.map(site => ({id: `source-${site.id}`, siteId: site.id, title: site.title,
    currentRevisionId: null, currentRevisionNumber: 0, rightsStatus: 'approved', buildPolicy: {}}));
  const host = document.createElement('section'); document.body.append(host);
  const guard = guardAuthoredMetadata(host);
  try {
    const root = ProjectPublishingWorkspace({state, refresh: async () => {}}); host.append(root);
    button(root, 'Settings').click();
    const references = root.querySelector('.publication-artifact-references');
    button(references, 'Load saved references').click(); await tick();
    const input = references.querySelector('[aria-label="Artifact asset path"]');
    input.value = 'maps/revised.html'; input.dispatchEvent(new dom.window.Event('input'));
    const choice = root.querySelector('[aria-label="Publication"]');
    choice.value = 'second'; choice.dispatchEvent(new dom.window.Event('change'));
    const link = document.createElement('a'); link.href = '/elsewhere'; document.body.append(link);
    assert.equal(link.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true, cancelable:true})), false);
    assert.equal(choice.value, 'atlas', 'blocked navigation reveals the Publication owning the draft');
    assert.equal(references.closest('[role="tabpanel"]').hidden, false);
    assert.equal(input.value, 'maps/revised.html');
    assert.match(references.textContent, /Save or discard Artifact reference edits/);
    button(references, 'Save Artifact references').click();
    assert.equal(guard.check(), true, 'refresh waits for save');
    assert.match(references.textContent, /Wait for the Artifact reference action/);
    button(references, 'Save Artifact references').click(); assert.equal(writes, 1);
    finish(); await tick();
    assert.equal(guard.check(), false);
    assert.match(references.textContent, /revision 2/);
    assert.equal(references.querySelector('[aria-label="Artifact asset path"]').value, 'maps/revised.html');
  } finally {guard.dispose();}
});


it("exposes workspace-scoped collaboration without loading or granting access on open", async () => {
  let reads = 0; const invitations = [];
  const state = fixture({listProjectMembers: async () => {reads++; return [];},
    createInvitation: async draft => {invitations.push(draft); return {...draft, status: 'pending'};}});
  state.organization.callerRole = "admin";
  const root = ProjectPublishingWorkspace({state, refresh: async () => {}});
  document.body.append(root);
  const access = root.querySelector('.publication-collaborators');
  assert.ok(access); assert.equal(access.open, false);
  assert.equal(access.querySelector('.project-site-collaborators'), null, 'access controls mount only after opening Workspace access');
  assert.equal(reads, 0); assert.equal(invitations.length, 0);
  access.querySelector(':scope > summary').click(); await tick();
  const panel = access.querySelector(".project-site-collaborators");
  assert.ok(panel);
  assert.equal(panel.open, false, 'the invitation disclosure still requires a deliberate open');
  assert.match(panel.textContent, /Workspace collaborators/);
  assert.match(panel.textContent, /not just this Publication/);
  panel.querySelector(":scope > summary").click(); await tick();
  const form = panel.querySelector('form[data-purpose="project-invitation"]');
  assert.ok(form); assert.equal(panel.open, true);
  assert.equal(reads, 0); assert.equal(invitations.length, 0, 'opening both disclosures never invites anyone');
  form.querySelector('[aria-label="Collaborator email"]').value = 'reviewer@local.invalid';
  form.querySelector('[aria-label="Collaborator display name"]').value = 'Local reviewer';
  form.querySelector('[aria-label="Collaborator project role"]').value = 'editor';
  access.querySelector(':scope > summary').click(); await tick();
  access.querySelector(':scope > summary').click(); await tick();
  assert.equal(access.querySelectorAll('.project-site-collaborators').length, 1, 'reopening reuses the mounted access controls');
  assert.equal(form.querySelector('[aria-label="Collaborator email"]').value, 'reviewer@local.invalid');
  assert.equal(reads, 0); assert.equal(invitations.length, 0);
  button(form, 'Create project invitation').click(); await tick();
  assert.equal(invitations.length, 1, 'only submitting the exact invitation form writes');
  assert.deepEqual(invitations[0], {email: 'reviewer@local.invalid', displayName: 'Local reviewer',
    organizationRole: 'member', projectId: 'project', projectRole: 'editor', expiresInDays: 7});
  assert.equal(reads, 0, 'an unopened roster is not fetched after invitation');
  assert.match(panel.textContent, /reviewer@local.invalid was invited as editor\. Access begins only after acceptance\./);
});

it('creates a private notebook from File without configuring an address, building or publishing', async () => {
  const writes = [], state = fixture({
    createResource: async (_project, draft) => {writes.push(['home', draft]); return {id:'home', versionNumber:1};},
    createSite: async (_project, draft) => {writes.push(['site', draft]); return {id:'new-site'};},
    createObservableSourceProject: async () => {writes.push(['source']); return {id:'new-source',currentRevisionNumber:0};},
    saveObservableSourceRevision: async (_project, _source, draft) => {writes.push(['revision', draft]);}
  });
  let refreshes = 0;
  const root = ProjectPublishingWorkspace({state, refresh:async()=>{refreshes++;}}); document.body.append(root);
  assert.equal(root.querySelector('.publication-new-dialog'), null);
  button(root,'New publication…').click();
  const dialog = root.querySelector('.publication-new-dialog'); assert.equal(dialog.open, true);
  const format = dialog.querySelector('[aria-label="Publication format"]');
  for (const name of ['framework','notebook','jupyter']) assert.equal([...format.options].find(option=>option.value===name).disabled, false);
  field(dialog,'Publication title').value = 'Field observations';
  field(dialog,'Publication title').dispatchEvent(new dom.window.Event('input'));
  assert.equal(field(dialog,'Publication identifier').value,'field-observations');
  format.value = 'jupyter';
  button(dialog,'Set up private publication').click(); await tick(); await tick();
  assert.deepEqual(writes.map(([kind])=>kind), ['home','site','source','revision']);
  assert.equal(writes[0][1].visibility,'restricted');
  const revision = writes[3][1]; assert.equal(revision.entryPath,'index.ipynb');
  assert.equal(JSON.parse(await revision.files[0].blob.text()).metadata.language_info.name,'python');
  assert.equal(refreshes,1);
  button(dialog,'Set up private publication').click(); await tick(); assert.equal(writes.length,4,'completed setup is not replayed');
});

it('adds a page in its explorer folder, preserves edits and rejects an occupied path', async () => {
  let saved;
  const records = ['src/index.md','src/methods/existing.md'].map(relativePath=>({relativePath,contentType:'text/markdown',sizeBytes:7}));
  const state = fixture({
    listObservableSourceRevisions:async()=>[{id:'revision',revisionNumber:1,title:'Report',entryPath:'src/index.md',lockfilePath:null,dataAttachments:[],files:records}],
    readObservableSourceRevisionFile:async()=>({blob:new Blob(['# Saved'],{type:'text/markdown'})}),
    saveObservableSourceRevision:async(_p,_s,draft)=>{saved=draft;}
  });
  state.observableSourceProjects=[{id:'source',siteId:'atlas',title:'Report',currentRevisionId:'revision',currentRevisionNumber:1,rightsStatus:'approved',buildPolicy:{}}];
  const root=ProjectPublishingWorkspace({state,refresh:async()=>{}});document.body.append(root);await tick();await tick();
  const textarea=root.querySelector('[aria-label="Framework source editor"]');textarea.value='# Unsaved home';textarea.dispatchEvent(new dom.window.Event('input'));
  root.querySelector('[aria-label="New page in src/methods"]').click();
  const path=field(root,'New page source path');assert.equal(path.value,'src/methods/new-page.md');
  path.value='src/methods/existing.md';button(root,'Add page to working revision').click();await tick();await tick();
  assert.match(root.querySelector('.framework-new-page').textContent,/conflicts with an existing file/);
  assert.equal(root.querySelectorAll('[data-source-path]').length,2);
  path.value='src/methods/new-page.md';button(root,'Add page to working revision').click();await tick();await tick();
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value.includes('New page'),true);
  assert.equal(saved,undefined);
  button(root,'Save draft').click();await tick();await tick();
  assert.equal(saved.files.length,3);
  assert.equal(await saved.files.find(file=>file.relativePath==='src/index.md').blob.text(),'# Unsaved home');
});

it('keeps address configuration in Settings and carries a reserved address into an opened Publish view', async () => {
  let statusReads=0, builds=0, reserves=0;
  const status={sourceProjectId:'source',dispatchConfigured:true,canPublish:true,canConfigureDestinations:true,
    origins:[{id:'origin',urlPrefix:'https://opengeo.tools/publications/'}],mounts:[],reviews:[]};
  const state=fixture({getFrameworkPublications:async()=>{statusReads++;return status;},
    listObservableBuildJobs:async()=>{builds++;return [{id:'build',sourceProjectId:'source',sourceRevisionNumber:1,state:'succeeded',resultChecksumSha256:'a'.repeat(64)}];},
    reserveFrameworkPublicationDestination:async(_p,_s,draft)=>{reserves++;return {...status,mounts:[{id:draft.reservationId,url:`https://opengeo.tools/publications/${draft.slug}/`,enabled:true}]};}
  });
  state.observableSourceProjects=[{id:'source',siteId:'atlas',title:'Report',currentRevisionId:null,currentRevisionNumber:0,buildPolicy:{}}];
  const root=ProjectPublishingWorkspace({state,refresh:async()=>{}});document.body.append(root);
  button(root,'Settings').click();await tick();assert.equal(statusReads,0);assert.equal(builds,0);
  button(root,'Publish').click();await tick();assert.equal(statusReads,1);assert.equal(builds,1);
  assert.equal(root.querySelector('[data-publication-panel="publish"] [aria-label="Address name"]'),null);
  button(root,'Public addresses…').click();await tick();await tick();assert.equal(statusReads,2);assert.equal(builds,1);
  const input=root.querySelector('[aria-label="Address name"]');input.value='field-report';input.dispatchEvent(new dom.window.Event('input'));
  button(root,'Reserve address').click();await tick();await tick();assert.equal(reserves,1);
  button(root,'Publish').click();
  assert.equal(root.querySelector('[aria-label="Publication destination"] option').textContent,'https://opengeo.tools/publications/field-report/');
  assert.equal(statusReads,2,'successful reservation response supplies the existing Publish view');
});
