import {retainArtifactOutputs} from './artifact-output.mjs';
import {ARTIFACT_INVOCATION_SCHEMA, ARTIFACT_REQUEST_SCHEMA, artifactInputFiles, artifactChecksum, artifactJsonbText} from './artifact-inputs.mjs';
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createRequire} from 'node:module';
import {
  constants as fsConstants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import {dirname, join, relative, resolve, sep} from "node:path";
import {publicationFormat, PUBLICATION_CONFIG} from './publication-format.mjs';

export const FRAMEWORK_VERSION = "1.13.4";
export const INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.1.0.0";
export const DATA_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.2.0.0";
export const DISTRIBUTION_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.4.0.0";
export const DISTRIBUTION_REQUEST_SCHEMA = "opengeo.observable-build-request.3.0.0";
export const LOCALIZED_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.5.0.0";
export const LOCALIZED_REQUEST_SCHEMA = "opengeo.observable-build-request.4.0.0";
export const MAX_DATA_BYTES = 64 * 1024 * 1024;
export const REQUEST_SCHEMA = "opengeo.observable-build-request.1.0.0";
export const REPORT_SCHEMA = "opengeo.observable-compiler-report.1.0.0";
export const LOCALIZED_REPORT_SCHEMA = "opengeo.observable-compiler-report.2.0.0";
export const OUTPUT_MANIFEST_SCHEMA = "opengeo.observable-local-output.1.0.0";
const requireLocal = createRequire(import.meta.url);

export const isStaticHtmlEntry = path => typeof path === "string" && /(^|\/)index\.html$/.test(path);
export const isJupyterEntry = path => typeof path === "string" && /\.ipynb$/i.test(path);

const SOURCE_PATH =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const OUTPUT_PATH =
  /^dist\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}(?:\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}){0,7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_SEGMENT = /(^|\/)(node_modules|dist|build|cache|\.git|\.aws|\.ssh)(\/|$)/i;
// Output assets may legitimately include a package's dist/ directory (Leaflet
// CSS and marker images, for example). Source admission still rejects dist/.
// Match the database output contract; traversal and private directories remain
// excluded by the closed path grammar and these checks.
const OUTPUT_FORBIDDEN_SEGMENT = /(^|\/)(node_modules|build|cache|\.git|\.aws|\.ssh)(\/|$)/i;
const FORBIDDEN_NAME =
  /(^|\/)(\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i;

const SOURCE_MEDIA = new Map([
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".geojson", "application/geo+json"],
  [".json", "application/json"],
  [".ipynb", "application/x-ipynb+json"],
  [".csv", "text/csv"],
  [".txt", "text/plain"],
  [".html", "text/html"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"]
]);

const OUTPUT_MEDIA = new Map([
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".json", "application/json"],
  [".geojson", "application/geo+json"],
  [".csv", "text/csv"],
  [".txt", "text/plain"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".zip", "application/zip"]
]);

const INVOCATION_KEYS = [
  "buildJobId",
  "entryPath",
  "files",
  "inputManifestChecksumSha256",
  "lockfilePath",
  "request",
  "requestChecksumSha256",
  "schemaVersion"
];
const REQUEST_KEYS = [
  "compilerImageDigest",
  "frameworkVersion",
  "lockfileChecksumSha256",
  "lockfileFormat",
  "networkPolicy",
  "purpose",
  "resourceLimits",
  "schemaVersion",
  "sourceManifestChecksumSha256",
  "sourceProjectId",
  "sourceRevisionId",
  "sourceRevisionNumber"
];
const LIMIT_KEYS = [
  "cpuMillis",
  "maxInputBytes",
  "maxInputFiles",
  "maxOutputBytes",
  "maxOutputFiles",
  "memoryMiB",
  "timeoutSeconds"
];
const FILE_KEYS = ["checksumSha256", "contentType", "path", "sizeBytes"];

export class ObservableBuilderError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ObservableBuilderError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ObservableBuilderError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function extension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function sourcePathIsSafe(path) {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    SOURCE_PATH.test(path) &&
    !FORBIDDEN_SEGMENT.test(path) &&
    !FORBIDDEN_NAME.test(path)
  );
}

