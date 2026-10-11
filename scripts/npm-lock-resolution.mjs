import {readFileSync, realpathSync} from "node:fs";
import {dirname, relative, resolve, sep} from "node:path";

export function resolveNpmLockPackage({root, manifest, lock, name, specifier}) {
  const entry = lock?.packages?.[`node_modules/${name}`];
  if (!entry?.link) return entry;
  if (typeof entry.resolved !== "string" || typeof specifier !== "string" || !specifier.startsWith("file:")) {
    throw new Error("local package link requires a file dependency and resolved target");
  }
  const base = resolve(root, dirname(manifest));
  const target = resolve(base, entry.resolved);
  if (target !== resolve(base, specifier.slice(5)) || !target.startsWith(root + sep)) {
    throw new Error("local package link differs from its declared in-repository target");
  }
  const actual = realpathSync(target);
  const metadataPath = realpathSync(resolve(target, "package.json"));
  if (!actual.startsWith(root + sep) || !metadataPath.startsWith(actual + sep)) {
    throw new Error("local package link or metadata escapes the repository");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const locked = lock.packages[entry.resolved];
  if (!locked?.version || locked.link || locked.name !== name || metadata.name !== name ||
      metadata.version !== locked.version || metadata.license !== locked.license) {
    throw new Error("local package identity, version or license differs from lock metadata");
  }
  return {...locked, localPackageJson: metadata, localSourcePath: relative(root, target),
    localPackageJsonPath: relative(root, metadataPath)};
}

export function assertPrivateLocalBoundary(locked, item) {
  if (!locked?.localPackageJson || locked.localPackageJson.private !== true ||
      (locked.localPackageJson.license ?? "NOASSERTION") !== (item.licenseExpression ?? "NOASSERTION") ||
      locked.localSourcePath !== item.sourcePath ||
      !item.licenseEvidence.paths?.includes(locked.localPackageJsonPath)) {
    throw new Error("private boundary must match the resolved local package, declared license and evidence");
  }
}
