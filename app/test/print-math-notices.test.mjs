import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import {readMathTypesetterPackages, readPdfConverterPackages, writeThirdPartyNotices} from "../scripts/build-third-party-notices.mjs";

const retainedLicenses = ["mathjax-4.1.3.LICENSE.txt", "mathjax-4.1.3.SOURCE-NOTICE.txt", "mathjax-tex-4.1.0.FONT-LICENSE.txt",
  "mathjax-newcm-4.1.3.FONT-LICENSE.txt", "SIL-OFL-1.1.txt", "GUST-FONT-LICENSE.txt", "LPPL-1.3c.txt"];
const fontIntegrities = {
  "@mathjax/mathjax-tex-font": "sha512-PnlkYIcY4fPjmbN0AGLTULD8nSC2isrCmquEyuHzGU9dAOvLvapYWi5/2yOu0+ZRDDxgs0cAtg52fYQMkirxrQ==",
  "@mathjax/mathjax-newcm-font": "sha512-gzAB3dFHilHX1l5x2xUqRL+1jDQt3Fyza1DkEMVXWC4E8SvsGdlgEza47HYi2WhVcgfkvf4zgUGzuhbq3Pjlew=="
};

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), {recursive: true});
  await writeFile(join(root, path), bytes);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opengeo-math-notices-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const appRoot = join(root, "app"), outputRoot = join(root, "output"), installRoot = join(root, "isolated");
  const fontTerms = "Original TeX font terms\r\nPreserve these exact outline permissions.\r\n";
  const packages = {
    "@mathjax/src": {version: "4.1.3", dependencies: {"@mathjax/mathjax-newcm-font": "4.1.3", "speech-rule-engine": "5.0.0-rc.4", commander: "^11", "missing-license": "1"}, optionalDependencies: {"absent-font-option": "^2"}, peerDependencies: {"peer-only": "*"}},
    "@mathjax/mathjax-tex-font": {version: "4.1.0"},
    "@mathjax/mathjax-newcm-font": {version: "4.1.3"},
    "speech-rule-engine": {version: "5.0.0-rc.4", dependencies: {commander: "^14"}},
    commander: {version: "11.0.0"},
    "speech-rule-engine/node_modules/commander": {name: "commander", version: "14.0.3"},
    "missing-license": {version: "1.0.0"}
  };
  const manifest = {dependencies: {"@mathjax/src": "4.1.3", "@mathjax/mathjax-tex-font": "4.1.0"}};
  const lock = {packages: {}}, receipt = {packages: {}};
  for (const [path, metadata] of Object.entries(packages)) {
    const name = metadata.name ?? path;
    const identity = {version: metadata.version, integrity: fontIntegrities[name] ?? `fixture-integrity-${path}`};
    const lockPath = `node_modules/${path}`;
    lock.packages[lockPath] = identity;
    receipt.packages[lockPath] = identity;
    await put(installRoot, `${lockPath}/package.json`, JSON.stringify({name, license: "Apache-2.0", ...metadata}));
    if (name !== "missing-license") await put(installRoot, `${lockPath}/LICENSE`, `Untouched ${path} terms\n`);
  }
  await put(installRoot, "node_modules/@mathjax/mathjax-tex-font/FONT-LICENSE", fontTerms);
  await put(installRoot, "node_modules/@mathjax/src/NOTICE", "Original MathJax Consortium attribution\n");
  for (const filename of retainedLicenses) {
    await put(appRoot, `src/assets/licenses/${filename}`, await readFile(new URL(`../src/assets/licenses/${filename}`, import.meta.url)));
  }
  await put(appRoot, "package.json", JSON.stringify(manifest));
  await put(appRoot, "package-lock.json", JSON.stringify(lock));
  await put(installRoot, "node_modules/.package-lock.json", JSON.stringify(receipt));
  for (const name of Object.keys(manifest.dependencies)) {
    await mkdir(dirname(join(appRoot, "node_modules", name)), {recursive: true});
    await symlink(join(installRoot, "node_modules", name), join(appRoot, "node_modules", name), "dir");
  }
  for (const path of ["community/LICENSE", "community/NOTICE", "community/ACKNOWLEDGEMENTS.md",
    "docs/open-source-foundations.md", "governance/open-source-foundations.json", "docs/community-licensing.md"]) {
    await put(root, path, `Original ${path}\n`);
  }
  return {root, appRoot, outputRoot, installRoot, fontTerms, lock, receipt};
}

