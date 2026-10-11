# OpenGeo Studio roadmap

We are building a workspace where researchers, planners and environmental and
social practitioners can retain spatial inputs, explain their methods and share
work others can inspect. The rollout prioritizes connecting real data, reusing
maps, collaborating and publishing useful results. Low idle infrastructure cost
is a design goal; workload costs depend on storage, processing, traffic and
deployment choices.

## Current release

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
Local checks use cached dependencies/images and synthetic authentication and
transport. Fresh-install/image builds, independent-account AWS acceptance and
the complete standalone native Notebook/Framework publication journey remain
open; the [readiness review](docs/api/native-publication-readiness.md) identifies
the missing local runtime connections. CKAN server acceptance is separate from
payload generation.
The [capability matrix](docs/community-capabilities.md) separates executable
operations, metadata-only imports and retained definitions. The
[workflow guide](docs/community-workflow.md) labels demonstrated and
unfinished steps. See [release notes](RELEASE_NOTES.md) for a concise account
of this source edition.

We weight public benefit by how widely a workflow is used, how much work it lets
people reuse, and how much installation or operating effort it removes. Community
issues, contributions and practical GIS examples help refine that order.

## Rollout priorities

| Stage | Community outcome | Public benefit | Open comparison families |
| --- | --- | --- | --- |
| 1 | Connect data and carry maps between projects | Highest: everyday GIS work and reusable source libraries | GeoLibre projects/authoring; GeoLens composition; GeoNode catalog/resource editing |
| 2 | Publish maps, reports and interactive analysis | High: useful outputs for everyone who consumes GIS work | GeoLibre layouts/stories/print; GeoNode publishing; GeoMoose print/delivery |
| 3 | Curate and collaborate across teams | High: shared data stewardship and reproducible work | GeoNode resources, metadata, discovery and community |
| 4 | Exchange services with the wider GIS ecosystem | Broad: existing desktop tools, portals and data infrastructure | GeoServer services; MapServer OGC publication; GeoMoose distributed services; OpenLayers sources |
| 5 | Extend specialist mapping and exploration | Focused: advanced editing, globe, terrain and time workflows | OpenLayers interactions; GeoLibre authoring breadth; Google Earth Pro comparison families |

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