function outputPathIsSafe(path) {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    OUTPUT_PATH.test(path) &&
    !OUTPUT_FORBIDDEN_SEGMENT.test(path.slice("dist/".length)) &&
    !FORBIDDEN_NAME.test(path)
  );
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseRequest(request, withArtifacts = false, withDistribution = false, withLocalization = false, sourceOnly = false) {
  const keys = [...REQUEST_KEYS, ...(withArtifacts ? ["artifactInputsChecksumSha256"] : []),
    ...(withDistribution ? ["outputProfile", "sizeAcknowledgment", "distributionApprovalId", "distributionApprovalChecksumSha256"] : []),
    ...(withLocalization ? ['outputRepresentation'] : [])];
  exactKeys(request, keys.sort(), "request_shape_invalid");
  if (
    request.schemaVersion !== (withLocalization ? LOCALIZED_REQUEST_SCHEMA : withDistribution ? DISTRIBUTION_REQUEST_SCHEMA : withArtifacts ? ARTIFACT_REQUEST_SCHEMA : REQUEST_SCHEMA) ||
    (withLocalization && request.outputRepresentation !== 'single-html') ||
    (withArtifacts && !SHA256.test(request.artifactInputsChecksumSha256)) ||
    !UUID.test(request.sourceProjectId) ||
    !UUID.test(request.sourceRevisionId) ||
    !Number.isSafeInteger(request.sourceRevisionNumber) ||
    request.sourceRevisionNumber < 1 ||
    !SHA256.test(request.sourceManifestChecksumSha256) ||
    !["preview", "release_candidate"].includes(request.purpose) ||
    !IMAGE_DIGEST.test(request.compilerImageDigest) ||
    request.frameworkVersion !== FRAMEWORK_VERSION ||
    request.lockfileFormat !== "npm-package-lock-v3" ||
    (request.lockfileChecksumSha256 !== null && !SHA256.test(request.lockfileChecksumSha256)) ||
    request.networkPolicy !== "deny_all"
  ) {
    fail("request_contract_invalid");
  }
  exactKeys(request.resourceLimits, LIMIT_KEYS, "resource_limits_invalid");
  const limits = request.resourceLimits;
  boundedInteger(limits.cpuMillis, 250, 4000, "resource_limits_invalid");
  boundedInteger(limits.memoryMiB, 256, 8192, "resource_limits_invalid");
  boundedInteger(limits.timeoutSeconds, 10, 600, "resource_limits_invalid");
  boundedInteger(limits.maxInputFiles, 1, 128, "resource_limits_invalid");
  boundedInteger(limits.maxInputBytes, 1, 16 * 1024 * 1024, "resource_limits_invalid");
  boundedInteger(limits.maxOutputFiles, 1, 512, "resource_limits_invalid");
  boundedInteger(limits.maxOutputBytes, 1, 32 * 1024 * 1024, "resource_limits_invalid");
  if (withDistribution) {
    const expanded = request.outputProfile === "archive-96m";
    const approved = UUID.test(request.distributionApprovalId ?? "") && SHA256.test(request.distributionApprovalChecksumSha256 ?? "");
    const noApproval = request.distributionApprovalId === null && request.distributionApprovalChecksumSha256 === null;
    if (!["default-32m", "archive-96m"].includes(request.outputProfile)
      || request.sizeAcknowledgment !== (expanded ? "allow-up-to-96-mib-output" : null)
      || (request.purpose === "preview" || (withLocalization && sourceOnly && !expanded)
        ? !approved && !noApproval : !approved)) {
      fail("distribution_request_invalid");
    }
  }
  return request;
}

