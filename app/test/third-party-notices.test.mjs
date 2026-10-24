import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import {writeThirdPartyNotices} from "../scripts/build-third-party-notices.mjs";

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), {recursive: true});
  await writeFile(join(root, path), bytes);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opengeo-notices-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const appRoot = join(root, "app"), outputRoot = join(root, "output");
  const packages = {
    "@categori/workspace-contracts": {license: "Apache-2.0", files: {LICENSE: "Supplied license\n", NOTICE: "Original categori.se notice\n"}},
    earcut: {license: "ISC", files: {LICENSE: "Original Earcut copyright\n"}},
    optional: {license: "SEE LICENSE IN LICENSE.txt", files: {"LICENSE.txt": "Original separate runtime terms\n"}},
    missing: {license: "BSD-3-Clause", files: {}}
  };
  const dependencies = {}, locked = {};
  for (const [name, {license, files}] of Object.entries(packages)) {
    dependencies[name] = "1.0.0";
    locked[`node_modules/${name}`] = {version: "1.0.0", integrity: "fixture-integrity"};
    await put(appRoot, `node_modules/${name}/package.json`, JSON.stringify({name, version: "1.0.0", license}));
    for (const [path, bytes] of Object.entries(files)) await put(appRoot, `node_modules/${name}/${path}`, bytes);
  }
  await put(appRoot, "package.json", JSON.stringify({dependencies}));
  await put(appRoot, "package-lock.json", JSON.stringify({packages: locked}));
  for (const path of ["community/LICENSE", "community/NOTICE", "community/ACKNOWLEDGEMENTS.md",
    "docs/open-source-foundations.md", "governance/open-source-foundations.json", "docs/community-licensing.md"]) {
    await put(root, path, `Original ${path}\n`);
  }
  await put(outputRoot, "editor-assets/editor.js.LEGAL.txt", "Original linked transitive notice\n");
  await put(outputRoot, "renderer-runtime/LICENSE.md", "Original renderer terms\n");
  await put(outputRoot, "renderer-runtime/ThirdParty.extra.json", '{"upstream":"inventory"}\n');
  await put(outputRoot, "index.html", "<main>Fixture</main>");
  return {root, appRoot, outputRoot};
}

