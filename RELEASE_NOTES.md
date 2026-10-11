# Community source edition

OpenGeo Studio is a workspace for retaining spatial inputs, reusing maps and
explaining analytical findings. The community edition includes Studio, the API,
PostGIS schema, processing workers, publication components and infrastructure
source under Apache-2.0, with upstream licenses and credits retained.

## Guides and examples

- A [practitioner workflow](docs/community-workflow.md) with a small
  redistributable sample and instructions for connected installations.
- [Published examples and practice exercises](docs/community-examples.md).
- An [operation and maturity matrix](docs/community-capabilities.md) that
  distinguishes executable adapters, metadata imports and retained definitions.
- The [architecture guide](docs/community-architecture.md) and
  [first contributions](CONTRIBUTING.md#make-a-first-contribution).
- [Renderer roles and compatible switching](docs/community-renderers.md),
  [operation-specific interoperability](docs/community-interoperability.md) and
  a [data stewardship example](docs/community-data-lifecycle.md).
- [Publication destinations and release recovery](docs/community-publication-destinations.md),
  including a two-destination configuration example, optional GitHub source export and
  reviewed rollback of retained builds.
- [Local development](docs/community-development.md),
  [AWS installation](docs/community-aws.md) and
  [deployment/demo resources](docs/community-deployments.md).

## Current status

The [current API contract](docs/api/README.md) can be exported and checked offline
without credentials. Its source, map and publication examples are model-validated;
focused route checks use synthetic authentication and mocked repositories. This
does not establish connected persistence, provider access or cloud acceptance.

The [local authorization pilot](docs/api/authorization-local.md) checks viewer
edit/publication denials, revoked reads and unchanged state after denied or stale
writes against PostGIS. Sign-in and object/queue transports remain synthetic.

The [built Studio persistence check](docs/community-development.md#browser-save-and-reopen-check)
uploads the sample facilities through the UI, saves its map at revision 2 and
reopens that exact map after restarting the same local database. Source identity,
all five features, point color and opacity are retained. Dependencies and service
images were cached; sign-in and object/queue transport were synthetic.
A separate local pilot covers uploads, selected GIS derivatives, map composition,
static publication and access controls.

The [STAC-to-CKAN exporter](docs/api/stac-ckan.md) generates a dry-run dataset
create payload with retained source/checksums and explicit conversion losses.
Validation covers a subset derived from CKAN 2.11.6; no CKAN server round trip,
harvesting or synchronization was performed.

Still to verify: clean-machine dependency and service-image builds, an independent
AWS installation, and the complete native Notebook/Framework build, preview and
publication workflow in Studio. Binary distributions also require license and
security review of their exact contents.

The public demo and hosted publications are examples of maintained deployments;
they do not verify a fresh installation. `COMMUNITY-RELEASE.json` records detailed
verification results; [ROADMAP.md](ROADMAP.md) lists the remaining work.

## Support

The community edition contains the full suite of tools. Hosting and enterprise
support are fee-based services for the same software. See
[support and inquiries](SUPPORT.md#hosting-and-enterprise-support).
