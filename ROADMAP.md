# OpenGeo Studio roadmap

Build maps you can reuse. Publish analysis others can inspect. We develop
OpenGeo Studio for recurring spatial studies, so useful sources, maps and methods
carry forward into the next report, notebook or website. Low idle infrastructure
cost is a design goal; workload costs depend on storage, processing, traffic and
deployment choices.

## Development status — October 17, 2026

The community edition contains the full suite of tools. Community installations,
the public Demo and managed Studio use the same core with their own configuration,
connections and operating policies. The Demo is a reference implementation;
private account configuration is not part of the community source.

Completed work stays completed when a later release or installation check is
pending. We record implementation, acceptance and delivery separately:

| Workflow | Completed work | Remaining work |
| --- | --- | --- |
| Catalog and Project composition | Persistent Layer identities, Catalog inspection, map composition, reusable versioned Styles and save/reopen are implemented. The built Studio check verifies upload, color/opacity changes, UI Save and exact reopening after restarting the same database. | Broader portable round trips and the complete contributor-to-reviewer-to-publisher browser journey. |
| Local authoring and print | Personal device saves, editable Project exports, a dedicated Print Studio, figure/print packs and interactive HTML are delivered on configured Studio/Demo. Print opens directly from a map without requiring a Publication. | Additional cartographic layout tools and higher-fidelity vector/georeferenced output. |
| Reuse on other websites | Native JavaScript delivery, developer bundles and an Observable Framework example are implemented. Local checks cover a separate origin, map events, filtering, selection, inherited styling and cleanup. | Independent installation acceptance and expanded content compatibility. Existing native delivery is not limited to the iframe helper. |
| Point symbology | Layer/category symbols, deliberate batch styling, versioned Point Styles and Styles navigation are delivered. Studio now delivers the 1,289-entry gallery, complete pinned Maki/OSM artwork, collection shortcuts and USGS/OSM guides. Local checks cover navigation, rendering and memory save/reopen. | Hosted account save/reopen, individual-feature overrides and separate icon/label controls. |
| Identify and Point clustering | Studio delivers the hidden-popup correction and per-Layer/batch clustering. Counts, filtering, save/reopen and Print-frame preferences pass compiled local checks. Studio and Demo deliver immediate Identify-panel opening, local feature attributes and Hide/Escape/reopening, verified on compiled artifacts and served files. Studio also preserves Results focus after native popups and governed-query completion. | Hosted persistence and visual paper-layout acceptance. |
| External PostGIS Layers | Connection verification, relation discovery, stable live Layer registration and bounded feature preview are implemented. A real local PostGIS journey verifies feature queries, exact numeric values, paging limits, revocation and cleanup. | Connected-browser and configured-provider acceptance, followed by deployment. The new source path defaults off. |
| Native authored publications | Two saved revisions compile through the native runner, open signed previews and publish through actual review/approval controls. Current/earlier public editions and private Build history pass locally. Missing/cross-build cookies, replay, viewer revocation and real capability expiry are verified; signed-cookie expiry uses a qualified local verifier clock. Preview origins are installation-configured. | Clean independent installation, AWS identity/delivery and production activation. Issued cookies remain valid until their 15-minute expiry. [Readiness](docs/api/native-publication-readiness.md). |
| API and CKAN exchange | The API contract has reproducible offline validation. The STAC-to-CKAN exporter and disposable CKAN 2.11.6 create/read/purge check are complete for their documented scope. | Complete harvesting, synchronization and live portal integration. |
| Configurable PMTiles intake | The dedicated conversion lane, parameter review, preserved-original path and completed-display handoff are implemented locally. The pinned worker converts GeoJSON and rejects disguised VRT input. | Current security review, successful native ARM64 execution and real-data hosted acceptance before activation. The corrected native API probe passes; the worker remains unexecuted because the host rejects a launcher mount option. Both temporary stacks and containers are cleaned up. The large global KBA conversion has not completed. |
| Analysis console | The docked JavaScript/Python/Bash editor, isolated browser JavaScript and opt-in local runners are implemented and accepted locally. Managed source connects private jobs, application storage, explicit queue/controller wake and a bounded host; local coordinator checks execute all three languages and cancellation. | Managed activation stays disabled. Connected HTTP/database and updated consumer lifecycle, admitted AMI, fresh-boot rootless security, actual AWS cleanup and production delivery remain open. |

