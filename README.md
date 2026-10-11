# OpenGeo Studio

**An open workspace for geospatial analysis and publishing.**

OpenGeo Studio, the geospatial workspace from OpenGeo.Tools, brings data, maps
and analytical writing together. Discover sources, build reusable maps, explain
your methods and publish the results—with the inputs and revisions attached.

It is designed for GIS practitioners, researchers, environmental and social
specialists, planners, consultants, NGOs and small project teams.

**Early community source edition.** The full suite of tools is included under
[Apache-2.0](LICENSE). See the [release status](RELEASE_NOTES.md) for current
installation and publishing limits.

[Try the demo](https://demo.studio.opengeo.tools/) ·
[Explore published work](https://opengeo.tools/projects/) ·
[Run locally](docs/community-development.md)

## Work from source to publication

| Activity | What you can do |
| --- | --- |
| Discover and connect | Inspect datasets, catalogs and services, including their metadata and reuse rights. |
| Compose and analyze | Reuse Layers and Styles across Projects, choose a renderer and run supported spatial operations. |
| Explain and author | Combine maps, charts, methods, code and narrative in analytical Publications. |
| Publish and maintain | Review saved builds, publish to configured web destinations, and manage updates or rollback. |

Layers, Projects and Publications have their own identities and versions. A map
can support several studies, and a published explanation stays connected to its
sources. Account and resource permissions control access throughout the workflow.

The [workflow guide](docs/community-workflow.md) explains how the steps fit
together. The demo saves drafts in your browser; connected Studio saves work to
your account.

## Explore published work

- [Map Folio](https://opengeo.tools/map-folio/): explore map composition, projections and reusable cartography.
- [Reading beyond the visible](https://opengeo.tools/noaa-coastal-imagery/reading-beyond-visible/): examine how imagery bands and display choices affect interpretation.
- [Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/): work through color, pattern and layout choices for readable maps.
- [Measuring change in Nepal with census tables](https://opengeo.tools/nepal-census-tables/): compare census observations and examine the limits of the comparison.

These are published on OpenGeo.Tools. The [examples guide](docs/community-examples.md)
includes a small downloadable exercise and instructions for contributing a study.

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

## Get started

For frontend development, install Node.js 24 and npm, then run:

```bash
npm ci --prefix app
npm run dev -- --host 127.0.0.1
```

Use the [local development guide](docs/community-development.md) to add the API,
PostGIS and worker. The [AWS guide](docs/community-aws.md) covers an installation
in your own account; [our deployment guide](docs/community-deployments.md)
explains the public site, hosted Studio and demo.

Follow the [roadmap](ROADMAP.md), [make a first contribution](CONTRIBUTING.md#make-a-first-contribution)
or ask a question through [community support](SUPPORT.md#community-help).

## License and support

Commercial use, modification and self-hosting are welcome under Apache-2.0.
Third-party software and data retain their own terms; see the
[acknowledgements](ACKNOWLEDGEMENTS.md),
[NOTICE](NOTICE) and [foundation inventory](docs/open-source-foundations.md).

We offer [hosting and enterprise support](SUPPORT.md#hosting-and-enterprise-support)
as fee-based services. [Contact us](mailto:2301690+aaronkyle@users.noreply.github.com) with inquiries.

Developed by [categori.se](https://github.com/categori-se); maintained by
[Aaron Kyle Dennis](https://github.com/aaronkyle).
