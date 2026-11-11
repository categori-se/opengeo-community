# Community source status

This summary describes the reviewed public source at
[`59d40190a088`](https://github.com/categori-se/opengeo-community/tree/59d40190a08842b20712acacb360366b54c17407).
It identifies source, without assigning a binary release version or implying
that every installation runs this revision. Operators retain and verify the
exact revision and configuration they deploy.

| Area | Available source behavior |
| --- | --- |
| Catalog and maps | Inspect one Layer, review metadata and reuse persistent Layer/Style identities in saved Projects. Governed search and supported GeoNode 5.1 discovery/migration retain identity and access boundaries. |
| Authoring and metadata | Governed editing with conflict/history and Style persistence in its declared profile; administrator-defined metadata profiles, revision-preserving GeoNode 5.1.0 import/export, a 40-field report and idempotent reimport. |
| Search and navigation | Coordinate, name, address and Plus Code search, deliberate promotion to Places and named-view ordering. Further hierarchy/input work is tracked in [#21](https://github.com/categori-se/opengeo-community/issues/21). |
| Local Projects and Print | Device saves and editable backups; saved page layouts, reusable templates, main/inset capture and declared SVG, PNG, HTML and PDF output profiles. Export detail and source rights remain explicit. |
| Analysis | Bounded browser/PostGIS operations and Baseline review tools preserve source versions, assumptions and interpretation limits. Configured worker jobs require deliberate activation. |
| Publications and exchange | Versioned source editing, native compilation, private preview, review and approved publication destinations; supported metadata, Project and GIS-client exchange profiles. |

The [capability guide](docs/community-capabilities.md) owns supported operations,
version-specific profiles and limits. The [workflow guide](docs/community-workflow.md)
and [examples](docs/community-examples.md) show how to use them.

## Installation and verification limits

Selected local checks cover upload, styling, Project save/reopen after database
restart, publication permissions and native Framework build/preview/publication.
Those checks include synthetic identity and local transport substitutes. They do
not establish a fresh independent installation's sign-in, provider connections,
HTTPS/CDN delivery or complete native Notebook execution. The authoring and
metadata profiles have separately scoped production checks recorded in
[#11](https://github.com/categori-se/opengeo-community/issues/11) and
[#20](https://github.com/categori-se/opengeo-community/issues/20).

Optional processing, external PostGIS and managed execution need the configuration
and acceptance stated in their guides. Distributing containers also requires
security and license review of the exact images. Whole-application accessibility,
complete device coverage, ISO/OGC certification and PDF/UA conformance are not
established by these scoped profiles.

[COMMUNITY-RELEASE.json](COMMUNITY-RELEASE.json) records the source offering and
its scoped verification. A maintainer-hosted example does not validate another
operator's installation. Use the [installation and handover guide](docs/community-deployments.md)
to assign identity, data, operating costs, updates, backups and recovery responsibilities.

The community edition contains the full suite of tools. Hosting and enterprise
support are separately agreed services for the same software; receiving source
does not transfer the main instance, its accounts, data or provider agreements.
See [SUPPORT.md](SUPPORT.md).

The [roadmap](ROADMAP.md) lists next outcomes, and [CONTRIBUTING.md](CONTRIBUTING.md)
explains how to report problems or contribute. Linked issues and merged pull
requests retain change details.