export function parseInvocation(value) {
  const withLocalization = value?.schemaVersion === LOCALIZED_INVOCATION_SCHEMA;
  const withDistribution = value?.schemaVersion === DISTRIBUTION_INVOCATION_SCHEMA || withLocalization;
  const withArtifacts = value?.schemaVersion === ARTIFACT_INVOCATION_SCHEMA || (withDistribution && Object.hasOwn(value, "artifactInputs"));
  const withData = value?.schemaVersion === DATA_INVOCATION_SCHEMA || withArtifacts || withDistribution;
  exactKeys(value, withArtifacts ? [...INVOCATION_KEYS, "dataFiles", "artifactInputs"].sort()
    : withData ? [...INVOCATION_KEYS, "dataFiles"].sort() : INVOCATION_KEYS, "invocation_shape_invalid");
  if (withLocalization && withArtifacts) fail('localized_artifact_inputs_unsupported');
  const sourceOnly = withLocalization && !withArtifacts && Array.isArray(value.dataFiles) && !value.dataFiles.length;
  const request = parseRequest(value.request, withArtifacts, withDistribution, withLocalization, sourceOnly);
  const artifactFiles = withArtifacts ? artifactInputFiles(value.artifactInputs, request, sourcePathIsSafe, fail) : [];
  if ((withArtifacts || withDistribution) && artifactChecksum(request) !== value.requestChecksumSha256) fail("artifact_request_checksum_mismatch");
  if (withData && !withDistribution && request.purpose !== "preview") fail("archive_publication_unauthorized");
  if (
    (!withData && value.schemaVersion !== INVOCATION_SCHEMA) ||
    !UUID.test(value.buildJobId) ||
    !SHA256.test(value.requestChecksumSha256) ||
    !SHA256.test(value.inputManifestChecksumSha256) ||
    value.inputManifestChecksumSha256 !== request.sourceManifestChecksumSha256 ||
    !sourcePathIsSafe(value.entryPath) ||
    (!value.entryPath.toLowerCase().endsWith(".md") && !isStaticHtmlEntry(value.entryPath) && !isJupyterEntry(value.entryPath)) ||
    (value.lockfilePath !== null && value.lockfilePath !== "package-lock.json") ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > request.resourceLimits.maxInputFiles
  ) {
    fail("invocation_contract_invalid");
  }
  let inputBytes = 0;
  const paths = [];
  for (const file of value.files) {
    exactKeys(file, FILE_KEYS, "input_manifest_invalid");
    if (
      !sourcePathIsSafe(file.path) ||
      (SOURCE_MEDIA.get(extension(file.path)) !== file.contentType && !(isJupyterEntry(file.path) && file.contentType === 'application/json')) ||
      !SHA256.test(file.checksumSha256)
    ) {
      fail("input_manifest_invalid");
    }
    boundedInteger(file.sizeBytes, 1, request.resourceLimits.maxInputBytes, "input_manifest_invalid");
    inputBytes += file.sizeBytes;
    paths.push(file.path);
  }
  if (
    inputBytes > request.resourceLimits.maxInputBytes ||
    paths.some((path, index) => index > 0 && path <= paths[index - 1]) ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
    !paths.includes(value.entryPath) ||
    (value.lockfilePath !== null && !paths.includes(value.lockfilePath)) ||
    (paths.includes("package.json") && value.lockfilePath !== "package-lock.json") ||
    (value.lockfilePath === null && request.lockfileChecksumSha256 !== null)
  ) {
    fail("input_manifest_invalid");
  }
  const dataFiles = withData ? value.dataFiles : [];
  if (!Array.isArray(dataFiles) || (withData && !withArtifacts && !dataFiles.length && !withLocalization)
    || value.files.length + dataFiles.length + artifactFiles.length > request.resourceLimits.maxInputFiles) fail("input_manifest_invalid");
  let dataBytes = 0;
  const dataPaths = [];
  for (const file of dataFiles) {
    exactKeys(file, FILE_KEYS, "input_manifest_invalid");
    const tiff = /\.tiff?$/i.test(file.path ?? "");
    const media = SOURCE_MEDIA.get(extension(file.path ?? ""));
    if (!sourcePathIsSafe(file.path) || !/\.(json|geojson|csv|txt|png|jpe?g|tiff?)$/i.test(file.path)
      || /(^|\/)(package\.json|package-lock\.json)$/i.test(file.path)
      || !(media === file.contentType || (/\.(geojson|json)$/i.test(file.path)
        && ["application/json", "application/geo+json"].includes(file.contentType))
        || (tiff && ["image/tiff", "image/geotiff"].includes(file.contentType)))
      || !SHA256.test(file.checksumSha256)) fail("input_manifest_invalid");
    boundedInteger(file.sizeBytes, 1, MAX_DATA_BYTES, "input_manifest_invalid");
    dataBytes += file.sizeBytes;
    dataPaths.push(file.path);
  }
  const artifactBytes = artifactFiles.reduce((total, file) => total + file.sizeBytes, 0);
  if (withArtifacts && inputBytes + artifactBytes + (withDistribution ? 0 : dataBytes) > request.resourceLimits.maxInputBytes) fail("input_manifest_invalid");
  if (withDistribution && request.outputProfile === "archive-96m" && !dataFiles.length) fail("distribution_request_invalid");
  const allPaths = [...paths, ...dataPaths, ...artifactFiles.map(file => file.path)].map(path => path.toLowerCase());
  if (dataBytes > MAX_DATA_BYTES || dataPaths.some((path, index) => index > 0 && path <= dataPaths[index - 1])
    || allPaths.some((path, index) => allPaths.slice(index + 1).some(other =>
      path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))) fail("input_manifest_invalid");
  if (withLocalization && sourceLayout(value).entryPath !== 'index.md') fail('localized_entry_invalid');
  return Object.freeze({...value, inputBytes: inputBytes + dataBytes + artifactBytes,
    allFiles: [...value.files, ...dataFiles, ...artifactFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)});
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("input_symlink_forbidden");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else fail("input_special_file_forbidden");
    }
  };
  visit(root);
  return files.sort();
}

function safeResolvedPath(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, ...path.split("/"));
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) fail("path_escape_forbidden");
  return absolutePath;
}

export function inspectInputs(invocation, inputRoot) {
  const parsed = parseInvocation(invocation);
  const expected = new Map(parsed.allFiles.map((file) => [file.path, file]));
  const observedPaths = walkFiles(inputRoot).map((path) => relative(resolve(inputRoot), path).split(sep).join("/"));
  if (
    observedPaths.length !== expected.size ||
    observedPaths.some((path) => !expected.has(path))
  ) {
    fail("input_tree_mismatch");
  }
  for (const [path, expectedFile] of expected) {
    const absolutePath = safeResolvedPath(inputRoot, path);
    readExactFile(absolutePath, expectedFile);
  }
  validateLockfile(parsed, inputRoot, expected);
  return parsed;
}

function readExactFile(path, expectedFile) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size !== expectedFile.sizeBytes) fail("input_file_mismatch");
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    bytes = readFileSync(descriptor);
  } finally {
    // readFileSync does not close caller-owned descriptors.
    closeSync(descriptor);
  }
  if (bytes.length !== expectedFile.sizeBytes || hash(bytes) !== expectedFile.checksumSha256) {
    fail("input_file_mismatch");
  }
  return bytes;
}

