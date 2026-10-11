import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runInNewContext} from "node:vm";
import {integratedStudioShellMode, loadIntegratedStudioBuild, integratedStudioAuthConfig,
  initializeIntegratedStudioSession} from "../scripts/integrated-studio-built-shell.mjs";
import {parseAuthConfig} from "../src/lib/authConfig.js";
import {getAccessToken} from "../src/lib/auth.js";
import {canonicalStudioRoutes} from "../scripts/application-route-inventory.mjs";
import {snapshotTree, sealManifest, writeJson} from "../scripts/release-utils.mjs";

test("built shell and pinned labels are independent explicit modes", () => {
  assert.deepEqual(integratedStudioShellMode([]), {built:false, pinnedFonts:false, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--built-studio"]), {built:true, pinnedFonts:false, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--pinned-map-fonts", "--built-studio"]), {built:true, pinnedFonts:true, restore:false});
  assert.deepEqual(integratedStudioShellMode(["--built-studio", "--restore-checkpoint"]), {built:true, pinnedFonts:false, restore:true});
  assert.equal(integratedStudioShellMode(["--built-studio", "--service-clients"]).serviceClients,true);
  assert.equal(integratedStudioShellMode(["--built-studio", "--wcs-only"]).wcsOnly,true);
  assert.equal(integratedStudioShellMode(["--built-studio", "--development"]).development,true);
  assert.throws(()=>integratedStudioShellMode(["--development"]));
  assert.throws(()=>integratedStudioShellMode(["--built-studio","--development","--service-clients"]));
  assert.throws(()=>integratedStudioShellMode(["--built-studio","--wcs-only","--service-clients"]));
  for (const args of [["--service-clients"], ["--restore-checkpoint"], ["--built-studio", "--built-studio"], ["--deploy"], ["anything"]]) {
    assert.throws(() => integratedStudioShellMode(args));
  }
});

test("local auth configuration uses the normal parser and cannot target a remote site", () => {
  const origin = "http://127.0.0.1:12345";
  const config = parseAuthConfig(integratedStudioAuthConfig(origin), {currentOrigin:origin});
  assert.equal(config.deployment.mode, "managed");
  assert.equal(config.redirectUri, `${origin}/login`);
  for (const unsafe of ["https://studio.opengeo.tools", "http://localhost:12345", `${origin}/path`, "http://user@127.0.0.1:12345"]) {
    assert.throws(() => integratedStudioAuthConfig(unsafe));
  }
});

test("synthetic session initialization preserves normal organization selection and sign out on reload", () => {
  const values = new Map();
  const sessionStorage = {getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, value), removeItem:key => values.delete(key)};
  const initialize = options => runInNewContext(`(${initializeIntegratedStudioSession})(${JSON.stringify(options)})`, {sessionStorage});
  initialize({organization:"owner-organization"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.owner");
  values.set("opengeo.organizationId", "deliberately-selected-organization");
  initialize({organization:"owner-organization"});
  assert.equal(values.get("opengeo.organizationId"), "deliberately-selected-organization");
  values.delete("opengeo.accessToken");
  initialize({organization:"owner-organization"});
  assert.equal(values.has("opengeo.accessToken"), false);
  initialize({organization:"owner-organization", actor:"reviewer"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.reviewer");
  assert.equal(values.has("opengeo.organizationId"), false);
  initialize({organization:"owner-organization"});
  assert.equal(getAccessToken(sessionStorage), "synthetic.local.reviewer");
});

test("synthetic sign-in never reads storage in isolated publication frames", () => {
  const frame = {top:{}};
  let reads = 0;
  const sandbox = {window:frame};
  Object.defineProperty(sandbox, "sessionStorage", {get() { reads++; throw new Error("Opaque origin"); }});
  runInNewContext(`(${initializeIntegratedStudioSession})({organization:'owner'})`, sandbox);
  assert.equal(reads, 0);
});

test("built transport requires exact sealed bytes and canonical routes, without page fallbacks", async () => {
  const work = await mkdtemp(join(tmpdir(), "opengeo-built-shell-test-"));
  try {
    const root = join(work, "built-studio/app/dist");
    await mkdir(root, {recursive:true});
    for (const [route, filename] of canonicalStudioRoutes) {
      await writeFile(join(root, filename), `<!doctype html><title>${route}</title>`);
    }
    const tree = await snapshotTree(root);
    const routes = canonicalStudioRoutes.map(([path, htmlPath]) => ({path, htmlPath,
      sha256:tree.files.find(file => file.path === htmlPath).sha256}));
    const manifestPath = join(work, "built-studio/dist/opengeo-studio-build.json");
    await writeJson(manifestPath, sealManifest({schemaVersion:"opengeo.studio-build.1.0.0", artifactTree:tree, routes}));
    const build = await loadIntegratedStudioBuild(work);
    assert.equal(build.files.get("/workspaces"), build.files.get("/workspaces.html"));
    assert.equal(build.files.get("/"), build.files.get("/index.html"));
    assert.equal(build.files.get("/missing"), undefined);
    assert.equal(build.files.get("/../studio-build.log"), undefined);
    assert.equal(build.files.get("/auth-config.json"), undefined);
    assert.equal(build.files.get("/workspaces").body.toString(), "<!doctype html><title>/workspaces</title>");
    await writeFile(join(root, "workspaces.html"), "replacement");
    await assert.rejects(loadIntegratedStudioBuild(work), /sealed artifact tree/);
    await writeJson(manifestPath, sealManifest({schemaVersion:"opengeo.studio-build.1.0.0", artifactTree:tree, routes:routes.slice(1)}));
    await assert.rejects(loadIntegratedStudioBuild(work));
  } finally {
    await rm(work, {recursive:true, force:true});
  }
});
