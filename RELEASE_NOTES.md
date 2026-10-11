# Community source release notes

## October 11, 2026 — source edition and public guide update

OpenGeo Studio is a workspace for retaining spatial inputs, reusing maps and
explaining analytical findings. The community edition includes Studio, the API,
PostGIS schema, processing workers, publication components and infrastructure
source under Apache-2.0, with upstream licenses and credits retained.

### What to explore

- An [illustrated practitioner workflow](docs/community-workflow.md) with a
  small redistributable synthetic input and clearly marked connected steps.
- An [example gallery](docs/community-examples.md) separating published work
  from proposed exercises that still need complete reproducibility packages.
- An [operation and maturity matrix](docs/community-capabilities.md) that
  distinguishes executable adapters, metadata imports and retained definitions.
- A concise [architecture guide](docs/community-architecture.md), repaired
  component reading paths and specific [first contributions](CONTRIBUTING.md#make-a-first-contribution).
- [Renderer roles and compatible switching](docs/community-renderers.md),
  [operation-specific interoperability](docs/community-interoperability.md) and
  a [data stewardship example](docs/community-data-lifecycle.md).
- [Publication destinations and release recovery](docs/community-publication-destinations.md),
  including a synthetic two-origin example, optional GitHub source export and
  reviewed rollback of retained builds.
- [Local development](docs/community-development.md),
  [AWS installation](docs/community-aws.md) and
  [deployment/demo resources](docs/community-deployments.md).

### Evidence and remaining limits

A bounded local Studio check creates and saves a Project/map, restarts the
database and reopens the exact saved map. A separate local pilot exercises
selected upload, GIS derivatives, map composition, static publication and access
controls. These checks reuse installed dependencies and cached images.

Clean-machine dependency and API/worker/compiler image builds, live independent
AWS installation, the complete standalone native Notebook/Framework publication
journey and full built-browser publication acceptance remain open. Future binary
distributions need their own exact license and security review.

The illustrated demo and hosted publications show their named deployment, not
independent-install acceptance. Documentation updates do not change runtime
support or promote parity claims. Source and supporting verification details are
retained in `COMMUNITY-RELEASE.json`; [ROADMAP.md](ROADMAP.md) owns future work.

### Support

The community edition contains the full suite of tools. Hosting and enterprise
support are fee-based services for the same software. See
[support and inquiries](SUPPORT.md#hosting-and-enterprise-support).
