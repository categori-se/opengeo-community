# OpenGeo Studio roadmap

Build maps you can reuse. Publish analysis others can inspect. We are building
OpenGeo Studio for recurring spatial studies, so useful sources, maps and methods
carry forward into the next report, notebook or website. Low idle infrastructure
cost is a design goal; workload costs depend on storage, processing, traffic and
deployment choices.

## Current release boundary

The community source edition includes the full suite of tools. The
[built Studio workflow](docs/community-development.md#browser-save-and-reopen-check)
verifies source upload, map composition, color and opacity changes, UI Save and
exact reopening after restarting the same database. The
[authorization check](docs/api/authorization-local.md) verifies resource roles,
revocation and unchanged protected state after rejected writes against PostGIS.
A further local pilot exercises selected GIS processing and static publication.

The [API contract](docs/api/README.md) provides a reproducible offline interface
and validated examples. The [STAC-to-CKAN exporter](docs/api/stac-ckan.md) produces
inspectable dry-run dataset metadata with retained provenance and explicit losses.
A [disposable CKAN 2.11.6 check](docs/api/stac-ckan.md#disposable-server-check)
creates and reads the fixture through the real Action API, then purges it and
confirms cleanup. The application checks use cached dependencies/images and
synthetic authentication and transport; the CKAN check uses a generated local
sysadmin identity. Fresh-install/image builds, independent-account AWS acceptance
and the complete standalone native Notebook/Framework publication journey remain
open; the [readiness review](docs/api/native-publication-readiness.md) identifies
the missing local runtime connections. CKAN harvesting, synchronization and live
portal integration remain separate acceptance work.
The [capability matrix](docs/community-capabilities.md) separates executable
operations, metadata-only imports and retained definitions. The
[workflow guide](docs/community-workflow.md) labels demonstrated and
unfinished steps. See [release notes](RELEASE_NOTES.md) for a concise account
of this source edition.

We weight public benefit by how widely a workflow is used, how much work it lets
people reuse, and how much installation or operating effort it removes. Community
issues, contributions and practical GIS examples help refine that order.

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

## Rollout priorities

| Work area | Recurring user task | Completion target |
| --- | --- | --- |
| 1. Connect and reuse | Stop preparing the same sources for every study | Inspect a Layer, use it in two Projects, save and reopen without duplicating managed data. |
| 2. Publish and revise | Carry a map into reports, print and other websites | Preview and approve a build, deliver it through supported paths, then revise one output while preserving its earlier edition. |
| 3. Curate and collaborate | Let a colleague continue the work | Find the source, terms, method, version and responsible people under explicit permissions. |
| 4. Exchange services | Use the same work in existing GIS clients and publications | Provide working access examples, version choices and independently checked service operations. |
| 5. Extend exploration | Answer a demonstrated specialist question | Add a focused workflow that preserves reusable resources and useful outputs. |

Each stage extends the current platform. The
[reference application comparison](docs/reference-applications.md) records the
version-pinned feature families and their relative parity. The
[foundation inventory](docs/open-source-foundations.md) identifies the software,
contributors and licenses that make this work possible.

## 1. Connect data and reuse maps

Make the path from an existing source to a useful map straightforward for GIS
practitioners and web developers.

- Complete portable Project and view round trips, preserving Layer identity,
  source references, cartography and geographic context.
- Close the remaining Catalog-to-Project composition and reusable Style gaps.
- Improve source inspection, field handling, editing and version recovery in the
  selected GeoLibre and GeoNode workflows.
- Provide a dependable connected development environment and an independent
  AWS installation using the maintained infrastructure and deployment scripts.
- Keep the Demo useful for inspecting, modifying and exporting a small study;
  distinguish personal device saves from resettable sample drafts and account storage.

**Outcome:** connect a supported source, inspect its Layer, compose a Project,
save it, reopen it and reuse its data and Styles in another composition.

## 2. Publish maps and analysis

Carry GIS work through to a useful result that colleagues and the public can
read, explore and cite.

- Complete the standalone Notebook/Framework authoring, compilation, preview and
  delivery workflow with operator-owned build and publication configuration.
- Close mixed map, chart, table and narrative layout gaps in the GeoLibre and
  GeoNode comparison families.
- Extend responsive delivery and print outputs from the GeoMoose comparison,
  preserving attribution, citations and selected resource versions.
- Reuse compiled Project Artifacts across Publications and preserve publication
  paths and release history through updates.
- Bring available figures, print, services, embeds and native JavaScript access
  into an understandable delivery workflow, with actual access and version choices.
  Verify external-site and Observable Framework examples on a separate origin.
- Make methods examples adaptable: question, permitted inputs, method, expected
  observations and a route into a compatible Studio workflow.

**Outcome:** publish an interactive analysis and a useful static or printable
edition from the same curated sources, then revise and republish it.

## 3. Curate and collaborate

Help organizations build a shared geographic library that remains understandable
as people, sources and analyses change.

- Complete the remaining GeoNode metadata, resource and discovery workflows,
  including explicit rights, provenance and source relationships.
- Improve invitations, resource review, discussions and community discovery in
  the open sharing comparison items.
- Make Collections, account roles and publication audiences easy to manage while
  preserving each resource's ownership and permissions.
- Keep source, normalized and curated knowledge distinct across import, editing
  and export.
- Show changed inputs, affected work and pinned outputs so authors can choose
  which results to rebuild while retaining prior editions.

**Outcome:** a team can discover, review, reuse and publish shared work while
retaining the evidence and responsibility behind it.

## 4. Connect the wider GIS ecosystem

Make OpenGeo Studio a practical companion to QGIS, existing spatial services and
established web GIS applications.

- Close selected GeoServer and MapServer service operation/version gaps, with
  independent clients and explicit standards acceptance.
- Extend the source and protocol coverage identified by OpenLayers and GeoMoose
  comparisons.
- Improve cartographic and service handoffs that preserve styles, coordinate
  systems, feature identities and metadata across tools.
- Refresh upstream version comparisons, starting with GeoLibre, and prioritize
  changes that affect common workflows.

**Outcome:** teams can move between OpenGeo Studio and their existing GIS tools through
well-defined formats, services and repeatable interoperability examples.

## 5. Extend editing and geographic exploration

Build on the everyday workspace with tools for more specialized spatial work.

- Advance remaining geometry interaction and editing items from OpenLayers and
  GeoLibre comparisons.
- Extend globe, terrain, KML/KMZ, saved views, measurement and time workflows
  identified by the Google Earth Pro behavioral reference.
- Sequence additional scene, imagery, tour and output capabilities around
  concrete community use cases.

**Outcome:** more demanding workflows fit the same reusable Layer, Project,
Style and Publication model.

## Throughout the rollout

Security, resource isolation, data preservation, low idle cost and upstream credit
remain part of every stage. Reuse connections and compiled outputs, keep builds
deliberate, and verify the selected user journey through its actual interface.

The [development guide](docs/community-development.md),
[AWS guide](docs/community-aws.md) and `COMMUNITY-RELEASE.json` hold installation
instructions and validation details. Image releases carry exact dependency
inventories, licenses, notices and applicable corresponding source.

[Contribute a focused improvement](CONTRIBUTING.md),
[share a reproducible GIS example](SUPPORT.md), or
[propose a priority](https://github.com/categori-se/opengeo-community/issues).