function validateLockfile(invocation, inputRoot, expected) {
  if (invocation.lockfilePath === null) return;
  const file = expected.get(invocation.lockfilePath);
  if (file.checksumSha256 !== invocation.request.lockfileChecksumSha256) {
    fail("lockfile_checksum_mismatch");
  }
  let lockfile;
  try {
    lockfile = JSON.parse(readFileSync(safeResolvedPath(inputRoot, invocation.lockfilePath), "utf8"));
  } catch {
    fail("lockfile_invalid");
  }
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages)) {
    fail("lockfile_invalid");
  }
  // This is preserved source metadata, not an installation plan. The build
  // invokes the pinned Framework CLI directly; it never runs npm install,
  // npm run, or lifecycle hooks from this lockfile or the source package.json.
  // In particular, older esbuild/fsevents hook metadata must not be confused
  // with a request to execute those hooks. Dependencies available at build time
  // remain the sealed compiler/cache; missing imports fail with networking off.
  for (const dependency of Object.values(lockfile.packages)) {
    if (!isRecord(dependency) || (dependency.hasInstallScript !== undefined &&
      typeof dependency.hasInstallScript !== 'boolean')) fail("lockfile_invalid");
  }
}

function sourceLayout(invocation) {
  // A complete Framework project retains its package/configuration beside src/.
  // Flat source revisions keep their existing route semantics. Never import or
  // execute the authored configuration to discover a filesystem path.
  const projectFolder = invocation.entryPath.startsWith("src/") &&
    (invocation.schemaVersion === "opengeo.observable-runner-invocation.5.0.0"
      || invocation.files.some(({path}) => path === "package.json"));
  return {
    root: projectFolder ? "src/src" : "src",
    entryPath: projectFolder ? invocation.entryPath.slice(4) : invocation.entryPath
  };
}

function presentationConfiguration(invocation, inputRoot) {
  const file = invocation.files.find(({path}) => path === "opengeo.observable.json");
  if (!file) return {};
  if (file.sizeBytes > 65_536) fail("presentation_configuration_invalid");
  let config;
  try {config = JSON.parse(readExactFile(safeResolvedPath(inputRoot, file.path), file));}
  catch {fail("presentation_configuration_invalid");}
  const invalid = () => fail("presentation_configuration_invalid");
  if (!isRecord(config) || config.schemaVersion !== "opengeo.observable-presentation.1.0.0" ||
      Object.keys(config).some(key => !["schemaVersion", "title", "pages", "theme"].includes(key))) invalid();
  const label = value => typeof value === "string" && value.trim().length > 0 &&
    value.length <= 300 && !/[<>\x00-\x1f\x7f]/.test(value);
  if (!label(config.title)) invalid();
  if (config.theme !== undefined && (!Array.isArray(config.theme) || config.theme.length < 1 ||
      config.theme.length > 2 || new Set(config.theme).size !== config.theme.length ||
      config.theme.some(theme => !["light", "dark"].includes(theme)))) invalid();
  const layout = sourceLayout(invocation);
  const routes = new Set(invocation.files.filter(({path}) => path.endsWith(".md") &&
    (layout.root !== "src/src" || path.startsWith("src/"))).map(({path}) => {
      const relativePath = (layout.root === "src/src" ? path.slice(4) : path).slice(0, -3);
      return relativePath === "index" ? "/" : `/${relativePath.replace(/\/index$/, "/")}`;
    }));
  const used = new Set(); let count = 0;
  function pages(values, depth = 0) {
    if (!Array.isArray(values) || !values.length || depth > 3) invalid();
    return values.map(page => {
      if (++count > 128 || !isRecord(page) || !label(page.name) ||
          Object.keys(page).some(key => !["name", "path", "pages"].includes(key))) invalid();
      if (Object.hasOwn(page, "pages")) {
        if (Object.hasOwn(page, "path")) invalid();
        return {name: page.name, pages: pages(page.pages, depth + 1)};
      }
      if (typeof page.path !== "string" || !routes.has(page.path) || used.has(page.path)) invalid();
      used.add(page.path);
      return {name: page.name, path: page.path};
    });
  }
  return {title: config.title, ...(config.theme ? {theme: config.theme} : {}),
    ...(config.pages === undefined ? {} : {pages: pages(config.pages), sidebar: true})};
}

function generatedConfig({root, entryPath}, presentation, sourceConfiguration = null) {
  if (sourceConfiguration) {
    // Only the isolated compiler opts into this path. The coordinator and
    // browser never import authored configuration. Keep output in the scanned
    // tree and require the configured page root to match the admitted layout.
    const expectedRoot = root === 'src' ? '.' : root.slice(4);
    return `import config from ${JSON.stringify('./src/' + sourceConfiguration)};\n` +
      `if (!config || typeof config !== "object" || Array.isArray(config)) throw Error("Framework configuration must export an object");\n` +
      `const sourceRoot = String(config.root ?? ${JSON.stringify(expectedRoot)}).replace(/^\\.\\//, "").replace(/\\/$/, "") || ".";\n` +
      `if (sourceRoot !== ${JSON.stringify(expectedRoot)}) throw Error("Framework configuration root does not match the selected source layout");\n` +
      // Output must work on exact-key S3 origins and in portable static copies;
      // retain authored source, but normalize links to the actual output files.
      `export default {...config, root: ${JSON.stringify(root)}, output: "dist", preserveIndex: true, preserveExtension: true};\n`;
  }
  const withoutExtension = entryPath.slice(0, -".md".length);
  const route = withoutExtension === "index" ? "/" : `/${withoutExtension.replace(/\/index$/, "/")}`;
  return `export default ${JSON.stringify({
    title: "OpenGeo private build",
    root,
    output: "dist",
    theme: "near-midnight",
    pages: [{name: "Preview", path: route}],
    sidebar: false,
    ...presentation,
    preserveIndex: true,
    preserveExtension: true,
    search: false,
    pager: false,
    footer: null,
    head: '<meta name="referrer" content="no-referrer">'
  })};\n`;
}

