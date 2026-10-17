import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {readJson, verifyManifestSeal, verifyTree} from "./release-utils.mjs";
import {reviewedStudioOrigin} from "./studio-release-config.mjs";
import {canonicalStudioRoutes} from "./application-route-inventory.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const distRoot = resolve(appRoot, "dist");
const manifestPath = resolve(workspaceRoot, "dist/opengeo-studio-build.json");
const manifest = await readJson(manifestPath);
const studioOrigin = reviewedStudioOrigin();

verifyManifestSeal(manifest, "Studio build manifest");
if (manifest.schemaVersion !== "opengeo.studio-build.1.0.0"
  || manifest.studioOrigin !== studioOrigin
  || manifest.routes?.length !== canonicalStudioRoutes.length
  || manifest.aliases?.length !== canonicalStudioRoutes.length - 1) {
  throw new Error("Studio build manifest contract is invalid");
}
await verifyTree(distRoot, manifest.artifactTree, "Studio build");

const paths = new Set(manifest.routes.map(({path}) => path));
for (const required of ["/", "/login", "/public-demo", "/workspaces", "/library"]) {
  if (!paths.has(required)) throw new Error(`Studio build is missing ${required}`);
}
for (const publicOnly of ["/methods/", "/methods/sensitive-receptors", "/about/"]) {
  if (paths.has(publicOnly)) throw new Error(`Public-only route leaked into Studio: ${publicOnly}`);
}
const [studioHome, pwaManifestBody, serviceWorker, icon192, icon512] = await Promise.all([
  readFile(resolve(distRoot, "index.html"), "utf8"),
  readFile(resolve(distRoot, "manifest.webmanifest"), "utf8"),
  readFile(resolve(distRoot, "service-worker.js"), "utf8"),
  readFile(resolve(distRoot, "icons/opengeo-192.png")),
  readFile(resolve(distRoot, "icons/opengeo-512.png"))
]);
if (!/_observablehq\/theme-near-midnight,wide\.[0-9a-f]+\.css/.test(studioHome)
  || /_observablehq\/theme-air,/.test(studioHome)) {
  throw new Error("Studio does not use the single reviewed Observable near-midnight palette");
}
if (!studioHome.includes('manifest.href="/manifest.webmanifest"')
  || !studioHome.includes('navigator.serviceWorker.register("/service-worker.js"')) {
  throw new Error("Studio pages do not register the sealed PWA shell");
}
const pwaManifest = JSON.parse(pwaManifestBody);
if (pwaManifest.id !== "/"
  || pwaManifest.scope !== "/"
  || pwaManifest.start_url !== "/"
  || pwaManifest.display !== "standalone"
  || JSON.stringify(pwaManifest.icons?.map(({sizes}) => sizes)) !== JSON.stringify(["192x192", "512x512"])) {
  throw new Error("Studio web application manifest is incomplete");
}
for (const [label, icon] of [["192", icon192], ["512", icon512]]) {
  if (!icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Studio ${label}px PWA icon is not a PNG`);
  }
}
if (!serviceWorker.includes('const CAPTURE_SYNC_TAG = "opengeo-field-capture-v1"')
  || !serviceWorker.includes('request.headers.has("authorization")')
  || !serviceWorker.includes('url.pathname !== "/auth-config.json"')
  || serviceWorker.includes('"/auth-config.json",')
  || serviceWorker.includes('"/_file/data/')) {
  throw new Error("Studio service worker crossed the credential-free shell boundary");
}

const artifactFiles = new Map(manifest.artifactTree.files.map((file) => [file.path, file]));
for (const route of manifest.routes) {
  const artifact = artifactFiles.get(route.htmlPath);
  if (!artifact || artifact.bytes !== route.bytes || artifact.sha256 !== route.sha256) {
    throw new Error(`Studio route seal is invalid: ${route.path}`);
  }
}
for (const alias of manifest.aliases) {
  const artifact = artifactFiles.get(alias.sourcePath);
  if (!artifact || artifact.bytes !== alias.bytes || artifact.sha256 !== alias.sha256) {
    throw new Error(`Studio alias seal is invalid: ${alias.key}`);
  }
}

console.log(JSON.stringify({
  status: "passed",
  studioOrigin: manifest.studioOrigin,
  files: manifest.artifactTree.files.length,
  htmlPages: manifest.routes.length,
  aliases: manifest.aliases.length,
  pwa: {
    startUrl: pwaManifest.start_url,
    icons: pwaManifest.icons.length,
    backgroundSyncTag: "opengeo-field-capture-v1",
    credentialFreeShell: true
  },
  observableTheme: "near-midnight",
  treeDigest: manifest.artifactTree.digest
}, null, 2));
