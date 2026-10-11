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

Local checks cover Project save, database restart and reopening the saved map.
A separate local pilot covers uploads, selected GIS derivatives, map composition,
static publication and access controls.

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
