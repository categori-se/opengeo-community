import {spawnSync} from "node:child_process";
import {constants, existsSync} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {
  assertPublicArtifactBoundary,
  copyTree,
  mergeTree,
  readJson,
  routeAliases,
  routeHtmlPath,
  sealManifest,
  sha256,
  snapshotTree,
  writeJson
} from "./release-utils.mjs";

import {composePublications} from "./compose-publications.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
if (process.argv.includes("--maintained") || (!process.argv.includes("--legacy")
  && existsSync(resolve(workspaceRoot, "publications/main-site/observablehq.config.js")))) {
  console.log(JSON.stringify(await composePublications(workspaceRoot), null, 2));
  process.exit(0);
}

const recoveredRoot = resolve(
  process.env.OPEN_GEO_PUBLIC_SOURCE_ROOT ?? "/home/aaron/framework/opengeo.tools"
);
const recoveredDistRoot = resolve(recoveredRoot, "dist");
const demoSourceRoot = resolve(appRoot, "dist/public-demo-source");
const demoDistRoot = resolve(appRoot, "dist/public-demo-build");
const outputRoot = resolve(workspaceRoot, "dist/public");
const manifestPath = resolve(workspaceRoot, "dist/opengeo-public-bundle.json");
const auditPath = resolve(workspaceRoot, "docs/opengeo-tools-source-audit.json");
const studioOrigin = "https://studio.opengeo.tools";

const [audit, sourceTree] = await Promise.all([
  readJson(auditPath),
  snapshotTree(recoveredDistRoot)
]);
assertPublicArtifactBoundary(
  sourceTree.files.map(({path}) => path),
  "Recovered public output"
);
const routes = validateAudit(audit);
const expectedHtml = routes.map(({path}) => routeHtmlPath(path)).sort();
const actualHtml = sourceTree.files
  .filter(({path}) => path.endsWith(".html"))
  .map(({path}) => path)
  .sort();
if (JSON.stringify(actualHtml) !== JSON.stringify(expectedHtml)) {
  throw new Error("Recovered Observable output does not contain exactly the audited 27 HTML pages");
}

await Promise.all([
  rm(demoSourceRoot, {recursive: true, force: true}),
  rm(demoDistRoot, {recursive: true, force: true})
]);
await stagePublicDemoSource();
const demoSourceTree = await snapshotTree(demoSourceRoot);
const sharedCacheRoot = resolve(appRoot, "src/.observablehq/cache");
const demoCacheRoot = resolve(demoSourceRoot, ".observablehq/cache");
await copyDirectoryStructure(sharedCacheRoot, demoCacheRoot);
await copyTree(sharedCacheRoot, demoCacheRoot);
try {
  runPublicDemoBuild();
} finally {
  await rm(resolve(demoSourceRoot, ".observablehq"), {recursive: true, force: true});
}
const demoTree = await snapshotTree(demoDistRoot);
const demoHtml = demoTree.files
  .filter(({path}) => path.endsWith(".html"))
  .map(({path}) => path);
if (JSON.stringify(demoHtml) !== JSON.stringify(["public-demo.html"])) {
  throw new Error("The isolated public demo build must contain exactly public-demo.html");
}
assertPublicArtifactBoundary(
  demoTree.files.map(({path}) => path),
  "Isolated public workbench demo",
  {allowWorkbenchDemo: true}
);

await rm(outputRoot, {recursive: true, force: true});
await copyTree(recoveredDistRoot, outputRoot);
await mergeTree(demoDistRoot, outputRoot);
const publicationCorrections = [
  ...await applyPublishedCorrections(outputRoot),
  ...await applyStudioNavigation(outputRoot, routes)
];
const artifactTree = await snapshotTree(outputRoot);
assertPublicArtifactBoundary(
  artifactTree.files.map(({path}) => path),
  "Composed public bundle",
  {allowWorkbenchDemo: true}
);

