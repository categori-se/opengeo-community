# OpenGeo Studio

**Build maps you can reuse. Publish analysis others can inspect.**

OpenGeo Studio is an open workspace for geospatial analysis and publishing from
OpenGeo.Tools. Curate spatial sources, compose reusable maps and carry them into
reports, notebooks and websites, keeping methods, versions, attribution and reuse
terms connected. Start the next study with useful work from the last one.

It is designed for people who repeatedly publish spatial analysis: researchers,
consultants, planners, environmental and social practitioners, and small teams.

**Early community source edition.** The full suite of tools is included under
[Apache-2.0](LICENSE). See the [release status](RELEASE_NOTES.md) for current
installation and publishing limits.

[Try the demo](https://demo.studio.opengeo.tools/) ·
[Open hosted Studio](https://studio.opengeo.tools/) ·
[LinkedIn](https://www.linkedin.com/in/akdennis/) ·
[Observable community profile](https://talk.observablehq.com/u/aaronkyle/activity) ·
[Explore published work](https://opengeo.tools/projects/) ·
[Choose an installation](docs/community-deployments.md) ·
[API documentation](docs/api/README.md)

## Choose how to use it

| Path | What to expect |
| --- | --- |
| [Try the browser Demo](https://demo.studio.opengeo.tools/) | Inspect, modify and export a small study without installing the stack. Personal saves stay on your device, separate from samples and account storage. |
| [Use hosted Studio](https://studio.opengeo.tools/) | Existing users sign in to the installation we operate. [Request hosted Studio access](https://www.linkedin.com/in/akdennis/) with your workflow and team size; access, availability and services are arranged with the maintainer. |
| [Run the community stack](docs/community-development.md) | Operate the browser application and its supporting services locally or in [your own AWS account](docs/community-aws.md). Configure your domains, styles, connections, permissions and usage limits. |
| [Commission a company deployment](SUPPORT.md#hosting-and-enterprise-support) | Agree a scope for installation, configuration, integration, training and handover into your environment. |
| [Arrange managed operation](SUPPORT.md#hosting-and-enterprise-support) | Use an organizational installation with agreed responsibilities for maintenance, recovery, upgrades and support. |

Our public Demo is one configured example; our managed `studio.opengeo.tools`
service is another, with its own account services and private connections. Demo
limits and sample controls describe that public deployment, not the limits of the
community software. Private data, credentials and installation settings stay
outside the shared source. The [deployment guide](docs/community-deployments.md)
compares operators, data, accounts, prerequisites and update responsibilities.

## What the repository contains

The community edition contains the connected application stack, including its
deployment source. Starting the frontend alone starts the browser interface;
durable accounts, shared resources, processing and publication need their
configured services.

| Component | Responsibility |
| --- | --- |
| Studio browser application | Inspect sources, compose and style maps, save Projects and author analytical Publications. |
| Resource and account API | Check access and maintain identities, versions, metadata and permissions. |
| PostgreSQL/PostGIS and file storage | Retain spatial records, original files, derivatives and resource relationships. |
| Spatial processing services | Run supported validation, transformation, analysis and rendering jobs deliberately. |
| Publication build system | Compile supported authored sources and selected inputs into inspectable web outputs. |
| Deployment and release infrastructure | Connect identity, storage, processing, previews and delivery in the operator's environment. |

See the [architecture](docs/community-architecture.md) and
[capability matrix](docs/community-capabilities.md) for implemented components
and their current limits.

## Keep useful work for the next study

| Activity | What you can do |
| --- | --- |
| Curate a source | Inspect a Layer's origin, version, coverage and reuse rights; distinguish a live reference from preserved data. |
| Compose and reuse | Reference the same Layer in several Projects, reuse Styles and run supported spatial operations. |
| Explain and deliver | Combine maps, charts, methods, code and narrative; choose supported print, download or web delivery. |
| Return and revise | Reopen saved work, review a changed input and deliberately publish a new edition while retaining earlier releases. |

Layers, Projects and Publications have their own identities and versions. Two
maps can reference one Layer without duplicating its managed data. Reusing a live
reference does not preserve the remote data; use an eligible capture when a study
requires retained inputs. Resource permissions and data terms still apply to
every use.

The [workflow guide](docs/community-workflow.md) follows a source through two maps,
external publication, print and a later revision, and identifies the steps still
awaiting complete acceptance. Start with the [small Demo study](docs/community-examples.md#try-it-community-facilities)
to inspect, modify and export a useful result. The Demo keeps personal saves on
your device; connected Studio provides account-backed saving.

## What you can make

| Deliverable | Workflow and examples | Access and limits |
| --- | --- | --- |
| Shared geographic library | [Curate sources and reuse Layers](docs/community-workflow.md#work-through-the-steps); start with the [facilities exercise](docs/community-examples.md#try-it-community-facilities). | [Supported data interfaces](docs/community-interoperability.md); [capabilities and limits](docs/community-capabilities.md). |
| Saved map Projects | [Compose, save and reopen](docs/community-workflow.md#work-through-the-steps); [inspect and modify a sample](docs/community-examples.md#try-it-community-facilities). | [Project exchange and services](docs/community-interoperability.md); [persistence boundaries](docs/community-workflow.md#choose-a-workspace). |
| Reusable map outputs | [Print or reuse a selected map](docs/community-workflow.md#a-recurring-study-to-verify); explore [Map Folio](https://opengeo.tools/map-folio/). | [Export and access interfaces](docs/community-interoperability.md); [current acceptance limits](RELEASE_NOTES.md). |
| Analytical Publications | [Prepare, review and revise](docs/community-workflow.md#work-through-the-steps); examine [NOAA imagery analysis](https://opengeo.tools/noaa-coastal-imagery/reading-beyond-visible/). | [Build profiles and delivery](docs/community-publication-destinations.md); [current acceptance limits](RELEASE_NOTES.md). |
| Project websites and publication Collections | [Configure a publishing destination](docs/community-publication-destinations.md); explore [published work](https://opengeo.tools/projects/). | [Delivery configuration](docs/community-publication-destinations.md) and [supported resource relationships](docs/community-capabilities.md); [release limits](RELEASE_NOTES.md). |

Publication components include Framework, HTML/map, Observable Notebook and
bounded Jupyter output profiles. Their implementation does not establish the
complete workflow in a fresh installation. Configured cloud delivery uses
S3/CloudFront; other hosts need an adapter or a supported exported-output workflow.
Collections organize references and do not grant access to their members.

## Explore published work

- [Map Folio](https://opengeo.tools/map-folio/): explore map composition, projections and reusable cartography.
- [Reading beyond the visible](https://opengeo.tools/noaa-coastal-imagery/reading-beyond-visible/): examine how imagery bands and display choices affect interpretation.
- [Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/): work through color, pattern and layout choices for readable maps.
- [Measuring change in Nepal with census tables](https://opengeo.tools/nepal-census-tables/): compare census observations and examine the limits of the comparison.

These are published on OpenGeo.Tools. The [examples guide](docs/community-examples.md)
includes a small downloadable exercise and instructions for contributing a study.
These examples illustrate outputs and methods; each does not yet provide a
complete redistributable Studio workspace and installation reproduction.

## Inside Studio

[MapLibre is the default renderer](docs/community-renderers.md), with optional
Mapbox and Cesium adapters for compatible content. Mapbox requires a public
session token and its provider terms apply. OpenLayers supplies geometry and
exchange utilities.

The browser application works with a FastAPI service, PostgreSQL/PostGIS,
spatial workers and an isolated publication compiler. The community edition
includes all of these components and the deployment infrastructure.

- [Architecture](docs/community-architecture.md): components, storage and security boundaries.
- [Capabilities](docs/community-capabilities.md): supported operations and current limits.
- [Interoperability](docs/community-interoperability.md): metadata, feature and raster access, map services and project exchange.
- [Data lifecycle](docs/community-data-lifecycle.md): originals, versions, derivatives, rights and provenance.
- [Publishing](docs/community-publication-destinations.md): configured destinations, previews, release review and recovery.

## Run and contribute

Start with the [connected local development guide](docs/community-development.md)
to run Studio, API, PostGIS and the worker together, then exercise upload, save,
database restart and reopening. The [AWS guide](docs/community-aws.md) covers
an installation in your own account.

Connected local checks cover selected upload, styling, save/reopen, access,
processing and static publication paths using documented local substitutes.
Clean installation, independent AWS deployment and the complete native
Notebook/Framework build, preview and publication journey remain acceptance work.
Read the [release notes](RELEASE_NOTES.md) before committing to a workflow.

For frontend development, install Node.js 24 and npm, then run:

```bash
npm ci --prefix app
npm run dev -- --host 127.0.0.1
```

This frontend command does not start the connected platform.

Follow the [roadmap](ROADMAP.md), [make a first contribution](CONTRIBUTING.md#make-a-first-contribution)
or ask a question through [community support](SUPPORT.md#community-help).

## API documentation

Use Studio's HTTP API to work with sources, versioned maps and publication
preparation and review. The [API guide](docs/api/README.md) explains authentication,
tenant headers, pagination, revisions and errors. Browse the generated
[OpenAPI contract](docs/api/openapi.json) and [validated examples](docs/api/examples.json),
or follow the guide to check the contract offline and open local Swagger docs.

## License and support

Commercial use, modification and self-hosting are welcome under Apache-2.0.
Third-party software and data retain their own terms; see the
[acknowledgements](ACKNOWLEDGEMENTS.md),
[NOTICE](NOTICE) and [foundation inventory](docs/open-source-foundations.md).

We offer [hosting and enterprise support](SUPPORT.md#hosting-and-enterprise-support)
as fee-based services. [Contact us](https://www.linkedin.com/in/akdennis/) with inquiries.

Developed and maintained by [Aaron Kyle Dennis](https://github.com/aaronkyle)
for [categori.se](https://categori.se).
