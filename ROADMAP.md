# OpenGeo Community development roadmap

Updated October 11, 2026. This is an early source release, not a production
readiness or upstream-parity certification. Work follows the core user journey;
adapter breadth does not delay a usable release.

## Release 0.1: complete application source

- Release Studio, API, schema/migrations, workers, compiler and necessary build
  source under Apache-2.0, retaining upstream exceptions and asset notices.
- Preserve the existing foundation register, references and acknowledgements.
- Document a connected local development environment using the existing runner.
- Publish an honest record of checks and limits in `COMMUNITY-RELEASE.json`.
- Preserve private operational history, credentials and hosted datasets outside
  the public repository. Keep the original application repository intact.

Status: initial source edition prepared. A bounded Linux check created a Project
and map through Studio, stopped/restarted its retained database, and reopened the
same map through Studio and the authorized API. It reused an existing built Studio
and cached images. Source availability is distinct from a successful fresh-install
or production deployment.

## Next: reliable local core workflow

The acceptance journey is: start Studio, register/inspect a supported source,
preview one Layer without creating a Project, compose a Project with reusable
Layers and Styles, save, stop/restart, reopen, compile a Publication, and serve or
export its result. Include a second local identity for resource-isolation checks.

Reuse the existing integration runner and representative checks. Close actual
blockers before extending unused adapters. Maintain a persistent developer state,
clear startup failures, deliberate worker dispatch and exact versioned inputs.
Prove the documented installation on a clean machine before calling it a supported
quick start. Local synthetic authentication is never a production login system.

## Next: supported self-hosting

- Provide a durable deployment profile with real identity, storage, queues and
  PostGIS; reuse the existing application interfaces and infrastructure source.
- Make all installation inputs operator-owned; remove assumptions about private
  image caches, registries, account IDs and the original hosting environment.
- Document backup/restore, forward migrations, upgrades, security updates and
  rollback. Exercise persistence and isolation on one representative installation.
- For any published images, generate exact SBOMs and ship required license,
  notice and corresponding-source material. Resolve the Python BiDi expression
  and stale Psycopg inventory entry before those binary releases.
- Include ordinary authentication and basic multiuser permissions in Community.

## Then: adoption and focused interoperability

Improve onboarding, error recovery and documentation from real user feedback.
Prioritize supported source formats and standards handoffs that named users need.
Retain unsupported content with clear limitations. Preserve Layer/Style identity,
custody, provenance, private data and usable exports across upgrades.

Contribution review uses the affected checks and a representative core journey.
Historical parity evidence remains historical; a reference version or a test
count does not establish current upstream parity or formal standards conformance.

## Community maintenance

Keep the source, installation guide, working examples and acceptance limits current.
Preserve a standalone Community path, version public integration interfaces and
review contributions against the core workflows. Keep attribution, security fixes
and data-preservation work part of the community project.

Paid support may be considered separately in the future. Its scope, terms and
availability are not defined by this roadmap.
