import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {assertPrivateLocalBoundary, resolveNpmLockPackage} from "./npm-lock-resolution.mjs";

function fixture(run) {
  const parent = mkdtempSync(join(tmpdir(), "opengeo-npm-lock-")), root = join(parent, "repo");
  const target = join(root, "app/vendor/contracts");
  mkdirSync(target, {recursive: true});
  const metadata = {name: "@categori/contracts", version: "0.1.0-alpha.8", private: true};
  writeFileSync(join(target, "package.json"), JSON.stringify(metadata));
  const input = {root, manifest: "app/package.json", name: metadata.name,
    specifier: "file:vendor/contracts", lock: {packages: {
      "node_modules/@categori/contracts": {link: true, resolved: "vendor/contracts"},
      "vendor/contracts": {...metadata}
    }}};
  try {run({input, parent, target, metadata});} finally {rmSync(parent, {recursive: true, force: true});}
}

test("registry package version and license remain unchanged", () => {
  const entry = {version: "1.2.3", license: "MIT"};
  assert.equal(resolveNpmLockPackage({lock: {packages: {"node_modules/regular": entry}}, name: "regular"}), entry);
});
test("local link resolves actual private version without inventing a license", () => fixture(({input}) => {
  const result = resolveNpmLockPackage(input);
  assert.equal(result.version, "0.1.0-alpha.8");
  assert.equal(result.license, undefined);
  assert.equal(result.localPackageJson.private, true);
  assert.equal(result.localSourcePath, "app/vendor/contracts");
}));
test("link cannot redirect a different declared dependency", () => fixture(({input}) => {
  input.specifier = "file:vendor/different";
  assert.throws(() => resolveNpmLockPackage(input), /differs from its declared/);
}));
test("local target cannot traverse outside the repository", () => fixture(({input}) => {
  input.specifier = "file:../../outside";
  input.lock.packages["node_modules/@categori/contracts"].resolved = "../../outside";
  assert.throws(() => resolveNpmLockPackage(input), /in-repository target/);
}));
test("repository symlink cannot expose external metadata", () => fixture(({input, parent, target, metadata}) => {
  const outside = join(parent, "outside");mkdirSync(outside);
  writeFileSync(join(outside, "package.json"), JSON.stringify(metadata));
  rmSync(target, {recursive: true});symlinkSync(outside, target);
  assert.throws(() => resolveNpmLockPackage(input), /escapes the repository/);
}));
test("local version and license drift require a lock review", () => fixture(({input, target, metadata}) => {
  writeFileSync(join(target, "package.json"), JSON.stringify({...metadata, version: "0.1.0-alpha.9"}));
  assert.throws(() => resolveNpmLockPackage(input), /differs from lock metadata/);
  writeFileSync(join(target, "package.json"), JSON.stringify({...metadata, license: "MIT"}));
  assert.throws(() => resolveNpmLockPackage(input), /differs from lock metadata/);
}));
test("published packages and mismatched licenses cannot use the private boundary", () => fixture(({input}) => {
  const locked = resolveNpmLockPackage(input), item = {sourcePath: locked.localSourcePath,
    licenseEvidence: {paths: [locked.localPackageJsonPath]}};
  assertPrivateLocalBoundary(locked, item);
  for (const metadata of [{...locked.localPackageJson, private: false}, {...locked.localPackageJson, license: "MIT"}]) {
    assert.throws(() => assertPrivateLocalBoundary({...locked, localPackageJson: metadata}, item), /private boundary/);
  }
}));
test("an explicitly licensed private source matches lock and inventory without authorizing registry publication", () => fixture(({input, target, metadata}) => {
  writeFileSync(join(target, "package.json"), JSON.stringify({...metadata, license: "Apache-2.0"}));
  input.lock.packages["vendor/contracts"].license = "Apache-2.0";
  const locked = resolveNpmLockPackage(input), item = {sourcePath: locked.localSourcePath,
    licenseExpression: "Apache-2.0", licenseEvidence: {paths: [locked.localPackageJsonPath]}};
  assertPrivateLocalBoundary(locked, item);
  assert.throws(() => assertPrivateLocalBoundary(locked, {...item, licenseExpression: "MIT"}), /declared license/);
  assert.throws(() => assertPrivateLocalBoundary({...locked, localPackageJson: {...locked.localPackageJson, private: false}}, item), /private boundary/);
}));
test("private package evidence must identify the actual resolved metadata", () => fixture(({input}) => {
  const locked = resolveNpmLockPackage(input);
  assert.throws(() => assertPrivateLocalBoundary(locked, {sourcePath: locked.localSourcePath,
    licenseEvidence: {paths: ["app/vendor/other/package.json"]}}), /private boundary/);
}));
