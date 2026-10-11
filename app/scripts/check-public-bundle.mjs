import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {
  assertPublicArtifactBoundary,
  digestFileRecords,
  readJson,
  routeAliases,
  routeHtmlPath,
  sha256,
  verifyManifestSeal,
  verifyTree
} from "./release-utils.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const publicRoot = resolve(workspaceRoot, "dist/public");
const recoveredRoot = resolve(
  process.env.OPEN_GEO_PUBLIC_SOURCE_ROOT ?? "/home/aaron/framework/opengeo.tools"
);
const recoveredDistRoot = resolve(recoveredRoot, "dist");
const manifestPath = resolve(workspaceRoot, "dist/opengeo-public-bundle.json");
const auditPath = resolve(workspaceRoot, "docs/opengeo-tools-source-audit.json");

const [manifest, audit] = await Promise.all([readJson(manifestPath), readJson(auditPath)]);
verifyManifestSeal(manifest, "public bundle manifest");
if (manifest.schemaVersion === "opengeo.public-bundle.3.0.0") {
  const {checkComposedPublications} = await import("./compose-publications.mjs");
  await checkComposedPublications(workspaceRoot, manifest);
  process.exit(0);
}
if (manifest.schemaVersion !== "opengeo.public-bundle.2.0.0"
  || manifest.publicOrigin !== "https://opengeo.tools"
  || manifest.source?.recoveredOutputRebuilt !== false
  || manifest.routes?.length !== 28
  || manifest.aliases?.length !== 35) {
  throw new Error("Public bundle manifest contract is invalid");
}
if (manifest.source?.sourceAuditSha256 !== sha256(await readFile(auditPath))) {
  throw new Error("Public bundle source-audit checksum no longer matches");
}
await verifyTree(publicRoot, manifest.artifactTree, "public bundle");
assertPublicArtifactBoundary([
  ...manifest.artifactTree.files.map(({path}) => path),
  ...manifest.aliases.map(({key}) => key)
], "Public bundle", {allowWorkbenchDemo: true});

const auditedRoutes = [...audit.routes].map(({path}) => path).sort();
const manifestRoutes = manifest.routes
  .map(({path}) => path)
  .filter((path) => path !== "/public-demo")
  .sort();
if (audit?.routeComparison?.setsMatch !== true
  || JSON.stringify(auditedRoutes) !== JSON.stringify(manifestRoutes)) {
  throw new Error("Public bundle routes no longer match the recovered-source audit");
}
await verifyTree(
  recoveredDistRoot,
  manifest.source?.recoveredArtifactTree,
  "recovered public output"
);
const demoTree = manifest.source?.demoHandoff?.artifactTree;
if (manifest.source?.demoHandoff?.kind !== "observable-demo-handoff-publication"
  || !Array.isArray(manifest.source?.demoHandoff?.configuration)
  || !manifest.source?.demoHandoff?.sourceTree
  || !demoTree
  || !demoTree.files?.some(({path}) => path === "public-demo.html")) {
  throw new Error("Public bundle does not seal its isolated workbench demo");
}
const configurationPaths = manifest.source.demoHandoff.configuration.map(({path}) => path);
if (JSON.stringify(configurationPaths) !== JSON.stringify([
  "app/observablehq.config.js",
  "app/scripts/public-demo.observablehq.config.mjs",
  "app/package.json",
  "app/package-lock.json"
])) {
  throw new Error("Public workbench build configuration inventory is invalid");
}
for (const configuration of manifest.source.demoHandoff.configuration) {
  const body = await readFile(resolve(workspaceRoot, configuration.path));
  if (body.length !== configuration.bytes || sha256(body) !== configuration.sha256) {
    throw new Error(`Public workbench build configuration changed: ${configuration.path}`);
  }
}
const sourceTree = manifest.source.demoHandoff.sourceTree;
const expectedSourcePaths = [
  "public-demo.md",
  "style.css"
];
if (JSON.stringify(sourceTree.files?.map(({path}) => path)) !== JSON.stringify(expectedSourcePaths)
  || digestFileRecords(sourceTree.files) !== sourceTree.digest) {
  throw new Error("Public workbench source inventory is invalid");
}
for (const source of sourceTree.files) {
  const body = await readFile(resolve(appRoot, "src", source.path));
  if (body.length !== source.bytes || sha256(body) !== source.sha256) {
    throw new Error(`Public workbench source changed: ${source.path}`);
  }
}
if (digestFileRecords(demoTree.files) !== demoTree.digest) {
  throw new Error("Public workbench artifact tree digest is invalid");
}
if (demoTree.files.some(({path}) => /PublicDemoWorkbench|WorkbenchView|auth-config|apiClient/.test(path))) {
  throw new Error("Public demo handoff contains workbench or authenticated Studio code");
}
const publicFiles = new Map(manifest.artifactTree.files.map((file) => [file.path, file]));
for (const demoArtifact of demoTree.files) {
  const published = publicFiles.get(demoArtifact.path);
  if (published?.bytes !== demoArtifact.bytes || published?.sha256 !== demoArtifact.sha256) {
    throw new Error(`Public workbench artifact is absent from the public bundle: ${demoArtifact.path}`);
  }
}

