# OpenGeo Studio roadmap

Improve recurring tasks that make a study useful: inspect sources, save and
reopen a map, explain findings, share an output and update it later. The
[capability guide](docs/community-capabilities.md) owns available operations and
limits. This roadmap identifies the next user outcomes.

| Priority | Next useful outcome | Where to start |
| --- | --- | --- |
| 1. Run an independent installation | An operator configures sign-in, storage, processing and delivery, then demonstrates permitted Catalog inspection, Project save/reopen and reviewed publication after restart. | [Installation and handover](docs/community-deployments.md#accept-and-hand-over-an-independent-installation), [local development](docs/community-development.md) and [AWS deployment](docs/community-aws.md). |
| 2. Find and organize work reliably | Users search, navigate Places and Layers, and return to named views with clear keyboard and error-recovery behavior. | [Search and navigation #21](https://github.com/categori-se/opengeo-community/issues/21). Build on existing coordinate, name, address and Plus Code search. |
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
their recorded scope. The authoring profile includes conflict/history and Style
persistence; metadata includes revision-preserving GeoNode 5.1.0 exchange.
Additional input, device, certification or installation work must name its own
outcome rather than treating these implementations as absent.

Use the [issue tracker](https://github.com/categori-se/opengeo-community/issues)
and [community project](https://github.com/orgs/categori-se/projects/2) for current
work items. [CONTRIBUTING.md](CONTRIBUTING.md) explains practitioner feedback,
small contributions and existing checks. Choose a bounded task and describe its
expected result, supported inputs and remaining limits.
