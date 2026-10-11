# OpenGeo.Tools deployment and examples

OpenGeo Studio is the software: an open workspace for geospatial analysis and
publishing. OpenGeo.Tools brings together Studio and our public methods and
knowledge library.

We use OpenGeo Studio to publish geographic information through
[OpenGeo.Tools](https://opengeo.tools/), curate and author work in
[OpenGeo Studio](https://studio.opengeo.tools/), and offer an anonymous
[Studio demo](https://demo.studio.opengeo.tools/). These are different uses of
the same community software, whose full suite of tools is available in the
[public source repository](https://github.com/categori-se/opengeo-community).

## Try the tools and read published work

| Destination | How we use it | What you can try |
| --- | --- | --- |
| [OpenGeo.Tools](https://opengeo.tools/) | Public delivery of Publications, dataset introductions, maps and analytical examples | Read published work and explore its maps, methods and source references |
| [studio.opengeo.tools](https://studio.opengeo.tools/) | Authenticated authoring and curation with persistent account permissions | Sign in to work with permitted Catalog resources, compose Projects and author Publications |
| [demo.studio.opengeo.tools](https://demo.studio.opengeo.tools/) | An isolated anonymous GIS workbench | Open local GIS files, add public web layers, style and inspect data, measure features and save a draft in the browser |

The demo keeps browser drafts separate from Studio accounts, private Projects
and managed uploads. Public entry links can send visitors without a Studio
session to the demo; ordinary sign-in and direct Project links retain their
destinations. The demo is useful for exploring the interface, while the connected
Studio supplies account-backed persistence and authorization.

Start with a small local GIS file or a public layer in the demo, inspect its
attributes and styling, and save a browser draft. For an example of published
work, [Map Folio](https://opengeo.tools/map-folio/) shows map-based delivery and
[Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/)
documents reusable cartographic choices. Dataset and provider terms remain
separate from the software license.

## Follow the source into your own installation

The hosted deployment separates the public publication origin, compiled Studio
and anonymous demo. Studio uses the API, account permissions and spatial database;
processing workers handle deliberate queued GIS jobs. Public outputs and the
demo are delivered as compiled web assets. The demo has its own delivery edge
without an account API or sign-in configuration.

- [Run the connected development environment](community-development.md) to work
  with Studio, API, PostGIS and the GIS worker locally.
- [Deploy to your own AWS account](community-aws.md) for account-owned identity,
  encrypted storage, processing and a sealed Studio release.
- Read the [resource model](../ARCHITECTURE_TERMS.md) for the relationship
  between Layers, Projects, Artifacts and Publications.
- Explore the [demo entry source](../app/demo/index.md),
  [workbench component](../app/src/components/PublicDemoWorkbench.js) and
  [Studio demo description](../app/src/public-demo.md) to see how the example is
  assembled from maintained application components.

These examples describe our deployment, rather than certify every independent
installation. The AWS guide records the standalone installer's supported scope
and remaining native publication setup; the development guide records local
persistence evidence and its limits. The [roadmap](../ROADMAP.md) tracks
unfinished workflows and acceptance.

For fee-based hosting or enterprise support for your installation, contact
[Aaron Kyle Dennis](mailto:2301690+aaronkyle@users.noreply.github.com) through the
[support guide](../SUPPORT.md#hosting-and-enterprise-support).
