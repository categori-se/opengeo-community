import {existsSync, readFileSync, statSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {assertPrivateLocalBoundary, resolveNpmLockPackage} from "./npm-lock-resolution.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = resolve(root, "governance/open-source-foundations.json");
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return null;
  }
}

function repoPath(path, label) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("..")) {
    errors.push(`${label} must be a safe repository-relative path`);
    return null;
  }
  const target = resolve(root, path);
  if (!target.startsWith(`${root}/`) || !existsSync(target)) {
    errors.push(`${label} does not exist: ${path}`);
    return null;
  }
  return target;
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("not HTTPS");
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL`);
  }
}

function normalizedPackageName(name) {
  return name.toLowerCase().replace(/[_.]+/g, "-");
}

function parsePythonDependencies(path) {
  const text = readFileSync(path, "utf8");
  const projectStart = text.indexOf("[project]");
  const dependenciesStart = text.indexOf("dependencies = [", projectStart);
  if (projectStart < 0 || dependenciesStart < 0) {
    errors.push(`${path}: missing [project] dependencies array`);
    return [];
  }
  const bodyStart = text.indexOf("[", dependenciesStart) + 1;
  const bodyEnd = text.indexOf("\n]", bodyStart);
  if (bodyEnd < 0) {
    errors.push(`${path}: unterminated dependencies array`);
    return [];
  }
  const dependencies = [];
  for (const match of text.slice(bodyStart, bodyEnd).matchAll(/"([^"]+)"/g)) {
    const requirement = match[1];
    const parsed = requirement.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?==([^;\s]+)$/);
    if (!parsed) {
      errors.push(`${path}: direct dependency must use an exact == version: ${requirement}`);
      continue;
    }
    dependencies.push({name: parsed[1], version: parsed[2], kind: "runtime"});
  }
  return dependencies;
}

const inventory = readJson(inventoryPath);
if (!inventory) process.exit(1);

if (inventory.schemaVersion !== "1.0.0") errors.push("inventory.schemaVersion must be 1.0.0");
if (!/^\d{4}-\d{2}-\d{2}$/.test(inventory.reviewedAt ?? "")) {
  errors.push("inventory.reviewedAt must be an ISO date");
}
if (typeof inventory.reviewScope !== "string" || inventory.reviewScope.length < 20) {
  errors.push("inventory.reviewScope must describe what the historical review date establishes");
}
if (!Array.isArray(inventory.manifests) || !inventory.manifests.length) {
  errors.push("inventory.manifests must be a non-empty array");
}
if (!Array.isArray(inventory.packages) || !inventory.packages.length) {
  errors.push("inventory.packages must be a non-empty array");
}

const declared = new Map();

for (const [index, manifest] of (inventory.manifests ?? []).entries()) {
  const label = `inventory.manifests[${index}]`;
  const path = repoPath(manifest, label);
  if (!path || !statSync(path).isFile()) continue;
  if (manifest.endsWith("package.json")) {
    const packageJson = readJson(path);
    if (!packageJson) continue;
    const lockRelative = `${dirname(manifest)}/package-lock.json`.replace(/^\.\//, "");
    const lockPath = resolve(root, lockRelative);
    const lock = existsSync(lockPath) ? readJson(lockPath) : null;
    for (const [kind, values] of Object.entries({runtime: packageJson.dependencies, development: packageJson.devDependencies})) {
      for (const name of Object.keys(values ?? {})) {
        const key = `npm:${name}`;
        const item = declared.get(key) ?? {ecosystem: "npm", name, manifests: new Set(), kinds: new Set(), versions: new Map(), locks: new Map()};
        item.manifests.add(manifest);
        item.kinds.add(kind);
        let locked;
        try {locked = resolveNpmLockPackage({root, manifest, lock, name, specifier: values[name]});}
        catch (error) {errors.push(`${manifest}: ${name}: ${error.message}`);}
        item.locks.set(manifest, locked);
        if (!locked?.version) errors.push(`${manifest}: ${name} has no resolved package-lock entry`);
        else item.versions.set(manifest, locked.version);
        declared.set(key, item);
      }
    }
  } else if (manifest.endsWith("pyproject.toml")) {
    for (const dependency of parsePythonDependencies(path)) {
      const normalized = normalizedPackageName(dependency.name);
      const key = `pypi:${normalized}`;
      const item = declared.get(key) ?? {
        ecosystem: "pypi",
        name: dependency.name,
        manifests: new Set(),
        kinds: new Set(),
        versions: new Map()
      };
      item.manifests.add(manifest);
      item.kinds.add(dependency.kind);
      item.versions.set(manifest, dependency.version);
      declared.set(key, item);
    }
  } else {
    errors.push(`${label} is not a supported package.json or pyproject.toml manifest`);
  }
}

const inventoried = new Map();
for (const [index, item] of (inventory.packages ?? []).entries()) {
  const label = `inventory.packages[${index}]`;
  if (!["npm", "pypi"].includes(item.ecosystem)) errors.push(`${label}.ecosystem is invalid`);
  if (typeof item.name !== "string" || !item.name) errors.push(`${label}.name is required`);
  const packageName = item.ecosystem === "pypi" ? normalizedPackageName(item.name ?? "") : item.name;
  const key = `${item.ecosystem}:${packageName}`;
  if (inventoried.has(key)) errors.push(`${label} duplicates ${key}`);
  inventoried.set(key, item);
  if (!/^\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(item.version ?? "")) {
    errors.push(`${label}.version must be exact`);
  }
  if (!["runtime", "development"].includes(item.dependencyKind)) {
    errors.push(`${label}.dependencyKind is invalid`);
  }
  if (!Array.isArray(item.usedBy) || !item.usedBy.length) errors.push(`${label}.usedBy is required`);
  for (const [usedIndex, usedBy] of (item.usedBy ?? []).entries()) repoPath(usedBy, `${label}.usedBy[${usedIndex}]`);
  if (typeof item.purpose !== "string" || item.purpose.length < 10) errors.push(`${label}.purpose is too short`);
  if (typeof item.licenseExpression !== "string" || item.licenseExpression.length < 2) {
    errors.push(`${label}.licenseExpression is required`);
  }
  const privateLocal = item.licenseEvidence?.kind === "private-local-package";
  if (privateLocal) {
    repoPath(item.sourcePath, `${label}.sourcePath`);
    if (item.ecosystem !== "npm" ||
        item.distributionStatus !== "private-pending-release-review") {
      errors.push(`${label}: private local packages must retain their private release boundary`);
    }
  } else httpsUrl(item.sourceUrl, `${label}.sourceUrl`);
  if (!item.licenseEvidence || typeof item.licenseEvidence !== "object") {
    errors.push(`${label}.licenseEvidence is required`);
  } else if (["package-lock", "private-local-package"].includes(item.licenseEvidence.kind)) {
    if (!Array.isArray(item.licenseEvidence.paths) || !item.licenseEvidence.paths.length) {
      errors.push(`${label}.licenseEvidence.paths is required`);
    }
    for (const [pathIndex, path] of (item.licenseEvidence.paths ?? []).entries()) {
      repoPath(path, `${label}.licenseEvidence.paths[${pathIndex}]`);
    }
  } else if (item.licenseEvidence.kind === "package-metadata") {
    httpsUrl(item.licenseEvidence.url, `${label}.licenseEvidence.url`);
    if (item.licenseEvidence.reviewedAt !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(item.licenseEvidence.reviewedAt)) {
      errors.push(`${label}.licenseEvidence.reviewedAt must be an ISO date`);
    }
  } else {
    errors.push(`${label}.licenseEvidence.kind is invalid`);
  }
}

for (const [key, dependency] of declared) {
  const item = inventoried.get(key);
  if (!item) {
    errors.push(`missing direct dependency inventory entry: ${key}`);
    continue;
  }
  const expectedManifests = [...dependency.manifests].sort();
  const actualManifests = [...new Set(item.usedBy)].sort();
  if (JSON.stringify(expectedManifests) !== JSON.stringify(actualManifests)) {
    errors.push(`${key}.usedBy must equal declared manifests: ${expectedManifests.join(", ")}`);
  }
  const versions = new Set(dependency.versions.values());
  if (versions.size !== 1 || !versions.has(item.version)) {
    errors.push(`${key}.version ${item.version} does not match resolved/declared versions: ${[...versions].join(", ")}`);
  }
  if (dependency.ecosystem === "npm") {
    for (const manifest of dependency.manifests) {
      const locked = dependency.locks.get(manifest);
      if (item.licenseEvidence?.kind === "private-local-package") {
        try {assertPrivateLocalBoundary(locked, item);}
        catch (error) {errors.push(`${key}: ${error.message}`);}
      } else if (locked?.license !== item.licenseExpression) {
        errors.push(`${key}.licenseExpression ${item.licenseExpression} does not match ${manifest} lock metadata ${locked?.license ?? "missing"}`);
      }
    }
  }
}

for (const key of inventoried.keys()) {
  if (!declared.has(key)) errors.push(`stale package inventory entry is not directly declared: ${key}`);
}

for (const section of ["platformFoundations", "referenceProducts"]) {
  if (!Array.isArray(inventory[section]) || !inventory[section].length) {
    errors.push(`inventory.${section} must be a non-empty array`);
    continue;
  }
  const names = new Set();
  for (const [index, item] of inventory[section].entries()) {
    const label = `inventory.${section}[${index}]`;
    if (names.has(item.name)) errors.push(`${label}.name is duplicated`);
    names.add(item.name);
    if (typeof item.name !== "string" || !item.name) errors.push(`${label}.name is required`);
    if (typeof item.version !== "string" || !item.version) errors.push(`${label}.version is required`);
    if (typeof item.licenseExpression !== "string" || !item.licenseExpression) {
      errors.push(`${label}.licenseExpression is required`);
    }
    httpsUrl(item.sourceUrl, `${label}.sourceUrl`);
    if (section === "platformFoundations") {
      httpsUrl(item.licenseEvidenceUrl, `${label}.licenseEvidenceUrl`);
      for (const [usedIndex, usedBy] of (item.usedBy ?? []).entries()) repoPath(usedBy, `${label}.usedBy[${usedIndex}]`);
    } else {
      repoPath(item.licenseEvidencePath, `${label}.licenseEvidencePath`);
    }
  }
}

// Readable summaries use the same source identities as the register. Match only
// direct-package tables: a reference-product row cannot cover a runtime package.
const readablePath = repoPath("docs/open-source-foundations.md", "readable foundation inventory");
if (readablePath) {
  const readable = readFileSync(readablePath, "utf8");
  const directSections = readable.match(/## Browser And JavaScript Foundations\n([\s\S]*?)\n## Runtime And Toolchain Foundations/);
  if (!directSections) errors.push("readable foundation inventory is missing direct-package sections");
  const rows = new Map();
  for (const line of (directSections?.[1] ?? "").split("\n")) {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    const source = cells[0]?.match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1];
    if (!source) continue;
    if (rows.has(source)) errors.push(`readable foundation inventory duplicates package source: ${source}`);
    rows.set(source, cells);
  }
  const expectedSources = new Set();
  for (const item of inventory.packages ?? []) {
    const key = `${item.ecosystem}:${item.name}`;
    const source = item.sourceUrl ?? `../${item.sourcePath}`;
    expectedSources.add(source);
    const row = rows.get(source);
    if (!row) errors.push(`readable foundation inventory is missing direct package: ${key}`);
    else {
      if (row[1] !== item.version) errors.push(`readable foundation inventory has stale version for ${key}: expected ${item.version}`);
      if (!row[3]?.includes(item.licenseExpression)) errors.push(`readable foundation inventory has stale license for ${key}: expected ${item.licenseExpression}`);
    }
  }
  for (const source of rows.keys()) {
    if (!expectedSources.has(source)) errors.push(`readable foundation inventory has an unregistered direct package: ${source}`);
  }
}

const communityLicensingPath = repoPath("docs/community-licensing.md", "community licensing guide");
if (communityLicensingPath) {
  const guide = readFileSync(communityLicensingPath, "utf8");
  const counts = guide.match(/contains (\d+) direct packages, (\d+) platform foundations\s+and (\d+) reference products/);
  const expectedCounts = [inventory.packages?.length, inventory.platformFoundations?.length, inventory.referenceProducts?.length];
  if (!counts || counts.slice(1).some((count, index) => Number(count) !== expectedCounts[index])) {
    errors.push(`community licensing guide has stale inventory counts: expected ${expectedCounts.join("/")}`);
  }
}

if (errors.length) {
  console.error("Open-source foundation inventory validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Open-source foundation inventory coverage passed: ${inventory.packages.length} direct packages, ` +
  `${inventory.platformFoundations.length} platform foundations, and ` +
  `${inventory.referenceProducts.length} source-audited references. ` +
  `${inventory.packages.filter(item => item.licenseEvidence?.kind === "private-local-package").length} private package(s) retaining registry publication boundaries. ` +
  `This consistency check does not approve release artifact licensing.`
);
