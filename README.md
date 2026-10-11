# OpenGeo Community

A geospatial workspace for connecting sources, curating reusable Layers and
Styles, composing Projects, and publishing maps and analytical narratives.

**Early community source edition.** This repository contains the application,
API, spatial schema, processing workers and publication compiler. It is not yet
a production self-hosting release. The [roadmap](ROADMAP.md) distinguishes the
available code from the remaining installation and acceptance work.

The first-party application is licensed under [Apache-2.0](LICENSE). Included
upstream code and assets retain their own licenses and notices. Commercial use,
modification and self-hosting are allowed under the applicable terms.

## What belongs in Community

- Catalog discovery, supported source connections, metadata, provenance and rights.
- Temporary Layer inspection, persistent Layer identities and reusable Styles.
- Project composition, save/reopen, maps, analysis and supported exports.
- Publications, the source editor, compilation and publishing interfaces.
- Private content, basic account roles, resource isolation and authorization.
- Supported APIs and standards integration, migrations and build source.

These are the community product scope, not a claim that every adapter or production
workflow has passed acceptance. There are no subscription checks in this edition.
Source references do not grant access to upstream data or hosted services.
Legacy developer notes and tests can reference private acceptance material that
is excluded from this snapshot; use the Community guide and its focused checks.

## Develop locally

Use the existing [development workflow](docs/community-development.md). It reuses
the Studio/API/PostGIS/worker integration runner. Its local authentication and
object transport are development substitutes; public deployment needs real
authentication, storage and reviewed infrastructure configuration.

For frontend work, with Node.js 24 and npm installed:

```bash
npm --prefix app ci
npm run dev -- --host 127.0.0.1
```

This starts the frontend only. It does not provision an API or a database, and it
does not establish that the complete application works. See the development guide
for the connected environment and its prerequisites.

## Project structure

| Path | Purpose |
| --- | --- |
| `app/` | Studio interface, map renderers and source editing |
| `services/api/` | Resource, permissions, source and publication APIs |
| `database/` | PostgreSQL/PostGIS schema, migrations and focused checks |
| `services/worker/` | Ingestion, spatial processing and render jobs |
| `services/observable-builder/` | Isolated publication compilation |
| `services/observable-coordinator/` | Compilation coordination and transport |
| `services/observable-preview/` | Isolated publication preview |
| `infrastructure/` | Infrastructure source; configure for your own account |
| `schemas/` | Portable definitions and exchange schemas |
| `governance/` | Maintained foundation and license register |

## Community and support

This repository focuses on the software, documentation and contributions available
to the community. Paid support may be offered in the future, but its scope, terms
and availability have not been defined. No paid support is required to use the
software under its license.

Read the [acknowledgements](ACKNOWLEDGEMENTS.md), [NOTICE](NOTICE),
[foundation inventory](docs/open-source-foundations.md) and
[licensing and contribution policy](docs/community-licensing.md).
We preserve upstream credit and distinguish dependencies from reference products.

Maintained by [Aaron Kyle Dennis / aaronkyle](https://github.com/aaronkyle),
published by [categori.se](https://github.com/categori-se).
[Contributions](CONTRIBUTING.md) are welcome; contributors retain their copyright.
