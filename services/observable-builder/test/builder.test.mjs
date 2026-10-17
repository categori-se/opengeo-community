import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {describe, it, mock} from "node:test";
import {stagePageCache, readPageCacheResult} from "../../observable-coordinator/src/page-cache-transport.mjs";
import {buildNotebookAssets} from '../scripts/notebook-assets.mjs';
import {
  FRAMEWORK_VERSION,
  DATA_INVOCATION_SCHEMA,
  DISTRIBUTION_INVOCATION_SCHEMA,
  DISTRIBUTION_REQUEST_SCHEMA,
  LOCALIZED_INVOCATION_SCHEMA,
  LOCALIZED_REQUEST_SCHEMA,
  LOCALIZED_REPORT_SCHEMA,
  INVOCATION_SCHEMA,
  ObservableBuilderError,
  compilerEnvironment,
  inspectInputs,
  inspectOutputs,
  parseInvocation,
  runBuild
} from "../src/contract.mjs";
import {artifactChecksum} from "../src/artifact-inputs.mjs";
import {readOutputTree} from "../../observable-coordinator/src/podman-runner.mjs";

const COMPILER_DIGEST = `sha256:${"d".repeat(64)}`;
const CHECKSUM = "c".repeat(64);

it('admits packaged dist assets without admitting private or traversal output paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-output-paths-'));
  try {
    const output = join(root, 'dist');
    const asset = join(output, '_npm/leaflet@1.9.4/dist/images/marker-icon.png');
    mkdirSync(dirname(asset), {recursive: true});
    writeFileSync(asset, 'image fixture');
    writeFileSync(join(output, 'index.html'), '<!doctype html><title>Map</title>');
    assert.equal(inspectOutputs(output, limits()).files.length, 2);
    for (const directory of ['node_modules', 'build', 'cache', '.git', '.aws', '.ssh']) {
      const unsafe = join(output, '_npm/leaflet@1.9.4/dist', directory);
      mkdirSync(unsafe);
      writeFileSync(join(unsafe, 'private.txt'), 'private');
      assert.throws(() => inspectOutputs(output, limits()), /output_path_invalid/);
      rmSync(unsafe, {recursive: true});
    }
    writeFileSync(join(dirname(asset), 'credentials.json'), '{}');
    assert.throws(() => inspectOutputs(output, limits()), /output_path_invalid/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function limits(overrides = {}) {
  return {
    cpuMillis: 1000,
    memoryMiB: 1024,
    timeoutSeconds: 60,
    maxInputFiles: 128,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputFiles: 512,
    maxOutputBytes: 32 * 1024 * 1024,
    ...overrides
  };
}

function invocationFor(files, overrides = {}) {
  const mediaType = (path) => {
    if (/\.ipynb$/i.test(path)) return "application/x-ipynb+json";
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".md")) return "text/markdown";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".txt")) return "text/plain";
    if (path.endsWith(".png")) return "image/png";
    return "text/javascript";
  };
  return {
    schemaVersion: INVOCATION_SCHEMA,
    buildJobId: randomUUID(),
    requestChecksumSha256: CHECKSUM,
    inputManifestChecksumSha256: "b".repeat(64),
    entryPath: "index.md",
    lockfilePath: null,
    files: Object.entries(files)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([path, content]) => ({
        path,
        contentType: mediaType(path),
        sizeBytes: Buffer.byteLength(content),
        checksumSha256: sha256(content)
      })),
    request: {
      schemaVersion: "opengeo.observable-build-request.1.0.0",
      sourceProjectId: randomUUID(),
      sourceRevisionId: randomUUID(),
      sourceRevisionNumber: 1,
      sourceManifestChecksumSha256: "b".repeat(64),
      purpose: "preview",
      compilerImageDigest: COMPILER_DIGEST,
      frameworkVersion: FRAMEWORK_VERSION,
      lockfileFormat: "npm-package-lock-v3",
      lockfileChecksumSha256: null,
      networkPolicy: "deny_all",
      resourceLimits: limits()
    },
    ...overrides
  };
}

function fixture(files = {"index.md": "# Exact private preview\n\nNo publication.\n"}) {
  const root = mkdtempSync(join(tmpdir(), "opengeo-observable-builder-"));
  const inputRoot = join(root, "input");
  mkdirSync(inputRoot);
  for (const [path, content] of Object.entries(files)) {
    const target = join(inputRoot, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content);
  }
  return {root, inputRoot, invocation: invocationFor(files)};
}

