# OpenGeo Observable Builder

`src/framework-standalone.mjs` is a local postprocessor for native
Framework output. `localizeFrameworkOutput({files, entryPath, maximumOutputBytes})`
accepts exact file metadata and Buffers, verifies consumed hashes and returns HTML
plus a storage-free manifest. It preserves compiled markup, cyclic module imports
and shared verified assets, with an explicit system-font fallback. Missing authored
imports, external dependencies and unsupported document assets fail; unavailable
generated stdlib/client loaders remain local throwing modules. Missing sample
assets are allowed only for the pinned generated client declarations; missing
authored or static imports still fail. Native graph localization
and synthetic restoration/integrity checks pass. The local request-v4/invocation-v5
`single-html` option now calls it after native compilation and theme normalization.
Report-v2 retains the native tree seal, exact generated index facts and a canonical
localized-manifest seal; default output stays 32 MiB. Only the generated index can
use the explicitly acknowledged 96 MiB profile, with admitted archive inputs.
The coordinator's focused graph/report/write checks pass. The existing isolated
runner accepts the current source overlay and report-v2 against actual bytes.
Its 1,448,934-byte single HTML decodes a 290-byte synthetic GeoTIFF through D3;
Chromium confirms reactive controls at 390px under the current saved-preview CSP
and offline from `file://`, without external HTTP requests. Earlier failures and
costs remain in the owner-workflow manifest. SQL/API admission passes locally,
including saved-result validation and owner review. SDK request-v4 forwarding
and legacy compatibility pass two focused cases. This is source-overlay acceptance,
not release acceptance. A corrected immutable AMD64 candidate `7b09709f…` now
passes the same isolated runner without an overlay; its byte-identical HTML reuses
those browser checks. Its exact 373-component license-only inventory includes
all nine cached npm packages. Fresh vulnerability security and runtime admission,
live/public delivery, original-data saved compilation and referenced-file staging
remain unfinished. The candidate remains local; no deployed image pin or published
output changed, and older invocation/report paths remain intact.

The local request-v3/invocation-v4 increment supports explicitly acknowledged
archive output budgets and approval-bound release candidates. Existing request
and invocation schemas retain their limits and private archive/Artifact behavior.
The `archive-96m` profile requires `allow-up-to-96-mib-output` consent, retains
the source policy's 32 MiB limit, and selects a separate 96 MiB execution budget.
Only unchanged archive outputs matching an admitted input's checksum, byte count
and extension can exceed the ordinary 32 MiB file limit, up to 64 MiB. Authored
source limits, the 64 MiB data budget and 128 combined files remain unchanged.
Private previews require no redistribution approval; release candidates require
the sealed approval identity supplied by the trusted coordinator. The compiler
does not authorize publication.

The seed requests browser GeoTIFF `3.1.0-beta.0` alongside D3. The compiler
does not install a server GeoTIFF dependency: this `npm:` import consumes the
Framework browser cache. The retained Studio `_node` cache cannot substitute
for its `_npm` graph. Ordinary Docker seed builds retain Framework's canonical
cache preparation and require the nonempty GeoTIFF npm entry. Reviewed cache
overlays additionally embed a manifest; when present, the toolchain check verifies
its module hashes and sizes, package versions, licenses and sealed notice paths.
The Dockerfile applies its existing read-only permissions before verification.
Cache preparation and local assembly checks do not establish an accepted image;
exact image, security and no-network runtime acceptance remain required.

This service is the credential-free half of the Phase 2 authoring boundary. It compiles one exact, pre-staged Observable source revision with Framework `1.13.4`. It does not claim a database lease, read S3, upload output, serve a preview, or publish a site.

The runner accepts an exact invocation contract plus a read-only input tree. It rechecks every path, media type, size and SHA-256; rejects extra files, links, special files, secret/generated paths, case collisions and widened limits; stages only verified bytes; and supplies a generated Framework config, a seed cache baked while the image is built, and a minimal environment. Source lockfiles are preserved metadata, not installation plans. Their checksums and v3 structure are checked, but older dependency hook metadata does not authorize installation or cause rejection by itself. No source package command, package installation or lifecycle hook runs during compilation. Runtime compilation makes no package-registry request; an import that is absent from the sealed image cache fails under deny-all networking. The runner emits a local checksum manifest. A separate trusted coordinator must inspect and upload those bytes, add exact S3 version facts, and submit the database result envelope.

