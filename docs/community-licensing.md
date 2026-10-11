# OpenGeo Studio licensing, attribution and contributions

Updated: October 11, 2026. Scope: the reviewed `opengeo-community` source and asset release.

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

Developed by categori.se; maintained by Aaron Kyle Dennis. The public maintainer
is `aaronkyle` (`2301690+aaronkyle@users.noreply.github.com`). This credit does not establish sole ownership of every file or replace existing copyright
holders. Publish accurate holder notices where known; do not invent ownership.

## Initial distribution

The initial artifact is a reviewed workspace **source and existing asset snapshot**,
with a fresh public repository history. It includes the selected working application
source, lockfiles, build/deployment source, documentation, reviewed reference-source
fixtures and required upstream notices. Existing browser assets include generated
font glyph PBFs, the Open Sans TTF and the supplied GeoTIFF JavaScript asset; their
upstream licenses and notices remain part of this initial artifact's review.
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

The checked register currently contains 55 direct packages, 17 platform foundations
and seven reference products. Those counts describe this local register, not a
complete transitive SBOM or legal certification. Exact binary releases need their
own transitive and operating-system inventory using existing release tooling.

## Exact findings and remaining review

| Component | Finding on October 11 | Required treatment |
| --- | --- | --- |
| First-party source | The private source checkout had no tracked root application LICENSE/NOTICE and its main npm manifests had no license field. | The community snapshot must include the Apache license and clear first-party scope, with upstream exceptions preserved. |
| `@categori/workspace-contracts` alpha.9 | Supplied `app/vendor/workspace-contracts` metadata declares Apache-2.0; LICENSE/NOTICE are present. The NOTICE credits `categori.se`. Its private package flag and older review wording remain. | Source inclusion is authorized for this community release. Preserve supplied notices and version, verify all referenced source files are included, and retain `private: true` to avoid accidental registry publication. This release does not authorize an npm/Python registry release. |
| Psycopg 3.3.4 | Installed exact-version metadata declares `License-Expression: LGPL-3.0-only` and carries LGPLv3 text. The register still says `NOASSERTION`; the readable inventory already says LGPL-3.0-only. | Reconcile the stale register against the inspected distribution before an exact binary release. Keep Psycopg under its upstream terms. The `binary` extra and bundled libraries require their own artifact review. |
| Python BiDi 0.6.11 | Installed metadata provides an LGPL classifier, GPLv3/LGPLv3 texts, authors and a Rust third-party license inventory, but no exact License-Expression. The register says LGPL-3.0-only while its notes and readable inventory acknowledge the unresolved expression. | Do not claim that the exact only/or-later expression is settled. Preserve the discrepancy and resolve it against authoritative upstream licensing before distributing its wheel or a runtime containing it. The source snapshot does not bundle that wheel. |
| JSZip 3.10.1 | Declares `(MIT OR GPL-3.0-or-later)`. | Preserve the published expression and both applicable upstream notices; record the MIT option when preparing a permissive binary distribution. |
| GPL/LGPL foundations | PostGIS, ClamAV, Poppler, GEOS, Psycopg and Python BiDi have copyleft obligations. Their present database/process/library boundaries differ. | Keep upstream licenses explicit. Review actual modifications, linking and source availability for each later shipped image. Do not assume process isolation removes the tools' own obligations or that merely using a database makes application source GPL. |
| Existing browser assets | Open Sans TTF/generated glyph PBFs have Apache LICENSE/NOTICE files. The supplied GeoTIFF JavaScript asset has its exact upstream MIT notice. GNU Unifont has a vendored complete upstream license and font exception. | Preserve exact asset identity and notices in this release. Review font distribution, generated assets and supplied library bundles separately from first-party source licensing. Shipping an Unifont license file alone does not mean the font is bundled. |
| Workspace snapshot | Targeted Git inspection found some supplied vendor/fixture notice files absent from the current index. | Export the reviewed working source and its notices, rather than relying solely on a Git archive. Do not include private tools merely to collect unrelated notice files. |

These findings are bounded local inspection of maintained contracts, registers,
manifests and two installed Python distributions. They are not an exhaustive
source-ownership audit, transitive license review, security scan or certification
that an arbitrary working tree is safe to publish. The shared inventory is not
silently rewritten by this document.

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