The [capability matrix](docs/community-capabilities.md) describes operation-level
limits. The [workflow guide](docs/community-workflow.md),
[development guide](docs/community-development.md) and
[release record](COMMUNITY-RELEASE.json) retain the checks behind each claim.
The [API contract](docs/api/README.md),
[resource authorization checks](docs/api/authorization-local.md) and
[STAC-to-CKAN exporter](docs/api/stac-ckan.md) document their supported scope.
The [disposable CKAN check](docs/api/stac-ckan.md#disposable-server-check)
uses the real Action API and verifies cleanup. These completed checks do not
establish harvesting or synchronization.

The same local Studio candidate groups the desktop visibility controls and closes
site/account menus on outside clicks or Escape, restoring keyboard focus. Site
switcher links open each installation's home route. Its build, local browser
checks and Studio production delivery pass. The existing phone toolbar is
unchanged.

A separate Demo/startup update is implemented and accepted locally. The compact
Demo introduction keeps the map visible and its home route opens the map; About
this map contains source details and secondary actions. Startup failures show one
friendly retry/home state, and normal Studio entry does not request the fixture
Catalog. Existing browser, parser and focused checks pass. This update has not
been built as an application release or deployed.

Existing application checks use cached dependencies/images and explicit local
substitutes; fresh installation, clean image builds and independent-account AWS
acceptance remain separate work. The local native Framework publication journey now
passes source save, compilation, private preview, publication and earlier-edition
reopening for two revisions. The [readiness review](docs/api/native-publication-readiness.md)
distinguishes this connected local acceptance from independent installation and
production delivery.

Frontend validation discovers both top-level and nested test suites. Community
core CI passes. The broader application suite currently stops at a TIFF test
deadline after 2,457 passing tests. That workflow passes locally; compiler and
browser setup now have a separate bounded phase, preserving every interactive
assertion. Consolidated release validation remains pending.

The new Identify action opens Results directly. Source also restores keyboard
focus after governed queries finish while preserving the user's choice to hide
or switch panels. Its component regression and compiled feature-click, focus and Hide/Escape/reopen
checks pass. Studio now delivers this action and stable focus; its served software
matches the verified release. Demo remains live.

GitHub Actions stay within the free allowance. Remaining capacity could not be
verified, so this checkpoint does not trigger another runner job. Main-branch
validation remains pending until its allowance can be established.

The connected local publication access journey now passes viewer opening, revoked
grants and real capability expiry. Temporary memberships are removed and runtime
is stopped. Shared API errors and response validators are extracted into a
separate module, preserving their behavior; 154 existing client tests pass. Broader
domain-parser and Workbench decomposition remain open. No AWS or Actions run was
needed for this increment.

A fresh app dependency directory now installs the current lockfile, runs esbuild's
install script/native binary and passes 154 existing client tests. Its verified
package cache needed 13 locked downloads; install/tests use network isolation.
The seven-page frontend build and artifact check also pass with networking off.
The current standalone API and compiler Dockerfiles build locally. Exact API
package versions and nonroot HTTP startup pass; the compiler's existing real
fixture passes with credentials excluded and networking disabled. OS-only API
fixes now reuse the unchanged Python dependency layer. Runtime test containers
are removed; current worker CI evidence is reused. A complete independent
installation and production delivery remain open. Identify presentation is also
separated from Workbench, with three existing interaction/focus checks passing.
These source changes await release validation.

## Planning and delivery

Follow the [community GitHub project](https://github.com/orgs/categori-se/projects/2)
for current work, the
[community workspace planner](https://team-spaces.categori.se/projects/project?initiativeId=opengeo&projectId=coord-f01263fcef7e60d3704d5847286ccfba)
for the corresponding project view, and the
[issue tracker](https://github.com/categori-se/opengeo-community/issues)
for individual changes. This roadmap summarizes outcomes; linked work items carry
their current status, next action and completion evidence. A locally accepted
change awaiting release is tracked as awaiting delivery rather than unfinished
implementation. Historical notes retain their original date and are not current
status reports.

## Current priorities

| Priority | Next useful outcome |
| --- | --- |
| 1. Finish selected delivery | Nepal's layer ordering, clustering and colors are saved and read back; the Berkshires update remains blocked by the current account's access. Complete hosted Style/Print acceptance and the outstanding PMTiles security, native-runtime and hosted-data checks before enabling the new worker lane. |
| 2. Finish the shared-data journey | Exercise contributor review and publication through the actual interface, then accept the implemented PostGIS Layer source with a connected browser and configured provider. Preserve identity, permissions and history when replacing data. |
| 3. Accept managed analytical sessions | Preserve the accepted browser/local console and finish connected managed-runner acceptance and delivery. Opening the console must not allocate managed compute. |
| 4. Verify installation and reuse | Reproduce the small reference workspace and the accepted two-revision Framework publication journey on an independent installation, then verify delivery to another website. |
| 5. Extend proven workflows | Add service operations, source adapters and cartographic tools where a specific recurring task requires them. |

We prioritize the time to a first useful map, dependable reopening, reuse in a
second study and a clear handover to a colleague. Existing implementations are
the starting point; a remaining acceptance task does not require rebuilding the
feature.

## Connect data and reuse maps

Extend the working Catalog-to-Project path with broader portable round trips,
source inspection and version recovery. Preserve Layer identities, references,
Styles and geographic context. Keep personal device saves separate from
resettable sample drafts and account storage.

Complete the PostGIS browser/provider checks and make source status and refresh
trustworthy. A failed refresh must preserve the last successful version. Retained
source definitions and metadata imports remain distinct from executable readers.

## Publish maps and analysis

Accept independent installation and hosted delivery for the locally verified
Framework source, compilation, preview and publication workflow. Extend Notebook
support and mixed map, chart, table and
narrative layouts while preserving resource versions, attribution and citations.
Reuse compiled Project Artifacts across Publications and retain earlier editions
when an author revises an output.

Build on the delivered Print Studio and native developer exports. Keep included,
live and excluded dependencies explicit; expand their supported content without
presenting existing output formats as missing.

## Curate and collaborate

Improve metadata review, invitations, discussions, Collections and publication
audiences through the existing ownership and permission model. Keep source,
normalized and curated knowledge distinct. Show changed inputs and pinned outputs
so authors can choose which results to rebuild.

The next acceptance journey uses contributors, reviewers and readers. It must
show useful records, understandable decisions and preserved access throughout.

## Connect the wider GIS ecosystem

Verify selected service operations with independent GIS clients, including
identify, legends, paging, CRS handling and authorization. Extend harvesting and
source adapters as complete discovery-to-refresh workflows. Preserve styles,
feature identities and metadata when handing work to other tools.

The [reference application comparison](docs/reference-applications.md) records
version-pinned feature families; the
[foundation inventory](docs/open-source-foundations.md) records upstream software,
contributors and licenses. Broader parity remains in progress and does not make
completed core workflows unfinished.

## Throughout development

Security, resource isolation, data preservation, low idle cost and upstream credit
remain part of each change. Builds and paid processing require deliberate actions.
Keep the [AWS installation guide](docs/community-aws.md) aligned with maintained
infrastructure and retain dependency, license and security review for binary
releases.

[Contribute a focused improvement](CONTRIBUTING.md),
[share a reproducible GIS example](SUPPORT.md), or
[propose a priority](https://github.com/categori-se/opengeo-community/issues).