The seed includes HTL 1.0.0, D3 7.9.0, Leaflet 1.9.4 (CSS and marker images included), MapLibre GL 5.20.2 and mapbox-gl-arcgis-featureserver 0.0.8. It exercises Inputs, Plot and search so their runtime dependencies are cached too. These are downloaded during image assembly only and must be included in its scan and immutable release identity. Bare imports resolve against this sealed cache, not a project's historic cache; this is not general support for installing arbitrary source dependencies. Notebook Kit's separately bundled libraries retain their own pinned versions.

The runner report is not a sandbox attestation. A deployment may add the database-required zero-credential/no-network attestation only from independently enforced runtime facts. In particular, running this command directly on a host does not prove network denial or isolation.

Version-2 invocations add a separate, exact `dataFiles` list for archived JSON, GeoJSON, CSV, text, PNG, JPEG and TIFF inputs. TIFF archive admission accepts only `image/tiff` and `image/geotiff`; executable source-upload rules are unchanged. Authored source stays within its original limit; data has a separate 64 MiB cap and shares the 128-file count. The runner verifies and stages both lists, without archive storage coordinates. Version-2 output can contain a file up to the unchanged 32 MiB total-output budget; version-1 keeps its 16 MiB per-file limit. The real local Framework regression builds a synthetic 19 MB GeoJSON attachment and checks identical output bytes and checksum. This is not a deployed image, real archive capture or publication acceptance. TIFF saved-build support additionally requires migration `0160`, the API change and an approved compiler/coordinator release; a 64 MiB input does not authorize an output above 32 MiB.

Source revisions support two layouts. A complete Framework folder has a root `package.json` (and the required verified `package-lock.json`) plus an entry under `src/`; the compiler uses that `src/` as the page root. For example, `src/methods/transmission-line-analysis.md` becomes `/methods/transmission-line-analysis`, and `src/new-src/index.md` becomes `/new-src/`. Root README and package/configuration files stay preserved inputs outside the page root. The isolated image sets `OPEN_GEO_FRAMEWORK_PROJECT_CONFIG=isolated` to import the authored `observablehq.config.js` or `.mjs` inside its credential-free child build, preserving presentation functions, navigation, search, themes and styles. It never imports this configuration in the coordinator or authenticated browser. Output is confined to `dist`; a root that differs from the admitted source layout and ambiguous config files are rejected. Host callers of `runBuild` retain non-executing generated configuration unless explicitly opted in. Projects without an authored config keep generated/declarative settings. Custom source roots and mount configuration still need separate support; the current implementation does not silently reinterpret them.

## Native publication formats (compiler and private hosted workflow accepted)

An optional `opengeo.publication.json` beside the entry records
`{"schema":"opengeo.publication.1","format":"notebook","entry":"index.html"}`.
Formats are `framework`, `html`, `map`, `notebook`, and `jupyter`; the selected
format must match the entry extension. It is a checksummed source file, not an
unverified request preference. Unknown fields and mismatches fail. Existing
unmarked Markdown, HTML and Jupyter sources retain their previous interpretation.
Native Notebook markup cannot pass through the static packager uncompiled.

Notebook Kit 2.5.6 compiles declared Notebook sources in a bounded child process.
The image prebundles runtime assets using `scripts/build-notebook-assets.mjs`.
Submitted cells are parsed/transpiled but never executed on the build host.
The result is one standalone `index.html` containing the title, reactive cells,
runtime, styles and explicitly referenced attachments. Unused source files and
the format record are not published. Attachment limits match the local editor:
4 MiB per file and 16 MiB total. Reviewed supplied compiled module graphs support
canonical aliases/reactive parameters and the four existing pinned library loaders.
Remote/cyclic modules and broader library compatibility remain open. Compiler ZIP
source admission remains unsupported; the browser-only exporter supports ZIP.

The local worker/browser test, exact immutable image isolation and coordinator
output checks pass. One current-default native Notebook source also passes the
hosted revision/build/private-preview workflow; broader compatibility remains open.