const filesByPath = new Map(artifactTree.files.map((file) => [file.path, file]));
const occupiedKeys = new Set(filesByPath.keys());
const aliasKeys = new Set();
const routeManifest = [];
const aliases = [];
for (const route of [...routes, {name: "Public Workbench Demo", path: "/public-demo"}]
  .sort((left, right) => left.path.localeCompare(right.path))) {
  const htmlPath = routeHtmlPath(route.path);
  const artifact = filesByPath.get(htmlPath);
  if (!artifact) throw new Error(`Audited public route is missing its artifact: ${route.path}`);
  const keys = routeAliases(route.path);
  routeManifest.push({
    path: route.path,
    htmlPath,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    aliases: keys
  });
  for (const key of keys) {
    if (occupiedKeys.has(key) || aliasKeys.has(key)) {
      throw new Error(`Public route alias collides with another release object: ${key}`);
    }
    aliasKeys.add(key);
    aliases.push({
      key,
      sourcePath: htmlPath,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      contentType: "text/html; charset=utf-8"
    });
  }
}

const auditBytes = await readFile(auditPath);
const correctionScript = await readFile(fileURLToPath(import.meta.url));
const demoConfiguration = await Promise.all([
  "app/observablehq.config.js",
  "app/scripts/public-demo.observablehq.config.mjs",
  "app/package.json",
  "app/package-lock.json"
].map(async (path) => {
  const body = await readFile(resolve(workspaceRoot, path));
  return {path, bytes: body.length, sha256: sha256(body)};
}));
const manifest = sealManifest({
  schemaVersion: "opengeo.public-bundle.2.0.0",
  publicOrigin: "https://opengeo.tools",
  source: {
    kind: "composed-observable-publication",
    framework: "@observablehq/framework@1.13.4",
    sourceAuditPath: "docs/opengeo-tools-source-audit.json",
    sourceAuditSha256: sha256(auditBytes),
    recoveredOutputRebuilt: false,
    recoveredArtifactTree: sourceTree,
    publicationCorrection: {
      reason: "Correct recovered map rendering and add a visible, audited handoff from every publication page to OpenGeo Studio.",
      script: {
        path: "app/scripts/build-public-site.mjs",
        bytes: correctionScript.length,
        sha256: sha256(correctionScript)
      },
      files: publicationCorrections
    },
    demoHandoff: {
      kind: "observable-demo-handoff-publication",
      configPath: "app/scripts/public-demo.observablehq.config.mjs",
      configuration: demoConfiguration,
      sourceTree: demoSourceTree,
      artifactTree: demoTree
    }
  },
  artifactTree,
  routes: routeManifest,
  aliases
});
await writeJson(manifestPath, manifest);

console.log(JSON.stringify({
  outputRoot,
  manifestPath,
  files: artifactTree.files.length,
  htmlPages: routeManifest.length,
  aliases: aliases.length,
  treeDigest: artifactTree.digest,
  recoveredSourceWasModified: false,
  demoHandoffBuilt: true
}, null, 2));

