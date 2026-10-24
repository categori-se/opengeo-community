import {createHash} from "node:crypto";
import {mkdir, readFile, readdir, realpath, writeFile} from "node:fs/promises";
import {basename, dirname, relative, resolve, sep} from "node:path";

const legalName = /(?:^|[-_.])(licen[cs]es?|notice|copying|copyright)(?:[-_.]|$)/i;
const mathSourceLicense = {
  filename: "mathjax-4.1.3.LICENSE.txt",
  sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  sourceUrl: "https://registry.npmjs.org/@mathjax/src/-/src-4.1.3.tgz"
};
const mathSourceNotice = {
  filename: "mathjax-4.1.3.SOURCE-NOTICE.txt",
  sha256: "b7983489b2aec657066673a88c37b04b9c82dcf9b241f7dd29e1d995b7b9e781",
  sourceUrl: "https://registry.npmjs.org/@mathjax/src/-/src-4.1.3.tgz",
  sourcePath: "ts/mathjax.ts#initial-legal-comment"
};
// Some npm packages omit legal text. Bind retained supplements to exact package
// identities rather than fetching mutable licenses or editing node_modules.
const upstreamLicenseSupplements = {
  "@mathjax/mathjax-tex-font": {
    version: "4.1.0",
    license: "Apache-2.0",
    integrity: "sha512-PnlkYIcY4fPjmbN0AGLTULD8nSC2isrCmquEyuHzGU9dAOvLvapYWi5/2yOu0+ZRDDxgs0cAtg52fYQMkirxrQ==",
    fontLicenseExpression: "OFL-1.1",
    files: [mathSourceLicense, mathSourceNotice, {
      filename: "mathjax-tex-4.1.0.FONT-LICENSE.txt",
      sha256: "db450224a8d71651a10f9b6a405b8999b4d80eab27caff319c961449c55ccefb",
      sourceUrl: "https://registry.npmjs.org/@mathjax/mathjax-tex-font/-/mathjax-tex-font-4.1.0.tgz",
      sourcePath: "chtml/woff2/*.woff2#name-table-0-13-14"
    }, {
      filename: "SIL-OFL-1.1.txt",
      sha256: "67b68bca726748f3bfefa48770519d63a532a1f254cbf01714130b1121066653",
      sourceUrl: "https://openfontlicense.org/open-font-license-official-text/"
    }]
  },
  "@mathjax/mathjax-newcm-font": {
    version: "4.1.3",
    license: "Apache-2.0",
    integrity: "sha512-gzAB3dFHilHX1l5x2xUqRL+1jDQt3Fyza1DkEMVXWC4E8SvsGdlgEza47HYi2WhVcgfkvf4zgUGzuhbq3Pjlew==",
    fontLicenseExpression: "LicenseRef-GUST-Font-License-1.0",
    files: [mathSourceLicense, {
      filename: "mathjax-newcm-4.1.3.FONT-LICENSE.txt",
      sha256: "91612143f70741ba2a850e967a2f06ffa22ade561a01b89c8b52a6abb9375177",
      sourceUrl: "https://registry.npmjs.org/@mathjax/mathjax-newcm-font/-/mathjax-newcm-font-4.1.3.tgz",
      sourcePath: "chtml/woff2/*.woff2#name-table-0-13-14"
    }, {
      filename: "GUST-FONT-LICENSE.txt",
      sha256: "5eb61bb836bb1845ef668717cb15b382e997748ce2629e4388cc5e4c3fa4e433",
      sourceUrl: "https://www.gust.org.pl/projects/e-foundry/licenses/GUST-FONT-LICENSE.txt"
    }, {
      filename: "LPPL-1.3c.txt",
      sha256: "3d262cdf34dafa6955f703c634a8c238ec44109bc8dd6ef34fb7aa54809f7e66",
      sourceUrl: "https://www.latex-project.org/lppl/lppl-1-3c.txt"
    }]
  },
  pmtiles: {
    version: "4.4.1",
    license: "BSD-3-Clause",
    integrity: "sha512-5oTeQc/yX/ft1evbpIlnoCZugQuug/iYIAj/ZTqIqzdGek4uZEho99En890EE6NOSI3JTI3IG8R7r8+SltphxA==",
    filename: "pmtiles-4.4.1.LICENSE.txt",
    sha256: "0371c38f338835f7fc13ed71176f3d92144e22c8b736a31cced57adbbeb647b3",
    sourceUrl: "https://github.com/protomaps/PMTiles/blob/0cebcaeade40034b86facb6e7da4ec726b9053fb/LICENSE"
  }
};
const sourceDocuments = [
  ["LICENSE", "community/LICENSE", "LICENSE"],
  ["NOTICE", "community/NOTICE", "NOTICE"],
  ["ACKNOWLEDGEMENTS.md", "community/ACKNOWLEDGEMENTS.md", "ACKNOWLEDGEMENTS.md"],
  ["docs/open-source-foundations.md", null, "open-source-foundations.md"],
  ["governance/open-source-foundations.json", null, "open-source-foundations.json"],
  ["docs/community-licensing.md", null, "community-licensing.md"]
];

