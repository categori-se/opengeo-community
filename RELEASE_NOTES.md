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

## Verified workflows

**Upload, compose, style, save and reopen.** The
[built Studio check](docs/community-development.md#browser-save-and-reopen-check)
uploads the sample facilities through the UI, adds the layer, changes its color
and opacity, and saves the map at revision 2. After restarting the same database,
Studio reopens that map with its source identities, all five features and styling
intact. A separate local pilot exercises GIS derivatives and static publication.

**Enforce resource access.** The
[connected authorization check](docs/api/authorization-local.md) verifies allowed
reads, denied viewer edits and publication, immediate revocation, and stale-write
conflicts against the real API and PostGIS. Rejected writes leave the protected
resource, render job and publication state unchanged.

**Inspect the API and exchange metadata.** The
[API contract](docs/api/README.md) exports deterministically without credentials
or network access, with model-validated source, map and publication examples.
Name-only map creation supplies a valid empty definition, including measurements;
focused request and route checks verify its initial revision and independent defaults.
The [public API CI run](docs/api/evidence/api-ci.json) installs hash-locked
dependencies on a hosted runner and passes the contract check and 89 focused tests.
The [STAC-to-CKAN exporter](docs/api/stac-ckan.md) produces a reproducible dry-run
dataset-create payload with retained source checksums and explicit conversion
losses, checked against a subset derived from CKAN 2.11.6.
A [disposable CKAN 2.11.6 round trip](docs/api/stac-ckan.md#disposable-server-check)
creates and reads the fixture, verifies its provenance and resource references,
then purges it and confirms cleanup.

The Studio and authorization checks use cached dependencies and service images,
synthetic sign-in and local object/queue transports. Browser persistence runs the
actual built Studio with the API, PostGIS and GIS worker. The API route tests and
inbound CKAN tests also use mocked repositories or providers, as recorded in their evidence.
The CKAN round trip uses the real server with a generated local sysadmin identity;
its receipt identifies the pinned images and reused cache.

## Selected source updates

Point clustering is included as local source work for supported Point Layers,
with per-Layer controls and saved preferences. Source inclusion and focused local
checks do not establish a delivered build or acceptance in an independent community
installation. Compiled rendering and publication/export limits must be reviewed
for the selected release; unsupported outputs must disclose clustering.

The configurable PMTiles-v2 conversion lane remains disabled pending current
security scanning, native ARM64 execution and hosted owner acceptance. Its source
and local GeoJSON conversion evidence do not authorize worker activation. The
shared worker security hold remains in effect. A preserved original is not a
validated map display, and a local conversion does not establish completion for
large datasets.

## Installation and publication status

The full suite is available for local development and self-hosting. Remaining
acceptance work covers a clean-machine installation of the full application and
services, an independent AWS installation, and the complete native
Notebook/Framework build, preview and publication journey. The
[native publication readiness review](docs/api/native-publication-readiness.md)
identifies the missing local runtime connections. CKAN harvesting, synchronization
and live portal integration remain unverified. Binary distributions require
license and security review of their exact contents.

The public demo and hosted publications show deployed examples. Fresh-install
and cloud acceptance remain separate from those examples and the local checks.
`COMMUNITY-RELEASE.json` retains earlier release verification;
[selected workflow evidence](docs/api/evidence/task-3.json) records the browser
journey above. [ROADMAP.md](ROADMAP.md) lists the next work.

## Support

The community edition contains the full suite of tools. Hosting and enterprise
support are fee-based services for the same software. See
[support and inquiries](SUPPORT.md#hosting-and-enterprise-support).