async function applyPublishedCorrections(root) {
  const corrections = [
    {
      path: "toolkit/visualization/maplibre.html",
      reason: "Insert the direct MapLibre container into the rendered article.",
      replacements: [
        [
          'inputs: ["html","maplibregl","mapWater","mapCoastline","mapRoads","mapPowerLines","mapPowerPoints","mapAmenities","mapPlaceLabels","visibleMapLibreLayers","popupTable","temaneExtent","invalidation"], outputs:',
          'inputs: ["html","maplibregl","mapWater","mapCoastline","mapRoads","mapPowerLines","mapPowerPoints","mapAmenities","mapPlaceLabels","visibleMapLibreLayers","popupTable","temaneExtent","invalidation","display"], outputs:'
        ],
        [
          'body: (html,maplibregl,mapWater,mapCoastline,mapRoads,mapPowerLines,mapPowerPoints,mapAmenities,mapPlaceLabels,visibleMapLibreLayers,popupTable,temaneExtent,invalidation) => {',
          'body: (html,maplibregl,mapWater,mapCoastline,mapRoads,mapPowerLines,mapPowerPoints,mapAmenities,mapPlaceLabels,visibleMapLibreLayers,popupTable,temaneExtent,invalidation,display) => {'
        ],
        [
          '\nmaplibreContainer\nreturn {maplibreContainer,mapTarget,map};',
          '\ndisplay(maplibreContainer);\nconst mapResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => map.resize()) : null;\nmapResizeObserver?.observe(mapTarget);\nglobalThis.requestAnimationFrame?.(() => map.resize());\ninvalidation.then(() => mapResizeObserver?.disconnect());\nreturn {maplibreContainer,mapTarget,map};'
        ]
      ]
    },
    {
      path: "datasets/protected-areas.html",
      reason: "Insert the direct WDPA MapLibre container into the rendered article.",
      replacements: [
        [
          'inputs: ["html","maplibregl","wdpaVectorTiles","FeatureService","wdpaFeatureService","invalidation"], outputs:',
          'inputs: ["html","maplibregl","wdpaVectorTiles","FeatureService","wdpaFeatureService","invalidation","display"], outputs:'
        ],
        [
          'body: (html,maplibregl,wdpaVectorTiles,FeatureService,wdpaFeatureService,invalidation) => {',
          'body: (html,maplibregl,wdpaVectorTiles,FeatureService,wdpaFeatureService,invalidation,display) => {'
        ],
        [
          '\nwdpaMapContainer\nreturn {wdpaMapContainer,wdpaMapTarget,wdpaMap};',
          '\ndisplay(wdpaMapContainer);\nconst wdpaResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => wdpaMap.resize()) : null;\nwdpaResizeObserver?.observe(wdpaMapTarget);\nglobalThis.requestAnimationFrame?.(() => wdpaMap.resize());\ninvalidation.then(() => wdpaResizeObserver?.disconnect());\nreturn {wdpaMapContainer,wdpaMapTarget,wdpaMap};'
        ]
      ]
    },
    {
      path: "field-labs/maplibre-live-demo.html",
      reason: "Display the MapLibre wrapper returned by the shared renderer.",
      replacements: [
        [
          'inputs: ["liveLayers","popupTable","renderMapLibreMap","invalidation","demoRoads","demoWater","demoPower","demoAmenities"], outputs:',
          'inputs: ["liveLayers","popupTable","renderMapLibreMap","invalidation","demoRoads","demoWater","demoPower","demoAmenities","display"], outputs:'
        ],
        [
          'body: async (liveLayers,popupTable,renderMapLibreMap,invalidation,demoRoads,demoWater,demoPower,demoAmenities) => {',
          'body: async (liveLayers,popupTable,renderMapLibreMap,invalidation,demoRoads,demoWater,demoPower,demoAmenities,display) => {'
        ],
        ["\nawait renderMapLibreMap({", "\ndisplay(await renderMapLibreMap({"],
        ["\n})\nreturn {labLayers};", "\n}));\nreturn {labLayers};"]
      ]
    },
    {
      path: "_import/components/geo.61fc2bcb.js",
      reason: "Resize shared MapLibre maps after their detached wrapper is inserted and whenever its frame changes.",
      replacements: [
        [
          '  if (invalidation) invalidation.then(() => map.remove());\n  return wrapper;',
          '  let resizeObserver = null;\n  const resize = () => map.resize();\n  globalThis.requestAnimationFrame?.(resize);\n  if (typeof ResizeObserver === "function") {\n    resizeObserver = new ResizeObserver(resize);\n    resizeObserver.observe(container);\n  }\n  if (invalidation) invalidation.then(() => {\n    resizeObserver?.disconnect();\n    map.remove();\n  });\n  return wrapper;'
        ]
      ]
    }
  ];

  const evidence = [];
  for (const correction of corrections) {
    const target = resolve(root, correction.path);
    const before = await readFile(target, "utf8");
    let after = before;
    for (const [needle, replacement] of correction.replacements) {
      if (after.split(needle).length !== 2) {
        throw new Error(`Publication correction expected exactly one match in ${correction.path}`);
      }
      after = after.replace(needle, replacement);
    }
    if (after === before) throw new Error(`Publication correction made no change to ${correction.path}`);
    await writeFile(target, after, "utf8");
    evidence.push({
      path: correction.path,
      reason: correction.reason,
      beforeSha256: sha256(before),
      afterSha256: sha256(after)
    });
  }
  return evidence;
}

