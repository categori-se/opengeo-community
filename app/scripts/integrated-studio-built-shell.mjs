import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {extname, join} from "node:path";
import {verifyManifestSeal, verifyTree} from "./release-utils.mjs";
import {canonicalStudioRoutes} from "./application-route-inventory.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const types = {".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css",
  ".json":"application/json", ".webmanifest":"application/manifest+json", ".png":"image/png",
  ".svg":"image/svg+xml", ".pbf":"application/x-protobuf", ".woff2":"font/woff2", ".txt":"text/plain"};

export function integratedStudioShellMode(args) {
  const supported = new Set(["--pinned-map-fonts", "--built-studio", "--restore-checkpoint", "--service-clients", "--wcs-only", "--analysis-only", "--development", "--publication-only"]);
  assert.ok(args.every(arg => supported.has(arg)) && new Set(args).size === args.length,
    "Only unique pinned-font, built-Studio, restore-checkpoint and service-clients flags are supported");
  assert.ok(!args.includes("--restore-checkpoint") || args.includes("--built-studio"), "Restoration requires the built application");
  assert.ok(!args.includes("--service-clients") || args.includes("--built-studio"), "Service clients require the built application");
  assert.ok(!args.includes("--wcs-only") || (args.includes("--built-studio") && !args.some(arg=>["--restore-checkpoint","--pinned-map-fonts","--service-clients"].includes(arg))), "WCS-only requires built Studio without other journey modes");
  assert.ok(!args.includes("--analysis-only") || (args.includes("--built-studio") && args.length === 2), "Analysis-only requires only built Studio");
  assert.ok(!args.includes("--development") || (args.includes("--built-studio") && args.length === 2), "Development requires only built Studio");
  return {built:args.includes("--built-studio"), pinnedFonts:args.includes("--pinned-map-fonts"), restore:args.includes("--restore-checkpoint"),
    ...(args.includes("--service-clients") ? {serviceClients:true} : {}),
    ...(args.includes("--wcs-only") ? {wcsOnly:true} : {}),
    ...(args.includes("--analysis-only") ? {analysisOnly:true} : {}),
    ...(args.includes("--publication-only") ? {publicationOnly:true} : {}),
    ...(args.includes("--development") ? {development:true} : {})};
}

// Serve only exact files and route aliases from the maintained builder's seal.
// No HTML/module rewriting, fixture adapter, fallback page or external proxy.
export async function loadIntegratedStudioBuild(work) {
  const bytes = await readFile(join(work, "built-studio/dist/opengeo-studio-build.json"));
  const manifest = JSON.parse(bytes);
  verifyManifestSeal(manifest);
  assert.equal(manifest.schemaVersion, "opengeo.studio-build.1.0.0");
  assert.deepEqual(manifest.routes.map(route => [route.path, route.htmlPath]), canonicalStudioRoutes);
  const root = join(work, "built-studio/app/dist");
  await verifyTree(root, manifest.artifactTree);
  const files = new Map();
  for (const file of manifest.artifactTree.files) {
    assert.ok(!file.path.split("/").some(part => ["", ".", ".."].includes(part)));
    const body = await readFile(join(root, file.path));
    assert.equal(digest(body), file.sha256);
    files.set(`/${file.path}`, {body, sha256:file.sha256, contentType:types[extname(file.path)] ?? "application/octet-stream"});
  }
  for (const route of manifest.routes) {
    const file = files.get(`/${route.htmlPath}`);
    assert.equal(file?.sha256, route.sha256);
    files.set(route.path, file);
  }
  return {files, evidence:{mode:"observable-built-studio", manifestSha256:digest(bytes),
    treeDigest:manifest.artifactTree.digest, files:manifest.artifactTree.files.length,
    routes:manifest.routes.map(route => route.path), unchangedBuiltBytes:true,
    serviceWorkers:"registration script withheld by the local server; separate PWA checks own offline behavior"}};
}

export function integratedStudioAuthConfig(origin) {
  const url = new URL(origin);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.origin, origin);
  return {version:1, region:"us-east-1", userPoolId:"us-east-1_LocalAcceptance",
    clientId:"localacceptancepublicclient", hostedUiBaseUrl:origin,
    redirectUri:`${origin}/login`, logoutUri:`${origin}/login`, scopes:["openid", "email", "profile"]};
}

// Browser session substitution only. Production auth storage, adapter selection,
// membership resolution and all API authorization still run unchanged.
export function initializeIntegratedStudioSession({organization, actor = null, origin = null}) {
  if (origin && globalThis.location?.origin !== origin) return;
  // Publication previews deliberately have opaque origins. Never seed a frame
  // or weaken its sandbox merely to install a synthetic top-level session.
  if (globalThis.window && window.top !== window) return;
  if (actor) sessionStorage.setItem("local-actor", actor);
  const selectedActor = sessionStorage.getItem("local-actor") || "owner";
  if (sessionStorage.getItem("opengeo.localAcceptanceActor") === selectedActor) return;
  sessionStorage.setItem("opengeo.localAcceptanceActor", selectedActor);
  sessionStorage.setItem("opengeo.accessToken", `synthetic.local.${selectedActor}`);
  sessionStorage.setItem("opengeo.accessTokenExpiresAt", String(Date.now() + 3_600_000));
  sessionStorage.removeItem("opengeo.organizationId");
  if (selectedActor === "owner") sessionStorage.setItem("opengeo.organizationId", organization);
}
