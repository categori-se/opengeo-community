# Open-Source Foundations And License Inventory

Status: maintained dependency index. Targeted attribution corrections: 2026-10-23. Checked register: [`../governance/open-source-foundations.json`](../governance/open-source-foundations.json).

The register's `reviewedAt: 2026-09-19` records the [historical eight-package review](../governance/foundation-inventory-review-20260919.json), not a current review of every entry. Later corrections carry their own evidence; neither date approves a release artifact.

OpenGeo Studio depends on substantial open-source work. This page makes those foundations visible to engineers, security and release teams, product owners, and external readers. It distinguishes software that ships with OpenGeo Studio from software used only for development, independent verification, or product research.

This engineering inventory supports release and legal review. The licenses and notice files shipped by each upstream project remain authoritative.

## What The Inventory Covers

The checked register contains:

- every direct dependency declared in the repository's npm and Python project manifests;
- explicitly selected runtime foundations, base distributions, GIS tools, document tools, and fonts;
- source-audited open-source products used as behavioral or interoperability references; and
- the source of each license attribution.

Release software bills of materials (SBOMs) add transitive npm/Python packages and operating-system packages from the exact lockfiles and container image digests. Architecture documents cover managed AWS services. Parity documents cover Google Earth Pro as a proprietary behavioral reference. The inventory records published source licenses and separately identified private local package boundaries.

Run the coverage and attribution check with:

```bash
npm run foundations:check
```

The check fails for a missing or stale direct dependency, unresolved npm version, npm license mismatch, unsafe/missing evidence path, duplicate entry, missing source/license reference, stale readable package/version/license row, or stale register counts in the community licensing guide. It checks inventory consistency; it does not certify transitive or binary distribution compliance.

Local npm links resolve to their declared, repository-contained lock target and
actual package metadata. The private `@categori/workspace-contracts` alpha.9 source
now declares Apache-2.0 and includes LICENSE/NOTICE. The lock and inventory record
that supplied license exactly, while retaining its private registry/publication
review boundary. This synchronization assigns no new license or registry release
permission. Version, source containment and license agreement remain checked;
application code and dependency versions are unchanged.

## Hosted Services Are Tracked Separately

`UX-007B` can connect a project to the hosted Protomaps API. That optional service integration does not add a software package to an OpenGeo Studio build and is therefore absent from the checked open-source dependency register. PMTiles, the Protomaps-originated library OpenGeo Studio ships, remains inventoried below under its BSD-3-Clause license. A live hosted connection separately requires provider terms, attribution, allowed-site, availability, usage, privacy, and cost review. The current local evidence uses a deterministic intercepted provider response and makes no live-service or licensing acceptance claim.

## Browser And JavaScript Foundations

