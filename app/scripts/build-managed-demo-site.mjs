import {prepareCesiumRuntime} from "./prepare-cesium-runtime.mjs";
import {writeThirdPartyNotices} from "./build-third-party-notices.mjs";
import {spawnSync} from "node:child_process";
import {prepareMapboxRuntime} from "./prepare-mapbox-runtime.mjs";
import {constants} from "node:fs";
import {copyFile, cp, mkdir, readFile, rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {sealManifest, sha256, snapshotTree, writeJson} from "./release-utils.mjs";
import {
  assertCanonicalStudioHtml,
  canonicalStudioRoutes
} from "./application-route-inventory.mjs";
import {writeStudioPwaAssets} from "./studio-pwa-assets.mjs";

const DEMO_ORIGIN = "https://demo.studio.opengeo.tools";
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const sourceRoot = resolve(appRoot, "dist/managed-demo-source");
const outputRoot = resolve(appRoot, "dist/managed-demo-build");
const releaseManifestPath = resolve(workspaceRoot, "dist/opengeo-managed-demo-release.json");
const expectedRoutes = canonicalStudioRoutes;

await Promise.all([
  rm(sourceRoot, {recursive: true, force: true}),
  rm(outputRoot, {recursive: true, force: true})
]);
await mkdir(sourceRoot, {recursive: true});
await cp(resolve(appRoot, "src"), sourceRoot, {
  recursive: true,
  filter: (path) => !path.includes("/.observablehq")
});
await cp(
  resolve(appRoot, "src/.observablehq/cache"),
  resolve(sourceRoot, ".observablehq/cache"),
  {recursive: true}
);
await copyFile(
  resolve(appRoot, "demo/index.md"),
  resolve(sourceRoot, "index.md"),
  constants.COPYFILE_FICLONE
);
try {
  runObservableBuild();
} finally {
  await rm(resolve(sourceRoot, ".observablehq"), {recursive: true, force: true});
}
await prepareMapboxRuntime(outputRoot);
await prepareCesiumRuntime(outputRoot);
await writeThirdPartyNotices({appRoot, outputRoot});
const pwa = await writeStudioPwaAssets({
  outputRoot,
  applicationId: "opengeo-managed-demo",
  name: "OpenGeo Studio public demo",
  description: "An isolated OpenGeo Studio geospatial workspace with published starter and MassGIS projects.",
  startUrl: "/",
  routes: expectedRoutes.map(([path]) => path)
});
run("render-auth-config.mjs", {OPEN_GEO_AUTH_CONFIG_OUTPUT_DIR: outputRoot});

const artifactTree = await snapshotTree(outputRoot);
const actualHtml = artifactTree.files
  .filter(({path}) => path.endsWith(".html") && path !== "offline.html")
  .map(({path}) => path)
  .sort();
assertCanonicalStudioHtml(actualHtml);
for (const [label, pattern] of [
  ["public workbench", /^_import\/components\/PublicDemoWorkbench\.[A-Za-z0-9_-]+\.js$/],
  ["managed API client", /^_import\/lib\/apiClient\.[A-Za-z0-9_-]+\.js$/],
  ["MassGIS configuration", /^_file\/data\/massgis-enviroscreen\.[A-Za-z0-9_-]+\.json$/]
]) {
  if (!artifactTree.files.some(({path}) => pattern.test(path))) {
    throw new Error(`Managed demo build is missing its reviewed ${label} artifact`);
  }
}
const rootHtml = await readFile(resolve(outputRoot, "index.html"), "utf8");
if (!rootHtml.includes("Public OpenGeo Studio workbench")
  || !rootHtml.includes("PublicDemoWorkbench")) {
  throw new Error("Managed demo root is not the bounded public workbench");
}

const files = new Map(artifactTree.files.map((file) => [file.path, file]));
const routes = expectedRoutes.map(([path, htmlPath]) => {
  const artifact = files.get(htmlPath);
  if (!artifact) throw new Error(`Managed demo route is missing: ${path}`);
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

const authArtifact = files.get("auth-config.json");
if (!authArtifact) throw new Error("Managed demo release is missing auth-config.json");
const authBytes = await readFile(resolve(outputRoot, "auth-config.json"));
if (authBytes.length !== authArtifact.bytes || sha256(authBytes) !== authArtifact.sha256) {
  throw new Error("Managed demo authentication configuration checksum is inconsistent");
}
const authConfig = parseAuthConfig(JSON.parse(authBytes.toString("utf8")), {
  currentOrigin: DEMO_ORIGIN
});
if (authConfig.version !== 2
  || authConfig.deployment.id !== "opengeo-demo"
  || authConfig.deployment.mode !== "demo"
  || !authConfig.deployment.publicSandbox.enabled
  || authConfig.deployment.publicSandbox.serverWrites
  || !authConfig.federation.some(({id, origin}) => (
    id === "opengeo-tools" && origin === "https://studio.opengeo.tools"
  ))) {
  throw new Error("Managed demo authentication and federation configuration is incomplete");
}

const configuration = await Promise.all([
  "app/observablehq.config.js",
  "app/scripts/managed-demo.observablehq.config.mjs",
  "app/package.json",
  "app/package-lock.json"
].map(async (path) => {
  const body = await readFile(resolve(workspaceRoot, path));
  return {path, bytes: body.length, sha256: sha256(body)};
}));
const manifest = sealManifest({
  schemaVersion: "opengeo.managed-demo-release.1.0.0",
  demoOrigin: DEMO_ORIGIN,
  framework: "@observablehq/framework@1.13.4",
  source: {kind: "managed-demo-single-build", configuration},
  authConfig: {
    path: "auth-config.json",
    bytes: authArtifact.bytes,
    sha256: authArtifact.sha256,
    cacheControl: "no-store",
    deploymentId: authConfig.deployment.id,
    clientId: authConfig.clientId
  },
  artifactTree,
  routes,
  aliases
});
await writeJson(releaseManifestPath, manifest);

console.log(JSON.stringify({
  status: "prepared",
  outputRoot,
  releaseManifestPath,
  files: artifactTree.files.length,
  routes: routes.length,
  aliases: aliases.length,
  pwaCache: pwa.cacheName,
  pwaShellBytes: pwa.shellBytes,
  authConfigSha256: authArtifact.sha256,
  treeDigest: artifactTree.digest
}, null, 2));

function runObservableBuild() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, [
    "exec", "--", "observable", "build", "--config", "scripts/managed-demo.observablehq.config.mjs"
  ], {cwd: appRoot, stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function run(script, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [resolve(appRoot, "scripts", script)], {
    cwd: appRoot,
    stdio: "inherit",
    env: {...process.env, ...extraEnvironment}
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
