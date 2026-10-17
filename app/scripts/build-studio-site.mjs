import {prepareCesiumRuntime} from "./prepare-cesium-runtime.mjs";
import {prepareMapboxRuntime} from "./prepare-mapbox-runtime.mjs";
import {writeMaplibreExportAssets, prepareMapWorkerAsset} from "./build-maplibre-render-bundle.mjs";
import {spawnSync} from "node:child_process";
import {rm, readdir, readFile, mkdir, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {sealManifest, snapshotTree, writeJson} from "./release-utils.mjs";
import {reviewedStudioOrigin} from "./studio-release-config.mjs";
import {writeStudioPwaAssets} from "./studio-pwa-assets.mjs";
import {buildArchiveWorker} from "./build-archive-worker.mjs";
import {buildPublicationEditor} from "./build-publication-editor.mjs";
import {
  assertCanonicalStudioHtml,
  canonicalStudioRoutes
} from "./application-route-inventory.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const distRoot = resolve(appRoot, "dist");
const manifestPath = resolve(workspaceRoot, "dist/opengeo-studio-build.json");
const studioOrigin = reviewedStudioOrigin();
const expectedRoutes = canonicalStudioRoutes;

await rm(distRoot, {recursive: true, force: true});
await prepareMapWorkerAsset(resolve(appRoot, "src"));
runObservableBuild();
// Preserve the current deployed Studio shell while rebuilding recovered source.
for (const [, htmlPath] of expectedRoutes) {
  const path = resolve(distRoot, htmlPath);
  const html = await readFile(path, "utf8");
  if (!html.includes("<html>") || !html.includes("<body>")
    || !html.includes('<main id="observablehq-main"')) {
    throw Error(`Unexpected Studio shell structure: ${htmlPath}`);
  }
  await writeFile(path, html.replace("<html>", '<html lang="en">')
    .replace("<body>", '<body><a class="studio-skip-link" href="#observablehq-main">Skip to content</a>')
    .replace('<main id="observablehq-main"', '<main tabindex="-1" id="observablehq-main"'));
}
await buildPublicationEditor(distRoot);
await buildArchiveWorker(distRoot);
// Exported maps carry their own viewer, with no Studio or CDN runtime dependency.
await writeMaplibreExportAssets(distRoot);
await prepareMapboxRuntime(distRoot);
await prepareCesiumRuntime(distRoot);
await writeFile(resolve(distRoot, "third-party-notices.txt"), [
  "earcut · ISC",
  await readFile(resolve(appRoot, "node_modules/earcut/LICENSE"), "utf8"),
  "@categori/workspace-contracts · Apache-2.0",
  await readFile(resolve(appRoot, "vendor/workspace-contracts/LICENSE"), "utf8"),
  await readFile(resolve(appRoot, "vendor/workspace-contracts/NOTICE"), "utf8")
].join("\n\n"));
// Published articles pin immutable embed URLs. Keep reviewed previous versions
// across Studio releases so deploying a new component cannot break old articles.
const embedRoot = resolve(appRoot, "public-embeds");
for (const name of await readdir(embedRoot).catch(error => {if (error.code === "ENOENT") return []; throw error;})) {
  const match = /^imagery-lab\.([a-f0-9]{8})\.js$/.exec(name);
  if (!match) throw Error(`Unexpected retained embed: ${name}`);
  const bytes = await readFile(resolve(embedRoot, name));
  if (createHash("sha256").update(bytes).digest("hex").slice(0, 8) !== match[1]) throw Error(`Retained embed checksum mismatch: ${name}`);
  await mkdir(resolve(distRoot, "_file/assets"), {recursive: true});
  await writeFile(resolve(distRoot, "_file/assets", name), bytes);
}
const pwa = await writeStudioPwaAssets({
  outputRoot: distRoot,
  applicationId: "opengeo-production-studio",
  name: "OpenGeo Studio",
  description: "An open workspace for geospatial analysis and publishing.",
  startUrl: "/",
  routes: expectedRoutes.map(([path]) => path)
});
const artifactTree = await snapshotTree(distRoot);
const actualHtml = artifactTree.files
  .filter(({path}) => path.endsWith(".html") && path !== "offline.html")
  .map(({path}) => path)
  .sort();
assertCanonicalStudioHtml(actualHtml);
for (const retiredPublicPath of [
  "about/index.html",
  "methods/index.html",
  "methods/sensitive-receptors.html",
  "library/legacy-home.html"
]) {
  if (actualHtml.includes(retiredPublicPath)) {
    throw new Error(`Public publication leaked into the Studio build: ${retiredPublicPath}`);
  }
}

const files = new Map(artifactTree.files.map((file) => [file.path, file]));
const routes = expectedRoutes.map(([path, htmlPath]) => {
  const artifact = files.get(htmlPath);
  if (!artifact) throw new Error(`Studio route is missing: ${path}`);
  return {
    path,
    htmlPath,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    aliases: path === "/" ? [] : [path.slice(1)]
  };
});
const aliases = routes.flatMap((route) => route.aliases.map((key) => ({
  key,
  sourcePath: route.htmlPath,
  bytes: route.bytes,
  sha256: route.sha256,
  contentType: "text/html; charset=utf-8"
})));
const manifest = sealManifest({
  schemaVersion: "opengeo.studio-build.1.0.0",
  studioOrigin,
  framework: "@observablehq/framework@1.13.4",
  artifactTree,
  routes,
  aliases
});
await writeJson(manifestPath, manifest);

console.log(JSON.stringify({
  outputRoot: distRoot,
  manifestPath,
  files: artifactTree.files.length,
  htmlPages: routes.length,
  aliases: aliases.length,
  pwaCache: pwa.cacheName,
  pwaShellBytes: pwa.shellBytes,
  treeDigest: artifactTree.digest
}, null, 2));

function runObservableBuild() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, [
    "exec", "--", "observable", "build", "--config", "scripts/studio.observablehq.config.mjs"
  ], {
    cwd: appRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
