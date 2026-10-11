# OpenGeo Studio

**An open workspace for geospatial analysis and publishing.**

OpenGeo Studio, the geospatial workspace from OpenGeo.Tools, connects source
discovery, reusable Layers and Styles, map composition, analytical authoring and
publication delivery. It is being developed for researchers, GIS practitioners,
environmental and social specialists, infrastructure planners, consultants,
NGOs and small public project teams who need to retain their sources, explain
their methods and share work that others can inspect and reuse. An analyst can
prepare a map, a reviewer can examine its evidence, and a developer can extend
the workflow through explicit interfaces.

**Early community source edition.** The repository includes the full suite of
tools under Apache-2.0; maturity varies by workflow. A connected local check
demonstrates Project/map creation, save, database restart and exact reopening.
Fresh-install/image builds, independent AWS installation and the complete
standalone native publication journey remain unfinished. See the
[capability and maturity matrix](docs/community-capabilities.md) and
[release notes](RELEASE_NOTES.md).

For example, a planner could map community facilities, inspect the source and
date behind each record, reuse the map in a second study and publish an
explanation of the assumptions. The
[illustrated walkthrough](docs/community-workflow.md) starts with five synthetic
facilities and marks the steps that require a connected installation or remain
unaccepted. It is a practice exercise, not an assessment of real communities.

[![Demo map of five synthetic community facilities with layer controls and map tools](docs/assets/community/starter-map.png)](docs/community-workflow.md)

Actual browser Demo from the October 5 release, with basemap requests disabled
for the local capture. Its display labels predate the current branding. Browser
drafts are separate from account-backed Projects; the screenshot does not
establish connected persistence or publication acceptance.

[Try the Studio demo](https://demo.studio.opengeo.tools/) ·
[Explore the OpenGeo.Tools library](https://opengeo.tools/) ·
[Run locally](docs/community-development.md) ·
[See our deployment](docs/community-deployments.md)

## From a source to an explanation

| Activity | What the workspace helps you retain |
| --- | --- |
| Discover and connect | Datasets, catalogs, services, source metadata and reuse rights; temporary inspection does not create a Project |
| Compose and analyze | Reusable Layers and Styles, deliberate Project saves, supported mapping and processing operations, selected versions and assumptions |
| Explain and author | Independently versioned Publications combining narrative, maps, methods, code and charts |
| Publish and maintain | Exact saved builds, reviewed delivery to configured web origins, source relationships, release history, updates and rollback |

Account context and explicit resource permissions keep restricted inputs under
their existing authority throughout those activities.

The [workflow guide](docs/community-workflow.md) explains what can be tried in
the demo and what needs a connected installation. The
[example gallery](docs/community-examples.md) connects hosted work to practical
questions and identifies proposed exercises that still need reproducible inputs.

**Connect once. Curate once. Reuse continuously.**

## What the community edition contains

Studio, Catalog, reusable Layers and Styles, Projects, collaboration, GIS
processing, Publications, APIs and infrastructure source are all included.
Support depends on the operation: registration, reading, previewing, editing and
preservation have different boundaries. STAC metadata import and retained source
definitions are described separately from executable data adapters in the
[capability matrix](docs/community-capabilities.md).

Our focus is the connection between reusable spatial resources, explicit source
custody, facts and interpretations, and computational explanations. Use
OpenGeo Studio alongside QGIS and other specialist tools. The
[reference comparison](docs/reference-applications.md) documents overlap,
version-pinned comparisons and compatibility limits.

## Map, analyze and publish

[MapLibre is the default renderer](docs/community-renderers.md). Optional Mapbox
and Cesium adapters admit compatible content through explicit checks while
retaining canonical Projects and Layers. Mapbox requires a workspace-session
public token and provider terms; Cesium supports a bounded vector scene profile.
OpenLayers supplies format/projection utilities and interoperability references,
rather than a selectable Studio renderer. Incompatible content is disclosed.

The [standards and interoperability guide](docs/community-interoperability.md)
separates catalog discovery and metadata exchange from feature/raster access,
map services and project conversion. The [data lifecycle](docs/community-data-lifecycle.md)
shows how source custody, exact versions, derivatives, rights and interpretation
stay distinct. Browser calculations, PostGIS previews, worker jobs and publication
compilation have different inputs, persistence and execution limits.

[Publishing has its own release workflow](docs/community-publication-destinations.md):
save a source revision, compile its admitted inputs, inspect a private preview,
review the exact build and select an approved origin. The concrete cloud adapter
uses configured S3/CloudFront resources. Optional GitHub source export is a
separate branch of the workflow. Retained builds and release receipts support
updates and reviewed rollback; an origin reservation or queued job is not a live
release. The guide includes a synthetic two-origin example and current acceptance
status, including the unfinished independent native-publication journey.

## Develop and deploy

- [Run the connected development environment](docs/community-development.md).
- [Understand the browser, API, database, worker and compiler](docs/community-architecture.md).
- [Deploy to your own AWS account](docs/community-aws.md).
- [Explore our public site, hosted Studio and isolated demo](docs/community-deployments.md).
- [Follow the roadmap](ROADMAP.md) and [make a first contribution](CONTRIBUTING.md#make-a-first-contribution).

For frontend exploration with Node.js 24 and npm:

```bash
npm ci --prefix app
npm run dev -- --host 127.0.0.1
```

The connected guide adds the API, PostGIS and processing worker. The AWS guide
describes account-owned authentication, storage, infrastructure and release
operations, with the standalone profile's remaining acceptance limits.

Low idle infrastructure cost is a design goal. Static delivery, request-driven
APIs, database pause/resume, reusable artifacts and deliberate processing support
that goal. Actual costs depend on the workload, retained data, traffic and AWS
configuration; this release does not provide a measured cost guarantee.

## License, foundations and support

The community edition's first-party software is [Apache-2.0](LICENSE).
Commercial use, modification and self-hosting are welcome under those terms.
Upstream code, assets and example data retain their applicable licenses and
notices. Contributors retain their copyright.

MapLibre, GDAL/OGR, PostGIS, PROJ, Observable, D3 and the wider open-source GIS
community make this work possible. Preserve the
[acknowledgements](ACKNOWLEDGEMENTS.md), [NOTICE](NOTICE),
[foundation inventory](docs/open-source-foundations.md),
[license register](governance/open-source-foundations.json) and
[contributor credits](CONTRIBUTORS.md).

[Community help](SUPPORT.md#community-help) is available through GitHub Issues.
We offer [hosting and enterprise support](SUPPORT.md#hosting-and-enterprise-support)
as fee-based services for the same full-suite software.
[Contact us](mailto:2301690+aaronkyle@users.noreply.github.com) with inquiries.

Developed by [categori.se](https://github.com/categori-se); maintained by
[Aaron Kyle Dennis](https://github.com/aaronkyle).