async function applyStudioNavigation(root, routes) {
  const evidence = [];
  const navigationLink = `\n          <a class="site-studio-link" href="${studioOrigin}/">Open Studio</a>`;
  const navigationMarker = "\n        </nav>";

  for (const route of routes) {
    const path = routeHtmlPath(route.path);
    const target = resolve(root, path);
    const before = await readFile(target, "utf8");
    if (before.split(navigationMarker).length !== 2 || before.includes("site-studio-link")) {
      throw new Error(`Studio navigation expected exactly one unmodified public header in ${path}`);
    }
    let after = before.replace(navigationMarker, `${navigationLink}${navigationMarker}`);
    if (route.path === "/") {
      const heroMarker = '    <a href="./projects/index.html">See project cases</a>';
      if (after.split(heroMarker).length !== 2) {
        throw new Error("Studio navigation expected exactly one public-home hero action group");
      }
      after = after.replace(
        heroMarker,
        `${heroMarker}\n    <a class="site-studio-hero-link" href="${studioOrigin}/workspaces">Manage and publish in Studio</a>`
      );
    }
    await writeFile(target, after, "utf8");
    evidence.push({
      path,
      reason: "Link the published Observable page back to its OpenGeo Studio workbench.",
      beforeSha256: sha256(before),
      afterSha256: sha256(after)
    });
  }

  const stylesRoot = resolve(root, "_import/styles");
  const themeFiles = (await readdir(stylesRoot))
    .filter((name) => /^theme\.[0-9a-f]+\.css$/.test(name));
  if (themeFiles.length !== 1) {
    throw new Error("Studio navigation expected exactly one recovered publication theme stylesheet");
  }
  const stylePath = `_import/styles/${themeFiles[0]}`;
  const styleTarget = resolve(root, stylePath);
  const styleBefore = await readFile(styleTarget, "utf8");
  if (styleBefore.includes("site-studio-link")) {
    throw new Error("Recovered publication theme already contains Studio navigation styling");
  }
  const styleAfter = `${styleBefore}\n.site-primary-nav a.site-studio-link{border:1px solid var(--og-accent);background:var(--og-accent-soft);color:var(--og-text)}.site-primary-nav a.site-studio-link:hover{background:color-mix(in srgb,var(--og-accent) 24%,transparent);color:var(--og-text)}\n`;
  await writeFile(styleTarget, styleAfter, "utf8");
  evidence.push({
    path: stylePath,
    reason: "Present the Studio handoff as the distinct product action in the public header.",
    beforeSha256: sha256(styleBefore),
    afterSha256: sha256(styleAfter)
  });

  return evidence;
}

function runPublicDemoBuild() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, [
    "exec", "--", "observable", "build", "--config", "scripts/public-demo.observablehq.config.mjs"
  ], {
    cwd: appRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function stagePublicDemoSource() {
  const paths = [
    "public-demo.md",
    "style.css"
  ];
  for (const path of paths) {
    const source = resolve(appRoot, "src", path);
    const destination = resolve(demoSourceRoot, path);
    await mkdir(dirname(destination), {recursive: true});
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

async function copyDirectoryStructure(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, {recursive: true});
  for (const entry of await readdir(sourceRoot, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      await copyDirectoryStructure(
        resolve(sourceRoot, entry.name),
        resolve(destinationRoot, entry.name)
      );
    }
  }
}

function validateAudit(value) {
  if (value?.routeComparison?.setsMatch !== true
    || value?.routeComparison?.sourceMarkdownPages !== 27
    || value?.routeComparison?.existingDistHtmlPages !== 27
    || !Array.isArray(value.routes)
    || value.routes.length !== 27) {
    throw new Error("The recovered-source audit does not seal the expected 27 public routes");
  }
  const paths = new Set();
  for (const route of value.routes) {
    if (typeof route?.path !== "string" || paths.has(route.path)) {
      throw new Error("The recovered-source audit contains an invalid or duplicate route");
    }
    paths.add(route.path);
  }
  return [...value.routes].sort((left, right) => left.path.localeCompare(right.path));
}