async function readSource(root, primary, fallback) {
  try {
    return await readFile(resolve(root, primary));
  } catch (error) {
    if (error.code !== "ENOENT" || !fallback) throw error;
    return readFile(resolve(root, fallback));
  }
}

async function filesIn(root, directory = "") {
  const files = [];
  for (const entry of await readdir(resolve(root, directory), {withFileTypes: true})) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function packageNoticeFiles(root) {
  const files = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (!legalName.test(entry.name)) continue;
    if (entry.isFile()) files.push(entry.name);
    else if (entry.isDirectory()) {
      for (const path of await filesIn(root, entry.name)) files.push(path);
    }
  }
  return files.sort();
}

function digest(bytes) {
  return {bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
}

const pdfConverters = new Set(["jspdf", "svg2pdf.js"]);
const mathTypesetters = new Set(["@mathjax/src", "@mathjax/mathjax-tex-font"]);
const converterSources = {jspdf: "dist/jspdf.es.js", "svg2pdf.js": "dist/svg2pdf.es.js"};

function lockedDependency(lock, parentPath, name, label) {
  for (let directory = parentPath; ; directory = dirname(directory)) {
    const path = `${directory === "." ? "" : `${directory}/`}node_modules/${name}`;
    if (lock.packages[path]) return {lockPath: path, identity: lock.packages[path]};
    if (directory === ".") throw Error(`${label} dependency absent from lockfile: ${name}`);
  }
}

async function installedDependency(parentRoot, name, optional, label) {
  for (let directory = parentRoot; ; directory = dirname(directory)) {
    try {
      return await realpath(resolve(directory, "node_modules", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (dirname(directory) === directory) {
        if (optional) return null;
        throw Error(`Required ${label} dependency is not installed: ${name}`);
      }
    }
  }
}

// npm's installation receipt identifies the downloaded tarball. Compare that
// integrity with the application lock; this does not rehash the installed tree.
async function installedIdentity(packageRoot, label) {
  for (let directory = dirname(packageRoot); ; directory = dirname(directory)) {
    if (basename(directory) === "node_modules") {
      try {
        const receipt = JSON.parse(await readFile(resolve(directory, ".package-lock.json"), "utf8"));
        const key = relative(dirname(directory), packageRoot).split(sep).join("/");
        if (receipt.packages?.[key]) return receipt.packages[key];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (dirname(directory) === directory) throw Error(`${label} installation integrity receipt missing: ${basename(packageRoot)}`);
  }
}

// Traverse required dependencies and installed optional dependencies, including
// their own closure. Absent optional packages are disclosed without requiring an
// install. Peer-only/development edges do not expand this bounded notice index.
async function readDependencyPackages({appRoot, onAbsentOptionalDependency = () => {}, roots, label}) {
  const manifest = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(appRoot, "package-lock.json"), "utf8"));
  const packages = new Map();
  async function visit(name, parentRoot, parentPath, requiredBy, optional = false, declaredRange) {
    const packageRoot = await installedDependency(parentRoot, name, optional, label);
    if (!packageRoot) {
      onAbsentOptionalDependency({name, declaredRange, optionalFor: requiredBy});
      return;
    }
    const {lockPath, identity} = lockedDependency(lock, parentPath, name, label);
    const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const installed = await installedIdentity(packageRoot, label);
    if (metadata.name !== name || metadata.version !== identity.version || installed.version !== identity.version) {
      throw Error(`${label} dependency identity differs from lockfile: ${lockPath}`);
    }
    if (!identity.integrity || installed.integrity !== identity.integrity) {
      throw Error(`${label} dependency integrity differs from lockfile: ${lockPath}`);
    }
    if (packages.has(lockPath)) return;
    packages.set(lockPath, {name, packageRoot, metadata, identity, lockPath, requiredBy});
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
      if (Object.hasOwn(metadata.optionalDependencies ?? {}, dependency)) continue;
      await visit(dependency, packageRoot, lockPath, `${name}@${metadata.version}`);
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {}).sort()) {
      await visit(dependency, packageRoot, lockPath, `${name}@${metadata.version}`, true, metadata.optionalDependencies[dependency]);
    }
  }
  for (const name of [...roots].sort()) {
    if (Object.hasOwn(manifest.dependencies ?? {}, name)) await visit(name, resolve(appRoot), ".", "direct");
  }
  return [...packages.values()].sort((a, b) => a.lockPath.localeCompare(b.lockPath));
}

export async function readPdfConverterPackages(options) {
  return readDependencyPackages({...options, roots: pdfConverters, label: "PDF converter"});
}

export async function readMathTypesetterPackages(options) {
  return readDependencyPackages({...options, roots: mathTypesetters, label: "Math typesetter"});
}

// This is a bounded notice index, not a claim of complete transitive bundle or
// container coverage. Keep the exact package metadata and untouched notice text.
export async function writeThirdPartyNotices({appRoot, outputRoot}) {
  const sourceRoot = resolve(appRoot, "..");
  const manifest = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(appRoot, "package-lock.json"), "utf8"));
  const directDependencies = [];
  const converterDependencies = [];
  const absentOptionalConverterDependencies = [];
  const mathTypesetterPackages = [];
  const absentOptionalMathTypesetterDependencies = [];
  const sections = [];
  const upstreamCopies = [];
  const converterPackages = await readPdfConverterPackages({appRoot, onAbsentOptionalDependency: entry => absentOptionalConverterDependencies.push(entry)});
  const mathPackages = await readMathTypesetterPackages({appRoot, onAbsentOptionalDependency: entry => absentOptionalMathTypesetterDependencies.push(entry)});
  async function collectNotices({name, packageRoot, metadata, identity, lockPath}) {
    if (metadata.name !== name || !metadata.version || identity?.version !== metadata.version) {
      throw Error(`Dependency notice identity differs from lockfile: ${name}`);
    }
    const paths = await packageNoticeFiles(packageRoot);
    const supplement = upstreamLicenseSupplements[name];
    // Retain the existing release requirement for these supplied notices.
    const required = name === "@categori/workspace-contracts" ? ["LICENSE", "NOTICE"]
      : name === "earcut" || pdfConverters.has(name) || (mathTypesetters.has(name) && !supplement) ? ["LICENSE"] : [];
    for (const path of required) {
      if (!paths.includes(path)) throw Error(`Required upstream notice missing: ${name}/${path}`);
    }
    const notices = [];
    const texts = [];
    for (const path of paths) {
      const bytes = await readFile(resolve(packageRoot, path));
      notices.push({path, ...digest(bytes)});
      texts.push(`--- ${name}/${path} ---\n${bytes.toString("utf8")}`);
    }
    // These supplied browser sources also contain embedded contributor/library
    // notices absent from the package's top-level license (including Microsoft
    // helper permissions). Preserve each whole original comment, untouched.
    if (converterSources[name]) {
      const path = converterSources[name];
      const source = await readFile(resolve(packageRoot, path), "utf8");
      let index = 0;
      for (const [comment] of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
        if (!/copyright|@license|permission (?:is hereby granted|to use)/i.test(comment)) continue;
        const origin = `${path}#legal-comment-${++index}`;
        notices.push({path: origin, ...digest(Buffer.from(comment))});
        texts.push(`--- ${name}/${origin} ---\n${comment}`);
      }
      if (!index) throw Error(`PDF converter embedded upstream notices missing: ${name}/${path}`);
    }
    if (supplement) {
      if (metadata.version !== supplement.version || metadata.license !== supplement.license || identity.integrity !== supplement.integrity) {
        throw Error(`Review version-pinned upstream notice before changing dependency: ${name}`);
      }
      for (const file of supplement.files ?? [supplement]) {
        const bytes = await readFile(resolve(appRoot, "src/assets/licenses", file.filename));
        if (digest(bytes).sha256 !== file.sha256) throw Error(`Version-pinned upstream notice checksum differs: ${name}/${file.filename}`);
        const path = `notices/${file.filename}`;
        notices.push({path, sourceUrl: file.sourceUrl, ...(file.sourcePath ? {sourcePath: file.sourcePath} : {}), ...digest(bytes)});
        texts.push(`--- ${name}/${file.filename} (version-pinned upstream source) ---\n${bytes.toString("utf8")}`);
        upstreamCopies.push({path, bytes});
      }
    }
    const hasLicense = !!supplement || paths.some(path => /^(licen[cs]es?|copying)(?:[-_.]|$)/i.test(path.split("/")[0]));
    const entry = {
      name,
      version: metadata.version,
      declaredLicense: metadata.license ?? "NOASSERTION",
      ...(supplement?.fontLicenseExpression ? {fontLicenseExpression: supplement.fontLicenseExpression,
        fontLicenseStatus: "complete-license-and-supplied-notices-retained"} : {}),
      ...(identity.integrity ? {integrity: identity.integrity} : {}),
      noticeStatus: hasLicense ? "license-file-present" : "missing-upstream-license-file",
      notices
    };
    sections.push(`${name}@${entry.version} · ${typeof entry.declaredLicense === "string" ? entry.declaredLicense : JSON.stringify(entry.declaredLicense)}\n\n${texts.length
      ? texts.join("\n\n")
      : "No upstream license or notice file is supplied in the installed package. The metadata declaration is not a replacement for the missing text."}`);
    return entry;
  }
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    const packageRoot = resolve(appRoot, "node_modules", name);
    const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const locked = lock.packages[`node_modules/${name}`];
    const identity = locked?.link ? lock.packages[locked.resolved] : locked;
    directDependencies.push(await collectNotices({name, packageRoot, metadata, identity}));
  }
  for (const descriptor of converterPackages) {
    const existing = directDependencies.find(entry => entry.name === descriptor.name && entry.version === descriptor.metadata.version && entry.integrity === descriptor.identity.integrity);
    const entry = existing ?? await collectNotices(descriptor);
    converterDependencies.push({...entry, lockPath: descriptor.lockPath, requiredBy: descriptor.requiredBy});
  }
  for (const descriptor of mathPackages) {
    const existing = [...directDependencies, ...converterDependencies].find(entry => entry.name === descriptor.name && entry.version === descriptor.metadata.version && entry.integrity === descriptor.identity.integrity);
    const entry = existing ?? await collectNotices(descriptor);
    const notices = [];
    // Preserve actual legal files as companions as well as the combined text.
    // Contextual lock paths distinguish different installed versions without
    // leaking local paths or fetching mutable upstream text during a build.
    for (const notice of entry.notices) {
      if (notice.path.includes("#") || notice.sourceUrl) {
        notices.push(notice);
        continue;
      }
      const artifactPath = `notices/math-typesetter/${descriptor.lockPath}/${notice.path}`;
      upstreamCopies.push({path: artifactPath, bytes: await readFile(resolve(descriptor.packageRoot, notice.path))});
      notices.push({...notice, artifactPath});
    }
    mathTypesetterPackages.push({...entry, notices, lockPath: descriptor.lockPath, requiredBy: descriptor.requiredBy});
  }

  await mkdir(resolve(outputRoot, "notices"), {recursive: true});
  for (const {path, bytes} of upstreamCopies) {
    await mkdir(dirname(resolve(outputRoot, path)), {recursive: true});
    await writeFile(resolve(outputRoot, path), bytes);
  }
  const documents = [];
  for (const [primary, fallback, target] of sourceDocuments) {
    const bytes = await readSource(sourceRoot, primary, fallback);
    const path = `notices/${target}`;
    await writeFile(resolve(outputRoot, path), bytes);
    documents.push({path, ...digest(bytes)});
  }
  // Index files actually retained by the existing asset builders. Never replace
  // their notices with a package's top-level license or the application license.
  const supplementalNotices = [];
  for (const path of await filesIn(outputRoot)) {
    if (path.startsWith("notices/") || path === "third-party-notices.txt") continue;
    if (!legalName.test(basename(path)) && basename(path) !== "ThirdParty.extra.json" && !path.endsWith(".LEGAL.txt")) continue;
    supplementalNotices.push({path, ...digest(await readFile(resolve(outputRoot, path)))});
  }
  const coverage = {
    directDependencies: "Installed direct application dependencies, verified against the application lockfile. This includes build tools and optional runtimes; it does not assert that every package is incorporated into every page.",
    converterDependencies: "Required and installed optional jsPDF/svg2pdf.js dependency closure, resolved from converter realpaths, with versions and npm installation-receipt integrity matched to contextual application lock entries. Includes type-only packages and installed HTML/canvas integrations; absent optional packages are separately recorded, while development and peer-only dependencies are excluded. Preserves supplied license/NOTICE files and embedded legal comments from both browser converter distributions; not an exact bundle inclusion trace or installed-file integrity audit.",
    mathTypesetterPackages: "Separate required and installed optional MathJax source/original-TeX-font dependency closure, resolved from realpaths with versions and npm installation-receipt integrity matched to contextual application lock entries. Preserves supplied license/NOTICE files byte-for-byte, including font terms, with separately indexed artifact companions. Absent optional packages are disclosed; development and peer-only edges are excluded. This is not an exact browser-bundle inclusion trace, an installed-file integrity audit or a grant for unrelated fonts.",
    supplementalNotices: "Notice and license files retained in this output by the asset builders, indexed by actual artifact path.",
    limits: "Not a complete transitive SBOM, bundle inclusion trace, container inventory or legal certification. Bundled transitive code, fonts and other assets still require review of the exact distribution. Software notices do not replace map and dataset attribution or provider terms."
  };
  const inventory = {
    schemaVersion: "opengeo.browser-notices.1.0.0",
    coverage,
    documents,
    directDependencies,
    converterDependencies,
    absentOptionalConverterDependencies,
    mathTypesetterPackages,
    absentOptionalMathTypesetterDependencies,
    supplementalNotices,
    unresolved: [...new Map([...directDependencies, ...converterDependencies, ...mathTypesetterPackages].map(entry => [`${entry.name}@${entry.version}`, entry])).values()].filter(entry => entry.noticeStatus !== "license-file-present")
      .map(({name, version, noticeStatus}) => ({name, version, issue: noticeStatus}))
  };
  await writeFile(resolve(outputRoot, "third-party-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(resolve(outputRoot, "third-party-notices.txt"), [
    "OpenGeo Studio — software notices and source-document index",
    ...Object.values(coverage),
    "Project source documents (describe their stated source-release scope):\n" + documents.map(({path}) => `  ${path}`).join("\n"),
    "Supplementary notices retained with shipped assets:\n" + supplementalNotices.map(({path}) => `  ${path}`).join("\n"),
    "Absent optional PDF-converter dependencies (not included):\n" + (absentOptionalConverterDependencies.length
      ? absentOptionalConverterDependencies.map(({name, declaredRange, optionalFor}) => `  ${name}@${declaredRange} (optional for ${optionalFor})`).join("\n")
      : "  None."),
    "Absent optional MathJax dependencies (not included):\n" + (absentOptionalMathTypesetterDependencies.length
      ? absentOptionalMathTypesetterDependencies.map(({name, declaredRange, optionalFor}) => `  ${name}@${declaredRange} (optional for ${optionalFor})`).join("\n")
      : "  None."),
    "Exact installed direct-dependency, PDF-converter and MathJax closure identities with preserved upstream text:",
    ...sections
  ].join("\n\n") + "\n");
  return inventory;
}
