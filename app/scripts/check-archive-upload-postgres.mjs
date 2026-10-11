// Actual built uploader and worker; real authenticated local API/runtime DB;
// all S3 requests redirected to an offline checksum-checking storage peer.
import assert from "node:assert/strict";
import {request} from "node:http";
import {createServer} from "node:https";
import {execFileSync} from "node:child_process";
import {readFile, readdir, mkdtemp, mkdir, writeFile, rm, open} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve, extname, join} from "node:path";
import {tmpdir} from "node:os";
import {chromium} from "playwright";
let input = ""; for await (const part of process.stdin) input += part;
const config = JSON.parse(input), dist = resolve("dist"), calls = [], errors = [], blocked = [];
const workspaceShell = config.workspaceShell === true;
const large = config.largeFileBytes === 5 * 1024 ** 3 + 3;
assert.ok(config.largeFileBytes == null || large, "Unexpected large-file budget");
const sourceBytes = large ? config.largeFileBytes : 64 * 1024 * 1024 + 3;
const expectedParts = Math.ceil(sourceBytes / (64 * 1024 * 1024));
const modulePath = async (dir, name) => {
  const file = (await readdir(resolve(dist, "_import", dir))).find(file => file.startsWith(name + ".") && file.endsWith(".js"));
  assert.ok(file, `Missing built module ${name}`); return `/_import/${dir}/${file}`;
};
const component = await modulePath("components", "ArchiveFolderUpload"), client = await modulePath("lib", "apiClient");
const workspace = workspaceShell ? await modulePath("components", "ProjectWorkspacePage") : null;
const stylesheet = "/_file/" + (await readdir(resolve(dist, "_file"))).find(name => /^style\..*\.css$/.test(name));
const temp = await mkdtemp(join(tmpdir(), "archive-browser-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=localhost", "-keyout", join(temp, "key.pem"), "-out", join(temp, "cert.pem")], {stdio: "ignore"});
const server = createServer({key: await readFile(join(temp, "key.pem")), cert: await readFile(join(temp, "cert.pem"))}, async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const upstream = request({hostname: "127.0.0.1", port: config.apiPort, path: req.url.slice(4), method: req.method, headers: req.headers}, response => {
      calls.push({method: req.method, path: req.url.split("?")[0], status: response.statusCode});
      res.writeHead(response.statusCode, {...response.headers, "access-control-allow-origin": req.headers.origin ?? "null"}); response.pipe(res);
    }); upstream.on("error", () => res.writeHead(502).end()); req.pipe(upstream); return;
  }
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"><main></main><script type="module">
      import {ArchiveFolderUpload} from '${component}'; import {OpenGeoApiClient} from '${client}';
      ${workspaceShell ? `import {ProjectWorkspacePage} from '${workspace}';` : ''}
      let organization = ${JSON.stringify(config.organizationId)};
      window.changeArchiveOrganization = value => {organization = value;};
      const adapter = new OpenGeoApiClient({baseUrl:'/api', tokenProvider:()=> 'editor', organizationProvider:()=>organization});
      adapter.selectOrganization = value => {organization = value;};
      const session = await adapter.getSession();
      const project = ${JSON.stringify({id: config.workspaceId})};
      const state = {adapter,session,organization:{id:organization},project};
      window.archiveTestState = state;
      document.querySelector('main').append(${workspaceShell ? 'ProjectWorkspacePage({adapter,projectId:project.id,managementTarget:"data"})' : 'ArchiveFolderUpload({state})'});
    </script>`); return;
  }
  const path = resolve(dist, "." + decodeURIComponent(req.url.split("?")[0]));
  if (!path.startsWith(dist + "/")) {res.writeHead(403).end(); return;}
  try {res.setHeader("Content-Type", extname(path) === ".js" ? "text/javascript" : extname(path) === ".css" ? "text/css" : "application/octet-stream"); res.end(await readFile(path));}
  catch {res.writeHead(404).end();}
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `https://127.0.0.1:${server.address().port}`;
const folder = join(temp, "originals");
await mkdir(folder);
await writeFile(join(folder, "README.md"), "preserved script metadata\n");
await writeFile(join(folder, "README-copy.md"), "preserved script metadata\n");
if (large) {
  const source = await open(join(folder, "source.bin"), "wx");
  try {await source.truncate(sourceBytes);} finally {await source.close();}
} else await writeFile(join(folder, "source.bin"), Buffer.alloc(sourceBytes, 0x61));
const teardownFolder = join(temp, "teardown");
await mkdir(teardownFolder); await writeFile(join(teardownFolder, "cancel.txt"), "cancel");
let browser, page, release, releaseTeardown, progressTimer;
try {
  browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync)});
  const context = await browser.newContext({acceptDownloads: true, ignoreHTTPSErrors: true});
  let pauseOnce = true, heldResolve;
  let holdTeardown = false, teardownResolve;
  const teardownHeld = new Promise(resolve => {teardownResolve = resolve;});
  const held = new Promise(resolve => {heldResolve = resolve;});
  await context.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "https://s3.us-east-1.amazonaws.com" && url.searchParams.get("X-Amz-Signature") === "offline-fixture") {
      const headers = {"access-control-allow-origin": origin, "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "content-type,x-amz-checksum-sha256,x-amz-expected-bucket-owner"};
      if (req.method() === "OPTIONS") return route.fulfill({status: 204, headers});
      if (req.method() === "GET") return route.continue({url: `${origin}/api/_archive-fixture/get${url.search}`});
      assert.equal(req.method(), "PUT");
      assert.equal(req.headers().authorization, undefined);
      if (holdTeardown) {
        holdTeardown = false; teardownResolve();
        await new Promise(resolve => {releaseTeardown = resolve;});
        return route.abort().catch(() => {});
      }
      if (url.searchParams.get("number") === (large ? "70" : "2") && pauseOnce) {
        pauseOnce = false; heldResolve();
        await new Promise(resolve => {release = resolve;});
        return route.abort().catch(() => {});
      }
      // CDP cannot expose file-backed XHR bodies through postDataBuffer. Route
      // the original request to the local HTTPS peer without copying/replacing it.
      return route.continue({url: `${origin}/api/_archive-fixture/put${url.search}`});
    }
    blocked.push(req.url()); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(large ? 900000 : 15000); page.on("pageerror", error => errors.push(error.message));
  if (large) progressTimer = setInterval(() => {
    page.getByRole("status").textContent({timeout: 3000}).then(status =>
      console.error(JSON.stringify({largeFileProgress: status}))).catch(() => {});
  }, 30000).unref();
  const click = name => page.getByRole("button", {name, exact: true}).click();
  await page.goto(origin);
  await page.getByLabel("Archive folder", {exact: true}).setInputFiles(folder);
  await click("Load private destinations");
  await page.getByLabel("Private archive destination", {exact: true}).selectOption({label: "Private fixture · s3://fixture-bucket/bhutan/private/"});
  await click("Review files and duplicates");
  await page.getByRole("status").filter({hasText: "3 files · 2 unique objects"}).waitFor();
  await click("Upload reviewed originals");
  await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error("Second part was not reached")), (large ? 900000 : 60000)).unref())]);
  await click("Pause"); release();
  await page.getByRole("status").filter({hasText: "Paused."}).waitFor();
  const savedBefore = await page.evaluate(() => localStorage.getItem(localStorage.key(0)));
  assert.ok(JSON.parse(savedBefore).uploadId);
  assert.ok(!savedBefore.includes("source.bin") && !savedBefore.includes("X-Amz"));
  await page.reload();
  await page.getByLabel("Archive folder", {exact: true}).setInputFiles(folder);
  await click("Resume saved upload");
  await page.getByRole("status").filter({hasText: "3 files · 2 unique objects"}).waitFor();
  await click("Upload reviewed originals");
  await page.getByRole("status").filter({hasText: "Verified 3 original paths in 2 stored objects."}).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await click("Download reconstruction manifest");
  const download = await downloadPromise, manifest = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(manifest.files.length, 3);
  const copies = manifest.files.filter(file => file.path.endsWith(".md"));
  assert.equal(copies[0].object.version_id, copies[1].object.version_id);
  const stats = await (await fetch(`http://127.0.0.1:${config.apiPort}/_archive-fixture/stats`)).json();
  assert.equal(stats.objects, 2); assert.equal(stats.pending_uploads, 0);
  assert.equal(stats.writes.length, expectedParts + 1); assert.equal(stats.writes.filter(row => row.number === 1).length, 1);
  assert.equal(stats.writes.filter(row => row.number > 0).reduce((sum, row) => sum + row.size, 0), sourceBytes);
  await click("Preserve reconstruction records in S3");
  await page.getByRole("status").filter({hasText: "Preserved 1 reconstruction records in the original private destinations."}).waitFor();
  const archivedDownload = page.waitForEvent("download");
  await click("Download reconstruction manifest");
  const archived = JSON.parse(await readFile(await (await archivedDownload).path(), "utf8"));
  assert.equal(archived.archivedRecords.length, 1);
  assert.ok(archived.archivedRecords[0].object.version_id);
  assert.equal(archived.archivedIndexes.length, 1);
  assert.ok(archived.archivedIndexes[0].object.key.endsWith("/index.json"));
  await page.reload(); await click("Resume saved upload");
  await page.getByRole("status").filter({hasText: "Saved upload is complete."}).waitFor();
  await click("Preserve reconstruction records in S3");
  await page.getByRole("status").filter({hasText: "Preserved 1 reconstruction records in the original private destinations."}).waitFor();
  const afterArchive = await (await fetch(`http://127.0.0.1:${config.apiPort}/_archive-fixture/stats`)).json();
  assert.equal(afterArchive.writes.length, expectedParts + 3);
  assert.equal(afterArchive.writes.filter(row => row.manifest).length, 2);
  assert.equal(afterArchive.reads.length, 0);
  if (!large) {
  // Headless substitute only for the native picker: actual browser filesystem
  // handles/writable streams in OPFS, not a mocked file writer.
  await page.evaluate(() => {window.showDirectoryPicker = () => navigator.storage.getDirectory();});
  await click("Choose empty restore folder");
  await click("Restore archived originals");
  await page.getByRole("status").filter({hasText: "Restored and verified 3 original paths."}).waitFor();
  const restored = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("originals"), files = [];
    for await (const [name, handle] of dir.entries()) {
      const file = await handle.getFile();
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      files.push({path: `originals/${name}`, size_bytes: file.size,
        sha256: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")});
    }
    return files;
  });
  for (const file of manifest.files) {
    const actual = restored.find(value => value.path === file.path);
    assert.equal(actual.size_bytes, file.size_bytes); assert.equal(actual.sha256, file.sha256);
  }
  const afterRestore = await (await fetch(`http://127.0.0.1:${config.apiPort}/_archive-fixture/stats`)).json();
  assert.equal(afterRestore.reads.length, 2);
  }
  const beforeScopeChange = calls.length;
  await page.evaluate(id => {window.changeArchiveOrganization(id);}, config.otherOrganizationId);
  await click("Preserve reconstruction records in S3");
  await page.getByRole("status").filter({hasText: "The signed-in account or workspace changed."}).waitFor();
  assert.ok(calls.slice(beforeScopeChange).every(call => call.path === "/api/auth/session"));
  await page.evaluate(id => {window.changeArchiveOrganization(id);}, config.organizationId);
  await click("Start a new archive"); await click("Clear selection");
  await page.getByLabel("Archive folder", {exact: true}).setInputFiles(teardownFolder);
  await click("Load private destinations");
  await page.getByLabel("Private archive destination", {exact: true}).selectOption({label: "Private fixture · s3://fixture-bucket/bhutan/private/"});
  await click("Review files and duplicates");
  await page.getByRole("status").filter({hasText: "1 files · 1 unique objects"}).waitFor();
  holdTeardown = true; await click("Upload reviewed originals");
  await Promise.race([teardownHeld, new Promise((_, reject) => setTimeout(() => reject(Error("Teardown PUT not reached")), 15000).unref())]);
  const beforeTeardown = calls.length;
  const cancelledPut = page.waitForEvent("requestfailed", {predicate: request =>
    request.method() === "PUT" && request.url().startsWith("https://s3.us-east-1.amazonaws.com/"), timeout: 5000});
  await page.evaluate(() => document.querySelector("main").replaceChildren());
  releaseTeardown();
  await cancelledPut;
  assert.ok(!calls.slice(beforeTeardown).some(call => /\/(complete|finish)$/.test(call.path)));
  const afterTeardown = await (await fetch(`http://127.0.0.1:${config.apiPort}/_archive-fixture/stats`)).json();
  assert.equal(afterTeardown.writes.length, expectedParts + 3);
  await page.reload();
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole("button", {name: "Resume saved upload", exact: true}).waitFor({state: "visible"});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({builtUploader: true, workspaceDataPage: workspaceShell, realApiAndRuntimeDatabase: true,
    pausedReloadAndResume: true, verifiedPartReused: true, duplicatePathsPreserved: true,
    downloadedManifest: true, completedReopen: true, privateScopeIdsOnly: true,
    preservedReconstructionPage: true, preservationRetryNoDuplicateWrite: true,
    completeDestinationIndex: true,
    streamedVerifiedRestore: !large, restoredDuplicateWithoutSecondGet: !large,
    restorePicker: large ? "not exercised for large upload" : "headless OPFS substitute; real browser filesystem streams",
    accountChangeBeforeMutationDenied: true, removedPanelStopsUploadCompletion: true,
    storagePeer: large ? "offline non-retaining real-byte checksum peer" : "offline real-byte checksum peer", sourceBytes,
    multipartCount: expectedParts, greaterThanFiveGiB: large,
    storageWrites: stats.writes.length, apiRequests: calls.length, blockedExternalRequests: blocked.length,
    externalRequests: 0, scope: workspaceShell ? "Built workspace Data page and worker; synthetic sign-in/storage, not production S3 or native picker" : "Built component and worker; synthetic sign-in and storage, not production S3 or full Studio shell"}));
} catch (error) {
  console.error(JSON.stringify({error: error.message, feedback: await page?.getByRole("status").textContent({timeout: 1000}).catch(() => null), errors, lastCalls: calls.slice(-8)}));
  throw error;
} finally {
  clearInterval(progressTimer); release?.(); releaseTeardown?.(); await browser?.close(); await new Promise(done => server.close(done)); await rm(temp, {recursive: true, force: true});
}