test("MathJax notices retain contextual identities and exact font companions separately from PDF converters", async t => {
  const options = await fixture(t);
  const packages = await readMathTypesetterPackages(options);
  assert.equal(packages.length, 7);
  assert.deepEqual(await readPdfConverterPackages(options), []);
  const inventory = await writeThirdPartyNotices(options);
  assert.equal(inventory.converterDependencies.length, 0);
  assert.equal(inventory.mathTypesetterPackages.length, 7);
  assert.equal(inventory.mathTypesetterPackages.filter(entry => entry.name === "commander").length, 2);
  assert.equal(inventory.mathTypesetterPackages.find(entry => entry.version === "14.0.3").lockPath,
    "node_modules/speech-rule-engine/node_modules/commander");
  assert.ok(!inventory.mathTypesetterPackages.some(entry => entry.name === "peer-only"));
  assert.deepEqual(inventory.absentOptionalMathTypesetterDependencies,
    [{name: "absent-font-option", declaredRange: "^2", optionalFor: "@mathjax/src@4.1.3"}]);
  const font = inventory.mathTypesetterPackages.find(entry => entry.name === "@mathjax/mathjax-tex-font");
  assert.equal(font.declaredLicense, "Apache-2.0", "software metadata is retained separately from font rights");
  assert.equal(font.fontLicenseExpression, "OFL-1.1");
  assert.equal(font.fontLicenseStatus, "complete-license-and-supplied-notices-retained");
  const newcm = inventory.mathTypesetterPackages.find(entry => entry.name === "@mathjax/mathjax-newcm-font");
  assert.equal(newcm.fontLicenseExpression, "LicenseRef-GUST-Font-License-1.0");
  assert.ok(newcm.notices.some(entry => entry.path === "notices/LPPL-1.3c.txt"));
  const terms = font.notices.find(entry => entry.path === "FONT-LICENSE");
  assert.equal(terms.sha256, createHash("sha256").update(options.fontTerms).digest("hex"));
  assert.equal(await readFile(join(options.outputRoot, terms.artifactPath), "utf8"), options.fontTerms);
  const combined = await readFile(join(options.outputRoot, "third-party-notices.txt"), "utf8");
  assert.ok(combined.includes(options.fontTerms), "font permissions retain original CRLF bytes");
  assert.ok(combined.includes("Original MathJax Consortium attribution\n"));
  assert.deepEqual(inventory.unresolved, [{name: "missing-license", version: "1.0.0", issue: "missing-upstream-license-file"}]);
  const serialized = await readFile(join(options.outputRoot, "third-party-inventory.json"), "utf8");
  assert.ok(!serialized.includes(options.installRoot));
  await writeThirdPartyNotices(options);
  assert.equal(await readFile(join(options.outputRoot, "third-party-inventory.json"), "utf8"), serialized);
});

test("MathJax closure refuses contextual version and installation-integrity drift", async t => {
  const options = await fixture(t);
  const nested = "node_modules/speech-rule-engine/node_modules/commander";
  await put(options.installRoot, `${nested}/package.json`, JSON.stringify({name: "commander", version: "11.0.0"}));
  await assert.rejects(readMathTypesetterPackages(options), /Math typesetter dependency identity differs from lockfile: node_modules\/speech-rule-engine\/node_modules\/commander/);
  await put(options.installRoot, `${nested}/package.json`, JSON.stringify({name: "commander", version: "14.0.3"}));
  options.receipt.packages[nested].integrity = "changed-tarball";
  await put(options.installRoot, "node_modules/.package-lock.json", JSON.stringify(options.receipt));
  await assert.rejects(readMathTypesetterPackages(options), /Math typesetter dependency integrity differs from lockfile: node_modules\/speech-rule-engine\/node_modules\/commander/);
});

test("MathJax missing required dependencies and root license text cannot be hidden by package metadata", async t => {
  const options = await fixture(t);
  await rm(join(options.installRoot, "node_modules/@mathjax/mathjax-tex-font/LICENSE"));
  await writeThirdPartyNotices(options); // The real font tarball omits this file.
  const path = "src/assets/licenses/mathjax-tex-4.1.0.FONT-LICENSE.txt";
  await put(options.appRoot, path, "Truncated font permissions\n");
  await assert.rejects(writeThirdPartyNotices(options), /upstream notice checksum differs: @mathjax\/mathjax-tex-font\/mathjax-tex-4.1.0.FONT-LICENSE.txt/);
  await rm(join(options.appRoot, path));
  await assert.rejects(writeThirdPartyNotices(options), {code: "ENOENT"});
  await rm(join(options.installRoot, "node_modules/speech-rule-engine"), {recursive: true});
  await assert.rejects(readMathTypesetterPackages(options), /Required Math typesetter dependency is not installed: speech-rule-engine/);
});
