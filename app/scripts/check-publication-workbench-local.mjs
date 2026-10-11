import assert from "node:assert/strict";
import {readFile, readdir, mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve, extname} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {unzipSync, strFromU8} from "fflate";

const dist = resolve(process.env.OPEN_GEO_PUBLICATION_WORKBENCH_DIST ?? fileURLToPath(new URL("../dist/", import.meta.url)));
const root = fileURLToPath(new URL("../..", import.meta.url));
const draftOnly = process.argv.includes('--draft-only');
const exportOnly = process.argv.includes('--export-only');
const accountExportPresentationOnly = process.argv.includes('--account-export-presentation-only');
const accountExportOnly = process.argv.includes('--account-export-only') || accountExportPresentationOnly;
assert(!(accountExportOnly && (exportOnly || draftOnly)), 'Choose one narrow check mode');
const output = "/tmp/opengeo-publication-workbench";
await mkdir(output, {recursive: true});
const module = (await readdir(resolve(dist, "_import/components"))).find(name => (accountExportOnly ? /^PlatformDirectory\./ : /^ProjectSites\./).test(name));
assert(module, "The selected compiled component is missing");
const theme = (await readdir(resolve(dist, "_observablehq"))).find(name => name.endsWith(".css"));
const css = (await readdir(resolve(dist, "_file"))).find(name => /^style\..*\.css$/.test(name));
const policy = async (path, name) => {
  const source = await readFile(resolve(root, path), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const directives = [...source.slice(start).split('].join')[0].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.ok(directives.length, `Empty ${name}`);
  return directives.join('; ');
};
const studioPolicy = await policy('infrastructure/lib/studio-web-stack.ts', 'STUDIO_CONTENT_SECURITY_POLICY');
const draftPolicy = await policy('infrastructure/lib/observable-preview-edge.ts', 'OBSERVABLE_PREVIEW_DRAFT_CSP');
const draftShell = await readFile(resolve(root, 'services/observable-preview/authorize/draft.html'), 'utf8');
const origin = 'https://studio.opengeo.tools';
const draftUrl = 'https://preview.studio.opengeo.tools/authorize/draft.html';
const unexpectedRequests = [];
let draftShellRequests = 0;
const browserStarted = Date.now();
let softwareRequests = 0, softwareBytes = 0, accountCheckTimer;
const browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync), ...(accountExportOnly ? {timeout: 5000} : {})});
if (accountExportOnly) accountCheckTimer = setTimeout(() => {void browser.close().catch(() => {});}, Math.max(1, 25_000 - (Date.now() - browserStarted)));
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}, ...(accountExportOnly ? {serviceWorkers: "block"} : {})});
  if (accountExportOnly) {page.setDefaultTimeout(3500); page.setDefaultNavigationTimeout(5000);}
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET' || request.postData() !== null) {
      unexpectedRequests.push(`${request.method()} ${url.href}`); return route.abort();
    }
    if (url.href === draftUrl) {
      if (accountExportOnly) {unexpectedRequests.push(url.href); return route.abort();}
      draftShellRequests++;
      return route.fulfill({contentType: 'text/html', headers: {'Content-Security-Policy': draftPolicy}, body: draftShell});
    }
    if (url.origin !== origin) {unexpectedRequests.push(url.href); return route.abort();}
    if (url.pathname === '/check') return route.fulfill({contentType: 'text/html', headers: {'Content-Security-Policy': studioPolicy},
      body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/_observablehq/${theme}"><link rel="stylesheet" href="/_file/${css}"><main class="platform-surface" id="workspace"></main>`});
    if (url.pathname === '/favicon.ico') return route.fulfill({status: 204});
    const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(dist + '/') || !/^\/(?:_import|_npm|_node|_file|_observablehq|editor-assets)\//.test(url.pathname)) {
      unexpectedRequests.push(url.href); return route.abort();
    }
    try {
      const bytes = await readFile(file);
      if (accountExportOnly) {
        softwareRequests++; softwareBytes += bytes.byteLength;
        if (softwareRequests > 200 || softwareBytes > 5 * 1024 * 1024) {
          unexpectedRequests.push('Compiled asset budget exceeded'); return route.abort();
        }
      }
      return await route.fulfill({contentType: ({'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png'})[extname(file)] ?? 'application/octet-stream', body: bytes});
    } catch {unexpectedRequests.push(url.href); return route.abort();}
  });
  await page.goto(origin + "/check");
  await page.evaluate(async ({module, exportOnly, accountExportOnly}) => {
    const {ProjectPublishingWorkspace, renderDirectoryState} = await import(`/_import/components/${module}`);
    if (accountExportOnly) {
      const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
      const accountId = id(1), ownerUserId = id(2), projectId = id(3), sourceId = id(4), revisionId = id(5);
      const exactText = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Original\r\n')]);
      const binary = new Uint8Array([0, 255, 13, 10, 128]), bytes = {'index.md': exactText, 'images/map.png': binary};
      const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      const source = {id: sourceId, projectId, siteId: id(6), routeNamespace: 'research', title: 'Research', ownerUserId,
        currentRevisionId: revisionId, currentRevisionNumber: 2, buildPolicy: {networkPolicy: 'deny_all'}};
      const composition = {id: id(12), accessContainerId: projectId, name: 'Saved research map', status: 'active', version: 3,
        ownerUserId, updatedAt: '2026-10-07T12:00:00Z'};
      const definition = {version: 1, layers: [{id: id(14), datasetId: id(15), source: {type: 'geojson', url: 'https://source.example/data.geojson'}}],
        map: {center: [-71, 42], zoom: 8}, providerMetadata: {unknown: ['preserve', {value: 4}]}};
      const savedMapVersion = {version: 3, definitionBytes: new TextEncoder().encode(JSON.stringify(definition)).length,
        createdBy: id(16), createdAt: '2026-10-07T12:00:00Z', changeMessage: 'Saved source references'};
      const revision = {id: revisionId, sourceProjectId: sourceId, revisionNumber: 2, parentRevisionId: id(7),
        title: 'Saved original', rightsStatus: 'unreviewed', entryPath: 'index.md', lockfilePath: null, changeSummary: 'Original source',
        manifestChecksumSha256: 'a'.repeat(64), manifest: {}, dataAttachments: [], createdBy: id(8), createdAt: '2026-10-07T12:00:00Z',
        files: await Promise.all(Object.entries(bytes).map(async ([relativePath, contents]) => ({relativePath,
          contentType: relativePath.endsWith('.png') ? 'image/png' : 'text/markdown', sizeBytes: contents.length,
          checksumSha256: await sha(contents), sourceObjectId: id(9), bucket: 'private-bucket',
          objectKey: `sources/${relativePath}`, s3VersionId: 'immutable-version', etag: 'etag'})))};
      window.calls = []; window.downloadBlobs = []; window.accountExportProbe = {pendingReads: 0, abortedReads: 0, directReads: 0};
      window.accountExportFixture = {account: accountId, delayed: false, savedBaseline: JSON.stringify({source, revision, composition, definition}), definition};
      const urls = new Map(), createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {const url = createObjectURL(blob); urls.set(url, blob); return url;};
      document.addEventListener('click', event => {const anchor = event.target.closest?.('a[download]');
        if (anchor) {event.preventDefault(); window.downloadBlobs.push({name: anchor.download, blob: urls.get(anchor.href)});}}, true);
      const adapter = {kind: 'api', baseUrl: '/api', organizationProvider: () => window.accountExportFixture.account, tokenProvider: () => 'offline-owner-fixture',
        listProjects: async options => {window.calls.push(['projects', options.offset, options.status]); return options.offset ? [] : [{id: projectId, callerRole: 'owner'}];},
        listObservableSourceProjects: async project => {window.calls.push(['sources', project]); return [source, {...source, id: id(10), ownerUserId: id(11), canManage: true}];},
        listObservableSourceRevisions: async (_project, retainedSource) => {window.calls.push(['revisions', retainedSource]); return [revision];},
        listCompositions: async options => {window.calls.push(['compositions', options.status, options.offset]); return options.offset ? []
          : [composition, {id: id(13), name: 'Demo map', ownerUserId: null, createdBy: ownerUserId}];},
        listCompositionVersions: async (mapId, options) => {window.calls.push(['map-versions', mapId, options.limit]);
          assertMap(mapId); return [savedMapVersion];},
        getCompositionVersion: async (mapId, version, {signal}) => {window.calls.push(['map-definition', mapId, version, Boolean(signal)]);
          assertMap(mapId); if (version !== 3) throw Error('Unexpected map version'); return {...savedMapVersion, definition};},
        readObservableSourceRevisionFile: async (_project, retainedSource, retainedRevision, path, {signal}) => {
          window.calls.push(['bytes', retainedSource, retainedRevision, path, Boolean(signal)]);
          if (window.accountExportFixture.delayed) {
            window.accountExportProbe.pendingReads++;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {window.accountExportProbe.abortedReads++;
              reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));}, {once: true}));
          }
          return {blob: new Blob([bytes[path]], {type: revision.files.find(file => file.relativePath === path).contentType})};
        },
        readObservableSourceRevisionFileDirect: async () => {window.accountExportProbe.directReads++; throw Error('Unexpected direct storage');}}
      function assertMap(mapId) {if (mapId !== composition.id) throw Error('A map without confirmed ownership was read');}
      window.accountExportFixture.savedCurrent = () => JSON.stringify({source, revision, composition, definition});
      renderDirectoryState(document.querySelector('#workspace'), {status: 'ready', adapter,
        session: {userId: ownerUserId, displayName: 'Owner'}, organization: {id: accountId, name: 'Personal account', callerRole: 'member'},
        projects: [], clients: [], teams: [], userConnections: [], userBasemapConnections: []}, () => {}, null, {view: 'access'});
      return;
    }
    if (exportOnly) {
      const contents = {'src/index.md': '# Original article\n\nNotes.\n', 'src/data/captured.json': '{"saved":true}\n'};
      const files = await Promise.all(Object.entries(contents).map(async ([relativePath, content]) => ({relativePath,
        contentType: relativePath.endsWith('.md') ? 'text/markdown' : 'application/json',
        sizeBytes: new TextEncoder().encode(content).length,
        checksumSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(value => value.toString(16).padStart(2, '0')).join('')})));
      window.calls = []; window.exportProbe = {pendingReads: 0, abortedReads: 0, directReads: 0}; window.downloadBlobs = [];
      const blobs = new Map(), createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {const url = createObjectURL(blob); blobs.set(url, blob); return url;};
      document.addEventListener('click', event => {const anchor = event.target.closest?.('a[download]');
        if (anchor) {event.preventDefault(); window.downloadBlobs.push({name: anchor.download, blob: blobs.get(anchor.href)});}}, true);
      const state = {organization: {id: 'org', callerRole: 'admin'}, session: {userId: 'owner'}, project: {id: 'project', name: 'Export article'},
        sites: [{id: 'site', title: 'Export article', slug: 'export-article'}],
        observableSourceProjects: [{id: 'source-0', siteId: 'site', title: 'Export article', routeNamespace: 'export-article',
          rightsStatus: 'approved', currentRevisionNumber: 2, currentRevisionId: 'revision',
          buildPolicy: {frameworkVersion: '1.13.4', compilerImageDigest: 'sha256:reviewed', networkPolicy: 'deny'}}],
        adapter: {kind: 'fixture',
          saveObservableSourceRevision: async () => {window.calls.push('save-source'); throw Error('Unexpected save');},
          listObservableSourceRevisions: async () => [{id: 'revision', revisionNumber: 2, title: 'Export article', entryPath: 'src/index.md', lockfilePath: null, dataAttachments: [], files}],
          readObservableSourceRevisionFile: async (_project, _source, _revision, path, {signal} = {}) => {
            window.calls.push(path);
            const file = files.find(file => file.relativePath === path);
            if (path === 'src/index.md') return {blob: new Blob([contents[path]], {type: file.contentType})};
            window.exportProbe.pendingReads++;
            if (!signal) throw Error('The pending export did not provide cancellation');
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
              window.exportProbe.abortedReads++; reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
            }, {once: true}));
          },
          readObservableSourceRevisionFileDirect: async () => {window.exportProbe.directReads++; throw Error('Unexpected direct transport');},
          listObservableBuildJobs: async () => {window.calls.push('builds'); return [];},
          createObservableBuildJob: async () => {window.calls.push('create-build'); throw Error('Unexpected build');},
          createObservablePreviewCapability: async () => {window.calls.push('capability'); throw Error('Unexpected capability');},
          getFrameworkPublications: async () => {window.calls.push('publications'); return {sourceProjectId: 'source-0', dispatchConfigured: true, canPublish: true, mounts: [], reviews: []};}
        }};
      document.querySelector('#workspace').append(ProjectPublishingWorkspace({state, refresh: async () => {}}));
      return;
    }
    const files = [
      {relativePath: "src/index.md", contentType: "text/markdown", content: '# Watershed atlas\n\n```js\nimport {label} from "./components/map.js";\nconst amount = view(Inputs.range([1,10], {label:"Amount", value:3, step:1}));\nconst rows = await FileAttachment("./data/rows.json").json();\n```\n<section><h2>${label}</h2><p id="computed">${amount * rows[0].value}</p></section>\n'},
      {relativePath: "src/components/map.js", contentType: "text/javascript", content: 'export const label = "Reactive watershed dependencies";\n'},
      {relativePath: "src/data/rows.json", contentType: "application/json", content: '[{"value":7}]'},
      {relativePath: "src/notebook.html", contentType: "text/html", content: '<notebook><title>Watershed notebook</title><script id="11" type="module">const n=view(Inputs.range([0,10], {label:"Notebook count", value:2, step:1}));</script><script id="12" type="text/html"><h1>Notebook result ${n + 3}</h1></script><script id="13" type="text/markdown"># Notebook notes</script></notebook>'},
      {relativePath: "package.json", contentType: "application/json", content: "{}"}
    ];
    window.calls = [];
    window.frameworkSource = files[0].content;
    const state = {organization: {callerRole: "admin"}, project: {id: "project", name: "Watershed atlas"},
      sites: [{id: "site", title: "Watershed atlas", slug: "watershed"}, {id: "site-2", title: "Field notes", slug: "notes"}],
      observableSourceProjects: ["site", "site-2"].map((siteId, i) => ({id: `source-${i}`, siteId,
        title: i ? "Field notes" : "Watershed atlas", rightsStatus: "approved", currentRevisionNumber: 2,
        currentRevisionId: "revision", buildPolicy: {frameworkVersion: "1.13.4", compilerImageDigest: "sha256:reviewed", networkPolicy: "deny"}})),
      adapter: {kind: "fixture",
        saveObservableSourceRevision: async (_project, _source, draft) => {window.savedRevision = draft; window.calls.push('save-source');},
        listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 2, title: "Watershed atlas",
          entryPath: "src/index.md", lockfilePath: null, dataAttachments: [], files}],
        readObservableSourceRevisionFile: async (_project, _source, _revision, path) => {
          window.calls.push(path); return {blob: new Blob([files.find(file => file.relativePath === path).content])};
        },
        listObservableBuildJobs: async () => {window.calls.push("builds"); return [];},
        createObservableBuildJob: async () => {window.calls.push('create-build'); throw Error('Unexpected build');},
        createObservablePreviewCapability: async () => {window.calls.push('capability'); throw Error('Unexpected capability');},
        getFrameworkPublications: async (_project, sourceProjectId) => {window.calls.push("publications");
          return {sourceProjectId, dispatchConfigured: true, canPublish: true, mounts: [], reviews: []};}
      }};
    document.querySelector("#workspace").append(ProjectPublishingWorkspace({state, refresh: async () => {}}));
  }, {module, exportOnly, accountExportOnly});
  const activePublication = page.locator('.observable-source-project:visible');
  const editor = activePublication.locator('textarea[aria-label="Framework source editor"]');
  const editSource = async value => {
    await activePublication.locator('.publication-code-editor .monaco-editor').click({position: {x: 120, y: 65}});
    await page.keyboard.press('Control+a'); await page.keyboard.insertText(value);
    await page.waitForFunction(value => document.querySelector('.observable-source-project:not([hidden]) textarea[aria-label="Framework source editor"]').value === value, value);
  };
  const assertNoCompilerWork = async () => assert.deepEqual(await page.evaluate(() => window.calls.filter(call =>
    ['builds', 'create-build', 'capability', 'save-source'].includes(call))), [], 'live drafts and tab changes require no build, capability or save');
  if (accountExportOnly) {
    assert.deepEqual(await page.evaluate(() => window.calls), [], 'opening the compiled directory does not inventory account downloads');
    await page.locator('.platform-account-menu > summary').click();
    await page.getByRole('button', {name: 'Download work…', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Download saved work', exact: true});
    const cancelControl = dialog.locator('button').filter({hasText: /^Cancel$/});
    const completedDownloads = accountExportPresentationOnly ? 0 : 1;
    assert.equal(await cancelControl.evaluate(element => getComputedStyle(element).display), 'none', 'idle Cancel stays hidden in the compiled stylesheet');
    assert.deepEqual(await page.evaluate(() => window.calls), [], 'opening Download work performs no metadata or body reads');
    await dialog.getByText(/Storage requests and charges are not estimated/).waitFor();
    await dialog.getByRole('button', {name: 'Check saved work', exact: true}).click();
    await dialog.getByText(/1 saved publications .* 1 maps .* 2 source file reads/).waitFor();
    await dialog.getByText('Demo map: Ownership information is unavailable; the Project definition is excluded.', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.calls.some(call => ['bytes', 'map-definition'].includes(call[0]))), false, 'estimates read metadata only');
    if (!accountExportPresentationOnly) {
    await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).click();
    await page.waitForFunction(() => window.downloadBlobs.length === 1);
    const zipped = Uint8Array.from(await page.evaluate(async () => [...new Uint8Array(await window.downloadBlobs[0].blob.arrayBuffer())]));
    const outer = unzipSync(zipped), inventory = JSON.parse(strFromU8(outer['opengeo-account-download.json']));
    assert.equal(inventory.complete, false); assert.equal(inventory.exported.length, 2); assert.equal(inventory.costs.kmsRequests, 'unknown');
    assert.equal(inventory.exclusions.unsavedBuffers, true);
    const publication = inventory.exported.find(item => item.kind === 'publication-source');
    const savedProject = inventory.exported.find(item => item.kind === 'project');
    assert(publication && savedProject, 'Both saved publications and confirmed owner maps are included');
    const projectPackage = JSON.parse(strFromU8(outer[savedProject.path]));
    assert.deepEqual(projectPackage.definition, await page.evaluate(() => window.accountExportFixture.definition));
    assert.equal(projectPackage.savedVersion.version, 3);
    const inner = unzipSync(outer[publication.path]);
    assert.deepEqual(inner['source/index.md'], new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Original\r\n')]));
    assert.deepEqual(inner['source/images/map.png'], new Uint8Array([0, 255, 13, 10, 128]));
    const sourceManifest = JSON.parse(strFromU8(inner['opengeo-source-project.json']));
    assert.equal(sourceManifest.metadata.exportedContent, 'saved-source-files');
    assert.equal(sourceManifest.metadata.savedRevisionNumber, 2);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call[0] === 'bytes').length), 2);
    }
    await page.evaluate(() => {window.accountExportFixture.delayed = true;});
    await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).click();
    await page.waitForFunction(() => window.accountExportProbe.pendingReads === 1);
    assert.equal(await cancelControl.isVisible(), true, 'an active held source read exposes Cancel');
    assert.notEqual(await cancelControl.evaluate(element => getComputedStyle(element).display), 'none');
    await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
    await dialog.getByText(/Download cancelled.*no ZIP will be downloaded/).waitFor();
    await page.waitForFunction(() => window.accountExportProbe.abortedReads === 1);
    assert.equal(await cancelControl.evaluate(element => getComputedStyle(element).display), 'none', 'Cancel hides again after abort');
    assert.equal(await page.evaluate(() => window.downloadBlobs.length), completedDownloads, 'cancel issues no additional or partial ZIP');
    const readsBeforeAccountChange = await page.evaluate(() => window.calls.filter(call => call[0] === 'bytes').length);
    await page.evaluate(() => {window.accountExportFixture.account = '10000000-0000-4000-8000-000000000080';});
    await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).click();
    await dialog.getByText('The download account or sign-in changed. Review again. No ZIP was downloaded.', {exact: true}).waitFor();
    assert.equal(await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).isDisabled(), true, 'the stale plan must be reviewed again before download');
    assert.equal(await cancelControl.evaluate(element => getComputedStyle(element).display), 'none');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call[0] === 'bytes').length), readsBeforeAccountChange, 'stale account starts no source transfer');
    assert.equal(await page.evaluate(() => window.downloadBlobs.length), completedDownloads);
    assert.equal(await page.evaluate(() => window.accountExportFixture.savedCurrent() === window.accountExportFixture.savedBaseline), true);
    assert.deepEqual(await page.evaluate(() => window.accountExportProbe), {pendingReads: 1, abortedReads: 1, directReads: 0});
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height: 900});
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, {timeout: 1500});
      assert.equal(await dialog.evaluate(element => {const bounds = element.getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;}), true, 'download dialog fits the viewport');
      await page.screenshot({path: `${output}/account-export${accountExportPresentationOnly ? '-presentation' : ''}-${width}.png`, fullPage: true});
    }
    assert.equal(await page.evaluate(() => window.calls.some(call => ['builds', 'create-build', 'capability', 'save-source'].includes(call[0]))), false);
  } else if (exportOnly) {
    await activePublication.locator('.publication-code-editor .monaco-editor').waitFor({state: 'visible'});
    await activePublication.locator('.source-editor-file-tray > summary').click();
    const downloads = activePublication.locator('.source-editor-downloads');
    await downloads.getByText(/Source ZIP: 2 files .* 1 unloaded file reads/).waitFor();
    await downloads.getByText(/Encrypted storage reads may incur S3\/KMS charges; actual charges are unknown/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.startsWith('src/'))), ['src/index.md'], 'opening the editor reads only its selected saved source');
    const draft = '# Current edited article\n\nUnsaved draft.\n';
    await editSource(draft);
    await downloads.getByRole('button', {name: 'Download source', exact: true}).click();
    await page.waitForFunction(() => window.downloadBlobs.length === 1);
    assert.equal(await page.evaluate(() => window.downloadBlobs[0].blob.text()), draft, 'source download contains current unsaved edits');
    assert.equal(await page.evaluate(() => window.downloadBlobs[0].name), 'index.md');
    await downloads.getByRole('button', {name: 'Download source project', exact: true}).click();
    await page.waitForFunction(() => window.exportProbe.pendingReads === 1);
    await downloads.getByRole('button', {name: 'Cancel download', exact: true}).click();
    await downloads.getByText('Download cancelled. Your working draft is unchanged.', {exact: true}).waitFor();
    await page.waitForFunction(() => window.exportProbe.abortedReads === 1);
    assert.equal(await editor.inputValue(), draft, 'cancel leaves the edited source unchanged');
    assert.deepEqual(await page.evaluate(() => ({probe: window.exportProbe, names: window.downloadBlobs.map(file => file.name), reads: window.calls.filter(call => call.startsWith('src/'))})),
      {probe: {pendingReads: 1, abortedReads: 1, directReads: 0}, names: ['index.md'], reads: ['src/index.md', 'src/data/captured.json']},
      'one compatible saved-file read was aborted, without a ZIP or direct S3 request');
    await assertNoCompilerWork();
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height: 900});
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, {timeout: 3000});
      assert.equal(await downloads.getByRole('button', {name: 'Download source project', exact: true}).isEnabled(), true);
      await page.screenshot({path: `${output}/export-${width}.png`, fullPage: true});
    }
  } else {
  await activePublication.locator('.publication-code-editor .monaco-editor').waitFor({state: 'visible'});
  assert.equal(await activePublication.locator('.publication-map-insert').isVisible(), false);
  assert.equal(await activePublication.getByRole('combobox', {name: 'Preview mode', exact: true}).inputValue(), 'draft');
  const framework = activePublication.frameLocator('iframe[title="Framework draft preview"]').frameLocator('iframe[title="Rendered Framework draft"]');
  await activePublication.locator('iframe[title="Framework draft preview"]').scrollIntoViewIfNeeded();
  await framework.getByRole('heading', {name: 'Reactive watershed dependencies', exact: true}).waitFor();
  await framework.locator('#computed').getByText('21', {exact: true}).waitFor();
  assert.deepEqual([...new Set(await page.evaluate(() => window.calls))].sort(), ['src/index.md', 'src/components/map.js', 'src/data/rows.json'].sort());
  const draft = await page.evaluate(() => window.frameworkSource.replace('# Watershed atlas', '# Unsaved watershed analysis'));
  await editSource(draft);
  await activePublication.getByRole('tab', {name: 'Preview', exact: true}).click();
  await framework.getByRole('heading', {name: 'Unsaved watershed analysis', exact: true}).waitFor();
  await framework.locator('input[type="range"]').fill('5');
  await framework.locator('#computed').getByText('35', {exact: true}).waitFor();
  await framework.locator('html').evaluate(() => {globalThis.workbenchDraftWindow = true;});
  await activePublication.evaluate(card => {
    const frame = card.querySelector('iframe[title="Framework draft preview"]');
    globalThis.retainedFramework = {frame, window: frame.contentWindow, editor: card.querySelector('.publication-code-editor'), source: card.querySelector('textarea[aria-label="Framework source editor"]')};
  });
  const frameworkTabCalls = await page.evaluate(() => [...window.calls]);
  const frameworkTabShells = draftShellRequests;
  await activePublication.getByRole('tab', {name: 'Files', exact: true}).click();
  assert.equal(await editor.inputValue(), draft);
  assert.equal(await activePublication.locator('.publication-map-insert').isVisible(), false, 'Preview does not reopen the map insertion form');
  await activePublication.getByRole('tab', {name: 'Preview', exact: true}).click();
  assert.equal(await activePublication.evaluate(card => {
    const retained = globalThis.retainedFramework;
    return retained.frame === card.querySelector('iframe[title="Framework draft preview"]') && retained.window === retained.frame.contentWindow
      && retained.editor === card.querySelector('.publication-code-editor') && retained.source === card.querySelector('textarea[aria-label="Framework source editor"]');
  }), true, 'Files and Preview retain the same iframe, editor and source buffer');
  assert.equal(await framework.locator('html').evaluate(() => globalThis.workbenchDraftWindow), true, 'Framework preview was not navigated again');
  assert.equal(await framework.locator('input[type="range"]').inputValue(), '5');
  assert.equal(draftShellRequests, frameworkTabShells, 'tab changes do not request another draft shell');
  assert.deepEqual(await page.evaluate(() => window.calls), frameworkTabCalls);
  await assertNoCompilerWork();
  await activePublication.getByRole('tab', {name: 'Files', exact: true}).click();
  await page.getByRole("combobox", {name: "Publication", exact: true}).selectOption("site-2");
  await page.getByRole("combobox", {name: "Publication", exact: true}).selectOption("site");
  assert.equal(await editor.inputValue(), draft, 'publication switching retains the unsaved Framework draft');
  await activePublication.locator('[data-source-path="src/notebook.html"]').click();
  const notebook = activePublication.frameLocator('iframe[title="Observable Notebook live preview"]');
  await activePublication.locator('iframe[title="Observable Notebook live preview"]').scrollIntoViewIfNeeded();
  await notebook.getByRole('heading', {name: 'Notebook result 5', exact: true}).waitFor();
  await notebook.locator('input[type="range"]').fill('4');
  await notebook.getByRole('heading', {name: 'Notebook result 7', exact: true}).waitFor();
  await notebook.locator('html').evaluate(() => {
    globalThis.workbenchNotebookWindow = true; globalThis.retainedNotebookInput = document.querySelector('input[type="range"]');
  });
  await activePublication.evaluate(card => {
    const frame = card.querySelector('iframe[title="Observable Notebook live preview"]');
    globalThis.retainedNotebook = {frame, window: frame.contentWindow, editor: card.querySelector('.publication-code-editor')};
  });
  const notebookTabCalls = await page.evaluate(() => [...window.calls]);
  await activePublication.getByRole('tab', {name: 'Preview', exact: true}).click();
  await activePublication.getByRole('tab', {name: 'Files', exact: true}).click();
  await activePublication.getByRole('tab', {name: 'Preview', exact: true}).click();
  assert.equal(await activePublication.evaluate(card => {
    const retained = globalThis.retainedNotebook;
    return retained.frame === card.querySelector('iframe[title="Observable Notebook live preview"]') && retained.window === retained.frame.contentWindow
      && retained.editor === card.querySelector('.publication-code-editor');
  }), true, 'Notebook Files and Preview retain their iframe, window and editor');
  assert.deepEqual(await page.evaluate(() => window.calls), notebookTabCalls);
  await notebook.getByRole('heading', {name: 'Notebook result 7', exact: true}).waitFor();
  await activePublication.getByRole('tab', {name: 'Files', exact: true}).click();
  const cells = activePublication.locator('.notebook-cell-editor');
  await cells.getByRole('button', {name: 'Cells', exact: true}).click();
  await cells.getByLabel('Notebook cell', {exact: true}).selectOption('12');
  await cells.getByLabel('Cell source', {exact: true}).fill('<h1>Notebook result ${n + 8}</h1>');
  await activePublication.getByRole('tab', {name: 'Preview', exact: true}).click();
  await notebook.getByRole('heading', {name: 'Notebook result 12', exact: true}).waitFor();
  assert.equal(await notebook.locator('input[type="range"]').inputValue(), '4');
  assert.equal(await notebook.locator('html').evaluate(() => globalThis.workbenchNotebookWindow
    && globalThis.retainedNotebookInput === document.querySelector('input[type="range"]')), true, 'editing the output cell retains the unchanged input and runtime');
  assert.equal(await activePublication.locator('iframe[title="Observable Notebook live preview"]').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await activePublication.evaluate(card => {try {card.querySelector('iframe').contentWindow.document; return false;} catch {return true;}}), true);
  await assertNoCompilerWork();
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    for (const name of ['Files', 'Preview']) {
      await activePublication.getByRole('tab', {name, exact: true}).click();
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, {timeout: 3000});
      await page.screenshot({path: `${output}/draft-${name.toLowerCase()}-${width}.png`, fullPage: true});
    }
    await notebook.getByRole('heading', {name: 'Notebook result 12', exact: true}).waitFor();
    assert.equal(await notebook.locator('input[type="range"]').inputValue(), '4');
  }
  await activePublication.getByRole('tab', {name: 'Files', exact: true}).click();
  await activePublication.locator('[data-source-path="src/index.md"]').click();
  assert.equal(await editor.inputValue(), draft, 'the Framework draft survives opening and editing its sibling Notebook');
  await assertNoCompilerWork();
  if (!draftOnly) {
  await page.getByRole("tab", {name: "Publish", exact: true}).click();
  await page.getByRole("tab", {name: "Files", exact: true}).click();
  await page.getByRole('button', {name:'New page in src/components',exact:true}).click();
  assert.equal(await activePublication.getByLabel('New page source path', {exact:true}).inputValue(),'src/components/new-page.md');
  await activePublication.getByLabel('New page title', {exact:true}).fill('Methods');
  await page.getByRole('button',{name:'Add page to working revision',exact:true}).click();
  await activePublication.locator('[data-source-path="src/components/new-page.md"]').waitFor();
  await activePublication.locator('[data-source-path="src/index.md"]').click();
  await page.waitForFunction(value => document.querySelector('textarea[aria-label="Framework source editor"]').value === value, draft);
  assert.equal(await page.evaluate(()=>window.calls.includes('save-source')),false);
  await page.locator('.publication-commands > details > summary').filter({hasText:/^File$/}).click();
  await page.getByRole('button',{name:'New publication…',exact:true}).click();
  await page.getByRole('dialog',{name:'New publication',exact:true}).waitFor();
  for (const format of ['framework','notebook','jupyter']) {
    await page.getByRole('combobox',{name:'Publication format',exact:true}).selectOption(format);
    assert.equal(await page.getByRole('combobox',{name:'Publication format',exact:true}).inputValue(),format);
  }
  await page.getByRole('button',{name:'Close new publication',exact:true}).click();
  assert.equal(await editor.first().inputValue(),draft);
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.getByRole('button',{name:'Insert map…',exact:true}).click();
    const aligned = await activePublication.locator('.publication-checkbox').evaluate(label=>{
      const checkbox=label.querySelector('input').getBoundingClientRect(), caption=label.querySelector('span').getBoundingClientRect();
      return checkbox.width<=20 && caption.left-checkbox.right>=4 && caption.left-checkbox.right<=16 && Math.abs(caption.top-checkbox.top)<=8;
    });
    assert.equal(aligned,true,'map distribution consent stays beside its caption');
    await activePublication.locator('.publication-map-insert > summary').click();
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, {timeout: 3000});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({path: `${output}/files-${width}.png`, fullPage: true});
  }
  await page.evaluate(async ({module}) => {
    const {ProjectPublishingWorkspace} = await import(`/_import/components/${module}`);
    const resource = {id: "page", slug: "home", title: "Field methods", kind: "document", versionNumber: 2};
    const site = {id: "atlas", slug: "atlas", title: "Field atlas", description: "Monitoring methods", language: "en",
      state: "draft", versionNumber: 3, theme: "paper", themeOptions: {}, printLayout: null, activeEdition: null,
      publicationDestination: {revision: 1, reach: "unpublished", listedSlug: "atlas", isPrimary: false},
      pages: [{slug: "home", navigationLabel: "Methods", position: 0, isHome: true,
        resourceId: resource.id, resourceTitle: resource.title, resourceKind: "document", resourceVersionNumber: 2,
        resourceState: "published", resourceVisibility: "public", content: {blocks: [{id: "intro", type: "markdown", markdown: "# Methods"}]}}]};
    const state = {organization: {id: "org", callerRole: "member"}, project: {id: "project", callerRole: "owner"},
      sites: [site], resources: [resource], observableSourceProjects: [], adapter: {
        updateSite: async () => {window.calls.push("save-site");},
        previewPageVersion: async () => {window.calls.push("page-preview"); return {html: "<h1>Field methods</h1>"};},
        configureSitePublicationDestination: async () => {window.calls.push("destination");}
      }};
    document.querySelector("#workspace").replaceChildren(ProjectPublishingWorkspace({state, refresh: async () => {}}));
  }, {module});
  await page.getByLabel("Site title", {exact: true}).fill("Unsaved field atlas");
  await page.getByRole("tab", {name: "Settings", exact: true}).click();
  await page.getByLabel("Accent color", {exact: true}).fill("#123456");
  await page.getByRole("tab", {name: "Preview", exact: true}).click();
  await page.getByRole("button", {name: "Preview saved page", exact: true}).click();
  assert.equal(await page.locator('iframe[title="Saved publication page preview"]').getAttribute("sandbox"), "");
  await page.getByRole("tab", {name: "Publish", exact: true}).click();
  assert.equal(await page.getByRole("button", {name: "Save destination", exact: true}).isVisible(), false);
  await page.getByRole('button',{name:'Configure public addresses…',exact:true}).click();
  assert.equal(await page.getByRole("button", {name: "Save destination", exact: true}).isVisible(), true);
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({path: `${output}/page-publish-${width}.png`, fullPage: true});
  }
  await page.getByRole("tab", {name: "Pages", exact: true}).click();
  assert.equal(await page.getByLabel("Site title", {exact: true}).inputValue(), "Unsaved field atlas");
  await page.getByRole("tab", {name: "Settings", exact: true}).click();
  assert.equal(await page.getByLabel("Accent color", {exact: true}).inputValue(), "#123456");
  assert.equal(await page.evaluate(() => window.calls.some(call => ["save-site", "destination"].includes(call))), false);
  }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, [], 'every request is served from the frozen build or exact local draft shell');
  console.log(JSON.stringify({passed: true, widths: [1280, 390],
    ...(accountExportOnly ? {accountExportOnly, accountExportPresentationOnly, accountSettingsEntry: true, ...(accountExportPresentationOnly
      ? {savedSourceZipProofReused: true, idleCancelHidden: true, activeCancelVisible: true, cancelledControlHidden: true, stalePlanDisabled: true}
      : {savedSourceZip: true, exactBomCrlfBinary: true}), visibleEstimate: true, compatibleReadCancelled: true, noPartialZip: true, staleAccountBlocked: true, unchangedSavedSources: true}
      : exportOnly ? {exportOnly, visibleEstimate: true, currentEditedBytes: true, compatibleReadCancelled: true, noPartialZip: true, unchangedDraft: true}
      : {retainedDraft: true, liveFrameworkDraft: true, reactiveNotebookDraft: true, retainedPreviewWindows: true, notebookInputPreserved: true, draftOnly}),
    draftShellRequests, externalRequests: 0, awsRequests: 0, newBuilds: 0, ...(accountExportOnly ? {softwareRequests, softwareBytes, elapsedMilliseconds: Date.now() - browserStarted} : {}),
    requests: await page.evaluate(() => window.calls), fixtureOnly: true, dist, output}));
} catch (error) {
  console.error(JSON.stringify({browserErrors: errors, unexpectedRequests, draftShellRequests, ...(accountExportOnly ? {accountExportOnly, softwareRequests, softwareBytes, elapsedMilliseconds: Date.now() - browserStarted} : {})}));
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0,10).map(node => [node.className, node.getBoundingClientRect().right])));
    await page.screenshot({path: `${output}/failure.png`, fullPage: true});
  }
  throw error;
} finally {clearTimeout(accountCheckTimer); await browser.close();}