async function addPmtiles(options) {
  const bytes = await readFile(new URL("../src/assets/licenses/pmtiles-4.4.1.LICENSE.txt", import.meta.url));
  const integrity = "sha512-5oTeQc/yX/ft1evbpIlnoCZugQuug/iYIAj/ZTqIqzdGek4uZEho99En890EE6NOSI3JTI3IG8R7r8+SltphxA==";
  const manifest = JSON.parse(await readFile(join(options.appRoot, "package.json"), "utf8"));
  manifest.dependencies.pmtiles = "4.4.1";
  const lock = JSON.parse(await readFile(join(options.appRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/pmtiles"] = {version: "4.4.1", integrity};
  await put(options.appRoot, "package.json", JSON.stringify(manifest));
  await put(options.appRoot, "package-lock.json", JSON.stringify(lock));
  await put(options.appRoot, "node_modules/pmtiles/package.json", JSON.stringify({name: "pmtiles", version: "4.4.1", license: "BSD-3-Clause"}));
  await put(options.appRoot, "src/assets/licenses/pmtiles-4.4.1.LICENSE.txt", bytes);
  return bytes;
}

test("PMTiles retains the complete exact-version upstream notice even when npm omits it", async t => {
  const options = await fixture(t), bytes = await addPmtiles(options);
  const inventory = await writeThirdPartyNotices(options);
  const entry = inventory.directDependencies.find(item => item.name === "pmtiles");
  assert.equal(entry.noticeStatus, "license-file-present");
  assert.equal(entry.declaredLicense, "BSD-3-Clause");
  assert.match(entry.notices[0].sourceUrl, /0cebcaeade40034b86facb6e7da4ec726b9053fb\/LICENSE$/);
  assert.deepEqual(await readFile(join(options.outputRoot, entry.notices[0].path)), bytes);
  assert.ok((await readFile(join(options.outputRoot, "third-party-notices.txt"), "utf8")).includes(bytes.toString()));
  assert.ok(!inventory.unresolved.some(item => item.name === "pmtiles"));
  assert.match(bytes.toString(), /Copyright 2021 Protomaps LLC/);
  assert.match(bytes.toString(), /Sample tilesets.*their own license terms/);
});

test("PMTiles build refuses missing or changed notice text and an unreviewed package identity", async t => {
  const options = await fixture(t), bytes = await addPmtiles(options);
  const path = "src/assets/licenses/pmtiles-4.4.1.LICENSE.txt";
  await rm(join(options.appRoot, path));
  await assert.rejects(writeThirdPartyNotices(options), {code: "ENOENT"});
  await put(options.appRoot, path, "Truncated copyright notice\n");
  await assert.rejects(writeThirdPartyNotices(options), /upstream notice checksum differs: pmtiles/);
  await put(options.appRoot, path, bytes);
  const lock = JSON.parse(await readFile(join(options.appRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/pmtiles"].version = "4.4.2";
  await put(options.appRoot, "package-lock.json", JSON.stringify(lock));
  await put(options.appRoot, "node_modules/pmtiles/package.json", JSON.stringify({name: "pmtiles", version: "4.4.2", license: "BSD-3-Clause"}));
  await assert.rejects(writeThirdPartyNotices(options), /Review version-pinned upstream notice before changing dependency: pmtiles/);
  lock.packages["node_modules/pmtiles"] = {version: "4.4.1", integrity: "different-package-bytes"};
  await put(options.appRoot, "package-lock.json", JSON.stringify(lock));
  await put(options.appRoot, "node_modules/pmtiles/package.json", JSON.stringify({name: "pmtiles", version: "4.4.1", license: "BSD-3-Clause"}));
  await assert.rejects(writeThirdPartyNotices(options), /Review version-pinned upstream notice before changing dependency: pmtiles/);
});

test("browser notices preserve direct and supplemental terms, expose gaps and ship local source documents", async t => {
  const options = await fixture(t);
  const inventory = await writeThirdPartyNotices(options);
  const notice = await readFile(join(options.outputRoot, "third-party-notices.txt"), "utf8");
  for (const text of ["Original Earcut copyright\n", "Original categori.se notice\n", "Original separate runtime terms\n"]) assert.ok(notice.includes(text));
  assert.match(notice, /Not a complete transitive SBOM/);
  assert.match(notice, /optional@1.0.0 · SEE LICENSE IN LICENSE.txt/);
  assert.deepEqual(inventory.unresolved, [{name: "missing", version: "1.0.0", issue: "missing-upstream-license-file"}]);
  assert.deepEqual(inventory.supplementalNotices.map(({path}) => path), [
    "editor-assets/editor.js.LEGAL.txt", "renderer-runtime/LICENSE.md", "renderer-runtime/ThirdParty.extra.json"
  ]);
  assert.equal(await readFile(join(options.outputRoot, "notices/NOTICE"), "utf8"), "Original community/NOTICE\n");
  assert.equal(await readFile(join(options.outputRoot, "editor-assets/editor.js.LEGAL.txt"), "utf8"), "Original linked transitive notice\n");
  assert.equal(inventory.documents.length, 6);
  const serialized = await readFile(join(options.outputRoot, "third-party-inventory.json"), "utf8");
  assert.ok(!serialized.includes(options.root), "inventory must not expose local installation paths");
  await writeThirdPartyNotices(options);
  assert.equal(await readFile(join(options.outputRoot, "third-party-inventory.json"), "utf8"), serialized, "reruns produce stable inventory");
});

test("notice identities must match locked packages and existing required upstream files remain mandatory", async t => {
  const options = await fixture(t);
  await put(options.appRoot, "node_modules/earcut/package.json", JSON.stringify({name: "earcut", version: "2.0.0", license: "ISC"}));
  await assert.rejects(writeThirdPartyNotices(options), /identity differs from lockfile: earcut/);
  await put(options.appRoot, "node_modules/earcut/package.json", JSON.stringify({name: "earcut", version: "1.0.0", license: "ISC"}));
  await rm(join(options.appRoot, "node_modules/@categori/workspace-contracts/NOTICE"));
  await assert.rejects(writeThirdPartyNotices(options), /Required upstream notice missing: @categori\/workspace-contracts\/NOTICE/);
});

test("community snapshots use root license documents and vendored lock identities", async t => {
  const options = await fixture(t);
  await put(options.root, "LICENSE", "Community root license\n");
  const lock = JSON.parse(await readFile(join(options.appRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/@categori/workspace-contracts"] = {link: true, resolved: "vendor/workspace-contracts"};
  lock.packages["vendor/workspace-contracts"] = {version: "1.0.0"};
  await put(options.appRoot, "package-lock.json", JSON.stringify(lock));
  await writeThirdPartyNotices(options);
  assert.equal(await readFile(join(options.outputRoot, "notices/LICENSE"), "utf8"), "Community root license\n");
});

test("PDF notices preserve required and installed optional closures, disclose absent packages, and reject identity drift", async t => {
  const options = await fixture(t);
  const installRoot = join(options.root, "isolated");
  const manifest = JSON.parse(await readFile(join(options.appRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(options.appRoot, "package-lock.json"), "utf8"));
  const packages = {
    jspdf: {version: "4.2.1", dependencies: {"fast-png": "^6", fflate: "^0.8", canvas: "*"}, optionalDependencies: {canvas: "*", "absent-optional": "^2"}},
    "svg2pdf.js": {version: "2.8.1", dependencies: {cssesc: "^3"}, peerDependencies: {"peer-only": "*"}},
    "fast-png": {version: "6.4.0", dependencies: {pako: "^2", "@types/pako": "^2"}},
    fflate: {version: "0.8.3"},
    pako: {version: "2.2.0"},
    "@types/pako": {version: "2.0.4"},
    cssesc: {version: "3.0.0"},
    canvas: {version: "1.0.0", dependencies: {"canvas-helper": "^1"}, optionalDependencies: {"absent-nested-optional": "^3"}},
    "canvas-helper": {version: "1.0.1"}
  };
  const receipt = {packages: {}};
  for (const [name, metadata] of Object.entries(packages)) {
    const identity = {version: metadata.version, integrity: `fixture-integrity-${name}`};
    const installedPath = `node_modules/${name}`;
    const lockPath = name === "pako" ? "node_modules/fast-png/node_modules/pako" : installedPath;
    lock.packages[lockPath] = identity;
    receipt.packages[installedPath] = identity;
    await put(installRoot, `${installedPath}/package.json`, JSON.stringify({name, license: "MIT", ...metadata}));
    await put(installRoot, `${installedPath}/LICENSE`, `Untouched ${name} permission and copyright\n`);
    if (["jspdf", "svg2pdf.js"].includes(name)) {
      manifest.dependencies[name] = metadata.version;
      await symlink(join(installRoot, installedPath), join(options.appRoot, installedPath), "dir");
    }
  }
  // The old top-level pako identity is valid for other packages, but must never
  // be substituted for the converter's contextual nested lock identity.
  lock.packages["node_modules/pako"] = {version: "1.0.11", integrity: "old-pako"};
  const embedded = "/******************************************************************************\r\nCopyright (c) Microsoft Corporation.\r\nPermission to use, copy, modify, and/or distribute this software.\r\n***************************************************************************** */";
  await put(installRoot, "node_modules/jspdf/dist/jspdf.es.js", "/** @license Original jsPDF contributor permission */\nexport {};\n");
  await put(installRoot, "node_modules/svg2pdf.js/dist/svg2pdf.es.js", `${embedded}\nexport {};\n`);
  await put(options.appRoot, "package.json", JSON.stringify(manifest));
  await put(options.appRoot, "package-lock.json", JSON.stringify(lock));
  await put(installRoot, "node_modules/.package-lock.json", JSON.stringify(receipt));
  const inventory = await writeThirdPartyNotices(options);
  assert.equal(inventory.converterDependencies.length, 9);
  assert.ok(inventory.converterDependencies.some(entry => entry.name === "@types/pako"));
  assert.equal(inventory.converterDependencies.find(entry => entry.name === "pako").lockPath, "node_modules/fast-png/node_modules/pako");
  assert.ok(inventory.converterDependencies.some(entry => entry.name === "canvas-helper"), "installed optional packages retain their required transitive notices");
  assert.ok(!inventory.converterDependencies.some(entry => entry.name === "peer-only"));
  assert.deepEqual(inventory.absentOptionalConverterDependencies, [
    {name: "absent-optional", declaredRange: "^2", optionalFor: "jspdf@4.2.1"},
    {name: "absent-nested-optional", declaredRange: "^3", optionalFor: "canvas@1.0.0"}
  ]);
  const notice = await readFile(join(options.outputRoot, "third-party-notices.txt"), "utf8");
  for (const name of Object.keys(packages)) assert.ok(notice.includes(`Untouched ${name} permission and copyright\n`));
  assert.ok(notice.includes(embedded), "embedded permissions retain original CRLF bytes");
  assert.match(notice, /absent-optional@\^2 \(optional for jspdf@4\.2\.1\)/);
  assert.ok(!JSON.stringify(inventory).includes(installRoot), "real installation paths stay private");
  await put(installRoot, "node_modules/pako/package.json", JSON.stringify({name: "pako", version: "1.0.11"}));
  await assert.rejects(writeThirdPartyNotices(options), /PDF converter dependency identity differs from lockfile: node_modules\/fast-png\/node_modules\/pako/);
  await put(installRoot, "node_modules/pako/package.json", JSON.stringify({name: "pako", license: "MIT", version: "2.2.0"}));
  receipt.packages["node_modules/pako"].integrity = "changed-installed-tarball";
  await put(installRoot, "node_modules/.package-lock.json", JSON.stringify(receipt));
  await assert.rejects(writeThirdPartyNotices(options), /PDF converter dependency integrity differs from lockfile: node_modules\/fast-png\/node_modules\/pako/);
  receipt.packages["node_modules/pako"].integrity = "fixture-integrity-pako";
  receipt.packages["node_modules/canvas"].integrity = "changed-optional-tarball";
  await put(installRoot, "node_modules/.package-lock.json", JSON.stringify(receipt));
  await assert.rejects(writeThirdPartyNotices(options), /PDF converter dependency integrity differs from lockfile: node_modules\/canvas/);
  receipt.packages["node_modules/canvas"].integrity = "fixture-integrity-canvas";
  await put(installRoot, "node_modules/.package-lock.json", JSON.stringify(receipt));
  await rm(join(installRoot, "node_modules/canvas-helper"), {recursive: true});
  await assert.rejects(writeThirdPartyNotices(options), /Required PDF converter dependency is not installed: canvas-helper/);
});