October 3 current-source packaging reuses the existing publisher OCI assembler:
`scripts/assemble-publisher-transition-oci.py` accepts `--base-oci`, `--patch-root`,
`--output`, `--expected-config`, `--created` and `--tag`. It verifies the retained
config, compressed layer hashes and exact filesystem identities before appending
only regular compiler `.mjs` files and `notebook-assets.json` (64 files/16 MiB cap).
Dependency/native layers and runtime configuration stay unchanged; symlinks, other
paths, wrong base identities and output overwrite are rejected. Legacy API assembly
still uses the existing default invocation.

For the selected GeoTIFF browser graph, the same assembler additionally accepts
paired compiler-only `--framework-cache-manifest` and
`--framework-cache-manifest-sha256` arguments. The operator-pinned manifest uses
`opengeo.framework-browser-cache.1.0.0`, Framework `1.13.4`, root import
`npm:geotiff@3.1.0-beta.0`, actual resolver provenance, the nine exact browser
package records (including licenses and notices), and `files` records containing
cache-relative `_npm/` paths, `sizeBytes` and `checksumSha256`. Put only these
enumerated cache files beneath `opt/opengeo-framework-cache/` in `--patch-root`;
the assembler embeds the exact manifest as
`opt/opengeo-framework-cache/opengeo-geotiff-cache-manifest.json`. This mode also
admits the single `srv/opengeo/scripts/verify-toolchain.mjs` readiness check.
Unlisted cache files, existing-cache replacements, linked files and runtime or
installed-package changes are rejected. Source, cache and manifest share the
unchanged 64-file/16 MiB ceiling. Retained layers, runtime configuration and
existing history entries remain exact; one new overlay and history entry are
appended. The receipt records the manifest hash. This is not a general dependency
installation or cache substitution mechanism.
Each package's `notices` list names hashed files within its exact cache package
directory. Resolver provenance records extracted notices, reused license text
and any unverified additional upstream notices separately.

The immutable AMD64 candidate passes normal container isolation without overlays;
its one Bar Chart527 output matches the earlier isolated/browser-accepted HTML
byte for byte, including notices. Its364-component SBOM reports zero HIGH/CRITICAL
findings against the retained October1 database, with no suppressions configured.
Two preceding offline install-cache failures remain retained; no install/download
was repeated. The approved October3 rollout promoted this exact image as `sha256:f4ad135eea6cdb714220d4f0b070637e093876340a15d615ea59f9712309a178`, deployed four-pin runtime `f3ea7eaa1314aa0c62a85b4f0fdd43eda467b885` and read back the matching new-source API default. A fresh October3 scan also reports zero HIGH/CRITICAL findings. The same private source saved its eight original files and passed one native build and hosted private preview: 26 bars, retained notice, working disclosure, narrow layout, exact accepted HTML and anonymous HTTP403. Rights remain unreviewed and publication unauthorized. The separately approved Studio release used the existing frozen candidate. [Deployment](../../.local-archives/renderer-switch-20260930/notebook-package/default-selection/deployment.json). [Private acceptance](../../.local-archives/renderer-switch-20260930/notebook-package/default-selection/acceptance/private-notebook-receipt.json). [Image receipt](../../.local-archives/renderer-switch-20260930/notebook-package/image-assembly/receipt.json).


