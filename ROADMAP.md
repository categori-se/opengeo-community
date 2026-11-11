# OpenGeo Studio roadmap

Improve recurring tasks that make a study useful: inspect sources, save and
reopen a map, explain findings, share an output and update it later. The
[capability guide](docs/community-capabilities.md) owns available operations and
limits. This roadmap identifies the next user outcomes.

| Priority | Next useful outcome | Where to start |
| --- | --- | --- |
| 1. Finish the four remaining comparisons | Complete the named service, history/panorama, tour/media and overlay gaps, preserving accepted Print and GeoLibre workflows. | [Remaining comparison work](docs/reference-applications.md#remaining-comparison-work). Reuse accepted outcomes and ship related source together through required release gates. |
| 2. Release the accepted search/navigation workflow | Users search coordinates, names, addresses and Plus Codes, organize Places/Layers, and return to named views with clear input and recovery behavior. | [Search and navigation #21](https://github.com/categori-se/opengeo-community/issues/21) passes its original scoped local comparison. Publish the reviewed controller/recovery source and collect installation/device feedback through the normal release process. |
| 3. Reuse shared inputs safely | Contributors and reviewers reuse Layer/Style identities in another study, refresh inputs and hand work to a colleague without losing permissions or earlier versions. | [Practitioner workflow](docs/community-workflow.md), [data stewardship](docs/community-data-lifecycle.md) and [source limits](docs/community-capabilities.md#source-operations). |
| 4. Publish reproducible explanations | An author builds, privately previews, reviews and releases an exact source revision to an approved address on an independent installation. | [Publication destinations](docs/community-publication-destinations.md) and [small examples](docs/community-examples.md). Preserve source authority, attribution and earlier editions. |
| 5. Extend useful analysis and exchange | Add a source, service operation or cartographic tool when it completes a named discovery-to-output workflow. Keep unsupported definitions and conversion losses visible. | [Processing](docs/community-capabilities.md#processing), [interoperability](docs/community-interoperability.md) and [versioned reference profiles](docs/reference-applications.md). |

Accessibility, understandable status and recoverable errors apply to every
priority. Assess the actual interface and generated outputs with intended users
and assistive technology; isolated checks do not establish whole-application
conformance.

Existing accepted profiles are the starting point. Governed authoring/inspection
[#11](https://github.com/categori-se/opengeo-community/issues/11), GeoNode metadata
[#20](https://github.com/categori-se/opengeo-community/issues/20), Print
[#14](https://github.com/categori-se/opengeo-community/issues/14) and portable
Projects [#17](https://github.com/categori-se/opengeo-community/issues/17) retain
their recorded scope. Search/navigation [#21](https://github.com/categori-se/opengeo-community/issues/21)
and OpenLayers controls/interactions [#13](https://github.com/categori-se/opengeo-community/issues/13)
also meet their original local comparison criteria. The authoring profile includes conflict/history and Style
persistence; metadata includes revision-preserving GeoNode 5.1.0 exchange.
Additional input, device, certification or installation work must name its own
outcome rather than treating these implementations as absent.

The [version-pinned comparison matrix](docs/reference-applications.md#relative-parity-by-capability)
identifies accepted scopes and the remaining service and Google Earth Pro gaps.
The sunlight criterion now has actual native UTC animation and changed terrain
pixels. Historical imagery/panoramas remains Partial on its wider inventory.
[Issue #5](https://github.com/categori-se/opengeo-community/issues/5) retains source
release, deployment and wider archive/provider requirements.

The local maintainer matrix records **45 Pass / 4 Partial across 49 planned
comparisons**; publication and production rollout of new increments remain separate.
Use its local-acceptance and release boundaries when selecting work. Installation
acceptance remains separate: follow [installation and handover](docs/community-deployments.md#accept-and-hand-over-an-independent-installation)
and the [local development guide](docs/community-development.md). Print and
the five GeoLibre comparisons already pass their recorded criteria; extend them
only to complete a specific unmet workflow.

An accepted comparison does not close a broader delivery obligation. External-source
acceptance [#10](https://github.com/categori-se/opengeo-community/issues/10) and
configured publishing/migration [#15](https://github.com/categori-se/opengeo-community/issues/15)
retain their explicit remaining work.

Use the [issue tracker](https://github.com/categori-se/opengeo-community/issues)
and [community project](https://github.com/orgs/categori-se/projects/2) for current
work items. [CONTRIBUTING.md](CONTRIBUTING.md) explains practitioner feedback,
small contributions and existing checks. Choose a bounded task and describe its
expected result, supported inputs and remaining limits.