describe("credential-free Observable builder contract", () => {
  it('retains native compiler failures only through an optional trusted host diagnostic callback', () => {
    const sample = fixture();
    // Deterministic child results avoid host spawnSync pipe/capture restrictions;
    // this checks private failure retention without running a native compiler.
    let result = {status: 17, signal: null, stdout: 'private stdout fixture', stderr: 'private stderr fixture'};
    const spawn = mock.method(childProcess, 'spawnSync', () => result);
    syncBuiltinESMExports();
    try {
      const cacheRoot = join(sample.root, 'empty-cache'); mkdirSync(cacheRoot);
      const fakeCli = join(sample.root, 'failing-cli.mjs');
      const diagnosticPath = join(sample.root, 'private-child-diagnostic.json');
      const run = (name, callback) => runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
        workspaceRoot: join(sample.root, name), observableCliPath: fakeCli, frameworkCacheRoot: cacheRoot,
        ...(callback === undefined ? {} : {onCompilerFailure: callback})});
      const sanitized = error => {
        assert.equal(error.code, 'compiler_failed');
        assert.equal(error.message, 'Observable Framework compilation failed');
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
        return true;
      };
      let calls = 0;
      assert.throws(() => run('retained', diagnostic => {
        calls++;
        assert.ok(Object.isFrozen(diagnostic));
        writeFileSync(diagnosticPath, JSON.stringify(diagnostic), {flag: 'wx', mode: 0o600});
      }), sanitized);
      assert.equal(calls, 1);
      assert.deepEqual(JSON.parse(readFileSync(diagnosticPath)), {code: 'compiler_failed', status: 17,
        signal: null, error: null, stdout: 'private stdout fixture', stderr: 'private stderr fixture'});
      assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600);
      assert.throws(() => run('no-callback'), sanitized);
      assert.throws(() => run('retention-failed', () => {throw Error('private retention failure');}), sanitized);
      result = {status: null, signal: null, stdout: null, stderr: null,
        error: {code: 'EPERM', message: 'private spawn failure fixture'}};
      let spawnFailure;
      assert.throws(() => run('spawn-failed', diagnostic => {spawnFailure = diagnostic;}), sanitized);
      assert.deepEqual(spawnFailure, {code: 'compiler_failed', status: null, signal: null,
        error: {code: 'EPERM', message: 'private spawn failure fixture'}, stdout: '', stderr: ''});
      assert.throws(() => run('invalid-callback', 'request-controlled-path'), /compiler_diagnostic_invalid/);
      const requestControlled = structuredClone(sample.invocation);
      requestControlled.request.onCompilerFailure = diagnosticPath;
      assert.throws(() => parseInvocation(requestControlled), /request_shape_invalid/);
    } finally {spawn.mock.restore(); syncBuiltinESMExports(); rmSync(sample.root, {recursive: true, force: true});}
  });

  it('compiles a declared Observable Notebook with only referenced attachments and no source execution', async () => {
    const source = '<!doctype html><notebook><title>Notebook publication</title><script id="1" type="module">throw new Error("Do not execute on the build host");</script><script id="2" type="module">const rows = await FileAttachment("data/rows.json").json();</script><script id="3" type="text/markdown"># Rows ${rows[0]}</script></notebook>';
    const notice = readFileSync(resolve('../../app/test/fixture/observable-bar-chart-527/LICENSE.txt'), 'utf8');
    const noticePath = `src/original/notices/LICENSE-${'a'.repeat(64)}.txt`;
    const sample = fixture({'src/index.html': source, 'src/opengeo.publication.json': JSON.stringify({schema:'opengeo.publication.1',format:'notebook',entry:'index.html'}),
      'src/data/rows.json': '[42]', 'src/private.txt': 'Private unused source must not be published',
      [noticePath]: notice, 'src/original/notices/private.txt': 'Unrelated notice-folder file must remain private'});
    sample.invocation.entryPath = 'src/index.html';
    try {
      const assets = join(sample.root, 'notebook-assets.json');
      writeFileSync(assets, JSON.stringify(await buildNotebookAssets(resolve('../../app'))));
      const report = runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
        workspaceRoot: join(sample.root, 'workspace'), observableCliPath: resolve('../../app/node_modules/.bin/observable'), notebookAssetsPath: assets});
      assert.deepEqual(report.outputManifest.files.map(file => file.path), ['dist/index.html']);
      assert.equal(report.validationReport.prewarmedFrameworkCache, false);
      assert.equal(report.validationReport.publicationAuthorized, false);
      const html = readFileSync(join(sample.root, 'workspace/dist/index.html'), 'utf8');
      assert.match(html, /<title>Notebook publication<\/title>/);
      assert.match(html, /"bytes":"WzQyXQ=="/);
      assert.doesNotMatch(html, /Private unused source must not be published/);
      assert.doesNotMatch(html, /Unrelated notice-folder file must remain private/);
      assert.match(html, /Licenses and attribution/);
      assert.match(html, /Copyright 2017–2021 Observable, Inc\./);
      assert.match(html, /Permission to use, copy, modify, and\/or distribute/);
      assert.match(html, /above\s+copyright notice and this permission notice appear in all copies/);
      assert.match(html, /&quot;AS IS&quot;/);
      assert.equal(readFileSync(join(sample.inputRoot, noticePath), 'utf8'), notice);
      assert.match(html, /Do not execute on the build host/);
      assert.equal(readFileSync(join(sample.inputRoot, 'src/index.html'), 'utf8'), source);
    } finally {rmSync(sample.root, {recursive: true, force: true});}
  });

  it('refuses unprocessed notebook HTML and invalid publication format records', () => {
    for (const [files, code] of [
      [{'index.html': '<notebook><title>Not static HTML</title></notebook>'}, 'notebook_format_required'],
      [{'index.html': '<h1>HTML</h1>', 'opengeo.publication.json': '{invalid'}, 'publication_format_invalid'],
      [{'index.html': '<h1>HTML</h1>', 'opengeo.publication.json': JSON.stringify({schema:'opengeo.publication.1',format:'jupyter',entry:'index.html'})}, 'publication_format_invalid']
    ]) {
      const sample = fixture(files); sample.invocation.entryPath = 'index.html';
      try {assert.throws(() => runBuild({invocation:sample.invocation,inputRoot:sample.inputRoot,workspaceRoot:join(sample.root,'workspace')}), error => error.code === code);}
      finally {rmSync(sample.root, {recursive: true, force: true});}
    }
  });
  it("renders native Jupyter pages without running code or publishing private source files", () => {
    const notebook = title => JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      {cell_type: 'markdown', metadata: {}, source: `# ${title}\n![Survey plot](images/plot.png)`},
      {cell_type: 'code', metadata: {}, source: 'raise RuntimeError("Must never execute")', execution_count: 1,
        outputs: [{output_type: 'display_data', data: {'text/html': '<table><tr><td>42</td></tr></table><script>evil()</script>'}}]}
    ]});
    const sample = fixture({'notebooks/analysis.ipynb': notebook('Analysis'), 'notebooks/methods.ipynb': notebook('Methods'),
      'notebooks/images/plot.png': 'image bytes', 'notebooks/images/private.png':'private image', 'notebooks/private.txt': 'not a public file'});
    sample.invocation.entryPath = 'notebooks/analysis.ipynb';
    try {
      const report = runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
        workspaceRoot: join(sample.root, 'workspace'), observableCliPath: resolve('../../app/node_modules/.bin/observable'),
        frameworkCacheRoot: '/missing/cache', incrementalPageCache: {}});
      assert.equal(report.validationReport.prewarmedFrameworkCache, false);
      assert.equal(report.validationReport.publicationAuthorized, false);
      assert.deepEqual(report.outputManifest.files.map(file => file.path), ['dist/index.html', 'dist/methods.html']);
      const html = readFileSync(join(sample.root, 'workspace/dist/index.html'), 'utf8');
      assert.match(html, /<h1>Analysis<\/h1>/);
      assert.match(html, /<td>42<\/td>/);
      assert.match(html, /src="data:image\/png;base64,aW1hZ2UgYnl0ZXM="/);
      assert.doesNotMatch(html, /cHJpdmF0ZSBpbWFnZQ==/);
      assert.doesNotMatch(html, /<script>|evil\(\)/);
      assert.equal(readFileSync(join(sample.inputRoot, 'notebooks/analysis.ipynb'), 'utf8'), notebook('Analysis'));
    } finally {rmSync(sample.root, {recursive: true, force: true});}
  });

  it("rejects Jupyter route collisions, mismatched media and malformed native notebooks", () => {
    const valid = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: []});
    for (const [files, expected] of [
      [{'analysis.ipynb': valid, 'index.ipynb': valid}, /jupyter_route_collision/],
      [{'analysis.ipynb': JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{},cells:[
        {cell_type:'markdown',metadata:{},source:'![Missing figure](missing.png)'}]})}, /Jupyter saved-output rendering failed/],
      [{'analysis.ipynb': '{invalid'}, /Jupyter saved-output rendering failed/]
    ]) {
      const sample = fixture(files); sample.invocation.entryPath = 'analysis.ipynb';
      try {
        assert.throws(() => runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
          workspaceRoot: join(sample.root, 'workspace'), observableCliPath: resolve('../../app/node_modules/.bin/observable')}), expected);
        sample.invocation.files[0].contentType = 'text/html';
        assert.throws(() => parseInvocation(sample.invocation), /input_manifest_invalid/);
      } finally {rmSync(sample.root, {recursive: true, force: true});}
    }
  });
  it("hands a host-staged cache through the actual builder CLI without publishing its sidecars", async () => {
    const sample = fixture({"index.md": "# CLI preview\n\nAn unchanged article.\n"});
    async function build(name, cache) {
      const contract = join(sample.root, name);
      mkdirSync(contract);
      await stagePageCache(contract, cache);
      const invocationPath = join(contract, "invocation.json");
      writeFileSync(invocationPath, JSON.stringify(sample.invocation));
      const workspace = join(sample.root, `${name}-workspace`);
      const reportPath = join(sample.root, `${name}-report.json`);
      const result = spawnSync(process.execPath, [resolve("src/cli.mjs"),
        "--contract", invocationPath, "--input", sample.inputRoot, "--workspace", workspace,
        "--report", reportPath, "--observable-cli", resolve("../../app/node_modules/.bin/observable"),
        "--framework-cache", resolve("../../app/src/.observablehq/cache"),
        "--page-cache", join(contract, "page-cache")
      ], {encoding: "utf8", timeout: 60_000, env: compilerEnvironment()});
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(reportPath));
      assert(report.outputManifest.files.every(file => !file.path.includes("page-cache")));
      return {report, cache: await readPageCacheResult(workspace)};
    }
    try {
      const first = await build("first", {});
      assert.equal(first.cache.stats.rendered, 1);
      const second = await build("second", first.cache);
      assert.equal(second.cache.stats.restored, true);
      assert.equal(second.cache.stats.reused, 1);
      assert.equal(second.cache.stats.rendered, 0);
      assert.equal(first.report.outputTreeChecksumSha256, second.report.outputTreeChecksumSha256);
    } finally {
      rmSync(sample.root, {recursive: true, force: true});
    }
  });
  it("reuses pages across fresh isolated compiler processes and invalidates edited consumers", () => {
    const files = {'index.md':'# Analysis\n\n```js\nconst rows = await FileAttachment("./rows.json").json();\n```\n${rows[0]}\n',
      'other.md':'# Other\n\nAn independent page.\n','rows.json':'[3]\n'};
    const projectId=randomUUID();
    const samples=[];
    function build(source, cache, project=projectId) {
      const sample=fixture(source);samples.push(sample);
      sample.invocation.request.sourceProjectId=project;
      const workspaceRoot=join(sample.root,'workspace');
      const report=runBuild({invocation:sample.invocation,inputRoot:sample.inputRoot,workspaceRoot,
        observableCliPath:resolve('../../app/node_modules/.bin/observable'),
        frameworkCacheRoot:resolve('../../app/src/.observablehq/cache'),
        ...(cache === null ? {} : {incrementalPageCache:cache})});
      if(cache===null)return {report};
      const stats=JSON.parse(readFileSync(join(workspaceRoot,'.opengeo-page-cache-result.json')));
      return {report,stats,cache:{body:readFileSync(join(workspaceRoot,'.opengeo-page-cache-output.json')),checksumSha256:stats.checksumSha256}};
    }
    try {
      const first=build(files,{});
      assert.equal(first.stats.rendered,2);assert.equal(first.stats.reused,0);
      const reused=build(files,first.cache);
      assert.equal(reused.stats.restored,true);assert.equal(reused.stats.rendered,0);assert.equal(reused.stats.reused,2);
      assert.equal(reused.report.outputTreeChecksumSha256,first.report.outputTreeChecksumSha256);
      const changed={...files,'rows.json':'[11,12]\n'};
      const incremental=build(changed,reused.cache);
      assert.equal(incremental.stats.rendered,1);assert.equal(incremental.stats.reused,1);
      assert.equal(incremental.report.outputTreeChecksumSha256,build(changed,null).report.outputTreeChecksumSha256);
      const otherProject=build(files,first.cache,randomUUID());
      assert.equal(otherProject.stats.restored,false);assert.equal(otherProject.stats.reused,0);
      const corrupt=build(files,{...first.cache,checksumSha256:'0'.repeat(64)});
      assert.equal(corrupt.stats.restored,false);assert.equal(corrupt.stats.rendered,2);
      assert(first.report.outputManifest.files.every(file=>!file.path.includes('page-cache')));
    } finally {for(const sample of samples)rmSync(sample.root,{recursive:true,force:true});}
  });
  it("packages static HTML and its assets exactly without a compiler or cache", () => {
    const files = {"site/index.html": '<!doctype html><script src="app.js"></script><h1>Map</h1>',
      "site/app.js": 'throw new Error("This is browser code, never a build hook");',
      "site/style.css": 'body{color:navy}'};
    const sample = fixture(files);
    sample.invocation.entryPath = "site/index.html";
    try {
      const report = runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
        workspaceRoot: join(sample.root, "workspace"), observableCliPath: "/missing/compiler",
        frameworkCacheRoot: "/missing/cache"});
      assert.equal(report.validationReport.prewarmedFrameworkCache, false);
      assert.equal(report.validationReport.publicationAuthorized, false);
      assert.deepEqual(report.routeManifest, [{path: "/", file: "dist/index.html"}]);
      assert.deepEqual(report.outputManifest.files.map(file => file.path), ["dist/app.js", "dist/index.html", "dist/style.css"]);
      for (const [path, bytes] of Object.entries(files)) {
        assert.equal(readFileSync(join(sample.root, "workspace/dist", path.slice(5)), "utf8"), bytes);
      }
    } finally {rmSync(sample.root, {recursive: true, force: true});}
  });

  for (const extra of ["private.txt", "site/README.md", "site/observablehq.config.js"]) {
    it(`rejects a static tree containing non-public source ${extra}`, () => {
      const sample = fixture({"site/index.html": "<!doctype html><h1>Map</h1>", [extra]: "not public"});
      sample.invocation.entryPath = "site/index.html";
      try {
        assert.throws(() => runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
          workspaceRoot: join(sample.root, "workspace")}), /static_html_public_tree_invalid/);
      } finally {rmSync(sample.root, {recursive: true, force: true});}
    });
  }
  it("compiles the CC0 facilities study with its retained lockfile, navigation and metadata", () => {
    const facilities = readFileSync(resolve("../../app/src/data/sample-public-facilities.geojson"), "utf8");
    const records = JSON.parse(facilities).features;
    assert.equal(records.length, 5);
    assert.equal(records.filter(record => record.properties.public_access === true).length, 4);
    const files = {
      "src/index.md": "# Data layers\n\nFive fictional community facilities under CC0-1.0; these records do not describe real facilities.\n\n```js\nconst facilities = await FileAttachment('./data/facilities.json').json();\ndisplay(facilities.features.filter(record => record.properties.public_access === true).length);\n```\n",
      "src/method/index.md": "# Method\n\nCount public_access values strictly equal to true: four of five fictional facilities. Preserve the original data.\n",
      "src/data/facilities.json": facilities,
      "package.json": JSON.stringify({private: true, type: "module", dependencies: {"@observablehq/framework": FRAMEWORK_VERSION}}),
      "package-lock.json": readFileSync(resolve("package-lock.json"), "utf8"),
      "opengeo.observable.json": JSON.stringify({schemaVersion: "opengeo.observable-presentation.1.0.0",
        title: "Community facilities study", theme: ["light", "dark"],
        pages: [{name: "Data layers", path: "/"}, {name: "Method", path: "/method/"}]})
    };
    const sample = fixture(files);
    sample.invocation.entryPath = "src/index.md";
    sample.invocation.lockfilePath = "package-lock.json";
    sample.invocation.request.lockfileChecksumSha256 = sha256(files["package-lock.json"]);
    const report = runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
      workspaceRoot: join(sample.root, "workspace"), observableCliPath: resolve("../../app/node_modules/.bin/observable"),
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")});
    assert.deepEqual(report.routeManifest.map(route => route.file).sort(),
      Object.keys(files).filter(path => path.startsWith('src/') && path.endsWith('.md'))
        .map(path => `dist/${path.slice(4, -3)}.html`).sort());
    assert.equal(report.validationReport.publicationAuthorized, false);
    const home = readFileSync(join(sample.root, "workspace/dist/index.html"), "utf8");
    assert.match(home, /Data layers/);
    assert.match(home, /Method/);
    assert.match(home, /CC0-1.0/);
    assert.doesNotMatch(home, /theme-air,near-midnight/);
    assert.ok(report.outputManifest.files.some(file => file.path.startsWith("dist/_observablehq/theme-air-near-midnight.")));
    const outputData = report.outputManifest.files.find(file => file.path.endsWith(".json"));
    assert.equal(outputData?.checksumSha256, sha256(facilities));
    assert.equal(outputData?.sizeBytes, Buffer.byteLength(facilities));
    const revisedLock = JSON.parse(files["package-lock.json"]);
    revisedLock.packages["node_modules/esbuild"].integrity = "sha512-changed";
    const changed = fixture({...files, "package-lock.json": JSON.stringify(revisedLock)});
    changed.invocation.entryPath = "src/index.md";
    changed.invocation.lockfilePath = "package-lock.json";
    changed.invocation.request.lockfileChecksumSha256 = sha256(files["package-lock.json"]);
    assert.throws(() => inspectInputs(changed.invocation, changed.inputRoot), /lockfile_checksum_mismatch/);
    rmSync(sample.root, {recursive: true, force: true});
    rmSync(changed.root, {recursive: true, force: true});
  });

  it("rejects unsafe, unknown and missing-target declarative presentation settings", () => {
    const config = {schemaVersion: "opengeo.observable-presentation.1.0.0", title: "Private source", pages: [{name: "Home", path: "/"}]};
    for (const invalid of [
      {...config, base: "/replace-root/"}, {...config, root: "/"}, {...config, head: "<script>"},
      {...config, title: "<script>"}, {...config, theme: ["https://example.test/theme"]},
      {...config, pages: [{name: "External", path: "https://example.test/"}]},
      {...config, pages: [{name: "Missing", path: "/missing"}]},
      {...config, pages: [{name: "Traversal", path: "/../admin"}]},
      {...config, pages: [{name: "Home", path: "/"}, {name: "Duplicate", path: "/"}]},
      {...config, pages: [{name: "Ambiguous", path: "/", pages: [{name: "Home", path: "/"}]}]}
    ]) {
      const sample = fixture({"index.md": "# Test\n", "opengeo.observable.json": JSON.stringify(invalid)});
      assert.throws(() => runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
        workspaceRoot: join(sample.root, "workspace"), observableCliPath: "/never-run", frameworkCacheRoot: "/never-read"}),
      error => error instanceof ObservableBuilderError && error.code === "presentation_configuration_invalid");
    }
  });

  it("compiles an archive-backed GeoJSON larger than the source cap without changing its bytes", () => {
    const data = JSON.stringify({type: "FeatureCollection", features: [], note: "x".repeat(18_930_900)});
    const sample = fixture({"index.md": "# Archive data\n\n```js\nconst data = await FileAttachment('./water.geojson').json();\ndisplay(data.type);\n```\n"});
    writeFileSync(join(sample.inputRoot, "water.geojson"), data);
    sample.invocation.schemaVersion = DATA_INVOCATION_SCHEMA;
    sample.invocation.dataFiles = [{path: "water.geojson", contentType: "application/geo+json",
      sizeBytes: Buffer.byteLength(data), checksumSha256: sha256(data)}];
    const parsed = inspectInputs(sample.invocation, sample.inputRoot);
    assert.ok(parsed.inputBytes > 16_777_216);
    assert.equal(parsed.files.length, 1, "Authored source retains its independent byte limit");
    const report = runBuild({invocation: sample.invocation, inputRoot: sample.inputRoot,
      workspaceRoot: join(sample.root, "workspace"), observableCliPath: resolve("../../app/node_modules/.bin/observable"),
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")});
    const output = report.outputManifest.files.find(file => file.path.endsWith(".geojson"));
    assert.equal(output?.sizeBytes, Buffer.byteLength(data));
    assert.equal(output?.checksumSha256, sha256(data));
    assert.equal(report.validationReport.inputFileCount, 2);
    assert.equal(report.validationReport.inputBytes, parsed.inputBytes);
    assert.doesNotMatch(JSON.stringify(report), /bucket|s3VersionId|objectKey/);
    const tampered = structuredClone(sample.invocation);
    tampered.dataFiles[0].path = "run.js";
    assert.throws(() => parseInvocation(tampered), /input_manifest_invalid/);
    tampered.dataFiles[0] = {...sample.invocation.dataFiles[0], sizeBytes: 67_108_865};
    assert.throws(() => parseInvocation(tampered), /input_manifest_invalid/);
    writeFileSync(join(sample.inputRoot, "water.geojson"), data.slice(1));
    assert.throws(() => inspectInputs(sample.invocation, sample.inputRoot), /input_file_mismatch/);
  });

  it("admits archive-backed TIFF only as bounded non-executable data", () => {
    const sample = fixture();
    try {
      const pin = {path: "data/elevation.tif", contentType: "image/tiff",
        sizeBytes: 64_912_721, checksumSha256: CHECKSUM};
      const invocation = {...sample.invocation, schemaVersion: DATA_INVOCATION_SCHEMA, dataFiles: [pin]};
      assert.equal(parseInvocation(invocation).allFiles.at(0).sizeBytes, pin.sizeBytes);
      assert.doesNotThrow(() => parseInvocation({...invocation,
        dataFiles: [{...pin, path: "data/elevation.TIFF", contentType: "image/geotiff", sizeBytes: 67_108_864}]}));
      for (const changed of [{sizeBytes: 67_108_865}, {contentType: "text/javascript"},
        {contentType: "application/octet-stream"}, {path: "../elevation.tif"}, {path: "data/elevation.js"}]) {
        assert.throws(() => parseInvocation({...invocation, dataFiles: [{...pin, ...changed}]}), /input_manifest_invalid/);
      }
      assert.throws(() => parseInvocation({...sample.invocation, files: [...sample.invocation.files, pin]}), /input_manifest_invalid/);
    } finally {rmSync(sample.root, {recursive: true, force: true});}
  });

  it("requires explicit size consent and sealed release approval without widening legacy archive requests", () => {
    const invocation = invocationFor({"index.md": "# Raster\n"});
    invocation.schemaVersion = DISTRIBUTION_INVOCATION_SCHEMA;
    invocation.dataFiles = [{path: "data/elevation.tif", contentType: "image/tiff", sizeBytes: 64_912_721, checksumSha256: CHECKSUM}];
    Object.assign(invocation.request, {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA, outputProfile: "archive-96m",
      sizeAcknowledgment: "allow-up-to-96-mib-output", distributionApprovalId: null, distributionApprovalChecksumSha256: null});
    const sealed = value => {value.requestChecksumSha256 = artifactChecksum(value.request); return value;};
    assert.equal(parseInvocation(sealed(invocation)).request.resourceLimits.maxOutputBytes, 32 * 1024 * 1024);
    for (const mutate of [value => {value.request.sizeAcknowledgment = null;},
      value => {value.request.resourceLimits.maxOutputBytes = 96 * 1024 * 1024;},
      value => {value.request.purpose = "release_candidate";}, value => {value.dataFiles = [];},
      value => {value.request.distributionApprovalId = randomUUID();}]) {
      const changed = structuredClone(invocation); mutate(changed);
      assert.throws(() => parseInvocation(sealed(changed)));
    }
    const release = structuredClone(invocation);
    Object.assign(release.request, {purpose: "release_candidate", distributionApprovalId: randomUUID(), distributionApprovalChecksumSha256: "a".repeat(64)});
    assert.equal(parseInvocation(sealed(release)).request.purpose, "release_candidate");
    const reviewedPreview = structuredClone(release); reviewedPreview.request.purpose = "preview";
    assert.equal(parseInvocation(sealed(reviewedPreview)).request.purpose, "preview");
    const legacy = structuredClone(invocation);
    legacy.schemaVersion = DATA_INVOCATION_SCHEMA;
    legacy.request.schemaVersion = "opengeo.observable-build-request.1.0.0";
    for (const key of ["outputProfile", "sizeAcknowledgment", "distributionApprovalId", "distributionApprovalChecksumSha256"]) delete legacy.request[key];
    legacy.request.purpose = "release_candidate";
    assert.throws(() => parseInvocation(legacy), /archive_publication_unauthorized/);
  });

  it('admits an explicit single HTML representation with unchanged source and distribution limits', () => {
    const invocation = invocationFor({'index.md': '# Localized publication\n'});
    invocation.schemaVersion = LOCALIZED_INVOCATION_SCHEMA;
    invocation.dataFiles = [];
    Object.assign(invocation.request, {schemaVersion: LOCALIZED_REQUEST_SCHEMA, outputRepresentation: 'single-html',
      outputProfile: 'default-32m', sizeAcknowledgment: null, distributionApprovalId: null,
      distributionApprovalChecksumSha256: null});
    const sealed = value => {value.requestChecksumSha256 = artifactChecksum(value.request); return value;};
    assert.equal(parseInvocation(sealed(invocation)).dataFiles.length, 0);
    const sourceRelease = structuredClone(invocation);
    sourceRelease.request.purpose = 'release_candidate';
    assert.equal(parseInvocation(sealed(sourceRelease)).request.purpose, 'release_candidate');
    const dataRelease = structuredClone(sourceRelease);
    dataRelease.dataFiles = [{path: 'data/rows.json', contentType: 'application/json', sizeBytes: 4, checksumSha256: CHECKSUM}];
    assert.throws(() => parseInvocation(sealed(dataRelease)), /distribution_request_invalid/);
    Object.assign(dataRelease.request, {distributionApprovalId: randomUUID(), distributionApprovalChecksumSha256: 'a'.repeat(64)});
    assert.equal(parseInvocation(sealed(dataRelease)).request.purpose, 'release_candidate');
    const artifactRelease = structuredClone(sourceRelease);
    artifactRelease.artifactInputs = {artifacts: []};
    artifactRelease.request.artifactInputsChecksumSha256 = artifactChecksum(artifactRelease.artifactInputs);
    assert.throws(() => parseInvocation(sealed(artifactRelease)), /localized_artifact_inputs_unsupported/);
    const legacySourceRelease = structuredClone(sourceRelease);
    legacySourceRelease.schemaVersion = DISTRIBUTION_INVOCATION_SCHEMA;
    legacySourceRelease.request.schemaVersion = DISTRIBUTION_REQUEST_SCHEMA;
    delete legacySourceRelease.request.outputRepresentation;
    assert.throws(() => parseInvocation(sealed(legacySourceRelease)), /distribution_request_invalid/);
    for (const mutate of [value => {delete value.request.outputRepresentation;},
      value => {value.request.outputRepresentation = 'asset-tree';},
      value => {value.schemaVersion = DISTRIBUTION_INVOCATION_SCHEMA;},
      value => {value.request.schemaVersion = DISTRIBUTION_REQUEST_SCHEMA;},
      value => {value.request.resourceLimits.maxInputBytes = 17 * 1024 * 1024;},
      value => {value.request.resourceLimits.maxOutputBytes = 96 * 1024 * 1024;},
      value => {value.entryPath = 'nested/index.md'; value.files[0].path = value.entryPath;}]) {
      const changed = structuredClone(invocation); mutate(changed);
      assert.throws(() => parseInvocation(sealed(changed)));
    }
    const archive = structuredClone(invocation);
    archive.dataFiles = [{path: 'data/elevation.tif', contentType: 'image/tiff', sizeBytes: 64_912_721, checksumSha256: CHECKSUM}];
    Object.assign(archive.request, {outputProfile: 'archive-96m', sizeAcknowledgment: 'allow-up-to-96-mib-output'});
    assert.equal(parseInvocation(sealed(archive)).request.outputProfile, 'archive-96m');
    for (const mutate of [value => {value.dataFiles = [];}, value => {value.request.sizeAcknowledgment = null;},
      value => {value.request.purpose = 'release_candidate';}]) {
      const changed = structuredClone(archive); mutate(changed);
      assert.throws(() => parseInvocation(sealed(changed)), /distribution_request_invalid/);
    }
    Object.assign(archive.request, {purpose: 'release_candidate', distributionApprovalId: randomUUID(),
      distributionApprovalChecksumSha256: 'a'.repeat(64)});
    assert.equal(parseInvocation(sealed(archive)).request.purpose, 'release_candidate');
  });

  it('compiles and seals a native single HTML representation through the existing builder', () => {
    const sample = fixture({'index.md': '# Localized publication\n\n```js\ndisplay(42);\n```\n',
      'opengeo.observable.json': JSON.stringify({schemaVersion: 'opengeo.observable-presentation.1.0.0',
        title: 'Localized publication', theme: ['light', 'dark']})});
    try {
      const invocation = sample.invocation;
      invocation.schemaVersion = LOCALIZED_INVOCATION_SCHEMA;
      invocation.dataFiles = [];
      Object.assign(invocation.request, {schemaVersion: LOCALIZED_REQUEST_SCHEMA, outputRepresentation: 'single-html',
        outputProfile: 'default-32m', sizeAcknowledgment: null, distributionApprovalId: null,
        distributionApprovalChecksumSha256: null, resourceLimits: limits({timeoutSeconds: 15, maxOutputBytes: 1024 * 1024})});
      invocation.requestChecksumSha256 = artifactChecksum(invocation.request);
      const workspaceRoot = join(sample.root, 'workspace');
      const report = runBuild({invocation, inputRoot: sample.inputRoot, workspaceRoot,
        observableCliPath: resolve('../../app/node_modules/.bin/observable'),
        frameworkCacheRoot: resolve('../../app/src/.observablehq/cache')});
      assert.equal(report.schemaVersion, LOCALIZED_REPORT_SCHEMA);
      assert.deepEqual(readdirSync(join(workspaceRoot, 'dist')), ['index.html']);
      const html = readFileSync(join(workspaceRoot, 'dist/index.html'));
      const file = {path: 'dist/index.html', contentType: 'text/html', sizeBytes: html.length, checksumSha256: sha256(html)};
      assert.deepEqual(report.outputManifest.files, [file]);
      assert.equal(report.outputTreeChecksumSha256, sha256(JSON.stringify([file])));
      assert.deepEqual(report.routeManifest, [{path: '/', file: 'dist/index.html'}]);
      const {manifest, manifestChecksumSha256} = report.localizedOutput;
      assert.deepEqual(manifest.output, file);
      assert.equal(manifest.outputBytes, file.sizeBytes);
      assert.equal(manifestChecksumSha256, artifactChecksum(manifest));
      const native = inspectOutputs(join(workspaceRoot, `.opengeo-native-output-${invocation.buildJobId}`, 'dist'), invocation.request.resourceLimits);
      assert.equal(manifest.sourceOutputTreeChecksumSha256, native.outputTreeChecksumSha256);
      assert.notEqual(native.outputTreeChecksumSha256, report.outputTreeChecksumSha256);
      assert.ok(native.files.length > 1);
      assert.ok(manifest.inputFiles.some(({path}) => /theme-air-near-midnight\.[a-f0-9]+\.css$/.test(path)));
      assert.equal(manifest.publicationAuthorized, false);
      assert.equal(report.validationReport.publicationAuthorized, false);
      assert.match(html.toString(), /Localized publication/);
      assert.match(html.toString(), /type="importmap"/);
    } finally {rmSync(sample.root, {recursive: true, force: true});}
  });

  it("collects a full-size exact archived output only with its acknowledged budget and matching pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeo-full-archive-output-"));
    try {
      const outputRoot = join(root, "dist"); mkdirSync(outputRoot);
      const archivePath = join(outputRoot, "elevation.tif");
      // Sparse byte-budget fixture, not a GeoTIFF parsing or rendering claim.
      writeFileSync(archivePath, Buffer.from([0x49, 0x49, 0x2a, 0x00])); truncateSync(archivePath, 64_912_721);
      writeFileSync(join(outputRoot, "index.html"), "<!doctype html><title>Archive</title>");
      const pin = {path: "data/elevation.tif", contentType: "image/tiff", sizeBytes: 64_912_721,
        checksumSha256: sha256(readFileSync(archivePath))};
      const expanded = limits({maxOutputBytes: 96 * 1024 * 1024});
      const invocation = {request: {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA, outputProfile: "archive-96m",
        sizeAcknowledgment: "allow-up-to-96-mib-output", resourceLimits: limits()}, dataFiles: [pin]};
      assert.throws(() => inspectOutputs(outputRoot, limits(), 32 * 1024 * 1024), /output_file_limit_exceeded/);
      assert.throws(() => inspectOutputs(outputRoot, expanded, 32 * 1024 * 1024, [{...pin, checksumSha256: "f".repeat(64)}]), /output_file_limit_exceeded/);
      const accepted = inspectOutputs(outputRoot, expanded, 32 * 1024 * 1024, [pin]);
      assert.equal(accepted.files.find(file => file.path.endsWith(".tif")).checksumSha256, pin.checksumSha256);
      const collected = await readOutputTree(outputRoot, expanded, invocation);
      assert.equal(sha256(collected.get("dist/elevation.tif")), pin.checksumSha256);
      await assert.rejects(readOutputTree(outputRoot, expanded, {...invocation, dataFiles: [{...pin, checksumSha256: "f".repeat(64)}]}), /runner_output_tree_invalid/);
      renameSync(archivePath, join(outputRoot, "large.html"));
      assert.throws(() => inspectOutputs(outputRoot, expanded, 32 * 1024 * 1024, [pin]), /output_file_limit_exceeded/);
      await assert.rejects(readOutputTree(outputRoot, expanded, invocation), /runner_output_tree_invalid/);
    } finally {rmSync(root, {recursive: true, force: true});}
  });

  it("accepts only the exact sorted input tree and closed request policy", () => {
    const sample = fixture();
    const parsed = inspectInputs(sample.invocation, sample.inputRoot);

    assert.equal(parsed.inputBytes, readFileSync(join(sample.inputRoot, "index.md")).length);
    assert.equal(parsed.request.networkPolicy, "deny_all");
    assert.equal(parsed.request.frameworkVersion, "1.13.4");
    assert.equal(parsed.request.purpose, "preview");
  });

  it("rejects extra files, symlinks, unsafe paths, and widened limits", () => {
    const extra = fixture();
    writeFileSync(join(extra.inputRoot, "extra.md"), "# Extra\n");
    assert.throws(
      () => inspectInputs(extra.invocation, extra.inputRoot),
      (error) => error instanceof ObservableBuilderError && error.code === "input_tree_mismatch"
    );

    const linked = fixture();
    symlinkSync(join(linked.inputRoot, "index.md"), join(linked.inputRoot, "linked.md"));
    linked.invocation.files.push({
      path: "linked.md",
      contentType: "text/markdown",
      sizeBytes: linked.invocation.files[0].sizeBytes,
      checksumSha256: linked.invocation.files[0].checksumSha256
    });
    assert.throws(
      () => inspectInputs(linked.invocation, linked.inputRoot),
      (error) => error instanceof ObservableBuilderError && error.code === "input_symlink_forbidden"
    );

    const unsafe = invocationFor({"index.md": "# Safe\n"});
    unsafe.files[0].path = ".env";
    assert.throws(() => parseInvocation(unsafe), {code: "input_manifest_invalid"});

    const widened = invocationFor({"index.md": "# Safe\n"});
    widened.request.resourceLimits.maxOutputBytes = 32 * 1024 * 1024 + 1;
    assert.throws(() => parseInvocation(widened), {code: "resource_limits_invalid"});
  });

  it("passes no inherited AWS, OpenGeo, proxy, or credential environment", () => {
    const environment = compilerEnvironment();
    assert.deepEqual(Object.keys(environment).sort(), [
      "CI",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "OBSERVABLE_TELEMETRY_DISABLE",
      "PATH",
      "SOURCE_DATE_EPOCH",
      "TZ"
    ]);
    assert.equal(Object.keys(environment).some((key) => /AWS|OPEN_GEO|TOKEN|SECRET|PROXY/i.test(key)), false);
  });

  it("preserves lockfile v3 hook metadata without treating it as installation authority", () => {
    const validLock = JSON.stringify({
      name: "private-preview",
      lockfileVersion: 3,
      requires: true,
      packages: {"": {name: "private-preview"}}
    });
    const valid = fixture({"index.md": "# Safe\n", "package-lock.json": validLock});
    valid.invocation.lockfilePath = "package-lock.json";
    valid.invocation.request.lockfileChecksumSha256 = sha256(validLock);
    assert.doesNotThrow(() => inspectInputs(valid.invocation, valid.inputRoot));

    const unsafeLock = JSON.stringify({
      name: "private-preview",
      lockfileVersion: 3,
      requires: true,
      packages: {"node_modules/hostile": {hasInstallScript: true}}
    });
    const unsafe = fixture({"index.md": "# Safe\n", "package-lock.json": unsafeLock});
    unsafe.invocation.lockfilePath = "package-lock.json";
    unsafe.invocation.request.lockfileChecksumSha256 = sha256(unsafeLock);
    assert.doesNotThrow(() => inspectInputs(unsafe.invocation, unsafe.inputRoot));
  });

  it('retains old and relocated dependency metadata while rejecting malformed package records', () => {
    const trusted = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')).packages['node_modules/esbuild'];
    for (const [path, dependency, accepted] of [
      ['node_modules/parent/node_modules/esbuild', trusted, true],
      ['node_modules/parent/node_modules/hostile', trusted, true],
      ['node_modules/parent/node_modules/esbuild', {...trusted, integrity:'sha512-changed'}, true],
      ['node_modules/parent/node_modules/esbuild', {...trusted, version:'0.27.4'}, true],
      ['node_modules/fsevents', {version:'2.3.3',hasInstallScript:true,optional:true}, true],
      ['node_modules/esbuild', {...trusted,hasInstallScript:'true'}, false],
      ['node_modules/esbuild', null, false]
    ]) {
      const lock = JSON.stringify({lockfileVersion:3, packages:{[path]:dependency}});
      const sample = fixture({'index.md':'# Source', 'package-lock.json':lock});
      sample.invocation.lockfilePath = 'package-lock.json'; sample.invocation.request.lockfileChecksumSha256 = sha256(lock);
      try {
        if (accepted) assert.doesNotThrow(() => inspectInputs(sample.invocation, sample.inputRoot));
        else assert.throws(() => inspectInputs(sample.invocation, sample.inputRoot), /lockfile_invalid/);
      } finally {rmSync(sample.root, {recursive:true, force:true});}
    }
  });

  it('does not run source package commands or install dependency hooks during a Framework build', () => {
    const marker='SOURCE_LIFECYCLE_MUST_NOT_EXECUTE';
    const script=`node -e "require('fs').writeFileSync('dist/hook.txt','${marker}')"`;
    const lock=JSON.stringify({lockfileVersion:3,packages:{'node_modules/hostile':{version:'1.0.0',hasInstallScript:true,resolved:'https://never-fetch.invalid/package.tgz'}}});
    const sample=fixture({'src/index.md':'# Preserved source',
      'package.json':JSON.stringify({type:'module',scripts:{preinstall:script,install:script,postinstall:script,prepare:script,build:script}}),
      'package-lock.json':lock});
    sample.invocation.entryPath='src/index.md';sample.invocation.lockfilePath='package-lock.json';
    sample.invocation.request.lockfileChecksumSha256=sha256(lock);
    try {
      const report=runBuild({invocation:sample.invocation,inputRoot:sample.inputRoot,workspaceRoot:join(sample.root,'workspace'),
        observableCliPath:resolve('../../app/node_modules/.bin/observable'),frameworkCacheRoot:resolve('../../app/src/.observablehq/cache')});
      assert(report.routeManifest.some(route=>route.file==='dist/index.html'));
      assert(!report.outputManifest.files.some(file=>file.path.endsWith('hook.txt')));
      assert.equal(readFileSync(join(sample.inputRoot,'package-lock.json'),'utf8'),lock);
    } finally {rmSync(sample.root,{recursive:true,force:true});}
  });

  it('preserves authored Framework presentation when explicitly enabled in the isolated compiler', () => {
    const lock=JSON.stringify({lockfileVersion:3,packages:{}});
    const files={'package.json':'{"type":"module"}','package-lock.json':lock,
      'observablehq.config.js':`import {label} from './src/site.js';
        export default {root:'src',title:label,theme:['near-midnight','wide'],search:false,
          pages:[{name:'Home',path:'/'},{name:'Methods',path:'/methods'}],
          globalStylesheets:['/style.css'],head:()=>'<meta name="authored-head" content="yes">',
          header:()=>'<nav class="authored-header">'+label+'</nav>',footer:()=>'<footer class="authored-footer">Source project</footer>'};`,
      'src/site.js':`export const label='Project navigation';`,
      'src/style.css':'.authored-header{color:rgb(12,34,56)}',
      'src/index.md':'# Authored home','src/methods.md':'# Methods'};
    const sample=fixture(files); sample.invocation.entryPath='src/index.md'; sample.invocation.lockfilePath='package-lock.json';
    sample.invocation.request.lockfileChecksumSha256=sha256(lock);
    try {
      const report=runBuild({invocation:sample.invocation,inputRoot:sample.inputRoot,workspaceRoot:join(sample.root,'workspace'),
        observableCliPath:resolve('../../app/node_modules/.bin/observable'),frameworkCacheRoot:resolve('../../app/src/.observablehq/cache'),
        allowSourceConfiguration:true,incrementalPageCache:{}});
      const html=readFileSync(join(sample.root,'workspace/dist/index.html'),'utf8');
      assert.match(html,/<nav class="authored-header">Project navigation<\/nav>/);
      assert.match(html,/<footer class="authored-footer">Source project<\/footer>/);
      assert.match(html,/<meta name="authored-head" content="yes">/);
      assert(report.outputManifest.files.some(file=>file.path.includes('theme-near-midnight-wide.')));
      assert(report.outputManifest.files.some(file=>file.path.includes('/style.') && file.path.endsWith('.css')));
      assert.equal(readFileSync(join(sample.inputRoot,'observablehq.config.js'),'utf8'),files['observablehq.config.js']);
    } finally {rmSync(sample.root,{recursive:true,force:true});}
  });

  it("builds the same local tree twice and emits no storage or publication authority", () => {
    const first = fixture({
      "data.js": "export const answer = 42;\n",
      "index.md": "# Exact private preview\n\n```js\nimport {answer} from './data.js';\ndisplay(answer);\nPlot.plot({marks: [Plot.dot([[1, answer]])]});\n```\n"
    });
    const cli = resolve("../../app/node_modules/.bin/observable");
    const firstReport = runBuild({
      invocation: first.invocation,
      inputRoot: first.inputRoot,
      workspaceRoot: join(first.root, "workspace"),
      observableCliPath: cli,
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")
    });
    const second = fixture({
      "data.js": "export const answer = 42;\n",
      "index.md": "# Exact private preview\n\n```js\nimport {answer} from './data.js';\ndisplay(answer);\nPlot.plot({marks: [Plot.dot([[1, answer]])]});\n```\n"
    });
    second.invocation.buildJobId = first.invocation.buildJobId;
    second.invocation.request = structuredClone(first.invocation.request);
    second.invocation.inputManifestChecksumSha256 = first.invocation.inputManifestChecksumSha256;
    second.invocation.requestChecksumSha256 = first.invocation.requestChecksumSha256;
    const secondReport = runBuild({
      invocation: second.invocation,
      inputRoot: second.inputRoot,
      workspaceRoot: join(second.root, "workspace"),
      observableCliPath: cli,
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")
    });

    assert.equal(firstReport.outputTreeChecksumSha256, secondReport.outputTreeChecksumSha256);
    assert.ok(firstReport.outputManifest.files.some(({path}) => path === "dist/index.html"));
    assert.ok(
      firstReport.outputManifest.files.some(({path}) =>
        path.startsWith("dist/_npm/@observablehq/plot@0.6.17/")
      )
    );
    assert.deepEqual(firstReport.routeManifest, [{path: "/", file: "dist/index.html"}]);
    assert.equal(firstReport.validationReport.publicationAuthorized, false);
    const serialized = JSON.stringify(firstReport);
    assert.doesNotMatch(serialized, /bucket|objectKey|s3VersionId|etag|credential/i);
  });

  for (const authoredConfiguration of [false, true]) it(`builds exact-file navigation with ${authoredConfiguration ? 'authored' : 'generated'} Framework configuration`, () => {
    const lockfile = JSON.stringify({lockfileVersion: 3, packages: {"": {name: "navigation"}}});
    const configuration = 'export default {root:"src", preserveIndex:false, preserveExtension:false};\n';
    const sample = fixture({
      'package.json': '{"type":"module"}', 'package-lock.json': lockfile,
      ...(authoredConfiguration ? {'observablehq.config.js': configuration} : {}),
      'src/index.md': '# Home\n\n[Methods](./methods) · [Nested](./nested/)\n',
      'src/methods.md': '# Methods\n\n[Home](./) · [Nested](./nested/)\n',
      'src/nested/index.md': '# Nested\n\n[Methods](../methods) · [Home](../)\n'
    });
    sample.invocation.entryPath='src/index.md'; sample.invocation.lockfilePath='package-lock.json';
    sample.invocation.request.lockfileChecksumSha256=sha256(lockfile);
    const report=runBuild({invocation:sample.invocation,inputRoot:sample.inputRoot,
      workspaceRoot:join(sample.root,'workspace'),observableCliPath:resolve('../../app/node_modules/.bin/observable'),
      frameworkCacheRoot:resolve('../../app/src/.observablehq/cache'),allowSourceConfiguration:authoredConfiguration});
    const files=new Set(report.outputManifest.files.map(file=>file.path));
    const prefix='/private/build/output/';
    let pageLinks=0;
    for (const file of report.outputManifest.files.filter(file=>file.path.endsWith('.html'))) {
      const html=readFileSync(join(sample.root,'workspace',file.path),'utf8');
      for (const [,href] of html.matchAll(/\bhref="([^\"]*)"/g)) {
        const target=new URL(href.replaceAll('&amp;','&'),`https://publication.test${prefix}${file.path}`);
        if(target.origin!=='https://publication.test') continue;
        assert.ok(target.pathname.startsWith(prefix),'Link escaped its build prefix');
        const path=decodeURIComponent(target.pathname.slice(prefix.length));
        assert.ok(files.has(path),`Exact-key hosting cannot resolve ${href} from ${file.path}`);
        if(path.endsWith('.html') && !target.hash) pageLinks++;
      }
    }
    assert.ok(pageLinks>=6,'Exercise navigation between all three pages');
    assert.deepEqual(report.routeManifest.map(route=>route.path),['/','/methods','/nested/']);
    if(authoredConfiguration) assert.equal(readFileSync(join(sample.root,'workspace/src/observablehq.config.js'),'utf8'),configuration);
  });

  it("builds a complete Framework folder without adding src to public page and asset paths", () => {
    const lockfile = JSON.stringify({lockfileVersion: 3, packages: {"": {name: "publication"}}});
    const sample = fixture({
      "package.json": JSON.stringify({type: "module"}),
      "package-lock.json": lockfile,
      "observablehq.config.js": "throw new Error('Imported configuration must not execute');\n",
      "opengeo.observable.json": JSON.stringify({schemaVersion: "opengeo.observable-presentation.1.0.0",
        title: "Independent publication", theme: ["light", "dark"], pages: [
          {name: "Publication home", path: "/"},
          {name: "Methods", pages: [{name: "Transmission analysis", path: "/methods/transmission-line-analysis"}]}
        ]}),
      "README.md": "# Project administration, not a public page\n",
      "src/index.md": "# Publication home\n\n[Analysis](./methods/transmission-line-analysis)\n",
      "src/components/site.js": "export const label = 'Transmission analysis';\n",
      "src/data/sample.json": JSON.stringify({distance: 42}),
      "src/methods/transmission-line-analysis.md": "# Transmission line analysis\n\n```js\nimport {label} from '../components/site.js';\ndisplay(label);\ndisplay(await FileAttachment('../data/sample.json').json());\n```\n",
      "src/new-src/index.md": "# Nested project page\n"
    });
    sample.invocation.entryPath = "src/index.md";
    sample.invocation.lockfilePath = "package-lock.json";
    sample.invocation.request.lockfileChecksumSha256 = sha256(lockfile);
    const report = runBuild({
      invocation: sample.invocation,
      inputRoot: sample.inputRoot,
      workspaceRoot: join(sample.root, "workspace"),
      observableCliPath: resolve("../../app/node_modules/.bin/observable"),
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")
    });
    assert.deepEqual(report.routeManifest, [
      {path: "/", file: "dist/index.html"},
      {path: "/methods/transmission-line-analysis", file: "dist/methods/transmission-line-analysis.html"},
      {path: "/new-src/", file: "dist/new-src/index.html"}
    ]);
    assert.ok(report.outputManifest.files.some(({path}) => /^dist\/_file\/data\/sample\.[a-f0-9]+\.json$/.test(path)));
    assert.ok(report.outputManifest.files.some(({path}) => /^dist\/_import\/components\/site\.[a-f0-9]+\.js$/.test(path)));
    assert.equal(report.validationReport.publicationAuthorized, false);
    assert.equal(readFileSync(join(sample.root, "workspace/src/observablehq.config.js"), "utf8"),
      "throw new Error('Imported configuration must not execute');\n");
    const generated = readFileSync(join(sample.root, "workspace/.opengeo.observable.config.mjs"), "utf8");
    assert.match(generated, /"title":"Independent publication"/);
    assert.match(generated, /"sidebar":true/);
    assert.match(generated, /"theme":\["light","dark"\]/);
    assert.match(readFileSync(join(sample.root, "workspace/dist/index.html"), "utf8"), /Transmission analysis/);
    sample.invocation.entryPath = "src/methods/transmission-line-analysis.md";
    const nestedEntry = runBuild({
      invocation: sample.invocation,
      inputRoot: sample.inputRoot,
      workspaceRoot: join(sample.root, "nested-entry-workspace"),
      observableCliPath: resolve("../../app/node_modules/.bin/observable"),
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")
    });
    assert.deepEqual(nestedEntry.routeManifest, report.routeManifest);
  });

  it("retains literal src routes for a flat revision without a package manifest", () => {
    const sample = fixture({"src/index.md": "# Literal source directory\n"});
    sample.invocation.entryPath = "src/index.md";
    const report = runBuild({
      invocation: sample.invocation,
      inputRoot: sample.inputRoot,
      workspaceRoot: join(sample.root, "workspace"),
      observableCliPath: resolve("../../app/node_modules/.bin/observable"),
      frameworkCacheRoot: resolve("../../app/src/.observablehq/cache")
    });
    assert.deepEqual(report.routeManifest, [{path: "/src/", file: "dist/src/index.html"}]);
  });
});