| Package | Resolved version | Role | License |
| --- | ---: | --- | --- |
| [Observable Framework](https://github.com/observablehq/framework) | 1.13.4 | Studio/static application framework and isolated publication compiler | ISC |
| [Observable Plot](https://github.com/observablehq/plot) | 0.6.17 | Charts and statistical visualization | ISC |
| [D3](https://github.com/d3/d3) | 7.9.0 | Data transformation and visualization utilities | ISC |
| [Earcut](https://github.com/mapbox/earcut) | 3.2.3 | Lazy projected polygon topology for bounded measurement | ISC |
| [Noble Hashes](https://github.com/paulmillr/noble-hashes) | 2.0.1 | Incremental browser archive hashing | MIT |
| [Lezer HTML parser](https://github.com/lezer-parser/html) | 1.3.13 | Source-position-aware Notebook editing | MIT |
| [Workspace contracts](../app/vendor/workspace-contracts) | 0.1.0-alpha.9 | Supplied private local contracts; registry publication review remains separate | Apache-2.0 |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | Size-limited browser ZIP handling | MIT |
| [jsPDF](https://github.com/parallax/jsPDF) | 4.2.1 | Explicit browser vector PDF generation and geographic registration in Print | MIT |
| [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | 2.8.1 | Convert the existing Print SVG scene into vector PDF through jsPDF | MIT |
| [MathJax source](https://github.com/mathjax/MathJax-src) | 4.1.3 | Lazy local TeX equation layout for saved Print layouts and SVG/PDF output | Apache-2.0 |
| [MathJax original TeX font software](https://github.com/mathjax/MathJax-fonts) | 4.1.0 | Equation metrics and SVG glyph paths; font-outline OFL terms are recorded separately | Apache-2.0 |
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | 6.4.1 | Primary 2D/globe/terrain renderer | BSD-3-Clause |
| [Mapbox GL JS](https://github.com/mapbox/mapbox-gl-js/tree/v3.30.0) | 3.30.0 | Optional proprietary renderer requiring the user's public token and separate provider terms; MapLibre remains the default | SEE LICENSE IN LICENSE.txt |
| [MapLibre Style Spec](https://github.com/maplibre/maplibre-style-spec) | 26.4.4 | Shared native-renderer expression evaluation | ISC |
| [RBush](https://github.com/mourner/rbush) | 4.0.1 | Native label screen-space collision index; reused installed dependency | MIT |
| [CesiumJS](https://github.com/CesiumGS/cesium/tree/1.145) | 1.145.0 | Optional native globe/scene adapter; Workbench integration pending | Apache-2.0 |
| [PMTiles](https://github.com/protomaps/PMTiles) | 4.4.1 | Range-addressed tile archives | BSD-3-Clause |
| [hyparquet](https://github.com/hyparam/hyparquet) | 1.31.1 | Lazy, bounded browser Parquet column reads | MIT |
| [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors) | 1.1.2 | Browser Parquet codecs, including Zstandard | MIT |
| [GeoTIFF.js](https://github.com/geotiffjs/geotiff.js) | 3.1.0-beta.0 | Bounded browser COG windows; exact existing OpenLayers dependency | MIT |
| [Proj4js](https://github.com/proj4js/proj4js) | 2.22.0 | Referenced COG pixel reprojection | MIT |
| [Mapbox Vector Tile](https://github.com/mapbox/vector-tile-js) | 2.0.5 | Development/test vector-tile parsing | BSD-3-Clause |
| [MapLibre geojson-vt](https://github.com/maplibre/geojson-vt) | 6.1.0 | Development/test GeoJSON tiling | ISC |
| [MapLibre vt-pbf](https://github.com/maplibre/vt-pbf) | 4.3.2 | Development/test vector-tile encoding | MIT |
| [jsdom](https://github.com/jsdom/jsdom) | 23.2.0 | Component and DOM contract tests | MIT |
| [OpenLayers](https://github.com/openlayers/openlayers) | 10.10.0 | Browser geometry/projection/exchange utilities and independent service-client checks | BSD-2-Clause |
| [pbf](https://github.com/mapbox/pbf) | 4.0.2 | Protocol-buffer test support | BSD-3-Clause |
| [Playwright](https://github.com/microsoft/playwright) | 1.61.1 | Managed-browser and live acceptance | Apache-2.0 |
| [PGlite](https://github.com/electric-sql/pglite) | 0.5.8 | Embedded migration/RLS tests | Apache-2.0 |
| [AWS CDK library](https://github.com/aws/aws-cdk) | 2.265.0 | Infrastructure definitions | Apache-2.0 |
| [Constructs](https://github.com/aws/constructs) | 10.8.1 | CDK construct model | Apache-2.0 |
| [Node type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.13.3 | Infrastructure type checking | MIT |
| [AWS CDK CLI](https://github.com/aws/aws-cdk-cli) | 2.1137.0 | Infrastructure synthesis/deployment tool | Apache-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.12 | TypeScript execution for tests/tools | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9.3 | Infrastructure static typing | Apache-2.0 |
| [@observablehq/notebook-kit](https://github.com/observablehq/notebook-kit) | 2.5.6 | Notebook authoring and execution support in Studio and the isolated publication compiler. | ISC |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 14.3.3 | Markdown parsing for authored publication content in Studio. | MIT |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | 0.56.0 | Code editing for authored sources in the Studio workbench. | MIT |
| [path-browserify](https://github.com/browserify/path-browserify) | 1.0.1 | Browser path operations used by notebook and authored-source tooling. | MIT |
| [@observablehq/inputs](https://github.com/observablehq/inputs) | 0.12.0 | Observable notebook input widgets bundled by the publication compiler. | ISC |
| [esbuild](https://github.com/evanw/esbuild) | 0.28.2 | Bundle notebook runtime assets inside the isolated publication compiler. | MIT |
| [htl](https://github.com/observablehq/htl) | 0.3.1 | Hypertext Literal templates for compiled Observable notebook output. | ISC |
| [jszip](https://github.com/Stuk/jszip) | 3.10.1 | Read and package notebook assets in the isolated publication compiler. | (MIT OR GPL-3.0-or-later) |

Versions and licenses in this table are checked against the corresponding `package-lock.json` metadata. This dependency inventory includes the separately licensed proprietary Mapbox option; inclusion here does not make it open source or grant distribution rights.

The October 23 Print converters credit James Hall, yWorks GmbH, Vitaly Puzrin and
the jsPDF/svg2pdf.js contributors. Generated browser notices preserve their supplied
MIT text and embedded browser-distribution legal comments, including Microsoft
helper permissions. The bounded converter closure follows required and installed
optional dependencies, including installed HTML/canvas integrations and type-only
packages such as `@types/pako`. This does not assert that every package contributes
executable code to an output. Versions and npm installation-receipt
integrities must match contextual app-lock identities, including fast-png's nested
pako 2.2.0. Absent optional packages are recorded explicitly without requiring an
install; development and peer-only dependencies are excluded. This targeted closure does not certify all other
transitive packages or a future binary distribution.

MathJax has a separate required and installed optional dependency inventory,
with the same contextual lock and installation-receipt checks. Its software
Apache 2.0 declaration does not replace font rights. All 22 installed original
TeX font name tables identify SIL OFL 1.1: 20 credit MathJax Inc. (2022); two
retain Design Science Inc. (2009–2010) and Reserved Font Name `MathJax_Main`.
The complete OFL and exact supplied notices accompany standalone equation
outlines. The installed New Computer Modern dependency separately identifies
Antonis Tsolomitis and the GUST Font License, with MathJax Inc. (2024) additions
in 21 of its 105 font files; it is not the selected equation font. These package
notices do not assert that every dependency contributes code or font outlines
to a browser bundle or output.

Observable Framework's current transitive build tree is locked with reviewed overrides for `tar` 7.5.22, `js-yaml` 3.15.1, `linkify-it` 5.0.2, `brace-expansion` 2.1.7, and `esbuild` 0.28.2. The guided preparation and CI run `npm audit --omit=dev --audit-level=high`; on 2026-08-27 the corrected tree reported zero vulnerabilities. This dated advisory result complements the version/license inventory and must be reevaluated by each current CI run. October 5 local release preparation found the MapLibre attribution [critical advisory](https://github.com/maplibre/maplibre-gl-js/security/advisories/GHSA-jrc7-96c5-q579) and brace-expansion high findings. Exact pins6.4.1/2.1.7 clear the current npm high/critical gate; three moderate findings remain. The GeoTIFF browser asset retains the exact [v3.1.0-beta.0 MIT notice](https://github.com/geotiffjs/geotiff.js/blob/v3.1.0-beta.0/LICENSE).

## Python API And Worker Foundations

| Package | Exact version | Role | License |
| --- | ---: | --- | --- |
| [Arabic Reshaper](https://github.com/mpcabd/python-arabic-reshaper) | 3.0.1 | Arabic-family print shaping | MIT |
| [cryptography](https://github.com/pyca/cryptography) | 50.0.0 | Cryptographic primitives | Apache-2.0 OR BSD-3-Clause |
| [FastAPI](https://github.com/fastapi/fastapi) | 0.141.1 | HTTP API framework | MIT |
| [httpx2](https://github.com/pydantic/httpx2) | 2.12.0 | Policy-controlled outbound HTTP | BSD-3-Clause |
| [Psycopg](https://github.com/psycopg/psycopg) | 3.3.4 | PostgreSQL adapter | LGPL-3.0-only |
| [Pydantic Settings](https://github.com/pydantic/pydantic-settings) | 2.15.0 | Typed runtime configuration | MIT |
| [PyJWT](https://github.com/jpadilla/pyjwt) | 2.14.0 | JWT validation | MIT |
| [pygeofilter](https://github.com/geopython/pygeofilter) | 0.4.0 | Bounded OGC CQL2 parsing | MIT |
| [Python BiDi](https://github.com/MeirKriheli/python-bidi) | 0.6.11 | Bidirectional print layout | LGPL family; exact SPDX expression is `NOASSERTION` pending upstream/legal confirmation; wheel includes separately inventoried Rust libraries |
| [Uvicorn](https://github.com/Kludex/uvicorn) | 0.52.3 | ASGI container server | BSD-3-Clause |
| [DuckDB](https://github.com/duckdb/duckdb) | 1.5.5 | In-process analytics | MIT |
| [GeoPandas](https://github.com/geopandas/geopandas) | 1.1.4 | Vector/tabular geospatial operations | BSD-3-Clause |
| [Apache Arrow/PyArrow](https://github.com/apache/arrow) | 25.0.0 | Arrow/Parquet interchange | Apache-2.0 |
| [Rasterio](https://github.com/rasterio/rasterio) | 1.5.0 | Raster access and transforms | BSD-3-Clause |
| [rio-cogeo](https://github.com/cogeotiff/rio-cogeo) | 7.0.2 | Cloud Optimized GeoTIFF creation/validation | BSD-3-Clause |
| [Shapely](https://github.com/shapely/shapely) | 2.1.2 | Geometry operations | BSD-3-Clause; uses LGPL GEOS |

These direct requirements are exact-versioned in `pyproject.toml` and hash-locked, including transitive packages, in each service's `requirements.lock`.

The October 22 correction reconciled Psycopg with its [3.3.4 package metadata](https://github.com/psycopg/psycopg/blob/3.3.4/psycopg/pyproject.toml), which explicitly declares LGPL-3.0-only. Its binary extra and bundled libraries still need artifact-specific review. Python BiDi's [v0.6.11 package metadata](https://github.com/MeirKriheli/python-bidi/blob/v0.6.11/pyproject.toml) supplies an LGPL classifier without a complete expression; the [Python algorithm file](https://github.com/MeirKriheli/python-bidi/blob/v0.6.11/bidi/algorithm.py) explicitly permits LGPL version 3 or later. The register therefore records `NOASSERTION` for the whole mixed Python/Rust package until its complete license scope is resolved. The community source snapshot does not bundle these wheels.

## Runtime And Toolchain Foundations

| Foundation | Selected version or source | Used for | License record |
| --- | --- | --- | --- |
| [Python](https://github.com/python/cpython) | 3.13.15 | API and verifier runtime | PSF-2.0 |
| [Node.js](https://github.com/nodejs/node) | 24.19.0 | Build, publication compiler, coordinator | MIT |
| [Alpine Linux](https://gitlab.alpinelinux.org/alpine) | 3.23 API base | Minimal API image | Multiple package licenses; SBOM required |
| [Debian](https://salsa.debian.org/) | 13 publication-builder base | Node builder/distroless filesystem | Multiple package licenses; SBOM required |
| [Ubuntu](https://code.launchpad.net/ubuntu) | 24.04 ARM64 build host and OSGeo image base | Transient builds and GIS worker | Multiple package licenses; AMI/image SBOM required |
| [AWS CLI](https://github.com/aws/aws-cli) | AWS-published v2 Snap; exact installed version captured per transient build | Development-account build and deployment operations | Apache-2.0 |
| [Distroless](https://github.com/GoogleContainerTools/distroless) | digest-pinned Node 24/Debian 13 | Reduced publication runtime | Apache-2.0 project; contained packages vary |
| [PostgreSQL](https://www.postgresql.org/) | Aurora-compatible engine selected by infrastructure | Authoritative relational/RLS store | PostgreSQL License |
| [PostGIS](https://github.com/postgis/postgis) | Runtime extension | Spatial store and predicates | GPL-2.0-or-later |
| [GDAL/OGR](https://github.com/OSGeo/gdal) | 3.13.0 OSGeo image | Raster/vector formats, CRS, transformation | MIT-style core; drivers/bundled libraries vary |
| [PROJ](https://github.com/OSGeo/PROJ) | From pinned OSGeo image | CRS definitions and transformations | MIT |
| [GEOS](https://github.com/libgeos/geos) | From OSGeo image/Shapely | Computational geometry | LGPL-2.1-or-later |
| [Tippecanoe](https://github.com/felt/tippecanoe) | 2.79.0 | Vector-tile generation | BSD-2-Clause |
| [ClamAV](https://github.com/Cisco-Talos/clamav) | Pinned worker-image package | Upload malware scanning | GPL-2.0-only |
| [Poppler](https://gitlab.freedesktop.org/poppler/poppler) | Pinned worker-image package | PDF inspection/text/raster preview | GPL-2.0-or-later |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | Pinned worker-image package and selected language data | Resource-limited OCR | Apache-2.0 |
| [MathJax and original TeX glyphs](https://www.mathjax.org/) | Source 4.1.3; TeX font 4.1.0 | Local Print mathematical layout and vector equation glyphs | Apache-2.0 software; OFL-1.1 font outlines and exact source notices |
| [GNU Unifont](https://savannah.gnu.org/projects/unifont) | 17.0.04 checksum-pinned from redundant GNU mirrors; full license vendored | Deterministic multilingual print glyphs | GPL-2.0-or-later WITH Font-exception-2.0 |
| [Open Sans generated map glyphs](https://src.fedoraproject.org/rpms/open-sans-fonts) | Open Sans 1.10 from Fedora `1.10-24.fc43`; `opengeo-open-sans-v1` asset version 1 | Shared exact-version browser/saved-map glyphs and original font for native Cesium labels | Apache-2.0; [vendored license](../app/src/assets/render-fonts/opengeo-open-sans-v1/1/LICENSE.txt) and [attribution notice](../app/src/assets/render-fonts/opengeo-open-sans-v1/1/NOTICE.txt) |
| [Maki symbol assets](https://github.com/mapbox/maki/tree/6ab50f392294aeb20b3af83e8a10067151876eb9) | 8.2.0; exact published archive checksum in the checked register | All 215 Point icons, generated locally with white glyphs and a dark halo; loaded on demand | CC0-1.0; [retained license, source pin and contributor credit](../app/src/data/symbology-sources.json) |
| [OpenStreetMap Carto symbol assets](https://github.com/openstreetmap-carto/openstreetmap-carto/commit/1cc4b89c48e4385b607d63156d6f8f1eea8b35a2) | Exact commit `1cc4b89c48e4` after v6.1.0; archive checksum in the checked register | All 998 source images: 921 Point/shield choices and 77 separate line/pattern reference previews, preserving source colors; separate on-demand payloads | CC0-1.0; [retained license, source pin and contributor credit](../app/src/data/symbology-sources.json) |

The Open Sans glyph manifest pins the source font, license, coverage, generator and generated PBF bytes. The separate attribution notice preserves the source font's embedded copyright and identifies the generated files; it is intentionally outside the frozen version-1 manifest. Ship both notice and license with the glyph assets. This records the exact Apache-licensed 1.10 font, not an asserted upstream commit or a newer release. TinySDF 2.2.0 (BSD-2-Clause) is already locked transitively in the app's build tree; generating these assets adds no runtime package and its build-tool attribution remains part of the transitive SBOM.

The inventory records `NOASSERTION` for Linux distributions because assigning one license to a distribution image would be misleading. Exact images are digest-pinned; the image SBOM and installed license files determine the release obligations.

## Open-Source Reference Products

These products inform requirements or execute as isolated test peers. OpenLayers
also supplies browser geometry, projection and exchange utilities and is a
declared runtime dependency. It is not a selectable Studio renderer. The other
references remain separate from the OpenGeo Studio application runtime.

| Product | Pinned reference | Relationship | License |
| --- | ---: | --- | --- |
| [QGIS](https://github.com/qgis/QGIS) | 3.44.12 | Source/workflow audit and native-client checks | GPL-2.0-or-later |
| [GeoLibre](https://github.com/opengeos/GeoLibre) | 2.6.0 | Browser GIS and portable-project reference | MIT |
| [GeoNode](https://github.com/GeoNode/geonode) | 5.1.0 | Governance/catalog reference | GPL-2.0-or-later |
| [GeoServer](https://github.com/geoserver/geoserver) | 3.0.1 | Service-engine reference and disposable peer | GPL-2.0-or-later |
| [MapServer](https://github.com/MapServer/MapServer) | 8.6.5 | Render/service reference and disposable peer | MIT |
| [GeoMoose](https://github.com/geomoose/gm3) | 3.15.2 | Web GIS portal reference | MIT |
| [OpenLayers](https://github.com/openlayers/openlayers) | 10.10.0 | Browser utility dependency, web-client reference and independent peer | BSD-2-Clause |

The exact source identity and license evidence for each reference are stored in the corresponding `parity/fixtures/*-source-lock.json` file. A reviewed dependency decision governs any reference code introduced into OpenGeo Studio.

## License Index

| Expression | Upstream terms | Release-team treatment |
| --- | --- | --- |
| [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html) | Permissive license with notice and patent terms | Preserve license and applicable NOTICE/attribution material. |
| [BSD-2-Clause](https://spdx.org/licenses/BSD-2-Clause.html), [BSD-3-Clause](https://spdx.org/licenses/BSD-3-Clause.html), [ISC](https://spdx.org/licenses/ISC.html), [MIT](https://spdx.org/licenses/MIT.html) | Permissive licenses | Preserve copyright and license notices; honor non-endorsement where applicable. |
| [LGPL-2.1-or-later](https://spdx.org/licenses/LGPL-2.1-or-later.html), [LGPL-3.0-only](https://spdx.org/licenses/LGPL-3.0-only.html) | Library copyleft | Preserve license/source information and review linking, replacement, modification, and distribution obligations. |
| [GPL-2.0-only](https://spdx.org/licenses/GPL-2.0-only.html), [GPL-2.0-or-later](https://spdx.org/licenses/GPL-2.0-or-later.html) | Copyleft | Keep these tools isolated where designed; review source and distribution obligations for every shipped image. |
| [PSF-2.0](https://spdx.org/licenses/PSF-2.0.html) | Python Software Foundation license | Preserve Python license and notices in distributed runtime material. |
| [PostgreSQL](https://spdx.org/licenses/PostgreSQL.html) | PostgreSQL permissive license | Preserve copyright and permission notice. |
| `GPL-2.0-or-later WITH Font-exception-2.0` | GNU Unifont terms and font embedding exception | Ship the complete vendored upstream license text already copied into the API images. |
| `NOASSERTION` | A collection has no honest single expression, or upstream metadata is insufficient to choose an exact SPDX expression | Generate and review exact component/package metadata and included license files; resolve direct-package ambiguity before public distribution. |

This short treatment provides release checklist prompts. Legal review and the upstream license texts determine distribution obligations.

## Adding Or Upgrading A Foundation

1. Ask the capability owner to justify the dependency and identify the module or interface it serves.
2. Pin or lock the version and integrity data using the ecosystem's maintained manifest.
3. Add or update the checked register with source, purpose, ownership paths, SPDX expression, and exact license evidence.
4. Run `npm run foundations:check`, unit/integration tests for the consumer, vulnerability scanning, and image/release SBOM generation.
5. Review the direct package together with transitive packages, native libraries, data files, fonts, codecs, and NOTICE/source-offer requirements.
6. Update this readable summary when the foundation is important enough to affect architecture, security, cost, interoperability, or product behavior.

A dependency upgrade is complete after its attribution, security, runtime, interoperability, and release checks pass.