export function compilerEnvironment() {
  return Object.freeze({
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    OBSERVABLE_TELEMETRY_DISABLE: "true",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SOURCE_DATE_EPOCH: "0",
    TZ: "UTC"
  });
}

function assertEmptyWorkspace(workspaceRoot) {
  mkdirSync(workspaceRoot, {recursive: true, mode: 0o700});
  if (readdirSync(workspaceRoot).length !== 0) fail("workspace_not_empty");
}

function stageInputs(invocation, inputRoot, workspaceRoot, allowSourceConfiguration = false) {
  const sourceRoot = join(workspaceRoot, "src");
  mkdirSync(sourceRoot, {recursive: true, mode: 0o700});
  for (const file of invocation.allFiles) {
    const source = safeResolvedPath(inputRoot, file.path);
    const target = safeResolvedPath(sourceRoot, file.path);
    mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    writeFileSync(target, readExactFile(source, file), {flag: "wx", mode: 0o600});
    // SOURCE_DATE_EPOCH is fixed at zero for this compiler. A staging time is
    // not a source acquisition date and must not invalidate unchanged inputs.
    utimesSync(target, 0, 0);
  }
  const configPath = join(workspaceRoot, ".opengeo.observable.config.mjs");
  const configs = invocation.files.filter(file => ['observablehq.config.js','observablehq.config.mjs'].includes(file.path));
  if (allowSourceConfiguration && configs.length > 1) fail('framework_configuration_ambiguous');
  writeFileSync(configPath, generatedConfig(sourceLayout(invocation), presentationConfiguration(invocation, inputRoot),
    allowSourceConfiguration ? configs[0]?.path : null), {flag: "wx", mode: 0o600});
  return configPath;
}

function stageFrameworkCache(frameworkCacheRoot, workspaceRoot, invocation) {
  const targetRoot = join(workspaceRoot, sourceLayout(invocation).root, ".observablehq", "cache");
  mkdirSync(targetRoot, {recursive: true, mode: 0o700});
  const sourceRoot = resolve(frameworkCacheRoot);
  const copyDirectory = (sourceDirectory) => {
    for (const entry of readdirSync(sourceDirectory, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) fail("framework_cache_symlink_forbidden");
      const source = join(sourceDirectory, entry.name);
      const cachePath = relative(sourceRoot, source).split(sep).join("/");
      const target = safeResolvedPath(targetRoot, cachePath);
      if (entry.isDirectory()) {
        mkdirSync(target, {mode: 0o700});
        copyDirectory(source);
      } else if (entry.isFile()) {
        writeFileSync(target, readFileSync(source), {flag: "wx", mode: 0o600});
      } else {
        fail("framework_cache_special_file_forbidden");
      }
    }
  };
  copyDirectory(sourceRoot);
}

function contentType(path) {
  return OUTPUT_MEDIA.get(extension(path)) ?? "application/octet-stream";
}

function outputMediaMatches(path, type) {
  const expected = OUTPUT_MEDIA.get(extension(path));
  return expected === type || expected === "image/tiff" && type === "image/geotiff";
}

function routeForOutput(path) {
  if (path === "dist/index.html") return "/";
  if (!path.endsWith(".html")) return null;
  const value = path.slice("dist/".length, -".html".length);
  return value.endsWith("/index") ? `/${value.slice(0, -"index".length)}` : `/${value}`;
}

function normalizeThemeAssets(outputRoot, limits) {
  // Framework gives combined themes comma-bearing filenames. Keep the existing
  // closed storage/preview path contract; normalize just its known generated CSS
  // name and HTML hrefs before sealing any output hashes.
  const files = walkFiles(outputRoot);
  if (files.length > limits.maxOutputFiles) fail("output_file_limit_exceeded");
  const names = new Set(files.map(path => relative(outputRoot, path).split(sep).join("/").toLowerCase()));
  const renames = [];
  for (const path of files) {
    const name = relative(outputRoot, path).split(sep).join("/");
    if (!/^_observablehq\/theme-[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)+\.[a-f0-9]{8}\.css$/.test(name)) continue;
    const normalized = name.replaceAll(",", "-");
    if (names.has(normalized.toLowerCase())) fail("output_path_collision");
    renames.push([name, normalized]);
  }
  if (!renames.length) return;
  for (const path of files.filter(path => path.endsWith(".html"))) {
    if (lstatSync(path).size > 16 * 1024 * 1024) fail("output_file_limit_exceeded");
    let html = readFileSync(path, "utf8");
    for (const [from, to] of renames) html = html.replaceAll(from, to);
    writeFileSync(path, html);
  }
  for (const [from, to] of renames) renameSync(join(outputRoot, from), join(outputRoot, to));
}

