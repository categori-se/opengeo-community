import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import {dirname, relative, resolve, sep} from "node:path";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertPublicArtifactBoundary(
  paths,
  label = "public release",
  {allowWorkbenchDemo = false} = {}
) {
  const forbiddenExact = new Set([
    "auth-config.json",
    "admin",
    "admin.html",
    "library",
    "library.html",
    "login",
    "login.html",
    "public-demo",
    "public-demo.html",
    "workspaces",
    "workspaces.html",
    "opengeo-unified-release.json",
    "opengeo-studio-build.json",
    "opengeo-studio-release.json"
  ]);
  const studioComponents = [
    "BasemapCapture",
    "DistanceToolbar",
    "ExportPanel",
    "FeatureCanvas",
    "LayoutCanvas",
    "LegendBox",
    "MapFrame",
    "MapView",
    "MarkdownSourceEditor",
    "MeasurementAnnotation",
    "NorthArrow",
    "PlatformDirectory",
    "PlotGeoLayer",
    "PrintStudio",
    "ProjectDatasets",
    "ProjectResources",
    "ProjectServices",
    "ProjectSites",
    "ProjectWorkspacePage",
    "PublicLibrary",
    "ScaleBar",
    "SessionPanel",
    "StartPage",
    "TeamAdministration",
    "TextBlock",
    "PublicDemoWorkbench",
    "WorkbenchView"
  ].join("|");
  const studioLibraries = [
    "apiClient",
    "auth",
    "authConfig",
    "basemapActivation",
    "basemapCatalog",
    "basemapGovernance",
    "basemapRuntimeHealth",
    "basemapSource",
    "catalog",
    "cognitoAuth",
    "fixturePlatform",
    "featureQuery",
    "geolibreImport",
    "geolibreProject",
    "geomooseMapbook",
    "governedIdentify",
    "portalConfiguration",
    "portalCatalog",
    "processingRegistry",
    "layerOrder",
    "mapDefinition",
    "mapLayers",
    "massgisDemo",
    "markdownSource",
    "offlineCapture",
    "platform",
    "printLayouts",
    "publicDemoProject",
    "publicationPolicy",
    "reviewedBasemapSources",
    "s3Urls",
    "spatialBody",
    "thematicStyle",
    "workbenchConfig",
    "workbenchStorage"
  ].join("|");
  const forbiddenPatterns = [
    /^workspaces\//,
    /^print\//,
    /^datasets\/dataset_(?:flood|public_basemap|roads|sites)_001(?:\.html)?$/,
    new RegExp(`^_import/components/(?:${studioComponents})\\.`),
    new RegExp(`^_import/lib/(?:${studioLibraries})\\.`),
    /^_file\/style\./,
    /^_file\/data\/(?:catalog|massgis-enviroscreen|public-demo-catalog|public-library|sample-)/,
    /^_file\/data\/massgis-massenviroscreen-.*\.geojson(?:\.[A-Za-z0-9_-]+)?\.gz$/
  ];
  const allowedDemoPatterns = allowWorkbenchDemo ? [
    /^public-demo(?:\.html)?$/,
    /^_import\/components\/(?:PublicDemoWorkbench|WorkbenchView)\.[A-Za-z0-9_-]+\.js$/,
    /^_import\/lib\/(?:basemapActivation|basemapCatalog|basemapGovernance|basemapRuntimeHealth|basemapSource|featureQuery|geolibreProject|geomooseMapbook|governedIdentify|printLayouts|portalConfiguration|portalCatalog|layerOrder|mapDefinition|mapLayers|massgisDemo|processingRegistry|publicDemoProject|publicationPolicy|reviewedBasemapSources|spatialBody|thematicStyle|workbenchConfig|workbenchStorage)\.[A-Za-z0-9_-]+\.js$/,
    /^_file\/style\.[A-Za-z0-9_-]+\.css$/,
    /^_file\/data\/(?:massgis-enviroscreen|public-demo-catalog|sample-public-facilities)\.[A-Za-z0-9_-]+\.(?:json|geojson)$/
  ] : [];
  const found = paths.filter((path) => {
    if (allowedDemoPatterns.some((pattern) => pattern.test(path))) return false;
    return forbiddenExact.has(path) || forbiddenPatterns.some((pattern) => pattern.test(path));
  });
  if (found.length) {
    throw new Error(`${label} contains Studio-only artifacts or routes: ${found.join(", ")}`);
  }
}