const files = new Map(manifest.artifactTree.files.map((file) => [file.path, file]));
const expectedAliases = [];
for (const route of manifest.routes) {
  const expectedHtmlPath = routeHtmlPath(route.path);
  const artifact = files.get(expectedHtmlPath);
  if (!artifact
    || route.htmlPath !== expectedHtmlPath
    || route.sha256 !== artifact.sha256
    || route.bytes !== artifact.bytes
    || JSON.stringify(route.aliases) !== JSON.stringify(routeAliases(route.path))) {
    throw new Error(`Public route seal is invalid: ${route.path}`);
  }
  for (const key of route.aliases) {
    expectedAliases.push({
      key,
      sourcePath: route.htmlPath,
      bytes: route.bytes,
      sha256: route.sha256,
      contentType: "text/html; charset=utf-8"
    });
  }
}
if (JSON.stringify(manifest.aliases) !== JSON.stringify(expectedAliases)) {
  throw new Error("Public route alias manifest is incomplete or out of order");
}

for (const required of [
  ["/", "index.html"],
  ["/public-demo", "public-demo.html"],
  ["/methods/", "methods/index.html"],
  ["/methods/sensitive-receptors", "methods/sensitive-receptors.html"]
]) {
  const route = manifest.routes.find(({path}) => path === required[0]);
  if (route?.htmlPath !== required[1]) throw new Error(`Required public route is missing: ${required[0]}`);
}

for (const route of manifest.routes.filter(({path}) => path !== "/public-demo")) {
  const body = await readFile(resolve(publicRoot, route.htmlPath), "utf8");
  const studioLinks = body.match(/class="site-studio-link" href="https:\/\/studio\.opengeo\.tools\/"/g) ?? [];
  if (studioLinks.length !== 1 || !body.includes(">Open Studio</a>")) {
    throw new Error(`Public page is missing its exact Studio navigation handoff: ${route.path}`);
  }
}
const publicHome = await readFile(resolve(publicRoot, "index.html"), "utf8");
if (!publicHome.includes('class="site-studio-hero-link" href="https://studio.opengeo.tools/workspaces">Manage and publish in Studio</a>')) {
  throw new Error("Public home is missing its Studio publication-management action");
}
const publicationTheme = manifest.artifactTree.files.find(({path}) => (
  /^_import\/styles\/theme\.[0-9a-f]+\.css$/.test(path)
));
if (!publicationTheme
  || !(await readFile(resolve(publicRoot, publicationTheme.path), "utf8"))
    .includes(".site-primary-nav a.site-studio-link")) {
  throw new Error("Public publication theme is missing the Studio navigation treatment");
}

console.log(JSON.stringify({
  status: "passed",
  publicOrigin: manifest.publicOrigin,
  files: manifest.artifactTree.files.length,
  htmlPages: manifest.routes.length,
  aliases: manifest.aliases.length,
  studioNavigation: "passed",
  treeDigest: manifest.artifactTree.digest
}, null, 2));