October 3 helper/constants delivery now promotes compiler
`sha256:4f944277a4fdbb88c9fb57d62afe67bed167c4fc3bb87029c59b3b0dfacb8682`
and matches the new-source API default, runtime `a1880ca7…` and Studio tree
`d0a32db8…`. Six retained layers are unchanged; one 15,014-byte converter layer
adds validated shared root/child scope. The current 364-component offline scan
reports zero HIGH/CRITICAL findings. Native isolation and actual packaged HTML
Chromium execution pass (3 → 5, shared identity, cleanup and zero egress).
The runtime retains all four previous compiler admissions and the GitHub primary;
existing source/job pins and the two historical failed-dispatch rows remain exact,
with their old compiler still ineligible. Built Files review/Commit/reopen is a
local fixture; normal-session hosted helper persistence remains open. No job is
launched by this release. [Delivery checkpoint](../../docs/progress.md#october-3--notebook-helpers-and-compiler-deployed).

## Declarative presentation settings

An optional root `opengeo.observable.json` is part of the checksummed source revision. Its closed schema is `opengeo.observable-presentation.1.0.0`, with a required plain-text `title`, optional `theme` containing `light`, `dark` or both, and optional grouped `pages` containing `{name, path}` or `{name, pages}`. Links must resolve to actual Markdown routes within the selected source root; duplicates, external destinations, unknown keys, excessive nesting and missing pages are rejected. It cannot set `root`, `output`, `base`, `head`, scripts or publication authority. This is the fallback for projects without an authored configuration, and for host callers that do not opt into isolated configuration execution as described above.

Combined-theme CSS filenames generated by Framework contain commas. Before output sealing, the compiler normalizes the known generated theme filename and its HTML references to hyphens, refusing collisions. The existing output path contract stays unchanged. Route and file checksums describe the final normalized bytes.

Browser packages may emit assets inside `dist/` subdirectories. Output validation now matches the existing database rule and permits these paths; source admission still forbids uploaded `dist/` trees. Traversal, encoded paths, private directories, secret filenames and symlinks remain rejected. The coordinator and Studio client use the same output-only distinction.

The real NOAA package regression retains its original package lock and checks every Markdown route in the source tree, grouped navigation and metadata. These changes require a new image digest, SBOM/scan and native sandbox acceptance; passing a host test does not approve an older image or deploy the runner.

## Optional incremental page cache

`--page-cache /contract/page-cache` opts into page-render reuse for Framework
builds. The directory is supplied by the trusted host through its read-only
contract mount, not by publication source. It contains `manifest.json` with an
expected `checksumSha256` and `pages.json` with the snapshot. An empty manifest
starts a cold cache. Missing, corrupt, oversized or linked files also compile
cold. A matching snapshot must additionally pass the renderer's exact project,
compiler and presentation-configuration scope checks.

The compiler writes `.opengeo-page-cache-output.json` and
`.opengeo-page-cache-result.json` at the workspace root, outside `dist`. The
coordinator must validate the build before admitting its cache to trusted private
storage. Source uploads and browser checksums are not cache provenance. The
optional Podman transport is prepared; production cache storage and activation
are not wired. See [verification and remaining work](../../docs/publication-incremental-builds-20260913.md).

```bash
npm test
npm run test:container
node src/cli.mjs \
  --contract /contract/invocation.json \
  --framework-cache /opt/opengeo-framework-cache \
  --input /input \
  --workspace /workspace \
  --observable-cli ./node_modules/.bin/observable \
  --report /result/compiler-report.json
```

Production execution remains disabled until the coordinator can stage and collect files without sharing its AWS/database identity with this process and the runner is launched with a read-only root/input/base image, an unprivileged user, no Docker socket, no task role, no egress, and enforced CPU, memory, time, file and byte limits.

The Dockerfile is pinned to the exact multi-platform Node `24.21.0-trixie-slim` manifest and a matching distroless Node runtime with libc6 `2.41-12+deb13u4`. Dependency lifecycle scripts are disabled. The cache-seed stage is allowed network access only while producing the image; the final image digest, SBOM and vulnerability scan must be reviewed before that digest is configured in OpenGeo. This compiler update does not change the separately pinned coordinator host or deploy the candidate.

An exact AMD64 manifest may be supplied through the build-only `NODE_IMAGE` argument for local image verification; deployment keeps the ARM64 default.

## Portable Project Artifact inputs (local contract)

Runner invocation `opengeo.observable-runner-invocation.3.0.0` accepts a sealed
Publication `artifactInputs` snapshot and optional archive inputs through `dataFiles`.
Its request uses `opengeo.observable-build-request.2.0.0`, binding the snapshot checksum.
Private previews verify exact retained HTML bytes and include them as ordinary compiler
assets without rebuilding the map. Public release remains unavailable. Existing
invocations remain supported. See [the Artifact contract](../../docs/project-artifacts.md)
for admission, lease authorization, image pinning and acceptance work still required.