export async function mergeTree(sourceRoot, destinationRoot) {
  const files = await walkFiles(sourceRoot);
  for (const sourcePath of files) {
    const path = relativePath(sourceRoot, sourcePath);
    const destinationPath = safeJoin(destinationRoot, path);
    await mkdir(dirname(destinationPath), {recursive: true});
    try {
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const [source, destination] = await Promise.all([
        readFile(sourcePath),
        readFile(destinationPath)
      ]);
      if (!source.equals(destination)) {
        throw new Error(`Observable public build collision is not byte-identical: ${path}`);
      }
    }
  }
  return files.length;
}

export async function copyTree(sourceRoot, destinationRoot) {
  const files = await walkFiles(sourceRoot);
  for (const sourcePath of files) {
    const path = relativePath(sourceRoot, sourcePath);
    const destinationPath = safeJoin(destinationRoot, path);
    await mkdir(dirname(destinationPath), {recursive: true});
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  }
  return files.length;
}

export async function snapshotTree(root) {
  const files = await walkFiles(root);
  const records = [];
  for (const file of files) {
    const info = await stat(file);
    const body = await readFile(file);
    records.push({
      path: relativePath(root, file),
      bytes: info.size,
      sha256: sha256(body)
    });
  }
  return {
    algorithm: "sha256",
    digest: digestFileRecords(records),
    files: records
  };
}

export async function verifyTree(root, expected, label = "release tree") {
  if (expected?.algorithm !== "sha256"
    || !SHA256_PATTERN.test(expected?.digest ?? "")
    || !Array.isArray(expected?.files)) {
    throw new Error(`${label} manifest is invalid`);
  }
  const actual = await snapshotTree(root);
  if (actual.digest !== expected.digest
    || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
    throw new Error(`${label} no longer matches its sealed artifact tree`);
  }
  return actual;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sealManifest(payload) {
  return {
    ...payload,
    manifestSha256: sha256(canonicalJson(payload))
  };
}

export function verifyManifestSeal(manifest, label = "release manifest") {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${label} is invalid`);
  }
  const {manifestSha256, ...payload} = manifest;
  if (!SHA256_PATTERN.test(manifestSha256 ?? "")
    || sha256(canonicalJson(payload)) !== manifestSha256) {
    throw new Error(`${label} checksum is invalid`);
  }
  return manifest;
}

export function routeHtmlPath(route) {
  if (route === "/") return "index.html";
  if (!route.startsWith("/") || route.includes("\\") || route.includes("..")) {
    throw new Error(`Unsafe public route: ${route}`);
  }
  const path = route.slice(1);
  return route.endsWith("/") ? `${path}index.html` : `${path}.html`;
}

export function routeAliases(route) {
  if (route === "/") return [];
  const path = route.slice(1).replace(/\/$/, "");
  return route.endsWith("/") ? [path, `${path}/`] : [path];
}

export function safeJoin(root, path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Unsafe release path: ${path}`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe release path: ${path}`);
  }
  return target;
}

export function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function contentType(path) {
  if (path.endsWith(".html") || path.endsWith("/")) return "text/html; charset=utf-8";
  if (/\.m?js$/.test(path)) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json") || path.endsWith(".geojson")) {
    return "application/json; charset=utf-8";
  }
  if (path.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (path.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (path.endsWith(".gz")) return "application/gzip";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

export async function walkFiles(root) {
  const results = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      results.push(path);
    } else {
      throw new Error(`Release trees may contain only regular files: ${path}`);
    }
  }
  return results.sort();
}

export function digestFileRecords(records) {
  const digest = createHash("sha256");
  for (const record of records) {
    digest.update(record.path);
    digest.update("\0");
    digest.update(String(record.bytes));
    digest.update("\0");
    digest.update(record.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
