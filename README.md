# OpenGeo Studio

OpenGeo Studio helps researchers, planners and small teams turn geospatial data
into reusable maps, environmental and social baselines, and analytical reports.
Inspect sources, compose maps and carry methods, versions, attribution and reuse
terms into your next study.

## Try it

- **[Browser Demo](https://demo.studio.opengeo.tools/):** explore without an account.
  Personal saves stay on your device; download backups of work you want to keep.
- **[Hosted Studio](https://studio.opengeo.tools/):** approved members can sign in
  to use configured account storage and services. [Request beta access or support](SUPPORT.md).

The Demo and hosted Studio use the same application foundations with different
storage, access and service configuration. A browser save does not create a
hosted account resource.

## What you can do

- Inspect vector and raster sources while retaining provenance and reuse terms.
- Compose and style map Projects; save, reopen and exchange supported data.
- Work with 2D maps, globe views, KML/KMZ organization and camera tours.
- Prepare printable maps and supported analytical web Publications.

Supported formats, renderers and exports have explicit limits; see the
[capabilities guide](docs/community-capabilities.md). Shared resources, server
processing and publication delivery require configured supporting services.

## Frontend development

Use Node.js **>=24.19.0 <25** and npm. From a checkout of this repository:

```bash
npm ci --prefix app
npm --prefix app run dev -- --host 127.0.0.1
```

Open the local URL printed by the server. This starts the browser interface.
For Studio with the API, PostgreSQL/PostGIS and worker, follow the
[connected local development guide](docs/community-development.md).
For self-hosting and deployment choices, see the
[deployment guide](docs/community-deployments.md).

## Learn and contribute

Follow the [workflow guide](docs/community-workflow.md) or try a
[small example](docs/community-examples.md). Report a reproducible problem or
contribute a focused improvement through [CONTRIBUTING.md](CONTRIBUTING.md).
See [SUPPORT.md](SUPPORT.md) for help and [SECURITY.md](SECURITY.md) for private
security reporting.

OpenGeo Studio is licensed under [Apache-2.0](LICENSE). Third-party software and
data retain their own terms; see [NOTICE](NOTICE) and
[acknowledgements](ACKNOWLEDGEMENTS.md).
