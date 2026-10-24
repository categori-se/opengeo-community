# OpenGeo Studio licensing, attribution and contributions

Updated: October 23, 2026 for targeted attribution and source-asset corrections. Scope: the reviewed `opengeo-community` source and asset release; the October 11 inspection remains historical evidence.

## License scope

Release first-party application source under **Apache-2.0**, covering Studio,
Catalog, Projects, Layers, Styles, Publications, APIs, migrations and the source
needed to build and operate the included workflows. Apply this grant only to
material the releaser has authority to license. Preserve separately licensed
upstream material under its original terms; a root license cannot replace them.

The community edition includes the full suite of tools and the source needed to
build and operate them, including Studio, collaboration, GIS processing and
publication infrastructure. It does not require a proprietary application module.
Apache-2.0 permits use,
modification and redistribution, including commercial use, under its terms. Keep
required notices and upstream licenses, and preserve contributors' rights. See
the [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

Hosting and enterprise support are offered as fee-based services for the same
software and do not change the community source license. See
[support and service inquiries](../SUPPORT.md#hosting-and-enterprise-support)
for contact details; engagement scope, terms and availability are agreed separately.

Developed and maintained by Aaron Kyle Dennis for categori.se. Upstream files
retain their original copyright holders and license notices.

## Initial distribution

The initial artifact is a reviewed workspace **source and existing asset snapshot**,
with a fresh public repository history. It includes the selected working application
source, lockfiles, build/deployment source, documentation, reviewed reference-source
fixtures and required upstream notices. Existing browser assets include generated
font glyph PBFs and the Open Sans TTF. The GeoTIFF asset generator is source code;
it injects the retained upstream MIT notice when a later build creates its browser
bundle. These upstream licenses and notices remain part of this artifact's review.
It excludes raw private Git history, credentials, operational receipts, private
account fixtures, private recovery tools and hosted/customer datasets.

No dependency wheels, installed dependency directories, runtime container images
or newly compiled application bundles are distributed by this initial export.
Dependency manifests remain instructions for obtaining separately licensed
upstream packages. Preserve exact identities and license/notice files for the
existing assets included now. If later releases add binaries, fonts, compiled
bundles or images, review their exact contents, licenses, notices and source
obligations before publishing them. This release does not certify future binary
artifacts or the rights to every externally downloaded dataset.

## Retained upstream record

Keep the existing [foundation inventory](open-source-foundations.md) and
[machine-readable register](../governance/open-source-foundations.json) as the
running dependency record. Preserve README acknowledgements, upstream source
links, pinned reference versions, standards references, modifications and useful
limitations. Distinguish runtime dependencies, development/test peers and products
that inform requirements; reference-product acknowledgement does not mean their
code is included or that they endorse OpenGeo Studio.

For every included upstream source or asset, keep its applicable copyright,
LICENSE and NOTICE files beside it. Include a readable release-level NOTICE/index
pointing to these terms. Identify modified upstream files and retain the original
license choices. Apache notices are attribution material, not extra license
restrictions; see [Apache-2.0 section 4](https://www.apache.org/licenses/LICENSE-2.0).

The checked register currently contains 60 direct packages, 20 platform foundations
and 7 reference products. Those counts describe this local register, not a
complete transitive SBOM or legal certification. Exact binary releases need their
own transitive and operating-system inventory using existing release tooling.
Its September 19 `reviewedAt` date describes a historical partial review, not
perpetual approval of the current dependency tree or a later release artifact.

## Public recognition and build notices

Print pages now retain source credits and recorded Layer license text, or state
that a license is not recorded. Hiding optional source notes does not remove these
texts. This locally accepted change awaits delivery and does not infer missing terms.

The community [acknowledgments](../ACKNOWLEDGEMENTS.md) distinguish
incorporated software, configured backend foundations, optional engines,
reference projects, data communities and hosting infrastructure. The public
`/credits` page ships with Studio and both Demo build variants; it is accessible
without sign-in and links to local license and source records. Operators may
add installation-specific credit while retaining the original notices.

The maintained builds collect the installed direct app dependencies' supplied
license/NOTICE text into `third-party-notices.txt`, verify their versions against
the lockfile, and write `third-party-inventory.json`. That inventory also indexes
separately shipped notice files by artifact path and checksum, and records missing
license text explicitly. The Print converters add jsPDF 4.2.1 and svg2pdf.js 2.8.1
under their supplied MIT terms, crediting James Hall, yWorks GmbH, Vitaly Puzrin and
contributors. Their required and installed optional closure is separately retained,
including embedded browser-source legal comments, installed HTML/canvas integrations
and type-only packages such as `@types/pako`.
Package versions and npm installation-receipt integrities must match contextual
app-lock entries; this does not rehash installed files. The current-lock clean install
now independently preserves Monaco’s DOMPurify 3.4.8, Cesium’s 3.4.16 and jsPDF’s optional
3.4.17 in their own dependency contexts; converter identities and bytes match the
accepted PDF inputs. Absent optional packages
are recorded explicitly; development and peer-only dependencies do not expand this closure. The index
includes build dependencies and optional SDKs; it does
not claim every listed package runs on every page. It is not a complete transitive
bundle trace, container SBOM or approval to redistribute an unresolved component.

The October 22 external review's priorities are useful: make recognition visible,
retain exact upstream notices, preserve contextual map credit, and automate drift
checks. Apply them with these limits:

- Credit actual software separately from workflow references. Optional Mapbox GL
  JS is proprietary; do not describe all optional engines as open source.
- A direct dependency register and this browser notice index do not establish
  complete binary license coverage. Preserve the existing exact-release review
  for bundled transitive code, wheels, native libraries and container packages.
- General thanks do not replace source-specific credits in maps or their outputs.
  The [OSMF guidance](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
  distinguishes interactive maps, static images and printed maps. Existing focused
  print/export evidence is retained; this increment does not verify every renderer,
  provider, mobile view or publication path.
- The existing foundation check now compares direct-package identities, versions
  and license expressions with the readable tables and summary counts. Historical
  review dates stay historical. The public core job reuses the same notice and
  release-contract tests; no new build matrix or remote run is introduced.

Local Studio and browser Demo builds and anonymous/mobile notice-link checks pass.
The browser Demo's source-package dependency closure is now 38,353 bytes under its
unchanged 64 KiB limit; its local notices retain the unresolved license evidence
listed below. Neither source publication, binary-distribution license approval nor
hosted deployment is established by these local checks.

## Exact findings and remaining review

| Component | Finding and verification | Required treatment |
| --- | --- | --- |
| First-party source | The private source checkout had no tracked root application LICENSE/NOTICE and its main npm manifests had no license field. | The community snapshot must include the Apache license and clear first-party scope, with upstream exceptions preserved. |
| `@categori/workspace-contracts` alpha.9 | Supplied `app/vendor/workspace-contracts` metadata declares Apache-2.0; LICENSE/NOTICE are present. The NOTICE credits `categori.se`. Its private package flag and older review wording remain. | Source inclusion is authorized for this community release. Preserve supplied notices and version, verify all referenced source files are included, and retain `private: true` to avoid accidental registry publication. This release does not authorize an npm/Python registry release. |
| Psycopg 3.3.4 | October 11 installed metadata reported LGPL-3.0-only and LGPLv3 text. October 22 verification of the [exact upstream package metadata](https://github.com/psycopg/psycopg/blob/3.3.4/psycopg/pyproject.toml) confirms LGPL-3.0-only; the register and readable inventory now agree. | Keep Psycopg under its upstream terms. The `binary` extra and bundled libraries still require their own artifact review; correcting this expression does not approve their distribution. |
| Python BiDi 0.6.11 | Installed metadata has an LGPL classifier without an exact License-Expression. October 23 offline inspection confirms explicit LGPL-3.0-or-later grants in `bidi/__init__.py` and `bidi/algorithm.py`, full GPLv3/LGPLv3 texts and authors. The shipped 19-crate declaration list differs from the installed 14-component CycloneDX SBOM; neither supplies complete crate notices. The exact [Rust manifest](https://github.com/MeirKriheli/python-bidi/blob/v0.6.11/Cargo.toml) has no package license field. | Keep whole-package `NOASSERTION`. Resolve the Rust wrapper grant, reconcile exact compiled dependencies and retain complete applicable notices, including the bundled `libgcc_s` library. The declaration list alone does not establish the binary inventory. The source snapshot does not bundle this wheel. |
| JSZip 3.10.1 | Declares `(MIT OR GPL-3.0-or-later)`. | Preserve the published expression and both applicable upstream notices; record the MIT option when preparing a permissive binary distribution. |
| PMTiles 4.4.1 | The npm package omits its complete notice. October 23 recovery uses the exact version's registry integrity and source commit `0cebcaeade40034b86facb6e7da4ec726b9053fb`; the [complete upstream notice](https://github.com/protomaps/PMTiles/blob/0cebcaeade40034b86facb6e7da4ec726b9053fb/LICENSE) is retained [locally](../app/src/assets/licenses/pmtiles-4.4.1.LICENSE.txt), with its Git blob and SHA-256 verified. | The maintained browser notice generator requires the exact package identity and text checksum, includes the full notice and copies a local notice file. Review these pins on dependency upgrades. Specification/sample-data rights and provider attribution remain separate. This closes the missing PMTiles text for the next prepared bundle; existing hosted bundles are unchanged. |
| GPL/LGPL foundations | PostGIS, ClamAV, Poppler, GEOS, Psycopg and Python BiDi have copyleft obligations. Their present database/process/library boundaries differ. | Keep upstream licenses explicit. Review actual modifications, linking and source availability for each later shipped image. Do not assume process isolation removes the tools' own obligations or that merely using a database makes application source GPL. |
| Existing browser assets | Open Sans TTF/generated glyph PBFs have Apache LICENSE/NOTICE files. The GeoTIFF asset generator injects its exact retained upstream MIT notice into later built bundles; this source snapshot contains the generator rather than a precompiled bundle. GNU Unifont has a vendored complete upstream license and font exception. | Preserve exact asset identity and notices in this release. Review font distribution, generated assets and supplied library bundles separately from first-party source licensing. Shipping an Unifont license file alone does not mean the font is bundled. |
| Workspace snapshot | Targeted Git inspection found some supplied vendor/fixture notice files absent from the current index. | Export the reviewed working source and its notices, rather than relying solely on a Git archive. Do not include private tools merely to collect unrelated notice files. |

These findings combine bounded October 11 local inspection of maintained contracts,
registers, manifests and two installed Python distributions with the targeted
October 22 upstream metadata verification above. They are not an exhaustive
source-ownership audit, transitive license review, security scan or certification
that an arbitrary working tree is safe to publish.

Keep software licenses separate from provider service terms, data licenses,
attribution requirements and application authorization. Unknown redistribution
rights remain unknown. Public sample data must have an explicit release basis;
private storage access or an anonymous download is not that basis.

## Contributions: inbound equals outbound

Accept community contributions under the same license as the affected file.
First-party contributions use Apache-2.0; upstream-derived files retain their
applicable terms. This follows [Apache-2.0 section 5](https://www.apache.org/licenses/LICENSE-2.0).
Contributors retain their copyright. There is no copyright assignment or CLA.

Each submitted commit must carry a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Contributors should review that certificate before using `git commit -s` and use
an identity/contact address they are willing to publish. Sign-off records are
public and retained. A sign-off is an origin certification, not a transfer of
copyright or a substitute for preserving third-party notices.

Maintainers check origin, affected licenses and required attribution during
review. Contributions containing employer-owned or third-party material need
the corresponding submission rights. The project cannot unilaterally revoke
contributors' grants or claim exclusive ownership of their contributions.

## History and acknowledgements

Retain the original private repository and its history. In the public snapshot,
preserve existing file-level authorship, required upstream credits and a reviewed
contribution/provenance summary. Record the source checkpoint and selected source
mapping privately without exposing private paths, account identities or receipts.
Preserve public contribution history normally after the initial release.

Do not manufacture missing author identities or publish private commit email
addresses merely to create a contributor list. Keep unknown historical authorship
explicit. Update acknowledgements and the existing foundation register when
new material is added; avoid a second competing license inventory.