export function inspectOutputs(outputRoot, limits, maximumFileBytes = 16 * 1024 * 1024, archivePins = []) {
  const files = [];
  let outputBytes = 0;
  const paths = walkFiles(outputRoot).map((path) => relative(dirname(outputRoot), path).split(sep).join("/"));
  if (paths.length < 1 || paths.length > limits.maxOutputFiles) fail("output_file_limit_exceeded");
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    fail("output_path_collision");
  }
  for (const path of paths) {
    if (!outputPathIsSafe(path)) fail("output_path_invalid");
    const absolutePath = safeResolvedPath(dirname(outputRoot), path);
    const size = lstatSync(absolutePath).size;
    if (size < 1 || size > Math.max(maximumFileBytes, archivePins.length ? MAX_DATA_BYTES : 0)) fail("output_file_limit_exceeded");
    const bytes = readFileSync(absolutePath);
    const checksumSha256 = hash(bytes);
    if (bytes.length < 1 || (bytes.length > maximumFileBytes && !archivePins.some(pin =>
      extension(pin.path) === extension(path) && pin.sizeBytes === bytes.length
      && pin.checksumSha256 === checksumSha256))) fail("output_file_limit_exceeded");
    outputBytes += bytes.length;
    if (outputBytes > limits.maxOutputBytes) fail("output_byte_limit_exceeded");
    files.push({
      path,
      contentType: contentType(path),
      sizeBytes: bytes.length,
      checksumSha256
    });
  }
  const outputTreeChecksumSha256 = hash(Buffer.from(JSON.stringify(files), "utf8"));
  const routeManifest = files
    .map((file) => ({path: routeForOutput(file.path), file: file.path}))
    .filter((route) => route.path !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (routeManifest.length > 128) fail("route_limit_exceeded");
  return {files, outputBytes, outputTreeChecksumSha256, routeManifest};
}

export function runBuild({
  invocation,
  inputRoot,
  workspaceRoot,
  observableCliPath,
  frameworkCacheRoot,
  incrementalPageCache,
  onCompilerFailure,
  allowSourceConfiguration = false,
  notebookAssetsPath = new URL('../notebook-assets.json', import.meta.url).pathname
}) {
  if (onCompilerFailure !== undefined && typeof onCompilerFailure !== 'function') fail('compiler_diagnostic_invalid');
  const parsed = inspectInputs(invocation, inputRoot);
  assertEmptyWorkspace(workspaceRoot);
  const staticHtml = isStaticHtmlEntry(parsed.entryPath);
  const jupyter = isJupyterEntry(parsed.entryPath);
  let format;
  try {format = publicationFormat(parsed.entryPath, parsed.allFiles, file => readExactFile(safeResolvedPath(inputRoot, file.path), file));}
  catch (error) {fail('publication_format_invalid', error.message);}
  if (format === 'notebook') {
    if (parsed.lockfilePath !== null) fail('notebook_lockfile_forbidden');
    const prefix = parsed.entryPath.slice(0, -'index.html'.length);
    const files = parsed.allFiles.map(file => {
      if (!file.path.startsWith(prefix)) fail('notebook_source_tree_invalid');
      const source = safeResolvedPath(workspaceRoot, `notebooks/${file.path}`);
      mkdirSync(dirname(source), {recursive: true, mode: 0o700});
      writeFileSync(source, readExactFile(safeResolvedPath(inputRoot, file.path), file), {flag: 'wx', mode: 0o600});
      return {...file, source};
    });
    const planPath = join(workspaceRoot, '.opengeo-notebook-plan.json');
    writeFileSync(planPath, JSON.stringify({entryPath: parsed.entryPath, files,
      source: files.find(file => file.path === parsed.entryPath).source, output: join(workspaceRoot, 'dist/index.html')}), {flag: 'wx', mode: 0o600});
    const execution = spawnSync(process.execPath,
      [new URL('./notebook-cli.mjs', import.meta.url).pathname, realpathSync(resolve(observableCliPath)), planPath, resolve(notebookAssetsPath)],
      {cwd: workspaceRoot, env: compilerEnvironment(), encoding: 'utf8', maxBuffer: 1024 * 1024,
        timeout: parsed.request.resourceLimits.timeoutSeconds * 1000, killSignal: 'SIGKILL'});
    if (execution.error?.code === 'ETIMEDOUT') fail('compiler_timeout');
    if (execution.error || execution.status !== 0 || execution.signal !== null) fail('compiler_failed', 'Observable Notebook compilation failed');
  } else if (jupyter) {
    if (parsed.lockfilePath !== null) fail("jupyter_lockfile_forbidden");
    const prefix = parsed.entryPath.includes('/') ? parsed.entryPath.slice(0, parsed.entryPath.lastIndexOf('/') + 1) : '';
    const plan = [], files = [], routes = new Set();
    for (const file of parsed.allFiles) {
      if (!file.path.startsWith(prefix)) fail("jupyter_source_tree_invalid");
      const source = safeResolvedPath(workspaceRoot, `notebooks/${file.path}`);
      mkdirSync(dirname(source), {recursive: true, mode: 0o700});
      writeFileSync(source, readExactFile(safeResolvedPath(inputRoot, file.path), file), {flag: 'wx', mode: 0o600});
      files.push({...file, source});
      // All native notebooks in the selected source directory are pages. Other
      // source files remain private; do not automatically publish the archive.
      if (!isJupyterEntry(file.path)) continue;
      const path = file.path === parsed.entryPath ? 'index.html' : file.path.slice(prefix.length).replace(/\.ipynb$/i, '.html');
      if (!outputPathIsSafe(`dist/${path}`) || routes.has(path.toLowerCase())) fail("jupyter_route_collision");
      routes.add(path.toLowerCase());
      plan.push({source, path: file.path, output: safeResolvedPath(workspaceRoot, `dist/${path}`)});
    }
    const planPath = join(workspaceRoot, '.opengeo-jupyter-plan.json');
    writeFileSync(planPath, JSON.stringify({pages: plan, files, sourceRoot: prefix.replace(/\/$/,'')}), {flag: 'wx', mode: 0o600});
    const execution = spawnSync(process.execPath,
      [new URL('./jupyter-cli.mjs', import.meta.url).pathname, realpathSync(resolve(observableCliPath)), planPath],
      {cwd: workspaceRoot, env: compilerEnvironment(), encoding: 'utf8', maxBuffer: 1024 * 1024,
        timeout: parsed.request.resourceLimits.timeoutSeconds * 1000, killSignal: 'SIGKILL'});
    if (execution.error?.code === 'ETIMEDOUT') fail('compiler_timeout');
    if (execution.error || execution.status !== 0 || execution.signal !== null) fail('compiler_failed', 'Jupyter saved-output rendering failed');
  } else if (staticHtml) {
    // A static publication is an explicit public tree, not a Framework wrapper.
    // Read exact verified bytes; never execute its JS or project configuration.
    const prefix = parsed.entryPath.slice(0, -"index.html".length);
    if (parsed.lockfilePath !== null) fail("static_html_lockfile_forbidden");
    for (const file of parsed.allFiles) {
      if (file.path === prefix + PUBLICATION_CONFIG) continue;
      const targetPath = `dist/${file.path.slice(prefix.length)}`;
      if (!file.path.startsWith(prefix) || !outputPathIsSafe(targetPath)
        || !outputMediaMatches(targetPath, file.contentType)
        || /(^|\/)(package(?:-lock)?\.json|observablehq\.config\.[cm]?js|opengeo\.observable\.json)$/i.test(file.path)) {
        fail("static_html_public_tree_invalid");
      }
      const target = safeResolvedPath(workspaceRoot, targetPath);
      if (file.path === parsed.entryPath && /<notebook(?:\s|>)/i.test(readExactFile(safeResolvedPath(inputRoot, file.path), file).toString('utf8'))) {
        fail('notebook_format_required', 'Select Observable Notebook before publishing native notebook source');
      }
      mkdirSync(dirname(target), {recursive: true, mode: 0o700});
      writeFileSync(target, readExactFile(safeResolvedPath(inputRoot, file.path), file), {flag: "wx", mode: 0o600});
    }
  } else {
  const configPath = stageInputs(parsed, inputRoot, workspaceRoot, allowSourceConfiguration);
  stageFrameworkCache(frameworkCacheRoot, workspaceRoot, parsed);
  const command = resolve(observableCliPath);
  let commandArgs = [command, "build", "--root", ".", "--config", configPath.slice(workspaceRoot.length + 1)];
  if (incrementalPageCache !== undefined) {
    const prior = incrementalPageCache?.body;
    const checksum = incrementalPageCache?.checksumSha256;
    if (!isRecord(incrementalPageCache)) fail("page_cache_input_invalid");
    const acceptedPrior = Buffer.isBuffer(prior) && prior.length <= 32 * 1024 * 1024 ? prior : null;
    if (acceptedPrior) writeFileSync(join(workspaceRoot, '.opengeo-page-cache-input.json'), acceptedPrior, {flag:'wx',mode:0o600});
    const scope = hash(JSON.stringify(['opengeo.framework-page-cache.1', parsed.request.sourceProjectId,
      parsed.request.compilerImageDigest, FRAMEWORK_VERSION, readFileSync(configPath,'utf8')]));
    const modulePath = join(dirname(dirname(realpathSync(command))), 'build.js');
    commandArgs = [new URL('./incremental-cli.mjs', import.meta.url).pathname, modulePath, configPath, scope,
      acceptedPrior && typeof checksum === 'string' ? checksum : ''];
  }
  const execution = spawnSync(
    process.execPath,
    commandArgs,
    {
      cwd: workspaceRoot,
      env: compilerEnvironment(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: parsed.request.resourceLimits.timeoutSeconds * 1000,
      killSignal: "SIGKILL"
    }
  );
  if (execution.error || execution.status !== 0 || execution.signal !== null) {
    const code = execution.error?.code === 'ETIMEDOUT' ? 'compiler_timeout' : 'compiler_failed';
    // Trusted host callers may retain bounded child diagnostics privately. This
    // callback is absent from request schemas and the public CLI/report; it must
    // never be connected to public logging or a source-controlled receipt.
    // Diagnostic retention failure cannot replace the sanitized builder error.
    if (onCompilerFailure) {
      try {onCompilerFailure(Object.freeze({code, status: execution.status, signal: execution.signal,
        error: execution.error ? Object.freeze({code: execution.error.code ?? null, message: execution.error.message}) : null,
        stdout: execution.stdout ?? '', stderr: execution.stderr ?? ''}));} catch {}
    }
    if (code === 'compiler_timeout') fail(code);
    fail("compiler_failed", "Observable Framework compilation failed");
  }
  normalizeThemeAssets(join(workspaceRoot, "dist"), parsed.request.resourceLimits);
  if (parsed.artifactInputs) retainArtifactOutputs({
    files: artifactInputFiles(parsed.artifactInputs, parsed.request, sourcePathIsSafe, fail), inputRoot, outputRoot: join(workspaceRoot, "dist"),
    prefix: sourceLayout(parsed).root === 'src/src' ? 'src/' : '', readExact: readExactFile
  });
  }
  const localized = parsed.schemaVersion === LOCALIZED_INVOCATION_SCHEMA;
  const distribution = parsed.schemaVersion === DISTRIBUTION_INVOCATION_SCHEMA || localized;
  const expanded = distribution && parsed.request.outputProfile === "archive-96m";
  const outputLimits = {...parsed.request.resourceLimits, ...(expanded ? {maxOutputBytes: 96 * 1024 * 1024} : {})};
  let output = inspectOutputs(join(workspaceRoot, "dist"), outputLimits,
    distribution ? Math.min(outputLimits.maxOutputBytes, 32 * 1024 * 1024)
      : parsed.schemaVersion === DATA_INVOCATION_SCHEMA ? parsed.request.resourceLimits.maxOutputBytes : 16 * 1024 * 1024,
    expanded ? parsed.dataFiles : []);
  let localizedOutput;
  if (localized) {
    // Load the DOM/AST postprocessor only for the explicit new representation.
    // Native Framework compilation, theme normalization and ordinary archive
    // file admission have already completed under their unchanged limits.
    const {localizeFrameworkOutput} = requireLocal('./framework-standalone.mjs');
    let result;
    try {
      result = localizeFrameworkOutput({files: output.files.map(file => ({...file,
        bytes: readExactFile(safeResolvedPath(workspaceRoot, file.path), file)})),
        maximumOutputBytes: expanded ? 96 * 1024 * 1024 : 32 * 1024 * 1024, archivePins: parsed.dataFiles});
    } catch (error) {fail('localized_output_invalid', error.message);}
    const bytes = Buffer.from(result.html);
    boundedInteger(bytes.length, 1, outputLimits.maxOutputBytes, 'localized_output_limit_exceeded');
    // This exception applies only to the newly generated, fixed HTML output.
    // inspectOutputs and generic file/tree limits are not widened.
    const file = {path: 'dist/index.html', contentType: 'text/html', sizeBytes: bytes.length, checksumSha256: hash(bytes)};
    const manifest = {...result.manifest, sourceOutputTreeChecksumSha256: output.outputTreeChecksumSha256, output: file};
    localizedOutput = {manifest, manifestChecksumSha256: artifactChecksum(manifest)};
    if (Buffer.byteLength(artifactJsonbText(localizedOutput)) > 262_144) fail('localized_manifest_limit_exceeded');
    const nativeOutputRoot = join(workspaceRoot, `.opengeo-native-output-${parsed.buildJobId}`);
    mkdirSync(nativeOutputRoot, {mode: 0o700});
    renameSync(join(workspaceRoot, 'dist'), join(nativeOutputRoot, 'dist'));
    mkdirSync(join(workspaceRoot, 'dist'), {mode: 0o700});
    writeFileSync(join(workspaceRoot, 'dist/index.html'), bytes, {flag: 'wx', mode: 0o600});
    readExactFile(join(workspaceRoot, 'dist/index.html'), file);
    output = {files: [file], outputBytes: bytes.length,
      outputTreeChecksumSha256: hash(Buffer.from(JSON.stringify([file]))), routeManifest: [{path: '/', file: 'dist/index.html'}]};
  }
  return {
    schemaVersion: localized ? LOCALIZED_REPORT_SCHEMA : REPORT_SCHEMA,
    ...(localized ? {localizedOutput} : {}),
    buildJobId: parsed.buildJobId,
    requestChecksumSha256: parsed.requestChecksumSha256,
    compilerImageDigest: parsed.request.compilerImageDigest,
    inputManifestChecksumSha256: parsed.inputManifestChecksumSha256,
    outputTreeChecksumSha256: output.outputTreeChecksumSha256,
    routeManifest: output.routeManifest,
    outputManifest: {schemaVersion: OUTPUT_MANIFEST_SCHEMA, files: output.files},
    validationReport: {
      frameworkVersion: FRAMEWORK_VERSION,
      entryPath: parsed.entryPath,
      lockfileVerified: parsed.lockfilePath !== null,
      fixedBuilderConfig: true,
      prewarmedFrameworkCache: !staticHtml && !jupyter,
      inputFileCount: parsed.allFiles.length,
      inputBytes: parsed.inputBytes,
      outputFileCount: output.files.length,
      outputBytes: output.outputBytes,
      publicationAuthorized: false
    }
  };
}

export function writeReport(path, report) {
  mkdirSync(dirname(resolve(path)), {recursive: true, mode: 0o700});
  writeFileSync(resolve(path), `${JSON.stringify(report)}\n`, {flag: "wx", mode: 0o600});
}
