# Resource model implementation — September 19, 2026

October 18 — Fresh installation uses the maintained public workflow

A boolean `fresh_installation` input defaults off on the existing two-job
workflow. Fresh mode checks x64, system Chrome, rootless cgroup-v2 Podman and
12 GiB free space, then uses empty isolated image/npm stores and anonymous
registry access. The unchanged Dockerfiles build under a 12-minute cap; the
canonical built-Studio and native-publication modes run separately with 6/5-minute
caps and runtime `TMPDIR=/tmp`. Isolated graph-checked cleanup runs on failure too.
Ordinary steps, API job, automatic paths and read-only permissions are preserved;
manual frontend timeout is 30 minutes. YAML, shell syntax and source comparisons
pass. Ordinary hosted CI passes; the first fresh preflight fails its exact graph
path assertion before downloads. Storage-path normalization and diagnostic messages
now preserve every preflight requirement; the targeted retry is pending. No new workflow, job, runner or build script.
Existing automated browser no-sandbox behavior and synthetic/local transports
remain acceptance limits. No AWS, cache-save or artifact-upload path is added.

October 18 — Empty-cache worker source build and runtime accepted

A public git archive at `cb74864` supplies the unchanged worker Dockerfile and
sources. Rootless Podman uses a new overlay graph, zero initial images, no
additional image stores and anonymous registry access. Its source build passes
in 360.035 seconds. The actual existing toolchain verifier passes in 16.166 seconds
under nonroot/network-none/read-only/capability-drop constraints, with asserted
512 MiB scratch ownership/mode and noexec/nosuid/nodev. No owned containers remain.
The installed engine requires CPU period/quota build flags and `U=true` tmpfs
ownership; both refused CLI forms and their costs are retained. Total build/check
wall time is 378.222 seconds; upstream HTTP counts/bytes are not separately measured.
No AWS account requests, KMS, Actions, image redistribution or release-security
approval is claimed. Broader independent installation and configured delivery
remain open.

October 18 — Pure tile-cache contracts extracted

`apiTileCacheContracts.js` owns the existing seed selector and six response
parsers, with their two private coordinate/bbox helpers. Its imports come only
from `apiResponseContracts.js`. `apiClient.js` retains the same six parser exports;
the selector stays internal to that client. Static comparison preserves nine
moved declarations, 289 retained declarations and all 169 public exports. The
existing client suite passes all 154 cases. This reduces the central file by
479 lines without changing request, authorization or processing behavior.
The capability guide also distinguishes accepted local Berkshire native publishing
from unverified independent installation and production identity/HTTPS/CDN delivery.
No build, deployment, cloud call or Actions run is used.

October 18 — Community validation has no cache-save path

The canonical `community/.github/workflows/api-contract.yml` is copied by the
existing exporter. Its two standard `ubuntu-24.04` jobs preserve their checks,
8/15-minute limits, concurrency and read-only credentials. Pinned restore-only
cache actions reuse npm/pip downloads; setup-node automatic caching is explicitly
disabled and setup-python cache saving is unconfigured. Installs remain unconditional.
No artifact upload or AWS action is added. Existing cancellation cases join the
same Node loop and owning file filters. YAML/source comparison preserves all
previous run commands. Public runner eligibility and storage behavior are distinct
from the unknown private minute allowance and from actual deployment acceptance.

October 18 — Preview compiler cancellation accepted locally

`buildFrameworkPreview` accepts an optional signal through the existing build
path. `esbuild-with-signal.mjs` owns context cancellation and disposal, retains
the abort reason and removes listeners; unsignaled calls keep native build behavior.
CSS siblings settle before failure returns. The TIFF fixture combines its hook,
deadline and teardown signals, aborts before draining setup, and keeps its original
browser test body and all timeouts unchanged. Ten lifecycle cases include actual
native cancellation; the existing synthetic browser workflow passes in 3.071 seconds
with no temporary directories remaining. This uses cooperative esbuild cancellation,
not an OS hard-kill guarantee. Full CI and configured deployment remain separate.

October 18 — Core frontend boundaries accepted locally

`apiResourceContentContracts.js` owns authored content parsing/serialization;
the unchanged public-URL validator joins existing shared response contracts.
`WorkbenchMapDrawing.js` owns drawing, completion/cancellation, query geometry
and guides, using existing Workbench actions and per-view context. The original
API client and Workbench exports remain. Static comparison preserves 965 function
bodies/parameters and existing classes; the two central files shrink by 1,113 lines.
The six selected existing suites pass all 259 cases. UI suites require separate
processes because their global JSDOM fixtures conflict in a combined run.
No dependency, cloud, build or deployment changes. Broader decomposition and
independent installation/delivery acceptance remain open.

October 17 — Standalone GitHub build installer accepted offline

`nativeGitHubBuild` and the explicit `github-build` phase carry retained core
metadata through the existing entrypoint, controller, IAM and API queue/provider.
The controller reuses the ARM64 API image; the GitHub runner uses the existing
AMD64 compiler, with no added host or private endpoint. Foundation exports the
application KMS ARN. Dormant resources precede bounded coordinator-only login
setup and verified account connection registration. Matching reruns preserve the
connection ID/verifier/time and source/dispatch history. Current enabled Cognito
and account-admin authority, exact App repository/workflow/ref access, actual secret
encryption and runtime tenant readback gate success. Incomplete setup never restores
execution admission; completed roles/registrations are reused safely. Optional
Artifact account grants remain explicit. The disabled repository-variable template
is applied by the operator; the installer changes no GitHub permissions or settings.
Private/public Python checks, scoped public CDK checks, actual SQL and TypeScript
pass offline. These are setup contracts, not independent or live acceptance.
See [operator setup](community-aws.md#trusted-github-compiler-configuration).

October 17 — Independent GitHub compiler configuration accepted offline

`GitHubFrameworkBuildAccessStack.independentDeployment` binds concrete local
storage, RDS, KMS, dedicated secret/ECR and numeric GitHub repository/owner identity.
Trust defaults off and requires exact immutable subject/environment/ref evidence.
The host shares a closed operator profile across preflight, ECR pulls and Podman;
canonical source, same-account custody and the reviewed runtime SHA are required
before dependencies. Managed defaults and local digest-only isolation are retained.
The manual workflow uses the same profile, explicit independent free-capacity
admission and unchanged runner/timeout/permissions. The exporter now includes only
that workflow plus the generalized access construct and tests. Existing runtime
and IAM suites, exporter/workflow review and TypeScript pass offline. This does not
install the controller, establish its database connection or activate execution.
Those installer connections and independent live acceptance remain open.

October 17 — Standalone publication-origin registration accepted locally

`publication-origin` invokes one owning database helper with the existing installer
configuration. STS, exact verified Cognito identity, same-account S3 metadata and
deployed CloudFront/OAC/release-path checks precede database writes. The helper
requires an existing active account administrator and uses the existing migration
client and runtime principal/tenant context. It creates no membership or hosting.
Parameterized registration locks the hostname and record, preserves immutable
identity/current release/mounts/history, and treats exact reruns as reads. Mutable
entitlements require an idle origin and current generation; prefix changes are
rejected once addresses exist. Runtime readback gates the retained success receipt.
Twenty-eight installer and thirteen helper checks pass. The existing PGlite suite
passes 22 cases and executes the actual helper query bodies with runtime permissions.
No native PostgreSQL or hosted installation claim follows. Admitted compiler and
independent identity/HTTPS/CDN acceptance remain open.

October 17 — Standalone on-demand publication phase accepted offline

The existing CLI/CDK entrypoint accepts closed `nativePublication` metadata with
complete independent delivery tuples and a dedicated local database secret.
The retained API digest also supplies the existing publisher. Explicit installation
names leave managed defaults unchanged. API dispatch and queue consumption default
off; successful function-only role setup is checkpointed before an explicit enable
setting can take effect. An interrupted final deployment reuses that role receipt.
Studio/private-custody destinations and the Studio distribution are rejected.
Publisher queue exports survive disable/reconfiguration while the API transitions.
Actual entrypoint synthesis and installer recovery checks pass; no cloud resources,
compiler or publication job run. Origin registration is now connected and accepted
locally as recorded above. Admitted compiler execution and independent live
installation/delivery remain incomplete.
See [operator instructions](community-aws.md#optional-publication-delivery-setup).

October 17 — Standalone private-preview phase accepted offline

`community-aws.py` accepts closed optional `nativePreview` metadata and a separate
`preview --apply` phase after the core runtime. It uses retained immutable images
and concrete origins through the existing CDK app, without implicitly enabling
the phase from configuration alone. Account verification precedes durable intent
and stack changes; later commands preserve that intent after interruption.
The exact four generated shell files use the installation's Studio authority and
owner-checked, checksum-verified, versioned writes. Completed writes are reused;
an uncertain write is reconciled or stopped without overwriting conflicting content.
Eighteen Python checks, seven CDK cases and TypeScript pass, including actual
entrypoint synthesis and the draft message handler. No cloud resources or runtime
are started. Native runner/publisher installation and live identity/HTTPS/CDN
acceptance remain open. See [installation instructions](community-aws.md#optional-private-preview-setup).

October 17 — Private preview can use independent installation resources

`ObservablePreviewEdge.independentDeployment` supplies a separate preview hostname,
Studio origin, shell bucket and resource prefix, with an optional explicitly enabled
maps hostname. It validates exact literal application-bucket identity, separate
custody, same-account certificate/WAF and distinct canonical origins. Managed
configuration keeps its existing guards and defaults. Signed output paths, OAC,
key groups, cache policies and all CSP directives except framing authority remain.
Foundation binds the preview to its configured Studio; both API variants consume
its origin. Community Studio permits only explicit independent preview origins.
The normal browser configuration generator now supplies the existing trusted-origin
map from operator environment settings. Selected CDK and browser checks pass.
Standalone installer wiring is now accepted offline as recorded above; configured
cloud delivery remains unaccepted.

October 17 — Ordinary local publication delivery accepted

The existing development action consumes approved native publication jobs, one
canonical 64-file step per review, with at most four reviews. Only deployed reviews
are acknowledged. The owner-checked, same-origin destination form remains explicit.
Public reads now coalesce at most 32 paths per process, with four active processes,
64 outstanding assets and a 50 MB aggregate byte cap per batch. Each file retains
canonical membership and checksum checks under the activation lock; expected
per-file failures leave valid siblings readable. Nothing is cached across requests.
Sixteen coordinator and fourteen public-custody checks pass. The existing Berkshire
edition renders anonymously with 16 polygon paths and tables of five and eleven
rows. Its build, review, source objects and release remain unchanged. Independent
installation, production identity/delivery and private CI admission remain open.

October 17 — Catalog preview response contracts separated

`apiPreviewContracts.js` owns the existing bounded spatial and document parsers.
The API client retains its public exports and reuses the geometry validator for
governed features and public previews. Its shared checksum helper moves unchanged
to `apiResponseContracts.js`, preserving its TypeError behavior. All other parser
bodies are unchanged; 166 existing client and Catalog tests pass. No wire format,
permission, storage or runtime setting changes. Build and delivery remain pending.

October 17 — Current managed-analysis routes and SQL lifecycle accepted locally

The existing native helper can use current API source and an isolated clone of
the accepted schema, avoiding repeated migration setup and the older frozen HTTP
package. Actual ASGI requests exercise native principal and tenant repositories;
targeted SQL verifies profile binding, the four-job cap and host-close fencing.
The fixture's plaintext exception is confined to its exact isolated loopback DSN;
production TLS settings are unchanged. All temporary resources are removed and
the original study is unchanged. See [progress](progress.md) for retained failure
and cumulative usage. Managed activation and remaining host/cloud checks stay open.

October 17 — Fresh-state Publication source import accepted

The unchanged public development runner initializes a new local database from the
current public checkout. Studio opens and creates a Project/map through its normal
controls. The Files editor imports the real Berkshire source ZIP, deliberately
saves draft revision 1 and reopens all four exact files. Source rights remain
unreviewed. Cached software and synthetic local sign-in qualify this result;
independent operator/clean-machine and production delivery acceptance remain open.
The [progress record](progress.md) retains failures, usage and verified cleanup.

October 17 — Real study input packages and native rendering

The Berkshire ACEC example preserves the exact 284,185-byte historical GeoJSON
and its separate provider, archive and curated metadata. Its dependency-free
method groups 16 municipal records into five designations and eleven towns,
rejecting inconsistent designation names instead of summing repeated areas.
The package command uses the existing Project and Publication archive validators.
Actual native output renders the map, legend and calculated tables. The cached
Studio imports its editable backup, changes opacity, saves and reopens with all
geometry and category styles intact. No hosted records or service configuration
change. Independent installation and configured production delivery remain open.

October 17 — Saved-map Artifact reaches the native Publication

The local compiler profile now enables portable Artifact retention through local
storage and the normal tenant repository. The coordinator resolves exact Artifact
inputs through the live lease and current permissions. A shared adapter defect is
fixed: current v3 requests combining Catalog data and Artifacts now load their
Artifact authority, as v2 already did. Requests without Artifacts retain their
existing behavior; request/checksum validation is unchanged.

The existing map resource is reused and explicitly advances to map v2. Portable
edition v1 and reference revision 1 retain the 2,126,629-byte output. The Source
editor's completed autosave is reconciled, preserving its Catalog data binding.
One replacement request follows the diagnosed staging failure; only one native
compiler invocation occurs. Its private preview renders all five points with
#2563eb color, 0.8 opacity, white 1.25-pixel outlines and the exact saved camera.
The final read-only opening reuses that successful build. The portable map
retains reviewed browser snapshot provenance (`authoritativeBuild: false`).

Fifteen adapter cases, six local-adapter cases and three actual API-profile/upload
checks pass. The selected journey totals 107 API attempts and 80.737 seconds of
active browser/controller time, including failures. Known local pilot stages total
1,181.209 seconds; agent effort and a dollar total are unavailable. Original limits,
explicit revised ceilings and failed attempts remain retained. All API, worker,
compiler and diagnostic containers are absent; the database is stopped. No AWS call,
Actions run or public release is used for this local increment. Independent operator
installation, a realistic study and configured production delivery remain open.

October 17 — Registered Catalog input reaches a native private preview

The existing Source editor connects the retained 1,472-byte CC0 GeoJSON through
Catalog search and exact dataset/version/file selection. Saving the data-binding
revision reuses the original 803-byte authored source object. The revision pins
archive identity, S3 version, size and SHA-256. One real coordinator/compiler job
succeeds; its signed private preview executes FileAttachment and displays all five
names and the strict boolean result, 4/5. Exact map readback remains unchanged.

The helper reconciles a completed registration before continuing and preserves
initial autosave, source-object reuse and cumulative request counts. The accepted
continuation takes 21.314 seconds; all selected-study attempts total 82 API calls.
Known community pilot stages total 1,052.201 seconds, including failed attempts and
local prerequisite recovery, under the explicit 1,100-second ceiling. Prior
publication/history/security evidence is reused without replay. All local runtime
containers are stopped. No AWS call, Actions run or public release occurs.

This verifies archived Layer input through the existing source component and
native pipeline. Retained Project Artifact presentation, a realistic reproducible
study, independent operator installation and production delivery remain open.

October 17 — Compiled local core Save and restart/reopen accepted

The existing five-point CC0 study now passes the complete selected local core:
compiled UI Project/map creation, upload, completed ingest, actual Catalog rendering,
deliberate map addition, styling, UI Save and rendered reopening. Catalog inspection
renders all five names without changing the Project. Canonical expired-lease
recovery completes the same interrupted ingest job/version on attempt two; normal
account API readback confirms active state, no error and five features. No job,
lease or version state is manually rewritten.

The saved map is version 2, pinned to the exact uploaded dataset version, with
`#2563eb` point color and 0.8 opacity. Actual MapLibre feature/paint assertions pass
before and after reopening. The runner stops the database between invocations;
a final read-only invocation compares the exact saved definition and renders all
five names after restarting it. API/worker containers are absent and the retained
database is stopped. No AWS or new Actions runs are used.

The smoke retains completed writes, cumulative elapsed time/API attempts and
incremental response/worker logs. Current native menu/row labels replace obsolete
test selectors. Once styled Save succeeds, API admission permits only reads and
exact-source download grants. The core-only cumulative usage is 174 API attempts and
159.346 seconds of browser/controller time, against explicit revised bounds of
185 and 180 seconds; earlier failed attempts are retained. Measured local pilot
stages total 965.508 seconds, below the existing 1,000-second ceiling. Agent/tool
overhead is not represented as measured runtime or a dollar estimate.

The public opening flag and installed pinned-CLI builder fixes remain accepted;
Catalog's blank-background fallback and two focused cases pass. Earlier public
validation at b5afc3d passes both existing CI jobs; follow-up source has separate
[CI receipts](https://github.com/categori-se/opengeo-community/actions/workflows/api-contract.yml). Broader selected-input Publication round trips, independent full-stack
installation and configured production identity/delivery remain open.

October 17 — Standalone images and frontend

The standalone API Dockerfile now applies libuuid 2.41.6-r1 and SQLite 3.53.4-r0,
matching the reviewed Lambda fixes. The private integration source policy checks both
Dockerfiles. Its OS-only update follows locked Python installation so cached Python
packages remain reusable. After an initial Docker-format rebuild hits its time
ceiling, the normal OCI build reuses that layer and completes in 9.169 seconds.
Exact package readback and real HTTP 200 pass as user 10001 with read-only root,
network disabled and no credentials. Automatic health metadata is not accepted:
Podman's normal OCI format omits it. Database readiness/auth remain unproved.

The maintained compiler Dockerfile builds with its default pinned images and
passes its existing real compilation fixture. Credential exclusion, route/output
validation and runtime cleanup pass without a source overlay. Current worker
build/security CI evidence is reused; no worker rebuild or publication replay.
An independent full-stack journey and production identity/delivery remain open.

The fresh app graph, esbuild lifecycle/native binary, 154 client tests and sealed
seven-page frontend build also pass. The runner includes `project_module.py` in
its snapshot. IdentifyResultsPanel owns the report presentation; Workbench keeps
query/selection authority. Three existing Identify cases pass. These new local
artifacts have not been deployed.

October 17 — Publication access and response-validation boundary

The existing security-only runner now admits the exact reconciled viewer-bootstrap
failure using pinned failure/cleanup receipts and migration0176. It reads back the
previous accepted invitation and absent memberships before any new fixture write,
preserves both failed attempts and reuses completed editions. The connected run
passes viewer access, revocation, real 60-second capability expiry and signed
cookie expiry with an explicitly advanced local verifier clock. Immediate
revocation of issued 15-minute cookies remains unsupported; production identity
and delivery are unproved. Cleanup preserves audit history and stops local runtime.

`apiResponseContracts.js` separates shared errors, response decoding and primitive
validators from API requests. All 35 declarations retain their original bodies,
public error identities remain stable and 154 existing client tests pass. The
new module has no imports; broader domain-parser/Workbench extraction remains open.

October 17 — Current browser and historical contract inputs

The quoted Node test glob selects both top-level and nested frontend suites.
Community core CI `39045917549` passes. Private run `39045915133` passes its seven
non-frontend jobs; its frontend reports 2,457 passes, zero failed assertions, one
TIFF cancellation and one skip. Application build and browser routes did not run.
The TIFF fixture now uses existing bounded before/after hooks for cold compiler,
editor and Chromium setup (15 seconds), actual UI behavior (18 seconds), and
cleanup (five seconds). All original assertions and other execution modes remain.
The changed case passes locally in 12.326 seconds; complete CI is pending.

A shared guarded Identify focus helper runs after opening Results and after
loading/completing governed queries. It requires an active, visible Identify panel
and a live context. Query authority, abort/revision handling and status text remain
unchanged. A focused actual-component regression verifies result attributes and
pending/completed focus, plus unchanged external focus after hiding or switching
panels. It passes after correcting the test renderer's required getStyle method.
Studio's immutable successor passes the actual compiled feature-click, focus,
Hide/reopen and Escape/reopen check. Native Popup focusAfterOpen receives the
existing focus choice, resolving the separate local-feature focus loss. Earlier
failed candidates remain retained. Studio `0b094fd7746c` is delivered with four
exact software readbacks and a completed origin update/invalidation. The release
window is closed; Demo remains live.

GitHub Actions are limited to the free allowance. Two exact billing reads cannot
establish remaining capacity, so no new runner job is admitted. Retain a release
branch checkpoint and leave required main-branch validation pending; do not skip
checks or assume paid minutes are available.

Migration0176 removes only the capability-to-membership foreign key, retains
stable requester and build identities, and requires/key-share-locks current
membership on insert. API issue and SQL exchange permission checks are unchanged.
The existing Observable database test file passes in 10.781 seconds, including
consumed/unconsumed audit retention and denied issue/exchange after offboarding.
Applying it to the retained local database permits exact temporary-guest cleanup
in 1.981 seconds while preserving both capability records, invitation history,
owner and other Project grants. The database is stopped and API removed. The
second browser security attempt remains failed at viewer navigation; its fresh
document source correction is not a complete expiry/revocation acceptance.
Production migration activation and that complete browser journey remain open.

Historical tests exercise the original approved inputs while rejecting current
activation: four focused cases pass, with original seals unchanged. Auth checks
preserve Home defaults and explicit return destinations. Automatic field-capture
replay waits while explicitly offline; its checks retain device-only drafts,
credential exclusion and accepted-data readback. Application routing, staging and
production authorization remain unchanged.

Automatic validation retains the full Studio browser suite, screenshots and all
security/service checks. Five existing Demo/legacy compatibility steps are
explicit manual opt-ins, enforced by the CI policy check. They are not marked
complete or passing without their own execution. The preview contract now records
60-second capabilities and 15-minute issued-cookie leases; complete browser
expiry/revocation, independent installation and production delivery remain open.
Demo Identify `f9104ca4a640` remains the verified delivery; Studio's new explicit
panel action remains source-only. [Checkpoint](progress.md#october-17--current-browser-and-historical-contract-inputs).

October 17 — Native publication revisions and earlier editions

The connected source UI, normal API, real PostGIS leases and native compiler now
produce two retained builds. Actual Publish controls prepare and approve both
reviews; the canonical restricted-SQL publisher activates each release from
separate immutable public custody. Private previews, anonymous current delivery,
old private Build history and retained public editions pass locally. Missing and
cross-build preview cookies are denied. Ten retained output files total 175,040
bytes. The first completed build is reused after fixing a separate hardcoded
preview-origin check in the API client; no successful save, build or publication
is replayed. Preview origins remain deployment-controlled and profile-specific.

This uses the existing runner and CC0 fictional study, cached images and synthetic
sign-in. Public delivery is explicitly mapped to a third loopback HTTP server;
DNS/TLS/CloudFront, clean installation, independent AWS acceptance, complete browser capability replay,
expiry/revocation and deployment are not established. Focused checks and independent
source review pass. The 412-path API contract is unchanged. Broader Workbench and
API-client decomposition remains open.
[Checkpoint](progress.md#october-17--native-publication-revisions-and-earlier-editions).

October 17 — Demo space and startup error handling (local)

Demo map descriptions, attribution, service limits and secondary actions now
open from About this map; the default strip is 43px at a 974px viewport. Existing
adjacent visibility controls are preserved and navigation labels remain on one
line. Workspace and Demo entry cells catch bootstrap failures once and offer a
friendly retry/home state. Normal API workspace entry no longer requests the
fixture catalog. Focused tests, Framework parsing and a component-bundled Chromium
journey pass without cloud calls. A broader, unchanged workspace-switcher test
still fails; this patch has not been built as an application release or deployed.
Foundations pass. The parity gate reports existing fixture artifact SHA mismatches;
the patch does not rewrite historical evidence.
[Browser evidence](../.local-archives/demo-ui-20261017/browser-results.json).

October 17 — Styles reference navigation and toolbar grouping

The existing full local symbology gallery now has collection shortcuts and visible
USGS/OSM/Maki/MassGIS source guides. The changed browser navigation passes with all
1,289 entries and no resource writes. Studio `165f0a10fcdb` now delivers the gallery.
Desktop quick-tools and Map-controls toggles share a nonwrapping group; the
existing phone toolbar remains separate. Site/account menus dismiss on outside
clicks or Escape and restore trigger focus. Site-switcher links use each site's
home route, including Demo's `/`, rather than hardcoded `/workspaces`.
One isolated Studio build passes compiled gallery navigation, imported Hospital
rendering, memory Style/Project save/reopen and dropdown behavior. Existing build
and release gates pass; foundations pass and 179 historical parity hash diagnostics
remain open. Held Style archival and managed execution are excluded. Production
delivery passes after explicit user approval: one cutover/invalidation and four
exact software reads. Hosted persistence remains open; Demo and API are unchanged.

October 17 — In-map script editor and isolated local runner

The docked console reuses Monaco, Workbench menus and the scratch-Layer path.
Browser JS and three native languages pass actual local execution; the development
bridge and default-off profiles pass focused checks. Outputs require deliberate
Add and retain host provenance. No API/compiler process evaluates user source.
Actual native local HTTP Run/Add/Stop and exact cleanup also pass. Managed source
now has private jobs, exact application-bucket transfers, explicit SQS/controller
wake and separate default-off lifecycle. Actual local coordinator execution covers
all three languages and cancellation; selected earlier native SQL groups pass.
Offline lifecycle checks cover one retained startup receipt, concurrent idle
admission and closing the window before consumer exit. The changed SQL quota and
closure paths remain native-unaccepted. Connected API HTTP/database acceptance,
admitted AMI/fresh-boot rootless security and real
AWS cleanup/deployment remain open. [Contract and limits](python-automation.md#analysis-console-in-a-map).

October 17 — Identify and Point clustering delivered; selected-map persistence

The isolated current-Studio increment removes only the CSS selector hiding Identify
popups with Map controls hidden. Native MapLibre Point clustering has individual and
explicit batch controls, filtered source counts, bounded local count images and
independent saved Project/Print-frame preferences. Pinned MapLibre 6.4.1 needs its
awaited missing-image resolver; actual compiled count rendering now passes after a
helper-only correction. Forty focused isolated and 41 merged-source cases pass.
Compiled local checks cover click/expansion, on/off, batch, filtering, source retention,
memory save/fresh reopen, archive Identify and actual print capture/frame save.
Hosted Print-frame persistence and visual paper-layout acceptance remain open. Dependency bytes
are unchanged. Foundations pass; 179 historical parity seals remain stale and are not
marked passed. After explicit user approval, Studio `165f0a10fcdb` delivers this
increment. The Nepal presentation passes one version-checked save and fresh
readback, version4→5: sparse points first, clinic clustering, translucent clinic
polygons and administrative outlines, preserving icons and source pins. Berkshires
returns404 under the normal account; no Berkshires patch or grants change occurs.
Its geometry-area ordering and maintained water/wetland/forest colors remain
prepared. [Saved-map receipt](../.local-archives/renderer-switch-20260930/point-clustering-20261017/layer-presentation-audit/operation-receipt.json).

October 16 — Configurable PMTiles v2, local release candidate

The selected v2 extension separates input and output Layer names, pins closed
GDAL options and the server's exact worker image, and preserves legacy v1 jobs.
Its dedicated queue/scale-zero worker reuses the singleton lifecycle controller.
New-job admission reads the existing controller ledger under its lock and rejects
disabled, mismatched, occupied or exhausted capacity before insertion; committed
job reuse and completed reads remain available. The shared editor and completed
display admission/save/reopen use existing identities and routes. The final image
passes local GeoJSON conversion through the production runner with the selected
parameters; package inventory binds retained fresh Grype evidence. Mandatory full
security freshness, native ARM64 and real-data hosted acceptance remain open; the
shared OCR worker stays held. Isolated infrastructure templates now pass one offline
synth and root review with activation disabled. First full-image diagnostics report
no High/Critical matches on the retained stale database. A bounded real global KBA
conversion reaches its time limit after source inspection, with no final PMTiles;
its costs and cleanup are retained, and equivalent emulation retries are stopped. [Current scope and evidence](progress.md#october-16--pmtiles-priority-and-s3-first-source-reconciliation).

The managed-original intake blocker now has a local implementation: migration `0173`,
purpose-bound upload/completion, jobless preserved versions, explicit upload choice
and v2 eligibility/display checks. The source stays draft and uninspected; existing
active/v1 behavior remains. A declared GeoJSON parser protects the new conversion
boundary. The local display handoff now connects completed-job review/admission to
explicit admitted-display selection and exact saved-map pins. Save authorization
rejects raw preserved references, including mixed and unversioned references.
Pause/reopen retains the display and requires fresh transfer consent. The SDK accepts
the closed v2 provenance and conversion-limit shape. The three broader UI failures
also reproduce on the frozen baseline; they remain unresolved outside this batch.
One selected Studio build (`469a4676dd0e`), API overlay (`4de19f31aa1c`) and cached
worker build (`d32c5c7f0fc9`) now contain the edits, excluding held PostGIS/gallery
work. Compiled components pass review/admission, explicit Add, exact Save/reopen and
Pause with a memory adapter; no tile transfer or interactive renderer is exercised.
The exact GDAL 3.13.1 worker converts GeoJSON and rejects a disguised VRT in 8.844
seconds. Unchanged package evidence is reused. Successor infrastructure bindings
now pass one complete offline synthesis and review: the queue/endpoints and four
controller modules are unchanged, both triggers stay disabled and no counters change.
The native executor's explicit limits reserve cleanup capacity and bound input,
command and evidence work; 15 focused source cases pass. One sealed ARM64 attempt
installs the admitted host tools and imports both exact image identities. It fails
before the API probe starts with Python execution denied; the worker probe does
not run. Image-header review shows executable Python and loader files, without
proving the cause. Named containers are absent and the disposable stack is deleted.
The executor uses 83 SDK calls; two preflight calls and one denied console read
are tracked separately. No image rebuild, scan, ECR publication, production change
or lane activation occurs. The primary scanner database is unchanged and stale
at 12:23 UTC; no repeated archive download or scan occurs. Fresh security, native
runtime and hosted-owner acceptance remain open.

The old Studio candidate is held because it predates the delivered gallery,
Identify and clustering changes. A source rebase onto `165f0a10fcdb` preserves those
features and passes 19 actual named clustering/handoff/PMTiles job cases. Successor
`45fb78e545a9` passes one build and release checks. Its compiled browser verifies
the preserved-source handoff/save/reopen with a memory adapter, all 1,289 gallery
entries, native clustering/count imagery and polygon Identify with controls hidden.
The browser uses 216 loopback requests/7,042,261 bytes in 8.486 seconds, with no
external requests or page errors. Hosted conversion/persistence and deployment
remain open; no further rebuild is required for unchanged inputs.

October 16 — External GeoJSON Catalog preview

The existing checksum-verified reader now supports Catalog “Open map” for external
GeoJSON, showing only the selected Layer in a temporary map. The concise record
summary reports known data facts and retains structured provenance. Studio candidate
`c441ae26b800` builds once and passes the normal-owner Towns journey: actual source
authorization, CORS, checksum and 32 MultiPolygon features. It uses sealed local UI
with current hosted APIs and a blank basemap replay; deployment, other source
individual checks and PMTiles Catalog preview are not claimed.

October 16 — Stable external PostGIS Layers and transient preview source

Migration0171, selected registration/preview APIs, same-connector execution and
Catalog UI now have focused local evidence. Preview features stay in process/HTTP
memory; a Layer viewer needs no connection-manage grant. Default-off configuration
and exact existing-function IAM introduce no new always-on resource. Actual
PostGIS feature execution passes the first actual native journey in10.097seconds:
100of123rows, exact numbers, bounded named cursor, replay/revocation and cleanup.
Connected browser and configured provider/DNS/TLS/AWS/deployment acceptance remain
distinct and open. Latest point-symbol UI work passes the selected local
composition/Style, actual rendering, print and offline-export journey. Studio
`7e4a568f0fc3` and Demo `d805ac7e4a6b` are delivered with exact software readback;
held PostGIS and pattern-editor changes remain excluded. Hosted account acceptance,
individual Point overrides and the fuller visual icon/label workflow remain open.
The new maintainer materials also update four public guides without changing
runtime delivery. [Scope and checks](progress.md#october-16--maintainer-adoption-guides-and-postgis-layer-source).

October 16 — Community guide revision

Six public source guides now explain recurring-study reuse, accurate personal
browser-save retention and the distinct community, Demo and managed deployments.
This changes documentation only; standalone installation and full publication
acceptance remain open. [Scope and local checks](progress.md#october-16--community-guides-for-recurring-studies).

October 16 — Shared data workflows take priority

The latest user direction puts one complete contributor-to-publication journey
first, followed by an executable external PostGIS connector, independently tested
services, and external-site consumption. Check the current implementation and
retained evidence against the older review before changing code. Dataset
replacement, published map delivery, native embedding and local developer bundles
already have implementations; their remaining acceptance limits stay explicit.

The contributor authority audit passes nine API, ten named UI and ten database
cases separately; full distinct-role browser acceptance remains open. A bounded
PostGIS metadata/query core passes five cases, source review and one actual local
metadata SQL/EXPLAIN check. The subsequent discovery lifecycle/API/Services UI now
passes its focused cases and one real native backend journey: revision/idempotency,
claims, metadata completion, ten-plus-four paging and cancellation in9.991seconds.
No feature rows are queried, and temporary containers/volumes are removed.
Next register a reviewed relation as a stable live Layer, then bounded feature
preview and one connected browser journey. External provider/TLS and deployment
remain unproven; the new discovery gate defaults off. Studio remains unchanged. WMS identify/
legend operations, complete resumable harvesting, reliable refresh, administration
and recovery remain in scope. The ArcGIS selected-map handoff contract is queued
behind these shared workflows; no handoff product code or cloud batch has started.
Keep the full parity goal, current release and carried costs unchanged.

October 16 — Point colors/Ozi delivered; earlier ArcGIS priority recorded

Studio `f6a7c2db314f` and Demo `5c87e98bcf49` deliver the accepted Point-color
wizard and bounded Ozi WPT/ordinary PLT import workflows. Both original publishers,
one cutover/invalidation each and eight exact software readbacks pass. Existing
local rendering, preservation, export, persistence and theme evidence is reused;
no build or behavior is repeated for delivery. API `64f76c64742e` is unchanged.

The batch uses 1,546 counted AWS requests/1,514 physical software PUTs/55,575,906
bytes; eight CDN reads total1,730,409bytes/3.034s. Cumulative UI35778/API-inclusive
35815/software-lower35767 remain distinct; KMS/dollars are unknown. No account,
data, provider, job, CI, capacity, IAM or billing change. Formal24/25/1 and164 old
hash diagnostics remain unchanged. [Delivery](progress.md#october-16--point-colors-and-ozi-delivered).

The earlier ArcGIS Pro request adds selected-map handoff, secure connections,
complete retrieval and related power-user workflows to the retained scope. The
latest shared-workflow order above supersedes that earlier next-action choice.
The bounded handoff audit and proposed contract remain available without claiming
implementation or licensed-Pro acceptance.

October 16 — CSV/NMEA delivered; next import-wizard gap

Studio `da1dc9f4fa5d` and Demo `e79bec0b9531` now deliver explicit CSV/TSV/TXT
mapping and bounded NMEA observations. Accepted local render/export/personal save/
fresh-reopen/original/theme checks are reused. Both original publishers, one
invalidation each and eight exact software reads pass. API remains `64f76c64742e`;
no rebuild, account/data/provider/job/CI/new capacity or IAM/billing change.

Delivery uses 1,554 counted AWS requests/1,512 software PUTs/55,538,946 bytes,
including ten read-only requests from the stopped pre-write identity error.
That correction retains the same budget/window and all prior usage. The eight
CDN reads total 762,593 bytes/2.602 seconds; no reads are repeated after interruption.
Cumulative UI34,232/API-inclusive34,269/softwarelower34,221 remain distinct;
KMS/dollars remain unknown. Full parity stays24pass/25partial/one exclusion.

Next add optional uniform/categorized Point colors to the existing delimited
import wizard, reusing canonical circle/category styling. Preserve source strings
and disclose bounded categories/fallback. Icons, portable style templates and
numeric interpretation remain unfinished; no new provider/device/worker expansion
or another deployment before a coherent accepted feature batch. Other declared
format/geocoding/regionation and partial-family requirements remain explicit.
[Evidence](progress.md#october-16--csvnmea-delivered).

October 16 — NMEA observations accepted locally; CSV/NMEA delivery next

Local .nmea/.nme files now open through the existing source review as separate
RMC/GGA observation Points. Valid checksums/fixes are required; rejected records
need explicit acknowledgement and exact originals remain downloadable. WGS 84
requires confirmation; conflicting datum declarations reject the file. Source
time/date/MSL-height fields remain separate from XY geometry, with no century,
track or talker-merging inference. Account maps retain temporary browser data.

Four reader and three chooser cases, one 1,000-observation pilot, actual compiled
render/export/one IndexedDB save/fresh reopen/original checks and both themes pass.
One Studio and one Demo build include the accepted CSV work. No AWS/account API/
provider/CI/package acquisition or deployment; live versions and formal 24/25/1
remain unchanged. Next prepare one coherent frontend delivery using these exact
artifacts; no rebuild or another format increment before delivery.
[Contract](workbench.md#local-nmea-observations--october-16),
[progress](progress.md#october-16--nmea-observations-accepted-locally).

October 16 — Delimited-coordinate workflow accepted locally

The lazy wizard reuses d3's installed row parser and the existing CRS transformer,
Layer review, browser Catalog/personal library and temporary-work paths. It adds
explicit column/CRS/height/label choices, preserves source strings and exact bytes,
and reports rejected records before deliberate omission. The old permissive CSV
conversion is removed. Managed table upload keeps its original callback and data.

Four reader cases, six normal chooser cases and the retained one-maximum pilot
pass. Actual compiled rendering, GeoJSON/Project/original downloads, one IndexedDB
save and fresh-document reopen pass with exact metadata and source strings. Both
mapping/review palettes pass at 390px; all four screenshots are inspected. One
Studio build and build/PWA checks pass, with no Demo build or cloud activity.
One harness-only data-access failure is retained and corrected without a product
rebuild or repeating accepted theme checks. Nine product/build files are isolated
over the delivered Esri/GPX source; held root changes remain excluded. The two new
modules account for Demo core 241→243 with all other limits unchanged. Delivery
remains pending; wider GIS/GPS and full parity remain incomplete.
[Scope](workbench.md#local-delimited-coordinate-import--october-16).

October 16 — Esri outcomes and GPX delivered

Studio `855674754ddd` and Demo `925839af9e52` deliver explicit Esri apply feedback
and the accepted GPX workflow. The activation function returns its commit outcome;
the Esri form shows loading/success/failure and prevents duplicate submissions.
Four source cases, six retained activation cases, five Demo policy cases and actual
compiled no-key activation/outage/theme checks pass. Original map/camera persist
on failure. One public metadata/tile sample succeeds; user-network cause is unproven.

The two original static publishers/invalidations and eight exact software reads
pass. API remains `64f76c64742e`; no backend/account/data/job/capacity change. Two
Studio build starts include an incomplete isolation/cache failure; one corrected
Studio build and one Demo build pass. Extra Demo staging was moved out of Studio's
release tree without changing or rebuilding assets. GPX acceptance is reused.
The separate delimited-coordinate core passes four source cases and one maximum
pilot; UI acceptance remains unfinished and excluded from this release.
[Evidence and remaining work](progress.md#october-16--esri-apply-feedback-and-gpx-delivered).

October 16 — GPX local import and preservation accepted

The lazy reader reuses installed OpenLayers 10.10.0 and retains original GPX bytes,
source fields and per-point elevation/time alongside normalized working geometry.
Tracks become separate segment features; missing elevation/time stays missing.
File review uses explicit deployment/storage context. Account-map additions remain
scoped temporary data excluded from account Save. The native 1.6 snapshot import
gate now matches the already deployed API contract.

Four reader cases, three new Workbench cases and retained source/temporary/Project
checks pass. The actual compiled mixed point/line map, exports, IndexedDB save and
fresh-document reopen pass. Final light/dark review, original checksum, build and
PWA checks pass after one demonstrated token correction. Two isolated Studio builds,
zero Demo builds and zero cloud/API/provider/CI calls; deployment remains pending.
The managed creation case uses a fixture adapter, not a new hosted account write.
[Contract](workbench.md#local-gpx-import--october-16).

October 16 — 3D face delivery and real persistence accepted

API64f76, Studio0d502718f024 and Demof2ae55e2ac38 are deployed. Fresh exact-image
ECR security passes; image-only promotion retains runtime/config/CORS and data.
The full normal compiled ProjectWorkspacePage edits the archived analytic fixture,
CAS-saves native1.6version3 and freshly reopens from the server. Source/datum,
topology and the prior profile survive; JSON numeric differences are bounded to one
IEEE754 step. Both original publishers/invalidations and eight exact software reads
pass. No further build or acceptance replay is needed. All harness failures, the
12SRPvs5initial ceiling and costs remain in the progress ledger. Broader terrain and
worker/PMTiles acceptance remain open; no formal parity row is promoted.

October 16 —3D face measurement accepted in source

The new lazy editor/core supports vertical and sloping XYZ faces, projected
triangulation,3D metrics, conservative radial uncertainty and closed GeoJSON.
Saved measurements and map definition1.6retain the record and reject invalid new
imports. The API independently verifies boundary/topology and numerical summaries;
6newJS/8retainedJS/27API+Schema cases pass. Scoped lint and two owning Python files'
type check pass; six preexisting errors in unrelated imports remain recorded.
The actual compiled editor/edit/GeoJSON/fixture Save/fresh-reopen passes. Four builds
per surface include demonstrated import and theme corrections; final contrast,
PWA/release/local-publisher gates pass. API64f76 retains11runtime layers and adds
37,594B; its exact nonroot/network-none ARM64 runtime validates the browser payload,
rejects forged/old-format records, preserves401guards and cleans up in76.413s.
No cloud/data/provider/job/CI/capacity change. Coordinated delivery waits for
matching API1.6support. [Contract](workbench.md#3d-polygon-faces--october-16-local-implementation).

October 16 — Cached elevation-grid visibility delivered

A read-only native COG adapter supplies cached sample centres/corners/values with
visibility/release invalidation. The lazy grid solver reuses the profile sight-line
primitive, triangulates in an observer metric frame and bounds solid terrain queries.
Catalog and Project reuse one form for explicit elevation interpretation, observer
selection, uncertainty, cell inspection and source-terms-gated GeoJSON. Deliberate
Project addition reuses temporary processing Layers. Ten new grid/form cases,
16COG/7LOS/2Project cases and a real compiled TIFF/MapLibre journey pass locally;
no analysis reads or original source/style changes. Final checkbox CSS, both built
release gates and eight exact software reads pass. Studio `039d019a7be1` and Demo
`96a5f99825ee` are live, with both original publishers/invalidations complete.
No API/worker/account/data/CI/capacity change; no further rebuild or delivery is
needed. [Contract](workbench.md#cached-elevation-grid-viewshed--october-16).

October 16 — Saved-profile LOS and uncertainty delivered

The existing path module validates saved samples and computes planar or spherical
chord clearance, optional conservative elevation bounds and explicit incomplete
results. A shared measurement inspector exports a recomputed closed JSON record;
the Workbench and Demo staging use that component.11 focused cases and actual
component/download/light-dark browser checks pass. The actual compiled measurement
workflow/download/fixture Save/fresh-reopen also passes with exact profiles and no
analysis requests. Studio1/Demo1 builds and affected gates pass. Studio
`8cfd8dc2d720` and Demo `594b309a19a0` are deployed; both original publishers/
invalidations and eight exact software reads pass. Five product changes and the
reviewed Demo core233 allowance preserve held root work and deployment profiles.
Hosted terrain/persistence, full DEM-grid viewshed and broader parity remain open.
[Contract](workbench.md#saved-profile-line-of-sight--october-16).

October 16 — Cached COG Identify and native export controls delivered

The existing reader retains bounded native sample arrays for Catalog clicks and
Project Identify, including main/overview scope, source NoData and display masks.
Identify adds no network request. Canonical native controls now track queued/API
visibility and mixed groups; developer export consumes that same function.33 owning
cases and compiled browser checks pass. The visual Refresh overlap fix has its own
narrow browser acceptance; earlier behavior checks are retained. Studio2/Demo1
isolated builds and affected gates pass. Studio `25dd1b64041f` and Demo `1b4095765287`
are deployed; both original invalidations and eight exact software readbacks pass.
Deployed API34112 remains unchanged until a later coherent API release.
[Scope](stac-services.md#cached-raster-value-inspection--october-16-delivery).

October 16 — Combined local export workflow delivered

The actual built Workbench now downloads native developer, publishing-source and
figure/print ZIPs from one local map. All payload hashes pass; prepared HTML reopens
in the existing source importer; figure PDF contains the exact JPEG and validates
as one A4 landscape page in Poppler. Canonical data/style remain unchanged. No
account/provider/job is invoked by preparation. Both isolated builds, affected
PWA/release/publisher gates and five release-policy cases pass; the strict existing
rollback frame helper is reused. Demo's validator closure is bundled without API
transport. Five added export assets account for core226→231; byte/SDK/PWA limits
remain. Studio `07c582b28b80` and Demo `4383ad0196b1` are deployed. Both original
publishers/invalidations completed and eight exact software readbacks pass.
[Figure contract](print-studio.md#figure-and-print-pack--october-16).

October 16 — Native developer ZIP accepted locally

Five product files and two existing build scripts add a developer format to the
interactive export dialog. It reuses the API native viewer, preserves separate
source/curated attribution and provides a checksummed package, source metadata,
preview and Observable example.23 focused cases plus actual download/cross-origin
Framework/native/offline acceptance pass. Python byte comparison proves generator
reuse. The final metadata-only followup has owning acceptance. No full application
build, deployment, API/provider/job/CI or cloud call. Package/renderer limits and an
observed checkbox-sync gap remain explicit. Finish the related figure pack and hosted
handoff before a bundled release. [Contract](project-artifacts.md#local-native-developer-bundle--october-16).

October 16 — Explicit Demo presentation and stable menu row accepted

Three product files separate Demo presentation from browser-local persistence and
put menus above quick tools. Studio and Demo now use their own navigation/actions
on desktop and in the phone Actions sheet. Four component cases and eight actual
compiled layout/theme cases pass; reviewed screenshots are readable. Two local
builds per surface include the demonstrated one-line mobile-navigation correction;
all prior failures/costs remain retained. Final release gates pass. Studio
`aad910664c4e` and Demo `5e073388a8f6` are deployed with both invalidations complete;
eight exact software reads pass. No API, data, provider, worker or capacity change.
[Owning contract](workbench.md#stable-menus-and-deployment-context--october-16).

October 16 — Home entry and local authoring delivered

Demo root now renders the map; example directories require explicit navigation.
Open Studio and generic authentication target Home; explicit resource destinations
remain intact. Installed Studio start_url is `/`. Five product files, one build
setting and two owning gates implement the correction.19 local cases and compiled
entry/sign-in transaction pass; twelve exact software reads verify deployment.

The delivered personal IndexedDB library, editable ZIP restore and local Print
implementation are preserved. No account/data/provider/job or capacity changes.
[Contract and remaining proposal exports](workbench.md#free-local-workspace--revised-proposal-october-16).

October 16 — Revised proposal and local Print implementation

The revised proposal prioritizes a complete free local workspace. The first local
increment connects anonymous browser Projects to the existing Print editor through
`BrowserPrintStudio`, preserving loaded geometry, camera and presentation. It saves
only layout metadata through existing browser storage and retains layouts in Project
files; a quota failure preserves the last save and permits recovery. Five product
files are isolated against deployed C6f;47 root and three isolated candidate cases
pass. Built MapLibre/browser and deployed local Print acceptance remain open.
No build, AWS/provider/CI call, server job or deployment. Daily Demo storage and
separate non-daily startup drafts remain unchanged. The personal IndexedDB library
and complete bundles are next; see [selected scope](workbench.md#free-local-workspace--revised-proposal-october-16).
Billing, quoted prices and license/edition changes are not activated by this proposal.

October 16 — Scientific raster display delivered

Studio `c6f78035cd1d` deploys the seven-file scientific COG increment on77db:
Catalog grayscale ranges for signed/float values, transparent missing data, and
Project display settings retained through Apply, Save and fresh reopen. Thirteen
focused cases, two root integration cases and the compiled real-Float32/MapLibre
journey pass locally; its Save callback is a fixture. Hosted scientific persistence
remains unverified. Earlier metadata, native examples, Identify and Print work is
preserved. Two existing local builds/gates are reused; no new build or CI run.

Delivery uses870 counted SDK calls,842 software PUTs/32,206,753 transfer bytes,
one cutover and one completed invalidation. Six exact software reads pass
(1,325,219 bytes; auth remains no-store). The original wait ended while CFN was
still running. Completion follows the same handle without repeating any upload,
cutover or invalidation; all earlier attempts/time remain recorded and the original
870-request ceiling holds. UI cumulative19,000/software-control lower bound18,952.
No API/SRP/provider/data/job/new capacity; mediated KMS and dollars remain unknown.
API, Demo, DB and blocked worker remain unchanged. Do not replay this release or
accepted owner checks. [Contract and limits](stac-services.md#scientific-one-band-display--october-16-delivery).

The bounded normal-account followup finds no public Collection in the account's
public-filtered query. Public gallery positive acceptance remains open; no access
or content is changed for testing. Two SRP and three GETs use343 response bytes/
29.754s, including a22.755s identity-store503 and successful1.495s retry. Session
cleanup passes. This reproduces the slow startup recovery without forcing a cold
run; retain that evidence for the next local startup-path audit. No new cloud
measurement, build or always-on capacity is authorized for that audit.

October 16 — Metadata controls and native integration examples delivered

Studio `77db52be11c5` fixes expanded metadata collapsing the map. The whole open
metadata panel scrolls, with native checkbox activation checked on desktop and
narrow screens in light/dark modes. Existing public release and Collection screens
now provide native import examples; no new data read or publication action occurs
when those controls render. Exactly three source files change from FAA0. Two owning
UI cases, one10.573-second build, all retained integrity/PWA/release gates and six
exact live software readbacks pass. The release uses861 SDK calls,841 physical PUTs,
32,194,828 upload bytes and one completed cutover/invalidation. UI cumulative18,130;
six anonymous software reads total574,918 bytes. API, Demo and worker are unchanged.

The actual-owner metadata/Identify/Print journey now passes on the selected Nepal
Project: metadata remains open, both layers load, a polygon pointer returns results
for two visible layers, and Print opens the selected map. One A4 landscape layout
is saved as Project revision3, freshly reopened and exported to a valid18,660-byte
SVG. All canonical Layer/Style/view records are preserved; transient image pixels
are absent on fresh reopen. The default provider basemap uses a local blank fixture.
The successful run uses49 API/2 SRP/995,811 response bytes/27.552s and zero new S3
GETs. Each host obtains fresh version/object/download authority before reusing the
same exact bytes previously verified through two real GETs/154,709 bytes/hash/CORS.
Cumulative owner usage is105 API/16 SRP/2,464,048 bytes/237.815 active seconds, plus
2 ms local pre-auth failure and one saved layout; all failed attempts remain carried.
Browser/session cleanup passes. Do not replay this save or rebuild/redeploy to
repeat acceptance. Worker security remains blocked without a known entitlement or
complete public fix; no existing PMTiles-only task/queue partition avoids OCR.

October 16 — Owner checkbox diagnostic

The observable owner check verifies metadata again and shows all four saved Layers
remain governed, with no matching external-source override. It stops in the native
checkbox click before any data-loading callback; the prior source-loader diagnosis
is unproven. The existing local fixture now reproduces the expanded metadata and
exact theme before another live attempt. Cumulative owner/diagnostic usage is40 API,
12 SRP,1,140,037 response bytes and152.887 active seconds, plus2 ms local pre-auth
failure; zero source reads or writes, with browser/session cleanup confirmed.
No frontend rebuild, deployment, worker activation or speculative source fix.

October 15 — Interface corrections delivered; PMTiles integration local

Studio `faa0c6690582` and Demo `40dbf1bac99e` retain06c3 and deliver theme/spacing,
Catalog entry points, polygon origin completion and Print current-view startup.
Both isolated builds/integrity/PWA and12 exact software readbacks pass;1,501 counted
AWS requests and one cutover/invalidation per distribution. Compiled Catalog and
actual-theme Properties pass; full compiled polygon navigation remains unproven.
Three owner attempts retain17 API/6 SRP/507,885 bytes/99.906 seconds, zero source
or writes; normal-account metadata/Identify/Print save/reopen remains unaccepted.

The direct PMTiles worker validation, immutable DB0169 completion/admission, API
display review, native saved-display validation and Studio controls pass focused
local checks. API `d9c3e783`, worker `0bc307db` and Studio `ee805165` are built
locally once; the compiled review/save/reopen check now passes with exact pins and
fresh read consent. The initial API runtime payload passed but its host command
timed out; its cleanup is confirmed. The live guard then found actual API479a.
Rebased APIcc799 preserves that current secure runtime and passes both payload and
host execution. Its exact sources remain in the next bundled candidate. Nothing
in this batch is deployed. The worker's fresh registry scan blocks activation with
20 HIGH findings, including ten OCR findings whose confirmed packaged fix requires
an unavailable Ubuntu Pro entitlement. No subscription or partial package build.

Native host map controls/events/cleanup, the pinned metadata-only release descriptor
and an ordered public Collection gallery are deployed as API34112 using existing
release identities and eligibility checks. Nineteen Artifact and fourteen Collection
cases and an actual MapLibre/gallery browser peer pass. Live anonymous descriptor/
native-module reads, private Collection denial and Studio preflight pass after a
gateway-only CORS correction; credentials remain disabled. Real public Collection
positive acceptance remains open. The gallery preserves legacy JSON/HTML capacity.
DB0169 commits once and its ledger/functions verify;23 Data API calls include one
read-only database-wake failure. Total API preparation/delivery is85 SDK calls,
plus five bounded anonymous reads. Sealed Studioee805 remains held until worker
processing is usable; the existing FAA0 feedback release is reused for owner checks.
Exact Alpine backport evidence resolves the supplemental scanner's musl/zlib CPE
matches; raw results remain unchanged and fresh registry admission remains required.

October 15 — Startup feedback delivered; observed workflow corrections next

Studio `a63ef09e8a56` preserves c365 and delivers compact testing controls, plain
loading copy, deferred fixture preloads and elapsed-time-aware session recovery.
74 focused cases, one offline build, integrity/PWA, local interface and six exact
software readbacks pass. Database cold wake remains unresolved. Subsequent local
work addresses the Project metadata view omitting existing description/Layers,
geographic context, existing shared-container team grants and Identify querying
mutable feature collections for exact-version managed previews. No new permission
model, country-membership assertion or production grant is implied.

October 15 — Catalog control delivery and next tiled-map requirement

Studio `c3655c886e59` delivers deliberate Catalog metadata exports and existing-authority
Layer grant controls over the accepted 3cc base. Forty focused cases, build/integrity/
PWA/foundations and exact seven-file software delivery pass; new owner UI acceptance
remains separate. Public generation 55 completes seven native editions and their
shared navigation. Scientific COG range display is implemented locally only.
The next functional gap is completed PMTiles output review/admission and saved-map
selection; local direct conversion/protocol acceptance does not prove that connection.

October 15 — Composition cleanup closed

All four historical map/Resource cleanup exceptions now pass owner-scoped archive
and readback with identities, definitions, immutable versions and archived access
containers preserved. The active queue separates the unfinished older publication
backlog from current feature work; no further publication cutover is required to
continue the remaining parity rows.


October 14 — Deployed owner composition acceptance

Studio `3cc0a38c5181` retains the Catalog fixes and accepted existing behavior.
The actual-owner two-map shared Layer/pinned Style save/reopen/render journey now
passes within the declared LineString scope, including Style version history and
fresh fixture cleanup. Migration `0168` aligns draft archival with the delivered
API; its exact production metadata readback passes without an application release.
GEOLENS-004 is pass: totals 24 pass / 25 partial / one exclusion. Historical hash
diagnostics, broader losses and four historical cleanup handles remain explicit.
The active queue owns the remaining native-publication and final collection work.


October 12 — Local GeoLibre revision exchange

The existing converter, recoverable import and workspace history now support
[saved-revision handoff and reviewed returns](interoperability-contract.md#saved-revision-geolibre-handoff-and-reviewed-return--october-12).
Original Layer identities, explicit derivative lineage and conflict resolution
reuse current records and authorization; no new migration or publication model.
The active queue and existing renderer checkpoint own current verification,
failed attempts and the unchanged deployment/upstream acceptance boundaries.

October 10 named-publication continuation — saved and building

The deployed Studio `bc972b16` and public generation 40 remove the OG mark,
route anonymous generic Studio entries to the existing Demo, retain signed-in
Studio entry, and provide a collapsible left sidebar with right-side Contents.
Actual normal-owner/anonymous entry and five-request live public acceptance pass.

Seven requested project collections now have modular native Notebook Sources:
five new Publication/Source pairs reuse genuine existing access containers, and
both ICIMOD identities retain their original revision-2 source trees in history.
All seven native builds and exact saved previews pass. The normal Studio
directory shows all seven with test fixtures hidden; the saved heat Notebook’s
cell editing, movement, duplication, deletion and undo controls pass without an
extra write. Native publishing is in progress, sequentially fenced on the existing
shared public origin. Main Source 14 places PAD-US and the ICIMOD introductions
under Datasets, and four new analyses/techniques under Projects. Do not claim the
seven public endpoints complete until their existing releases and the one final
shared-shell collection cutover finish. Preserve queued jobs and committed writes.

The single continuation is `.local-archives/public-article-revision/checkpoint.json`;
`requestedProjectPublications` in its existing manifest owns the finite seven-row
scope, budgets, prior failures and receipts. No new Projects, raw archive reads,
source-public grants, API/compiler deployment or parity promotion are included.


Current verified delivery is API `34112d5f` / Studio `77db52be` / Demo `40dbf1ba`.
DB0169 is applied alongside the retained ledger and existing draft bootstrap.
See the [active queue](resource-model-roadmap.md)
for verification, limits and unfinished core workflows. Earlier delivery records
below are historical checkpoints.

Two further local main-workflow fixes reuse existing paths. Mixed public/archive
draft previews now refresh metadata for new binding identities while retaining
verified bytes and settled failures; both editor binding callbacks cancel obsolete
reads without repeating metadata for renamed paths. Saved geographic tags prepare
exact, revision-pinned polygon conditions in supported vector queries and preserve
existing conditions until Run query. Owning checks pass20/32 respectively; no
cloud/build/deployment/parity promotion. Catalog-wide exact polygon discovery,
imagery clipping and real-owner acceptance remain unfinished. The sealed pending
release is unchanged; the existing manifest owns this separate local follow-up.

The separate local public-file Live preview follow-up connects Catalog TIFF aliases
to the existing exact-byte reader and per-editor cache. It shares the 64 MiB archive
budget, rejects stale account/binding/authority state and requires explicit reload
after failure. Provider CORS and actual owner acceptance remain unverified; public
standalone downloads still use Saved preview. No cloud/build/deployment or parity
promotion occurred, and sealed Studio `62847d4b` is unchanged. See the
[data-file contract](framework-data-attachments.md#connected-public-files-in-live-preview--october-9-local-follow-up).

The public shell now places its sidebar toggle on the left beside the title,
with session-persistent wide-screen collapse and a narrow-screen left drawer.
Main Source 11 preserves all files and bindings. Seven-width light/dark keyboard,
focus and resize acceptance passes. Generation 39 is deployed; five live GETs
verify three exact pages and both shared assets, with eight reader groups and
reference anchors passing. API/Studio/compiler remain unchanged. The existing
publication manifest retains all attempts and the two unpublished land-cover
drafts.

The NOAA analytical entry now uses the existing Publication/Site and Source
identities as **Reading beyond the visible**. Site 3 and Source 10 preserve
native release history and all files; the Source opening file is the analysis.
Main Source 9 places the introduction under Datasets and the source-bound
analytical entry under Projects. The hosting mount remains immutable and both
URLs work. Actual Studio directory/search/390px checks and eight local hosted
navigation checks pass; no source-file reads or GIS processing. Generation 38 is
deployed with one completed invalidation; five live pages and shared CSS passed
six anonymous GETs, both themes and mobile navigation. Studio/API/compiler are
unchanged.

NOAA Source 9 separates its seven existing Catalog Layer references from
publication navigation and links its analytical article. All NOAA pages use the
global site sidebar; `/project` renders the full introduction. Actual owner
readback preserves the genuine seven-layer composition and existing identities.
Four-page local and live light/dark/mobile checks pass. Generation 37 is deployed
from the same interrupted release, with completed objects reused; its one
invalidation completed and five anonymous GETs passed. Studio/API/compiler are
unchanged.

The isolated non-spatial Catalog increment preserves the accepted directory and
authentication behavior. On-demand CSV previews verify original bytes; recorded
PDF/ODT text uses the existing read-authorized endpoint. Non-spatial records omit
irrelevant map controls. Both existing Nepal CSV versions pass actual owner
preview and 390px page bounds. The same session saved/reopened the approved
44-cell Nepal census Notebook as Source 4, preserving the earlier manuscript in
Source 2. Its native saved build succeeded and exact preview controls passed both
themes. The approved native release deployed at 23:14 UTC. Main Source 7 and the
43-route host composition pass actual four-entry directory and both-theme
reader/layout checks. Generation 36 is deployed; five anonymous GETs and actual
light/dark controls/mobile navigation pass. Owner sessions are cleared. Queued
Catalog inputs, workbook parsing and the full earlier raster reproducibility
package remain unfinished. No raw source public grants or processing-state bypass.

The current local publication package is Studio `62847d4b` / API `e3d97267`,
with complete worker bundle `9598a6fb` on actual active parent `f7f137…`, retaining
the accepted `4ea0ef51` tree. The previous `206d3a20` / `1eff20f7`
omitted accepted dependencies and remain preserved as incomplete candidates.
Affected build, integrity, offline-cache, publisher/operator and exact native API
checks pass. Compiler `3a18705b` fixes the demonstrated dependency finding using
cached 1.2.2, passes fresh offline security review and produces identical accepted
HTML. The existing eleven-layer registry promotion operator passes 30 owning checks
and exact read-only plan verification. API/default and saved-preview policy
template deltas are prepared; the existing schema/API/policy/runtime bindings pass
29 distinct owning checks. Migration150-attempt/600-second bounds, exact missing
API-layer preparation, initial worker fencing and actual phase admission are now
prepared and locally checked. Two exact change sets are available; combined
approval, execution and owner acceptance remain open. Studio `62847d4b` preserves all three newer deployed
`b0a30be5` Catalog components. Its one offline build, seal, integrity and PWA pass;
prior `37609261` output is retained. The guarded release is rebound to the current
artifacts and observed rollback origin, with future phase receipts still absent;
no deployment or parity promotion is claimed. The active
queue and its single current checkpoint retain all failed attempts and usage.

The subsequent neutral Framework appearance correction is deployed at origin
generation 33, with Main Source 6 and Notebook Source 7. Actual table headers
and rows pass light/dark filter/sort checks; Studio/API/compiler are unchanged.

The public display correction is deployed at origin generation 32. The main
Publication is named **OpenGeo.tools** across its current Source, access container
and compatibility Site. Main Source 5 and Notebook Source 6 preserve files and
history. Shared navigation/appearance, visible Studio links, native table bounds
and caption contrast pass the owning checks. Three additional Bhutan/Nepal
Publications remain private revision-2 drafts with unreviewed rights and no public
endpoint. See the active queue and single public-article manifest for evidence;
Studio/API/compiler delivery is unchanged.

Local migration 0163 connects generated single-HTML results to saved build
completion and owner review without new grants. The existing PostgreSQL fixture
passes source-only release, approval-bound archive output, malformed-result
denial and revocation after mandatory preview exchange. Larger retained pages
use the exact prior deployed plan; publisher planning/storage pass 62 focused
cases. These are local metadata and adapter checks. The current native compiler
source overlay now produces a sealed 1,448,934-byte single HTML from a 290-byte
synthetic GeoTIFF. Chromium proves reactive D3 rendering at 390px under saved-preview
CSP and offline `file://`, without external HTTP requests. Two SDK cases pass
optional request-v4 forwarding, legacy compatibility and existing result redaction.
The corrected immutable AMD64 compiler `7b09709f…` also passes without an overlay
and produces identical HTML. Its license-only inventory covers 373 components
and all nine cached npm packages. The local saved-preview format selector matches
exact build history and retry identity; nine owning cases pass. Format metadata
is bounded, read alongside history and reused. Fresh vulnerability security and
runtime admission, actual owner UI/persistence, live/public delivery,
original-data saved compilation and actual owner public-file preview remain
open. Local assembly reuses nine layers; no cloud calls or GIS capture occurred.
Deployed artifacts
and parity counts are unchanged.

The local anonymous source transport can now stage a query-free public TIFF with
an exact SHA-256 and size up to 64 MiB. It preserves DNS/TLS controls, validates
classic/BigTIFF signatures, bounds chunk reads to 64 KiB, cleans failed staging
and refuses an occupied destination. The archive storage path rejects this TIFF
type before loading credentials. Forty-three focused cases pass in 0.60 seconds
with tiny synthetic files and no network. This adapter does not register a file,
bind a publication revision or connect the trusted coordinator transport.

Local migration 0164 adds a separate immutable public-file reference registry.
API/SDK registration and draft manifest 3 derive exact source/metadata facts;
the editor preserves references through reopen/save and refuses incomplete ZIPs
or dependency history restoration. At that registry-only checkpoint,
builds/previews remained closed for these inputs. Focused API/SDK/editor checks pass. Selected native PostgreSQL registration,
retry, exact private save/reopen, independent access, withdrawal and build denial
pass in 21.148 seconds. Three attempts total 82.599 seconds, retaining both failures;
all containers were removed. No cloud, provider, capture, live-account or build
execution occurred; current delivery is unchanged.

Local migration 0165 and the coordinator now support current-authorized private
saved previews of those public pins, without a duplicate archive or compiler
credentials. The [input contract](framework-data-attachments.md#private-saved-previews--october-9-local)
records transport, cancellation, exact output and public-denial boundaries.
API264 and JS31 plus two guard checks pass; the corrected selected native
lease/completion/preview journey passes in 24.471 seconds. Its diagnosed SQL
failure is retained; two attempts total 48.207 seconds and both containers were
removed. No cloud/provider/capture/live-account or native compiler execution.
Runtime activation, original-data owner rendering and public rights remain open;
no parity row is promoted.

Local migration 0166 extends exact public-file pins to owner-approved distribution.
The existing API/SDK/UI preserve approval version 1 and add version 2 with current
rights separate from historical file metadata. Metadata review batches reference
facts without file reads; source terms remain unknown when absent. Current authority
and revocation guard public build/completion/review/publisher access. JS40/API65
pass. The narrowed native migration-166 journey passes owner review/approval,
release completion/preview, publisher authorization, withdrawal and revocation in
24.311 seconds, reusing unchanged registry/private-preview evidence. The first
30.964-second timeout remains counted: two attempts total 55.275 seconds and both
containers were removed. No source/output bodies, cloud or compiler build. The
public-reference owner picker, deployment, original-data owner rendering and
runtime activation remain open; no parity row is promoted.


Local migration 0167 and the existing Catalog picker now admit cross-workspace
source metadata with independent authority, and bind/insert public TIFF aliases
in private drafts. JS20/API2 and a 26.556-second native authority journey pass.
Mixed inventories, stale-account reloads and legacy pins are guarded. No copy,
cloud, build, deployment or parity promotion. The [current picker contract](framework-data-attachments.md#catalog-picker-and-draft-fileattachment-names--october-9-local)
records failed attempts, reuse and required real-owner/runtime acceptance.

API `e9ba206c` and Studio `400124c5` are live after exact combined approval;
Demo `aed69308` is unchanged. The API executed once and preserves its runtime,
permissions and storage. Studio delivered 821 unique software objects (30,935,283
bytes; expected physical transfer 31,049,889 bytes) with one cutover and completed
invalidation `I23OP70JXYV3B4H3T1XPSVI7XO`. API `3f299a4d` / Studio `c007bdf8` are
retained for rollback. API promotion used 17 SDK calls / 53.642 measured active
seconds including its five-call stopped preflight; a strict response-wrapper repair
preserved the same approved artifacts and effects. Studio used 850 counted requests /
139.446 seconds; one read-only completion check added 1 request / 1.185 seconds.
No publisher, upload, cutover or invalidation was repeated. Counted administration
is 11,451 (software control 11,403); KMS usage, idle interruption time and dollars
remain unknown. No GIS capture, migration, private Source upload or rebuild occurred
in this software release. The seven-class D3/Plot Styles reference and downloadable
module are delivered; actual Layer 971 rendering still needs confirmation.

Map Folio owner publication, cross-origin `createView` and offline HTML delivery are
verified; see the active plan for this checkpoint. The public host now retains
consistent CORS headers across cached responses. This does not prove full parity.

Studio retains Catalog nesting/preservation details and selected-boundary Query,
plus earlier New publication availability with same-form input preservation and
exact unchanged source-file reuse. Four directory and eleven isolated editor/SDK
cases pass, together with canonical build/integrity/PWA gates. Server parent locking,
authorization and stale-file fallback remain. Production latency and KMS savings
are unmeasured. Remote ArcGIS polygon queries and raster polygon clipping remain
unsupported. Retained 1280/390px fixtures prove layout/disclosures, not source paint.

The API adds explicit enum casts for status-only Map assignment without changing
schema, runtime, dependencies or permissions. After deployment, five exact
unchanged generated ICIMOD maps archived successfully at version 3; first unknown
state was read before mutation. The preserved archived route and active summary
pass; the two curated version-3 maps were never replayed. The source-only image
reused 57 delivered dependency/OS layers and passed the retained emulated ARM
runtime and fresh exact ECR scan; no new native ARM, Trivy or SBOM pass is claimed.

Both original Bhutan and Nepal publications remain account-private draft revision 2,
289,098 original bytes, outside GitHub. The two native attempts to save Nepal’s
17,020-byte 2022 discussion update made no uploads or revisions; they are terminal.
Cumulative owner intake is 169 API / 32 SRP / 560.304 seconds / 15 source POSTs /
289,476 bytes. Native text synchronization remains unresolved; do not replay it.
The preserved map uses 2019 data, and actual 2020–2022 distributions remain unknown.

The exact owner Catalog read now identifies Layer 971’s 7,954-byte preview rejection
at the root-member allowlist. One signed object read used 4 API / 2 SRP / 4.314 seconds,
with source bytes cleared and no content mutation. A bounded root foreign-metadata
projection fix passes 32 local cases; it preserves archived originals and omits ignored
fields from preview responses. CRS remains rejected. The deployed owner preview now returns HTTP 200 and three features. Its bounded
native journey reached 32 Positron requests before paint confirmation; cleanup
completed, and no content changed. All native attempts total 18 API / 10 SRP /
130.210 seconds. The existing saved Blank canvas will avoid new provider traffic
for the two-map/pinned-Style acceptance; no equivalent tile retry is planned.
Original source keys remain unknown; actual rendering and aggregate acceptance stay open.

Map Folio’s original 14-file source is frozen at 2,179,999 bytes, including four Bali
OSM snapshots from 2022. Before transfer, two bounded S3 root listings and one normal
owner Catalog search found no evidenced Bali match; deeper folders and exact existing
copies remain unknown. No provider data was captured; the later Source transfer includes
the existing local snapshots. Closed local dependencies
and their licenses are prepared; the first preview exposed two omitted D3 exports,
now corrected. The next check resolved runtime errors but exposed a test selector
mismatch. A corrected path check proves 1,266 SVG paths, the forest toggle and
390/1060px layout with no external requests. All three attempts are retained.
Native creation first stopped before writes on existing workspace `63e6e28d…`.
Scoped metadata established owner-only access and no Sites, Sources or team grants.
Native New publication then created private Site `3188f40a…`, Source `87d5f3d9…`
and a 129-byte starter. Its first folder import rejected `bali@1.geo.json`; the
path-safe copy renames that attachment and its active literal while retaining the
original name, index, checksums and unchanged GIS bytes in lineage. The next native
import saved all 20 files / 2,333,808 bytes as revision 2 `5b9b9605…`, preserving
starter history, private home pin, owner and unrelated resources. Head, full manifest,
history and saved index hash pass. Cumulative usage is 79 API / 12 SRP / 230.461
seconds / 22 source POSTs / 2,333,937 bytes, including all prior failures. The final
editor flag remains unobserved: Files mode eagerly compiled Live draft and attempted
an unused companion GET, blocked locally before dispatch. Persistence is accepted;
do not repeat uploads or Save to make this receipt green. Public build/path/importable
output and Catalog reuse evaluation remain unfinished. No GitHub synchronization,
fresh provider capture, public build or publish occurred.

The seven-class D3/Plot reference, standalone download and offline gallery pass
browser/minification checks. Studio `400124c5` changes exactly three production
files over `c007`; one offline build and standard release/PWA gates pass. API
`e9ba206c` passes 32 focused and nonroot/emulated ARM checks; its exact automatic
scan is COMPLETE with zero HIGH/CRITICAL findings. Staging used 24 SDK calls /
27.034 measured active seconds, preserving the asynchronous wait and interruption.
Actual delivery is recorded above. Historical parity fixture hash drift remains;
no row is promoted. Sandbox transport effort, service-mediated KMS and dollars are
unknown. Parity remains 23 complete / 26 partial / 1 excluded.

[Execution limits, partial commits and next acceptance](../.local-archives/studio-sharing/noaa-owner-workflow/manifest.json).

Earlier October8 API `53372d43` / Studio `ad1f05d5` release was live after the user's
exact approval. Guarded readback verifies the exact image/runtime/template and sealed
Studio origin, with one completed invalidation. The prior `ff3f72ed` / `f05b00c4`
remain rollback; no new build, capture or migration. The native owner Catalog journey failed before Layer reads. Two attempts total
54.256seconds/2API/4SRP, with sessions cleared. The current exact auth route logs prove
principal TimeoutError after20.115seconds and503; the initial transport timeout alone
did not prove a failed server response. Four bounded diagnostic AWS reads retained
no raw logs, source bytes or secrets. Capacity0 before and active during the request
supports database wake-up as a contributor. Local full-module import4.867seconds
versus factory0.023seconds now selects a lean session path with shared authentication
and HTTP security;50 local cases pass and lean import measures0.857seconds. The
isolated API7fb7aa22 retains533 runtime, with unrelated artifact-sharing lines
excluded. Original/scoped ARM checks time out (111.502seconds carried); cleanup
passes and staging is stopped. The unchanged host handler passes outside the
sandbox in19ms, and one actual-handler regression passes. Exact ARM cause and
production recovery remain unproved for that candidate. A subsequent two-keyword
async getter change passes23 affected cases. Isolated API `d860fc9d` passes exact
nonroot ARM source/handler acceptance with two401 invocations and no full import:
26.447seconds,137.950seconds carried including prior failures, cleanup confirmed.
It retains533 runtime settings and excludes unrelated artifact-sharing edits.
Existing API-only staging is complete:22SDK/25.208active seconds, fresh automatic
OS scan0High/Critical, code-only change set AVAILABLE/unexecuted, live533 runtime
readback unchanged. No Studio build/cutover, data capture or production execution.
The sealed review and20-call/180s promotion operator require exact user approval;
API533/ad1remainlive. Owner-visible recovery is not yet measured on Lambda.
The subsequent production process was rejected by automatic approval review before
AWS calls or execution intent: generic approval was not accepted for the specific
D860 digest. An exact-digest question is pending; no retry or workaround.
Compiled native source ZIP/isolation, exact ARM64 runtime and basic OS scan gates
pass; two delivered
module hashes match. Normal production account/source access passes. Production
history/file acceptance remains unfinished after a stale revision-2 test fixture;
no further private retry or delivery replay. Full account export remains unfinished.
[Current ledger](progress.md).

The selected full GeoLens1.20.0 native application workflow now passes normal login,
MVT rendering and Save/reopen/Duplicate with shared Dataset identity. API-seeded
order/filter/paint are preserved; broader native editing and deployed OpenGeo
composition remain unproved. Layer diagnosis encountered two account-service503
responses before any object read. Navigation cancellation now reaches the late
selected-map read locally. The directory loader no longer duplicates the SDK's
session503 retry; SDK/backoff/403 account repair stay intact. Five affected cases
pass; the delivered Studio tree is unchanged and the server failure remains unresolved.
The isolated API `53372d43` / Studio `ad1f05d5` candidate gives only `GET /auth/session`
the existing 20-second total principal window. Normal three-second transport limits,
fresh token validation and membership checks remain. Thirty-five API cases pass;
the isolated compiled Studio and emulated ARM64 runtime pass. A delayed terminal
read accepts the completed exact-image OS scan; the image-only change set is
delivered through one exact execution and Studio cutover. Owner-visible recovery
and actual KMS savings remain unproved pending the bounded native journey.
The independent local Catalog preview increment forwards AbortSignal through the
existing spatial-preview SDK and disposes pending/rendered maps on page disposal.
Seven focused cases pass; the Layer page's disposal chain reaches the preview.
No schema, authorization, source-version or preview-selection change. Frozen533/ad1
is untouched; this increment remains undeployed.
LayerResourcePage now uses the existing no-Projects startup option and defers the
first destination page until **Load projects**. Current account/edit checks and
pagination remain;16 behavioral cases pass locally. This is outside frozen533/ad1.
The existing native Catalog runner's archived-preview lane failed twice at auth;
live owner rendering remains unaccepted. No third attempt or resource setting change.
The existing Account ZIP planner now optionally packages current owned Catalog
record/knowledge JSON and the shared saved Collection definition. It rechecks
ownership/revision before and after packing, keeps the existing shared caps and
adds no default calls. Supported registered server and repository descriptors now join
that JSON, preserving independent source revisions/provider pins without provider reads.
Missing references remain explicit; ownership and full metadata are rechecked before
and after packing. Forty-five behavioral cases pass locally. Isolated Studio
`eb9133c1` now compiles this increment and both Catalog changes; one cached build
and official seal/release checks pass, with unchanged authentication configuration.
Four owned-process cleanup cases pass. Native metadata UI/HTTP acceptance failed
twice (56.352seconds total within90seconds), with both terminal/container cleanup
receipts retained. The nonexistent Map owner fixture column was corrected once;
the second cause is unknown. Fixed-step/type/count diagnostics pass four local
cases; no third attempt, new build or deployment. Linked data, full connection inventory/restoration,
credentials, metadata history
and non-user ownership remain excluded.
[Peer result](../parity/reports/geolens-004-full-application.json).

Earlier local checkpoints below retain their original delivery scope.

October 7 subsequent local increment adds JPEG image export and optional saved map
versions to the existing account ZIP flow. Thirty-nine executed assertions and one
native JPEG/history-ZIP journey pass against sealed Studio9a1d/runtime-role
PostgreSQL. One cached build, zero AWS/capture; frozen API953/Studio9039 and live
db19/21e9 stay unchanged. Fixture auth/software GPU do not prove production.
[Current delivery and limits](progress.md).

October 7 current checkpoint: API `953ba3d7` and Studio `9039c439` are assembled
and accepted locally for saved Project snapshot/create/reopen and actual normal
MapLibre painting. Nested SDK `canvasContextAttributes` restores drawing-buffer
preservation: 456 matching pixels, 13 local GETs and 28.707 seconds, unchanged records.
Earlier persistence/isolation proof is reused; one affected build, zero AWS/provider
requests, GIS capture or CI. Fixture authentication/software GPU limit this proof.
[Exact local checkpoint](../.local-archives/studio-sharing/noaa-owner-workflow/account-saved-content/saved-project-reopen-continuation/paint-fixed-root-review.json).

Approved API `db19bf16`/Studio `21e9a988` remain live. Parity stays 23 complete /
26 partial / one exclusion;144 historical hash errors remain and no new errors arose.
ECR scan and image-only CloudFormation preparation/review now pass; authorized
delivery and production owner acceptance remain open. No further build is required.
[Active queue](resource-model-roadmap.md) retains full-peer and other workflow gaps.

Earlier October 7 preparation checkpoint (superseded above): owner saved-map definitions now join saved Publication
source downloads through the exact governed owner, with unknown ownership explicit.
API `db19bf16` and Studio `21e9a988` are isolated, scanned/compiled and reviewed,
not deployed. One image-only API change set is AVAILABLE; one Studio cutover and
invalidation require exact production approval. Current API46/Studio90e3 remain
live. No GIS capture or CI. Parity remains22 complete; historical144 hash errors
remain unresolved. [Current ledger](progress.md) and [exact release review](../.local-archives/studio-sharing/noaa-owner-workflow/session-transport-cap/release-review.md)
retain checks, costs, exclusions and rollback. Next: approved changed delivery, then
one bounded representative owner journey; full export/sharing/intake remain required.

Earlier October 7 release checkpoint (superseded above): the approved Studio90e3 and API46 releases remain
live. A separate isolated Studio8751 candidate now adds Account settings → Download
work for exact latest saved Publication sources owned by the signed-in user.
It estimates source bytes and application reads, supports Cancel, checks ownership/
account/version/integrity and records exclusions. Eighteen focused local cases and
compiled desktop/mobile acceptance pass. Root visual review found and fixed an
idle Cancel button and an outdated enabled download plan; prior ZIP evidence was
reused. Two changed-input builds total26.917seconds; seals2.704seconds and native
checks7.187seconds, with zero AWS, GIS capture or CI. This remains a partial account
content download; Project ownership, history, linked bytes and other work remain
required. [Scoped review](../.local-archives/studio-sharing/noaa-owner-workflow/account-saved-content/root-review.json).

At that earlier checkpoint, native production Cancel acceptance was unfinished. Credentials authenticated,
but session reads exceeded10s and20s before SQL started. Both attempts total33.991s/
one SDK/two API/four SRP calls, no transaction or writes; no third equivalent run.
Two bounded log calls total2.380s and find a contemporaneous principal TimeoutError;
exact client correlation and the underlying HTTP/database cause remain unproved.
A narrow local candidate caps principal transport at the existing3s while retaining
its20s explicit-resume window and fresh authorization SQL. Twenty-one Data API cases
pass, including the unchanged5s analysis budget. This API change is unbuilt and
undeployed; no new permission cache or always-on compute. Parity remains22 complete /
27 partial /one exclusion. Package only the scoped diff for the next coherent
release, then use one representative owner journey after changed delivery.

October 7 Studio90e3 is now deployed from the approved isolated source-export
bundle:809 files/30,584,957 software bytes,816 hosting objects, one origin cutover
and one completed invalidation. Publication source exports show size/read estimates,
retain current edits and support Cancel with saved-file integrity/current-account
guards. The existing Catalog area/time, flight HUD, native analysis Cancel and
bounded session retry ship together. One11.881-second offline build and4.046seconds
of seal/compiled desktop-phone checks pass; two delivered module hashes match.
Publication took148.989seconds/847 counted software AWS requests; actual mediated
KMS usage remains unknown. No GIS capture, Data API, secret-value read or CI job.
API46 remains live; encryption/grants and account-owned drafts retain their existing
boundaries. Account-wide export and Publication audiences remain required. Native owner
Cancel acceptance stopped before SQL: credentials authenticated, but session
reads exceeded10 seconds and then20 seconds. The second fetch timeout is confirmed;
the server cause remains unknown. Both attempts total33.991seconds/one SDK/two API/
four SRP calls, no transaction, writes or GIS capture. No third live retry. Local
session diagnosis and saved-owned-content export continue; parity remains22 complete.
The Layer409 diagnostic stopped before any object read at an unacknowledged
BeginTransaction;15cumulative SDK calls/84.728seconds are carried, without retry.
[Release and delivered readback](../.local-archives/studio-sharing/noaa-owner-workflow/source-export-controls/review.md).

October 7 KMS conservation API `46d950da` is deployed: a bounded 60-second success-only
cache for immutable basemap-secret versions, one checksum GET instead of duplicate
HEAD/GET during discovery recovery, and bounded WMS status backoff. Seventy-seven
focused cases pass. The signed vendor zlib update clears the inherited scan finding;
exact image/template and unchanged runtime readback pass after approved execution.
Eleven bounded operator calls/60.589 seconds, zero GIS/Studio/invalidation. Current
authorization and encryption remain; actual KMS billing savings are unmeasured.

The local source Files export controls now estimate bytes/unloaded reads, disclose
unknown storage/encryption charges, support Cancel and reject stale account/source
or corrupted saved-cache bytes. Edited buffers remain deliberate current drafts.
Cancel also reaches linked-input S3 header/body transfers; already-issued service
work cannot be undone. Five affected UI cases and one client HTTP-abort case pass,
reusing prior source-export checks. These changes are outside the delivered API
and current sealed Studio; whole-account export remains required.

Saved source exports now also have an exact-version download-ticket API, explicit
client convenience method and exact-origin GET CORS in the existing application
bucket. Signing uses the existing local signer without object reads. Fifteen API,
twenty client and twenty-three infrastructure cases pass; API authority fixtures
are not live PostgreSQL/RLS evidence. The browser still performs one storage GET.
Neither these changes nor account-wide export are deployed; the previous source
GET remains compatible. Private drafts stay in OpenGeo storage without GitHub writes.

October 7 Files and Preview now share one PublicationPanels surface; ProjectSites
switches its layout while retaining the editor and iframe. PublicationCodeEditor
defaults to current draft, refreshes plain-text/Cells/Monaco edits and initializes
saved-build controls only after explicit selection. Detached fallback editors dispose
channels before account/workspace replacement. FrameworkProjectPreview closes a
consumed capability frame when leaving saved mode. Focused checks and one actual
routed/offline ProjectSites journey pass; approved Studio `a919a55a` is now deployed.
The owning stack update and one invalidation completed; two delivered editor modules
match the exact seal. Source/history/API/grants remain unchanged. The
[current contract](publication-draft-preview-20260914.md#current-draft-workflow--october-7)
records native HMR, kernels, remote NOAA imagery and sharing/export limits.

October7 final Studio candidate `03d9b2e8` preserves that editor release. Its narrow
runtime inputs add Catalog area/time controls, the visible flight HUD, explicit
analysis cancellation and one coalesced, cancellable session read retry on the exact
`identity_store_unavailable`503. Eleven client cases and compiled Catalog controls
against local runtime-role PostgreSQL pass. APIca097 contains only the three
cancellation modules and retains the existing runtime/dependencies/configuration;
its basic OS scan has zero High/Critical findings and its image-only change set is
available but unexecuted. Production delivery and live cancellation are not claimed.
Normal owner/guest identities resolve correctly; the selected Layer preview409
stops the composition journey before writes, preserving original content/grants.

The same sealed `03d9` ProjectResources controls now pass native metadata profile
create/revise and governed metadata save/reopen through the local API and runtime
PostgreSQL role. Independent SQL retains exact profile/resource revisions 1 and 2,
rights, lineage, provenance, translations and unknown nested fields, while the other
tenant sees zero history rows. GeoNode 5.1 metadata field reports read back. Generic
resource history has no browser endpoint; this evidence is native save/reopen plus
independent immutable SQL readback. Cumulative 60.234 seconds / 152 observed HTTP
requests include both diagnosed fixture failures; cleanup completed with zero
external calls. The aggregate row remains partial; no runtime/build/deployment
change was required. [Receipt](../.local-archives/studio-sharing/noaa-owner-workflow/parity-27-catalog/metadata-admin-postgres-browser-ordering-continuation-1.json).

Static sharing's configured `artifact_view_origin` and specific Studio viewer
behaviors repair API Gateway Host/form-origin and edge CSP delivery. The exact
direct or `/api` share URL is accepted by the client; forwarding headers cannot
authorize another form origin. Global Studio policy remains unchanged. Frontend
8352e9 is sealed and API4a8fc2 locally assembled; focused checks pass, while the
bounded ARM64 execution timed out and remains unaccepted. No production changes.
The [contract](project-artifacts.md#static-s3-viewers-and-password-shares--october-7)
records the independent static-sharing delivery and remaining gates.

The existing owner metadata runner has an optional fixed-origin, anonymous
`/api/health/ready` gate before credentials. It requires HTTP200 and the database
SQL-ready result, caps one request at five seconds/1024 bytes, and preserves
earlier manifests and cumulative usage. Seven offline scenarios pass. The single
live gate timed out before authentication; owner access remains unaccepted.
This changes the intake check only, without Studio polling or new infrastructure.

October 7 locally implemented static map sharing adds `artifact_shares.py`, the
API gate/static-ticket adapters, additive migration0159 and the existing Artifact
panel/client controls. Protected shares remain separate from public releases and
resource grants. HTML is served by S3 after a bounded password exchange; current
public-source eligibility and a short object-link lifetime remain explicit limits.
The [contract](project-artifacts.md#static-s3-viewers-and-password-shares--october-7)
records routes, costs and unfinished production acceptance. Catalog's public TIFF
URL form is also implemented locally, without uploads or implicit Project creation.
Neither change is included in sealed Studio5d2d/API20dc or deployed.

October 7 public map saved-preview opt-in is locally implemented across API,
Studio and the existing preview edge. The optional `public_maps_v1` capability
requires manage authority and approved exact-revision rights, and signs only the
separate maps-preview host. Default delivery stays strict and configuration stays
off. No migration, compiler job or imagery copy is required. Local boundary checks
pass. Exact API/preview change sets are reviewed and available but unexecuted;
the covering certificate awaits external DNS validation. Exact registry readback,
fresh basic OS scan (zero findings), and offline non-root ARM64 imports/configuration
pass; production authorization and delivered owner rendering remain required. A missing Catalog
repository-setup link and the backup/source edition correction are sealed in
Studio `5d2d1da7` for the same bundle. The existing save regression and one
changed-input build/seal sequence pass; prior `3f69d319` stays retained. Release and
rendered owner acceptance remain open. The
[active plan](resource-model-roadmap.md) owns the current continuation and limits.

October 7 Catalog backup checking is live as Studio `211133`. In Register Layer →
Backup and source edition, users can check same-source Catalog metadata and choose
one verified, caller-owned S3 repository folder. A chosen result stages a reference
for normal review/save; it does not copy data, change source edition or imply rights
or equivalence. Checks are bounded to 100 source records, 3 matching Layers,
50 configured repositories and 50 folder entries; other pages/subfolders remain
unchecked. The map picker also discovers other workspaces only on request.
Twenty-two focused checks and the sealed build/PWA checks passed. One cutover and
invalidation completed: 847 new counted AWS requests, 1,815 carried (2,662 known
subtotal), plus two matching public software GETs. No GIS data or private article
was transferred or published. The native owner journey accepted the unchanged
private editor, Publications (1.194 seconds) and Collections (92 milliseconds),
but the return click during a Collection read was blocked. The control-only owner
metadata check now passes; no repository is configured, so folder/select/save
acceptance remains open. The [active plan](resource-model-roadmap.md) records its
bounded scope and carried costs. The read-navigation fix is implemented and tested locally, to be bundled
with the next needed release. Both failed attempts and 16 owner GETs / 4 SRP
requests / 82.457 seconds remain counted. No further equivalent live retry.
[Backup workflow checkpoint](../.local-archives/studio-sharing/noaa-owner-workflow/backup-workflow-release/batch.json).

October 7 connectivity repair is live as Studio `54128`: publication startup skips
unrelated inventories and eagerly imports 2.13 MB instead of 6.06 MB of JavaScript
(static graph sizes, not network timings). Nineteen focused checks and the sealed
build/PWA checks passed. The first normal-owner session request took 23.640 seconds;
the private editor opened in 30.227 seconds with Source5 unchanged. Navigation
acceptance stopped because the test guard expected `/sites` where the maintained
client requests anonymous `/publications`. The failed receipt and costs are retained;
a corrected bounded journey is next. Backend cold resume remains an inference.
No API, schema, grants, GIS capture or always-on capacity changed.
[Connectivity checkpoint](../.local-archives/studio-sharing/noaa-owner-workflow/connectivity-release/batch.json).

Current October 6 continuation: the approved bundled release is deployed and
verified: API50f172, controllerb1a, migration0158, runtimef7f137 and Studio cd689.
Canonical drafts/history stay in OpenGeo S3/Aurora; new builds do not require
GitHub source copies. Dispatch was fenced before mutation and restored after
exact checks; main6866 and the existing compiler policy remain unchanged. One
Studio cutover/invalidation completed, with two exact deployed asset readbacks.
The retained security evidence and earlier failed read-only attempts are carried.
See the single [deployment checkpoint](../.local-archives/studio-sharing/noaa-owner-workflow/fast-parity-release/deployment-summary.json)
for targets, preservation, usage and verification limits.

Next: one owner source5 build,
private preview/review and NOAA article publication at its reserved mount. Source5,
mapv2 and public map import acceptance remain preserved. The other requested
publications, native SourceApply/directory and full offline/notebook acceptance
remain open; continue from the [current checkpoint](progress.md#october-6--noaa-owner-workflow-and-source-preservation).

Earlier intermediate checkpoints below are historical and superseded where they
refer to source access as internal, revision 2 as current, or earlier Studio trees
as the active release.

October 6 owner acceptance now confirms all 22 Sea Layers' public governed Catalog
metadata, including one actual native create/review/public decision. Source access
and the articles remain unfinished. The [current checkpoint](progress.md#october-6--noaa-owner-workflow-and-source-preservation)
records the SDK batch, exact-pin/readback limits, retained failures and pending release.

October6 follow-up: Source access and Capture cost review are locally implemented.
Classification-only changes preserve existing source IDs/revisions/URL/configuration
and require exact published metadata plus explicit owner/publisher review. Capture
marks planned maxima **over1,000,000,000bytes** as large, requires cost acceptance,
blocks unknown volume and explains unknown provider/ongoing storage/download charges.
API8359 and Studio0d75 are now deployed after approval
(808files/30,516,407bytes). Focused checks, Studio gates andfoundations
pass; cfn-lint retains an unchanged warning and historicalparity seals remain stale.
[Exact follow-up review](../.local-archives/studio-sharing/project-imports/release/owner-source-access/review.md)
is delivered. A diagnosed hidden Source details panel needs its one-line visibility
correction before owner audience acceptance. No newGIS capture; the NOAA archive intent exists butprepare503
sent nofilebytes. Preserve it and the bounded local captures; no full-dataset backup.

October6: The approved Publication workbench is now deployed as sealed Studio
`88dd0d24603e…` (806files/30,480,292bytes;813origin objects), together with API310,
public module edge, draft-preview policy/shell and the exact private NOAA archive
destination. Previous origin/shell versions remain retained; one invalidation per
surface completed. One diagnosed CloudFront security-header declaration repair
passed its focused infrastructure test and cfn-lint; the original failure is retained.
Representative live sealed files, public CORS/security headers and anonymous denial
pass. HEAD is unsupported by the module API (405); actual public imports remain open.
The saved Sea map/source are unchanged. Continue normal-owner archive and source
public-metadata eligibility, then Artifact insertion/build/address/article release.
Do not replay completed release/source writes or broaden offline compilation.
Details and limits stay in the [current checkpoint](progress.md#october-6--noaa-owner-workflow-and-source-preservation).

NOAA now has22 registered sea-level Layers and its existing Project at version2,
with prior content/view preserved and fresh API readback. The supplied owner login
matches `akdennis`; normal API checks confirm the exact owner UUID, active Account
and workspace. The former literal Cognito-name gate was too strict and is resolved.
Native Sea22-Layer reopening/local edit discard passes with retained pixels and
unchanged persistence; current provider health remains unverified. The tract now has
a real private Catalog identity and one exact managed original with fresh version,
checksum and byte readback; it is queued, not rendered. Three Heat ImageServer
registrations, the Heat composition, durable captures and both articles remain required. Heat pinning has compatible local API481bc07d/Studio8a5bcb1a candidates; one build
and release gate pass. They are unstaged/undeployed and outside pending approval. API-stack reads were denied by the valid static-only
operator session; an exact20-minute staging-grant review is ready, unattached. Failed
intake costs and the existing tract identity are retained; no duplicate registration. Finish NOAA, then WDPA
India2010, global WDPA, PAD-US and MassGIS. WDPA inventory/drafts are prepared;
public downloadable redistribution rights remain unresolved. For MassGIS, archive
only proof-of-concept files and retain broader source connections. Demo’s sealed
649-file tree `8f2f3bb652f2…` passes native browser checks for all four publication
formats: source and offline HTML downloads, simulated review/release, edit
invalidation and five-minute idle reset at1280px/390px. HTML controls are reachable;
opaque preview reuse and inactive cell visibility are fixed. Exact Demo cutover
approval remains pending; shared draft-shell delivery is complete. No Demo deployment. Full
saved-Project offline compilation and formal parity16/33/1 remain unchanged.

October 5 sharing evidence: migrations0154/0155, ownership API9720 and
Studio b08 were deployed and verified, preserving existing owners/content/grants.
The compatible current COG release and hosted outcomes are recorded below.
The published audience control now saves/reopens Account visibility, denies fresh
anonymous Artifact reads, restores Public and reopens that result. The guest's
actual private Collection interface denies access without revealing its title or
editor. Source content/version/rights/original release are preserved. Six live
representative assets and the manifest were verified; other unchanged dependencies
use exact sealed local bytes. The aggregate runner remains failed on its scope
guard for an ancillary metadata-profile GET; completed assertions are retained
separately, with no replay of writes. Both configured credentials work.
Live Team/Organization create/transfer, non-admin-owner sharing and full recovery
remain open. The guest owns no test workspace; do not create accounts or widen grants.

Public static Item search and the direct COG Catalog-to-Project path now have local
implementation and compiled interface acceptance. Search reuses the explicit public
inventory; deliberate registration preserves source metadata/terms and creates no
Project or imagery copy. The selected Catalog map renders actual bounded Sentinel-2
pixels; deliberate Project save/reopen preserves Layer identity, source revision,
configuration and terms. The shared MapLibre reader exposes refresh and cleanup.
Public S3 hides range/ETag headers: known-size 206/exact-length reads therefore display
“snapshot unverified”; no atomic snapshot claim is made. Patched MapLibre 6.4.1 and
brace-expansion 2.1.7 clear the current npm high/critical gate. Larger imagery,
unsupported CRS/bands and broader integrations remain unaccepted.
The approved migration0156/API0cbb/Studio4f81 release is now deployed and verified.
A schema-only0157 correction removes the demonstrated16KiB configuration limit for
bounded COG provenance, preserving existing rows/revisions/grants and the16KiB bound
for other source kinds. Actual sealed registration/Project components now register,
render, save and freshly reopen through normal production authorization, preserving
Layer identity, source revision/configuration/terms; anonymous source reads return401.
Metadata/raster bytes reuse exact captures. This accepts the component/persistence
path. The actual saved Project route, retained Catalog/back navigation and canonical
Layer temporary-map route now also pass read-only Studio acceptance. Full Catalog scene search, distribution/workspace review and deliberate registration
now reuse the exact existing Layer through the actual Studio interface, with unchanged
source/Project and zero writes/provider reads.
No owned search store, ingestion inventory, CI or new runtime resource is added.
Formal families stay16 pass/33 partial/one conditional exclusion; stale evidence
hashes remain open, without promotion or resealing.
[Current outcomes, usage and limits](progress.md#october-5--published-audience-controls-and-bounded-static-search).

## October 5 — Local typed Collection ownership

Local migration 0155 adds exclusive User/Team/owning-account Organization owners
without rewriting existing User records. Compatible API/client controls implement
eligible owner creation, revision-checked audited transfer and typed metadata
export. Current account membership and active Team roles govern Team-derived
authority, independently of Collection grants/audience and target resource access.
The existing recovery metadata inventory includes the new owner IDs.

Frozen forward migrations0154/0155 are committed with exact checksums through155.
Existing User owners, content, entries, grants and revisions are unchanged; the
metadata inventory projection includes typed owner IDs once. No actual recovery
capture, body export or restore was performed. The accepted owner API9720 is deployed
with unchanged resources/runtime/dependencies, and the same accepted Studio build
is live as tree b08. Normal hosted User Collection open/reopen/export and owner
candidate reads are observed; live typed owner creation/transfer, canonical cross-app
identities and the remaining UI journeys are unaccepted. After new owner types are
used, rollback must retain a compatible API; ownership rewrites remain excluded.
Historical parity diagnostics remain open.
[Local checkpoint](../../ecosystem-architecture/.local/adoptions/opengeo-collection-owners-20261005/).

## October 5 — Local Collection metadata handoff

The existing saved Collection editor now exports its validated alpha.6 metadata
through one deliberate authenticated read and local JSON download. Owner, account,
ordered qualified references and unavailable slots remain distinct; metadata grants
no access. Explicit `collectionAccount` links require the existing selected account
before private reads and retain scope without switching accounts automatically.
Twenty-seven focused directory/API/adapter/export checks and nine local compiled
cross-app browser journeys pass with actual components/local metadata persistence
and OpenGeo/auth fixtures. No application build, cloud call, API/schema change,
deployment or parity promotion occurred. Hosted/provider acceptance remains open;
the sharing/security continuation above retains its
current delivery priority. [Contract and local evidence](workspace-collections.md#october-5--saved-metadata-handoff-implemented-locally).
[Local browser receipt](../../ecosystem-architecture/.local/adoptions/docs-manager-collection-links-20261005/browser-delivery/receipt.json).

## October 3 — Owned Layer guided knowledge persistence accepted

The actual published Layer guided editor now saves an inferred marker, reopens it,
restores the exact baseline in a forward revision and reopens that baseline while
retaining marker history. Source/provider/license/rights and saved discovery bytes
remain exact. This closes only the authenticated owned-Layer persistence subitem;
RM-03/RM-04 families remain partial. Production >32 KiB objects and larger refresh
remain required and open; one bounded metadata probe returned only 8,301 bytes.
Continue the remaining selected core workflow acceptance using the existing release.
Formal 16/33/1 and 115 stale diagnostics stay unchanged, with zero reseals. [Acceptance and remaining limits](progress.md#october-3--owned-layer-guided-knowledge-persistence-accepted).

## October 3 — Discovery download, helper save and Collection visibility accepted

RM-04's explicit SQL integer lease cast is deployed in worker `106324e5…`.
Exact deployed-environment diagnosis then reproduces all three constructor failures;
adding only `OPEN_GEO_AWS_REGION` makes all three pass locally. The environment-only
CloudFormation correction is deployed and verified, reusing that image and resources.
Original catalog and collection discovery jobs finish at attempt 1; one reference
Layer is registered through the normal UI. Actual published Layer inspection,
authorized saved inline-response Download and fresh reopen pass without writes,
provider refetch or network asset GETs. The >32 KiB object path remains unproven.

AUTHOR-001C's actual Files Review/Use/Save/fresh reopen now passes on owned Source
`29c2e476…`, revision 4 `95494e4e…`: four new exact objects and two reused companions.
Approved rights, source identities and `fed7e9ff…` compiler pin remain unchanged;
no new hosted build is claimed. RM-09's owner account-shell visibility round trip
passes and restores private revision 6 without member/resource changes. Separate
reader/sharing/public-member inclusion and owner177 Layer/Style acceptance stay open.

The >32 KiB private-object path, larger-document refresh, another account reader,
explicit sharing and positive public-member inclusion remain unaccepted. Formal
parity stays 16 pass / 33 partial / one conditional exclusion, with 115 stale
diagnostics and no promotion or reseal. Next is the existing guided Layer knowledge
Save/reopen/forward-restore workflow; preparation has made zero live calls.

API/Studio/compiler/runtime pins are unchanged; neither worker repair adds Studio
builds, resources, invalidations or Actions. [Current acceptance and limits](progress.md#october-3--discovery-download-helper-save-and-collection-visibility-accepted).

## October 3 — Discovery metadata preservation delivered; hosted acceptance open

The reviewed discovery-only API, permanent worker and Studio bundle are deployed and read back. Normal-session discovery, private response persistence, Layer association and authorized download remain open until the bounded Studio journey supplies evidence. Migration `0153` is committed and verified. Image `e2ff2b21…`
retains all 37 predecessor layers and adds only the three-module discovery-isolation
overlay as layer 38; its exact offline scan has zero HIGH/CRITICAL findings. The
12-resource permanent worker reuses existing Foundation database, bucket and key;
no Foundation update was needed. Mapping began disabled, password bootstrap was
separate, compatible consumers preceded activation, and the active template is exact.

The dedicated queue setting enables no snapshot/data-copy, GeoNode harvest or
processing dispatcher. Exact responses above 32 KiB through 2 MiB remain governed
by current Layer read authority and immutable version/length/checksum checks.
Hosted persistence/download and larger-document refresh remain open; original
local storage, PGlite, UI, IAM, CORS and diagnosed repair evidence is retained.
The normal-session retry exposes a worker claim BIGINT/INTEGER SQL mismatch despite
valid EXECUTE/schema USAGE authority. Next explicitly cast the lease to integer in
one worker-only update and resume the existing queued job; no Studio cutover,
invalidation or new resources. Formal 16/33/1 stays unchanged with 115 stale diagnostics. [Delivery checkpoint](progress.md#october-3--discovery-metadata-preservation-delivered-hosted-acceptance-open).

## October 3 — Larger discovery documents accepted locally; release next

RM-04 adds migration `0153` and a governed `retained_object` descriptor for valid
metadata bodies above 32 KiB through 2 MiB. Account/workspace/job coordinates,
lease, immutable version, length and checksum are sealed; public metadata omits
storage coordinates. Explicit Layer-authorized response download verifies the
saved bytes and rechecks current access. The metadata namespace stays outside
GIS notifications; no dataset capture widening, inspection refetch or processing
is introduced. Small inline records and historical omissions remain compatible.

The original 138 Python, one maintained PGlite, three UI and three IAM cases are
retained, with four storage repair, one IAM repair and one CORS case passing.
The absent-object retry repair uses one exact-key `ListObjectsV2` result, scoped
only to the archiver; committed bytes are reopened and denied access fails closed.
Immutable repair peer review leaves zero critical blockers. Foundations PASS is
reused. Formal 16/33/1 stays unchanged; 112 stale checksum diagnostics comprise
110 prior plus two newly stale artifact hashes, without reseals or family promotion.
This local acceptance used no build or deployment; PGlite is not Aurora acceptance.

The production SourceArchiver stack is absent and dispatch remains disabled.
Next prepare compatible API/Studio consumers plus a separate concrete proposal
for the required production worker; this phase creates no worker. Retention
activation needs migration/scoped IAM, compatible consumers, then the reviewed
producer. Hosted normal-session persistence/download and larger-document metadata
refresh remain open. Current deployed AUTHOR-001C is Studio `7d499d31…`,
compiler `4f944277…`, runtime `a1880ca7…`, with API `0f10d6e1…` unchanged;
shared owner177's normal session and processing IAM authority remain required.
[Checkpoint](progress.md#october-3--larger-discovery-documents-accepted-locally-release-next).

## October 3 — Notebook helpers and compiler deployed

The reviewed helper/constants converter is deployed with compiler `4f944277…`,
one-file runtime backport `a1880ca7…` and Studio
`opengeo-studio-20261003222741-7d499d31d96b` (tree `d0a32db8…`). The API template
changes only the new-source compiler default; code image `0f10d6e1…`, existing
Source/job pins, GitHub primary and four previous admissions remain unchanged.
The exact two historical failed-dispatch rows retain their unadmitted compiler,
request/source/runtime/run identities and state. No job or grant is created.

The actual compiled helper HTML passes isolated runtime/browser execution with
shared identity, native Mutable updates (3 → 5), cleanup and zero egress. Built
Files review/Commit/exact originals/reopen is a local fixture, not hosted persistence.
New-helper normal-session Save/reopen and built focus remain open; four source
focus cases pass. One Studio cutover completes its original invalidation; five
public assets pass exact status, size and SHA readback. Formal 16/33/1 and 110
diagnostics remain unchanged. Next review the passing local RM-04 retained-document
storage/schema receipts: IAM, UI and backend checks pass, with no cloud or build
work. Hosted storage acceptance remains open.
[Delivery checkpoint](progress.md#october-3--notebook-helpers-and-compiler-deployed).

## October 3 — Notebook module helpers and constants accepted locally

AUTHOR-001C reuses the version-1 editable local-module descriptor with a validated
shared scope. Root/child helpers and constants preserve original function/object
identity across cells and derived instances; the import caller retains the root
original once, child originals remain exact, and imported-notebook counts remain
child-only. Thirty owning converter, two Files persistence/recovery and two actual
isolated-runtime cases pass, with the original JSON-ID regression failure retained.
The runtime proves root closures/native Mutable updates and child-derived shared
objects/views/updates/cleanup, with zero parent execution or network. Immutable
five-file peer review and foundations pass. Deployed Studio/API/compiler remain
unchanged; `f4ad135e…` needs updated converter/compiler assets before supporting
this root scope. Next bundle Studio/compiler with the local focus fix through the
existing architecture; formal 16/33/1 and 110 diagnostics are unchanged.
[Local closure checkpoint](progress.md#october-3--notebook-module-helpers-and-constants-accepted-locally).

## October 3 — Final-page workspace focus repaired locally

The Data access directory now captures focused Load more activation before disabling
the button. On successful final-page removal, it focuses Search only if focus remains
on Load more or the document body; another focused control is left intact. One
JSDOM probe established the prior body-focus loss. Four distinct affected cases
pass through scoped corrections, with original process/fixture failures retained;
foundations passes 50 packages, 17 foundations and seven references. This is a
local source fix, not a built or deployed change. Current Studio `a29a7aaa…`/API
`0f10d6e1…`, hosted search acceptance, cumulative usage and 110 checksum diagnostics
remain unchanged. Bundle this with the next coherent release; shared owner177's
normal session and processing IAM authority remain required external items.
[Local follow-up](progress.md#october-3--final-page-workspace-focus-repaired-locally).

## October 3 — Authorized workspace search deployed and hosted accepted

Studio `opengeo-studio-20261003160913-a29a7aaa6388` deploys tree `9670502b…`
and API `0f10d6e1…` over the existing infrastructure. Recovery confirms the
committed cutover and completed original invalidation; five public assets match
status, size and SHA. No upload, build, cutover or invalidation is repeated.

Explicit Search/Enter filters the complete authorized Data access workspace
inventory before pagination. Five API cases, 43 distinct Studio cases, 16 real
local PostgreSQL queries and the corrected exact-built keyboard/390px journey
pass. The first normal-session hosted search also passes: the existing owned
workspace is the only match, a literal impossible query is empty, Clear restores
active page zero, and the target remains unchanged.

Authorization, shared directory inputs, compiler `f4ad135e…`, runtime and auth
remain intact. Hosted inventory scale/every-account acceptance, backup downloads,
the shared owner session and processing IAM authority remain open. Formal parity
is still 16/33/1; current checksum diagnostics are 110, with no seal refresh or
family promotion. Next is bounded shared owner acceptance when owner177's normal
session is available, or the next independent core gap in the active queue.
[Current delivery record](progress.md#october-3--authorized-workspace-search-deployed-and-hosted-accepted).

## October 3 — Workspace pagination and repeat-backup release

Studio `opengeo-studio-20261003151058-46939f5b0d05` deploys `2cb20510…` with
Data access workspace paging and fresh backup provenance filenames. Exact-built
keyboard/zero-filter workspace 101 and 390px fixture navigation pass; a diagnosed
fixture correction separately passes account/disposal guards. Five public assets
match status, size and SHA; one cutover/invalidation completes. The subsequent
API-only output-identity repair `4b6b158b…` is deployed;
compiler `f4ad135e…`, auth, runtime and dependencies remain unchanged.

Private mixed Project/Publication Collection revision 3 is already hosted accepted.
Hosted large-workspace paging and repeat-backup restore remain open. The authorized
bound-Artifact preflight now passes. The final shared checker stops at a hidden
revision-note input without opening Files; its strict guard rejects a build-jobs
GET. Neither repeat nor bound ZIP download is accepted. All browsers close and
local sessions clear. Next is local inspection of the existing Files workflow;
the retained plan authorizes no fourth attempt.
Shared Layer/Style acceptance needs owner177's normal session. Migration
`0152` is approved and verified; processing stays disabled pending IAM execution
authority. Formal 16/33/1 and 105 historical diagnostics stay unchanged.
[Release details](progress.md#october-3--workspace-pagination-and-repeat-backup-release).

## October 3 — Mixed Collection accepted; directory paging local

Private Collection `5620d666…` now saves/reopens revision 3 with the existing
Project first and Publication second; underlying resources and retained entry
identity remain exact. Usage of 37 API/four SRP requests includes the preserved checker failure.
Data access directory paging closes the first 100-record limit locally with
39 initial passing cases plus one corrected retry fixture. No release, upload,
job, new infrastructure, Action or invalidation. Browser/hosted directory checks,
sharing/visibility/isolation and real shared-workspace owner access remain open.
Formal 16/33/1 and 105 historical diagnostics are unchanged. [Details](progress.md).

## October 3 — Selected input backup deployed; hosted restore accepted

Studio `opengeo-studio-20261003141335-d6fe3e214354` deploys frozen `0c0034d0…`
and API `3f0576a6…`. One bundled delivery transfers 786 objects and completes
invalidation `I4V3QZ4ZNF2EG5YFVFUI217Q0D`; the earlier `fed6fe95…`/`e18b2c8b…`
sections retain historical releases. Normal GUI complete-backup download → Files
review → explicit restore → Commit → fresh reopen passes on private Source
`7da3856b…`, revision 2 → revision 3 `cf73e661…`. All eight immutable source
objects/versions remain exact; one verified provenance file is added. Unreviewed
rights and compiler `f4ad135e…` remain unchanged; original IDs confer no authority.
No job, grant, publication, new infrastructure or Actions run is created.

The journey uses 28 API calls (26 GETs, two writes), two SRP calls and one source
storage POST. Zero direct browser storage GETs does not measure backend S3 reads.
Aggregate retained acceptance is 150 API calls, 28 SRP calls, 11 source storage
POSTs and 26 explicit hosted asset GETs; prior usage and failures remain retained.
[Release checkpoint](../.local-archives/renderer-switch-20260930/source-project-export/dependency-backup/release/manifest.json),
[deployment](../.local-archives/renderer-switch-20260930/source-project-export/dependency-backup/release/deployment-record.json) and
[hosted backup/restore](../.local-archives/renderer-switch-20260930/source-project-export/dependency-backup/release/readback-complete-input-backup.json).

This actual source had empty data/Artifact bindings. Local all-dependency and
authorization checks pass (19 archive/import, nine actual UI, five backend and
four client cases, scoped Ruff); the initial archive failure/correction and
non-acceptance default UI-runner diagnostic remain retained. Real bound-dependency
backup acceptance still depends on owner access. The deployed complete backup
conservatively rejects an existing provenance filename. A local follow-up selects
a fresh filename and preserves earlier provenance; all 20 archive/import cases
pass in one invocation. It awaits the next coherent release; no extra build,
cloud call or invalidation. The original source ZIP still preserves all files. Full account/workspace/history restoration and undeclared
remote packages remain open. Formal 16/33/1 and 105 stale checksums stay unchanged;
no family promotion or evidence-seal refresh.

## October 3 — Bundled picker, startup and notebook fixes deployed

Studio `opengeo-studio-20261003131909-54e60408c311` deploys frozen `fed6fe95…`:
Catalog Project pagination, the final-page visibility correction, one retry of an
initial session 503, and literal computed Mutable value import/update support.
Nine picker, three session and 27 converter cases pass. Exact-built keyboard/phone
picker and notebook import/update/reset journeys pass; release/PWA/foundations pass.
One build/cutover completes invalidation `I12LZ9CCL6BUB9HS4H4D818S8H`;
five hosted files match exactly. An interruption required three read-only AWS checks
and completion of the original invalidation; no upload or cutover was repeated.
Auth/dependencies/API/compiler pins stay unchanged; no new AWS resources, jobs or
Actions. Hosted picker authorization, cold latency and broader compatibility remain
open. Formal 16/33/1 and 105 checksum diagnostics remain unchanged.
[Release and reconciliation](../.local-archives/renderer-switch-20260930/core-workflow-release/deployment-record.json),
[built picker](../.local-archives/renderer-switch-20260930/core-workflow-release/built-picker/project-picker-browser-result.json) and
[built import](../.local-archives/renderer-switch-20260930/core-workflow-release/built-import.json).

## October 3 — Import/rebinding/module release deployed; hosted ZIP persistence accepted

Studio `opengeo-studio-20261003121401-870afda2d32d` deploys `e18b2c8b…` with
destination archive/map-alias choices, compiled notebook modules and an async
source-replacement correction preserving dirty/busy map-reference drafts. Five
focused cases and build/release/PWA/foundations pass. Exact built import acceptance
passes local source/reference save/reopen and the retained Bar Chart527 tree with
26 bars. Auth/dependencies/API and deployed `f4ad…` compiler/runtime remain exact;
767 of 778 files are unchanged. One build/cutover/invalidation, no new infrastructure,
compiler/backend build, Actions or jobs. Hosted same-source ZIP GUI Save/reopen
now passes on private source `7da3856b…` revision 2 `e470404f…`: all eight object
IDs/storage versions and 36,741 bytes are reused exactly with zero uploads,
unchanged unreviewed rights and compiler `f4ad…`, and no job/publication/grant.
The first pre-write 503 remains recorded; prior native/Jupyter GUI and private
compiler acceptance are retained. Shared Layer/Style owner-access acceptance is
next; hosted destination binding and full backup remain open. Counts 16/33/1 and
105 historical checksum diagnostics remain unchanged.
[Deployment](../.local-archives/renderer-switch-20260930/authoring-import-release/deployment-record.json)
and [built import journey](../.local-archives/renderer-switch-20260930/authoring-import-release/import-browser-navigation.json).
[Hosted ZIP save/reopen](../.local-archives/renderer-switch-20260930/authoring-import-release/readback-private-zip-save.json).

The approved shared Style migration `0152` is committed and verified with its
exact checksum and internal-helper execution denied. Processing stays disabled;
the spent window remains preserved. Normal owner browser and real worker
acceptance are still open.
[Committed migration](../.local-archives/renderer-switch-20260930/layer-style-reuse/migration-receipt.json).

RM-09 now has hosted account-shell evidence for creating one private Collection,
adding an existing Publication, saving revision 2 and reopening its permanent link.
Source/Site versions and access remain unchanged. The retained journey uses 23 API
calls and four SRP calls, including the first pre-write 503; two optional font GETs
were blocked. Mixed membership, sharing, visibility and account isolation remain
open. No build, new AWS resource, Action or invalidation. [Readback review](../.local-archives/renderer-switch-20260930/authoring-import-release/readback-collection-save-review.json).

RM-02 now ships explicit Project pagination through `fed6fe95…`: 100 authorized
records per deliberate click, with selection/attachment feedback preserved and
stale account/disposal responses rejected. Nine cases are reused; the 10,000-offset
limit stays explicit. Exact sealed-build Chromium passes keyboard loading at
1280 px and selection/attachment at 390 px with the corrected final-page CSS,
no overflow or external HTTP. Its API-shaped fixture does not establish hosted
account authorization; the separate workspace-loader limit remains open.
[Built browser receipt](../.local-archives/renderer-switch-20260930/core-workflow-release/built-picker/project-picker-browser-result.json).




## October 3 — Authoring deployed; exact private Notebook build/preview accepted

The approved rollout deployed and read back compiler `f4ad135e…`, runtime
`f3ea7eaa…` and the matching new-source API default; API code `eeaf224b…`
and existing source/job pins remain unchanged. Fresh October 3 security data
reports zero HIGH/CRITICAL findings. The same normally authenticated private source
`7da3856b…` now saves eight files (36,741 bytes) as revision 1 `c530e32c…`
through the maintained API path. One native job `e67b4ace…` succeeds; its exact
private output renders 26 bars, notices, three disclosures and narrow layout.
Authorized access returns 200 and anonymous access 403; rights remain unreviewed.
The earlier Studio save refusal and costs remain retained. Cumulative acceptance
uses 19 API calls, eight SRP calls, eight storage POSTs and one native build.
No compiler redeployment, new resources, manual Actions dispatch or invalidation.
[Private acceptance](../.local-archives/renderer-switch-20260930/notebook-package/default-selection/acceptance/private-notebook-receipt.json).

Studio `opengeo-studio-20261003110921-177d33b68452` now deploys frozen authoring
candidate `760defbe…` with one completed invalidation and the existing build.
Eight hosted asset checks and normal-authenticated Files/native/Jupyter/ZIP/narrow
readback pass through 10 API GETs and zero API writes. Actual native Files cell
edit, GUI Save and exact reopened revision 3 now pass on retained source `29c2e476…`:
one upload/revision, unchanged companions, approved rights and compiler `fed7…`.
Two earlier checks stopped before writes on runner assumptions and remain recorded.
Jupyter Markdown cell edit, GUI Save and exact revision 3 reopen now also pass on
existing source `427d5364…`, preserving metadata, outputs, cell IDs, companions,
rights and compiler. One upload/revision, no kernel/build/publication/deployment.
Hosted destination-binding persistence and wider conversion/backup remain open. Formal
family counts remain 16/33/1.
[Hosted readback](../.local-archives/renderer-switch-20260930/authoring-workflows-release/readback.json).
[Native GUI save/reopen](../.local-archives/renderer-switch-20260930/authoring-workflows-release/readback-native-save.json).
[Jupyter GUI save/reopen](../.local-archives/renderer-switch-20260930/authoring-workflows-release/readback-jupyter-save.json).

## October 3 — Native compiler admission preserves existing pins

The trusted compiler cap rises locally from three to four, retaining digest,
repository, default and immutable job checks. Two focused cases pass; one duplicate
fixture failure and its targeted correction are retained. A verified isolated
runtime bundle changes only the policy. All three live pins/defaults remain.
The candidate preserves its already admitted AMD64 base and recorded GitHub path;
Notebook entries need no cache-grant change. Three GitHub variable reads retain
two wrong-namespace failures and one corrected success. No AWS/build/Actions/
invalidation. Promotion/preflight and new-image hosted acceptance remain open;
frozen760 and formal family counts are unchanged.
[Receipt](../.local-archives/renderer-switch-20260930/notebook-package/admission/receipt.json).

## October 3 — Immutable compiler image reuses retained layers

The existing publisher OCI assembler now accepts verified compiler base/patch
arguments while retaining legacy API defaults. It validates config, transport and
filesystem hashes, keeps runtime policy exact and rejects symlinks/unrelated paths/
overwrite. Five layers are reused; the431,175-byte source/assets patch adds no
dependencies/native code. One normal AMD64 container run passes without overlays
and emits byte-identical accepted Notebook HTML. Prior Chromium is reused; a wrong
base config rejects before output. A364-component SBOM/cached scan reports zero
HIGH/CRITICAL findings, no suppressions, database October1. No network/AWS/CI/
invalidation/deployment. Interrupted load was unstarted and ran once on resume;
earlier failures remain retained. Production architecture/admission and hosted
delivery remain open. [Receipt](../.local-archives/renderer-switch-20260930/notebook-package/image-assembly/receipt.json).

## October 3 — Current Notebook compiler runs in retained isolation

The maintained container runner accepts a supplied revision fixture, retained
output and optional read-only source/assets overlay. The retained image's dependency
lock is identical to today's lock. One network-none/nonroot/read-only-root run
compiles the actual Bar Chart527 tree to one HTML file with notices and no unrelated
private text. Exact-output Chromium acceptance renders26 bars, notice, responsive
layout and parent isolation with zero requests; browser/temporary containers closed.
Two offline build cache misses and two preflight harness errors remain retained.
No image was assembled; overlay acceptance does not prove image assembly or hosted
delivery. No AWS/CI/invalidation; frozen760 unchanged. Existing foundations reused,
parity retains105 checksum-only diagnostics. [Contract](concept-publications.md#legacy-observable-conversion--local-october-2).

## October 3 — Shared Style access at worker boundaries

Forward migration `0152` rechecks original Style pins/bytes/Layer association and
the job actor's current resource authority. Queued admission, running heartbeat
and completion cancel unavailable dependencies and clear leases; layer reads are
denied. Checks do not rely on worker tenant settings or select a newer Style head.
Six affected and twelve existing PGlite database cases pass. Four initial runner/
fixture/regression failures are retained across five bounded runs. Foundations
pass; aggregate parity retains105 checksum-only diagnostics. No cloud/build/CI/
invalidation. Migration deployment and real worker/hosted acceptance remain open;
no family promotion. [Contract](style-definition-workflow.md#reusable-styles-in-private-saved-map-outputs).

## October 3 — Retained notices reach compiled Notebook HTML

The existing Notebook CLI includes bounded retained notice text in a visible
Licenses and attribution section of its single HTML output. Text/labels are escaped;
unrelated private files stay excluded. Notice scope is not inferred and compilation
does not approve publication. Original bytes remain in source; HTML presents UTF8.

Two pure cases and the existing real local compiler case pass. Both initial default
compiler invocations hit the sandbox's EPERM subprocess boundary, proven with one
empty Node child; the same case passes under scoped escalation. All costs/failures
remain recorded: three in-memory assets builds, no Studio/container build, provider/
AWS/CI call, deployment or invalidation. Prior real rendering is reused. Source-only
outside frozen `760defbe…`; hosted packaging/delivery remain open. No family promotion.
[Contract](concept-publications.md#legacy-observable-conversion--local-october-2).

## October 3 — Upstream Files save/reopen preserves notices

Supplied LICENSE/NOTICE/COPYING text now accompanies converted source under safe,
distinct retained paths, with exact bytes and original path/hash context. Review
names notices; rights remain unreviewed and no term scope is inferred. Identical
primary folder copies are not falsely listed unused; differing copies stay listed.

Four focused cases pass on first runs. The actual pinned Bar Chart527 goes through
Files review, explicit commit and reopen with exact originals, CSV and ISC notice;
draft recovery and generated names still pass. Selected fixture hashes/license are
retained. Local UI/adapter persistence only; prior rendering evidence reused. No
build/download/cloud/Actions/invalidation. Frozen `760defbe…` is unchanged; hosted
persistence and public-output notice propagation remain open. No family promotion.
[Contract](concept-publications.md#legacy-observable-conversion--local-october-2).

## October 3 — One pinned upstream Notebook imports and renders

The actual public D3 Bar Chart527 export now converts with its child module and CSV,
retaining exact originals and its ISC notice. Two demonstrated blockers are fixed:
canonical attachment coercion metadata and generated `@revision` retention paths.
HTL is correctly recognized as already supported offline and explicitly shares the
bundled namespace; the existing build already rewrote its recommended CDN import.
25 converter, 1 Files path-preservation and 1 runtime case pass; a real Chromium sandbox
renders 26 bars/two documentation panels, adapts to 390 pixels and denies parent access
with zero requests. One 29,952-byte export GET and two in-memory runtime bundles;
no Studio build/deployment/cloud/Actions/invalidations. Initial startup/parse/storage
failures remain recorded; no archive refetch. Source-only outside frozen `760defbe…`;
broader exports, deployed authoring and upstream Files persistence remain open.
[Contract and receipt](concept-publications.md#legacy-observable-conversion--local-october-2).

## October 3 — Automation deployed identity accepted

Genuine normal SRP sign-in and six production Python/CLI GETs pass identity, explicit
account selection, bounded search and wrong-account/anonymous denial. The initial
15s identity timeout is retained; one diagnosed 45s first-read retry passed in3.576s.
Four SRP requests across both runs, eight application GET attempts including the
anonymous diagnosis, one AWS metadata read and one temporary official SDK install.
All older auth/CLI failures remain recorded; no writes/jobs/resources/Actions or
invalidations. Local session and temporary SDK are removed. Retained local
write/recovery/reuse and pinned-peer scopes close GEOLENS-008 with declared limits.
Counts are16 pass/33 partial/1 conditional exclusion; no product has full parity.
[Scoped receipt and audit](../parity/reports/geolens-008-automation.json).

## Pinned offline Notebook library loaders — October 3

Legacy require now resolves only the four existing D3/Plot/Inputs/htl pins, with
matching numeric version requests and shared module identity. Parent/child review
retains resolutions; custom loaders and unavailable requests remain manual review.
Twenty-three converter, five affected compiler/runtime and one Files save/reopen
case pass. Two review-check failures were fixed: Notebook Kit uses singular output
for a declared loader, and the Files fixture used the wrong report filename.
Originals and both first attempts remain retained. One affected in-memory runtime
bundle is reused; no release build/cloud/CI. Frozen `760defbe…` is unchanged.
Built/deployed/upstream acceptance and broader libraries remain open.
[Contract](concept-publications.md#legacy-observable-conversion--local-october-2).


## Automation session bootstrap — October 3

The Python client/CLI now reads signed-in identity and memberships before explicit
organization selection. Data methods reject absent scope locally; session selection
is validated and unmapped response extensions omitted. The seven-request loopback
check passes after an initial sandbox socket denial; no dependencies added.
Production authentication remains unverified. One rejected direct sign-in and one
bounded hosted-UI attempt made zero application calls/writes. The browser is closed,
secrets were not printed or saved, and both failures remain recorded. No family is
promoted. [Contract](python-automation.md).


## Imported source map reconnection — subsequent local increment

Files reuses the retained Artifact picker for original ZIP map aliases. Destination
references load separately; explicit map/edition selection and optimistic save use
destination identities and revision. Imported IDs/pins do not become authority.
Unsaved reference edits cannot be erased by source replacement or commit; another
ZIP review retains the recovery controls. Current source/data collisions are checked
at reconnection and source commit. Nine reference checks and five affected Files
checks pass initially, including denied-save recovery and exact source preservation.
No builds/cloud use; source-only outside frozen `760defbe…`. Built/hosted acceptance,
full offline restore and workspace/account backup remain open.
[Contract](page-authoring-and-connections.md#page-source-and-source-project-manifests).

## Imported source data reconnection — subsequent local increment

ZIP import now offers explicit destination-file selection for original data paths
through the existing archive picker. Reconnecting replaces only the chosen draft
path. Original identities and checksums convey no access; differing bytes are shown.
Existing commit checks current access and path/media/size limits before uploading.
Local save/reopen preserves exact source bytes and destination bindings; unavailable,
revoked and colliding files preserve the draft. Source-only outside frozen `760defbe…`;
Automatic restore and built/hosted acceptance remain open; local map reconnection
follows above.
[Contract](page-authoring-and-connections.md#page-source-and-source-project-manifests).

## Local compiled notebook imports — subsequent source increment

The existing converter, compiler and isolated runtime share a bounded local
module graph. Direct imports/aliases, paired reactive imports and canonical
parameter substitutions preserve lazy bindings and separate/shared instance identity.
Graph, binding and attachment changes dispose prior scopes; parent value changes and
import whitespace/pinning retain them. Files preserves original bytes and explicit
save/reopen. Twenty converter, eleven compiler/runtime and the affected workspace
case pass on their first runs for the derivation increment. Existing recovery
checks are reused. Foundations pass; parity retains 105 checksum mismatches only.
The incorrect warning for already-bundled Markdown is fixed. No release build/cloud.
This increment is outside frozen `760defbe…`; coordinated packaging, upstream and
deployed acceptance remain open. [Contract](concept-publications.md#local-compiled-notebook-imports--subsequent-source-increment).

## Consolidated authoring candidate — built October 2

Candidate `760defbe…` bundles the subsequent source ZIP, Jupyter and legacy reactive
conversion changes with native authoring restoration. One build passes release/PWA
and exact built browser acceptance: real editor, source preservation, import review,
ZIP reimport, reactive conversion, narrow layout and isolation. Two diagnosed fixture
failures required no rebuild; all attempts remain retained. No cloud/CI use. This
supersedes pending candidate `2550c2…` for one proposed cutover; both frozen trees
remain available. October 3 deployment and hosted editing/preview readback now pass;
native GUI Save/reopen now passes through one exact retained-source revision.
Earlier runner failures remain recorded; Jupyter GUI Save/exact reopen also passes.
ZIP-import hosted persistence and broader restoration remain open.
[Release review](../.local-archives/renderer-switch-20260930/authoring-workflows-release/review.md).

## Legacy Observable conversion — local October 2

Files now reviews hosted source JSON or ordinary compiled JavaScript exports before
explicitly replacing a working draft. Notebook Kit parses/serializes the conversion;
submitted modules never execute during import. Original bytes, mapped attachments,
conversion report and native publication-format marker are saved together. Local
adapter save/reopen, compiler selection and atomic failure/stale-review recovery pass.
Canonical viewof pairs and mutable triples now become native reactive cells; local
runtime checks prove dependent updates and initializer resets. Canonical supplied imports now have the subsequent source path above. Remote modules, noncanonical wiring and mutable operations beyond value access
remain unsupported.
The consolidated candidate above now passes built conversion/reactive preview;
real upstream-export, deployed and full conversion acceptance remain open.
[Contract](concept-publications.md#legacy-observable-conversion--local-october-2).

## Reviewed source-project ZIP import — local October 2

Files now verifies OpenGeo's stored ZIP export format before explicit import of the
working source tree and reviewed title/entry/lockfile settings. Complete path/header/
CRC/SHA checks and existing source limits precede replacement. Rights start unreviewed;
destination identities, build policy and external bindings remain unchanged. Local
save/reopen preserves exact source bytes, and failures or stale review leave current
work intact. Built export/review/reimport passes in the consolidated candidate;
deployed acceptance, dependency rebinding and full restore remain open.
[Contract](page-authoring-and-connections.md#page-source-and-source-project-manifests).

## Jupyter cell source editing — local October 2

The existing Cells/Source interface edits Jupyter cell text and now adds, duplicates,
moves and removes code/Markdown/raw cells. The bounded JSON range editor splices
exact cell objects; untouched source, metadata, outputs and attachments remain exact.
Fresh IDs, deletion/movement restrictions, selection continuity and bounded Undo
pass focused checks, plus explicit adapter save/reopen. Outputs may be stale and
existing type changes use Source; no kernel runs. The consolidated candidate now
also passes built editor/saved-output preview checks; deployment remains pending.
[Contract and limits](concept-publications.md#jupyter-cell-source-editing--local-october-2).

## Source-project ZIP export — local October 2

The Files toolbar can download exact working source plus a bounded manifest of
settings, original revision context, file checksums and saved external-reference
intent. Existing source limits and authorized lazy readers are reused. Local
checks cover exact bytes, extracted-file reimport, cached reads, failed-read recovery
and stale-result suppression. Dependency bytes, permissions, full history and
automatic restore are excluded explicitly. Built export/import checks now pass in
the consolidated candidate; its deployment awaits approval.
[Contract](page-authoring-and-connections.md#page-source-and-source-project-manifests).

## Native Notebook cells — local October 2

`AUTHOR-001C` now has a Cells/Source interface for native Notebook HTML, including
language/body edits, insertion, duplication, order, removal and bounded Undo. It
edits the existing source buffer; save, authorization and isolated preview retain
their existing paths. Source offsets preserve untouched markup and cell IDs;
ambiguous imports retain Source recovery. Local adapter save/reopen preserves
unknown attributes, BOM/CRLF and binary attachments. The subsequent existing Studio
build passes real Monaco/cell/preview acceptance, source preservation, Add/Undo,
sandbox and 390-pixel layout, plus release/PWA gates. Two browser attempts waited on
an offscreen lazy runtime; showing the authoring view fixed the fixture without a
product rebuild. The consolidated candidate above includes this work and subsequent Jupyter editing;
its deployment remains pending. No cloud or CI use. See
the [active queue](resource-model-roadmap.md).

## Automatic processing controller — deployed disabled October 2

The single approved processing window completed the two-feature upload, but required
three interventions: exact unused-export handling in the controller, starting one
worker because the scaling threshold excluded one queued job, and deregistering the
exact task definition during cleanup. Worker and endpoint stacks are DELETE_COMPLETE,
the task is STOPPED, and both triggers plus the control configuration are disabled.
One window / 1,800 reserved seconds remains spent. Cumulative explicit usage is
38/40 metadata calls and 40 Data API calls; internal deployment/controller requests
are not individually metered. No dollar total is inferred. Automatic availability
is still incomplete. Scaling and cleanup-permission corrections are local only;
the one-file Lambda fix is deployed and must be reconciled into the next assembly.

See the [active queue](resource-model-roadmap.md) for exact receipts.

## Bundled Studio workflow release — October 2

Studio `opengeo-studio-20261003010910-4e4ebd0989ae` deploys source-rights controls,
nonblocking Project job history and native notebook import review. Exact built
review/runtime and PWA checks pass; six hosted assets match. The signed-in editor
reopens the existing approved sample revision without a write. Source export and
restoration of three previously accepted publishing/preview controls are subsequent
local changes. See the [current queue](resource-model-roadmap.md) for receipts,
current-state readback and the next candidate; no full parity or speed claim.

## Deployed loading increment — October 2

Project loading overlaps source/connection reads with the dataset inventory only
after workspace authority and map selection succeed. The 47 loader cases include
ordering, denied authority and aborted navigation. Request count is unchanged.
Studio `opengeo-studio-20261002230248-eab362dd202e` deploys the checked loading
change. One cutover/invalidation completed; three public resources match approved
bytes. Release and offline-cache checks pass. Authenticated latency is unmeasured. The approved public
CC0 sample has a live public map and a deployed embedded Publication. See the [active queue](resource-model-roadmap.md).

## Current implementation boundary — October 2

Use the [delivery dashboard](roadmap-summary.md#current-delivery-status) for release
identities and the [active queue](resource-model-roadmap.md) for execution order.
Managed Catalog preview, deliberate Layer reuse, Project save/reopen and standalone
portable-map public publishing retain their earlier live evidence. Continuous
processing and cold-loading improvements remain unfinished.

Retained Project Artifact registration, pinned reference persistence, compilation
and an embedded private preview now pass using the existing identities and exact
map bytes. The hosted increment activates the existing compiler/runtime and scoped
input reads, fixes UUID typing at two Aurora Data API boundaries, and permits
same-origin nested preview frames without weakening signed-cookie access. One job
succeeds on its second attempt. No new compute, frontend build, public release or
invalidation. The browser snapshot still excludes unsupported My Places content.

The authorized invented CC0 sample is active with five quality checks passed.
Catalog preview and the saved/reopened Project render both points. Its retained
portable Artifact has a public release with anonymous HTTP 200 and visible points.
Publication revision 3 reuses that public URL, passes exact private preview, and is
now deployed at [the demonstration address](https://pages.studio.opengeo.tools/p/invented-locations-demo/).
Anonymous HTTP 200 and both rendered points are verified; Studio reports deployed.
Two source builds were necessary because the first exposed missing source-rights
approval in Studio. The authenticated existing API recorded the user's approved
rights without changing source bytes. The source-rights editor control is now deployed and its saved approved value
is verified through Studio. No formal parity row is promoted by this representative journey.

The version-2 build that copies private Artifact bytes remains preview-only. Public
release URLs use ordinary Publication source instead. The source-save selection fix
is deployed; public-release creation now passes; published embed acceptance now passes for the invented CC0 sample. Historical entries retain their dated scope.

## Archive goal closure and final source records (September 24)

[Completion audit](bhutan-archive-goal-completion-20260924.json) links the retained
preservation, source, catalog, account and renderer evidence. Three NSDI exceptions
are restricted service-metadata records created through the existing repository,
with exact S3 provenance and both-account readback (76 Data API calls). They are
counted separately from working data layers. The renderer check now compares
visible pixels over its explicit white fixture background; a transparent WebGL
buffer had caused a false hide failure despite identical displayed pixels. Live
render evidence and offline hide evidence remain separate. User-confirmed hosted
rendering is recorded. Syntax/whitespace checks passed; no app build or deployment.

## Remaining ICIMOD catalog batch (September 24)

[Checkpoint](bhutan-regional-remainder-batch-20260924.json) records 211 references
and 14 maps with both-account exact readback. The existing bulk operator now handles
native ArcGIS vectors as well as map images. A failed insert exposed a missing
dataset-format enum cast; a six-call read-only check confirmed no planned rows,
then the corrected batch completed within its original deadline and call limit.
Local preparation preserves empty historical metadata explicitly and retains
oversized symbology by reference. Reconciliation records provider groups separately
from dataset counts. Syntax and scoped whitespace checks passed; no application
build or deployment. Source and renderer evidence limits remain in the checkpoint.

## Regional-only batch and geographic review (September 24)

[Checkpoint](bhutan-regional-scope-batch-20260924.json). The batch operator now keeps
regional-only source/map membership separate from Bhutan and uses each source's
recorded bounds. Readback verifies map definitions and absence from the Bhutan
Collection. A diagnosed JSON parameter-binding mismatch caused one rolled-back
attempt; exact map comparison now uses the repository write binding. Cumulative
calls include the failed attempt and two read-only probes. GDAL/PROJ recovered
499 current extents locally; envelope and exact boundary evidence remain separate.
No deployed application changes. The targeted live visibility check passes with
retained baseline/final canvas evidence; other rendering claims remain limited.

## Regional climate catalog batch closed (September 24)

[Checkpoint](bhutan-regional-climate-batch-20260924.json) retains the 2,387-reference,
31-map registration and both-account readback. Existing bulk operators now accept
retained service image samples and group model periods without per-layer HTTP
observations. Complete parsed layer metadata and exact historical S3 identities are
retained; large original documents use immutable references rather than exceeding
the catalog metadata limit. No deployed application change or original raster
acquisition is claimed. Rendering exceptions and hosted sign-in remain explicit.

## Prepared temperature references closed in one batch (September 23)

[Evidence](bhutan-temperature-batch-closed-20260923.json). The eight already prepared
maximum/minimum temperature plans now register 255 references in eight all-off
Bhutan maps and the existing private Collection. Exact metadata, source settings,
tags, memberships and map definitions pass runtime checks for Aaron and Categorise.
The transaction uses existing authorization rules/RLS and map/Collection repositories;
set-based writes replace per-record/tag network calls. Total: 233 Data API calls,
including a three-call cold-start failure; no S3 requests, uploads or app deployment.

One minimum-temperature layer passed the retained Studio renderer after one tile
timed out and a bounded retry succeeded: 24 PNG requests / 24,677 bytes across both
attempts. Unchanged maximum-temperature rendering evidence is reused. Remaining
layers have retained individual provider image observations and shared renderer-path
evidence, not individual browser or complete pixel-coverage verification. Model
periods/scenarios remain explicit; no original raster acquisition is claimed.

The current regional pointer now records 716 registered historical identities, with
2,804 raster references, 85 vector references and three groups still to reconcile.
Those are metadata-only candidates, not automatically missing archives or confirmed
Bhutan datasets. Next use bulk service metadata and retained geographic evidence to
resolve that finite queue; keep new data acquisitions separate. Hosted signed-in
acceptance remains unverified. The archive-only alternate-copy UI item remains
separate from its working explicit-enable map path. The full goal remains active.

## Later-added originals reconciled; historical fire layer usable (September 23)

[Evidence](bhutan-original-supplement-closed-20260923.json). All 13 later-added
ICIMOD originals already had private S3 preservation. Twelve had catalog lineage;
the remaining 121-point Active Fire archive now has its own catalog identity and
Bhutan map in the private Collection. Both accounts pass runtime access. Combined
coverage is 5,095 preserved local paths and 616 payload/companion paths with catalog
lineage; these are file counts, not independent dataset counts. No uploads.

The fire records date to March–May 2011; the filename's 2022 is not an observation
year. Exact upstream origin remains unknown. The existing public archive passes a
46,151-byte GET/hash/CORS check, and all 121 records pass the retained Workbench
content check and render after explicit enable. Opening the all-off map reads no
archive bytes. Its private copy passes exact-version HEAD and both-account archive
access, but the retained viewer lacks an alternate-copy button for archive-only
layers. Hosted sign-in is unverified. No app build or deployment occurred.

Registration readback resumed without replaying writes after a diagnosed one-ULP
bounds rounding difference. The registrar reuses the tested numeric comparator.
The browser fixture now accepts actual archive-only configurations and exact S3
paths; failed fixture attempts remain recorded. Next: resolve the finite historical
metadata/source-relevance queue from retained evidence, with optional new provider
acquisitions paused. The full goal remains active.

## Original lineage closed; current-directory delta identified (September 23)

[Evidence](bhutan-original-lineage-closed-20260923.json). All 603 payload/companion
paths from the initial 5,082-path inventory now have catalog/archive lineage.
Twenty existing records received 39 original-file relationships and eight image
sidecars, with both-account readback. Exact original text/checksums are retained;
parsed floating-point readback permits at most two ULPs after a diagnosed wire
rounding difference. Three focused tests protect IDs, source text and structure.

A ten-call runtime batch confirms both accounts see all 281 associated active
catalog identities in Bhutan maps. It exposed two missing Map service archive
choices (land cover and river). Both are now enabled against existing verified
private objects and pass both-account API readback; no data transfer or conversion.
The river passes the retained Studio renderer using the MapServer FID convention:
541 records preserved, including 13 without geometry. Land-cover display evidence
is reused for unchanged artifacts. Zero S3/provider requests this increment.

A current directory/stat check found no missing or changed original files, but
13 files now exist under `icimod-archive/data-original/` that were absent from the
initial inventory. Only those 83,210,822 bytes were hashed. Twelve match existing
private S3/catalog lineage. The remaining Active Fire file exactly matches a
retained September 13 S3 GET receipt (46,151 bytes, 121 features); its catalog/local
path relationship still needs closure. This is an explicit inventory delta, not
permission to reupload the other copies. Reconcile and preserve these local-path
observations next. Historical metadata relevance/catalog work and hosted signed-in
acceptance also remain; the full goal is not complete. All processes are terminal.

## Original payload audit and missing landslide layers (September 23)

[Evidence](bhutan-original-inventory-landslides-20260923.json). The original inventory
has 5,082 preserved paths, including 603 data/image/companion paths. Retained exact
object or provenance links now cover 564 of those paths; 39 need further lineage
reconciliation (13 GeoJSON, ten GeoJSONL, eight images and eight world files). This
is not 39 missing datasets: all 13 GeoJSON files have existing catalog candidates,
and image sidecars name their source, layer, CRS and download date. Join those
receipts and metadata before making new copies or requesting more provider data.

The audit found two landslide sources omitted by the historical sanitized-folder
collision. Both now have catalog identities, one new Bhutan map and private Collection
membership. Their 189-point captures are byte-identical and reuse one existing S3
object. Aaron and Categorise pass runtime source, map, Collection and archive access.
One actual retained Workbench check covers the identical capture bytes: all 189
features/attributes load after explicit archive selection and render; hidden layers
and live failures make no archive requests. Hosted sign-in remains unverified.

Four provider requests received 15,383 bytes. Registration used 190 Data API calls,
including three failed database-wakeup calls before any write. Admission used seven
calls and one S3 HEAD; account readback used 26 calls. No upload, conversion, grant
change, app build or deployment. The existing registrar now avoids reading every
Collection member's target during readback and supports original Bhutan vector plans.
Three continuation tests, operator syntax, whitespace and foundations pass; the
existing shared parity fixture hash failures remain. All processes are terminal.

Next: close original lineage relationships using the retained inventory/activation
receipts and image sidecars. Keep historical metadata/provider-relevance requirements
visible, but do not silently turn them into new full-data acquisitions. New provider
batches remain paused. The full goal remains active.

## Close committed work; enforce cost correction (September 23)

The user again reported excessive cost and repeated requests for an expedient close.
[AGENTS.md](../AGENTS.md) now makes finite ingestion completion authoritative instead
of importing platform parity as additional scope. The [delivery rules](logbook/ingestion-delivery-and-concurrent-review.md)
require reuse, bounded research, batch acceptance and closure before expansion.
**New provider batches are paused pending a finite requirement/inventory audit.**
Do not start the prepared minimum-temperature maps or remaining maximum-temperature
periods merely because plans exist. Match each next action to an unmet user requirement.

[Current evidence](bhutan-waterbody-temperature-20260923.json). The waterbody tiled
archive is privately preserved and enabled against the existing regional and Bhutan
Layer. Aaron and Categorise pass archive/map access. Every recovered spatial ID and
attribute is retained: 466,445 geometries, plus one preserved attribute-only record
whose provider geometry is unavailable. All originals and error evidence remain
preserved. The retained Studio renderer passes the Bhutan view and eight tiny polygon
probes, reading 3,672,130 bytes in 35 local range requests. No automatic archive loading,
permission change or new application deployment. Hosted sign-in remains separate.

The interrupted temperature job committed two maps / 51 Layers. Both accounts now
pass readback; no committed registration was replayed. The 17-layer baseline has a
representative successful renderer check after one retained provider timeout. All
153 maximum- and 153 minimum-temperature references have individual provider image
observations. Three further maximum-period plans and five minimum-period plans are
prepared but unexecuted. The runner is explicitly paused; all processes are terminal.

The inventory pointer retains 461 registered historical identities, with 3,059 raster,
85 vector and three group references unmatched. Those are metadata identities, not
an assertion that all are captured datasets, Bhutan-relevant, or require new acquisition.
An offline queue separates 82 current-queryable vector references outside the retained
Bhutan boundary. Next: derive the finite completion matrix from the requested original
inventory, logical datasets, existing catalog links and actual usable map requirements.
Close genuine gaps; keep optional enrichment separate without hiding unmet requirements.

Three continuation tests, syntax, whitespace and foundations pass. Shared parity
fixture hash failures remain unchanged. Files and receipts are checkpointed. The full
user goal is not yet declared complete; do not substitute this checkpoint for its audit.

## Precipitation periods and recovered regional vectors reconciled (September 23)

[Retained checkpoint](bhutan-confirmed-vectors-20260923.json). This supersedes the
running-process status in the earlier scenario entry below. All processes are terminal.
The approved 19-file land-cover upload remains complete; all 15 retained evidence
hashes match, and no repeat upload occurred.

All **153 precipitation-model Layers** are registered in five period maps, with
both-account access verified. Thirteen representative Layers passed the retained
Studio renderer; all 153 have individual provider image observations. Six uniform
images remain explicitly unconfirmed coverage. Model/scenario names and years are
preserved. Original raster pixels are not claimed archived.

The **23 vector sources** confirmed against the retained Bhutan boundary are now
registered in four source-grouped Bhutan maps and the private Collection. Regional
custody is retained. Twenty-two complete GeoJSON captures contain 145,927 features;
99 unique private objects preserve their 225 logical paths. Their archive choices
are enabled in both the regional and Bhutan workspaces. Aaron and Categorise pass
production runtime archive/map readback. Four representative captured layers
(points, multipoints, lines and polygons) pass actual built Workbench rendering,
with full feature-content hashes and zero external requests. Hidden layers and
live failures make no archive reads. This is intercepted transport plus separate
production authorization evidence, not hosted signed-in browser acceptance.

The larger waterbody capture preserves all **466,446 records' attributes** and
466,445 recovered geometries in 482 private objects / 483 logical paths. One provider
geometry could not be obtained: original GeoJSON/native errors, attributes, stable
ID inventories and the bounded generalized-query timeout are preserved. Its null
capture geometry means unavailable, not a null original. The catalog records that
limitation explicitly; a bounded tiled display is still required before archive use.

The effective regional reconciliation accounts for **410 of 3,608 historical
identities**. Remaining: 3,110 rasters, 85 vectors and three groups. Those historical
counts do not establish Bhutan relevance or captured originals. Separate archive
renderer evidence now accompanies the reconciled identities without implying live
rendering. Use the existing reconciliation index; do not repeat uploads or recoveries.

All new map layers start off, live is the default, and archive reads require user
action. No grant change, application build or deployment. Syntax and foundations
pass; parity retains existing shared fixture hash failures. Operator files are
retained in the linked checkpoint. The full goal remains active. Next: bounded
waterbody display, remaining regional metadata, then hosted map acceptance. The
user-deferred uploader test is not an ingestion completion requirement.

## Regional scenario and vector review in progress (September 23)

[Retained checkpoint](bhutan-regional-scenarios-progress-20260923.json).
Another **36 live Layers** are registered and read back as Aaron and Categorise:
19 demographic/environmental references and 17 precipitation baseline references.
Both grouped Bhutan maps start off. Every source passed a small provider image
check; nine representative layers passed the retained Studio rendering path with
zero hidden-layer provider traffic. This is sampled rendering, not 36 individual
browser checks or hosted signed-in acceptance. One provider tile exceeded the
20-second test timeout; a single retained 45-second retry passed.

All 153 precipitation-model references have current metadata and image observations.
Five immutable period plans preserve baseline/RCP names, including the provider's
`RPC45` spelling without silently correcting it. Six uniform images are explicitly
flagged as unconfirmed valid-data coverage. The four 34-layer period plans remain
in progress. The first larger transaction exceeded the operator tenant-executor time
limit; read-only inspection proved its selected records and map absent. Its failed
receipt and 1,236 calls are retained. The operator timeout now scales to batch size
within the existing 900-second limit and original total 11,460-call ceiling; no
application or deployed API change.

**Poll exec session 44577 before restarting anything.** Its ledger is
`.local-archives/bhutan-local-20260920/regional-imagery-reconciliation/ppt-period-batch.json`;
the log is `/tmp/opengeo-ppt-period-batch-resume-transaction.log`. The ledger is not
liveness proof. All other processes from this increment are terminal. Inspect any
failure before replay; completed registrations and renderer receipts are reused.

Current public metadata/count review covered 105 previously unresolved vector
references (232 GETs, 1,161,803 response bytes). Sixty-nine have no features in the
Bhutan envelope. Exact retained district-union queries for the remaining 36
(36 read-only POSTs, 6,937,344 query bytes) identify **23 actual boundary matches**
and exclude another 13. No feature payloads were downloaded. Next recovery work:
22 ordinary candidates plus the separately bounded 466,446-feature regional permanent
waterbody source. Preserve regional custody; Bhutan membership does not imply that
all source features are in Bhutan.

The single effective reconciliation pointer is now
`.local-archives/bhutan-local-20260920/completion-audit-20260923/regional-reconciliation-index.json`.
Run `python scripts/reconcile-regional-registration-receipts.py` after verified
registrations. It reuses immutable input receipts and creates content-addressed
snapshots without overwriting older evidence or requiring database/provider scans.
The retained checkpoint accounts for 251 registered historical identities, with
3,246 rasters, 108 vectors and three groups remaining; running batches may advance
this. These historical counts do not imply all entries are Bhutan-relevant.

Syntax, whitespace and foundations pass. Parity retains the existing shared fixture
hash failures. No S3 upload, grant change, application build or deployment occurred.
The full goal remains active, including remaining regional services and hosted map
acceptance; the deferred uploader test is separate.

## Regional tiled layers and HKH imagery completed (September 23)

[Batch evidence](bhutan-hkh-catalog-20260923.json). Eleven existing regional fire
and glacier Layers now appear in three source-grouped Bhutan maps. Actual original
geometry intersects the retained Bhutan boundary. Six unchanged tiled displays and
six checksum indexes were reused, with 12 S3 HEADs and no upload. Both accounts pass
map, Collection and archive-choice readback. All six displays render at the Bhutan
viewport using the retained Studio build and local bytes.

Another 70 live imagery Layers (22 land-cover and 48 monthly climate) are registered
in three Bhutan maps, with current provider metadata and exact historical S3 metadata
links. Both accounts pass readback. Every layer rendered over Bhutan and starts off;
hidden layers made no provider requests. Initial review used 80 provider requests;
browser checks used 852 requests / 6,841,450 bytes. The land-cover check combined a
retained successful prefix with a five-layer continuation after a global-idle assertion
timeout; the continuation required hidden visibility and an exactly blank canvas.
Original raster pixels are not claimed archived. Hosted signed-in acceptance remains
separate and unfinished. No application build, deployment or permission change.

The effective reconciliation is now
`.local-archives/bhutan-local-20260920/completion-audit-20260923/deferred-reconciliation-hkh-complete.json`.
It supersedes, without overwriting, the earlier reconciliation: 215 of 3,608 historical
metadata entries have exact registered matches; 3,282 rasters, 108 vectors and three
groups remain. These counts do not establish Bhutan relevance or original-data availability.
The approved 19-file private land-cover upload and its two catalog links remain complete.

All processes in this batch are terminal. Next: reconcile the remaining regional
services in bounded batches, prioritizing confirmed Bhutan coverage and retaining
model/scenario years and unknown units explicitly. Reuse existing identities and S3
objects. Finish hosted catalog/map acceptance separately from the deferred uploader
test. The full archive goal remains active. Syntax, whitespace and foundations pass;
parity still reports existing shared fixture-content hash mismatches, which were not
resealed. Seven operator scripts are retained in the linked file-backed checkpoint.

## Approved land cover and regional catalog links completed (September 23)

[Batch checkpoint](bhutan-regional-catalog-20260923.json) and
[land-cover evidence](bhutan-landcover-enabled-20260923.json).
The user explicitly approved the additional 19-file, 301,681,179-byte package.
It is now preserved privately, linked to both existing 50k land-cover Layers, and
read back as Aaron and Categorise. Six deployed reader modules and the native API
image match retained acceptance. Both map entries remain off; archive loading is
manual. The earlier pending-approval entry below is historical and superseded.
The known NSDI display backlog is now empty; this does **not** close the full goal.

Current provider checks and retained Studio rendering pass for **19 regional imagery
Layers** in two new source-grouped Bhutan maps. All start off and make no provider
requests while hidden. Full current layer metadata and exact historical private-S3
metadata identities are retained separately. Original raster pixels are not claimed
archived. The tests used 33 initial provider-review requests and 228 browser image
requests, with about 4.39 MB of browser image responses; no S3 downloads or new
application deployment.

A local geometry audit against the retained 20 Bhutan district polygons identified
**26 already registered regional vector Layers** for reuse, two with no intersection,
and 11 tiled originals requiring further review. The 26 existing identities now
appear in five grouped Bhutan maps and the private Collection. The same 354 preserved
S3 objects are available as manual archive choices in Bhutan: no copies were uploaded,
no grants changed. Both accounts pass source, map, Collection and archive readback.
Actual built Workbench checks pass for representative polygons, points and lines
(12, 436 and 128 complete features), including deliberate archive cost acknowledgement,
no downloads while hidden or after live failure, and rendering over Bhutan. This is
intercepted transport with actual preserved bytes plus separate production RLS
acceptance; hosted signed-in browser acceptance remains open.

The single effective deferred-metadata reconciliation now accounts for 145 of the
3,608 historical entries as registered, including the 19 new references. Remaining:
3,352 rasters, 108 vectors and three groups. These are historical metadata identities,
not a claim that every one is Bhutan-relevant or that original data were captured.
Retained original preservation still covers 5,082 paths / 4,337 versioned objects.
Do not repeat completed uploads or conversions to refresh these receipts.

Next: verify geographic coverage for the 11 existing tiled regional vector originals,
reuse appropriate identities/archives in Bhutan, then continue the remaining regional
provider metadata in bounded batches. Prioritize HKH land cover and monthly climate;
retain modeled scenario years and source units explicitly. Finish hosted catalog/map
acceptance separately from the uploader test the user deferred. All batch processes
are terminal. The full goal remains active.

Operator-only changes are retained in a file-backed checkpoint. Syntax, affected
whitespace and foundations pass. Parity continues to report shared fixture-content
hash mismatches; no unrelated evidence hashes were resealed. No application build
or deployment was performed.

## Bhutan land-cover display reviewed; full inventory audit retained (September 23)

[Checkpoint and evidence](bhutan-landcover-and-completion-audit-20260923.json).
The 410,122-record 50k land-cover display now passes complete identity/attribute,
packed-byte and renderer-ring checks. Retained z13–14 tiles are unchanged; classified
imagery covers z7–12, avoiding 31 over-limit z12 vector fragments. Eight independent
native source-coverage probes pass within 0.896 m of display quantization; this is
sampled display evidence, not analytical geometry equality. The retained published
Studio renderer passes overview/detail, eight probes and manual archive lifecycle
checks using 42 intercepted range requests / 3,876,992 bytes, with no external calls.
Original GeoJSON and GeoJSONL remain preserved independently; their complete parsed
geometry equality is not asserted.

The 19-file, 301,681,179-byte private package is prepared but **not uploaded or
linked**. Automatic approval review rejected it because the prior explicit approval
covered only four different packages. The exact new payload/destination approval
question is pending. Preserve plan `5e1c7f727e7808fc`; do not regenerate, bypass the
rejection, or repeat the four already completed packages. After approval: conditional
transfer, release compatibility check, links to the existing 50k_Bhutan and
Topography_50k Layers, then both-account readback. Hosted sign-in remains unverified.

The broader audit reconciles 5,082 original paths to 4,337 preserved versioned
objects with no path/hash gaps. Retained current RLS readback proves all 143 regional
recoveries and 33 Bhutan maps accessible to both accounts; 32 Collection maps cover
all 349 distinct map Layers. All 18 registered Bhutan rasters occur in those maps,
with saved visibility off. This is access/membership proof, not universal rendering.

Historical deferred metadata is now separately classified: 3,608 entries / 75
services (3,422 rasters, 183 vectors, three groups); 2,933 distinct metadata files
match preserved checksums. Nine entries have invalid JSON; 169 lack a usable extent.
3,054 intersect the Bhutan bounding box, often through broad service extents. These
are scope candidates, not confirmed pixels or a count of absent catalog records.
Reconcile current identities before registering grouped regional imagery. Do not
substitute completion of the NSDI vector queue for the full archive objective.

This checkpoint changes operator preparation/verification only: no app build,
deployment, provider calls, S3 operations or database calls this turn. Syntax,
focused positive/negative admission checks, whitespace and foundations pass. Parity
retains shared fixture-content hash failures; no evidence hashes were resealed.
Reuse the completed artifacts and checks; full goal remains active.


## Demo New Project catalog and rendering verification (September 23)

New Project opens the searchable Layer catalog; the empty map and Add data panel
also offer Browse Layer catalog. Review and add preserves source metadata and adds
the selected Layer to the current Project without navigating to another composition.
The new-Project status now explains catalog selection and local save limits.

The current Demo build stages the shared filter editor and Layer-version dependencies.
A browser check exposed an unfiltered-layer regression in the in-progress filter work:
MapLibre layer specifications must omit an absent filter, rather than supply null.
The fix retains null for clearing a runtime filter and omits it during layer creation.
A focused regression check and the actual built Demo journey pass: select a catalog
Layer, render, save locally, reload and render again, then return to the catalog
without losing the selected Layer. [Receipt](demo-new-project-catalog-evidence.json).
Build tree: `767d02bb82902b5017c4866ddce07b1dc4789e677f28f3a2b25ae9045c508531`.
The broader local registration journey also passes after the fix, including KML
render/edit/reopen, metadata preservation, independent catalog identity and reference
reuse. [Regression receipt](demo-catalog-registration-current-evidence.json).

Focused Demo/catalog/filter checks and foundations pass. Parity validation still
reports existing shared fixture hash mismatches; no evidence hashes were resealed.
No AWS, external providers, GitHub Actions or deployment were used. This is a local
checkpoint, not evidence that the deployed Demo has changed.

Next: include this Demo bundle in the next authorized batched release. Resume the
pending Project filter/version connected acceptance using a rebuilt Studio artifact:
the earlier Studio build predates the unfiltered-layer fix. Filter persistence and
post-save Publication-input checks remain unverified until that journey passes.
Full parity remains partial.


## Project Layer version update checks field dependencies (September 23)

Layer actions → Style now includes **Project Layer version** for editable pinned
managed Layers. It lists authorized active versions and checks candidate schema
against label, category/graduated Style and supported rendered-expression/filter
dependencies. Missing fields, unknown dependencies/schema, unresolved pinned Styles,
nonnumeric graduated fields and changed geometry types block replacement. One
unambiguous inspected schema and an unchanged geometry type are currently required.

**Apply version to Project draft** reads the complete authorized exact version before
changing its pin or display. In-flight source/presentation changes invalidate the
attempt. Existing identity, presentation and runtime filters are retained; **Save**
persists the Project separately. Catalog current pointers and publication actions
are not part of this control.

[Full built Studio evidence](../parity/reports/geolens-003-project-version.json) passes:
a missing `name` label blocks the newer `status` schema, Cancel retains the old pin,
and a deliberately failed object read leaves the earlier map intact. Disabling the
incompatible label allows the new data to render. One explicit Project save and
reload retain the candidate pin, Layer identity and Style through the real API/database.
The browser uses Layer actions → Style; the initial check incorrectly assumed selecting
the Layer name opened that panel and was corrected without changing the build.

Focused dependency/picker checks pass. One Studio build, tree
`eef2af8b9e67335b228bd4452fddb7e4121604aee0b1240634aaa98fbf6a60a4`,
retained under `.local-archives/project-version-build-20260923`. The final connected
run uses two native captures, three tiny XML documents and one local Publication build;
an earlier navigation-check attempt repeated that local setup. Containers removed.
Foundations, syntax, affected whitespace and evidence schemas pass; parity retains
shared fixture hash failures. No AWS, live providers, CI or deployment calls.

Limits: field/filter variants beyond the label case have focused evidence only;
mobile picker and broader geometry/schema cases remain open. Runtime filters are
assessed during replacement but their saved composition semantics remain separate.
Publication rendering is verified before the Project save in this receipt. Additional
post-save frozen-input/build-count assertions were added afterward and must run in the
next affected batch; do not treat them as evidence already obtained. Full parity partial.

Next: persist supported Project filters and verify their save/reopen semantics together
with version replacement, including removed-field refusal and retained publication inputs
after Project save. Reuse this build where inputs are unchanged; avoid another run solely
for fresh receipts. Deployed/provider acceptance and broader parity remain open.


## Revised WFS schema reaches staged data review and retained publication (September 23)

The connected journey now carries an actual revision-1 capture through reviewed WFS
metadata, deliberate source revision 2, staged capture/native processing, Studio data
review and one-time acceptance. Exact WFS requests change from `facility_id,name,geom`
to `facility_id,status,geom`; the candidate also changes the ID's inspected type and
point geometry. The base stays current while the candidate processes.

Server review retains both exact source revisions and processed schemas, with
`schema_changed` and `source_revision_changed`. Studio displays these reasons and the
explicit data-version comparison, including `name`/`status`, before acknowledgement.
Reader acceptance is denied; owner acceptance happens once and reopens the candidate.
Stale expected source revision and stale base requests each receive 409.
[Receipt](../parity/reports/geolens-003-wfs-schema-refresh.json).

The earlier captured features feed a pinned portable Artifact and one Publication
build before source/data changes. After promotion, frozen Publication inputs and
output bytes remain unchanged. Actual bundled MapLibre renders the earlier point,
Layer toggle and reset controls at 1100 and 390 pixels without another build or
external requests. Project/Artifact/Publication setup is through repository/compiler
paths; prior full authoring/upload evidence remains separate. Automatic Style/filter/
label dependency compatibility is not established by this single-point case.

Reused Studio tree `30bd48233c1ed079fee2e04ba8351c0daa7702ad553f16b8e755586144dd59e4`;
no app rebuild. Two one-feature captures/native workers, three tiny XML responses,
one local Publication build, containers removed. Syntax, affected whitespace,
evidence schemas and foundations pass. Parity retains shared fixture hash failures;
no blanket resealing. No AWS, live-provider, CI or deployment calls. Full parity is
still partial, with synthetic identity/provider/storage explicitly retained.

Next: assess field dependencies when users deliberately update a Project's pinned
Layer configuration/version. Show missing fields used by Styles, labels or filters
before changing the composition, preserving the old pin on cancellation/failure.
Broader schema/geometry/volume/accessibility and deployed/provider acceptance remain.


## Deliberate WFS connection revision from reviewed schema (September 23)

The verified provider response now offers **Review WFS connection changes** separately
from metadata acceptance. It reads the current connection and checks Layer, workspace,
endpoint, collection and the exact reviewed revision. Existing selected fields still
available are prefilled; removed fields are listed. Users choose fields and explicitly
confirm stable sorting before **Save WFS connection revision**. Editing selection clears
confirmation. Proposed and earlier configuration remain visible.

The existing revision API supplies optimistic concurrency and authorization. Saving
preserves the endpoint, page limits and attribution while applying reviewed geometry
and selected fields. It creates a new source revision, not a new Layer or data capture.
Project source pins, Styles, filters and labels are not rewritten; the interface states
that dependency compatibility is not automatically checked.

[Full Studio evidence](../parity/reports/geolens-003-wfs-revision.json) covers metadata
review, refusal before confirmation and without the sort field, one source PATCH,
revision 2 reopening, and real API rejection of stale expected revision 1. Both exact
schema documents and curation remain retained. Focused component checks and one built
journey pass. Tree:
`30bd48233c1ed079fee2e04ba8351c0daa7702ad553f16b8e755586144dd59e4`,
retained under `.local-archives/wfs-revision-20260923`.

Three tiny fixture XML documents, no native processing/capture/Publication jobs,
and the local PostgreSQL container removed. Foundations, affected whitespace and
evidence schemas pass. Parity validation retains existing shared fixture hash failures;
no blanket resealing. No AWS, external provider, CI or deployment calls. Synthetic
identity/provider transport and local persistence do not establish deployed acceptance.
Full parity remains partial.

Next: exercise the revised connection through a staged capture under the existing
managed Layer, comparing changed fields and source revision before promotion. Verify
stale source/base refusal and retained Project/Publication pins with the changed schema.
Automatic dependency compatibility, broader schema/geometry, volume/accessibility and
live-provider/deployed acceptance remain open.


## WFS schema review and metadata discovery connected (September 23)

WFS provider metadata checks now use the browser API's `configuration.typeName`.
The connected journey exposed the prior snake-case lookup, which stopped submission;
the focused fixture now follows the parsed API contract.

Provider response comparison adds a bounded selected-collection field summary for
local XML declarations: added/removed fields and changed type, cardinality or
nillability. Names and resolved type namespaces avoid false changes from reordered
fields or namespace-prefix aliases. Exact text remains available; unsupported
complex groups, unresolved inheritance, different namespaces and unsafe XML receive
an unavailable summary. Imported type definitions are never fetched or interpreted.

Full Studio registers the source, preserves curation, retains the original schema,
explicitly checks updated metadata, compares the changed fields, accepts and reopens
both exact XML responses. Registered configuration, URL and revision remain unchanged.
[Receipt](../parity/reports/geolens-003-wfs-schema.json). Metadata acceptance does not
change data, Project assignments or field selections.

Four focused check files and the connected journey pass. Final Studio tree:
`f2313b63c75e1ba0e53add5499bb3c2a727d4c6e16f1ccd5fdd7ff007f98279f`
under `.local-archives/wfs-schema-fixed-20260923`. The initial build/journey
identified a test status-text mismatch and then the production adapter mismatch;
a second build was required for that fix. Final run uses three tiny XML documents,
no capture/native processing or Publication jobs, and removes its PostgreSQL container.
Foundations, affected whitespace and evidence schemas pass; parity still reports
shared fixture content-hash mismatches. No AWS, external-provider, CI or deployment
calls. Identity/provider transport remain fixtures. Full parity remains partial.

Next: connect reviewed schema changes to deliberate source-configuration revision
and a staged data refresh, retaining the old configuration until that separate action.
Verify removed sort/style fields and source-revision conflicts before claiming the
whole schema-change workflow. Reuse prior pinned-output evidence for unchanged paths;
complex schema, geometry, volume/accessibility and deployed/provider acceptance remain.


## WFS failure history preserves the usable Layer (September 23)

Known provider total-count contradictions now retain `source_count_mismatch` for
WFS as well as ArcGIS. Invalid count encodings and repeated identities remain
`response_invalid`; no source data or count is rewritten. The existing Studio
explanation now applies to WFS without a frontend rebuild.

The connected local journey inspects both failed captures through full Studio,
reloads and inspects again using only GET requests. Neither failure publishes an
archive, candidate or review, and the current Layer stays unchanged. A subsequent
valid three-feature capture passes native processing and Studio acceptance, including
reader denial and reopening. [Receipt](../parity/reports/geolens-003-wfs-failure-history.json).

All 76 source-archiver checks pass. Reused Studio tree
`536571c6273dca125feb1650820c80163ee7d105ff1eb5fd7e010467e4c59c80`;
seven tiny feature-fixture requests and two native workers total, with containers
removed. Foundations, syntax, affected whitespace and evidence schemas pass.
Parity validation still reports shared fixture content-hash mismatches; no blanket
resealing. No AWS, external-provider, CI, app build or deployment calls.
Identity/provider/storage remain fixtures; full parity remains partial.

Next: complete the WFS schema-change review path with added/removed fields and
retained source metadata, verifying that Project references and pinned outputs
remain stable until deliberate acceptance. Reuse existing successful rendering and
Publication evidence for unchanged paths. Live-provider/deployed acceptance,
volume/accessibility and the separately blocked capture policy remain open.


## Multi-page WFS capture rejects numeric duplicate identities (September 23)

Fixed a production duplicate-detection gap: serializing numeric IDs treated `1` and
`1.0` (and `0`/`-0.0`) as different identities. Capture now compares numeric values
without converting strings or rounding IDs, while preserving source property values.
Regression cases reproduced the flaw before the change; the complete source-archiver
test file passes afterward.

The connected case rejects changing provider counts and a numeric-equivalent ID repeated
on page two. Neither failure creates a stored archive, candidate version or review; the
base remains current. A third capture requests two then one feature with exact offsets,
sort and CRS84 bounds, retains per-page response hashes/counts, and passes native
processing. Studio reviews one current versus three candidate features, denies a reader,
then accepts once for the owner and reopens the new version.
[Receipt](../parity/reports/geolens-003-wfs-multipage.json).

Seven tiny feature-fixture requests including the initial base, two native workers total,
and reused Studio tree `536571c6273dca125feb1650820c80163ee7d105ff1eb5fd7e010467e4c59c80`.
No app rebuild, Publication compilation, AWS/provider/CI or deployment calls; containers
removed. An initial runner request omitted required destination fields and was corrected
without changing the API contract. Failure creation/review setup uses the API; successful
acceptance uses full Studio. Identity/provider/storage remain fixtures, and failed-job
history is not exercised here. Counts do not prove provider snapshot consistency.
Full parity remains partial. Syntax, affected whitespace, evidence schemas and foundations
pass; parity validation still reports shared fixture content-hash mismatches. No blanket
evidence seal refresh.

Next: surface and verify multi-page failure history through Studio, distinguishing known
count contradictions from generic invalid responses where the retained error permits it.
Keep failed refreshes inspectable and retries deliberate. Reuse this build and earlier
positive rendering/Publication evidence; broader schema/geometry/volume/accessibility,
live-provider/deployed acceptance and the separately blocked capture policy remain open.

## WFS reuse preserves existing Projects and access boundaries (September 23)

The existing-Project dialog now has connected local acceptance for a WFS Layer in a
second access workspace. Destination-viewer and source-sharing refusals each return 403;
subsequent Project reads retain the original version/definition and the preview remains
available. Authorized reuse links the same dataset once and updates the existing Project
once. The prior Layer, view, basemap, style/opacity and other definition settings remain
exactly unchanged except the appended Layer occurrence and active selection. Actual
MapLibre renders the WFS point before and after reopening. The same Layer also remains
in the separately saved new Project. [Receipt](../parity/reports/geolens-003-wfs-reuse.json).

Reused Studio tree
`536571c6273dca125feb1650820c80163ee7d105ff1eb5fd7e010467e4c59c80`;
no rebuild, capture/native processing, Publication build or external-service calls.
The PostgreSQL container was removed. Target Project and limited actors are fixture setup;
one token substitution per denied request exercises real authorization, not a deployed
session or role-revocation journey. The existing hidden Layer is preserved, not rendered.
The provider point and blank basemap are local fixtures. Full parity remains partial.
Syntax, affected whitespace, evidence schemas and foundations pass. Parity validation
still reports shared fixture content-hash mismatches; no blanket seal refresh.

Next: close multi-page WFS capture gaps with bounded sorted responses, count changes and
repeated identifiers, preserving the usable Layer when retrieval is inconsistent. Reuse
the existing Studio/build and positive rendering/Publication evidence for unchanged paths.
Broader schema/geometry/volume/accessibility, live-provider/deployed acceptance and the
separately blocked capture policy remain open.

## WFS catalog inspection now renders and saves a reference (September 23)

Fixed a production gap: the catalog's live-preview and Project-save path admitted only
ArcGIS sources even though Workbench supported WFS. Authorized WFS connections now
expose a WFS service descriptor and reuse the existing bounded feature reader. Preview
requests one CRS84 page using reviewed attributes, geometry and sort; missing extents use
world bounds and the UI always labels the sample incomplete. Saved views retain Layer
identity, source revision and configuration. No upload, capture or implicit Project is
created by previewing.

The connected sealed Studio journey renders a WFS point in a temporary catalog map,
cancels Save without writes, explicitly creates one Project, and renders the same feature
in the real Workbench before/after reload. Preview screenshot inspected locally. Source
registration and metadata preservation remain in the same journey; no capture jobs.
[Receipt](../parity/reports/geolens-003-wfs-preview.json).

Focused browser-library/catalog tests and API catalog tests pass. One Studio build passed,
retained as tree `536571c6273dca125feb1650820c80163ee7d105ff1eb5fd7e010467e4c59c80`.
The first browser run needed explicit selection of the catalog's layer presentation view;
the corrected runner uses the visible controls. No second build. PostgreSQL cleaned up;
no external provider, AWS, CI or deployment calls. Identity/provider responses are local
fixtures; a blank basemap isolates actual MapLibre feature rendering. One point and new
Project destination do not establish all geometry, existing-Project or deployed behavior.
Full parity remains partial. Evidence schemas, affected whitespace and foundations pass;
parity validation still reports shared fixture content-hash mismatches. No blanket seal
refresh was performed.

Next: exercise deliberate reuse of the WFS Layer in an existing Project, retaining its
other Layers/configuration and testing current edit/source-access refusal. Reuse this
build; do not repeat native capture or Publication compilation for unchanged paths.
Multi-page capture, broader schemas/geometry/volume/accessibility, live-provider/deployed
acceptance and the separately blocked capture policy remain open.

## WFS protected copy and reviewed refresh through Studio (September 23)

The registered WFS source now continues through the protected-copy dialog, actual native
processing, Layer refresh estimate/start, working/provider count review, reader denial,
owner acceptance and reload. Both bounded GetFeature requests retain the qualified type,
selected attributes and geometry, explicit stable sort, CRS84 bounds, COUNT 2 and offset 0.
Retained evidence records numberMatched/numberReturned/fetchedCount as 1 and leaves the
independent count query absent. The base stays current until deliberate acceptance; one
acceptance record promotes the candidate. [Receipt](../parity/reports/geolens-003-wfs-capture.json).

Reused Studio tree
`4fa828c4fddc36a3582aa2789eb0b726c0d8bf755994dcd3605e3f8ecf57d085`.
Two XML documents and two tiny feature pages, two native jobs, zero app/Publication builds
or AWS/provider/CI/deployment calls; all containers removed. The first attempt exposed an
ArcGIS-specific selector in the acceptance runner; it now respects the existing WFS 1000
page-size limit. Product behavior is unchanged. Identity/storage/provider responses are
synthetic. The receipt's legacy top-level component-browser scope is conservative;
individual browser phases record the actual sealed Studio routes. Reader denial uses a
fixture-token substitution. Single-page provider counts are not completeness guarantees.
Full parity remains partial; rendering is not claimed by this WFS case.
Syntax, affected whitespace, evidence schemas and foundations pass. Parity validation
still fails shared fixture content-hash mismatches; no blanket evidence seal refresh.

Next: exercise catalog-only WFS map inspection and deliberate Project reuse with bounded
local provider responses, checking visible features and no implicit Project creation or
capture. Reuse this build and existing capture/Publication evidence. Multi-page WFS and
broader schema/geometry/volume/accessibility, live-provider/deployed acceptance, and the
separately blocked capture policy remain open.

## WFS discovery and preserved schema through Studio (September 23)

The sealed Studio flow now has connected local evidence for WFS GetCapabilities →
DescribeFeatureType → reviewed registration → exact schema download → metadata curation
and reopening. Selected fields exclude the separate geometry property; the confirmed
stable-sort field and qualified type name persist. Missing rights/attribution confirmation
does not register the source. The downloaded schema matches the original fixture bytes;
curated title and unknown license persist separately without modifying source, normalized
or inferred assertions. [Receipt](../parity/reports/geolens-003-wfs-discovery.json).

Reused Studio tree
`4fa828c4fddc36a3582aa2789eb0b726c0d8bf755994dcd3605e3f8ecf57d085`.
Exactly two bounded local XML requests, zero capture jobs, no app rebuild, external
provider, AWS, CI or deployment calls. PostgreSQL container removed. An initial fixture
mistake read query parameters from the URL rather than the fetcher's separate argument;
the corrected transport now checks exact WFS parameters. Production behavior is unchanged.
Identity and provider transport remain synthetic. This proves retained selected-schema
handling, not arbitrary WFS schema support, feature rendering, or catalog-to-source
metadata linkage. Full parity remains partial.
Syntax, affected whitespace, evidence schemas and foundations pass. Parity validation
still fails shared fixture content-hash mismatches; no blanket evidence seal refresh.

Next: connect the registered WFS source to bounded protected-copy processing and refresh
review, checking numberMatched/numberReturned, explicit sort and capture bounds. Reuse
the established Artifact/Publication evidence for unchanged code instead of rebuilding
it. Preserve unknown provider facts; broader schema/document handling, geometry/volume/
accessibility, live provider/deployment and the separately blocked capture policy remain.

## Full Layer route preserves Project and Publication pins (September 23)

The sealed Studio Layer route now participates in the connected Artifact/Publication
journey: inspect source, review estimate, confirm rights/limits, start refresh, inspect
candidate counts, acknowledge review, accept and reopen. A reader acceptance request
is denied by the real API/database; the UI reports lost update access and reopening
retains the base. Owner acceptance succeeds once and reopening shows the candidate.
Review/acceptance starts no new capture or build. Earlier Project geometry and Style v1
remain pinned; the retained Publication still renders both Layers and the polygon hole
at desktop/narrow widths after Layer acceptance and Style v2. Exactly one Publication
build. [Receipt](../parity/reports/geolens-003-layer-publication-route.json).

The local journey reused Studio tree
`4fa828c4fddc36a3582aa2789eb0b726c0d8bf755994dcd3605e3f8ecf57d085`;
two tiny native capture jobs, four provider-fixture requests, no app rebuild or external
services. Containers and temporary output were removed. Initial source/capture and
Style/composition setup still use API/repositories. Reader denial substitutes a fixture
viewer token on one request; this is not deployed login or role-revocation acceptance.
Provider, identity and object transports remain synthetic. Full parity remains partial.
Syntax, affected whitespace, evidence schemas and foundations pass. Parity validation
still fails shared fixture content-hash mismatches; no blanket evidence seal refresh.

Next: connect WFS catalog discovery → schema inspection → deliberate stable-sort/rights
review → source registration → preserved document/metadata reopening through Studio.
Use bounded local XML fixtures and the retained build first; reuse the existing capture/
Publication evidence for unchanged code. Broader geometry/volume/accessibility, live
provider/deployed acceptance and the separately blocked capture policy remain open.

## Workbench downloads register through Studio controls (September 23)

The connected local journey now carries actual Workbench HTML/manifest downloads through
Resources → Project Artifact editions. The browser sends one multipart upload, completes
and registers the received bytes through the production API, deliberately selects current
edition 1, and reopens revision 2. Registration starts no build. The existing routed
Publication journey consumes that edition, builds once, and retains earlier polygon/hole
geometry and Style v1 after Layer acceptance and Style v2. Both Layer controls work at
1100px and 390px; reopening creates no second build.
[Receipt](../parity/reports/geolens-003-artifact-upload-ui.json).

Reused sealed Studio tree
`4fa828c4fddc36a3582aa2789eb0b726c0d8bf755994dcd3605e3f8ecf57d085`.
Two setup defects were corrected: the synthetic S3 multipart endpoint belongs outside
the API body-limit middleware, and compiler verification must read the registered object
identity rather than a variable from the former repository-only path. Application limits
and authorization remain unchanged. The successful run used two tiny capture jobs, four
fixture queries and one Publication build; all containers and temporary output removed.
No app rebuild, AWS/provider/CI calls or deployment. Identity/provider/storage remain
synthetic; actual multipart bytes are verified against the production intent. Style setup
uses repositories and Layer review still uses a component browser. Full parity is partial.
Syntax, affected whitespace and foundations checks pass. Parity validation still fails
shared fixture content-hash mismatches; no blanket evidence seal refresh.

Next: move Layer candidate review/acceptance into the sealed Studio route within this
same retained-Artifact journey, including reload and denied reader acceptance. Reuse this
build and prior evidence. Broader WFS/ArcGIS discovery/document handling, geometry/volume/
accessibility, deployed acceptance and the separately blocked capture policy remain open.

## Captured Layers render and export through Workbench (September 23)

The connected UI exposed and fixed a production reader mismatch: the archiver writes
`opengeo:capture` count/provenance metadata, but the managed GeoJSON reader rejected that
root member after a valid authorized download. Managed reads now retain that bounded
metadata, including unknown provider fields, alongside exact geometry. They still verify
object checksum, feature inventory and geometry, reject unsafe nested values, and reject
capture records whose schema or fetched count does not match. Public archive contracts
remain unchanged unless this managed-read option is explicitly selected.

The sealed Studio Workbench now opens the saved composition, reads the original through
the normal authorized download, resolves pinned Style v1, and exports both HTML and its
manifest through the real dialog. The exact downloaded bytes are registered through
production repositories and consumed through Studio Publication controls. After Layer
acceptance and Style v2, the Publication retains earlier geometry and paint at desktop
and narrow widths; both Layer controls work. One Publication build; reopening reuses it.
[Receipt](../parity/reports/geolens-003-workbench-export.json).

Initial transport attempts lacked the original-download method and complete ticket
shape; those fixture gaps were corrected without weakening the application checks.
The subsequent real reader bug has focused passing regressions. One affected Studio
build passed and is retained as tree
`4fa828c4fddc36a3582aa2789eb0b726c0d8bf755994dcd3605e3f8ecf57d085`.
Foundations pass; parity validation still reports shared fixture hash mismatches.
No AWS/provider/CI or deployment calls; local containers and temporary output removed.

Registration in this case uses production repositories rather than upload UI. Setup and
Style updates use repositories; Layer review uses component browser; identity, storage
and provider transports remain synthetic. Parity remains partial.

Next: drive the existing Artifact upload/register controls with these Workbench downloads
through the same API/object transport, then reuse the verified Publication path. Preserve
this build and earlier evidence; do not repeat unaffected native/peer checks. Broader
provider/geometry/volume/accessibility and deployed acceptance remain open.

## Persisted Style and two-Layer Publication retention (September 23)

The connected local case now persists a reusable MapLibre Style and a composition
containing two distinct Layer identities: the referenced source and its captured copy.
The compiled Artifact records Style version 1 and its checksum. After Layer refresh
acceptance and creation of Style version 2, database resolution still returns the exact
version-1 definition. The retained Publication renders the earlier red polygon and hole
at desktop/narrow widths; both Layer controls work. Studio directory reopening creates
no second build. [Receipt](../parity/reports/geolens-003-publication-style.json).

Style creation and composition setup use production repositories with runtime-role
access checks. Compilation invokes the production browser Style resolver, inspector and
compiler with the retained database bytes, outside the Workbench dialog. Publication
selection/build/reopen uses the sealed Studio directory and route. The earlier local
dialog receipt and this connected result remain separate evidence, not a claim that
the full Workbench export UI has been exercised through persistence.

Reused Studio tree `a488e4d746ed1ac3c96887d808f86dafdd7576f956e87e3e35c029eeea4840a5`;
no app rebuild, AWS/provider/CI or deployment calls. Two tiny capture jobs and one
Publication build; all local containers and temporary output removed. Synthetic
identity/transports and local compiler sandbox remain explicit; parity stays partial.

Next: exercise the Workbench export dialog against the persisted Style and captured
Layer through its normal API/data transport, then reuse the same Artifact registration
and Publication path. Do not repeat unchanged compiler, native-worker or peer checks.
Broader provider/geometry/volume/accessibility and deployed acceptance remain required.

## Portable export now supports pinned Styles (September 23)

Inspection found a real integration gap: Workbench rejected every portable export
containing a reusable Style. It now allows selected Layers whose resolved Style
identity/version/checksum and displayed paints match. Missing or mismatched Styles
remain visibly unavailable; supported other Layers can still be selected.
The Artifact manifest retains selected Style references and unknown rights separately,
and its input checksum includes those dependencies. Export consent covers styling.
This is browser snapshot provenance, not server attestation or authorization.

Focused export/Style tests and an actual dialog with real MapLibre pass: two Layers,
exact pinned reference, rejection after displayed paint changes, and retained earlier
color in the sandboxed exported viewer. [Evidence](referenced-style-export-local-evidence.json).
Style storage in this browser case is synthetic; connected database/Publication
acceptance for the new feature remains next. Existing earlier receipts remain scoped
to their unchanged inputs.

One affected Studio build passed and is retained locally with tree
`a488e4d746ed1ac3c96887d808f86dafdd7576f956e87e3e35c029eeea4840a5`.
Foundations pass; parity validation still reports shared fixture content-hash mismatches.
No blanket hash refresh, cloud/provider/CI calls or deployment. Browser launch required
local process-sandbox escalation; its external requests remained blocked.

Next: use this retained build to carry a real persisted pinned Style and multi-Layer
composition through Artifact registration, Publication selection/build and reopen after
Style/Layer changes. Preserve one-build reuse and record the database authorization
boundary; do not substitute the component result for that connected acceptance.

## Publications directory and polygon retention (September 23)

The connected local journey now starts and returns through the sealed Studio
Publications directory. A captured polygon with a hole becomes a retained Artifact,
selected and saved in the Publication, then compiled once. After reviewing and accepting
changed Layer geometry, the earlier Publication reopens from the directory without a
second build. Its exact earlier rings remain intact; browser rendering shows the filled
area and an empty hole at 1100px and 390px. Layer toggle/reset work and frozen inputs
and output bytes remain unchanged. [Receipt](../parity/reports/geolens-003-publication-polygon.json).

The initial fixture used calculated coordinates with floating-point tails; it now uses
explicit decimal coordinates matching intended values. No production geometry handling
was changed. Cached Studio build and native worker reused; no AWS/provider/CI requests
or app rebuild. All local containers and temporary output removed.

Scope remains local: synthetic identity/provider/storage, component Layer review,
local compiler sandbox adapter and software WebGL Chromium. This adds polygon-hole
and directory evidence, not general geometry, volume, accessibility or deployment
acceptance. The parity row remains partial.

Next: cover representative multi-Layer composition and retained Style use in this
same connected Publication workflow; use one shared Artifact and one Publication build.
Broader provider completeness, Z/M interoperability, volume/accessibility and deployed
acceptance remain required. Batch the verified Demo and Studio work for an authorized release.

## Routed Studio Publication retains its Artifact after refresh (September 23)

The unchanged sealed Studio Publication route now passes the connected local journey:
open by Publication identity, select a retained Artifact, save and reload its pinned
selection, build once, open preview, accept changed Layer geometry, and reopen the
same Publication preview without a second build. The Files editor reads exact retained
source bytes; all application API requests succeed. The earlier map renders at desktop
and narrow widths. [Receipt](../parity/reports/geolens-003-publication-routed.json).

The runner reuses the sealed build and verifies its tree. Initial attempts exposed
fixture-only gaps: an invalid synthetic session format and missing source-download
transport. Both are corrected; production authentication and storage code are unchanged.
The earlier source-transport diagnostic remains locally archived. Optional external
font requests are blocked and recorded. No cloud/provider/CI calls or app rebuild;
containers and temporary output removed.

This closes the local routed Publication selection/build/reopen step. Layer acceptance
still uses its component browser, identity and transports are synthetic, and the compiler
sandbox is a local adapter. Broader geometry, provider and deployed gates remain open;
the aggregate parity row stays partial.

Next: extend this same connected route to entry from the Publications directory and
representative non-Point data; preserve exact retained outputs and one-build reuse.
Batch the verified demo catalog and Studio changes for the next authorized release.

## Publication authoring checkpoint and demo catalog handoff (September 23)

Built Studio Publication panels now select a retained captured-data Artifact, save
its pinned inputs, compile once and reopen the same preview after changed Layer
geometry is accepted. Frozen inputs and output bytes remain unchanged; reopening
creates no build. Real MapLibre renders the earlier Point at desktop and narrow widths.
[Connected receipt](../parity/reports/geolens-003-publication-authoring.json).

Reused the sealed Studio build; no new app build, AWS/provider requests or CI runs.
Local containers and temporary output were removed. The first attempt selected an
older app/dist without the chooser; its diagnostic is retained locally. This is built
panels in a harness with synthetic identity/transport, not full routed or deployed
Studio acceptance. The aggregate parity row remains partial.

The requested Demo New Project → searchable catalog → Review and add → map flow is
already implemented and exercised in the local built Demo. It clears stale search,
keeps the new Project selected, reviews metadata and fits the added Layer. Catalog
and source records remain reusable within browser storage limits.
[Demo receipt](demo-catalog-toolbar-local-evidence.json). This is not deployed.

Next: carry the locally verified demo catalog flow into the next authorized, batched
release; retain existing build evidence. For Publication parity, connect the same
selection/reopen journey through full routed Studio, then address remaining provider,
geometry, volume/accessibility and deployed acceptance without repeating unchanged checks.

## Retained Publication map renders earlier data after refresh (September 23)

Real bundled MapLibre renders the earlier captured Point in the retained Publication
iframe after accepting changed Layer geometry. At 1100px and 390px, rendered feature
coordinates match the earlier data and exclude the changed coordinates; layer toggle
and reset controls work, reset remains in view, and the page has no horizontal overflow.
No external requests or browser errors. Frozen inputs/output remain unchanged and only
one Publication build runs. [Receipt](../parity/reports/geolens-003-publication-browser.json).

The fixture now supplies the saved map camera and responsive iframe dimensions.
Runtime observation retains real rendering methods. Software WebGL/Chromium, one Point,
synthetic transport/identity and local compiler sandbox limits remain explicit. All
containers and temporary output removed; no AWS/provider/CI or deployment calls.

Next: complete the integrated Studio authoring path with the same real captured-data
Artifact: select it in a Publication, prepare pinned inputs, build and open preview,
then return after Layer acceptance without reconstructing those selections. Reuse the
existing authoring/browser helpers and one affected Studio build if needed. Broader
provider, geometry, volume/accessibility and deployed requirements remain open.

## Captured Layer → portable Artifact → Publication remains pinned (September 23)

The local journey now compiles the actual earlier captured features with bundled
MapLibre into portable HTML, retains/registers that Artifact, prepares frozen Publication
inputs, and runs the real coordinator/builder. Publication output embeds the exact
Artifact bytes. After accepting changed Layer geometry, frozen inputs, build request
and embedded output remain unchanged. One Publication build runs; retry reuses it and
reads create no build jobs. [Receipt](../parity/reports/geolens-003-publication-consumer.json).

Two tiny captures, cached GIS workers, one portable compilation and one Publication
compilation; containers and temporary output removed. No AWS/provider/CI or deployment.
Synthetic object transport/identity and local builder sandbox adapter remain explicit.
Layer acceptance uses the component browser; Publication creation/reads use production
repositories. This is neither visual Publication rendering nor deployed acceptance.

Next: exercise the actual retained Publication map in a browser across Layer acceptance,
checking the displayed earlier geometry and narrow-screen controls without a second
Publication build. Reuse this connected fixture and compiler inputs. Integrated authoring
UI, broader provider/geometry/volume/accessibility and deployed gates remain open.

## Compiled image Artifact remains pinned across Layer acceptance (September 23)

One real image is compiled and registered before a connected Layer refresh. After
acceptance of changed geometry, explicit edition 1 and the selected current Artifact
retain the exact manifest/output checksum and identity. Reads create no render job.
[Receipt](../parity/reports/geolens-003-artifact-consumer.json), linked to the partial
GeoLens metadata-refresh row. Two tiny captures, one image compilation; all local
containers removed. Synthetic storage/provider/identity and component browser remain
explicit; Artifact operations use production repository methods rather than its UI.

An initial harness still requested a second compilation; the application correctly
reused the completed render. Its diagnostic is retained. The corrected journey reads
the existing edition and passes, with no cloud, CI, full app build or deployment.

Next: portable-HTML Artifact → Publication inputs/build → Layer refresh acceptance.
The supported Publication source-reference path currently accepts portable-map-html,
not saved-map-image. Reuse `portable_artifact_postgres_acceptance.py` and
`compile_portable_publication_fixture.mjs`, but replace their empty-feature fixture
with the captured Layer's actual earlier data; retain publication output bytes and
input checksums across acceptance. Image evidence does not close that remaining step.

## Provider mismatch preserves current Layer and explains failure (September 23)

Independent count disagreement now records `source_count_mismatch` rather than a
generic invalid-response failure. Refresh status/history explains that the provider
reported a different count, capture stopped, and the current Layer is unchanged.
The connected local failure journey proves saved failure state, unchanged current
version, no candidate or review, and read-only history inspection displaying that
explanation. [Receipt](../parity/reports/geolens-003-provider-mismatch.json).

One baseline GIS run and four tiny provider-fixture requests; database and worker
containers removed. Component browser and five focused count checks pass. An initial
harness assertion incorrectly expected processor success for the intentional failure;
its failed receipt is retained, corrected journey passes. No AWS/provider/CI, full app
build or deployment. Successful count and mismatch receipts now link to the parity row,
which remains partial with live-provider and broader coverage gaps explicit.

Next: audit Project Artifact and Publication consumption of refreshed Layer versions.
Reuse prior pinned-map evidence; connect a representative compiled consumer to immutable
version references and verify that explicit Layer acceptance cannot silently retarget
an existing artifact/publication. Preserve the remaining provider/geometry and deployed
gates rather than expanding isolated count checks without a new risk.

## ArcGIS independent scoped count integrated (September 23)

New ArcGIS copy estimates budget one count query plus feature pages within the existing
64-request cap. Migration 0146 preserves legacy page-only estimates and unchanged
permissions. The worker derives count filters from the same feature query, retains
response metadata/hash in the archive, and checks fetched rows against the lesser of
the reported count and approved feature cap. Invalid counts, errors and mismatches
refuse output; legacy missing counts remain unknown. A small hash-backed summary
keeps full response metadata out of the database completion-size budget.

78 capture/estimate tests pass. The real local API/database/capture/GIS/component
browser journey passed capture → review → acceptance → reopen using four requests
across two one-feature captures; all containers removed. The later compact-summary
adjustment has two focused passing checks and was not redundantly integrated again.
[Receipt](../parity/reports/geolens-003-provider-count.json). No AWS/provider/CI calls,
app build or deployment; synthetic provider/storage/identity remain explicit.

Next: extend connected acceptance to provider-count mismatch so a failed candidate
retains current data and reports its failure clearly. Then cover broader provider
paging/geometry and publication consumers. Provider counts are assertions at query
time, not a snapshot or proof of provider truth. Full parity and deployed gates remain open.

## Bounded pinned peer comparison consolidated (September 23)

The final admission case observes PostgreSQL blocking between two real transactions.
After the first commits, the second raises DatasetBusyError; its transaction remains
usable and exactly one pending run persists. [Race receipt](../parity/reports/geolens-003-runtime-race.json)
is linked as `geolens-003.peer-race`. This is database/service contention, not a pair
of concurrent HTTP requests. One case, zero skips, container removed; no worker,
provider, AWS or CI activity.

The bounded peer comparison now covers stored-source admission, actual worker staging
and replacement, count mismatch, schema approval, changed-content/replay refusal,
terminal SQL rollback and overlapping admission. Preserve all separate receipts and
substitutions; do not equate this with live-provider or full product parity.

Next: return to OpenGeo's independent provider-count gap. Inspect
`services/api/src/opengeo_api/source_archiver.py` and the connected refresh harness:
WFS page numberMatched evidence exists, while ArcGIS provider completeness needs a
bounded independent count with the exact same scope, explicit unknown/failure handling,
and preserved evidence through capture → processing → review. Use local provider
fixtures first, reuse the Studio artifact, and retain other row limits unchanged.

## Pinned peer approval consumption and changed contents (September 23)

A three-attempt local scenario verifies that changed source contents invalidate an
approved review fingerprint and produce a new blocked review, preserving original
data/version. Replaying the consumed approval returns 422 without dispatch. Approving
the new review installs exactly its changed contents; replay after success also returns
422 without dispatch. Exactly three durable run rows remain after both replay refusals.
[Receipt](../parity/reports/geolens-003-runtime-approval.json), linked as
`geolens-003.peer-approval`; the aggregate row remains partial.

Actual API, worker, GDAL and PostgreSQL execute with the existing bounded transport,
queue, DNS, cache and embedding substitutes. One case passes, zero skips; container
removed. No AWS/provider/CI, app build or deployment. Prior worker and rollback receipts
remain independently retained; this does not establish concurrent or cross-user cases.

Next: simultaneous admission at the real unique constraint, then consolidate the
bounded peer comparison and return to outstanding OpenGeo provider/geometry and
publication-consumer integration. Deployed identity/provider and pending administrator
policy remain separate gates. Avoid expanding peer checks beyond unresolved claims.

## Pinned peer terminal-write rollback verified (September 23)

A single local refresh now fails at the actual PostgreSQL terminal-success write,
after executing real worker replacement SQL. A test-only database trigger raises the
identified fault. The exception is observed; original rows, source binding and current
version remain unchanged, no new DatasetVersion survives, successful freshness stays
unset, and the durable run records failure without a version link.
[Receipt](../parity/reports/geolens-003-runtime-rollback.json), linked as
`geolens-003.peer-rollback` in the still-partial parity row.

One case, zero skips; the isolated container and its trigger were removed. This proves
rollback for this SQL failure, not process termination or network interruption.
Provider/queue/DNS/cache/embedding substitutions remain explicit. No AWS, provider,
CI, application build or deployment calls; the prior four-attempt result is retained.

Next: approval replay and changed-content acceptance boundaries, then simultaneous
admission coverage. Keep broader OpenGeo provider/geometry, publication-consumer,
deployed identity and administrator-policy requirements open. Reuse the cached peer
runtime; do not rerun successful cases without an affected boundary.

## Pinned peer schema approval and pending-admission conflict (September 23)

The four-attempt local GeoLens scenario passes real API/worker/database execution:
successful replacement, count-loss rejection, blocked destructive schema change, and
explicit approval installing the changed schema. A second request while the first
run is pending returns 409 without another dispatch. Accepted data/version survive
both rejection and blocked review. [Receipt](../parity/reports/geolens-003-runtime-worker.json)
and `geolens-003.peer-runtime` now link this evidence to the still-partial parity row.

This is sequential pending-run contention, not a simultaneous race. Provider fetch,
queue, DNS, caches and embeddings remain substituted. One fixture diagnostic retained
an inspection transaction and correctly hit the upstream DDL timeout; ending that
read before worker execution fixed the fixture without changing upstream behavior.
Zero skips, container removed; no AWS/provider/CI calls, app build or deployment.

Next: bounded database fault injection at terminal success to verify full replacement
rollback, followed by acceptance replay/changed-content and simultaneous-admission
coverage. Broader geometry, provider completeness, publication consumers, deployed
identity and administrator policy remain open; no aggregate completion claim.

## Pinned GeoLens worker replacement and count rejection (September 23)

The local peer case now executes actual GDAL conversion, worker staging and PostgreSQL
replacement. A two-feature refresh succeeds, links a version, increments the current
version and preserves source identity. A subsequent one-feature fetch against an
advertised count of two records `source_count_mismatch`; accepted contents and version
remain unchanged. [Receipt](../parity/reports/geolens-003-runtime-worker.json).

One case passed with zero skips. Provider fetching/paging, queue delivery, SSRF DNS,
cache invalidation and embedding dispatch are substitutes; worker verification, swap,
ORM and run finalization execute unchanged. No AWS/provider/CI calls or app rebuild.
Container removal verified. Two setup diagnostics preceded success: generated test DB
name and fixture primary-key naming; neither was an upstream application defect.

Source inspection also corrects the comparison: the peer swap drops its old table.
A retained version ledger does not prove retained historical data access. Preserve
OpenGeo's stronger immutable-version requirement without attributing it to the peer.

Next: extend this scenario with reviewed schema change and competing admission, then
forced transaction failure/rollback evidence. Broader geometry/provider, deployed and
aggregate parity remain open. Reuse cached dependencies and database image.

## Pinned GeoLens database admission verified (September 23)

The unmodified pinned service-refresh admission case passes on isolated PostgreSQL 18,
PostGIS 3.6 and pgvector: one test, zero skips. The real API persists a pending run
from the stored service binding and passes the same endpoint/layer identity to the
upstream mocked dispatch. [Receipt](../parity/reports/geolens-003-runtime-admission.json).
This is admission evidence only; dispatch and SSRF DNS validation are upstream mocks.

The cached peer database image is reusable. The runner waits for final database
initialization, routes both production and test connections through the isolated Unix
socket, rejects skipped tests and verifies container removal. Earlier startup/socket
and skipped attempts remain diagnostic failures, not acceptance. The successful case
used no AWS, live provider or CI calls; no application rebuild or deployment occurred.

Next: connect actual worker staging, replacement and terminal-run transactions to a
bounded local source fixture, including prior-version reads, count-loss/schema-change
outcomes and competing admission. Keep the full runtime comparison and aggregate
parity row open. Reuse the locked environment and database image.

## Isolated pinned GeoLens environment prepared (September 23)

The complete pinned backend (1,291 backend/license files) was extracted from one
13.2 MB public archive and each file checked against the pinned Git tree. The
upstream Dockerfile pins uv 0.11.32; that exact installer synced the unchanged uv.lock
into an isolated environment using wheels only. OpenGeo dependencies are unchanged.
Selected dependency versions match the lock and the actual refresh route, run-ledger
service and reupload worker modules import successfully with ephemeral test values.
[Environment receipt](../parity/reports/geolens-003-runtime-environment.json).

This is environment preparation, not runtime parity. Local Python is 3.14.6 versus
the Dockerfile's 3.14.7 (within the declared >=3.13 floor). No database migration,
queue delivery, swap transaction, AWS call, provider request or CI run occurred.
Package cache is about 602 MiB and is retained for reuse; no repeated dependency
resolution/build is needed. The first import correctly refused missing required
configuration; the successful check uses synthetic ephemeral values only.

Next: inspect the pinned migration/test database prerequisites, create one isolated
compatible PostgreSQL instance, and run the bounded real admission/staging/replacement
scenario in the runtime comparison contract. Reuse this environment and archive; do
not bypass upstream database requirements or replace transaction behavior with mocks.
All aggregate parity and deployed requirements remain open.

## Pinned GeoLens runtime inputs and execution boundary (September 23)

Twelve upstream files, including refresh admission, worker staging/replacement,
run models, upstream tests and dependency lock, are now retained unmodified at the
existing commit pin. SHA-256 and upstream Git blob identities pass offline verification.
[Runtime comparison contract](geolens-refresh-runtime-comparison.md) names the actual
transactions and observable outcomes required; the source audit is not execution.

The API interpreter lacks seven selected pinned runtime dependencies. No package
installation, container, build, provider/AWS call or CI run was started. Public source
retrieval used one GitHub tree read and twelve bounded file reads; subsequent checks
are offline. The full source dependency closure remains unfinished. Existing Studio
acceptance stays valid for its exact build and need not be repeated.

Next: inspect cached runtime environments, complete the pinned backend source closure,
and prepare an isolated locked peer environment. Then execute the bounded real
admission/staging/replacement scenario in the contract. Never replace these boundaries
with mocks merely to obtain a passing report. Keep all aggregate parity gaps open.

## Retained discovery metadata and separate curation reopen (September 23)

The built Layer page now has connected acceptance for inspecting and downloading
its linked discovery response: downloaded byte length and SHA-256 match the exact
original fixture document. A curated title and explicitly unknown license save and
reopen unchanged. Retained discovery data, source/normalized/inferred metadata remain
unchanged by curation. [Receipt](../parity/reports/geolens-003-discovery-knowledge.json).

Two bounded local ArcGIS metadata documents; real discovery processor/API/PostgreSQL
and unchanged Studio build. No capture/GIS jobs, rebuild, provider/AWS/CI calls.
Database container removed. This verifies the bounded UTF-8 fixture, not broader
providers or arbitrary documents. No deployment or full-parity claim.

Next: move to the pinned GeoLens service/worker comparison beyond its already verified
pure decision function. Inspect the pinned runtime and choose a bounded offline
service-to-worker scenario covering staged replacement and retained prior reads.
Keep independent provider completeness, broader geometry/volume/accessibility,
publication consumers, deployed identity/provider acceptance and pending administrator
policy open. Avoid repeating the completed local Studio journeys without a new risk.

## Discovery-to-refresh journey and registration fix (September 23)

Automated ArcGIS discovery now passes the complete local built-Studio path: Find
available layers → inspect → prepopulated title/fields with blank rights → reviewed
registration → confirmed initial copy → native processing → refresh acceptance/reopen.
The real discovery engine and database coordinator consume two bounded local metadata
documents. [Receipt](../parity/reports/geolens-003-discovery-studio.json).

This exposed and fixed a production registration failure: FOR SHARE required UPDATE
on discovery jobs, intentionally unavailable to the API role. Completed jobs are
immutable under the existing transition trigger, so their exact binding uses an
ordinary tenant-scoped read. No grants, policies or migrations changed. Two diagnostic
failures are retained locally; both cleaned up. Seven API tests and the corrected
integrated journey pass. The existing Studio build was reused; two one-feature captures,
no AWS/provider/CI calls, all containers removed. Foundations pass; shared parity
fixture checksum mismatches remain. Not deployed and not full parity.

Next: verify retained discovery-document reopening and unknown/curated separation
within this connected fixture, then address the pinned GeoLens service/worker comparison.
Broader providers/WFS, geometry/volume/accessibility, publication consumers, deployed
identity/provider acceptance and pending administrator-only capture policy remain open.
Do not count the local metadata transport as independent provider evidence.

## Initial protected copy through Studio (September 23)

The existing sealed Studio build now passes registration → initial protected-copy
dialog → actual native processing → refresh review/acceptance/reopen. Registration
and estimate alone create no capture. An attempted submission without confirmations
creates no job; supplying the rights basis and accepting rights/request/byte/cost
limits queues exactly one job with the selected bounds, feature/page limits and
attribution. [Receipt](../parity/reports/geolens-003-initial-copy-studio.json).

Two one-feature local captures, real API/PostgreSQL/archiver/GIS worker, synthetic
identity/provider/storage; all temporary containers removed. No rebuild, provider,
AWS or CI calls. This closes the initial-dialog gap only; no deployment or full-parity
claim. Automated discovery and prepopulated provider metadata remain separate.

Next: extend this existing fixture with SourceDiscoveryProcessor and its database
coordinator, using bounded local metadata documents. Drive Find available layers,
select/inspect one result, review prepopulated fields and terms, then reuse the existing
registration/copy path. Retain explicit unknown rights and originals. Peer runtime,
provider completeness, broader geometry/volume/accessibility, deployment and pending
administrator-policy requirements remain open.

## Built Studio reviewed-source registration (September 23)

The local integrated journey now starts with Studio's Create first map, Add data and
manual reviewed ArcGIS registration. Exact endpoint, field identity and attribution
reach persistent source storage; registration does not start a copy. The same source
continues through actual capture/native processing and built refresh review,
acceptance and reopening. [Receipt](../parity/reports/geolens-003-registration-studio.json).

The first attempt found a missing fixture map and stopped before registration; its
failed receipt and cleanup remain recorded locally. The corrected journey creates
the map through the actual UI. Existing sealed build reused, two one-feature captures,
no AWS/provider/CI calls; temporary containers removed. This is not automated source
discovery or initial copy-dialog acceptance: the first copy remains API setup. No
deployment and no full-parity claim; historical fixture checksum gaps remain open.

Next: connect the initial protected-copy dialog to this existing journey and native
processing, preserving the explicit rights/scope/cost decision. Then cover automated
service discovery through its actual worker and prepopulated review. Keep the separate
pinned peer-runtime, provider completeness, broader geometry/volume/accessibility,
deployed identity and administrator-policy requirements open.

## Built working-count review and accepted refresh (September 23)

The unchanged Studio build now passes the successful connected refresh journey:
actual source captures and native processing retain independently inspected input and
working counts; both base/candidate show 1/1 in review with count-equivalence limits.
Reload before acceptance retains the base. Explicit acknowledgement/acceptance moves
the candidate current once, and reopening shows it as current without another staged
candidate. [Receipt](../parity/reports/geolens-003-counts-studio.json).

Two one-feature fixtures; real API/PostgreSQL/archiver/GIS worker and built browser,
local provider/storage/identity substitutes. Containers removed. No rebuild, AWS,
provider or CI call; no deployment. Existing broad parity checksum gaps remain.
The comparison table no longer lists the implemented count check as missing.

Next integrated gap: initial upstream source registration through the full Studio
shell, then its existing capture/review workflow. Reuse this sealed build if unchanged
and extend the existing bounded fixture rather than adding another test framework.
Pinned GeoLens service/worker execution, independent provider completeness, broader
geometry/volume/accessibility, deployed identity acceptance and the pending admin
policy decision remain separate open requirements. Keep the parity row partial.

## Built Studio refresh failure recovery (September 23)

Capture history now offers a deliberate processing-status check for each completed
capture, so returning to the Layer can recover status without starting another job.
A bounded local built-Studio journey starts a real source capture, injects actual
working-file count loss, and reopens the failure before and after page reload. The
UI distinguishes capture completion from processing failure, disables the failed
candidate and offers no acceptance. The base stays current; no derivative output is
published. History inspection makes GET requests only.

[Receipt](../parity/reports/geolens-003-failure-studio.json): two one-feature captures,
actual native workers/API/PostgreSQL, synthetic provider/storage/identity; container
cleanup verified. Focused component check, one updated build and verifier pass.
Foundations pass; broad parity still reports shared fixture checksum mismatches.
No deployment, AWS/provider calls or CI runs. The earlier build remains historical;
this build adds the history action needed for recovery.

Next: reuse this build for successful working-count review/accept/reopen evidence;
continue the remaining parity acceptance requirements. This failure slice does not
establish full refresh or application parity.

## Refresh processing status and working counts (September 23)

Manual Check source refresh now distinguishes a completed capture from failed,
queued or active processing by matching its exact output version in a bounded
version listing. Missing or incompatible version bindings remain unestablished.
No polling, capture, processing or promotion is started by this status check.
Refresh review exposes retained per-layer input/working-file counts separately,
including missing knowledge and the limits of count equality. Provider query totals
remain distinct from inspected input counts.

Focused DOM checks pass for explicit reads, failure, active/queued status, disposal,
zero counts, unknown counts and unchanged review acknowledgement. One isolated Studio
build and build verifier pass. [Local receipt](refresh-processing-status-local-evidence.json).
No deployment, provider, paid runtime or CI calls. Existing parity fixture hash
mismatches remain unresolved; these checks do not establish full parity.

Next: connect the built failure-status and count-review display to the retained
real-worker/API acceptance fixture, reusing the build. Continue the tracked parity
requirements; do not infer completion from the refresh sequence or local checks.

## MapServer contour archive enabled; one shared NSDI display remains (September 23)

The distinct MapServer contour capture now has an enabled private display on its
existing Layer. All 212,935 spatial identities and target attributes are retained;
nine nonspatial records remain in the exact original. Reuse preserves every parent
MVT geometry command and tile extent, with an independently measured additional
capture-curve displacement bound below 0.001 metre. Parent quantization and explicit
overview generalization remain applicable. This is not original-coordinate equality.

All 45,490 packed tiles match staging. The built Studio selector rendered all 37
fine records across 38 component probes, tested visibility/style changes, explicit
archive choice and return/reopen behavior, and read zero archive bytes before user
action. Its local transport used 65 range requests and 17,941,271 bytes. Fourteen
private objects plus the manifest were preserved (327,623,918 uploaded bytes).
Production runtime checks verify Aaron and Categorise can discover the archive and
retain its initially-off membership in the same Bhutan map. Unchanged deployed
viewer hashes were reused; no application build, deployment, original overwrite or
grant change was needed. Hosted signed-in browser acceptance remains open.
[Completion evidence](mapserver-contour-display-20260923-evidence.json).

The NSDI queue now contains two source URLs sharing one 50k land-cover original.
The full native profile is complete. The GDAL conversion terminated at its 1,800 CPU
second bound. The alternative Tippecanoe run reported an 8,506,655-byte overview tile,
above the 8 MiB reader limit, and was deliberately terminated to avoid further wasted
work. Its terminal receipt is retained; no conversion or transfer from this turn
remains running. Next use a bounded overview/detail path and test representative
large geometries before another full conversion. Do not repeat either unchanged
attempt or raise display limits merely to admit the output. The full ingestion goal
still requires the remaining display work and its completion audit.

The operator source reader now permits an explicit 64–512 MiB individual-value
review bound for these exceptional originals; its default remains 64 MiB. This does
not change browser/API limits. Default-limit rejection, explicit larger parsing and
invalid overrides were checked. The contour admission gate accepts the bound reuse
chain and rejects changed original identity, curve evidence and target counts.


## Demo catalog access from a new Project (September 23)

The latest user request takes priority over the queued refresh-status follow-up.
Existing new-Project behavior opens the searchable Layer catalog, clears the previous
composition, and reviews source metadata before adding a selected Layer. A visible
Catalog toolbar action now also returns to that picker from a populated Demo Project
without navigation or clearing its Layers. Local source registration remains separate.

One bundled Demo build and focused public-demo/catalog-store checks pass; foundations
pass. The full parity gate reports fixture content-hash mismatches across the shared
worktree; evidence hashes have not been refreshed to mask those differences. The local
built browser journey passes catalog selection, toolbar return without Project loss,
metadata review, actual rendering and save/reopen.
[Receipt](demo-catalog-toolbar-local-evidence.json). No deployment, provider, AWS or CI
run is part of this increment. Demo daily-reset/storage limits continue to apply.

Next: bundle the verified Demo artifact into the
next authorized release. Resume working-count/processing-status UI afterwards; the
full parity target remains open.

## Working-count loss stops durable ingestion (September 23)

A browser-started source refresh now passes the actual worker/database failure path:
the fixture replaces its converted working Parquet with a real empty Parquet, then
the normal inspector independently reads zero rows against one source feature. The
candidate fails with `working_feature_count_mismatch`, its current base remains active,
and no working/display artifact upload or completed derivative record is produced.
The failed version retains its original capture; API review creation is denied and
no refresh review is inserted. [Receipt](../parity/reports/geolens-003-working-loss.json).

Two one-feature source fixtures, cached native workers and real PostgreSQL; all
containers removed. No cloud/provider/CI calls, application build or permission change.
The fault exists only in the explicit local test runner. Native GDAL count inspection
and worker/database failure finalization run unchanged. Broader geometry/multi-layer
failure and deployed acceptance remain separate.

Next: expose successful working-count evidence clearly in refresh review and surface
processing failure distinctly from successful source capture, reusing the existing
manual status controls. Keep full parity targets and remaining independent/runtime
comparison requirements open; this receipt closes only the scoped loss-safety check.

## Independently checked working-file counts (September 23)

Each working Parquet now receives one bounded read-only `ogrinfo` inspection after
conversion and before its artifact is returned. Known input/output count mismatches
raise `working_feature_count_mismatch`; missing/invalid counts remain explicitly
unavailable rather than becoming zero or an invented match. Malformed or ambiguous
working metadata fails safely. Per-layer evidence and an aggregate quality check are
retained; count checks do not claim feature identity or geometry equivalence.
[Evidence](../parity/reports/geolens-003-working-counts.json).

Thirteen focused cases and lint pass. Two native XYM/XYZM one-point conversions retain
M/Z and match independently reopened counts. The extra inspection took 0.117 and
0.115 seconds respectively, one local metadata command per file. This is not a large
file latency estimate. No cloud/provider/CI calls or frontend build; the cached native
container used automatic removal. Final formatting/equivalent aggregation cleanup
was followed by focused tests/lint without repeating unchanged native processing.

Next: inject actual working-output count loss into the local worker journey and verify
that failed candidates never become current or expose completed derivative records.
Then inspect the new count evidence through existing refresh review. Full parity,
broader volume/geometry and deployed acceptance remain open.

## Refresh comparison consolidated; derivative counts next (September 23)

Eight offline cases now compare OpenGeo's current retained-record decisions with the
unchanged pinned GeoLens refresh function. Missing/extra counts are rejected; unknown
counts, empty replacements and destructive field changes need review. OpenGeo also
flags declared dimension changes. Source hashes and Git blob IDs are verified before
executing the peer. [Comparison](../parity/reports/geolens-003-current-comparison.json).

The comparison document no longer describes catalog bbox filtering or managed refresh
as absent. Historical receipts remain unchanged; current connected evidence and limits
are linked explicitly. No build, container, provider, AWS or CI run was needed.

Next implementation: independently inspect feature counts in working derivatives.
`DatasetInspector` currently totals input-layer counts before conversion; its working
artifact check establishes file existence/size, not post-conversion completeness.
Compare known counts per layer, fail safely on loss, and retain explicit unknowns
without inventing totals. Use bounded native fixtures and measure the additional
inspection work. Then reconnect the result to existing refresh evidence. GeoLens full
service/worker comparison and all other tracked acceptance gaps remain open; parity
is not complete.

## Measured-version download through built Studio (September 23)

The sealed Studio Layer page now passes inspection of the actual processed measured
version, readable compatibility/display-loss warnings, reload and exact working-file
download. Browsing/reopening makes no signing or storage requests. Preparing the link
uses the normal authorized API without fetching bytes; choosing Download retrieves one
working object whose browser-observed SHA-256 matches the reopened catalog record.
[Receipt](../parity/reports/geolens-003-measured-studio.json).

The first run exposed quality messages being discarded by the API client. The parser
now preserves messages, nested evidence and scan provenance without aliasing the source
payload; two focused checks pass. One corrected Studio build/verifier passes.
The journey serves that corrected build unchanged and runs one measured fixture
through actual PostgreSQL and GIS-worker finalization. Initial upload setup is through
the API; identity/storage delivery are local substitutes, external fonts are blocked.
No browser errors or cloud/provider/CI calls; all containers removed. This
is built-interface local acceptance, not deployed login/S3 or broad reader parity.

After this journey passed, the shared `--browser` flag invoked an unrelated style
journey and failed on duplicate fixture membership. The receipt retains successful
measured-browser assertions and cleanup, but the overall command exited 1. The runner
now uses `--measured-browser`; this flag-only correction was not replayed. The next
needed integrated run should use that dedicated flag, not repeat native processing
merely to replace the successful journey evidence.

Next: consolidate the pinned GeoLens metadata-refresh comparison against these
connected receipts, then select the remaining substantive parity gap. Broader geometry,
reader compatibility, full-shell initial registration and deployed acceptance remain
open. The administrator-only permission proposal remains pending separately.

## Measured version persistence and exact working download (September 23)

A retained 98,304-byte Point ZM GeoPackage now passes normal upload/completion APIs,
the actual GIS worker and PostgreSQL finalization. Reopening through the version API
returns active/current XYZM metadata, a passed native scan, both measured-Parquet and
display-loss warnings, and all five original/working/display objects. The normal
exact-version/object download endpoint authorizes its working file; local retrieval
matches the catalog SHA-256. Listing alone requests neither a ticket nor file bytes.
[Receipt](../parity/reports/geolens-003-measured-version.json).

The one-case journey uses synthetic identity and local upload/download transports;
it is not live S3 or browser acceptance. The downloaded bytes match the catalog;
native WKT preservation has its separate inspector receipt. Worker artifact retention
is opt-in and capped at 1 MiB per file for this fixture. All containers removed; no
cloud/provider/CI calls or new build. Existing application permissions are unchanged.

Next: exercise this retained-version warning/download flow through the existing
Studio version-files build, then consolidate metadata-refresh comparison evidence.
Broader geometry/reader compatibility, production packaging and deployment remain open.
GeoLens parity remains partial.

## MapServer roads enabled; remaining land cover and contour conversion (September 23)

The distinct MapServer road capture now has a private display on its existing Layer.
All 15,588 identities and properties are retained, including 72 nonspatial records;
the three tiny lines omitted by the earlier tile candidate remain exact. The display
uses topology-preserving line simplification, independently checked against every
removed vertex, with a 1.261-metre projected displacement bound. Original geometry
remains preserved. The 13.8 MB gzip decodes to 38.2 MB within existing Studio limits.

The actual built archive selector verified all loaded feature content, visible roads,
and zero archive reads before explicit selection or on live failure. Five bounded
S3 calls preserved and verified the display and restoration manifest. Source-locked
admission reused the successful object check after a pre-transaction Aurora wake-up
response. Both real accounts discover the choice through the production runtime and
retain its initially-off membership in the same Bhutan map. No grants, original
objects, application builds or deployments changed. Hosted signed-in acceptance is
still separate. [Evidence](mapserver-road-display-20260923-evidence.json).

The NSDI queue is now three source URLs representing two original contents. The
native land-cover profile completed all 410,122 records and 98,373,827 vertices;
no exterior collapsed at the three tested grids. Its bounded conversion is running
in session 56264. The contour correspondence review bounds ordered captured-curve
differences below 0.001 metre, with separate original attributes and provenance.
Session 64427 rewrites the reviewed display with the MapServer IDs and attributes,
preserving both native grid extents after retaining the first mismatch receipt.
Poll these exact handles before any restart. Full display and goal completion are
not yet established.


## Layer version files and readable quality observations (September 23)

The existing Layer version panel now shows retained original/working/display files,
roles, sizes and checksums alongside readable quality warnings. Users can prepare an
exact version/object download through the existing authorized API, then choose the
short-lived link. Listing performs no signing or storage reads. Missing download
permission hides the action; denial, expired tickets and disposal never expose a link.
The original structured quality observations remain available without modification.

Seven focused component checks and one isolated Studio build/verifier pass.
[Evidence](layer-version-files-20260923.json). No cloud/provider/CI calls. The API and
permissions are unchanged. This is local UI evidence with adapter substitutes, not
proof of measured-worker persistence or live object retrieval; no deployment occurred.

Next: connect a measured GeoPackage upload through real worker finalization, reopen
its quality observations and retrieve the exact working object with the normal API.
Use this new build for the browser portion where inputs remain unchanged. Existing
parity gaps and the administrator-policy approval remain open.

## Measured-coordinate working data and display loss (September 23)

Native inspection found `MakeValid` silently dropped M values from working Parquet.
Working conversion now preserves source geometry without automatic topology repair
and explicitly enables GDAL's additional-dimensions Parquet option. Two typed Point M
and Point ZM GeoPackages retain exact M=123.5 in working data; XYZM also retains
Z=45.5. Original source hashes remain unchanged. GeoJSON previews omit M, and retained
quality observations now disclose display loss and measured-Parquet reader limits.
[Native receipt](../parity/reports/geolens-003-measured-preservation.json).

This is an internal measured extension, not a claim of standard GeoParquet reader
compatibility. Display derivatives still apply their existing repair path. Initial
loss/rejection receipts are retained. Three bounded offline inspector containers were
removed; zero cloud/provider calls, CI runs or new frontend builds. The actual inspector
ran with cached native tools; API/database queue finalization remains separate.

Next: verify measured working-copy retrieval and quality observations through the
normal version workflow, then broaden geometry/reader compatibility. Existing records
are unchanged and must not be silently regenerated. GeoLens parity remains partial;
production worker packaging/deployment and broader acceptance remain open.

## Explicit Z/M layout review (September 23)

Refresh review and retained-version comparison now display XY, XYZ, XYM and XYZM
from the worker's recorded per-layer declarations. A change from XYZ to XYM receives
an explicit elevation/measure warning even though both have three ordinates. Missing,
malformed or partly unknown history remains Unknown; dimension alone never supplies
layout. Matching declarations do not imply every coordinate or derived display was
verified. Stored evidence and server acceptance rules are unchanged.

Five focused helper/DOM cases pass, including unchanged acknowledgement and rejected
candidate behavior. One isolated Studio build and verifier pass. No cloud/provider/CI
calls. [Evidence](coordinate-layout-review-20260923.json). This new build is local;
previous full-shell acceptance remains evidence for its earlier exact build.

Next: exercise a real measured-coordinate ingestion and inspect original versus
derivative preservation, then consolidate broader geometry/count-loss evidence.
GeoLens metadata-refresh remains partial; deployed identity/provider acceptance and
full-shell initial registration remain open.

## Connected refresh through the built Studio Layer route (September 23)

The sealed Studio build now passes the connected-refresh journey through its actual
`/layers` page, normal browser auth storage, platform adapter and navigation. Opening
the Layer makes no writes. Explicit inspection, estimate and rights/cost confirmation
start one capture; real archiver/GIS workers process it. The built page reviews the
candidate, retains it across reload, requires acknowledgement, accepts it and reopens
with the candidate current and no remaining staged candidate.
[Receipt](../parity/reports/geolens-003-connected-studio.json).

Build tree `7d414c642a64e3ed606eb35f987ffe608010ba12036bba1aa183480462ef2296`
was reused and verified without rewriting its files. Initial source registration and
first capture use fixture setup through normal APIs; identity/provider/storage are
local substitutes. Optional external fonts are blocked, not fetched. The first run
stopped at that font boundary. A second run exposed the component fixture token
format being rejected by normal browser auth; the local verifier now maps a valid
synthetic session shape. Both failure logs are retained. All containers removed;
no AWS/provider/CI calls or application rebuild. Not deployed.

Next: reconcile remaining GeoLens metadata-refresh acceptance with the pinned
upstream comparison and broader geometry/count-loss cases. Full-shell initial source
registration, deployed identity/provider acceptance, volume/accessibility and broader
publication pin coverage remain open. Administrator-only capture permissions remain
unapplied pending approval. The parity row stays partial.

## Remaining Bhutan display exceptions: retained local investigation (September 23)

The four approved packages remain preserved and enabled as recorded in
[the completion receipt](bhutan-approved-display-completion-20260923.json).
Additional local investigation made no cloud calls, uploads or catalog changes.
Lossless MapServer road compaction retains 15,588 records and 3,564,823 positions,
but its 141,399,936 decoded bytes exceed the existing 64 MiB reader limit.
Its 51,812,381-byte gzip size does not remove that limit.

The contour comparison now accounts for all 212,944 records. Nine differences
are null versus empty line geometry; seventeen records contain additional source
vertices. Original properties and these exceptions are retained. Coordinate
similarity does not authorize replacing one captured source with the other.

The large 50k land-cover native profile is still running within its 1,200-second
bound; poll session 20530 and its retained receipt before any restart. It avoids
the previous individual-JSON-value limit. No conversion or rendering completeness
claim follows from profiling. [Investigation checkpoint](bhutan-remaining-display-investigation-20260923.json).

Python syntax and foundations checks pass. Aggregate parity retains unrelated
shared-tree artifact hash mismatches; no evidence seals were rewritten. The
full ingestion goal and hosted signed-in acceptance remain open.


## Captured versions remain pinned in saved maps (September 23)

Two real local source captures now exercise changed geometry: the first point is at
[-71.2, 42.3], the candidate at [-71.1, 42.3]. A saved map pins the first actual GIS
preview before refresh. Browser acceptance promotes the candidate; reopening leaves
the map definition unchanged. The real saved-map worker then verifies the earlier
object ID, key, storage version and checksum and renders its red point at the center
of a 128px image. No synthetic replacement preview is inserted for this journey.
[Receipt](../parity/reports/geolens-003-connected-pinned.json).

The bounded fixture retains at most 32 KiB of actual preview bytes for local reuse.
Two one-feature provider fixtures, two ingestion workers and one rendering worker;
all containers removed, no cloud/provider/CI calls and no new application build.
The first run stopped because the fixture lacked required dataset metadata; its log
is retained. The fixture now creates that record through the normal repository.
Identity/storage/provider transports remain local substitutes; map creation uses
normal repositories and browser acceptance uses real components, not the full shell.

Next: full Studio-shell connected-refresh acceptance, reusing the existing bundled
build where inputs remain unchanged. Broader geometry/volume, publication embedding,
independent provider comparison and deployed acceptance remain open. GeoLens metadata
refresh remains partial. The administrator-only permission proposal is still pending.

## Connected capture source-update contention (September 23)

The real local PostgreSQL/API journey now observes a source update and candidate
acceptance waiting on the same upstream Layer lock. When the update wins, acceptance
and retry return `refresh_source_revision_changed`. The active base remains unchanged,
the processed candidate is preserved, and no acceptance record is inserted.
[Receipt](../parity/reports/geolens-003-connected-contention.json).

Two one-feature captures use the actual source archiver and GIS worker. The browser
starts the refresh; HTTP clients exercise contention. Provider/storage/identity are
local substitutes. All containers were removed; no cloud/provider/CI calls or new
application build. The first run failed on an incorrect error-shape assertion after
observing the expected conflict; its log is retained and the corrected run passes.

GeoLens metadata refresh remains partial. Next: capture-specific pinned-consumer
rendering, then full Studio-shell acceptance using the existing build where inputs
are unchanged. Administrator-only capture policy remains unapplied pending approval;
this journey uses existing explicit Project-owner authority.

## Four approved Bhutan packages preserved; six archive choices enabled (September 23)

The user explicitly approved the four prepared private road, agricultural, contour
and LULC 2010 display packages. All 77 payload files (868,149,094 bytes) and four
restoration manifests are now preserved at exact versioned S3 keys beneath the
existing private Bhutan prefix. Total uploaded bytes including manifests were
868,197,162. Originals and permissions are unchanged.

Six existing catalog Layers now offer explicit archive choices: four primary
records plus two road/contour entries whose captured bytes and registered schemas
match exactly. Reuse preserves separate Layer identities, source provenance and
unknown rights; no extra payload copies were uploaded. Actual runtime checks verify
all six choices for Aaron and Categorise and their membership in five Bhutan maps.
All remain initially off. The current paired viewer's seven deployed modules and
current API image were checked; unchanged API custody/signing tests and native
security evidence were reused. No application build or deployment was required.
[Completion evidence](bhutan-approved-display-completion-20260923.json).

The first LULC upload stopped because hard-link-related ctimes differed on three
unchanged files. All payload sizes/hashes, mtimes and inodes were reverified before
creating a ctime-only continuation. Nineteen completed object receipts and the
original transfer budget/deadline were carried forward. Failed receipts and original
plans remain retained. The database wake-up failure preceded transaction begin;
its subsequent admission reused successful S3 checks.

The retained NSDI display queue is now four source URLs representing three unique
original files: shared 50k land cover, MapServer road and MapServer contour. A local
50k land-cover profile stopped because one individual GeoJSON value exceeds 64 MiB.
Its terminal failure is retained; do not rerun the same parser or infer malformed
geometry from that size limit. Next use a bounded streaming geometry path for that
source and reconcile reusable MapServer geometry. Hosted signed-in acceptance and
the full ingestion completion audit remain open. No running transfer remains.

## Connected refresh acceptance and bundled build (September 23)

One bounded journey now connects normal API source registration and estimate/capture,
the actual source archiver, two actual GIS-worker ingestions and browser capture
confirmation/review/acceptance/reopen. The current version remains usable until
acceptance; a reader is denied; one acceptance is retained. Two one-feature fixture
responses, ten browser-start requests and seventeen browser-review requests; zero
cloud/provider/CI calls. All containers removed. [Receipt](../parity/reports/geolens-003-connected-refresh.json).
Identity/provider/storage transports are local substitutes and the browser uses real
components, not the full Studio shell. Broader volume and provider acceptance remain.

The first run uncovered an API/database mismatch for account administrators without
an explicit Project role. Automatic approval review rejected the proposed permission
expansion as requiring explicit approval. No policy migration was written or applied.
[Concrete proposal](source-capture-admin-policy-review.md) awaits the user's decision.
The passing run uses the already-supported explicit Project-owner role, not a policy
bypass. Failed logs are retained alongside the local receipt.

Built Studio once in an isolated copy and passed its verifier. Tree
`7d414c642a64e3ed606eb35f987ffe608010ba12036bba1aa183480462ef2296`.
[Build receipt](studio-connected-refresh-build-20260923.json). Not deployed; matching
API/migrations and release preparation remain required. GeoLens evidence is updated
without promoting the partial row or resealing unrelated checksum failures.

Next: connected source-update contention and capture-specific pinned-version evidence,
then full Studio-shell/release acceptance using this build while inputs are unchanged.
Keep the administrator-policy step pending separately; independent work can continue.

## Deliberate connected refresh UI (September 23)

Managed Layer pages now offer an explicit source-refresh panel. Inspection resolves
the current version's capture lineage and exact prior job, then loads the current
source. A new estimate reuses the recorded capture area/limit. Rights text and
attribution are prefilled from history; permission and cost confirmations remain
unchecked. Starting sends the target Layer/base with the existing capture request,
retaining the same idempotency key after an uncertain response. Manual status,
queued cancellation and earlier-capture history do not start another capture.

No requests occur on mount. A single-source capture binding and source access through
the selected Project are required; no implicit links, grants or provider polling.
History is bounded to the latest 100 source jobs. Completed captures lead to the
existing processing/candidate review controls. One DOM initiation/retry/history case,
five Layer page cases and six filtered client cases pass. [Evidence](capture-refresh-ui-20260923-evidence.json).
These checks use deterministic adapters, not a built browser/actual worker journey.
No AWS/provider/CI calls or build.

Next run one integrated local source estimate/request → capture → GIS worker → browser
review → acceptance/reopen journey, with stale-source rejection and pinned-version
checks. Resolve integration findings before one bundled Studio build. GeoLens refresh
remains partial; deployed identity/provider and broader comparison requirements remain.

## Capture-aware review and acceptance (September 23)

Review evidence now joins completed capture jobs, approved scopes and immutable
count records to their exact original objects and versions. It compares processed
counts against captured counts and the provider-reported bounded total. Mismatches
produce rejected reviews; missing knowledge and changed scopes/revisions remain
explicit. The selected source must match the previous capture and the staged parent.
Acceptance locks the upstream Layer, requires current read access and checks its
latest source revision before recomputing the exact reviewed evidence and promoting
the candidate. Metadata remains distinct from edit authority.

The existing review UI explains the provider total, expected bounded count, processed
count and approved area/limit. Rejected captures have no acceptance action. Forty-three
review/ingestion tests and two UI cases pass. The real offline PostgreSQL upload
journey passes with the expanded evidence query, retaining concurrent one-time
acceptance and existing upload behavior. [Evidence](capture-refresh-review-20260923-evidence.json).
Capture-specific repository tests use fixtures; this is not yet the connected
capture/worker/browser acceptance journey. No provider/AWS/CI calls or build.

Next expose deliberate connected-source refresh initiation with estimate/rights/cost
review, then run one local capture request → worker → review → acceptance/reopen
journey, including source revision contention and pinned maps. Keep GeoLens refresh
partial and retain deployment/volume/peer comparison gaps. The previous exclusion of
snapshot candidates from upload-only review is replaced by source-aware evidence.

## Koshi wetlands archive rendering and land-cover TIFF links (September 23)

Registered one Koshi basin wetland Layer and an initially hidden map in the Nepal
collection. Preserved QGIS metadata points to layer 32, which now serves elevation;
current layer 33 matches the archive name, fields and exact extent. The old URL and
unknown migration/acquisition dates remain recorded. One public sample confirms
current feature delivery and Studio CORS; full provider equality remains unverified.

A private, immutable 10,468,558-byte gzip copy restores all 41,422,509 original bytes.
The existing built Workbench loaded all 22,119 features unchanged and rendered the
polygons through explicit archive selection. Hidden layers, metadata review and a
failed live connection made zero archive reads. Exact S3 version/range/CORS and
normal runtime archive discovery passed; Aaron and Categorise both retain access.
This separates local browser rendering from real account/storage checks; a hosted
signed-in journey is not claimed. No application build or deployment was needed.

Also linked two existing 2019 land-cover TIFF variants to their existing Layer.
Bounded headers identify the WGS84 grid, tiled/overview structure and band metadata;
full pixel equality, ZIP derivation and archive map display are not established.
The retained 387-object Nepal listing now has 259 account-verified catalog links,
125 unresolved keys, two empty markers and one duplicate relocated to India.
Counts describe objects, not distinct Layers or map-ready datasets.
[Evidence](nepal-koshi-and-landcover-20260923-evidence.json).

Syntax, whitespace and foundations pass. The aggregate parity check still reports
existing shared-tree fixture hash mismatches; no evidence was blindly resealed.
Next reconcile the remaining ordinary Nepal S3 groups, keeping large buildings and
unknown-datum electricity files isolated. The full ingestion goal remains open.

## Same-Layer connected capture staging (September 23)

The source capture API accepts an explicit `refresh_target` containing the managed
Layer ID and expected base version. It checks target edit authority, retains existing
name/classification and skips Layer/link creation. Migration 0145 requires an active
managed capture with lineage to the same upstream Layer. Completion allocates the
next candidate version and ingestion job, binds the parent/upload intent and count
evidence, and retains the active current pointer. Ordinary protected copies retain
their existing behavior; a remote reference is never converted into hosted data.

Auditing cleanup exposed an existing copy assumption: failure/cancellation detached
the destination from its Project. All three cleanup paths now retain staged targets,
including exhausted retries. Thirteen custody cases exercise staging, parent/current
identity and cleanup; 60 API/repository/ingestion checks pass. One offline PostgreSQL
run applied all 145 migrations and verified privileges, then removed its container.
[Evidence](staged-source-capture-20260923-evidence.json). Prior GIS completion is a
fixture in the custody test; actual worker/browser acceptance remains open. No
cloud/provider/CI calls or build.

Next: connect capture-aware review and acceptance to immutable count/lineage records,
checking source revision, query scope, current base and edit authority. Upload-only
review currently excludes source-snapshot candidates, preventing them from bypassing
that check. Then expose the deliberate refresh UI and run one connected local journey.
This is staging implementation, not a finished refresh experience or parity closure.

## Trusted capture count binding (September 23)

Migration 0144 stores server-created count summaries atomically with completed
capture jobs, exact original objects and resulting dataset versions. The completion
wrapper checks the approved scope, source type, count consistency and unknown/limited
status. Evidence is immutable and tenant-isolated; the runtime can read but not write
it. The archiver cannot bypass completion or insert directly. Legacy captures without
evidence remain compatible and unknown. Arbitrary GeoJSON metadata is not consulted.

The actual fetcher returns a compact summary separately from the GeoJSON, and the
archiver transports it with the exact stored artifact. Eighty-four Python checks and
12 direct custody lifecycle cases pass, including mismatches, scope substitution,
replay, exact object/version binding, cross-tenant hiding and immutability. One offline
PostgreSQL run applied all 144 migrations and verified privileges, then removed its
container. [Evidence](source-capture-binding-20260923-evidence.json). The initial Node
`--test` result reported only a file-level pass; the direct command established that
the 12 cases actually ran. No cloud/provider/CI calls or build.

Next implement deliberate same-Layer staging for connected captures and consume only
this server binding in refresh reviews, rechecking current source revision, base and
edit authority at acceptance. Protected-copy behavior still creates a separate Layer;
this checkpoint does not claim that connected refresh or its UI is complete. Keep
GeoLens refresh partial. Deployment remains a separate gate.

## Bounded connected-source count verification (September 23)

The existing feature capture path now checks supplied `numberMatched` and
`numberReturned` against received pages. Contradictory totals, changing totals,
premature short results and oversized pages fail before output storage. Successful
GeoJSON captures retain count fields, response hashes/lengths, fetched count and
approved scope/limit in `opengeo:capture`. A limited capture remains a subset;
missing totals remain unknown. No extra requests or count polling were introduced.

The source-fetcher and coordinator checks pass (83 local tests), including ArcGIS
and WFS request configurations with deterministic response fixtures. Ruff and
whitespace checks pass. [Evidence](source-capture-counts-20260923-evidence.json).
This establishes consistency with supplied counts, not an independent query,
transactional provider snapshot, retained raw response bodies or deployed acceptance.
Initial test fixture mistakes were corrected; no cloud/provider/CI runs or builds.

Next connect exact server-created capture identity and its approved query scope to
staged refresh candidates/reviews. Never trust `opengeo:capture` from arbitrary
uploads as server evidence. Preserve unknowns and reject mismatches at acceptance;
GeoLens refresh remains partial. Demo/Studio deployment and full-shell acceptance
remain separate gates. Previous dimension and demo catalog evidence remains valid
for its stated scope.

## Declared coordinate dimensions and demo catalog checkpoint (September 23)

Worker metadata now preserves declared XY/XYZ/XYM/XYZM layouts and coordinate
dimension. The refresh review shows before/after dimensions and flags changes;
legacy and mixed unknown declarations remain unknown. A real offline XYZ upload
passed GIS processing, persisted review, browser acknowledgement, acceptance and
reopen. The first run exposed GDAL JSON's `PointZ` spelling; suffix parsing was
corrected alongside prefix parsing. Eighteen focused tests and Ruff pass.
[Scoped receipt](../parity/reports/geolens-003-declared-dimensions.json).
No cloud/provider/CI calls; temporary containers removed. M layouts have unit
coverage, not a real M ingestion journey. This is declared metadata, not a scan
of every coordinate. GeoLens refresh parity remains partial.

The demo New Project flow opens its catalog, clears stale searches and retains the
new Project when adding a Layer. Registered local Layers remain independently
reusable after reload. The existing [built-demo evidence](demo-catalog-knowledge-20260923-evidence.json)
covers this flow; it has not been deployed. The earlier Studio build predates the
new dimension display. Batch remaining changes before rebuilding.

Next: authoritative provider count verification and connected-service refresh,
then coherent API/static release preparation and full Studio acceptance. Preserve
existing publication/version pins and unknown rights. Deployment requires a current
window; shared-worktree parity checksum failures remain visible and unresealed.

## Pinned-map rendering and bundled Studio build (September 23)

A map saved before refresh acceptance retains its exact definition afterward. The
actual saved-map job resolves the earlier version's preview object ID, storage version
and checksum; the real worker renders a 128×128 PNG whose center remains the old red
point. The replacement point is far outside that view. The old preview is an explicit
synthetic fixture; the replacement was browser-uploaded and processed by the real GIS
worker. [Receipt](../parity/reports/geolens-003-pinned-render.json). All containers removed.

Fixture errors in resource ID access, explicit blank/single-symbol selection and the
pixel checker were corrected; failed receipts remain. GDAL supplies the pixel check,
so no dependency/image build was needed. One ingestion and one render in the passing
journey; zero AWS/provider/CI calls.

Built Studio once in an isolated copy and passed the build verifier. Seven routes and
six aliases; tree `a20f78223b04e3a13528ae0cbf567ba8b5f3e47da1abbdef9dfc34872e6bd677`.
[Build receipt](studio-refresh-build-20260923.json). Not deployed or release-prepared;
the API and migrations must accompany this workflow. Foundations check passes; full
parity validation still reports shared-worktree evidence checksum mismatches, left visible.

Next close remaining refresh metadata/verification gaps (provider count and coordinate
dimension evidence) and review the partial parity queue. Reuse this build for unchanged
inputs; prepare coherent API/static release artifacts before requesting a deployment
window. Full Studio/deployed acceptance, broad GeoLens comparison and volume remain open.

## Nepal landcover archives and existing-reference closure (September 23)

Linked nineteen existing NLCMS ZIPs (2000–2019, excluding 2012) to the corresponding
registered ICIMOD Layers. Their embedded ISO XML names the exact persistent identifier
of the public FRTC/ICIMOD record. Original XML, rights text, member years and timestamps
are retained; native Lambert Conformal Conic metadata stays separate from the live
service's WGS84 display bounds. Both accounts read the same metadata revisions and
see the archived-data indicators. No new Layer, original upload, or automatic fallback.

The bounded inspection used 38 conditional S3 range GETs and 2,490,368 bytes, preserving
exact range and metadata hashes. It did not download full rasters or establish pixel
or whole-ZIP equality. Original null S3 versions remain mutable and acquisition dates
remain unknown. Existing maps are unchanged; archive raster rendering remains open.
[Evidence](nepal-landcover-archive-links-20260923-evidence.json).

Also linked the preserved Nepal folder discovery index and verified 55 already-known
S3 object references across 51 existing identities using both accounts' normal catalog
capabilities and current exact metadata/source references. That check used 32 Data API
calls and no S3 reads. The retained 387-key inventory now records 255 account-verified
object relationships, 129 unresolved keys, two empty markers and one relocated duplicate.
These counts do not establish an equal number of logical datasets or renderable Layers.

Updated delivery instructions to use bounded ZIP metadata inspection, persistent source
identifiers, atomic receipts and immediate manifest closure instead of repeated uploads
or registrations. Syntax and foundations pass; existing shared-worktree parity checksum
failures remain unresealed. No application build, provider polling loop or deployment.
Next inspect/link the two existing 2019 TIFF variants, register remaining ordinary
Nepal objects and resolve the outstanding full archive display work. Goal remains open.

## Browser acceptance of actual processed data (September 23)

The connected local journey now returns to the browser after actual WorkerProcessor
execution. It reviews the processed candidate, denies a reader, accepts with current
edit authority and reopens the new current version. SQL verifies the prior version
remains active and exactly one acceptance record exists for that review. This connects
browser upload, GIS processing, retained evidence, deliberate acceptance and reopening.
[Receipt](../parity/reports/geolens-003-processed-acceptance.json).

The run completed in about 53 seconds with one GIS job, 24 API calls in the upload
browser phase and 17 in processed-candidate review. No browser errors, AWS/provider/CI
calls or builds. Both containers, browsers and API bridges were removed/stopped.
Nested browser worker flags describe those separate phases; worker evidence is explicit.

Audit: saved-map compilation requires an explicit dataset version, and saved-map source
resolution matches that ID/version number without substituting the current pointer.
This code audit is not rendered-map acceptance. Next add that pinned-consumer journey,
then bundle the Studio build once. Full Studio/deployed identity, provider count and
coordinate-dimension verification, broader GeoLens comparison and volume evidence remain.

## Actual GIS worker processes the browser-staged candidate (September 23)

The connected local journey now sends the browser-uploaded GeoJSON through current
WorkerProcessor code in the cached, network-disabled GIS image and real worker-role
PostgreSQL. Malware inspection passes and the worker generates GeoParquet, GeoJSON
preview, PMTiles and thumbnail artifacts. The candidate becomes active with one feature
while the prior current pointer remains. Server review binds its processed count and
exact original checksum. [Receipt](../parity/reports/geolens-003-staged-worker.json).

Successful run took about 46 seconds including browser/API setup; both worker and
database containers were removed. No AWS/provider/CI/build/image pull. An approval
review timeout preceded execution; three launcher failures (dependency path and input
mount permissions) were corrected by matching the existing integration launcher's
runtime path and label handling. All failed receipts are retained. No application or
database privileges were broadened. Browser receipt's worker flag remains false for
its earlier phase; the separate worker receipt proves actual execution afterward.

Next complete browser acceptance of this actually processed candidate and verify an
existing version-pinned consumer still renders its previous version. Then bundle the
Studio build. Independent provider counts, coordinate dimensions, full service/worker
comparison, deployed acceptance and representative volume remain open; parity is partial.

## Nepal ICIMOD catalog reconciliation (September 23)

Registered 125 live provider connections under Aaron's Nepal workspace and verified
read/edit access for Aaron and Categorise through the normal runtime repositories.
All 125 have usable source extent/CRS metadata and spatial search. Eleven service maps
are saved in the Nepal collection with all layers initially off and both-account
readback. Ten unusually wide vector schemas use provider map images; complete source
metadata is retained in the private, versioned 224 KB bundle rather than discarded.

Linked the eleven original S3 service metadata objects to these catalog identities.
The retained 387-key Nepal inventory now has 180 account-verified object relationships,
56 other references, 149 unresolved keys, one relocated duplicate and one empty marker.
These are object counts, not dataset counts. The discovery folder index remains open.

Four hydropower samples render in the actual built Workbench with zero hidden reads;
one Corona image also passed a bounded provider probe. This is representative evidence,
not a claim that all 125 layers render or their datasets are archived. No app deployment,
full build or repeated original upload. [Evidence](nepal-icimod-services-20260923-evidence.json).

Resume receipts atomically, preserve completed registrations, and compare only numeric
display-bound round-trip noise within 1e-12 degrees; source URLs and visibility remain
exact. Two initial database readiness timeouts made no writes; the resumed runs completed.
Next reconcile existing Nepal landcover archives to these identities and close ordinary
inventory gaps before optional large display conversions. Overall ingestion stays open.
Whitespace and foundations checks pass. The parity gate still reports shared-worktree
fixture checksum mismatches; these were retained without a blanket evidence reseal.

## Browser staging retains Layer identity and current data (September 23)

Extended the connected browser journey to select a GeoJSON file and use the normal
managed upload client. The local storage substitute receives the multipart bytes and
checks exact size and SHA-256 against the API registration before completion. One
upload creates a queued candidate under the same Layer and expected base; reload
retains it and the previous current pointer. Queued candidates cannot be accepted.
The run also repeats review/acknowledgement, reader denial and accepted-version reopening.

[Receipt](../parity/reports/geolens-003-staged-browser-upload.json): 24 local API requests,
one intercepted synthetic-storage upload, no browser errors, zero cloud/provider calls.
Browser/API/container cleanup completed. No CI/full build. GeoLens partial evidence now
includes browser upload; actual GIS processing, provider counts/dimensions, full Studio,
deployed identity/storage and pinned consumer rendering remain open. Next reuse the
cached worker runtime for a representative staged candidate and its retained artifacts.

## Connected browser review and acceptance (September 23)

The actual DatasetRefresh component and normal API client now pass a browser journey
against the real local API/PostgreSQL. It recovers a retained candidate after reload,
shows unknown source count, requires acknowledgement, rejects a reader after edit
access is removed, accepts as an authorized user, and reopens the new current version.
Seventeen local API requests, zero initial writes, zero external requests/browser errors.
The browser, loopback API and offline container were cleaned up.
[Receipt](../parity/reports/geolens-003-staged-review-browser.json).

Updated the GeoLens comparison and partial parity row with this specific evidence.
The candidate was staged through the API fixture and processed through worker SQL with
synthetic inspection output. Browser upload, actual GIS inspection, full Studio shell,
provider counts/dimensions, pinned-consumer rendering and deployment remain unverified.
No AWS/provider/CI/full build. Next connect a representative actual local GIS worker
journey and browser upload without duplicating remote processing or relaxing unknowns.

## Layer inspector staged-update controls (September 23)

Added an editable upload-backed Layer workflow to the inspector: choose a same-format
file, stage through the existing recoverable managed-upload session, manually check
processing/candidates, inspect exact retained review evidence and acknowledge unknowns
before making the reviewed version current. API client methods validate review identity
and bind acceptance to its digest/base. The candidate list also resumes retained staged
versions after reopening. Opening the panel does not upload, process or poll.

The component check exercises staging under the existing Layer, review, acknowledgement
and a single acceptance with the exact review. Five Layer inspector checks pass. Four
managed-upload checks and ten spatial interchange checks pass; the upload regression
exposed padded hex WKB being misclassified because whitespace counted toward parity.
Hex detection now checks the trimmed payload. Syntax and scoped whitespace checks pass.
These are component/adapter checks, not the integrated browser/API journey or deployment.
No AWS/provider/CI/full build. Checkpoint:
`.local-archives/layer-refresh-ui-20260923/checkpoint.json`.

Next exercise this actual component with the normal API client against the local real
PostgreSQL API, including reopen, changed-base recovery and permission denial; then
connect actual GIS worker processing and pinned consumer acceptance. Bundle the affected
Studio build after that coherent journey. Full refresh and overall parity remain open.

## Atomic acceptance of reviewed staged uploads (September 23)

Connected explicit acceptance using the exact review digest and expected base. Under
the Layer lock the API rechecks current edit authority, unconsumed review, active base
and candidate, and retained evidence. It atomically promotes the candidate and inserts
one immutable acceptance record (migration 0143). Duplicate acceptance conflicts rather
than promoting again. Rejected reviews and unsupported source kinds fail closed.
Prior versions remain; metadata and consuming map/Publication pins are not rewritten.

The offline API/PostgreSQL journey passed all 143 migrations. Two competing requests
produce one success/one conflict and one acceptance record; wrong digest/base, changed
inspection evidence, readers and duplicate requests are rejected. Prior version and
Layer identity remain, acceptance mutation fails, and the temporary container was
removed. [Evidence](staged-refresh-acceptance-20260923.json). An initial read-lock query
required forbidden update privileges on retained processing records; it was removed,
preserving their read-only grants. Failed receipt retained. No AWS/provider/CI/build.

The 55 existing ingestion/route/review checks passed, followed by 35 ingestion checks
including three added rejection/source-boundary cases. Ruff and scoped whitespace
checks pass. Earlier foundations evidence remains applicable; shared-worktree parity
checksum failures remain unresolved, without a blanket reseal.

Next connect staging, progress, review and acceptance to the Layer inspector using the
same API and permission path. Then exercise actual GIS processing and a pinned consumer
journey. Provider count verification, deployed acceptance and full parity remain open.

## Server-authored staged refresh reviews (September 23)

Connected `POST /datasets/{id}/refresh-reviews` to immutable review storage. It locks
and checks the editable current Layer, then accepts only a completed staged candidate
bound to that base. Evidence comes from retained versions and original storage objects;
requests cannot submit counts or schema. Upload source counts and coordinate dimensions
remain explicitly unknown, requiring review. Schema/spatial changes and empty output
are also flagged. Repeated creation returns the same review without promotion.
Migration 0142 enables API-role inserts; immutable history and tenant/actor checks remain.

All 52 ingestion/route regressions and three review-rule checks pass, with Ruff clean.
The offline API/PostgreSQL journey passed all 142 migrations, pending/stale conflicts,
reader denial, extra-field rejection, exact byte/metadata binding, repeat identity and
retention of the base pointer. The first run correctly allowed an editor via another
Project; the fixture was changed to a true reader, and its failed receipt is retained.
[Receipt](staged-refresh-review-20260923.json). Container removed; no AWS/provider/CI/build.
The earlier foundations check passed; shared-worktree parity checksum failures remain
unresolved, with no blanket evidence reseal.

Next implement atomic one-time acceptance under the Layer lock, binding the displayed
review digest and expected base, then connect the upload/review UI and exercise actual
GIS processing. Provider count verification and full GeoLens refresh parity remain open.

## Staged candidate worker database boundary (September 23)

Extended the staged upload acceptance through the actual granted `opengeo_worker`
claim/completion functions. A wrong token and repeat completion are rejected; the
candidate becomes active with its own inspected metadata and derivative record while
the base stays active and current. Upload retry after processing still returns the
candidate without another object inspection. This closes the database lifecycle question
for staging, using synthetic inspection output, not actual GDAL or S3 execution.

The offline PostgreSQL run passed with all 141 migrations and removed its container.
[Receipt](staged-upload-worker-boundary-20260923.json). No AWS/provider/CI/build calls.
Foundations check passed; the repository parity check still fails evidence checksum
mismatches in the shared worktree. No hashes were refreshed to hide those failures.

Next connect authoritative review generation to candidate metadata and original-object
identity, explicitly treating unavailable source counts and coordinate dimensions as
unknown. Then implement atomic one-time acceptance and the connected review UI, and
exercise actual GIS processing with a representative local fixture. Full refresh parity
and deployment remain unfinished.

## Staged upload candidates retain the current Layer (September 23)

The upload request API now optionally accepts paired `target_dataset_id` and
`expected_base_version_id` fields. For an editable, active upload-backed Layer of the
same format, registration binds the existing Layer and expected base before issuing
storage access and rechecks them under lock. Completion allocates a separate candidate
with its parent version and ingestion job, retaining the Layer current pointer, name,
tags and metadata. Migration 0141 makes the intent's staging binding immutable.

Focused ingestion and route checks passed (32 and 20 respectively), with Ruff clean.
The offline PostgreSQL/API journey applied all 141 migrations and verified retained
identity/base/metadata, candidate parent binding, reader denial before storage and exact
completion retry. Synthetic storage only; zero cloud calls; container removed. The
first harness URL error was corrected and its failed receipt retained. Evidence:
`.local-archives/staged-upload-postgres-20260923/receipt.json`.

This is API staging, not a complete refresh workflow. Actual worker execution, authoritative
count/schema/content/geometry review, atomic one-time promotion and the connected UI
remain next. No deployment, remote build or CI run occurred.

## Upload retry resolves its exact produced version (September 23)

Preparing staged uploads exposed an existing completion-recovery bug: a completed
upload retry resolved the dataset's current version, which may differ from the version
that upload produced. Both the initial completed fast path and locked concurrent
completion path now resolve the version/job by the upload intent's recorded completed
original object. Missing original identity fails closed. Current dataset presentation
is still returned independently; no object reinspection, mutation or current-pointer
change occurs during retry.

The ingestion regression now supplies a newer current version while retrying the older
upload and checks the original object query, returned original version/job and no
storage read/write. All 29 ingestion checks and Ruff pass. An accidental extra keyword
on the ordinary completion read was caught and corrected before the passing rerun.
No cloud/provider/build/CI. Checkpoint:
`.local-archives/upload-exact-completion-20260923/checkpoint.json`.

Staged upload creation remains next: retain the existing Layer/current version, bind
an intent to the expected base, allocate a separate candidate and process through the
existing worker boundary without promotion. Then authoritative review and atomic
one-time acceptance must be connected. This completion fix is a prerequisite, not
same-Layer staged upload availability or GeoLens refresh parity.

## Staged refresh review storage verified (September 23)

Migration 0140 establishes immutable review records bound to exact base/candidate
versions of the same account and Layer, with an optional exact external source revision.
One review is allowed per candidate. A generated digest identifies stored JSONB evidence;
review creation itself never changes the current Layer pointer. Runtime review writes
and worker access remain disabled until authoritative verification is connected.
[Contract](dataset-refresh-review.md) specifies staging, counts/schema/content/geometry,
one-time acceptance, lock/revocation and retained-history requirements.

The offline PostgreSQL check applied all 140 migrations and passed exact-version foreign
keys, duplicate candidate rejection, immutability, tenant read isolation, disabled runtime
writes and unchanged current pointer. Temporary container removed. Initial generated-
expression and synthetic shared-object fixture errors were fixed; both failed receipts
are retained. [Evidence](dataset-refresh-storage-20260923.json). No AWS/provider/CI/build.

This is storage readiness, not implemented refresh promotion. Next connect server-owned
staged version creation and verification using distinct version-owned object records,
then atomic one-time promotion and the review UI. Keep old current versions and pinned
consumers intact. GeoLens managed-refresh parity and the full target remain unfinished.

## Managed version audit and inspection comparison (September 23)

Audit: upload registration allocates a new dataset; completing that upload creates its
version and processing job. Protected-copy requests also allocate a new destination
dataset. These are not a general refresh/replacement operation on an existing Layer.
The worker completion boundary and immutable versions are reusable, but a staged
replacement identity, reviewed expected source count and explicit promotion transaction
remain to implement. Do not infer replacement parity from metadata retention.

The canonical Layer inspector now offers explicit comparison of two accessible retained
data versions. It displays recorded feature counts, geometry, CRS and schema paths,
distinguishes unknown values from zero, calls out nonempty-to-empty changes and inactive
versions, and caps schema disclosures at 100 while retaining the full per-version JSON.
Selection makes no calls and changes no current pointer, data, style or map binding.
This is inspection, not the server refresh gate or proof of provider completeness.

Two focused helper/component checks pass for schema removal, explicit selection,
unknowns, empty data and input preservation. No build/cloud/provider/CI calls.
Checkpoint: `.local-archives/data-version-comparison-20260923/checkpoint.json`.

Next implement a staged replacement contract that reuses existing exact-version objects,
retains the current Layer until deliberate acceptance, binds source/count/schema/content
and geometry evidence, and enforces one-time acceptance under the Layer lock. Connect
that server record to review UI and exercise retention/revocation/conflict. The pinned
GeoLens data-refresh gap and full parity remain open.

## Pinned GeoLens refresh comparison identifies data-replacement gap (September 23)

Fetched only the decision module and its tests at pinned commit
`f5fee67d8cf053d741590a00a55fe1870eed2b92`, verified both Git blob identities against
the retained tree, and preserved unmodified files plus Apache-2.0 license. Eight
upstream tests pass offline. [Comparison](../parity/reports/geolens-003-peer-refresh.json).

GeoLens gates staged feature replacement on counts, destructive schema changes and
review fingerprints covering source, content and geometry/CRS/dimension. OpenGeo's
new workflow retains metadata responses without replacing features; it does not prove
this data-refresh outcome. The pure upstream function also cannot establish durable
one-time acceptance alone. Both limits are explicit in the ledger and comparison.
GeoLens metadata-refresh remains partial, with managed-data refresh acceptance tracked.

No provider/AWS/CI calls or build. Two bounded public source reads were needed after
sandbox DNS failed; no repository contents or credentials were sent. Next audit existing
managed-data version replacement and processing acceptance for these safeguards before
adding another workflow, then implement the missing connected review/acceptance path.
Bundle official Studio UI after the resulting coherent changes; full parity stays open.

## Competing source update rejects obsolete refresh (September 23)

A deterministic local PostgreSQL check observed both real API transactions blocked
on the shared dataset lock. The source update was queued first and completed after
release. Refresh acceptance then returned `metadata_refresh_source_conflict`, inserted
no knowledge revision, and the earlier candidate read was rejected against the changed
source. The cached database container was removed. No browser rebuild, provider request,
AWS or CI. [Receipt](../parity/reports/geolens-003-source-contention.json).

The scheduling lock is a test-only administrative connection; both application actions
use normal runtime-role API transactions. This closes the specifically tracked source-
update contention gap, not general load/scale acceptance. Existing browser evidence is
retained unchanged; the GeoLens ledger adds this independent receipt. The row remains
partial pending pinned GeoLens comparison and full Studio/deployed acceptance.

Next inspect pinned GeoLens refresh safeguards and preserve its independent fixtures,
then bundle the accumulated metadata UI into an official Studio artifact. Reuse the
successful local workflow receipts for unchanged inputs. Full parity remains open.

## Connected metadata refresh workflow passes (September 23)

Chromium with the actual metadata components and normal API client completed discovery,
manual progress, retained-response verification, explicit earlier-text comparison,
acceptance and reopening through real local HTTP/API/runtime-role PostgreSQL. Eight
browser API requests, no initial requests and no browser errors. Exact new source
text survived reopening alongside both earlier source text and curated unknown rights.
The same bounded run retained authorization, history, stale-revision and competing
metadata-writer checks. Database container cleanup was confirmed.

[Receipt](../parity/reports/geolens-003-local-refresh.json) records source/migration
hashes and limits. This is a component bundle, not full Studio-shell acceptance;
provider bytes and token verification are synthetic. No AWS/provider calls or remote
CI. GeoLens metadata-refresh is now partial with scoped local evidence; independent
pinned comparison, source-update contention and deployed acceptance remain open.

Next examine the pinned GeoLens refresh safeguards against this workflow, exercise
source-update/acceptance contention, and batch the official Studio artifact with any
resulting fixes. Do not rerun unchanged component/database evidence merely for newer
timestamps. Full tracked parity remains the completion target.

## Explicit earlier-response comparison (September 23)

Provider refresh review now offers an explicit selector over source documents already
retained in the loaded knowledge revision. Each choice shows URL, retrieval time and
identity. It reports exact text equality or the first differing line and exposes both
complete texts in inert disclosures. Whitespace, line endings and unknown values are
preserved. A shared URL does not imply the same collection, terms or semantic scope;
no document is preselected, normalized or silently merged. No extra request or write
is made during comparison, and acceptance remains a separate action.

Eleven affected UI cases pass across comparison, refresh review and knowledge editor
checks, including explicit selection, whitespace-only difference, inert markup, exact
text and empty-history behavior. No build/provider/AWS/CI calls. Checkpoint:
`.local-archives/provider-response-comparison-20260923/checkpoint.json`.

The UI now covers deliberate discovery, manual status, response verification, earlier
text comparison and acceptance. Next exercise the complete connected browser/API/SQL
journey, including reopening retained knowledge and source-update contention. Use the
existing local database runner and one bundled affected UI artifact; fixture and SQL
receipts alone are not a connected-browser proof. Independent GeoLens comparison,
deployment and full parity remain open.

## Explicit provider metadata check from the Layer editor (September 23)

The Layer review panel now offers “Check provider metadata.” It reads the registered
source only on that action, derives the ArcGIS collection URL or WFS type name, and
submits through the existing bounded discovery endpoint. Queued/running progress is
read manually; queued checks can be cancelled. A known active job prevents duplicate
submission. Uncertain dispatch retries the same sealed request/idempotency key;
a deliberate new check after terminal status obtains a fresh source and identity.
Unsupported source kinds are disclosed without dispatch. Parent dirty/busy guards
apply to every action. Completed responses use the existing review/acceptance flow.

Twelve affected editor/review/discovery cases pass across three files. ArcGIS and WFS
fixtures verify no initial reads, request reuse after uncertain dispatch, no polling,
active-job duplicate prevention and deliberate fresh checks. No provider, AWS, build
or CI call. This is local DOM evidence, not the connected browser/database journey.
Checkpoint: `.local-archives/metadata-refresh-launch-20260923/checkpoint.json`.

Next provide comparison against explicitly selected earlier retained responses, then
exercise the full browser → local API/PostgreSQL → synthetic discovery completion →
review/accept/reopen journey in one batch. Preserve the existing successful SQL receipt
for its unchanged inputs. GeoLens independent comparison and aggregate parity remain
open; no prepared release includes these UI changes yet.

## Refresh persistence passes; discovery admin mismatch fixed (September 23)

The offline runtime-role PostgreSQL/API journey passed with all 139 migrations.
It verifies account-admin discovery submission/cancellation, viewer submission denial,
normal claim/completion with retained synthetic bytes, candidate lookup, explicit
acceptance, exact source text and unchanged curation, earlier knowledge history,
duplicate rejection, stale knowledge/source revision denial and cross-tenant denial.
Two concurrent metadata writes at the same revision yield exactly one 200 and one
409. The temporary container was removed. [Receipt](metadata-refresh-postgres-20260923.json).

Real SQL exposed a pre-existing mismatch: the API permits account administrators to
manage discoveries, but database insertion, RLS and cancellation required project
membership. Forward migration 0139 aligns these checks with the API while retaining
tenant, actor, request-seal, state and quota checks. No table or record is renamed.
Failed-run receipts are retained: initial fixture-only inspection fields, the trigger
and RLS mismatch, and an oversized synthetic worker lease were resolved before passing.

This proves local API/database behavior, not browser, real provider retrieval or
deployed identity. Source revision mismatch was exercised; an overlapping source
update versus acceptance remains separate from the tested metadata-writer race.
No AWS, remote CI or application build. Archive:
`.local-archives/metadata-refresh-postgres-20260923`.

Next add the fresh discovery launch/status and earlier-response comparison to the
Layer editor, and exercise that connected browser journey against this database path.
Batch the UI build once the flow is complete. GeoLens peer evidence and aggregate
parity remain open; no existing release or deployment request includes migration 0139.

## Layer metadata refresh review connected (September 23)

The canonical Layer inspector now supplies its access workspace to the knowledge
editor. Editors can deliberately list the latest 50 discovery jobs, review completed
collection responses, and accept verified retained UTF-8 text. The browser checks
Layer/job identities, byte size and SHA-256 before showing an acceptance control.
Acceptance sends the loaded knowledge revision and reviewed source revision to the
atomic server endpoint. Provider source text stays separate from curated knowledge.
Dirty metadata blocks listing/review/acceptance; pending requests participate in the
host busy guard. Opening the page does not list jobs, fetch providers or start polling.

Eleven focused comparison/editor/review cases pass across three files, including no
initial calls, dirty-draft guards, exact text, revision pins, explicit acceptance and
corrupt response rejection. No build or cloud calls. The API client validates bounded
candidate shape and accepted knowledge identity. Actual PostgreSQL execution and the
connected browser/API journey are still required; fixture UI is not persistence proof.
Checkpoint: `.local-archives/metadata-refresh-ui-20260923/checkpoint.json`.

The current picker lists only the latest 50 workspace discoveries and instructs users
to run existing source discovery if none are available. An integrated fresh-discovery
launch/status path, pagination and comparison with earlier provider responses remain
next UX work. First exercise the atomic SQL path locally with concurrent revision and
authorization denial cases, then bundle the affected UI build and independent pinned
GeoLens comparison. No parity promotion or deployed completion is claimed.

## Atomic acceptance of retained refresh responses (September 23)

Added a deliberate POST acceptance endpoint alongside the candidate read. Its request
contains the expected knowledge and source revisions. Acceptance holds the dataset
lock shared by source updates and metadata saves, checks Layer edit and job-workspace
management authority, then rechecks the current completed discovery/source binding.
It verifies retained bytes against size and SHA-256, decodes UTF-8 without stripping
BOM/whitespace, and appends a source entry identified by job and content checksum to
the latest knowledge document. Existing curation, normalized/inferred claims and
prior sources remain intact. No rights are inferred or source definitions replaced.

Duplicate response IDs, checksum/size mismatch, non-UTF-8, unretained/oversized bodies,
changed source revisions and stale knowledge fail before insertion. Existing record
limits still apply. Failed acceptance does not partially save a revision. Response
media type is selected from the discovery protocol; original transport headers are
not asserted to have been retained.

Fifty affected local API/helper/repository tests and Ruff pass. They include exact
text/curation preservation and source conflict without insertion. Repository checks
use fake transactions: actual SQL/concurrency and connected browser acceptance remain
open. No AWS, provider call, build, deployment or remote CI. File-backed checkpoint:
`.local-archives/metadata-refresh-acceptance-20260923/checkpoint.json`.

Next connect the adapter/editor to review candidate bytes and explicitly accept, then
run one local PostgreSQL/browser journey including competing source/knowledge updates
and denied access. Reuse the existing discovery job lifecycle for retrieval rather
than polling on page load. GeoLens comparison and full parity remain unfinished.

## Bound discovery refresh candidate read (September 23)

Added `GET /datasets/{id}/metadata-refresh/{project_id}/{job_id}`. This reads an
already completed collection-discovery response under Layer edit authority and the
job workspace's dataset-management authority. One bounded SQL lookup requires matching
current source type/URL and WFS type name, retained response status and completed job.
The result includes the observed source revision. No discovery job, provider request,
metadata save, source replacement or new access grant is created by this endpoint.
The initial registration link and immutable discovery documents remain unchanged.

Fifteen focused repository/route checks and Ruff pass. They cover route edit denial,
workspace reader denial, missing/mismatched candidate rejection, query bindings and
no dispatch/write. Query tests use a fake transaction: actual PostgreSQL execution,
concurrent source-change rejection at eventual save, byte verification and connected
candidate acceptance are still required. No database/cloud run, build or CI was used.
Checkpoint: `.local-archives/metadata-refresh-candidate-20260923/checkpoint.json`.

Next connect candidate selection/review to the Layer knowledge editor and implement
atomic acceptance against both source and knowledge revisions, retaining exact source
text and existing curation. Reuse existing discovery submission/status controls and
limits; do not introduce automatic polling. Then run one local SQL/browser journey
and pinned GeoLens comparison. No parity promotion or deployment claim is made.

## Review replacements before saving knowledge (September 23)

The shared Layer/Project/Publication/Collection knowledge editor now requires a
before/after review when a draft changes or removes saved fields. The confirmation
is bound to the exact proposed JSON and loaded revision; edits or pending guided
entries invalidate it. Additive drafts retain the existing save flow. Invalid JSON
cannot use an old confirmation. Existing optimistic concurrency and append-only
server history remain authoritative; conflicts retain the complete draft.

Ten focused comparison/editor cases pass, including tag removal review, explicit
unknown rights, invalidated confirmation and conflict recovery. The existing removal
test now follows the required confirmation; a new test adapter argument mismatch was
corrected before the passing rerun. No build, provider, AWS or CI call. File-backed
checkpoint: `.local-archives/metadata-change-review-20260923/checkpoint.json`.

Audit found no provider-refresh endpoint in the current knowledge path. Pasted source
text remains explicitly user-supplied, and retained discovery inspection represents
initial registration, not a fresh provider response. Do not relabel either as verified
refresh. Next implement bounded refresh retrieval with source/Layer binding, retained
response evidence and candidate review, then independent GeoLens comparison. The
GeoLens metadata-refresh row stays not_started until scoped evidence is registered;
this safeguard is implemented locally and not included in prior release candidates.

## Metadata revision comparison (September 23)

Resource knowledge history now compares a deliberately selected retained revision
with the saved revision loaded in the editor. Added, removed and changed JSON paths
expose earlier/loaded values separately, including explicit nulls and exact source
text. Source, normalized, curated and inferred namespaces remain distinct. Array
positions are explicitly described; reorderings are not inferred to be semantic edits.
The full earlier JSON remains available. Reads are serialized, drafts survive, and
comparison cannot save, restore or contact a provider.

Focused knowledge comparison and editor checks pass (nine cases across two files).
The initial new test used the wrong adapter argument position; corrected to the
existing ID/options contract and reran both affected files successfully. No application
build, AWS or remote CI. This change is not included in the earlier sealed release.
GeoLens metadata-refresh remains not_started: independent pinned comparison and the
connected refresh/recovery workflow have not been established by this local UI check.

Next connect a reviewed provider refresh candidate to this comparison while preserving
source documents and curation, then exercise conflict/recovery and the pinned peer.
Bundle the affected UI build with the next coherent batch. Deployment authorization
and remaining aggregate parity acceptance remain separate.

## Built managed conversion and current release preparation

The actual built Workbench now has browser evidence for WKT selection, checksum-bound
normalized upload bytes, retained original-file checksum and conversion report, and
invalid-input rejection before upload. The capture adapter made no real storage calls;
one external resource request was blocked and there were no browser errors. The separate
real API/worker acceptance receipt remains valid for its 256 unchanged backend/schema
inputs. Original WKT bytes are not archived; that limit remains explicit.

Prepared a separate Studio release copy, retaining the pristine build and reusing the
verified origin-bound authentication configuration. Release checks pass for 314 files
and seven pages, tree `cd92118acc102aa2ae94f1ffe092b9f24ddd166479762cb6f8a9e29e2d750bc4`.
No rebuild, AWS request, remote CI or deployment was needed. See
[scoped evidence](studio-managed-conversion-built-20260923.json) and local archive
`.local-archives/studio-integrated-current-20260923`.

Demo new-project catalog opening, cleared search, selection without switching Projects,
source reuse and reopen already pass in the prepared Demo browser receipt
[here](demo-catalog-knowledge-20260923-evidence.json). These remain local build results.
The new Studio candidate is outside older deployment request scopes. Static deployment
alone would not deliver the API Publication-directory fix. Next coordinate a current
UI/API release scope and continue unresolved parity acceptance; do not repeat unchanged
builds or infer deployment authorization from continuation.

## Current isolated Studio build and Publication browser check pass

The accumulated UI fixes are bundled in an isolated official Studio build, tree
`fd268801da1fc1ae42936bafd61aaf24c7b5be317b8b7f5dca0cf0fdb4e0d9a5`.
Artifact checks pass: 313 files, seven HTML pages, six aliases. The actual built
Publication workspace passes Artifact edition selection, draft/navigation protection,
save and reopen using its local browser fixture. The backend/schema reuse audit
matches all 256 checked inputs to the successful integrated receipt; do not rerun
unchanged backend acceptance merely to refresh timestamps.

Build staging now retains immutable public embeds and four shared notebook compiler
modules required outside app/. The initial missing-module failures are retained;
the complete dependency set was inspected before the successful retry. Focused staging
preservation checks pass. Existing release candidates were preserved. This is a build
artifact, not a deployed release or an update to earlier deployment approval scopes.

Artifacts, logs and browser receipt are retained in
`.local-archives/studio-integrated-current-20260923`. Next exercise managed WKT selection
through this built Workbench and its registration handoff, then prepare the corresponding
release evidence without rebuilding unchanged inputs. No AWS, Actions or deployment.
Full parity and current deployment authority remain open.

## Complete current local Studio journey passes

The current source-bundled Studio journey passes through real API/PostGIS/GIS worker:
registration and conversion provenance; exact Layer loading, styling, save and reopen;
PMTiles and PNG processing; pinned map-resource revision and composition rendering;
canonical Publication discovery by an invited editor; shared revision; review/publish;
portable ZIP and exact-image delivery; immutable output despite later map edits; source
withdrawal, edition revocation and collaborator removal. Temporary containers and
volume cleanup were verified. No AWS or remote CI was used.

The full receipt, with source fingerprints and migrations 0086–0138 after baseline
0085, is `parity/reports/integrated-studio-current-20260923.json`. A checksum-bound
fixture and scoped evidence ledger link it to `geonode.publishing-administration`.
That row remains partial: this does not prove GeoNode migration, deployed identity,
S3/SQS/KMS, two-person acceptance, backup/restore or product-wide parity. Evidence,
fixture and baseline schemas pass. Other stale fixture seals remain unresolved.
No unchanged old checksum was refreshed to manufacture current acceptance.

Raw receipt, request log, portable ZIP and images are retained in
`.local-archives/integrated-studio-current-20260923`. Prior failures remain separately
available. This pass uses the local source bundle, not the official sealed Studio
build; managed WKT selection itself was not exercised, although its product conversion
helper and registered stored bytes were verified.

Next bundle the accumulated UI/API fixes into isolated current release artifacts and
exercise the affected built UI, including managed WKT selection, while reusing this
unchanged backend receipt where source fingerprints match. Prepared older deployment
requests do not include these changes and remain distinct. Deployment still needs a
current authorized window. Continue remaining parity work; this is not completion.

## Publication discovery, shared editing, export and revocation observed

The SQL-backed journey now discovers the map-and-page Publication for the invited
editor, saves their revision, publishes a reviewed edition, verifies portable ZIP
and exact map/dataset images, checks sealed-image stability, withdraws a source and
confirms public delivery denial, revokes the edition, and removes the collaborator.
The final request was the canonical Publication GET returning 404 as required.

The runner still exited failed because its last assertion waited for legacy Project
GET denial. That assertion now follows the Publication endpoint. The denial page also
now says Publication not found and links to Publications instead of conflating it with
a Project. Five focused recovery checks pass; the first test caught and corrected a
local URL-helper argument mismatch. The corrected final browser assertion has not
been rerun. See [scoped outcome](integrated-publication-revocation-20260923.json).

ZIP, requests and failure remain in
`.local-archives/integrated-publication-revocation-20260923`. Cleanup completed without
reported errors. This is local source-bundled UI with real API/SQL/worker and synthetic
identity/object transport, not deployed acceptance. No AWS, CI or deployment.
Next consolidate a successful final runner receipt and reconcile current evidence
against remaining parity targets. Do not treat this observed workflow as full parity
or silently replace the failed runner result with a pass.

## Publication directory now includes map-and-page drafts

The reviewer acceptance journey exposed a product omission: the authenticated
publication-workspaces query included Framework sources and hosted endpoints only.
A map-and-page draft was absent even after its workspace invitation was accepted.
The query now unions ordinary site records under the same organization, active-
workspace and effective-role constraints, excluding sites already represented by
Framework sources. It remains one bounded read, without builds or per-project reads.
Current title/revision and retained non-revoked edition metadata remain distinct.
No public URL is invented from this authoring record.

API response and client parsing now accept the `site` kind already supported by
the directory UI. Its Open publication action uses the independent Publication ID.
Six focused directory checks and two focused API checks pass; diff whitespace is
clean. These checks do not execute PostgreSQL authorization: the next integrated
run must verify reviewer discovery, editing, publication delivery and revocation.
The preceding run's invitation/map/render/conversion slices passed but the full
journey failed at the empty directory. No aggregate parity promotion.

Logs and failure are retained in `.local-archives/publication-site-directory-20260923`.
The local run cleaned up without reported errors. No AWS, remote CI or deployment.
Next run the corrected SQL-backed journey and investigate any remaining permission
or publication failure before consolidating its receipt.

## Invitation acceptance passed; remaining publishing harness follows canonical routes

The integrated run now creates and accepts the editor invitation through the restored
Publication collaborator controls and real membership API/database. It stopped next
because the harness sought a legacy workspace publishing tab on the settings page.
The current product navigation is Publications directory → canonical Publication URL.
The reviewer now follows those visible controls and verifies the selected identity.

The remaining publication steps were also aligned with the current tabbed editor:
the draft editor/destination already open by default are not toggled closed; publishing
controls are reached through Publish; saved destination/review/publish transitions
wait for the old card to detach before selecting controls in its replacement.
Routes and response codes were checked against current client and API definitions.
Script syntax passes. These revised later steps have not run yet, so collaborator
editing, publication export and revocation are still unproven in this current run.

The earlier map/render/conversion stages passed again. Failure/request logs remain in
`.local-archives/integrated-publication-navigation-20260923`. Cleanup completed without
reported errors. No AWS, remote CI or deployment. Next execute the corrected full
local journey once and retain its complete receipt; do not promote aggregate parity
from the completed invitation slice alone.

## Integrated map styling and save passed; Publication collaboration restored

The local integration passed both Layer style edits, map saving, PMTiles processing,
metadata and dataset PNG work, narrative assembly, saved-map revision and composition
rendering. It stopped at collaborator editing because the newer Publication workspace
omitted the existing collaborator controls. This is not a full journey pass.

The Publication editor now exposes those controls under Workspace collaborators.
The copy explicitly identifies the containing workspace and the wider scope of roles
across Projects, Publications and shared resources. Existing API authorization and
invitation behavior are reused. Merely opening the editor or disclosure does not
load the roster or change access. All eight focused Publication workspace checks pass,
including this regression. The Layer-menu correction passed in the integrated browser.

Evidence/failure and checks are retained in
`.local-archives/integrated-layer-menu-collaboration-20260923`. The run cleaned up
without reported errors; no AWS, CI or deployment. The integration used its local
source bundle, not a new sealed Studio release. Next resume collaborator edit and
publication acceptance through the same local pipeline, then consolidate the complete
receipt. No aggregate parity status or fixture seal changed; full parity remains open.

## Local exact downloads work; Layer action menus no longer overlap

The browser integration fixture now issues synthetic exact-version S3-shaped
URLs only for verified local objects. Its interception checks the exact issued URL,
expiry, method, absence of credentials, object version, byte count and checksum;
it never proxies arbitrary requests. Production URL validation is unchanged.
Focused transport checks reject unissued/expired URLs, credentialed requests and
modified bytes. Current database initialization checks also pass.

The integrated rerun passed managed conversion and loaded both governed Layers.
It then exposed an action-menu obstruction when styling the second Layer: the
first menu stayed open across panel updates. Opening a Layer menu now closes other
Layer menus; choosing a button action closes its menu before rerender. All 29
focused dataset-to-map handoff checks pass, including the new two-menu regression.
This corrects the initial hover-popover description: these are deliberate action
menus, not hover tooltips.

The full journey still failed before map saving/publishing and has not been rerun
after the menu fix. Keep this distinction; no aggregate seal/status promotion.
Evidence and failure remain in `.local-archives/integrated-object-transport-20260923`.
Next run the corrected integrated map/style/save/publish path once, then consolidate
current evidence. Cleanup completed without reported errors. No AWS, CI, full Studio
build or deployment; the local source-bundle integration build was used.

## Conversion registration and worker inspection passed locally

The current-schema integrated journey passed project/service setup and managed
conversion: normalized WKT was registered through UI/API, inspected by the worker,
and reopened from local object transport with its exact checksum and structured
provenance. Conversion runs in Node, so Workbench WKT selection remains unverified.
See [scoped receipt](integrated-conversion-20260923.json). Current dataset reads
succeeded, resolving the earlier stale-schema 503.

The broader journey failed later at map Layer loading. LocalObjects still issues
`local-transport.invalid` tickets rejected by current exact-version S3 validation.
Do not weaken production validation. Next update only the local BrowserObjects
transport to issue contract-valid synthetic tickets and intercept recorded objects,
then resume map/publishing acceptance. Full journey and aggregate parity remain open.

Stored original bytes, worker logs, requests and later failure are retained in
`.local-archives/integrated-conversion-current-schema-20260923`. Cleanup completed
without reported errors. No AWS, remote CI or deployment occurred.

## Integrated conversion acceptance exposed stale harness setup

The integrated Studio journey now includes a normalized WKT registration, worker
inspection, and exact stored-object comparison with its structured provenance.
The helper uses actual registration controls/API/database/worker but calls the
product conversion helper in Node; Workbench WKT selection remains separate.
This new stage has not passed yet.

Two bounded local attempts stopped earlier: the first waited for legacy `project`
navigation after creation switched to `composition`; the second reached the new
route but dataset reads returned 503. Its database was still initialized at 0085,
while current API queries require later schema. The initial missing-link diagnosis
was incomplete: the unavailable page, not simply moved links, explains the timeout.
The source-bundled harness now routes composition/publication identities like the
application. Database initialization now stages all forward migrations after the
chosen baseline, fingerprints those sources, and records the applied list.
Focused initialization checks pass for both normal and 0082-upgrade paths.

Both attempts exited and ran orchestrator cleanup without reported cleanup errors;
logs remain in `.local-archives/integrated-conversion-harness-20260923`.
No AWS, remote CI or deployment occurred. Next rerun the corrected local integrated
journey once, diagnose any remaining API failure, and only then claim managed
conversion persistence. No aggregate fixture seals or parity statuses were changed.

## Managed conversion handoff binds provenance to uploaded bytes

The conversion helper now distinguishes exact original file length from parsed
representation length, which differs for whitespace-padded hexadecimal EWKB.
A local adapter handoff exercises WKT and hex EWKB through the ordinary managed
upload session: request size/checksum match normalized uploaded bytes, and reopening
those bytes preserves original identity, conversion report and the explicit
`originalBytesArchived: false` limitation. Focused handoff and spatial checks pass.
The initial fixture mistakenly padded binary WKB; corrected explicit hex output
passes without widening the parser. See
[receipt](managed-conversion-handoff-20260923.json).

This uses an in-memory upload adapter, not real storage or the API. Next extend the
existing integrated Studio upload journey with this exact normalized-file case and
inspect the stored original through the real local API/worker pipeline. Bundle the
built UI check with that journey. No build, AWS, CI or deployment occurred; fixture
seals and parity statuses remain unchanged.

## Managed geometry uploads retain structured conversion provenance

Managed WKT/WKB/EWKB import previously uploaded normalized GeoJSON with only a
human-readable description and tags. It now embeds `opengeo:conversion` in the
exact uploaded GeoJSON: original filename, format, byte length, SHA-256, and the
full parser conversion report. `originalBytesArchived: false` explicitly prevents
this identity record from implying preservation of the original source bytes.
The existing bounded serializer includes metadata in its output-size checks.
No API schema change or extra upload is needed; the original normalized object
retains the report even if derived render products omit foreign GeoJSON members.

Focused interchange tests pass, including exact original checksum, unchanged source,
normalized coordinates, and conversion provenance surviving a subsequent GeoJSON
read. Workbench syntax passes. This change has not been built or exercised through
managed storage; the previous peer receipt remains scoped to its recorded hashes.
Next exercise the managed upload handoff and reopen the stored original object,
then bundle UI validation. No AWS, CI, build or deployment; parity remains open.

## Current spatial interchange passes the independent local peer

The current metadata-preserving interchange code passes the pinned OpenLayers
10.10.0 peer: GeoJSON/WKT/WKB exchange, authoritative CRS/axis fixtures, bounded
WFS filters, GML reads and single-operation WFS transactions. The focused spatial
interchange checks also pass. Exact input hashes and the full peer result are in
[the revalidation receipt](spatial-interchange-revalidation-20260923.json).
The first run was denied loopback listening by the sandbox; the permitted retry
passed and cleaned up its local service. No external providers, AWS, CI or build.

This closes current format/service regression uncertainty after the metadata fixes.
It does not validate the changed Workbench or managed-ingest interface. Existing
fixture seals and aggregate statuses remain unchanged. Next reconcile that UI
scope against the retained built Demo import/export receipt and inspect the
managed-ingest conversion handoff before updating this fixture. Full parity and
prepared release authorization remain open.

## Historical parity logs retain their original evidence

Six WFS/WMS fixtures now reference an immutable snapshot of `docs/progress.md`
from commit `6d09b31769bb57349d9da85234a704f5cf172022`. Its 598,973 bytes
match every original expected checksum exactly. Only artifact paths changed;
claims, statuses and checksum values remain unchanged. Provenance is recorded in
`parity/references/progress-6d09b317.provenance.json`. This historical narrative
is not proof of current runtime behavior.

The offline parity gate now reports 112 checksum mismatches across
45 paths; all six oversized-file failures are resolved.
The oversized files were progress logs, correcting the earlier suggestion that
implementation-file size was responsible. See
[remaining audit](parity-historical-reference-audit-20260923.json).

Next review changed implementation evidence by owning workflow, starting with
Workbench/catalog and API persistence, reusing the retained built-browser and
connected Postgres receipts only where their inputs match. Do not replace hashes
without the corresponding behavior review. No build, AWS, CI or deployment ran.
Prepared deployment scopes remain unchanged; full parity remains open.

## Parity baseline schema repaired without changing claims

All 33 baseline schema errors were oversized known-loss, missing-evidence or
extension strings. They now use bounded clause chunks; joining each field's entries
with spaces reproduces the original wording exactly. Requirements, acceptance
criteria, row statuses, evidence links and dates are unchanged. The entire baseline
passes its JSON schema without relaxing limits. The before snapshot and per-field
text hashes are retained in `.local-archives/parity-baseline-schema-20260923`.

One offline full parity check still fails with 118 artifact issues across 46 paths:
stale retained checksums and files over the existing 1-MiB fixture limit. See
[the mapped audit](parity-schema-audit-20260923.json), which identifies fixture IDs,
paths and observed hashes without resealing them. The hashes are a point-in-time
audit, not replacement evidence. WorkbenchView appears in 14 issue entries;
apiClient in nine. No passing claim follows from this schema-only repair.

Next resolve evidence by owning workflow and actual changed behavior, using valid
retained artifacts where inputs match. Large path-backed implementation files need
an explicit evidence-scope design rather than blanket checksum refresh or removal
of size limits. Existing prepared release scopes remain unchanged. No build,
container, AWS, CI or deployment occurred. Full parity remains open.

## Pinned GeoLens export wrapper runs against local PostGIS

The unmodified pinned GeoLens export wrapper now executes two real GDAL exports
from four synthetic PostGIS rows. OpenGeo reads projected GeoJSON back within
1e-10 degrees while preserving a literal geometry attribute; GDAL independently
reopens OpenGeo output. The peer's split-antimeridian predicate returns the two
expected seam points. Exact output/source hashes and helper substitutions are in
`parity/reports/geolens-002-export.json`; evidence is linked to GEOLENS-002, which
remains partial. This is not merely a reimplementation of the peer's argument logic.

Configuration, logging, source connection, timeout and tenant-environment helpers
are fixture seams. Full GeoLens routes/authentication, custody mutation and other
formats remain untested; no collection rights can be inferred from SQL export rows.
The cached database has network=none, 512 MiB/one CPU; exports are capped at 20 seconds.
Container removal and socket ownership cleanup passed. Initial setup failure
(missing logger shim/rootless socket ownership) is retained separately; no exporter
change was needed. No AWS, Actions, provider requests or application build.

Run `services/api/.venv/bin/python scripts/check-geolens-export-peer.py <fresh-output-dir>`;
existing output directories are refused. Next extend the connected custody workflow
and explicit rights/loss checks, without promoting this selected format slice to
complete GeoLens parity. Deployment approval and full parity remain open.

## Built GeoJSON import/export retains source knowledge

One isolated Demo build bundles the geometry-named attribute fix and foreign-member
preservation. The real browser journey imports a local GeoJSON file, confirms its
source review, opens Layer properties, and downloads both data and the conversion
report. Downloaded data retains null license, feature license, nested provenance,
geometry metadata and the literal `geometry` attribute. Stale source bbox is absent
from transformed output and present in the report's sourceConversion record.
This caught and fixed the report handoff: export now includes the Layer's import
report, since normalization may already have removed original spatial declarations.

See [built receipt](spatial-metadata-browser-20260923-evidence.json), actual downloads
and manifest in `.local-archives/demo-spatial-metadata-20260923`; tree
`fb5d767026fc7c3920ad0c23efb07bce6c9bf7483a37a87e28acb1b7b7c24358`.
No browser errors or real external/provider requests. The first harness used a
button locator for a menuitem; corrected selector passed against unchanged bytes.
This is built local import/export evidence, not full Demo regression or deployment.
Previously approved/requested candidate identities remain separate and unchanged.

No AWS, CI or deployment. Next continue the pinned GeoLens export-route comparison
using the now-corrected OpenGeo exchange path; preserve the distinction between
GDAL interoperability and execution of the complete GeoLens source/tenant pipeline.
Full parity and current deployment authorization remain open.

## GeoJSON metadata survives interchange

The shared GeoJSON parser/exporter now preserves foreign members at collection,
feature and geometry scope, including nested provenance, unknown license values
and member names that are structural only at another GeoJSON level. They remain
opaque source knowledge, not interpreted permissions or claims of conformance.
Original bbox/CRS declarations are retained with their source paths in the conversion
report; they are not copied onto normalized/reprojected coordinates as stale facts.
Output limits are checked after preserved metadata is included.

Workbench export displays the actual loss report and exposes a deliberate Download
conversion report action after successful export; archived ZIPs already carry that
report with capture provenance. Geometry-only WKT/EWKB explicitly disclose omission
of GeoJSON metadata as well as properties and identifiers. Existing sources remain
unmodified. Focused spatial-interchange and archived-export checks pass, including
nested rights/provenance round trips, scope-specific foreign members, null license,
projected output and source bounds retained in the report. Workbench syntax passes;
the new report-download control has not yet had built-browser acceptance.

No build, AWS, CI or deployment. Sealed release candidates remain unchanged. Next
bundle the geometry-property collision and metadata-preservation fixes, exercise
export plus report download in the built browser, and continue pinned GeoLens export
comparison without treating metadata retention as equivalent to full service parity.
Full parity and the pending deployment authorization remain open.

## Spatial exchange preserves geometry-named attributes

GeoLens export-path inspection led to a reproducible OpenGeo interchange failure:
a valid GeoJSON property named `geometry` replaced OpenLayers' internal geometry
and crashed parsing. The shared reader now chooses an internal key absent from all
input feature properties, including internal-looking user names. Both parsing and
writing use it; geometry transformations and geometry-only WKT/WKB remain separate.
Existing format checks and a two-feature nested-property/projected regression pass.

Independent local GDAL 3.11.5 exchange preserves the geometry-named and nested
attributes, agrees with OpenGeo EPSG:3857 coordinates within 1e-6 metres, and reads
OpenGeo output back to longitude/latitude within 1e-10 degrees. See
[receipt](spatial-attribute-exchange-20260923-evidence.json); exact input/output files
and source hashes are retained in `.local-archives/spatial-attribute-exchange-20260923`.
This is an OpenGeo/GDAL exchange result, not execution of GeoLens's full export
wrapper. GeoLens's pinned wrapper was read (one bounded public source request),
but its database/tenant/export invocation remains untested. No parity promotion.

No Studio build, AWS, CI or deployment. Prepared candidates remain unchanged and
do not include this follow-up. Next inspect foreign-member/license preservation
and loss reporting in the same exchange path, then bundle the completed exchange
fixes into the next affected build. GeoLens client/export route acceptance and full
parity remain open; pending deployment approval is unchanged.

## GeoLens source custody: first pinned executable comparison

GEOLENS-002 now has a scoped executable comparison against unmodified GeoLens
1.20.0 origin functions, its record-type dependency and export-format vocabulary.
The files match the pinned Git tree blob IDs and SHA-256 lock; Apache-2.0 text is
retained. Seven explicit cases cover uploaded, created, registered-table, three
service-copy origins and STAC references. OpenGeo validates their reviewed custody
metadata without inferring license/access rights. Unknown OpenGeo custody stays null;
GeoLens's null-format PostGIS convention is not imported as an OpenGeo default.
Peer managed-table ownership and secret/external-database key rejection also pass.

Run `services/api/.venv/bin/python scripts/check-geolens-custody.py` offline.
See `parity/reports/geolens-002-custody.json` and evidence `geolens-002.json`.
This is pure-function/metadata comparison, not source ingestion, table serving,
STAC asset rendering, export bytes, deletion, or independent-client acceptance.
The row becomes partial, retaining actual format/CRS and connected custody evidence
as missing. Totals: 15 pass, 29 partial, 5 not started, 1 conditional not applicable.
No product parity is established. New evidence and the GeoLens baseline validate;
full schema validation finds 33 existing errors in other product baselines, retained
as a separate limitation. No evidence hashes were refreshed to conceal those errors.

Source inspection used five bounded public GitHub reads (tree plus four files);
there were no Actions, AWS, provider-data, installations or application builds.
Next exercise selected GeoJSON/CRS exchange against a pinned GeoLens export path,
with exact geometry/properties/rights losses, before widening this row's acceptance.
Deployment approval remains pending and is not supplied by goal continuations.

## Consolidated tested Studio and Demo release request

The exact latest candidates are now identified in
[the bounded release request](studio-demo-release-request-20260923.json): Studio
`0b241e893a752eb4…` and Demo `13253a46b6f2e515…`. Together they contain 486 deployment
objects and 18,486,913 artifact bytes before aliases/manifests. The requested bound
is 32 MiB upload, 2 invalidations, 2,000 cloud requests and 30 minutes, one execution
within 60 minutes of explicit approval. Preflight is capped at 20 reads and must
verify ownership, current origins, immutable hashes and browser-only Demo topology.
Stop on mismatch or concurrent changes; retain prior immutable origins for rollback.
No API, data, IAM or remote-build changes are included.

A fresh approval question names both candidates and supersedes the pending request
for older Studio tree `c06ad387a9f4b267…`. It has not been answered; automatic goal
continuations do not authorize deployment. No cloud calls occurred in preparing this
scope. The preceding connected local persistence receipt remains valid.

Independent continuation target while approval is pending: inspect the pinned
GeoLens source-custody/exchange baseline and retained source lock, then identify
executable import/export and custody cases against the existing OpenGeo paths.
That required row remains `not_started`: prior catalog/metadata/browser evidence
must not be relabeled as an independent GeoLens comparison. Avoid further cosmetic
Catalog increments or rerunning unchanged builds as a substitute for that evidence.
Full parity and hosted acceptance remain open.

## Built Artifact selection reaches real local persistence and compilation

The sealed Studio candidate's retained-edition chooser now passes the existing
API/runtime-role PostgreSQL browser journey. It saves a cross-workspace pinned
reference, reloads it, prepares immutable Artifact inputs, creates one browser-requested
Publication build, reopens the compiled preview and delivers its embedded exact
Artifact. Reopening unchanged selection reuses the build. The broader connected
runner verifies current-pointer advancement without changing prior pins/input
manifests, conflict detection, tenant denial, lease actor checks, upstream revocation
and exact-version download denial. Twenty-one browser API requests; no external
requests. The cached network-none PostgreSQL container was removed successfully.

The runner now accepts `OPEN_GEO_ACCEPTANCE_DIST` so it can exercise sealed output
without rebuilding or substituting the shared working dist. The new edition chooser
is exercised explicitly instead of relying on the former numeric v1 default.

See [connected receipt](publication-choice-persistence-20260923-evidence.json).
Release tree remains `0b241e893a752eb4e214dae7f18cf5e30a61cbbf31dc52645bfaeda3e71ef74b`.
This upgrades fixture-only persistence evidence for reference/preview controls:
the database, runtime permissions, API and exact-byte compilation are real locally;
token verification, object-storage transport and CloudFront delivery remain fixtures.
It is not live managed-login, multi-user/device, paid-storage or hosted acceptance.
No AWS, CI, deployment or new Studio build. Next reuse this candidate and connected
receipt for a freshly authorized bounded hosted journey; do not repeat local builds
or promote aggregate parity without the remaining row-specific evidence.

## Bundled Studio Publication workflow passes built acceptance

One isolated Studio build bundles the retained-edition chooser, Publication reference
draft guards, and the latest shared browser catalog metadata/Project-scope fixes.
The actual built ProjectPublishingWorkspace passes an intercepted Chromium journey:
choose retained v4 → switch Publication → blocked navigation reveals original draft
→ account change blocked → save pending/refresh blocked → success → remount and
reload the same v4 pin. Two fixture reads, one edition metadata read and one save;
zero external requests and page errors. This proves built UI behavior with adapter
fixtures, not real persistence, authentication or hosted acceptance.

Release checks pass: 314 files, seven pages, six aliases; release tree
`0b241e893a752eb4e214dae7f18cf5e30a61cbbf31dc52645bfaeda3e71ef74b`.
The tested Demo's Workbench, registration component and attachment helper match
exactly. All 20 editor artifact files were compared: executable content is unchanged;
one Framework filename changed in its license footer and manifest, with identical
license text. Reuse records distinguish this from exact-byte equality. The first
browser harness run passed workflow assertions but Playwright's service-worker
blocking injected errors into opaque editor frames; the unchanged build passed
with that override removed and all requests still intercepted. Failure retained.

See [evidence](studio-publication-choice-20260923-evidence.json) and candidate
`.local-archives/studio-publication-choice-20260923`. Older candidates remain intact.
No deployment, cloud or CI calls occurred. Next review fresh authorization/current
preflight for this exact Studio candidate; previous pending approval describes a
different tree and is not transferable. Demo remains separately prepared. Full
parity, real multi-user persistence and hosted acceptance remain open.

## Inspect retained editions before Publication insertion

Publication Artifact selection now loads retained edition metadata deliberately
before insertion. The chooser names the current version (when set) and the returned
history versions, distinguishing a moving current reference from a fixed pin. An
unset current pointer is not offered. Changing workspace or map clears the inspected
selection; saved drafts remain intact. Adding and saving reuse that metadata without
reading output bytes or launching builds. Server authorization and revision checks
still apply when saving and preparing inputs. History remains bounded by the existing
100-edition API contract; no unbounded history or new conformance claim is implied.

The numeric editor for an existing reference no longer invents v1 when the version
is unknown. Newly inserted pinned references retain the chosen version. Focused
reference and integrated Publication workspace tests pass: current selection,
cross-workspace reset, unset-current history, exact v4 pin/save, one metadata read,
conflict preservation and draft navigation. These are local DOM/adapter checks;
built Studio, real persistence and hosted acceptance remain separate. No cloud, CI
or build occurred. Next bundle the edition chooser and draft continuity with pending
shared Studio source changes into one isolated build and exercise the built workspace.
Prepared Studio/Demo artifacts remain unchanged; full parity stays open.

## Publication Artifact reference draft continuity

Artifact-reference controls now participate in the existing Workspace navigation and
refresh guard. Unsaved edits and in-flight actions prevent leaving, account changes,
Back and refresh through that shared guard. A blocked action reveals the Publication
owning the draft and selects its Settings panel, even after another Publication was
selected. Switching retained panels still preserves drafts without starting builds.
Success or explicit discard releases the guard; failed saves retain the draft.

The real ProjectPublishingWorkspace, reference editor and shared guard pass a local
DOM integration journey: edit → switch Publication → attempt navigation → reveal
original draft → save → blocked refresh during save → success. Existing reference
conflict/identity and authored metadata guard checks also pass. This is local UI
integration with an adapter fixture, not database, browser-rendering or hosted
acceptance. No build, CI or cloud calls. Next bundle these Publication changes with
the pending shared Studio updates and exercise the built workspace before release.
The sealed candidates remain unchanged; full parity remains open.

## Catalog review stays with its originating Project

Demo file, service and catalog review now capture the originating Project before
source loading. Late results cannot open a review after New Project or after the
workbench is detached/disposed. Confirmation rechecks the destination; a stale
review explains the change and allows cancellation. Pending confirmation cannot
submit twice or be dismissed with Escape while its addition is underway.

Bundled with the preceding metadata preservation fix, one isolated Demo build
passes the full existing source-registration/catalog browser journey. Tree:
`13253a46b6f2e515b60b64503a042035beac168d9b329eb0cb4a2c301f7cd13a`.
The new race and nested-knowledge cases pass focused DOM/storage checks; the built
journey covers actual rendering, Project continuity, local reuse, save/reopen,
remote review and mobile dialogs. Zero external providers/private requests/errors;
56 intercepted service requests. The prebuilt release check passes, 164 files and
165 eventual objects. See [receipt](demo-catalog-knowledge-20260923-evidence.json).

The new isolated candidate is `.local-archives/demo-catalog-knowledge-20260923`.
Prior copied receipts are segregated under `prior-candidate-reference`; they do
not establish this candidate's acceptance. Previously prepared Studio/Demo releases
remain untouched. No cloud, CI or deployment occurred. Next use this newer Demo
candidate for a freshly authorized bounded release/preflight; bundle shared source
changes into a subsequent Studio candidate. Full parity and hosted acceptance remain
open. Source changes do not extend any prior deployment authorization.

## Catalog reuse preserves metadata knowledge

Reviewing an existing browser catalog Layer now retains its nested source,
normalized, curated and inferred fields and additional metadata namespaces. The
four editable review fields are merged rather than replacing the whole record.
Explicit null curated values remain blank on reopen instead of falling back to
provider terms. Preview feature count/CRS normalization remains separate from
preserved source facts; input catalog objects are not mutated.

Focused dialog → confirmation → actual catalog serialization → reopen checks pass,
including nested evidence, unknown license, cancellation and clone isolation. The
existing storage quota/reset checks also pass. This is local DOM/storage evidence,
not a new built-browser or deployed acceptance claim. No build, AWS or CI calls.
Prepared release artifacts remain unchanged and do not contain this follow-up.
Next bundle this source change into the next affected release and reuse the existing
Demo catalog browser journey for built acceptance. Hosted release authorization
and full parity remain open.

## September 23: Reusable prebuilt browser Demo release path

The existing Demo deploy/rollback commands now accept explicit
`OPEN_GEO_DEMO_SURFACE=browser` for production while preserving managed-production
and browser-development defaults. `--prebuilt` reuses sealed artifacts;
`--local-check` also skips rebuilding and performs no AWS calls. Anonymous release
validation rejects private/auth artifacts and enforces one page, no aliases,
200-file/20-MiB limits. Existing account/OAC/edge/CloudFormation checks remain; an
API-bearing edge is rejected rather than modified. Rollback preserves the selected
surface and validates its target manifest before mutation.

The new path passes against the exact tested Demo: 164 files, 165 eventual objects.
Focused surface/boundary and release-safety checks pass; zero cloud calls or builds.
See [operating contract](browser-demo-release.md) and
[local receipt](demo-prebuilt-release-path-20260923.json). The expired dated Python
helper is retained as history and must not be executed. Next obtain a fresh bounded
Demo authorization and perform read-only current edge/owner preflight before any
publication. Studio approval remains separate and pending; full parity is open.

## September 23: Replacement Studio candidate includes tested attachment startup

The replacement Studio release is sealed and passes the release check: 314 files,
seven pages; tree `c06ad387a9f4b267a966a389efbd38f5fe8955317c01b6ba4b41a90db64d95b5`.
WorkbenchView and whenConnected are byte-identical to the corrected Demo whose full
catalog/render/save/reopen journey passed. The three recent Studio component groups
and all 20 editor artifacts match their tested bytes, so those checks were reused.
The older paired land-cover browser receipt remains tied to its original Workbench;
it is not silently relabeled as acceptance for this replacement.

See [replacement identity and deployment scope](studio-startup-candidate-20260923.json).
The prior candidate remains do-not-deploy. This replacement still needs current
production authorization and preflight; no cloud or CI calls occurred. Demo remains
separately prepared, with its expired deployment helper requiring replacement before
execution. Next: authorized bounded static release of this exact Studio candidate,
or independent local Demo release-path work while approval is pending. Full parity
and hosted signed-in acceptance remain open.

## September 23: Demo catalog acceptance exposed and fixed deferred map startup

Demo can construct WorkbenchView before Observable attaches its returned element.
The recent disconnected-shell guard permanently skipped initialization in that case.
The workbench now waits for actual attachment and initializes once. The shared
helper supports cancellation and ignores later detach/reattach cycles. Demo staging
also includes the missing reviewed-display identity helper and new attachment helper.
The earlier sealed Studio candidate is explicitly superseded/do-not-deploy because
it contains the old startup behavior; its deployment approval question is withdrawn.

The corrected isolated Demo passes the complete source-registration/catalog browser
journey: New Project opens the unfiltered catalog, selection retains Project identity,
KML renders/fits, independent metadata and source reuse survive save/reopen, native
project files reopen, and the mobile dialog passes. All provider requests were
fixtures (84), private requests and browser errors zero. The public boundary/seal
check passes: 164 files / 5,252,539 bytes; tree
`4c59ff75cba9180e8fa43b0b4a3221fc17accb2787cc4051232f75ec9d6fef26`.
Focused lifecycle, Demo and release-safety checks pass. See
[Demo acceptance](demo-catalog-startup-20260923-evidence.json).

Failed staging, missing dependency and pre-fix browser results remain retained.
No cloud calls or deployment occurred. Next prepare a replacement Studio candidate
containing the shared startup fix and validate its affected map startup; keep Demo
as a separate sealed candidate. The old browser-Demo deploy helper has an expired
date-specific grant and must not be executed. Establish fresh bounded deployment
scope/authorization before publishing either candidate. Full parity remains open.

## September 23: One sealed Studio candidate consolidates local fixes

The changed generated editor bundles now pass checks using the exact sealed
candidate: Framework reactive inputs, attachments/imports and real root cards;
Jupyter highlighting, local PNGs, stale-load/invalid-edit recovery and sandboxing;
Observable notebook reactive cells, local attachment and opaque preview. No rebuild
was needed. The notebook harness first reported service-worker getter errors with
Playwright's blocking context; normal context passes on identical bytes, with
external traffic still intercepted. Both results are retained. See
[editor acceptance](studio-candidate-editor-acceptance-20260923.json).

Local release checks are complete for this batch. The prepared static deployment
would create 320 distinct objects and transfer 13,448,581 bytes including metadata
rewrites, update the existing Studio origin, and issue one invalidation. It excludes
API, dataset and Demo changes. Obtain current deployment authorization and confirm
the current origin before execution; retain its rollback path and previous releases.

Prepared and checked the current isolated Studio release without rebuilding:
313 files / 13,228,754 bytes; release tree
`8c7c4b9a881dcfad46f3191fccde3c02823d6b24e2b3aa34e4ff7c2812172638`.
Retained public auth configuration is unchanged from the recorded deployment.
Eleven exact tested frontend files match across release recovery, Collection preview
recovery, authored metadata navigation and paired land-cover acceptance. Reuse those
receipts for their unchanged scopes; no browser journeys were repeated here.

The retained deployment comparison also exposes changed generated editor/preview
bundles. Do not equate those changed hashes with accepted unchanged outputs. Those local checks now pass as recorded above. Establish current deployment
pointer/authorization before publishing. This is not deployment approval or a
live-state observation; no AWS/CI calls occurred.
Demo release remains separate. See [candidate, delta and next steps](studio-bundled-candidate-20260923.json).

## September 23: Authored metadata guards surrounding navigation and accounts

The isolated Studio build and release check now pass (312 files; tree
`2554faaf98f3eb66…`). Chromium exercises both Project and Publication metadata with
the real StudioAccountControls component outside the host: same-tab links, account
selection and sign-out are blocked over a draft, and sign-out stays blocked while
a save is pending. After save, account switching/sign-out each work once. Canonical
resource identities are checked by the fixture adapter. Zero external requests or
page errors. See [browser evidence](authored-metadata-navigation-20260923-evidence.json).
This is built-component acceptance with fixture persistence/auth, not full workspace
rendering or live authentication. The first harness attempt omitted opening the
advanced editor; its failure is retained, and the corrected test reused the build.

The actual ProjectWorkspacePage plus StudioAccountControls DOM integration also
passes: the account component is outside the workspace; sign-out cannot start over
an unsaved Project metadata draft, then proceeds after the independent metadata save.
The test verifies canonical map identity, one metadata save and zero map-content
writes. This extends isolated guard evidence to the real component wiring, but does
not establish browser graphics, live authentication, or full deployed-shell acceptance.

The Project/Publication metadata host now intercepts same-tab links and account
commands across the document, not just inside its panel. Account selection is
restored while a metadata draft/request is pending and its change event cannot
reach the switching handler. Newly inserted account controls are tracked; normal
account changes resume after save/discard. Detached hosts do not block navigation,
and disposal removes document listeners and remembered controls. Modified/new-tab
link gestures retain their usual behavior.

Focused tests exercise both authored resource kinds with navigation, sign-out and
account selection outside the metadata host, then verify successful switching after
save and independent metadata reopen. The existing release guard regression also
passes. No API/schema, metadata authority or content-save behavior changed. This is
local DOM acceptance, now supplemented by the built-component checks above.
Next exercise the full account shell/live-auth path in an authorized bundled release;
no cloud or CI was used for local validation. Overall parity remains open.

## September 23: Collection preview failures retry without reopening drafts

Image-fetch failures now also enable deliberate retry. Successful metadata refresh
replaces prior figures and eligibility results, prevents duplicates, and keeps the
four-preview bound. Detached image callbacks cannot change the current view.

The isolated Studio build and sealed release check pass (312 files; tree
`59d4103e3166d607…`). Chromium passes metadata failures, image failures and successful
retries in both gallery/member views, with actual PNG decoding, no duplicate figures,
an unchanged unsaved title and preserved member links. Six explicit fixture metadata
requests and three image reads; successful image bytes were reused by Chromium.
The first test incorrectly required four image reads; that result is retained, and
the corrected bounded cache-aware check passes without rebuilding. Zero external
requests. See [built-browser evidence](collection-preview-recovery-20260923-evidence.json).
Real API authorization, full-shell and hosted acceptance remain distinct and open.

Gallery and member preview request failures now re-enable their existing load
buttons and explain in-place retry. Member failure handling checks the selected
Collection before updating controls. Unsaved title/member state and text links stay
intact; no automatic retry, provider polling or extra successful-preview reads were
introduced. The focused Collection regression passes failed/successful retries in
both views, retains the unsaved title and members, and verifies exactly four
explicit adapter requests. Existing Collection checks also pass.

The initial DOM increment is now followed by the built-browser acceptance above.
Next include this tested change in the next authorized bundled Studio release;
full-shell, real authorization and overall parity remain open. The completed
image-release recovery evidence remains valid for its unchanged component inputs.

## September 23: Confirmed image release survives history refresh failure

The isolated current-source Studio build and sealed release check now pass
(312 files, seven HTML pages, six aliases; tree `097b91963ba62fec…`). Chromium
exercised the built ArtifactReleases component through confirmed publish and revoke,
failed history refreshes and manual recovery. Both mutations ran exactly once;
revoked links disappeared immediately. Zero external requests and page errors.
See [built-browser evidence](release-history-recovery-20260923-evidence.json).
This establishes component/browser behavior with adapter fixtures, not real API
persistence, full-shell or hosted acceptance. Shared build output is unchanged.

Artifact release authoring now distinguishes a successful mutation from a failed
follow-up history read. Confirmed publish closes the draft and reports the created
release ID even if history is unavailable; confirmed revoke immediately removes
that row's public link and revoke action. Both offer the existing Load public releases
recovery without replaying the mutation. History rows are staged until all public
URLs resolve, avoiding partial replacement on a failed refresh. Unconfirmed mutation
responses retain the existing idempotent draft/retry behavior.

The DOM regression exercises publish and revoke success followed by history failure,
manual recovery and one mutation call each. Existing draft-store and navigation-guard
checks pass (three focused test files), as does affected whitespace. The initial checks were local component evidence; the subsequent isolated build
and browser acceptance above close that local validation step. Deployed and full-shell
acceptance remain open. Next include this tested change in the next authorized
bundled release and continue remaining release/full-shell parity.

## September 23: Fix actual mixed-archive rendering and geographic filing

Small Overpass previews were rejected by the API's narrower GeoJSON contract;
earlier browser fixtures bypassed that parser. Eligible managed GeoJSON now uses
its exact authorized original at every supported size, still only on activation.
The managed reader allows bounded nested property data (eight levels, 400,000 nodes,
bounded arrays/strings, unsafe keys rejected); the public archive contract retains
its scalar default. Failed complete-layer reads now report failure instead of
silently saying ready. WebGL constructor failure retains the shell and exposes a
deliberate retry. No API/native deployment was needed.

The real six originals pass browser rendering; the four Nepal layers render together.
Both-account exact tickets pass; hidden reads and repeat visibility reads remain zero.
Forced WebGL failure and denied-download retry pass. Two Indian protected-area
records/maps and S3 filing were corrected without new uploads. The concurrent raster
zoom-range validation delta was explicitly reviewed and its focused tests pass;
LayerArchiveControl changed only through dependency hashes. Five published files
match. Hosted signed-in browser acceptance remains distinct. See
[the evidence](nepal-india-rendering-correction-20260923.json).

## September 23: Mixed OSM batch uses existing ingestion and viewer

The retained Nepal OSM helpers now accept an explicit mixed batch with separate
plans and receipts. Three exact originals are partitioned into six disjoint geometry
families; all feature IDs/properties/coordinates and export headers are retained.
1,017 features pass equality review. All jobs, both-account reads, exact download
authorization and 24 private derivative checksums pass. Corrected the verifier's
old assumption that every original has a null S3 version; it now compares each
record's actual version immutability. The existing built viewer renders all six
layers and matches five deployed files, without app changes. The grouped, all-off
map is persisted and readable by both accounts. Hosted sign-in remains untested.
See [evidence](nepal-mixed-osm-20260923-evidence.json).

## September 23: Metadata snapshot reconciliation complete

The existing metadata reader/linker now supports the retained Nepal catalog
snapshots and receipt-backed updates to the current coverage manifest. All 51
exports match their historical catalog revision and owner. Exact S3 versions and
checksums are linked; both-account readback passes for every record. One redundant
embedding hit the existing 49,152-byte metadata limit after 12 records; the remaining
39 use references to preserved exports and the completed records were not repeated.
No new dataset, S3 write, API/UI change or deployment. See
[evidence and scope](nepal-metadata-snapshot-links-20260923-evidence.json).

## September 23: Roads processing and account verification complete

The Nepal roads registration and processing helpers now share their bounded path
with land use via `--layer`, retaining distinct plans and receipts. After an
interruption, the exact abandoned worker lease was released through the supported
function only after checking the process and destination. The resumed job completed;
both accounts, 472,828 features, EPSG:4326, five original-file links and four private
derivative checksums pass. No original upload was repeated. The optional PMTiles
candidate is rejected for 64 missing identities; no display admission or new
deployment occurred in this batch. Hosted browser rendering remains unverified.
See [the current batch ledger](nepal-large-osm-20260922-progress.json).

## September 23: Nepal land-use display deployed; buildings conversion complete

The 179,240-record Nepal land-use PMTiles display is now privately preserved and
attached to its existing catalog Layer and exact managed version. Migration 0138,
the API image and tested Studio controls are deployed. Both Aaron and Categorise
pass production runtime readback; four verified private index/header reads total
261,824 bytes. Ten published Studio files match the tested build. Original S3 files,
account grants and initial visibility are unchanged. The native build has zero
high/critical findings in both scanners; its instance, volumes and NAT are removed.

Managed storage required one additional exposed response header, `Content-Range`.
Its exact CloudFormation change and unchanged policy dependencies were reviewed;
no origins, methods or permissions changed. Real PostgreSQL acceptance covers all
138 migrations, exact versions, workspace isolation, download rights and revocation.
The focused infrastructure check, foundations and whitespace pass. Aggregate parity
still has shared checksum failures. Hosted signed-in browser acceptance remains open.
See [release and admission evidence](nepal-managed-display-release-20260923-evidence.json).

Buildings session 31200 is terminal success: all 5,085,029 features pass exact
coordinate/property roundtrip verification. Its 1,501,431,024-byte GeoJSON and the
completed 472,828-record roads conversion must be reused. Next close their catalog
and display gaps, then reconcile retained inventory coverage and project attachments.
Do not restart the independent Bhutan land-cover worker or bypass its approval.
The full ingestion goal remains incomplete. Apply the
[delivery and concurrent review instructions](logbook/ingestion-delivery-and-concurrent-review.md).

## September 22: Managed tile viewing verified; ingestion closure takes priority

The land-use candidate passes the actual built Studio **Map display** selector,
including all eight repaired tiny polygons. The overview and eight detail visits
read 7,944,418 bytes in 15 intercepted storage requests; all-off open, metadata
review and hidden movement preserve the no-download behavior. API tests and the
actual migration/RLS constraint fixture pass. The Studio build and build check pass.
Migration 0138 binds a reviewed display to an exact managed version without a
fabricated live connection. This is local implementation, not production admission.
See [evidence and concrete next actions](nepal-managed-display-20260922-evidence.json).

The user explicitly called out the excessive time spent. Follow the new
[ingestion delivery and concurrent review rules](logbook/ingestion-delivery-and-concurrent-review.md)
and AGENTS.md: reconcile existing catalog/S3 identities, batch ordinary records,
reuse verification and isolate exceptional data; optional UI work must not expand
the completion set. Finish this tested integration, preserve/admit the land-use
display once, then close remaining registration and inventory gaps. Do not restart
the independent Bhutan land-cover worker or bypass its pending approval boundary.

Buildings session 31200 remains active, last observed past 4 million of 5,085,029
exact round-trip checks. Poll that handle before any restart. No cloud mutation or
new source download occurred in this batch. Foundations and whitespace pass;
aggregate parity retains shared checksum failures, and app.py has two unrelated
existing long-line lint failures. Do not reseal evidence to hide these limits.

## September 23: Current viewer admission retains original preservation evidence

`preserve-bhutan-additional-tiles.py --current-paired-viewer` now allows admission
to validate a separately exercised current frontend without repackaging unchanged
archives. This option is admission-only. It requires the identical raster receipt,
actual raster checksum and complete polygon/vector/browser validation, then matches
the current viewer's deployed frontend evidence. Provenance retains the original
preserved browser review plus the new review, both receipt hashes and deployment
receipt. It does not substitute fresh hashes into historical acceptance.

Four focused integration checks pass: planning and execution reject the override;
a changed raster is rejected; the real current-viewer evidence passes until the
missing deployed API receipt. Syntax and whitespace pass. No build, cloud call,
upload or catalog mutation occurred. See
[integration evidence](lulc2010-current-viewer-admission-20260923.json).

Next: after the pending exact preservation approval, retain versions/checksums and
establish current API and seven-file frontend deployment evidence. Use the original
paired directory for preservation and the separate current-viewer directory for
admission acceptance. Full parity and hosted signed-in acceptance remain open.

## September 23: Current Studio build passes paired land-cover acceptance

The current built application passes the complete paired LULC 2010 journey with
all 49 fine-component probes freshly exercised, six raster checks, detail zooms,
visibility/style reload and saved-source return/reopen. One deliberate archive
reselection passes the explicit download choice again. Session 73652 completed
with exit zero: 109 intercepted range reads / 9,840,291 bytes, no external calls.
The admission validator also passes against this separate current-viewer receipt
(32 sidecars; no reused-probe receipt needed). See
[current-build evidence](lulc2010-current-viewer-20260923.json).

No rebuild or archive conversion was needed. The original 37-object preservation
plan and prior browser receipt remain unchanged; the new evidence is in
`7d7f0e0fa036251c-current-viewer-20260923/selector-review`. Private preservation
approval remains pending. Next release work must match these seven frontend files,
retain the newer acceptance as an additional evidence record, and establish the
current API/security/runtime and exact preserved-version evidence before admission
to the existing Layer. Do not overwrite the pending preservation package or treat
this local browser result as hosted sign-in acceptance. Full parity remains open.

## September 23: Paired land-cover admission integrated; preservation prepared

The polygon-component admission gate now validates the complete source identity,
attributes, topology, component/hole coverage, packed bytes and actual browser
journey together. It retains the existing line/soil gates. The real candidate's 33
sidecars pass; eight existing admission tests pass and five damaged-evidence cases
are rejected. The validator hash still matches that acceptance evidence. See
[admission validation](lulc2010-admission-validation-20260923.json).

The offline preservation plan contains 37 unique payload objects (365,346,539 bytes)
and one manifest, including both display archives and their provenance. Its logical
minimum zoom is 7; vector detail starts at 12. Exact plan SHA-256 is
`6d7a58e955e4844919335c97d446dc85d581192ad2c3aaec8d6b6876be123204`.
See [destinations, bounds and requirements](lulc2010-preservation-plan-20260923.json).
No cloud write, catalog change or deployment was performed for this package.

Next: await explicit authorization for this exact private preservation run, then
retain object versions/checksums. Admission must reuse Layer
`1ce9e746-5200-4edc-bab2-de36aee45584` and requires the matching seven-file deployed
frontend receipt, paired API/security/runtime evidence, and authority/source-revision
readback. Coordinate release integration with the current application; do not deploy
the older isolated viewer snapshot over newer fixes. Reuse the completed build and
local evidence wherever their input identities still match. Full parity remains open.

The offline [release comparison](lulc2010-release-gap-20260923.json) finds all five
archive-rendering modules unchanged in the current build. WorkbenchView has newer
map-startup and dataset-error handling; LayerArchiveControl changes its reader import.
The retained paired API source hash also matches, but that alone does not prove the
current deployed runtime. Current-build acceptance is now complete in a separate receipt directory, as
recorded above. The original package candidate and browser evidence remain intact;
newer hashes were not substituted into the older receipt.

## September 23: Complete local paired land-cover viewer passes

Browser session 37458 is terminal success. All 49 component probes are accounted
for: 44 completed probes were reused only after vector, raster and all seven tested
frontend hashes matched; the remaining five were exercised. One viewport correctly
contains fine geometry but no ordinary geometry, independently proven from native
coarse envelopes. Six raster pixel checks and detail zooms 12–13 pass, along with
visibility/style reload, saved source identity, return-to-live and reopen behavior.
The resumed journey used 49 intercepted reads / 5,191,840 bytes and zero external
requests. This is local actual-viewer evidence, not hosted authorization acceptance.

All final native identities/attributes, packed read budgets and full fine component/
hole correspondence also pass. Admission integration and the offline preservation
plan are now complete, as recorded above. Private upload and deployed catalog
admission still require their exact release and authorization evidence; no cloud
write or deployment occurred here. See
[complete local receipts and next actions](lulc2010-display-progress-20260922.json).

## September 22: All conversions complete; national overview exceeds capacity

All 53 batches pass native checks, accounting for 690,239 records. Final wave
17651 is terminal with exit zero. The ordinary merge staged all 31,265 tile
payloads (617,569,300 bytes), then correctly stopped at tile 7/96/53: its decoded
payload is 45,811,862 bytes, above the existing 16 MiB reader limit. Session 18155
is terminal with exit 1; staged SQLite chunks and all inputs remain reusable.

A targeted lossless probe removes only duplicate or between-collinear vertices,
with unchanged directed edges and ring signed areas. It reduces 9,168,535 vertices
to 6,797,676 but still yields 41,028,501 decoded / 21,001,953 compressed bytes for
331,930 feature records. It is not an acceptable display. Do not repeat source
conversion or raise limits. Next use an explicitly declared scale-appropriate
overview (evaluate the retained `symb2010` land-cover classes or raster overview),
while retaining complete per-record identities and attributes at detail zooms.

Corrected fine geometry already has complete component/hole coverage. It remains
reusable; final combined archive, packed/renderer budgets and actual viewer
acceptance are pending. All processes in this slice are terminal. No cloud calls,
CI, app rebuild or deployment. See [merge and lossless diagnostic](lulc2010-display-progress-20260922.json).

## September 22: Clipped-ring diagnosis; full triangulated coverage running

Component `390789:0` is valid before clipping, including global-grid rounding
at zooms 19–22. Its 42 native fragments include six invalid standalone polygon
representations. Without changing any source or native ring, the installed
Earcut 3.0.2 stage produces 282 triangles whose union preserves the component's
fill and hole within two zoom-19 grid units (0.018661 m). Both missing-fill and
unexpected-fill GEOS differences are empty at that tolerance. This narrows the
problem to clipped representation and validation semantics; one component does
not establish full geometry or actual rendering acceptance.

The exporter now optionally retains native fill triangles using classified rings
and the installed Earcut stage. All corrected components were exported on session
68657 (terminal exit zero). Independent full-component GEOS coverage is running
on **34391**, with one thread, 2 GiB memory, 660 CPU seconds and a 720-second outer
wall timeout. It verifies triangle validity and compares complete source fill
in both directions; it does not MakeValid the native polygons. Keep the earlier
raw-ring failure. MapLibre subdivision, packed output and browser checks remain
separate. Conversion wave **50501** remains live; do not duplicate either process.
Syntax checks pass. No cloud calls, CI, app build or deployment. See
[diagnostic and coverage evidence](lulc2010-display-progress-20260922.json).

## September 22: Coverage review rejects native self-intersections

The stalled coverage process was traced to GDAL native import with default OpenMP
threads under the 2 GiB address-space cap. A bounded diagnostic reproduces it;
OMP_NUM_THREADS=1 imports in under one second. The exact stalled process was
terminated (session 25663 exit 143), preserving the diagnostic. The checker now
sets OpenMP/GDAL/OpenBLAS to one thread and the rerun had a 720-second outer timeout.

The rerun is terminal (96821, exit 1) after 5.32 seconds. Nine parts pass bidirectional
coverage; component `390789:0` then fails native geometry validity. Inspection of
its 42 fragments identifies six with ring/self-intersections. Their exact decoded
geometries are retained without repair. This contradicts geometric acceptance;
the earlier positive-area/ring-count probe remains a narrower result. Do not use
MakeValid merely to turn the verification green. Next determine the quantization
or clipping cause and ensure the actual generated/rendered polygons preserve
fill and holes before rerunning coverage or admitting polygon-component output.

Wave 10–17 completed in 393.10 seconds (50988 exit zero). Batches 0–17 have native
identity/attribute/positive-area evidence; this does not override the geometry
failure. Wave 18–25 is live on **50501** with unchanged serial bounds. Poll that
handle, retaining completed work. No cloud calls, CI, app rebuild or deployment.
See [failure and exact fragment evidence](lulc2010-display-progress-20260922.json).

## September 22: Full component coverage export complete; GEOS review running

The corrected zoom-19 probe now exports every native decoded fragment with its
component identity in EPSG:3857. The checksum-bound export contains 126,786
fragments in 58,220,199 bytes and completed in 9.99 seconds. Earlier probe receipts
remain unchanged. Export session 25183 is terminal with exit zero.

The independent GEOS checker indexes fragments on disk and unions each component,
then checks source versus native fill in both directions using a two-grid-unit
buffer. This includes hole interiors, not just sample points. It is running on
session **25663** with 2 GiB address space / 660 CPU seconds and a 600-second
geometry-loop bound. It has not produced its first receipt yet; poll the exact
live handle and inspect its log, rather than restarting. No geometric acceptance
is claimed. Final packed geometry and browser behavior remain separate.

Conversion wave 10–17 remains live on **50988**, last observed through batch 13.
Continue those exact handles; no duplicate conversions. New scripts compile and
syntax checks pass. No cloud calls, CI, app build or deployment. See
[coverage and conversion progress](lulc2010-display-progress-20260922.json).

## September 22: Corrected fine input bound; first conversion wave complete

Batches 0–9 pass native identity, attribute and positive-area checks. Wave 2–9
completed in 372.33 seconds; session 71385 is terminal with exit zero. The next
serial wave, batches 10–17, is running on session **50988** with the same per-batch
limits, native checks and 1,800-second wave budget. Poll that handle before
resuming. At checkpoint 11 batches cover 201,152 reviewed records.

The fine-detail builder now requires `--reviewed-topology-directory` whenever
the parent carries a topology review hash. A shared loader verifies the original
record cache, every candidate hash, exact corrected feature content, unchanged
non-geometry fields and the complete selected identity set. The native probe must
match the corrected input and review hashes. It cannot fall back to invalid
original geometry. Focused checks passed for exact retained input and rejected a
wrong review hash and missing identity. Existing original-geometry paths remain.

The full merger now emits the standard ordinary-parent receipt and precision
profile into `additional-nsdi-tiles/7d7f0e0fa036251c-batched`, preserving derivative
provenance for native review and the fine builder. Neither merged nor fine output
has been built yet. Syntax and whitespace pass. Final part/hole correspondence,
packed limits and browser acceptance remain pending. No cloud calls, CI, app
build or deployment. See [current progress](lulc2010-display-progress-20260922.json).

## September 22: Corrected polygon parts pass their own native precision probe

A new reviewed-topology mode binds the eight corrected geometries to their
reviewed hashes and original source identity, checks all non-geometry fields,
and retains the exact fourteen-record probe input separately from the originals.
At zoom 19 all 2,872 parts retain positive native area across 123,526 tiles,
with no renderer ring-count loss (maximum five rings per clipped polygon).
The probe completed in 8.188 seconds under the existing 150,000-tile / 180-second
limits. Session 16646 is terminal with exit zero. Earlier original-geometry
receipts are unchanged and are not substituted for this corrected-input result.

This is not hole correspondence, positional accuracy, final packed acceptance
or a browser result. Bind the corrected input and review hash into the later
mixed-detail build; do not revert to original invalid geometries when selecting
fine records. The full merge still awaits remaining batch conversions. Wave
2–9 remains live on session **71385**; poll it before resuming. Syntax passes.
No cloud calls, CI, application build or deployment. See
[exact corrected-input probe](lulc2010-display-progress-20260922.json).

## September 22: Full-source batch merger implemented; conversion continues

The ordinary-detail merger now validates every staged batch and matching native
review before creating output. It stages compressed payloads in SQLite, merges
on identical native grids, rejects identity collisions, independently decodes each
result and compares all native geometry, attributes and IDs. It stops on existing
16 MiB decoded / 8 MiB compressed reader limits; no simplification or limit increase
is introduced. Source topology corrections remain explicitly linked to staging.

Syntax passed and an incomplete-input check confirmed rejection before output
creation. The full merger has **not run**; this is implementation evidence only.
Run it with a 2 GiB Node heap once all 53 batches pass. It has a 1,200-second merge
bound, 3 GiB staged-payload cap and 8 GiB free-disk floor. Final packed verification,
complete part/hole fidelity and browser acceptance remain separate requirements.

At this checkpoint 6 batches (106,796 records) pass native identity,
attribute and positive-area checks. Conversion wave 2–9 remains live on session
**71385**, most recently observed at batch 6. Poll that handle before
resuming; do not duplicate it. No cloud calls, CI, app rebuild or deployment.
See [current receipts](lulc2010-display-progress-20260922.json).

## September 22: Two land-cover batches verified; bounded serial wave running

The first two staged batches pass native maximum-zoom checks for all 39,224
identities, exact attributes and positive area per record. Their 133 overlapping
tiles were merged and independently decoded: all 204,988 fragments preserve exact
native geometry, attributes and IDs, with no ID collisions. Maximum merged decoded
payload is 5,794,531 bytes (2,843,013 compressed), within existing reader limits.
This proves the two-batch operation, not complete-source merged size or part/hole
fidelity. Original source records remain preserved.

An eight-batch serial wave (indices 2–9) is running on session **71385** with a
1,800-second wave limit and existing per-conversion bounds. Each successful batch
gets a native review before continuing. The first failure stops the wave, retaining
finished outputs and receipts. Poll the exact handle; do not start duplicate work.
Sessions 19759, 91076 and 50288 are terminal with exit zero.

Next inspect the wave, finish remaining bounded conversions, and implement the
full merge with complete native and packed-budget checks. Reviewed topology and
zoom-19 part/hole repair still require their own acceptance before admission.
Syntax and whitespace pass; no app rebuild, cloud calls, CI or deployment occurred.
See [exact batch progress](lulc2010-display-progress-20260922.json).

## September 22: Nepal land use registered; complete tiled candidate verified locally

The three remaining Nepal OSM groups now have their fifteen exact S3 components
retained and hashed (2,061,523,115 bytes downloaded, thirteen AWS calls, originals
unchanged). Local older copies differ. The retained README identifies the August
2020 Geofabrik snapshot; initial acquisition and current-provider byte equality
remain unknown. OpenBLAS startup allocation was diagnosed and stopped before data
processing; single-thread imports fixed it. Interrupted conversions resumed from
saved byte/count checkpoints after missing handles and absent processes were verified.

Land use (179,240 features) and roads (472,828) pass every FID, attribute and
coordinate round-trip. Land use passes the offline safety worker and is now active
as `b3957e80-b87d-4c77-a669-167495424ea5` in Nepal. Both owner/editor readback and four
private artifact HEAD/checksum checks pass. The first registration execution guard
made no changes; one Aurora-resume timeout also created no record. The bounded retry
completed without duplicates. Exact original companions and README remain linked.

The ordinary land-use tile candidate omitted eight tiny polygons and was rejected.
Its 133,839,234-byte repaired candidate passes all 179,240 native IDs and non-null
attributes; MVT null omissions are explicit. Every 46,955 ordinary compressed tile
payload is unchanged. All eight repaired polygons retain one positive-area exterior
and pass independent GEOS coverage within two native grid units (0.009331 m).
The candidate is local and still requires built viewer acceptance and catalog
attachment; it is not an enabled map display. Do not admit the rejected parent.

Buildings conversion remains active on session 31200 with a one-hour bound; poll
that exact handle before restarting. Roads display/registration remains next.
Syntax, foundations and whitespace pass. Aggregate parity still reports shared
worktree evidence checksum mismatches. No new app build or deployment occurred.
See [exact receipts and active process](nepal-large-osm-20260922-progress.json).
Next complete the land-use viewer/integration checks, inspect the building process,
and continue remaining S3 registrations. The overall goal remains active.

## September 22: Complete land-cover staging; first bounded conversion succeeds

All 690,239 records are accounted for in 53 staged batches (2,142,930,416
serialized bytes), completed in 313.31 seconds. Original-source and display
feature digests, per-batch checksums and identity sidecars are retained. Exactly
eight reviewed topology geometries are substituted, with non-geometry fields
unchanged and original source data preserved. Each batch is limited to 64 MiB,
20,000 records and one million vertices.

The new single-batch converter checks manifest/input bindings, retains resource
usage, reuses checksum-verified successful output and refuses automatic retries
of failed batches. Batch 0 completed successfully in 43.95 seconds,
using 47.52 user / 5.00 system CPU seconds and 109,968 KiB peak resident memory.
Its 19,225 source records produced 15,331,783 archive bytes. This is conversion
success, not yet complete native feature or geometric acceptance. Both sessions
39769 and 85902 are terminal with exit zero. Next inspect native batch coverage
and merge semantics, then convert remaining batches with reusable receipts and
bounded total execution; do not repeat successful conversions. Limits remain
2 GiB address space, 300 CPU / 240 wall seconds, 512 MiB per file and an 8 GiB
free-disk floor.

Merge/repack, native attributes, complete exterior/hole correspondence, packed
reader budgets and browser acceptance remain outstanding. No cloud calls,
application rebuild or deployment occurred. See
[batch progress and retained receipts](lulc2010-display-progress-20260922.json).

## September 22: Representative conversion succeeds; resume in bounded batches

The paired GDAL diagnostic is terminal. Original record 689474 converts in 23.20
seconds, with 42.70 user / 0.78 system CPU seconds, 656,368 KiB peak resident memory
and 937,143 output bytes. Its reviewed topology converts in 23.69 seconds, with
43.44 / 0.79 CPU seconds, 654,508 KiB peak memory and 937,216 output bytes. Both use
the same zoom-7–14 recipe and explicit thread/memory/time limits. This one record
does not explain the earlier whole-source SIGKILL or prove complete display fidelity.
No diagnostic output is admitted or used as a full Layer.

Next stage bounded, resumable conversion inputs with complete ID accounting and
explicit provenance for the eight reviewed topology derivatives. Preserve successful
batch work and record CPU/RSS before merging; do not restart the same 5.1 GB
whole-source conversion or silently raise production read limits. Final merge,
overview behavior, component/hole fidelity and browser acceptance remain required.
All current processes are terminal. Syntax and whitespace pass; no AWS/provider/CI
calls, application rebuild or deployment occurred. See
[diagnostic receipts and next actions](lulc2010-display-progress-20260922.json).

## September 22: Land-cover topology reviewed; whole-source conversion failed

The ordinary conversion is terminal: GDAL exited -9 after 1,036.572 seconds and
left a 12 KiB malformed temporary SQLite file. No usable archive exists. The
partial file, checksum and failure receipt remain retained. The original wrapper
captured neither child CPU nor peak resident memory, so the SIGKILL cause is not
established. Future runs now record both; do not repeat this conversion unchanged.

The initial bulk topology check also terminated without a result. Isolated,
thread-limited checks then examined all 14 records in 8.49 seconds: six are valid
and eight have ring self-intersections. Seven separate LINEWORK display candidates
passed exact undirected 2D segment-multiset and area-tolerance review under the
15-second record CPU budget. Only record 689474 needed a targeted 45-second budget;
it completed in 16.70 seconds. All eight corrected candidates retain exact boundary
segments and original attributes, with originals untouched. The combined topology
review retains both successful and failed receipts. This is not native or renderer
acceptance; the previous native probe covered original geometry and cannot silently
stand in for the corrected input.

All processes are terminal. Next perform a bounded representative conversion
diagnostic with resource telemetry, use its evidence to choose the conversion
strategy, and integrate topology provenance before repeating native component and
filled-hole acceptance. Polygon-component admission remains explicitly blocked.
Compilation and whitespace pass; no AWS/provider/CI calls or deployment occurred.
See [exact failure and retained review paths](lulc2010-display-progress-20260922.json).

## September 22: Multipart polygon builder wired; admission stays closed

The shared mixed-detail builder now has an explicit `--polygon-components` mode.
It requires the complete affected-ID inventory and exact-source native probe,
permits the proven zoom 19, promotes whole records and retains original overview
fragments without the older polygon-overview hole simplification. The generated
inventory covers all 49 collapsed exteriors across the 14 records. The corrected
build is not started while the ordinary parent build remains active.

Admission explicitly rejects this polygon component recipe until final packed
part/hole correspondence and browser evidence are implemented. A negative test
ensures line acceptance cannot be reused to bypass that requirement. Seven admission
tests, builder syntax, foundations and whitespace pass. No evidence was resealed.

Read-only OGR/GEOS source-topology inspection runs on session 19951, with 2 GiB
address space and 150 CPU seconds; it must not normalize originals. Ordinary build
56562 is also still active. Next collect both exact handles, inspect any invalid
source geometry, review the parent's native/budget output, then complete polygon
repair and acceptance. No cloud calls, deployment or duplicate conversion.
See [current state](lulc2010-display-progress-20260922.json).

## September 22: Polygon repair bounded at zoom 19 by native evidence

The retained 14 affected records contain 2,872 parts, 7,852 rings and 392,402
vertices in 15,111,766 bytes. Forty-nine exteriors collapse at ordinary detail.
Some source parts have up to 2,122 rings, requiring an explicit renderer-limit check.
No source-grid hole collapse was observed at zooms 14 or 20 in these records;
this does not prove clipped-tile hole correspondence.

A zoom-18 native probe rejects component `689064:1670`; 2,871 of 2,872 parts
survive. The rejected evidence is retained. The bounded zoom-19 follow-up passes
all 2,872 parts, with maximum five rings per clipped polygon and no renderer
ring-count loss. It visits 123,511 tiles, emits 10,809,490 encoded bytes and finishes
in 7.602 seconds, within its explicit 150,000-tile/180-second local probe limits.
The production reader limits are unchanged. Full attributes, actual hole geometry,
combined archive topology and browser acceptance remain separate requirements.

Ordinary build session 56562 remains active; preparation and both probes are
terminal. Next use the ordinary native/budget results to promote all 14 complete
multipart records at zoom 19 while retaining their overview fragments. Do not use
only wholly missing record IDs or blindly choose zoom 20. Reuse the retained exact
records and checksum-bound probe. Compilation, foundations and whitespace pass;
no AWS/provider/CI calls or deployment. See
[exact results and remaining process](lulc2010-display-progress-20260922.json).

## September 22: Multipart land-cover repair inventory started

Ordinary build session 56562 remains active. Independent session 37212 is retaining
the 14 source records with collapsed exterior parts, preserving complete attributes,
all parts and holes. It inventories ring/vertex counts, collapsed holes at ordinary
and fine resolution, first positive exterior zoom and conservative zoom-20 bounding
box cell counts. Those cell counts exclude buffers and other zooms; they are not
actual build output or memory requirements.

The extraction has a 2 GiB address-space cap, ten-minute elapsed budget, 660 CPU
seconds and 1 GiB retained-output cap. It rechecks the original checksum and refuses
to overwrite earlier preparation. Failure leaves a stopped receipt and partial
output for inspection; it cannot become accepted precision evidence. Compilation,
foundations and whitespace pass. No AWS/provider/CI calls or additional tile build.

Next poll both existing handles, inspect component size/complexity before choosing
whole-record fine tiling, and review the ordinary output independently. Keep all
native, geometry and actual renderer acceptance requirements; a polygon identity
count does not prove its smaller parts or holes survived. See
[process details](lulc2010-display-progress-20260922.json).

## September 22: 2010 land-cover profile complete; bounded build started

The complete source profile passes after 499.895 seconds: 690,239 spatial records
and 693,903 polygon parts. No whole record collapses at zoom 14, but 14 records
lose at least one exterior there. No exterior collapses at zooms 20 or 22. This
is why identity counts alone cannot establish complete polygon display. Hole and
native clipping/rendering checks remain required.

One ordinary-detail build is active on session 56562, reusing the complete profile
and rechecking the original SHA. Limits are two GDAL threads, 8 GiB address space,
20 minutes, 4 GiB free-disk floor and 2 GiB output acceptance. Progress is written
every ten seconds after startup. This intermediate is not admitted. Do not restart
on a tool observation timeout or treat a log/lock alone as a live process.

Next inspect native identities/properties and packed budgets, inventory the full
size and tile cost of the 14 affected multipart records, and select a complete-part
repair. Large records may make blind whole-record fine tiling expensive; establish
the actual requirement before launching that work. Compilation and whitespace
pass; prior foundation evidence remains valid. No AWS/provider/CI calls or upload.
See [completed profile and running build](lulc2010-display-progress-20260922.json).

## September 22: 2010 land-cover precision profile running

The next unprocessed NSDI polygon source contains 690,239 expected records in a
5,145,663,291-byte retained capture. Its size and SHA-256 pass. Session 41582 is
streaming the complete source through the existing exterior-grid profiler, with a
2 GiB address-space cap, 900-second profile deadline and 960-second CPU cap. The
first 675,000 records have been examined; this is not yet a complete profile.
No tile build has started. Poll the same handle before any follow-up.
The existing bounded builder now accepts `--polygon-profile` while retaining its
contour default. It validates the completed profile against the retained source,
refuses unresolved zoom-22 exterior collapse, records planned repair IDs and copies
the precision evidence into the candidate. Syntax passes; conversion is deliberately
not started until this exact profile finishes. No source rescan was restarted.

The shared profiler now accepts a retained source URL without a prior display build
and records IDs of partially collapsed multipart exteriors, preserving its prior
2016/default candidate mode. This avoids choosing a large build recipe blindly or
repairing only wholly missing records. Holes, native tile clipping and actual
rendering still require separate acceptance. Compilation, foundations and whitespace
pass. No AWS/provider/CI calls. Contour, road and agriculture preservation remain
separately prepared and unuploaded while exact-package authorization is pending.

Next inspect the complete precision result, choose a bounded build with component
retention, then native/geometry/browser acceptance. Continue toward the full parity
scope; this source profile is only a prerequisite. See
[process and input details](lulc2010-display-progress-20260922.json).

## September 22: Contour local acceptance passes; preservation prepared

The corrected contour display now passes the complete built Studio selector journey:
all 38 component locations, ordinary-detail overzoom, visibility/style reload, saved
live identity and return/reopen without archive reads. The run used 74 intercepted
requests and 20,673,922 bytes, with one deliberate archive reselection. Production
limits remain unchanged. The earlier five-minute expiry failure remains retained.
Native/geometry/packed checks cover all 212,935 spatial source identities; nine
unlocated originals remain preserved separately.

The local preservation plan contains 16 objects totaling 351,483,546 bytes,
including the checksum index and required geometry/generalization/provenance evidence.
It is not uploaded or admitted. Exact-module release evidence was reused after
matching the tested reader files; no new hosted reads or deployment occurred.
All processes are terminal. No build, AWS/provider/CI call was needed this increment.
See [local acceptance and package](contour-display-local-evidence-20260922.json).

Next obtain exact-package upload authorization, preserve and admit through runtime
account authority, then verify the hosted signed-in journey. The earlier road upload
was rejected by automatic review for unestablished exact payload/destination
permission; goal continuations are not approval. Continue independent local work
while that permission remains pending. Byte-identical contour captures offer a
separate reuse opportunity, retaining catalog identities and distribution terms.

## September 22: Contour selector expiry retained; explicit reselection follow-up

The first selector run ended after 37 of 38 component locations passed. The
retained receipt identifies the five-minute archive session expiry, not a native
geometry failure. It used 63 intercepted requests and 19,806,913 bytes. Initial
software-rendered overview took 12.569 seconds; this is not hosted latency.
Save/return/reopen acceptance did not run, so the candidate remains unaccepted.

The failed result is retained under `selector-review-expired`. A single follow-up
on session 83140 reuses the unchanged built Studio and archive, deliberately opens
archive review and acknowledges costs again after 20 probes. It verifies that
metadata review makes no storage reads, requires renewed consent, and retains all
38 component probes plus save/return/reopen. Production time/request/byte limits
are unchanged; no automatic renewal was added. The journey also bounds cumulative
reads. Do not duplicate this running process or prepare an accepted package early.

The retained restoration manifest also identifies byte-identical contour captures
for Hosted_50k_Bhutan and Hosted_Topography_50k, with the same SHA and object version.
Reuse is a later opportunity, not permission to merge source identity or rights.
Next collect this exact browser result, resolve any remaining failure, then prepare
preservation locally. No AWS/provider/CI calls, rebuild or deployment occurred.
See [the current handles and retained failure](contour-display-progress-20260922.json).

## September 22: Contour content and geometry pass; selector acceptance running

The corrected archive passes complete native review: all 212,935 spatial identities,
exact attributes, correct layer membership and nonzero line lengths at their declared
detail zoom. Nine unlocated source records remain preserved without invented map
positions. Independent comparison covers all 11,604 original tiles and 2,289,173
fragments. Only two declared overview tiles differ; all 14,705,346 original vertices
there are within the half-pixel bound. Fine-detail review covers all 263 components
of 37 records, with 989,832 endpoint/midpoint samples and maximum distance 0.02636 m
against a 0.11197 m display tolerance. This is display correspondence, not survey
accuracy or continuous geometric equality.

Preservation/admission now requires checksum-bound overview generalization evidence,
the exact declared tile set and complete vertex counts. Negative checks reject wrong
artifacts, changed evidence, excessive deviation and incomplete coverage. Provenance
retains the method and evidence separately from originals. Six admission tests,
compilation, foundations and whitespace pass; aggregate parity remains unproven.

The built Studio selector journey is active on session 11049. Its overview and
first fine records render with intercepted local transport. Wait for the same handle;
no browser acceptance claim or upload is established yet. Next finish that journey,
then prepare the preservation package locally. No AWS/provider/CI calls, rebuild or
deployment. See [process and evidence state](contour-display-progress-20260922.json).

## September 22: Corrected contour archive built; all packed payloads pass

Independent source-chord verification covers all 14,705,346 vertices in the two
oversized overview tiles, retaining native identities, exact properties, line parts,
endpoints and nonzero lengths within half a pixel at each native extent. The shared
mixed-detail builder now accepts checksum-bound evidence for an explicit list of
line overview corrections. Other tiles retain their existing geometry; full-detail
source records remain preserved. The exact comparison must still verify that claim
against the finished archive.

The single corrected build completed in 80.808 seconds: 11,604 existing tiles,
33,886 fine tiles, two generalized overview tiles and 338,539,777 packed bytes.
All 45,490 unique packed payloads pass: maximum decoded 14,232,324 bytes and maximum
aligned response 6,291,456 bytes, below unchanged reader limits. Original rejected
receipts are retained. The candidate is not admitted or uploaded.

Native identity/property review is running on session 48388, packed overview
comparison on 70054 and fine-component geometry review on 3166. Poll those exact
handles before starting new work. Next complete those reviews, connect bounded
review evidence to preservation/admission, and exercise the real archive selector.
Do not substitute this build or its size audit for geometry/browser acceptance.
Focused simplification/independent-verifier checks, six admission checks,
foundations, syntax and whitespace pass. The known aggregate parity checksum
failures remain unresolved. No AWS/provider/CI calls or deployment occurred.
See [exact candidate and process state](contour-display-progress-20260922.json).

## September 22: All fifteen Nepal OSM layers have a registered full-data map

The existing managed-vector reader resolves the earlier eight-layer map concern:
it deliberately loads the exact private original when a bounded preview is
insufficient. All 157,485 features across fifteen layers pass the real reader and
built Workbench tests. Hidden layers trigger zero data reads; off/on reuses data.
Both accounts pass thirty version readbacks and sixteen exact download authorizations.
Five published Studio files match the tested release; no rebuild or deployment.

The map `7ea9bdda-d070-4763-aa6e-8452ef082350` is now in the existing Nepal collection,
with all fifteen layers initially off. Aaron owner and Categorise editor readback
pass. Registration used 277 Data API calls and no S3/provider reads. Authorization
used 326 calls after one retained Aurora-resume timeout; no signed URLs were saved.
See [the exact evidence](nepal-osm-map-20260922-evidence.json).

This supersedes the earlier inference that eight layers require PMTiles before
being added to a map. Inline catalog previews still have their size/count limits.
Automatic zoom-5 worker PMTiles omit some source identities and remain unsuitable
as complete displays. Browser rendering was local with retained data and intercepted
transport; hosted signed-in acceptance remains open. Thirteen owning reader tests, foundations and whitespace
pass. Aggregate parity retains evidence-checksum failures. Next: address the three larger Nepal OSM groups with reviewed tile displays,
then remaining S3 coverage and hosted acceptance. The full goal remains active.

## September 22: Contour review terminal; two overview corrections proven feasible

The native review is terminal: 25 missing identities, no unexpected identities or
property mismatches among decoded records. All 25 are included in the 37-record
fine-detail repair inventory. The packed audit is also terminal and rejects two
overview payloads above the 16 MiB decoded limit. Do not restart either review or
admit this ordinary candidate.

A local experiment simplifies only those zoom-7/8 tiles within half a pixel at
512-pixel display resolution. Their native extents differ (8192 and 4096), so the
bound uses each layer's actual extent. Decoded sizes fall to 6,855,002 and 7,958,582
bytes. Native identities, exact attributes, part counts, endpoints and positive
lengths survive re-encoding. The archive itself remains unchanged. The reported
RDP deviation still needs independent verification; this is not catalog admission.

Next: verify the generalization independently, integrate the two-tile correction
with the prepared zoom-17 complete-record repair, then run the candidate's native,
geometry, packed-budget and archive-selector checks. Keep the original rejected
receipts and unchanged full-detail geometry. No AWS, provider or CI calls occurred.
Focused simplification checks pass; the preceding foundations/whitespace result
is retained and aggregate parity checksum failures remain unresolved.
See [updated exact progress](contour-display-progress-20260922.json).

## September 22: Demo new Projects start with the full Layer catalog

New demo Projects open the existing searchable catalog, clear the previous search
and discard the cached panel. This prevents a prior selection from hiding available
Layers. Metadata review, deliberate addition and browser-only persistence remain
intact. The demo packager now stages three required archive presentation modules;
the first build exposed their absence, and the corrected build passed.

The local built-browser journey passes new Project/catalog selection, search reset,
rendering, metadata review, independent catalog reuse, save/reopen and mobile dialogs.
No private requests or external providers were contacted. Focused demo, Project-file
and release-safety tests, foundations and whitespace pass. Aggregate parity still
reports evidence-checksum mismatches in the shared worktree; no blanket resealing.
See [local evidence](demo-catalog-reset-20260922-evidence.json).
This increment is not deployed. Next: include it in the next authorized bundled
Demo release and verify the hosted New Project → catalog → add Layer journey.

## September 22: Fifteen Nepal OSM S3 layers registered; complete map display remains open

Fifteen historical Geofabrik/OSM Nepal shapefile groups are now active catalog
records owned by Aaron, with Categorise editor access verified through the existing
runtime repositories. Both accounts read back all 157,485 features' recorded counts,
EPSG:4326, exact original component identities and source README. The 75 original
S3 files remain untouched. Their 109,119,920-byte private GeoJSON representations
retain every source FID, property and coordinate; all safety inspections passed.
The 60 private working/preview/tile/thumbnail artifacts (78,901,908 bytes) have exact
version/checksum HEAD verification. The README dates the source snapshot to
2020-08-24T20:42:02Z; initial acquisition date and current-provider byte equality
remain unknown. The current Geofabrik page fetch timed out.

Three representative real point/polygon/line previews pass the built local Studio
journey, including zero hidden reads and reuse after toggling. Country-wide polygon
rendering initially timed out; the retained successful journey uses feature-scale
bounds. Hosted signed-in acceptance is not claimed. Seven previews are capped at
5,000 features, and three exceed the API's 4 MiB limit: eight distinct layers still
need complete map presentation. No whole-batch map was persisted, and its prepared
registration refuses incomplete previews. Ordinary worker PMTiles are stored but
not yet established as complete, accessible map presentations.

The retained 387-key Nepal inventory now has 75 additional exact component links
verified through both accounts; 224 keys still lack an explicit reference in that
conservative reconciliation. Keys are not dataset counts, and this is not a fresh
bucket listing. No original rewrites, new infrastructure, application rebuild or
deployment occurred. Compilation, lineage validation, foundations and whitespace
pass; aggregate parity retains evidence-hash failures. All batch processes are
terminal. See [the evidence](nepal-osm-catalog-20260922-evidence.json).

Next: connect complete reviewed managed PMTiles displays to authorized map reads,
then finish Nepal's three larger OSM groups and remaining S3 groups. Continue the
remaining Bhutan/ICIMOD displays and hosted acceptance. The full goal remains active.

## September 22: 2016 land cover preserved and enabled with complete record coverage

The 213,694-record 2016 land-cover Layer now offers a private 160,647,489-byte
PMTiles display under its existing catalog identity. The original 852,959,159-byte
capture remains preserved. Complete native review found all identities and exact
attributes: 213,676 records at detail zoom 14 and 18 tiny polygons at zoom 20, all
with nonzero area. Independent checks cover every tiny polygon's sampled edges and
every packed payload's reader limits. The 164 overview holes removed to fit the
renderer are recorded in the build evidence; original and detail geometry remain
separate from display generalization.

The complete built Studio journey passes all 18 fine polygons, ordinary-detail
overzoom, visibility/style reload, saved live identity, and return/reopen without
archive reads. It used 25 intercepted requests and 14,056,385 bytes. Initial overview
was 33.055 seconds in software-rendered Chromium; do not claim hosted latency or a
fast overview. The original host process finished successfully after its tool
observation ended; no repeat browser run was launched. Eight bounded HTTP reads
verified the exact published entry documents and six tested reader modules.

Private preservation completed 12 objects plus its restoration manifest in 32 S3
calls, uploading 160,760,301 bytes. The first admission stopped before a transaction
while Aurora resumed; the bounded retry reused its two exact version checks and
enabled one choice in five Data API calls. Both accounts verified the exact stored
provenance and unchanged live source through runtime authority in 34 metadata calls,
with no S3 reads or tickets. Counts now read 589 active Aaron-owned datasets,
445 enabled archive choices, and 442 datasets with an enabled choice. Hosted
signed-in acceptance remains unproven. See [the evidence](lulc2016-mixed-detail-20260922-evidence.json).

Nepal's 16 retained README/index objects cost 17 AWS calls and 51,042 downloaded
bytes. Their reported checksums are not newly verified data bytes. Electricity
aliases match three already-registered Layers. The 91 OSM keys group into 18
shapefiles and a README; required companions and CRS files are present, but content,
source-version matching and catalog registration remain. No duplicate records or
S3 rewrites were made. Five focused admission cases, compilation, foundations and
whitespace checks pass; aggregate parity still fails checksum checks.

Next: review the retained main-road candidate's 10 missing identities and complete
its fine-detail geometry, then the remaining larger NSDI displays. Ten source URLs
across seven unique original contents remain in the NSDI display queue. Continue
Nepal file-group reconciliation and hosted account acceptance; the full goal is active.

## September 22: Soil archive enabled; production and both-account readback verified

The 4,414,467-record soil Layer now offers its reviewed private archive: a
1,026,112,483-byte vector PMTiles file plus a 10,048,352-byte classified overview.
Its original captures remain preserved, and Live remains the default. The exact
paired reader is deployed in Studio and API image
`sha256:5df6150fe99508ae98993b03c453d824bab4d2c80b5421fce2ec26d1dc7f9ffe`.
Native and production scans report zero high/critical findings. The transient
runner, attached/tagged volumes and NAT were verified removed; IP cleanup is proven
by its CloudFormation deletion because direct IP inspection is not authorized.

Admission verified three exact S3 versions and inserted one archive choice in five
Data API calls. Production runtime authority returned it to Aaron and Categorise
with the original source, count, paired recipe and complete provenance. The stored
metadata text matches exactly. Typed JSON reads round eight review statistics by
one ULP; the diagnostic and exact text readback are retained. No metadata reads
signed tickets or downloaded S3 objects. The connected local browser passed through
actual HTTP and PostgreSQL; hosted sign-in and actual S3 browser ranges remain a
separate acceptance gap. Owner-scoped counts are 589 active datasets, 444 enabled
archive choices and 441 datasets with enabled choices. These totals do not establish
completion of every capture. See [the evidence](soil-paired-overview-20260922-evidence.json).

All 2,123 API tests passed before the final two annotation corrections; 36 owning
cases and owning-file Ruff/format checks passed afterward. Three new typing errors
were fixed and the changed source rebuilt once. Full static checks still report
377 mypy diagnostics, 45 Ruff diagnostics and 47 files needing formatting.
Foundations pass; aggregate parity retains checksum failures. Neither gate has been
relaxed or claimed green.

Nepal's current listing has 387 keys, compared with 322 in the earlier inventory.
Thirty-one already-retained QGIS metadata documents now also link their exact
inspected S3 file identities; both existing accounts can edit the resulting
knowledge records. The first bounded batch stopped after 28 verified rows; its
three remaining rows were reconciled idempotently. Total metadata registration used
822 Data API calls and no S3 writes. After these links, 299 keys still lack an
explicit current catalog reference in the bounded audit; they include provenance
and sidecar files and must not be counted as 299 missing datasets. Sri Lanka's prior
179-key reconciliation remains separate retained evidence, not a refreshed scan.

Next: finish the complete 2016 land-cover precision profile and build its bounded
mixed-detail display without discarding tiny records. Then finish the other NSDI
displays, Nepal file-group reconciliation and hosted account acceptance. The full
goal remains active. This is a progress checkpoint, not goal completion.

## September 22: Paired soil overview passes the complete local Studio journey

The 4,414,467-record soil display now passes the complete built Studio selector
using a 10,048,352-byte classified PNG overview with the unchanged
1,026,112,483-byte reviewed vector detail. The country overview opens in 4.2 seconds;
zoom 8–11 views take 2.5–3.0 seconds in local software-rendered Chromium. All eight
small-polygon probes, visibility/style reload, saved live identity and return/reopen
pass. The journey uses 81 intercepted requests and 19,113,280 bytes, inside the
unchanged five-minute/64 MiB budget. These are local measurements, not hosted latency.
The first paired browser failure was a test visibility-property error; its screenshot
already showed classified pixels. Both receipts are retained.

The API and reader require exact paired versions/checksums, shared scope and read
budgets, matching bounds and disjoint display zooms. The overview contributes no
additional logical records. Feature filters hide it while vector detail is filtered.
Thirty-six focused API cases, four reader test files, the paired layer lifecycle,
three admission tests, Studio build/release sealing and PWA privacy checks pass.
Foundations pass; aggregate parity retains existing checksum failures.

The 24-file private preservation batch is complete: 69 S3 calls and
1,037,364,776 uploaded bytes including the new restoration manifest. Exact versions
and storage checksums were verified; no existing manifests were replaced. All 2,123 API tests pass in 520.67 seconds. The authorized native security build
is running as handle `97483` from
`.local-archives/progress-runtime-20260919/native-input-bff111f0f379`; poll that
exact handle and verify its temporary-stack cleanup. The current API-only release
baseline preserves the current bucket policy and CORS without changing either;
an older policy-equality preflight failed and only that policy read was resumed.
Finish API security/runtime acceptance and the paired API/Studio deployment before
admission. Production still has 443 enabled archive
choices and soil is disabled. Eleven other NSDI URLs, country reconciliation and
hosted account acceptance remain. See [current evidence](soil-paired-overview-20260922-evidence.json).


## September 22: Grouped soil overview verified; full navigation still fails

The new 1,026,112,483-byte soil candidate groups 5,910,571 overview features into
19,170 multipart features without changing any classified polygon or hole. All 241
pixel comparisons, packed overview checks, 11,393 retained-detail comparisons and
packed read budgets pass. The local Studio overview opens in 2.6 seconds and all
intermediate zooms render, but the complete journey still expires after four of
eight detail probes. Disabling offscreen renderer caching did not eliminate the
progressive waits. The installed headless renderer is SwiftShader even without the
forced software flag. No full browser or hosted acceptance is claimed.

All build, verification and browser processes are terminal. Preserve their receipts;
do not rerun the same vector journey or increase its timeout. The next concrete
action is a separately declared raster overview from the verified class pixels,
combined with the unchanged full-detail vector tiles under shared explicit access
and read budgets. Extend the descriptor and reader contract before enabling it.
The admission path now requires the exact tested frontend files to be deployed.
The frontend presentation remains local; no soil upload or admission occurred.
Production remains at 443 enabled archive choices. Five Python cases, grouping and
presentation checks, deployment-gate rejection checks, foundations and whitespace
pass; aggregate parity retains 116 existing checksum errors. See
[current evidence](soil-grouped-overview-20260922-evidence.json).


## September 22: Soil artifact proofs complete; selector performance remains open

The full class-overview PMTiles is complete: 1,042,776,216 bytes, with all 241
overview tiles passing packed pixel-class verification and all 11,393 detail tiles
matching the verified parent. All packed payloads meet the reader budgets. The
aggregate presentation helper is locally implemented and tested; it is not deployed.
The full selector still fails at zoom 13 after progressively slower intermediate
views. A direct zoom-13 diagnostic loaded in 3.2 seconds; its later optional
renderer-internal inspection failed and is not acceptance. Investigate the sequence
and style reload before changing preserved geometry or increasing timeouts.

All previous build and selector handles are terminal. The bounded series diagnostic
was launched as handle `11718`; poll that exact handle. Soil remains disabled and
production retains 443 enabled archive choices. No soil upload or admission has
occurred. See [current evidence](soil-selector-performance-20260922-evidence.json).


## September 22: Soil overview sampling and admission checks

The local operator pipeline now supports a separately declared soil-class
overview built from every staged fragment, preserving covered class zero separately
from no data. Aggregate regions carry only `gridcode` and a representation label;
they do not impersonate captured feature IDs or retain misleading area attributes.
Zooms 12–14 remain copied from the verified parent. All overview tiles require a
pixel-class roundtrip and equality against the final packed artifact. Retained
source-identity and geometry proofs require independent packed detail equality.

The five-tile pilot and installed-renderer check pass. The full candidate is still
building and has no completed selector acceptance. The earlier lossy candidate is
explicitly rejected by the admission helper. Four Python test methods pass,
including six negative admission mutations; syntax, whitespace and foundations
pass. Aggregate parity retains existing checksum failures. No application bundle,
API, production record or permissions changed; no deployment is required for these
operator-only edits. See [evidence](soil-class-overview-pilot-20260922-evidence.json).

## September 22: 2020 land cover admitted; compatible Studio reader deployed

The 60,970-record 2020 land-cover archive is now available on its existing catalog
Layer. Its 81,905,243-byte PMTiles and ten supporting files are preserved under the
private Bhutan NSDI prefix. Both Aaron and Categorise pass production runtime
repository discovery; the total enabled archive count is **443**. The first database
attempt stopped during Aurora wake-up before any transaction; one supported retry
reused the two exact S3 version checks and completed the single-row admission.

The 310-file Studio release at
`/releases/opengeo-studio-20260922120842-fdc4bacc8080` is deployed. Its completed
invalidation, origin and eight published files were verified. The reader handles
per-layer detail ranges within one authorized archive session: ordinary land-cover
polygons overzoom from 14, and three tiny polygons retain detail at 20. The complete
local selector journey passes visibility, style reload, all three fine probes with
surrounding coarse polygons, save/live identity, return and reopen. It uses ten
intercepted range requests totaling 6,644,379 bytes. The 22.1-second local overview
settle wait is not a hosted latency claim. No originals or permissions were replaced.

The complete 4,414,467-record soil PMTiles is built and passes native identities and
attributes, sampled geometry and every packed payload's byte limits. Its browser
check remains failed: the initial style did not finish in 120 seconds, although
5,834 features had rendered. Four overview tiles contain 23,612,882 vertices.
This requires a bounded overview vertex/triangulation workload, not another blind
wait or full recapture. Full-detail identities and preserved source geometry must
remain intact. Both previous browser failures are retained; no soil review process
is live and the full soil archive is not enabled.

Three focused reader test files, the sealed release, PWA privacy checks, foundations,
syntax and whitespace pass. Four negative admission-evidence cases reject wrong
hashes, missing positive-area coverage, oversized reads and failed return/reopen.
Aggregate parity retains 116 existing checksum errors. Remaining work includes soil,
11 other NSDI URLs, hosted signed-in acceptance and the broader country catalog
reconciliation. This checkpoint does not establish the full goal complete. See
[current evidence](mixed-detail-landcover-admission-20260922-evidence.json).

## September 22: Studio archive preview deployed; soil merge resumes committed tiles

The tested 309-file Studio release is deployed at
`/releases/opengeo-studio-20260922111441-e02fc7d76070`. AWS confirms the stack update
and distribution are complete. One idempotent cache invalidation completed, and nine
published files match the sealed release, including the catalog archive-preview
component. The interrupted local deploy client was reconciled against AWS rather
than triggering another upload or cutover. Signed-in archive rendering remains
separate acceptance; the previous release remains available for rollback.

The soil merge reached its 1,800-second deadline with **7,600 committed tiles** and
1,528,572,768 compressed bytes retained. The complete source staging is unchanged.
A bounded continuation now checks committed tile structure, polygon area and the
renderer ring limit before producing missing tiles. Independent final identity,
attribute, geometry and browser reviews remain mandatory. Earlier overview omission
statistics are retained as attempt diagnostics, including rolled-back candidates;
they are not summed as exact final-artifact omissions. Full-detail thinning remains
forbidden in every attempt.

A later diagnostic read held the active SQLite output open and interrupted a
commit. The observer finished; 8,800 committed tiles remain. The diagnostic also
found overview tiles above Studio's 16 MiB decoded limit despite fitting the 8 MiB
compressed limit. The current continuation reuses valid tiles and rebuilds only
oversized overviews against both limits. It commits each expensive overview promptly
and waits briefly for transient locks; do not run long reads against active output.
Full-detail tiles cannot be thinned. A regression test covers highly compressible
oversized tiles, and preservation now requires the observed maximum decoded size.
The current unit is `opengeo-soil-reader-budget-20260922.service` (active/running,
PID 2261080 at checkpoint), with the same 12 GiB/40-minute local limits.

A complete local profile identifies 213,694 spatial 2016 land-cover records. Its
interrupted conversion is retained. Seven of eight tiny probes collapse at zoom 14;
all eight retain positive area at zoom 20. Three previously missing 2020 probes
survive at zoom 19. These are sampled precision results, not complete displays.
Reuse the profiles to prepare sparse finer-detail geometry before another full run.

Enabled archive choices remain **442**. Full soil admission, 12 other NSDI source
URLs and hosted account acceptance remain. Four focused Node test files, syntax,
whitespace and foundations pass; aggregate parity retains existing checksum failures.
See [deployment and continuation evidence](studio-release-soil-resume-20260922-evidence.json).

## September 22: complete soil staging and independent rendered coverage

All **4,414,467 soil identities** are now staged, each retaining positive polygon
area at full detail. The 893 batches contain 2,666,624,491 compressed partial-tile
bytes. This is completed staging, not an admitted or completed PMTiles display.
A complete audit of 161,493 full-detail partial tiles and 5,060,654 fragments finds
no renderer ring-limit violation (maximum 281 rings). Overview reduction therefore
addresses an overview-only ring-limit issue in this staged capture.

An independent GEOS comparison of actual installed MapLibre fill triangles passes
eight dense tile windows from the two reviewed complex polygons: 13,692 triangles,
no unexplained missing or excess area outside three tile units (0.896 Web Mercator
metres at zoom 14). A preceding strict decoded-ring validity check rejected a
quantization self-touch and remains recorded; rendered coverage does not establish
full-dataset OGC validity or positional accuracy.

The first merge stopped before writing any tile because an overview polygon would
lose 79 rings to the renderer's 500-ring limit. Staging remains intact. A separate
worst-overview partition trial reached its 120-second limit. The corrected merge now
explicitly records smallest-hole reduction at overview zooms, alongside the existing
polygon overview budget. Full-detail zoom cannot use that reduction and must retain
all identities and pass the strict renderer ring check. The new local merge is
running with 12 GiB memory and a 40-minute service cap, without provider/S3 calls.

Four focused Node test files, two Python partition cases, syntax, whitespace and
foundations pass. Parity retains the same 116 checksum errors. Enabled archive choices
remain 442; full soil validation/admission, 12 other NSDI source URLs, the prepared
Studio release and hosted acceptance remain. The preservation path now requires
complete soil lineage and actual rendered coverage evidence. See
[current evidence](soil-complete-staging-rendered-coverage-20260922-evidence.json).


## September 22: Road Network admitted; complete soil batch build running

There are **442 enabled archive choices**. The newly admitted Road Network display
retains all 18,092 spatial identities and exact properties from 18,101 captured
records; nine unlocated originals remain preserved. Both account repository access
checks pass for this new choice. Local browser checks fetched 1,909,022 bytes across
nine views of the 703,169,487-byte PMTiles archive. This is not hosted acceptance.

Both complex soil polygons now have valid display topology retaining all 1,748,629
original boundary segments exactly. The 5,263 reviewed partitions reproduce those
two normalized polygons within the recorded floating-point tolerance. The two-record
PMTiles trial passes native properties, actual local rendering and every-tile renderer
ring-limit review. The temporary topology runtime override has been removed; the
road, partition and trial services are terminal. The full 4,414,467-record soil build
is now running locally with bounded batches, a 12 GiB memory cap and 70-minute service
limit. It must retain positive polygon area for every identity at full detail;
overview omissions are recorded separately. It makes no network requests or uploads.

The preceding status-only goal turn made no progress; this turn revalidated state,
implemented the full-capture batching path and started its actual process. Remaining
work is 12 NSDI source URLs, full soil validation/admission, the prepared Studio
release and hosted acceptance. Do not treat the two-record soil trial as completion.
See [current evidence](road-admission-full-soil-build-20260922-evidence.json).


## September 21: revised bounded road tiler and exact soil topology review

The MapLibre tiler already installed in Studio retains all eight smallest Road
Network test lines at zoom 21. A depth-first adapter matches independent eager
tiling byte-for-byte on crossings and holes, discards completed tile-cache branches,
and uses zero simplification. The complete 18,101-record road capture is now being
prepared with it; 18,092 spatial records must retain positive-length geometry, and
native attribute plus actual viewer checks remain required. No archive was admitted
from these tests. The earlier GDAL timeout remains preserved.

The first complex soil polygon now has valid serialized display topology with all
829,244 original boundary segments retained exactly, no added or removed segments,
and unchanged attributes. The second polygon remains under review. The active
review's local runtime limit was extended from 15 to 25 minutes, retaining its 8 GiB
memory cap, so successful work is not repeated. Its runtime override must be removed
when the job finishes. Partitioning is prepared but requires both topology reviews
to pass. This remains a two-record preparation step, not the full soil display.

Enabled archive choices remain **441**. There are 13 pending NSDI source URLs plus
soil, the prepared Studio release and hosted acceptance. Focused checks, syntax,
whitespace and foundations pass; parity retains the same 116 checksum errors.
See [current evidence](maplibre-road-soil-review-20260921-evidence.json).


## September 21: complex soil geometry diagnosed before another full build

The alternative soil tiler trial stopped at its 600-second limit. A separate
partition trial then rejected the input because both large captured polygons have
self-intersecting rings: fid 1167588 (41,447 rings) and fid 2410643 (51,198 rings).
Their complete originals and all 4,414,467 soil records remain preserved. No soil
display has been admitted, and no two-record trial is treated as the full capture.

A bounded local OGR/GEOS linework review now prepares separate display topology
only if every original boundary segment survives exactly, area remains within the
stated floating-point tolerance, and serialized geometry is valid. This review is
not a claim that normalization has passed. Road Network subsequently stopped at
its 2400-second conversion deadline; retain the failure and profile its tile workload
before changing the build. Syntax, whitespace and foundations pass; parity retains
the same 116 checksum failures. Total enabled archive choices remains **441**; 13 NSDI source URLs,
soil display, the prepared Studio release and hosted acceptance remain outstanding.
An exact comparison identifies 8,790 Road Network geometries matching the admitted
control-plan road, 9,302 unmatched geometries and nine null records. Two matched
geometries have multiple candidate reference identities. This establishes a partial
reuse opportunity only; it does not establish a completed display or attribute match.
See [diagnostic evidence](soil-topology-diagnostic-20260921-evidence.json).


## September 21: combined glaciers and second control-plan road admitted

There are now **441 enabled archive choices**, with both account runtime access
checks passing for the new choices. The combined glaciers retain all 259,228 source
identities and attributes at full detail. Oversized overview tiles have explicitly
recorded generalization. The second control-plan road retains its own attributes,
all 17,882 mapped records and six unlocated originals. Eight short-line viewer
probes pass. Existing Layer identities and live defaults remain unchanged.

The completed displays and lineage evidence are preserved in private S3 prefixes.
The combined glacier batch uploaded 704,798,801 bytes; the second road batch uploaded
486,878,141 bytes. Account checks read metadata only. No application deployment or
hosted signed-in acceptance is claimed.

Remaining display work covers 13 NSDI source URLs plus soil; the previously pending
combined regional glacier pair is admitted. Road Network is still running in its
bounded local service. The complete soil capture is safe, but its GDAL display
conversion reached its deadline. A pinned alternative tiler is testing the two most
complex polygons before any full-capture retry; that trial is not a catalog archive.
Syntax, five focused overview/buffer tests, whitespace and foundations pass. Parity
retains the same 116 artifact checksum mismatches. Terminal local services were
cleaned up after recording their results; the two active services remain untouched.
The prepared Studio release and hosted acceptance remain outstanding. See
[current evidence](glacier-road-admission-20260921-evidence.json).


## September 21: control-plan roads and continents admitted; four display jobs active

There are now **438 enabled archive choices**. Both account runtime checks pass for
the new control-plan road and global continent choices. The road retains all 17,882
spatial records and non-null attributes at zoom 20; six unlocated records remain in
the original. Eight shortest-line viewer probes pass. Preservation wrote 396,088,575
bytes through 21 S3 requests. The local viewer used 1,274,898 bytes across nine views;
this does not establish hosted egress or signed-in acceptance.

The continent display preserves all nine identities and attributes. Eleven small
boundary overshoots are documented. OGR/GEOS MakeValid repairs OBJECTID 9's
self-touching ring topology while preserving the exact multiset of all 63,732
boundary segments. Originals and inverse reconstruction references remain intact.
The archive selector passes four regional views, with screenshot inspection. Three
evidence/display objects and a manifest total 1,587,175 uploaded bytes through nine
requests under the private global/icimod prefix. Anonymous current and exact-version
HEADs return 403. Runtime receives GetObjectVersion for only this additional display
key; existing bucket policy remains unchanged.

Four bounded local systemd jobs are active: soil, combined glaciers, reattributed
control-plan roads, and Road Network at its reviewed zoom 21. The combined glacier
merge now budgets oversized overview tiles by retaining larger polygon areas,
records omitted fragments by zoom, and never thins zoom 14. It also corrects a
pooled-buffer decoding issue caught by exact floating-point attribute checks. Every
retained tile fragment is checked before native/full-resolution and viewer checks.
The combined merge completed 86,543 tiles (690,342,210 bytes) and is now checking
all 259,228 source records at maximum zoom. The second control-plan source has exactly the same original geometry and identities
as the admitted road, but different attributes; its tiles reuse geometry and receive
all properties from that distinct source. Neither pending display is yet admitted.

Remaining: 14 NSDI source URLs, two regional URLs (the combined glacier pair), soil
display, prepared Studio release and hosted signed-in acceptance. Syntax, focused
overview/buffer checks, whitespace and foundations pass. Parity retains the same 116
checksum errors. No application deployment occurred. See
[admission and running-job evidence](road-continent-admission-20260921-evidence.json).


## September 21: world-grid archive admitted; completion status checked

The reviewed 72-record world-grid display is preserved under the private
`global/icimod/captures/local-20260920/` prefix and linked to its existing Layer.
The database retry succeeded. A bounded production runtime check confirms that
Aaron and Categorise can discover the new archive; total enabled archive choices
is **436**. The check used 18 metadata requests, no S3 requests and no writes.
Original coordinates remain preserved separately from the documented display
normalization. Current-object and exact-version anonymous access checks deny access.

A host service check confirms soil and control-plan road jobs are running; the
road job has reached native content verification. Combined-glacier source matching
passed for all four annual captures, but the tile merge stopped at its feature
safety limit. Separate annual glacier archives remain available. Remaining display
work covers 15 NSDI source URLs, three regional URLs, and soil. The next action is
to finish the active checks and resolve the combined overview limit without losing
source detail, then complete hosted Studio acceptance. No deployment or signed-in
browser acceptance is established by this checkpoint. See
[status evidence](world-grid-admission-status-20260921-evidence.json).


## September 21: persistent builds and explicit world-grid display normalization

A session interruption removed all six build/review tool handles. An elevated host
process check confirmed no surviving Python, GDAL, Node or Chromium jobs. Partial
output and receipts were retained. Soil and the complete control-plan road build
now run as bounded systemd user services, including their native and local viewer
checks. These survive conversation interruptions and have runtime, memory and disk
limits. The combined glacier job is instead testing reuse of the four admitted
annual displays: every original geometry and attribute must match, allowing only
an explicitly verified mapping of both GeoJSON id and OBJECTID. No tile reuse has
yet passed; the first comparison stopped because it normalized only one of those
identity fields. Do not repeat builds using the old missing tool handles.

The provider World sample grid has a separate normalized display: 72 records,
567 documented boundary-coordinate adjustments, each no more than 0.0001220703125
degrees. Only longitude/latitude overshoot is clamped; all valid coordinates,
attributes and feature identities remain unchanged. Applying the recorded inverse
reconstructs the parsed original exactly. This is display normalization, not a
claim about true positional accuracy. Originals remain unchanged. The actual local
archive-selection UI passes four regional views, verifies all feature content, and
reads one 22,369-byte gzip object only after deliberate selection. Screenshot
inspection passes. This display has not been uploaded or admitted. Global S3
placement and privacy must be resolved before that step. The separate Continent
sample also has a pre-existing invalid polygon and is not silently repaired.

The enabled archive total remains 435. No S3/catalog writes or deployment occurred
in this continuation. Syntax, whitespace and foundations pass; parity retains the
same 116 artifact checksum failures. See [persistent-job and world-grid evidence](persistent-displays-world-grid-20260921-evidence.json)
for exact unit names, invocation IDs, limits and next actions. Stop and clean up
completed transient units after their terminal receipts are recorded.

## September 21: road precision narrowed; complete control-plan build running

Small, retained original-geometry probes establish that both control-plan road
captures retain their eight shortest lines at zoom 20; Road Network requires
zoom 21. Zoom 19/20 intermediate results include disappearing and reappearing tiny
lines, so precision is established from decoded positive-length geometry rather
than assuming monotonic retention. MapLibre's installed geometry loader rounds to
its internal extent; merely increasing the encoded tile extent would not solve
rendering loss.

One complete 17,888-record control-plan capture is building at zoom 20, with six
null geometries retained as unlocated. The conversion is limited to 2400 wall
seconds, 3600 CPU seconds, 8 GiB address space, 4 GiB intermediate files and 2 GiB
final display; it stops if free disk falls below 4 GiB. Native identity/property
verification and the actual viewer must pass before any admission. No probe subset
is a catalog archive. Soil and combined-glacier builds remain active.

There are still 435 enabled archive choices. No S3 write or deployment occurred in
this continuation. Syntax, whitespace and foundations pass; parity retains 116
prior artifact checksum failures. See [road precision continuation evidence](road-precision-continuation-20260921-evidence.json)
for active handles and the next actions. Never restart work from a state file alone.

## September 21: complete regional fire archive enabled

The ICIMOD fire Layer now has a private tiled archive containing all 1,397,461
captured records. Native identity and attribute checks, 14 point geometry probes,
and the actual local Workbench viewer pass. Overview and detail images were
inspected. The 15 tested views read 10,115,037 bytes through 133 local range
requests; the first test's cumulative 100-request limit was inappropriate for
multiple views. The revised check measures each view independently, retains a
32 MiB overall byte cap, and records actual transfers. This is not hosted S3 cost
or sign-in acceptance.

Six display/evidence objects and an immutable manifest are preserved under the
private regional/hkh/icimod prefix. The source Layer is linked; Aaron and Categorise
runtime access checks pass. Total enabled archive choices is 435. Live remains the
default and archive reads remain deliberate.

Remaining: 15 NSDI URLs, four regional URLs, and soil displays. Soil is actively
converting all 4,414,467 records. The combined glacier build stopped with SIGKILL
under its original CPU cap and produced no reusable tiles; its exact cause is not
independently established. One bounded retry allows 3600 wall seconds and 7200 CPU
seconds for this four-year capture. Inspect the recorded process handles before
acting. The soil registration helper now links original S3 capture evidence and
explicit native projection lineage, but no soil display is admitted yet.

Syntax, whitespace and foundations pass. Parity retains 116 existing artifact
checksum failures. No deployment or hosted sign-in acceptance is claimed.
See [fire admission evidence](fire-archive-admission-20260921-evidence.json).

## September 21: Bhutan 50k roads and all separate glacier years admitted

Six more archive choices are enabled: two Bhutan 50k road source Layers and the
matching regional 2000 and 1990 glacier pairs. Exact duplicate captures share display
objects while source identities and provenance remain separate. Native verification
retains all 15,514 spatial road records and all 65,394 / 65,188 glacier records, with
no missing identities or attribute differences. The road original additionally
retains 74 null geometries without invented positions. Actual local Workbench checks
and all tiny-feature probes pass. Both account runtime checks pass; total enabled
reviewed choices is 434. This does not establish hosted sign-in acceptance.

Remaining displays: five regional sources, 15 NSDI source URLs / 12 distinct
contents, and soil. The combined glacier capture is converting. The first complete
fire conversion reached its 1800-second limit. Its retained zooms 4–11 exactly match
all source-point/buffer tile locations; a bounded continuation builds only 12–14
before packing unchanged tile payloads and rechecking full native content.

All 4,414,467 soil identities and preserved chunks are verified. The two native
features retain all 92,645 rings and 1,841,274 vertices through explicit EPSG:3857 to
EPSG:4326 preparation. Original ring coordinates and hole membership match before
projection; every serialized vertex passes round-trip checks within 10 micrometres
(observed maximum under 4 nanometres). This is transformation fidelity, not source
positional accuracy. Complete local soil input assembly now contains all 4,414,467 identities (3.66 GB);
no soil tiled display is enabled. Originals remain unchanged.

Foundations, syntax and whitespace pass. Parity retains 116 prior artifact checksum
failures. See [roads, glacier and soil evidence](roads-glacier-years-20260921-evidence.json).
Inspect current continuation handles before acting; completed captures and admissions
must not be repeated.

## September 21: 2010 glacier archives enabled; Bhutan road precision profiled

Two separate regional 2010 glacier source Layers now share one verified private
250 MB display. All 64,885 identities and attributes pass native verification;
eight smallest polygon probes pass geometry and actual Workbench rendering checks.
Both Aaron and Categorise runtime access checks pass. There are 428 enabled reviewed
archive choices. Originals, permissions and default visibility are unchanged.

Nine preserved regional sources, 17 NSDI sources and soil still need display work.
The 2000 glacier and regional fire conversions are running, with bounded local
review continuations. The 50k Bhutan road conversion also started after exact-source
profiling and small precision probes. Its 15,588 original records include 74 null
geometries; those remain unlocated. Two control-plan captures each contain six null
geometries and Road Network contains nine. Their tiny-line probes need higher
precision than zoom 18; a full country-wide zoom-22 conversion is not justified by
those small probes. No road display is admitted by this checkpoint.

Foundations, syntax and whitespace checks pass. Parity retains 116 existing artifact
checksum failures. Deployment and hosted signed-in acceptance remain separate.
Inspect current build and review handles before continuing; never restart from a
saved building status alone.

See [glacier and road evidence](glacier-2010-road-profiles-20260921-evidence.json).

## September 21: three glacier archive choices verified and enabled

Afghanistan's 15,301-record glacier capture and the two matching regional 2020
63,761-record sources now have verified private tiled displays. Each distinct
Layer retains its source identity and metadata; the regional pair shares one
display object. Aaron and Categorise runtime access checks pass for all three.
The latest runtime count is 426 enabled reviewed archive choices. These checks
do not establish hosted signed-in browser acceptance.

Full native identity/property verification and local built Workbench checks pass.
Regional geometry review identified one legitimate buffered tile clipping corner,
inside the original polygon with both adjacent edges on the clipping rectangle.
Focused negative cases cover holes, outside points, arbitrary interior points and
wrong buffer/edge positions. Other vertices retain the existing tolerance; no
artifact rebuild or relaxed source geometry threshold was needed.

Eleven of the 143 preserved regional sources still need displays, plus 17 NSDI
sources and soil. Fire conversion was interrupted before output completion; its
partial files are retained. A bounded restart and the 2010 glacier conversion are
running locally. Inspect their live handles before acting; no admission is implied
by a build state file. Originals must not be recaptured or overwritten.

Foundations and focused checks pass. Parity retains 116 artifact checksum failures;
no evidence was resealed. Next: complete these displays, finish the remaining large
captures and source geometry exceptions, then hosted acceptance.

See [glacier admission evidence](glacier-admissions-20260921-evidence.json).

## September 21: glacier captures reconciled; bounded display checks running

The complete 143-source preservation inventory has 14 sources without matching
successful display-admission receipts. The preceding count of 11 covered only
existing deferred plans and omitted the final fire and two combined-glacier batches.
Raw captures are already preserved; this is a display queue correction, not a
request to recapture data. Seventeen NSDI sources and soil display also remain.

All four yearly glacier pairs (1990, 2000, 2010, 2020) have matching complete
geometry/attribute fingerprints. Source identities, CRS metadata and dates remain
separate. Both combined 259,228-record captures also match exactly. All eleven
sources are verified and form six distinct complete contents. A bounded local
continuation is building and reviewing Afghanistan plus the regional 2020 display.
Inspect the live session and receipts before acting;
no S3 or catalog changes are established by this running checkpoint.

Provider sample Continent and World captures have 11 and 567 out-of-range coordinate
vertices respectively; their original EPSG:4326 metadata extents also exceed valid
bounds. Originals remain unchanged. A labelled clipped display requires separate
review; neither is currently admitted. Syntax, whitespace and foundations pass;
parity retains 116 artifact checksum mismatches.

See [glacier work evidence](glacier-display-work-20260921-evidence.json).

## September 21: BasinModel and plot-boundary archive displays registered

Ten ICIMOD BasinModel source Layers now reference two private, verified regional
display objects. Each scenario retains all 480 basin/month records and non-null
attributes. Separate source identities, rights, renderer metadata and original
capture references remain intact. RCP 4.5 and RCP 8.5 are model scenarios; encoded
Gregorian years 2007, 2020, 2030, 2040 and 2050 are model dates, not acquisition or
observation dates. Exact-year versus representative-period semantics remain
unverified. Generic display verification does not establish thematic/time filtering.

The Bhutan Plot Boundary Layer now has a verified private display retaining all
238,000 polygon identities and non-null attributes. MVT omits null attributes on
103 records; the original nulls remain preserved and this difference is recorded.
Native review, actual built Workbench
rendering and eight tiny-polygon geometry probes pass. Exact original geometry is
preserved; sampled tile edge distances do not establish source positional accuracy.

All eleven archive choices pass Aaron and Categorise runtime access checks without
S3 reads. There are 423 enabled reviewed choices. Live remains default; archive
reads still require user action. Original S3 files, grants and map visibility were
not changed. No application deployment or hosted signed-in browser test occurred.

Remaining: 17 NSDI source URLs / 13 unique captures, 11 deferred regional entries,
soil display, model presentation and hosted acceptance. Completed captures must
not be repeated. Continue with bounded displays and retain explicit exceptions for
empty, invalid or unrepresentable source geometries. Foundations passes; aggregate
parity retains 116 artifact checksum mismatches, with no evidence resealing.

See [BasinModel and parcel evidence](basin-parcel-displays-20260921-evidence.json).

## September 21: both historical buildings Layers share a verified archive display

The distinct NSDI `buildlings` and `buildlings_view` Layers now share one private
display derived from their byte-identical original captures. All 343,949 polygons
and every non-null attribute pass native tile verification. Original geometries,
source endpoints, catalog identities, rights and lineage remain separate. The
344,928,752-byte display uses zoom 18; all identities are retained.
No source attributes were omitted. Exact original geometry remains preserved.

The built Workbench renders eight smallest-area polygons and ordinary coverage
using 63 local range requests / 3,504,913 bytes, with no archive
reads before selection and no external requests. Sampled vertices pass the
recorded tile-resolution edge-distance check; this is not source positional
accuracy or full geometric equivalence. Aaron and Categorise runtime repository
checks pass for both Layers without S3 reads. There are now
412 enabled reviewed archive choices. No deployment or hosted signed-in
browser acceptance was performed. Live remains default and archive use is explicit.

The interrupted zoom-22 conversion was confirmed stopped before this complete
zoom-18 conversion began; its incomplete intermediate is retained for diagnosis.
The native verifier now streams large GeoJSON through a bounded standard JSON
decoder, retaining nulls and nested attributes. Focused parser fixtures cover
large values, numeric fidelity, malformed/trailing content and duplicate root keys.

Remaining: 18 NSDI source URLs / 14 unique original captures require display
admission. Land-cover 2020 has three small polygons retained by the maximum-zoom
probe; a full country-wide zoom-22 conversion is not justified by that probe.
The MapServer roads capture has 72 empty lines plus three omitted nonempty lines;
two microscopic segments still collapse at supported maximum tile precision.
Keep these cases explicit; do not relabel them empty or silently omit them.
Soil/regional capture and preservation are already complete. Continue display
work and hosted acceptance; the broader goal remains open.

Focused syntax, parser, native content, browser, geometry, access and foundations
checks pass. Aggregate parity still reports retained artifact checksum mismatches;
no evidence was resealed to bypass them. One database resume response preceded any
transaction; the bounded retry reused successful object checks and committed.

See [shared-building evidence](nsdi-shared-buildings-20260921-evidence.json).

## September 21: shared buildings conversion and source-precision review in progress

Two distinct NSDI buildings Layers have byte-identical preserved captures containing
343,949 polygons. The interrupted zoom-22 builder and continuation driver were
confirmed absent from both their exec handles and the host process list; the partial
intermediate remains retained. A full-source zoom-18 conversion is running under
fixed CPU/memory/time limits, followed by automatic native identity/property review.
No source subset is substituted and no new S3 copy or catalog choice is enabled yet.
Recheck the live handles in the work evidence; stored running status is not liveness.

The large-file verifier now streams root GeoJSON features using the standard JSON
decoder. Focused fixtures pass for chunk boundaries, nested metadata, numbers/nulls,
large values, malformed content and duplicate root keys. Actual LULC 2020 native
review agrees with the independent jq-based review: 60,967 of 60,970 identities,
with no observed property mismatches. All three missing polygons survive a bounded
zoom-22 geometry probe; this does not justify a full high-zoom country-wide rebuild.
MapServer roads retain 72 empty LineString records in their original archive and
15,513 of 15,516 nonempty identities in the existing tiles. Two microscopic segments
still collapse at supported maximum tile precision; do not call them empty records.
Rejected review receipts do not establish complete attribute/identity equality.

Next: inspect the existing builder and verifier, then complete browser verification,
private preservation, distinct Layer admission and both-account runtime checks.
Keep live connections as default and S3 reads deliberate. Broader NSDI, soil/regional
display and hosted acceptance work remains; completed captures must not be repeated.
See [current work evidence](nsdi-display-work-20260921-evidence.json).

## September 21: complete building-footprint archive display admitted

The historical NSDI Building footprint Layer now has an enabled private tiled copy.
All 142,694 located polygons and every non-null attribute pass native maximum-zoom
MVT verification, including the 96 tiny polygons absent from the previous display.
The original retains all 143,059 records: 198 null geometries and 167 empty polygons
have no invented map positions. MVT omits source null attributes for
25,928 features; original nulls remain preserved and the descriptor
states this representation difference. Two captured footprints lie far south of
Bhutan; their original coordinates are retained as source observations, not corrected
without evidence. The previous rejected display remains separate.

The full display is 473,836,449 bytes through zoom 22. The built Workbench
renders eight formerly missing polygons at their source positions using local range
transport (33 requests / 863,174 bytes), with zero archive requests before selection and zero
external network requests. This is not hosted signed-in browser acceptance. Exact private S3
versions/checksums and the complete 64 KiB block index are preserved. The existing
runtime supports the representation; no API/UI deployment or source recapture was
performed. Aaron and Categorise runtime metadata readback passes without storage
access; 410 enabled archive choices are visible. Live remains the default; admission changes
no saved map visibility, and the archived copy requires explicit selection.

The current remaining NSDI display inventory is
`nsdi-display-remaining-after-buildings-20260921.json`: 20 source URLs / 15 unique
original contents. A separate ten-feature road precision probe recovers every
previously omitted nonzero segment at zoom 22; that is not full-road acceptance.
Avoid a blind high-zoom rebuild of long roads or country-covering polygons: establish
bounded tile volume before the next full conversion. Soil recovery is already complete
and preserved (4,414,467 records); regional recovery is also preserved. Do not repeat
those captures/uploads. Continue their required map representations and the remaining
NSDI displays. Hosted acceptance and the separate prepared Studio UI deployment
question remain open. The overall Bhutan goal is not complete.

Focused syntax, whitespace and foundations checks pass. Aggregate parity still
reports retained artifact checksum mismatches; no evidence was resealed to bypass
those failures. The initial database resume response occurred before any transaction;
one bounded retry reused the verified S3 objects and committed successfully.

See [building archive evidence](nsdi-building-display-20260921-evidence.json).

## September 21: all Sri Lanka S3 files linked to active catalog records

All 179 objects under `example-geodata/sri-lanka/` are reconciled: 173 nonempty
files are linked to 32 active catalog records, and six empty ArcGIS lock files
remain inventory-only. Eight existing records were reused and 24 new logical
datasets were registered in Aaron's Sri Lanka workspace. Owner and Categorise
editor runtime readback passed. Sidecars, original ZIPs, alternate exports, XML,
PDFs and workbooks remain linked instead of becoming duplicate map layers.

Every nonempty S3 object matches a local copy. Thirty-three metadata-only multipart
HEADs recovered the original part boundaries; single/multipart MD5 matching is
recorded separately from local SHA-256. Original null S3 versions are not called
immutable. No original S3 object was overwritten. Managed inputs total
768,895,183 bytes; 80 private artifacts totaling
1,058,905,649 bytes passed exact version/checksum HEAD verification.
No new cloud infrastructure or deployment was needed.

Eight DIVA-GIS ZIPs exactly match official public downloads (415,058 bytes).
Existing seven MapCruzin/OSM matches were reused. Survey Department/HDX 2019
metadata and related exports are retained, but today's HDX files have different
names/sizes. WFP's saved WFS request and VaeSSA's embedded metadata and primary
project page support provenance without proving current public file identity.
Historical HTTPS endpoint checks failed. Local modification/change times are
observations, not asserted initial acquisition dates. Full original source files
and XML remain preserved, with selected provider facts carried into knowledge.

Six raster representations preserve every base pixel, source CRS and geotransform;
two workbook representations preserve populated cells/formulas/links while originals
retain layout. A WKT fallback bug incorrectly selected nested EPSG unit IDs; root-only
parsing now rejects those before registration. Three legacy rasters retain their
source WKT with unidentified CRS authority, not fabricated EPSG:4326. Focused worker
tests, changed-file Ruff and mypy pass. These operator/worker source corrections
were used for this catalog operation; no production worker image was deployed.
Two initial job-claim failures were normally
released before output uploads; the first ten jobs then completed. A larger bounded
offline retry completed the 2001 land-cover file. Completed inputs were reused.

The built catalog preview passed desktop/mobile checks with actual DCW roads and
zero hidden archive reads using intercepted local transport. This is not signed-in
production UI acceptance. 11 large vector previews exceed the existing 4 MiB API
limit; raster/original ZIP previews are not claimed. The prepared Studio preview
release still awaits the existing deployment answer. Aggregate parity still reports
retained artifact checksum mismatches; evidence was not resealed to hide them.

Next: broader Bhutan work remains open, including 21 large NSDI source displays.
The local z22 building precision probe retains all 96 previously missing nonempty
polygons, but full build/property/browser acceptance remains outstanding. Keep
archive reads explicit and original source/derived representations distinct.
See [Sri Lanka completion evidence](srilanka-complete-catalog-20260921-evidence.json).


## September 21: three source-matched Nepal survey archives active

Three additional Layers are active in Aaron's existing Nepal workspace, with
Categorise editor access verified: major roads (1,086 features), municipal areas
(58 polygons) and municipal headquarters (58 points). All three original S3 ZIPs
are exact SHA-256 matches to the HDX public downloads. The extra roads ZIP is a
byte-identical duplicate linked to the same Layer; neither original was deleted.
The public records attribute the datasets to the Survey Department, Nepal.

Every source feature ID, attribute and WGS84 coordinate was checked before offline
GIS/malware inspection and normal authorized worker completion. Twelve private
worker derivatives totaling 2,828,022 bytes passed exact S3 version/checksum checks.
The three managed display inputs total 2,503,034 bytes. Original ZIPs were not
rewritten. Original null-version S3 objects are explicitly not described as immutable.
Public matching used three downloads totaling 779,677 bytes; no repeated provider
fetch was used for UI verification.

The catalog knowledge preserves complete HDX package metadata, exact original S3
identities/checksums and embedded XML member hashes. Full embedded metadata remains
inside each original ZIP. The municipality package's 2001 date and description's
2014 reference year remain conflicting source statements. Placeholder embedded XML
fields are not asserted as facts. Roads list CC BY-IGO; municipality records list
Other with their original terms link. Rights are recorded separately, not inferred
from public access or applied across distributions. Initial acquisition is unknown.

The Nepal Collection contains the new all-off grouped map
`ca822942-618c-4a11-8683-efb516a94256`. Owner/editor runtime readback and the actual
built Workbench with all three retained previews passed. Local browser checks saw
zero hidden reads and no additional reads on repeated visibility toggles. They use
intercepted local transport, not signed-in production browser acceptance. Existing
application artifacts were reused; no deployment or new infrastructure was needed.
One initial database timeout occurred before any dataset creation; a single bounded
retry reused the original checks and completed successfully.

The catalog workstream now has 551 registered Layers (349 Bhutan unchanged).
The 21 remaining large NSDI source displays and broader S3 registration remain open.
Continue those reconciliations and public matching; the separate prepared Studio
archive-preview/reader release still awaits the existing deployment answer.
See [Nepal survey evidence](nepal-survey-catalog-20260921-evidence.json).

## September 21: Bhutan wind originals relocated and catalog archive preview prepared

Both original NREL wind ZIPs now have verified private copies at
`example-geodata/bhutan/nrel/`. SHA-256 comparisons passed before reversible delete
markers hid the old `nepal/` keys. All historical object versions remain intact;
there were no version deletions. The bounded move used 18 S3 requests. Knowledge
revision 2 points to the new exact objects and retains the relocation trail; Aaron
and Categorise runtime readbacks passed. Only the two destination keys were added
to the existing private-access deny policy. Older operator release scripts that
pin the previous bucket-policy hash need a deliberate baseline review before use.

A prominent **Preview archived data** action is now implemented directly beneath
the catalog Layer title and description for active managed vector archives. It uses
the existing authorized, version-pinned, bounded spatial-preview endpoint and needs
no provider connection or Project assignment. No archive reads occur before a click.
Hide/reopen reuses the current preview; sampled previews show their limits. Pending,
unreadable, repository-only and unsupported formats do not advertise this action.
This increment does not claim raster or arbitrary original ZIP preview support.

Focused tests and the built catalog UI with the actual 899 wind polygons pass.
Desktop and 390-pixel mobile visuals were reviewed; zero reads before selection and
zero additional reads on reopen were observed with intercepted local transport.
Build, release seal, PWA, foundations and whitespace checks pass. Aggregate parity
still reports existing retained-artifact checksum mismatches; evidence was not resealed
to hide them. This is local UI acceptance, not signed-in production acceptance.

The updated 309-file Studio release is prepared with tree digest
`b1fb7e7bec137261a3234996f1968b7e5af59fef65bc7fb56a712568464d2bc4`.
It includes the previously prepared archive reader compatibility changes. It has not
been deployed; the existing Studio deployment question remains pending. Registration
counts remain 548 overall / 349 Bhutan; 21 large NSDI sources remain unresolved.
Next: deploy and verify the prepared UI when authorized, continue Nepal/Sri Lanka
S3 registration with public-record matching, and reconcile the remaining NSDI displays.
See [relocation and catalog preview evidence](catalog-archive-preview-20260921-evidence.json).

## September 21: source-matched NREL Bhutan wind archive registered

The existing S3 wind-data ZIP and methods-report ZIP under `nepal/` are exact SHA-256
matches to the official NREL/OpenEI public downloads linked from the Department of
Energy catalog. Their content belongs to Bhutan. The originals remain unchanged and
the legacy prefix is documented; the new managed Layer is in Aaron's Bhutan workspace
with Categorise editor access. Its source knowledge retains the original object
versions/checksums, public URLs, embedded XML and projected CRS, methods-report
reference and current official CC BY 4.0 statement. Initial acquisition remains
unknown. January 14, 2009 is an embedded metadata/process date, not a download date.
Placeholder/stale source XML fields are preserved separately from observed facts.

All 899 polygon identities and attributes are preserved in a WGS84 display copy;
every transformed coordinate was checked. The embedded custom Drukref03 Transverse
Mercator WKT remains retained without assigning an inferred EPSG identifier or
claiming established absolute datum accuracy. Offline GIS/malware inspection, normal
worker completion, four exact derivative S3 version/checksum checks, and both-account
runtime readback pass. The source match used two S3 GETs and three public requests,
totaling 1,135,550 bytes. The private display input is 1,028,383 bytes; four verified
worker derivatives total 1,872,294 bytes. No original overwrite or deployment occurred.

An all-off grouped wind map is persisted in the Bhutan Collection. Actual built
Workbench rendering passes with the complete 899-feature preview, zero hidden reads
and no extra read on repeated visibility toggles. Visual evidence waits for redraw
after re-enable. Transport is locally intercepted; signed-in hosted browser acceptance
is not claimed. No live map service was identified for this matched distribution, so
this Layer explicitly uses its archive rather than pretending the download is a live
provider connection.

The catalog workstream now has 548 Layers, including 349 Bhutan. Reviewed NSDI/archive
choices remain 409. The 21 pending large NSDI sources remain open. Investigation of
two existing rejected displays found three tiny LULC 2020 polygons and, separately,
167 empty building polygons plus 96 located building polygons omitted at zoom 14.
Their original geometries are preserved; do not relabel missing polygons as complete
or blindly rebuild all country-wide coverage at extreme zoom. Continue the remaining
S3 catalog/source matching and develop a bounded faithful representation for these
exceptions. The prior Studio reader deployment question remains pending.
See [wind catalog evidence](bhutan-wind-catalog-20260921-evidence.json).

## September 21: three river archive choices enabled with original source lineage

The NSDI 50k_Bhutan and Topography_50k FeatureServer river Layers now share one
reviewed PMTiles archive because their complete historical captures are byte-identical.
Each keeps its own public endpoint, original S3 reference and Layer identity. The
separate MapServer river Layer has its own verified display copy. All three are
persisted in production and visible through Aaron and Categorise runtime authorization;
metadata listing performs no storage reads. Live remains the default, map visibility
is unchanged and archive use remains deliberate.

Both artifacts preserve all 160,835 ordinary river line identities and exact native
attributes. The FeatureServer originals retain 253 unlocated records. The MapServer
original retains 246 empty lines; seven zero-length lines have explicitly named
location markers at their sole original coordinates. An intermediate conversion
that consumed FID as a database key was rejected; the corrected intermediate retains
FID as an attribute, and the final native check compares every original property.
Zoom 14 lost eight tiny lines per artifact; zoom 16 retains them, and all 16 tiny-line
probes render in the actual built Workbench at zoom 21. Original geometry is preserved
separately; display tiles remain quantized and clipped. No synthetic line lengths
or locations were introduced.

Two private display artifacts plus reviews/indexes/manifests uploaded 359,893,062
bytes across 36 S3 requests. No originals were overwritten. Local browser checks used
7,538,986 and 10,910,299 range bytes; these are bounded representative local tests,
not hosted egress guarantees or signed-in browser acceptance. The existing deployed
runtime supports these archives; no application deployment was needed. Database
cold-start retries reused checks for both the artifact and checksum index.

There are now 409 reviewed archive choices, with 21 large NSDI sources representing
16 distinct original byte sets still awaiting display reconciliation. Registered
Layer counts remain 547 overall and 348 Bhutan. Continue the remaining NSDI/country
catalog work and public-source matching, then regional soil recovery. The prepared
Studio reader release still awaits its existing deployment approval question.
Focused checks and foundations passed; aggregate parity retains prior artifact SHA
mismatches. See [river reconciliation evidence](nsdi-river-reconciliation-20260921-evidence.json).

## September 21: GMC parcel archive enabled and duplicate captures linked

The historical GMC Board plots Layer (FeatureServer/5) now has an explicit private
PMTiles archive choice. All 55,309 spatial identities and every non-null attribute
are verified in the native tiles. 72 source records have a null `datemodifi` field
that MVT omits (85 tile-fragment occurrences); that limitation is explicit in the
review and descriptor, and originals retain the nulls. Exact property equality is
not asserted. The verifier rejects this by default; the explicit null-omission
review still rejects missing non-null values, type changes and invented fields.
Focused tests cover those distinctions. No geometry simplification was added;
normal tile quantization and clipping remain declared.

The existing artifact was reused, rendered through the built Workbench, preserved
under the private Bhutan prefix and admitted to the existing source record. Both
Aaron and Categorise repository readbacks pass without storage reads. Initial local
rendering used four byte ranges totaling 3,513,258 bytes; this is representative
local transport evidence, not a hosted cost or signed-in browser guarantee. Five
new S3 objects including the restoration manifest total 45,622,404 bytes. Original
archives, source identities, grants and map visibility were unchanged. The deployed
runtime already supports this archive format; no application deployment is needed.

Six checksum-identical pairs among the remaining original NSDI captures are now
linked in the 12 existing Layers' immutable knowledge revisions. Each retains its
own source URL, original S3 reference and metadata. Aaron writes and Categorise
readbacks passed. These are historical capture matches, not assertions that today's
public endpoints are equal. Reuse one future display derivative per matched byte
set after checking each source revision; do not duplicate processing or merge Layers.

There are now 406 reviewed archive choices. Of the earlier 25 large NSDI sources,
24 remain, representing 18 distinct original byte sets. The active goal remains
open, including those display reconciliations, regional soil recovery and broader
country catalog registration. The separate prepared Studio full-reader release is
still awaiting its existing approval question. See [reconciliation evidence](nsdi-display-reconciliation-20260921-evidence.json).

## September 21: exact MapCruzin public matches and 14 additional archive Layers

Seven Bhutan and seven Sri Lanka ZIPs already in S3 now have exact SHA-256 matches
to the current public downloads linked from MapCruzin's country pages. This is
byte-verified distribution provenance, not a title-based candidate association.
The check used 16 requests and 16,246,402 bytes. Source pages, ZIP URLs, checksums,
verification time and bundled READMEs are preserved in each catalog knowledge record.
Bhutan retains its historical CloudMade/OSM CC BY-SA 2.0 notice; Sri Lanka retains
Geofabrik/OSM ODbL and its September 3, 2014 snapshot. Initial acquisition dates
remain unknown; filesystem dates are not substituted for them. Bhutan's anomalous
provider label “coastline” remains explicit instead of silently reclassified.

All 14 Layers are active under Aaron, with Categorise editor access and both account
readbacks passed. Seven Bhutan Layers contain 1,152 features; seven Sri Lanka Layers
contain 110,760. Both country Collections have an added grouped map with all Layers
off. Original S3 ZIPs were untouched; 46,109,078 bytes of private display copies were
created, preserving every feature ID, attribute and coordinate. Actual offline GIS/
malware inspection and normal authorized worker completion passed, with 56 exact
S3 derivative versions/checksums verified. A Sri Lanka timestamp field is compared
as its original JSON string because GDAL's date inference reformats its display;
no source value is replaced.

The built Workbench renders representative point/polygon Layers for both countries,
with zero hidden data requests and no extra reads on repeated visibility toggles.
The full reader passes all 14 real inputs offline. Sri Lanka buildings, points and
roads exceed the small-preview feature limit; their complete hosted display awaits
the already prepared Studio release and its pending deployment approval. No new app
build or deployment was performed. No signed-in hosted browser acceptance is claimed.

The workstream now has 547 registered Layers, including 348 Bhutan; this is not all
S3 objects or full goal completion. Remaining country shapefiles, rasters, large or
mixed exports and original Bhutan recovery limits are still in the queue. Continue
catalog registration using retained source evidence; deploy the prepared release if
approved. See [this increment's evidence](mapcruzin-country-registration-evidence.json).

## September 21: Nepal/Sri Lanka S3 catalog and Bhutan Global Map increment

Latest user direction prioritizes cataloging existing S3 data and matching public
records, with Nepal and Sri Lanka added to Bhutan. The owner remains Aaron and
Categorise has editor access. No source S3 objects were overwritten or re-uploaded.

49 unique existing GeoJSON Layers are persisted: 48 Nepal and one Sri Lanka,
29,937 features, with three byte-identical S3 duplicates linked instead of repeated.
They have separate country access workspaces and private Collections containing
three grouped maps, all Layers initially off. Both account readbacks pass. Inventory
covers 501 S3 objects (including folders/sidecars); 481 nonempty objects outside
already-managed captures have pinned metadata. These counts are not dataset counts
and do not establish that all files are registered.

32 exact ICIMOD URLs were recovered from paired QGIS metadata and their public
layer metadata retrieved. HDX metadata provides ten matching local/S3 distribution
filenames. Geofabrik Nepal's local README dates that local snapshot to November 10,
2019; this date is not assigned to different S3 2020 bytes. Sri Lanka's README
identifies MapCruzin/Geofabrik/OSM and September 3, 2014. A retained WFP WFS request
identifies the Sri Lankan roads source. Global Map Bhutan 2.0 was found in the local
Nepal directory; geography is recorded separately from storage location. Nepal HOT
building ZIPs are local only in this inventory, not silently uploaded or registered
as S3 copies. Current metadata is not proof of equality to historical provider data.

Seven Bhutan Global Map 1.0 Layers also completed normal managed ingestion: 26,358
features and 28 exact S3 derivative checksums verified. Their all-off map is in the
Bhutan Collection. Original shapefile EPSG:4326 and GDAL's XYZ GeoJSON EPSG:4979
interpretation are retained separately. Four palette rasters still need CRS/legend
review. This increment brings the workstream to 533 registered Layers, 341 Bhutan;
it is not full goal completion.

A prepared Studio release fixes strict reading of checksum-pinned legacy S3 content
types, retains Overpass source text, and explicitly loads full managed GeoJSON when
bounded previews are insufficient. All 49 exact country archives pass the real
parser; a built Workbench renders representative country polygons with zero hidden
reads and cached visibility toggles. All 49 anonymous HEAD/CORS checks pass. Focused
tests, build, release/PWA, foundations and whitespace pass; aggregate parity still
fails artifact/evidence seals. Fresh deployment approval is pending. No signed-in
hosted browser acceptance is claimed. The earlier hidden-loading fix stays deployed.

Next: deploy this prepared Studio release if approved; continue catalog registration
of remaining S3 shapefiles, rasters, large/projected/mixed-geometry exports and legacy
Bhutan files using their correct formats and preserved public-source evidence.
Do not recopy the 49 originals or repeat completed inventory/provider checks.
See [country evidence](country-s3-registration-20260921-evidence.json) and
[Global Map evidence](bhutan-globalmap-registration-evidence.json).


## September 21: HOT originals linked and two usable layers registered

The existing S3 HOT files are confirmed: 18 POI objects and two related Garmin
objects. The retained HOT Export Tool README establishes OpenStreetMap attribution
and ODbL/DbCL terms. Export job/date remain unknown. Local timestamps stay separate
from first-encounter or export dates. No original S3 object was overwritten.

Two private display representations preserve all 2,236 points and 595 polygon
features from the byte-matched original GeoPackage. Actual GDAL/ClamAV inspection
and normal worker completion produced eight immutable derivatives (1,684,536 bytes),
all verified by S3 version, size and checksum. Both records are active, EPSG:4326,
owned by Aaron; Categorise access readback passes. The grouped map
`1f50a697-53ec-4eff-ac43-bfa39cc8c92d` is in the Bhutan collection, both layers off.
This increment brings the workstream to 477 registered Layers, 334 Bhutan; it does
not mean all remaining legacy files or upstream recoveries are complete.

The built Workbench renders the retained point and polygon previews. During review,
a hidden-layer preload was found and fixed for saved managed/archive layers. Focused
UI tests and an actual local browser show zero data reads on all-off map opening,
then one read per enabled layer and no extra reads on repeated visibility toggles.
Studio build/release/PWA and foundations pass. Aggregate parity retains prior
artifact/evidence hash failures. After explicit user deployment authorization, the loading fix is deployed to
production Studio as `opengeo-studio-20260921032408-ed92253b4b24`. Two public
artifact hashes match the tested release. Data registration is persisted; signed-in
hosted rendering remains untested. No API or Demo deployment was needed for this increment.

Next: continue remaining Global Map, MapCruzin and legacy representations. A reusable feature thumbnail and bounded
interactive preview would reduce browsing transfers. Current worker SVG thumbnails
only show extent and are not actual feature thumbnails. Do not generate previews
on catalog page opens, silently load archives, or promise all repeat reads are free.
See [HOT evidence](bhutan-hot-registration-evidence.json).


## September 20 catalog reconciliation release

Production now includes migration 0137, indexed source-metadata geometry,
preservation summaries, matching counts, incremental catalog loading and account
navigation. The previous migration-0136 release below is retained history.
Three existing GADM layers and an all-off source-grouped map are persisted with
owner/editor readback. Source-family research and local timestamp observations
remain explicit evidence, not a claim that all legacy S3 objects are cataloged.
See [current batch evidence](bhutan-catalog-sync-20260920-evidence.json) and the
active roadmap for remaining registration, representation and hosted acceptance.

## September 20 production release

Studio and the native ARM64 API are now deployed through migration 0136. See
[production evidence](bhutan-production-release-20260920-evidence.json) for exact
artifacts, security/health/desktop/phone checks, private uploader destinations,
cleanup and outstanding signed-in transfer/archive activation acceptance. The
September 19 hold below is historical and has been resolved by the native build.

The product direction is: connect once, curate once, reuse continuously. Layers
are resources; projects compose; artifacts preserve; publications explain;
collections organize; accounts govern; geographic tags connect. Connecting a layer
must not require an upload, a map, or copying the provider's data.

## September 19 release checkpoint

The current user request authorizes updates to Studio and Demo. The browser-only
Demo is deployed and its live editing/export/responsive journey passes. Studio is
prepared but held by fresh Python/zlib runtime security findings; no Studio schema,
API or static release writes occurred. The installed 104 migration hashes match,
with 105–126 staged. See [the release checkpoint](progress-release-20260919.md)
for immutable artifacts, the live-origin/stack-parameter drift, scan evidence and
the next bounded action. Local domain separation must still not be called deployed
Studio acceptance.

New Project creation from a temporary catalog Layer preview now allows explicit
access-workspace selection. Actual local runtime-role PostgreSQL and browser
acceptance verify creation in a different workspace and reopening the canonical
composition. Layer identity remains independent; attachment and Project creation
remain separate transactions with partial-link reporting. See
[workspace-choice evidence](catalog-workspace-choice-local-evidence.json).


## September 19: Demo catalog survives independently of Projects

Reviewed local and remote registrations now use a separate browser catalog, loaded
only for Demo. Confirming registration retains Layer/source/curated metadata and
local preview data; selecting it later remains deliberate and starts no provider
request merely by opening the catalog. Re-reviewing a registered Layer updates its
catalog record. Removing it from a Project does not remove the registration.

The store follows local-date daily expiry, bounds the catalog to 100 records and
2,000,000 serialized characters, and handles storage failure without replacing the
previous saved inventory. Reset Demo clears it. Catalog storage failure is shown in
the catalog panel; current-session registrations remain usable. The ordinary Studio
catalog and API authorization remain unchanged.

One focused store check, the affected Demo build and the existing browser registration
journey pass. The browser saves an empty Project, reloads, finds the earlier Layer in
the catalog, and reuses its preserved metadata; prior KML rendering, reference-only
reopening, WMS review and mobile checks still pass. Twenty-four WMS requests use
intercepted fixtures, zero external providers/private API/AWS/GitHub Actions. The first
build exposed the new module missing from the explicit Demo asset allowlist; included
it and rebuilt successfully. Foundations/whitespace pass; aggregate parity retains
changed-file evidence hash failures. See [local evidence](demo-catalog-persistence-local-evidence.json).

The exact Demo tree `ce6dd61eee6288e3f228f7d68a4192d8fb5bbbb5f2484968bd26fd11cf0c2603`
is preserved under the local archive for a bundled release with prior remote-reference
restoration and review changes. Next prepare that bounded Demo release and its single
live-origin acceptance, respecting the release scope and cost limits. No deployment
occurred here. Multiple KML documents, provider discovery and live MassGIS coverage
remain open; native Studio runtime export approval remains pending.


## September 19: Bundled Demo catalog release deployed and verified

Deployed the preserved `ce6dd61eee62` public Demo bundle, combining independent
catalog persistence, remote-source review and reference-only reopening. The existing
release deployer verified 152 sealed files (5,144,436 bytes), changed only the existing
Demo distribution origin, completed one invalidation, checked public file hashes,
and removed its exact temporary grant. There were 171 tracked deployment calls
plus six IAM grant setup/cleanup calls, no database calls or GitHub Actions. The local
API venv lacked boto3; used the existing operator Python installation without adding
dependencies. No rebuild or native-runtime export was performed.

One live-origin browser journey passed registration/cancel, KML rendering and fit,
new-Project catalog selection, catalog reuse after saving an empty Project/reloading,
metadata retention, reference-only reopening, WMS review and mobile layout. WMS reads
were 28 intercepted fixtures; no private API or external provider was contacted.
See [deployed evidence](demo-catalog-deployment-evidence.json). The prior release
remains stored; Studio/API/migrations/publications are unchanged.

Next resolve independent simultaneous KML documents: the editor still has a single
legacy document/Layer slot. Preserve existing KML behavior while giving catalog imports
independent identity and document state; use bounded local fixtures before another
bundled build. Provider discovery and live MassGIS acceptance remain open. Studio
runtime export approval/security release remains pending; aggregate parity incomplete.


## September 19: KML source identity no longer overwrites catalog registrations

The KML audit found two distinct collisions: imports shared the catalog dataset ID
and the active map/editor occurrence ID. New Demo file imports now receive independent
catalog dataset identities before metadata review. The legacy `kml-places` occurrence
and historical IDs remain compatible. This prevents the second source from replacing
the first catalog record without pretending the editor already supports two documents.

The built browser journey imports two KML sources, reloads and finds both catalog
records with distinct IDs and their original document names/content retained. Existing
registration/reuse/metadata/WMS paths still pass. One Demo build and one browser run;
74 intercepted WMS fixtures, zero external/private API/AWS/GitHub Actions. Foundations
and whitespace pass; aggregate parity retains evidence-hash failures. See
[identity evidence](kml-catalog-identity-local-evidence.json). New build `b1e65af0fad2`
is preserved locally; the live Demo remains `ce6dd61eee62`.

Next migrate the active map/editor state. `importKmlPlaces` still removes the legacy
occurrence; `applyKmlPlacesDocument`, overlay/Region rendering, selection/drawing,
NetworkLink state and draft restoration still address that slot. Give each occurrence
its own document/report/NetworkLink state, use selection only to choose the editing
context, and serialize all documents. Preserve old saved drafts through an adapter.
Verify two displayed documents, independent edits/visibility/overlays and save/reload;
never claim simultaneous KML support from catalog-only preservation. This remains the
active implementation gap, not a completed parity target.

## Demo source registration and catalog selection

The deployed Demo now opens source review for local imports, fits confirmed geometry,
and opens a searchable Layer catalog when creating a Project. The live synthetic
KML/community journey verifies cancellation, actual rendered features, same-Project
selection and curated metadata after local save/reload. No private API or external
provider was contacted by that acceptance run. See [the maintained contract](browser-layer-registration.md)
and [deployed evidence](demo-registration-deployment-evidence.json). MassGIS reference
rehydration across Projects, independent catalog persistence and multiple KML documents
remain separate acceptance gaps.


## September 19: Collection member image previews accepted locally

Collection detail now offers **Load member previews**, reusing the bounded retained
Project outputs already used by gallery cards. Preview responses retain entry identity;
images match only accessible saved entries, including when titles coincide. Loading
is deliberate, filters reuse the response, and failed images preserve member links.
License and attribution remain visible. No rendering or copying is triggered.

Nine focused checks, one Studio build and the existing local API/PostgreSQL/browser
release journey pass, including decoding a deterministic PNG in a member card. The
journey also retains gallery/public preview and release-revocation checks. Container
cleanup verified; no AWS, provider or GitHub Actions requests. See
[local evidence](collection-member-preview-local-evidence.json). This is not deployed
Studio acceptance. Publication previews remain next; native runtime approval and the
coordinated Studio release remain pending. Demo new-Project catalog selection was
already deployed and verified; remote reference restoration is pending deployment.


## September 19: Publication previews reuse retained map snapshots

Connected listed Publication snapshots to Collection gallery, member and anonymous
views. Discovery keeps member identity and source terms; image delivery bounds reads
to 1 MiB and revalidates edition/source access. The interface reuses deliberate preview
loading, with text links when no eligible image exists. No build or render is started.

Ten focused UI checks, fifteen Publication/site route checks and one bundled Studio
build pass. The existing local browser/API/runtime-role PostgreSQL journey decodes
Publication images in all three views, removes them after edition revocation, and
verifies source withdrawal without extra storage reads. It uses 126 migrations,
31 browser API requests and a synthetic PNG; the two existing fixture render jobs
remain unchanged. Container cleanup verified; zero AWS/provider/GitHub Actions calls.
See [local evidence](publication-preview-local-evidence.json). No deployment performed.

This covers retained map images, not generated covers for narrative-only/Framework
Publications. Next finish release lifecycle recovery/full-shell navigation acceptance
and denied append-to-existing-Project acceptance. Preserve pending Demo restoration
artifacts for the next bundled release. Studio release remains held on native runtime
security acceptance and the specifically requested build-export approval.


## September 19: Existing-Project append permissions and conflict recovery

Extended the existing built ImageServer browser/API/database journey. Reader append
and edit permission lost while the dialog is open both return denial and preserve
the entire Project. A forced competing title edit causes a version conflict; retry
rereads the Project, keeps that title, its previous layers and camera, and appends the
selected catalog Layer. Destination selection remains in the form after rejection.

The final run passes with 126 migrations, 41 browser API calls, two metadata and
40 tile fixtures, zero external calls, and verified container removal. No application
change or rebuild was required. The first run encountered the baseline's deliberately
revoked shared Style; restored that local fixture permission for the conflict journey.
See [append evidence](catalog-append-permissions-local-evidence.json). Real deployed
Studio acceptance and atomic cross-workspace attach/update remain open.

Next implement recoverable public-image release creation. `ArtifactReleases.js`
retains the form after an uncertain response, but `artifact_releases.create_release`
currently inserts a new identity for every call. Add durable request identity with
exact immutable input matching, current permission rechecks, and UI retry recovery;
prove a committed/lost response creates one release. Also complete full-shell draft
navigation protection. Keep the existing release visibility/revocation checks.


## September 19: Public-image release retry recovers exact identity

Migration 0127 adds an optional immutable creation key, unique within the account and
creator. Release creation serializes that key, rechecks current publish and source
eligibility, compares Artifact/version/title/license/attribution, and returns the
existing identity only for an exact active match. Changed intent and revoked replay
return conflicts. Legacy clients without a key remain compatible.

Studio freezes the submitted terms and key while retrying; Discard starts a separate
draft. The built browser journey drops a successful create response, retries, and
verifies the same ID and exactly one matching history record. One local API/database/
browser run passes with 127 migrations, 33 browser API requests, and preserved preview,
source withdrawal and release-revocation coverage. Container cleanup verified; no
AWS/provider/GitHub Actions calls. One Studio build, Ruff, foundations and whitespace
pass. Aggregate parity still fails changed-file evidence hashes; no blanket reseal.
See [recovery evidence](artifact-release-recovery-local-evidence.json).

Next add full-shell release draft navigation/target-switch guards and recovery after
reload. The current UI key lasts while the form is open; after reload, inspect history
before starting another release. No deployed acceptance or complete parity claim.


## September 19: Release drafts protected against navigation and target changes

Open release forms now block same-tab links, Back, account actions and account-select
changes. The captured account and URL remain in place, and beforeunload warns before
reload. Artifact identity/representation changes and edition operations also stop
while a release form is open. Workspace refresh reuses the existing draft check;
listeners clean up when the component is removed. Discard/success releases the guard.

Focused draft-guard/metadata-host checks and one Studio build pass. The reused local
browser/API/database release journey verifies links, Back, representation and target
rejection, then lost-response recovery and existing preview/revocation behavior.
It uses 127 migrations and 33 browser API calls; container cleanup verified, zero
AWS/provider/GitHub Actions. Foundations and whitespace pass. Aggregate parity still
fails changed-file evidence hashes. See [guard evidence](artifact-release-draft-guards-local-evidence.json).
Account/refresh checks do not yet have a complete live Workspace/Cognito journey.

Next implement reload recovery with a bounded session draft scoped to API origin,
verified user, selected account and Artifact. `OpenGeoApiClient.getSession()` supplies
verified user identity; do not store tokens or recover across actors/accounts. Preserve
submitted terms and creation key, offer deliberate recovery, and clear on success or
Discard. Unavailable storage must retain the current in-memory recovery/history path.
Keep current server authorization as the authority. No deployment this checkpoint.


## September 19: Release drafts survive reload in the verified account

Release forms now recover bounded session drafts scoped to API URL, verified user,
selected account and Artifact identity. Both editable drafts and frozen submitted
intent retain the original image edition and creation key. Restoring sends nothing;
Publish/Retry is deliberate. Current identity/membership are checked again before a
stored intent is submitted. Tokens are never stored. Success/Discard clear the draft.

Retention is limited to the browser tab, 24 hours, and 16 drafts per user/account/API
scope. Expired/malformed entries are rejected. Quota failures retain the open form
and history fallback. Two focused checks cover identity/API/account/Artifact isolation,
expiry, capacity and quota handling. One bundled Studio build and the reused local
browser/API/database journey pass: a committed response is lost, reload restores its
terms/key, retry returns the same release, and successful recovery clears storage.
The run applies 127 migrations, makes 39 browser API calls, and verifies container
cleanup with zero AWS/provider/GitHub Actions. See [reload evidence](artifact-release-reload-local-evidence.json).
Foundations/whitespace pass; aggregate parity still fails changed-file evidence hashes.

Next exercise release authoring inside the complete Workspace host, including account
and refresh transitions, then continue the tracked parity acceptance queue. The native
runtime build-export approval and deployed Studio security acceptance remain pending;
no rejected external action was retried. No deployment at this checkpoint.


## September 19: Workspace Resources preserve release drafts

Found and corrected a host boundary: opening/reloading another resource detail or
closing the current detail could replace an open release form. Both now consult the
release draft guard before changing the DOM or starting detail reads. Discard and
successful publication still allow normal navigation.

The existing release acceptance journey now opens the real built Workspace Resources
surface, selects the map resource, inspects its Artifact and opens a release draft.
It proves Close/resource replacement and Workspace links preserve the draft, no
replacement read starts, and Discard clears storage and releases the detail panel.
The same run retains release retry/reload, preview and revocation checks. One Studio
build and local API/runtime-role PostgreSQL/browser run pass: 127 migrations, 58
browser API calls, zero external calls and verified container cleanup. Foundations
and whitespace pass; aggregate parity still fails changed-file evidence hashes.
See [Workspace evidence](artifact-release-workspace-local-evidence.json). No deployment.
Live account switching and other refresh-producing host actions remain separate.

Next return to Demo's persistent Layer catalog: registrations currently live in the
Workbench session map, while saved browser Projects retain only their own Layers.
Preserve reviewed registrations independently within existing Demo reset/quota rules,
so switching or creating a Project and reloading does not require reconstructing its
sources/metadata. Reuse the existing registration/catalog journey and bundle the next
Demo build with pending remote-reference restoration. Keep simultaneous KML documents,
provider discovery and live MassGIS acceptance explicitly open. Native runtime export
approval and deployed Studio acceptance remain pending.

## Collection grouping and visibility audit

Collections already have independent account-scoped records, ordered map/site
references, explicit grants, optimistic revisions and durable authoring URLs.
They are arbitrary groupings, not tags. Optional knowledge revisions do not change
membership. Current sharing covers owner/account administrators and named readers/
editors. Migration 0123 now adds explicit account-wide reader visibility through
the same role resolver and revision-checked owner/admin control; public visibility
now has an initial listed-Publication-only anonymous projection and read page.
Public Project bindings and positive listed-member acceptance remain open. The current directory is
an authoring list/form, not the intended Collection gallery/member-card interface.
The next batch is defined in [the Collection contract](workspace-collections.md).
Preserve existing identities and independent member access throughout that work.

## Geographic-tag correction

The latest product direction treats Locations as optional reusable geographic tags.
Existing account-scoped Location storage and APIs are retained for compatibility;
the Studio directory, editor and catalog selector now use geographic-tag language.
Coordinates/geometry and parent relationships stay optional. No new database
classification, migration or ownership transfer is introduced. Layer-side tag
editing now uses dataset metadata edit authority independently of the existing
tag-side link permission. Wikidata context resolve/retain/reopen now has connected
local evidence with fixture provider transport; other resource interfaces, live
provider acceptance remain open. Ancestor-aware canonical catalog filtering now
has local connected evidence via migration 0121 and current metadata associations. See [geographic tags](geographic-tags.md) for the mapping and local receipt. The original audit and dated increments below
record implementation history, not a mandate to build a geographic hierarchy.

## Shared authored-resource metadata audit

Canonical maps and sites retain existing MAP/SITE permissions; Collections retain
explicit grants. Migration 0122 adds independent knowledge revisions with typed
foreign keys instead of putting geographic tags into render/build inputs. The
[shared knowledge contract](authored-resource-knowledge.md) records local API/database
evidence and remaining Studio integration. Collections now embed the shared editor
with connected draft protection and independent metadata save/reopen; Project and
Publication host integration remains open. No legacy access container is renamed.

## Architecture audit

| Concept | Existing implementation | Finding and migration direction |
| --- | --- | --- |
| Account | `app.organizations`, organization memberships, selected account in the browser adapter | Existing independent user identity and account membership are reusable. Preserve roles and tenant checks. |
| Layer | `app.datasets`, dataset versions, external sources/revisions, repository objects | Dataset UUID already identifies reusable data. `app.project_datasets` references it from multiple projects. A registered service needs no uploaded object. Broader database-source adapters remain future work. |
| Catalog | `/datasets` and `/catalog/layers` | The former deduplicates dataset identities; the latter enumerates saved map presentations and source connections. Previously presentations were the default and metadata links entered project management. Resources are now the default; presentations remain an explicit compatibility view. |
| Project | `app.projects` and `app.maps` | `projects` is currently an access/work container, with multiple versioned map compositions in `maps`. Do not rename the container into a collection: it is not necessarily one. A future authored-project identity should adapt the map identity while retaining container authorization. |
| Style | Styles within map definitions and governed resource styles | Reuse existing style assets and version bindings. Map-specific style selections are not new catalog layers. |
| Artifact | Saved-map render jobs, immutable outputs, portable static-map exports | Existing output/version pins are useful. A common current/versioned portable project-artifact contract remains to be connected. |
| Publication | Governed documents/pages, sites, Observable source projects, source revisions/builds and publication endpoints | Publications already have distinct site/source identities, but their editor is routed through the access container. Creation currently creates a container, document, site and source tree, without creating a map. Preserve this workflow; migrate to a publication identity route separately. |
| Collections and locations | No canonical equivalents established by this audit | Do not relabel clients, account containers or map extents as these concepts. Add independent identities and reference relationships in later increments. |

The browser uses Observable Framework with a sealed static route inventory. The
API is FastAPI; PostgreSQL/PostGIS stores identities and relationships. AWS S3,
CloudFront and processing services supply persistence and delivery. This work
changes local source and adds a forward development migration; it deploys no AWS
resources, changes no production permissions and copies no provider imagery.

## Increment 1: standalone resource inspection

`/layers?id=<dataset-uuid>` is a generic application shell rather than a generated
page per database row. `GET /datasets/{id}` resolves an existing authorized
project link internally. The compatibility payload's `project_id` is access
context, not resource identity or ownership. Old project data URLs still work.
The exact six-route predecessor is retained in an explicit rollback contract;
new builds include the layer shell.

Catalog resource links open the layer page. It shows recorded identity, extent,
CRS, geometry, access classification and update date; source configuration,
provider preview, data versions, nested schema and lineage load on demand.
Inspection performs reads only. Provider previews do not create maps or copies.
The source configuration is explicitly distinguished from original provider
metadata. Metadata editing uses existing dataset edit authorization.

## Increment 2: persistent knowledge and uncertainty

Migration `0105_dataset_knowledge.sql` adds append-only dataset-bound revisions.
They survive removal of an individual project reference and do not increment
map/data versions or schedule builds. No source migration, backfill, ownership
change or rights inference occurs.

- `GET /datasets/{id}/metadata` reads the latest revision; an absent record is
  revision zero with empty knowledge, not invented metadata.
- `GET /datasets/{id}/metadata?version=N` reads a specific historical revision.
- `PUT /datasets/{id}/metadata` accepts `expected_version` and `document`. A
  dataset row lock serializes writers; stale edits return HTTP 409. Revision
  authors/timestamps come from the authenticated server session.
- Reads and writes retain tenant and dataset authorization. Responses are
  `no-store`. Descriptive rights never grant application permissions.

The [document schema](../schemas/resource-knowledge-1.0.0.schema.json) separates
source documents, normalized assertions, curated assertions and inferred
assertions. Exact source text, including whitespace and nested JSON, remains
inside the immutable revision. It is bounded to fit the current database/API
transport; large source documents need a future governed object reference.
No automatic provider fetch or extraction is introduced in this increment.

Each assertion has a subject (`resource` or a distribution URI), vocabulary
property URI, nested JSON value and provenance. Optional confidence, evidence,
method, timestamp and agent remain attached to the claim. Unknown is represented
by a null value with `unknown` provenance. Machine inferences cannot be placed
in normalized or curated metadata. Source, normalized and curated assertions
are never automatically overwritten by an inference.

Distributions have independent identifiers and explicit custody: referenced,
hosted, cached, mirrored, derived, locally created, or unknown. A dataset's
license is not implicitly copied to distributions. Context consists of resource
references, relationship URIs, evidence and confidence, without ingestion or
transferring ownership/rights across the relationship.

Vocabulary guidance follows [DCAT 3](https://www.w3.org/TR/vocab-dcat-3/):
`http://purl.org/dc/terms/license`, `accessRights`, `rights`, `creator`, `publisher`
and `conformsTo` stay separate; use `http://www.w3.org/ns/odrl/2/hasPolicy` for
policy and `http://www.w3.org/ns/prov#wasDerivedFrom` for derivation. Claims can
carry nested objects without flattening them into strings. This is a bounded
knowledge-record contract, not a claim of full JSON-LD, DCAT, STAC, OGC Records or
ODRL conformance. Existing governed metadata import/export remains in place;
bridging its source documents and projections to canonical dataset knowledge is
still required. The [JSON-LD specification](https://www.w3.org/TR/json-ld11/)
provides the standard for a future interoperable projection.

The layer page provides readable sections and an advanced JSON editor. Saving
creates a revision; earlier revisions remain inspectable. A conflict retains the
draft and blocks reload until the user explicitly discards it. Fixture metadata
is session memory only; the production API path persists to PostgreSQL.

## Increment 3: reuse from the resource page

Readers with dataset-sharing rights can choose an active editable project and
add the existing dataset through the established `attachDataset` API. The
control explains the project's access consequences and links to project data
for map configuration. It creates a reference, not a dataset, upload, map or
style. Project and dataset authorization still run on the server. The current
picker now loads subsequent authorized 100-record pages on explicit request,
including after an ineligible first page. Raw page offsets, selection, account
boundaries and disposal are checked; the existing 10,000-offset ceiling is
disclosed. Nine focused cases are reused. Current-source Chromium also passes
keyboard pagination at 1280 px and selection/attachment at 390 px, including
the final-page hidden-button CSS fix, feedback, shared identity and no overflow.
This is an in-memory API-shaped fixture; exact built/hosted authorization
acceptance and the separate workspace loader limit remain open.

## Remaining sequence

The [active execution register](resource-model-roadmap.md) now owns priorities and acceptance boundaries. RM-03 is the next integration slice; the descriptions below remain implementation context.

Next, adapt existing governed resource metadata into this view without copying
claims into a false authority level, and connect source discovery to exact
metadata preservation. Expose compatible reusable styles from the layer page. Then separate authored map and publication identity routes from
the legacy access container, unify current/versioned project artifacts and
publication references, and add independent collections and locations. Contextual
street imagery should start as provider integrations and references.

Deployment requires migration 0105 followed by the compatible API and Studio
release. Until then, the metadata panel fails recoverably on older servers.
Rollback must retain the metadata table/history; earlier application releases
can ignore it. This document is the checkpoint for these local increments,
not a claim that the complete product workflow has shipped.

## GeoLens reference

The [GeoLens repository](https://github.com/geolens-io/geolens) describes distinct
uploaded, locally created, registered-table, imported-service and live-STAC
source modes, plus a separate map builder. The patterns worth adapting are a
searchable resource inventory, dedicated preview/schema/metadata inspection,
and explicit source freshness/last-check state. OpenGeo should preserve its
own distinction between references and copies for every connector. The demo
HTML did not expose its interactive UI to the read-only web fetch, so no live
GeoLens workflow acceptance is claimed. No GeoLens code or dependencies were
imported.

## Local verification checkpoint

- Focused Python API/repository/validator suite: 61 tests pass, including invalid
  claims, unknown rights, preserved source text, stale edits and read-only roles.
- PGlite executes the new canonical resource query and migration: authorized
  project resolution, direct dataset grants, cross-account isolation, immutable
  history, duplicate revision rejection and surviving project-link removal pass.
- Browser/component checks cover standalone resource URLs, canonical catalog
  defaults, retained presentation paging, API metadata save/reopen, draft
  preservation on conflict and exact predecessor release rollback contracts.
- Studio build succeeds with seven application routes. Chromium checks the
  actual built layer shell and desktop/390px metadata save/reopen views. The
  shell uses fixture identity; save/reopen uses the normal API client against
  a local HTTP store substitute. This does not establish a deployed or full
  API-to-PostgreSQL browser journey. Receipts/screenshots are local under
  `.local-archives/resource-model-20260919/`.
- Focused changed-module type checking, lint and `git diff --check` pass.
  Repository-wide mypy still reports an unrelated `framework_publisher.py:210`
  inferred dictionary type error. Foundation inventory checks report existing
  unregistered publication dependencies. Parity checks report stale path-backed
  hashes across the working tree; seals were not refreshed to hide those failures.

No cloud deployment, production migration or live account acceptance occurred.
The repository already contained extensive uncommitted work; these increments
remain a file-backed checkpoint without bundling that work into a commit.

## Continuation checkpoint: planning and draft safety

The [active plan](resource-model-roadmap.md) consolidates subsequent implementation
order and acceptance criteria. Repository instructions and maintained architecture,
account, API and data-model guides now distinguish product identities from legacy
containers. Historical milestone requirements remain in scope.

RM-Q1 holds metadata editing, save, discard and reload controls while save/reload
is pending. Deferred success/failure and discard/reload component tests pass; a
failed save preserves the draft. Both metadata and Layer-page test files pass.
Documentation links and whitespace checks pass. Foundation inventory and parity
checks were rerun and still fail for the recorded inventory/evidence drift; no
unreviewed evidence seals were regenerated. No deployment or full-browser acceptance
is claimed for this component-only fix. RM-03 remains the next integration slice.

## RM-03: existing governed metadata bridge

Layer inspection now discovers dataset-linked governed records through bounded
`GET /datasets/{id}/resources` and reads them in place. Dataset authorization gates
the endpoint; the repository separately filters each resource by membership,
project role, ownership or explicit resource grant before paging. Other accounts
and inaccessible siblings are excluded. No migration, backfill or provider fetch
is needed. Existing authorized detail/source endpoints remain authoritative.

The UI shows current revision, author/time, rights statements, nested profile and
extensions, provenance and identifiers. It distinguishes a changed current revision
from the listed revision. The latest retained import has its own version ID,
importer/time, source identity, checksum basis and conversion report; it may predate
the current record. Raw UTF-8 text is retained; structured JSON is explicitly labeled
as such. Values are never copied into dataset knowledge or promoted to source authority.

Focused resource API/repository tests, an actual SQL predicate test in PGlite and
Layer/component/client tests pass. The seven-route Studio build and static build
validation pass. Full cloud identity/API/PostgreSQL acceptance remains separate;
there was no AWS call, remote CI dispatch or deployment. RM-04 is the next slice.

Built Chromium additionally passes governed metadata listing, changed-revision
inspection, retained import inspection and reopening through the normal API client
against a local HTTP substitute, with all external requests blocked. The source
fixture was corrected to match the API translations object before the passing run.
This is UI/client acceptance with substitutions, not a real PostgreSQL/identity
provider journey. Updated receipts are in `.local-archives/resource-model-20260919/`.
Changed resource modules also pass focused mypy and Ruff checks.

## RM-04: guided knowledge curation

The Layer knowledge editor now offers forms for representation custody, scoped
claims and retained source text. Guided additions and the advanced JSON editor use
one draft and one optimistic revision save. Existing claims, nested values and
source text remain unchanged; new claims append with curated/inferred/unknown
provenance, optional evidence, method and confidence. Source/retrieval details are
explicitly user-supplied, not a verified fetch. Source documents are retained as
entered and bounded with the complete knowledge record; no text is truncated.

Unapplied guided entries block saving until added or cleared. Each form can be
cleared without discarding the shared draft. Read-only users see no curation form;
request controls remain held during saves/reloads, and conflicts retain the draft.
Focused tests cover scoped unknown rights, retained text, existing inferred nested
claims, shared revision save/reopen, pending-entry protection and individual clearing.

Automatic discovery capture is still open. The current engine discards response
bytes after normalization, and migration 0062 requires a strict normalized result.
The next batch must coordinate a compatible worker/database/API source-document
contract and registration linkage. The manual source form does not close that gap.

Final local validation: focused metadata/Layer tests and the seven-route/254-file
Studio build pass. Built Chromium exercises guided representation/unknown-rights
curation, preserved source text and 390px form layout through the normal API client
with the existing local HTTP substitute. Explicit select labels corrected a browser
accessibility failure. No deployed/full-stack acceptance is claimed. Foundation
inventory (10 issues) and parity checks (97 checksum mismatches) remain failing;
no unrelated evidence seals were changed. No cloud or remote CI work occurred.

## RM-04: bounded discovery preservation and Layer linkage

Migration 0106 retains immutable successful ArcGIS/WFS discovery responses separately
from normalized job results. The engine hashes the bytes already fetched and retains
up to 32 KiB exactly, encoded as base64. Larger valid responses have a checksum,
length and explicit non-retention status, never a truncated source. Failed/invalid
responses are not preserved. No HTTP headers or transport encoding are archived.
The completion wrapper verifies lease, length and checksum and atomically records
both result and document; the old worker/function result contract remains compatible.

Discovery registration passes the completed job identity. The API verifies matching
account, project, source type, endpoint and WFS collection before writes, then links
the initial source descriptor to the dataset. Linked metadata intentionally follows
Layer authorization, with this consequence stated at registration. It remains
available without listing the originating project's jobs. Manual registrations and
old completed jobs still work; missing original bytes are explicit. This is a new
reference relationship, not a data copy or a rights/ownership transfer.

Layer inspection uses `GET /datasets/{id}/discovery-metadata`, checks the SHA-256
before displaying/downloading exact bytes, and labels the initial discovery as
potentially older than the current source revision. Inspection is read-only and
makes no provider request. See the API contract and response schema for bounds.

Focused API/discovery/runtime/source-repository tests, actual completion-function
and RLS tests in PGlite, client/UI tests and six-module mypy/Ruff checks pass. The
seven-route/255-file Studio build passes. These remain local checks; migration 0106,
worker/API updates and Studio require an ordered release and real acceptance.
Broader source sizes/connectors and normalized claims remain open. RM-05 is next.

The built Chromium check also passes checksum-verified exact-response download,
comparing downloaded bytes with the original local fixture. It reuses the prior
metadata/Layer journey with external requests blocked. HTTP persistence and identity
remain substitutes; PGlite owns separate completion/RLS verification. Updated local
receipts are under `.local-archives/resource-model-20260919/`. Foundation inventory
and parity evidence hashes remain unresolved; no cloud or remote CI work ran.

## September 19: Layer Style inspection and workbench/publisher narrative

Layer inspection now lists the Styles of an accessible governed record, shows stable
identity and version, and reuses the existing checksum-verified definition/download
and immutable-version editor. Editing requires resource capabilities; missing
capabilities yield read-only inspection. Reloading the parent record preserves an
unsaved Style draft. Format support is explicitly distinct from field, geometry and
renderer compatibility. Map Style selection remains unavailable here; RM-05 stays
partial until explicit bindings can be reused in two saved/reopened compositions.
The source registration terms-review entry now starts blank.

README blends the supplied persistent-workspace draft with technical onboarding,
architecture and evidence links. It explains separate Layer/Style/Project/Artifact/
Publication/Collection/Account responsibilities, existing ecosystem integration,
GeoLens comparison status, metadata uncertainty and cost-efficient persistence.
It removes the stale claim that all evidence seals are current. Candidate integrations
and planned extensions remain distinct from implemented and deployed capabilities.

Focused Layer/Style and protected-copy component checks and the bundled seven-route,
255-file Studio build pass. The local built-browser journey verifies Style inspection
and exact definition download alongside metadata/discovery workflows. Identity and
HTTP persistence are substitutes; it is not full-stack or deployed acceptance.
No AWS, provider requests, remote Actions or deployments were used. Next: explicit
Style-version bindings and compatibility behavior in saved compositions (RM-05).


Checkpoint gates: README local file links and `git diff --check` pass. Foundation
inventory remains failing with 10 issues; parity retains 97 artifact checksum
mismatches. No seals were refreshed to mask changed inputs.

## September 19: exact immutable Style-version reads

Added the authorized exact-version read route and repository query for governed
Styles. It selects by account/project/resource/Style/revision, retains resource-read
authorization and returns 404 for a missing revision without falling back to current.
Responses use no-store; the client rejects substituted Style/resource/version values.
Existing latest-list and update contracts remain unchanged. No migration is needed.

This closes a prerequisite for persistent Style bindings: a composition must be
able to resolve its chosen version after later Style edits. It does not yet implement
map bindings, compatibility checks, fixture version history or version-selection UI.
Next RM-05 batch: define the composition binding and exact renderer compatibility,
validate access and dataset association at save/read, then expose selection and
exercise two compositions sharing a Style without copying its definition.

Focused repository and client checks pass, as do changed-module Ruff and mypy.
The initial route test lacked auth headers and correctly returned 401; the corrected
test explicitly checks unauthenticated rejection as well as authorized exact reads
and invalid version bounds. This is local API/client evidence, not real PostgreSQL,
browser composition or deployed acceptance. No build, AWS or remote CI was needed
for this read primitive. Aggregate parity remains incomplete.

Checkpoint gates: `git diff --check` passes. Foundation inventory reports 10
issues and parity reports 97 artifact mismatches; neither was resealed.
The corrected exact-version route test passes.

## September 19: Style history inspection and fixture retention

The shared definition editor now offers explicit version-number inspection through
the exact-version API/client. Identity, format, slug, revision and checksum must
match before the read-only historical definition appears. The existing verified
download exports that revision. Current edit drafts remain untouched; failed or
substituted history clears the historical display without falling back to latest.
No request is made merely by opening the page. The fixture adapter now retains
previous Style revisions and returns isolated copies rather than mutable aliases.

Audit for composition bindings: `currentProjectDefinition` currently serializes
inline style/labels; `addDataLayer`/paint helpers interpret those values directly.
The backend `saved_map_rendering` compiler also compiles inline presentation.
A binding must be integrated with all of these paths, dataset/resource association,
current access and explicit version resolution. Merely adding a reference field
would silently keep rendering the inline fallback. RM-05 remains partial; next is
the coordinated binding contract and renderer resolution, then two-composition
save/reopen acceptance. History inspection does not satisfy that acceptance.

Focused Style editor/Layer tests pass, including draft preservation, corrupt or
substituted history rejection, exact fixture history and mutation isolation.
This is local work; no AWS calls, remote Actions or deployment were performed.


The bundled seven-route/255-file Studio build and built Chromium check pass.
Chromium requested version 1 while the current listing was version 3, downloaded
`boundaries-v1.json`, and matched its bytes to the original historical definition.
This uses fixture identity and local HTTP substitution, with external requests
blocked; it is not authenticated API/PostgreSQL or deployed acceptance. Receipts
remain in `.local-archives/resource-model-20260919/`. `git diff --check` passes;
foundation inventory still reports 10 issues and parity 97 checksum mismatches.
No unrelated seals were refreshed.

## September 19: composition Style-reference contract and README positioning

Backend map definition 1.4 introduces exact Style references while preserving 1.3
writes and legacy reads. Save validation checks referenced resource access in its
own container plus same-account dataset association, immutable version, format and
checksum, with no latest fallback or copied definitions. Repeated references are
deduplicated per save transaction. Imports reject references pending deliberate
rebinding. Studio continues to reject 1.4 as unsupported; static rendering now fails
explicitly on unresolved references. Browser/static resolver integration and the
selection UI remain the next RM-05 slice; this is not usable composition parity yet.

README restores explicit gratitude to the GIS community, highlights GeoLibre and
GeoLens as existing foundations for the experience, and explains OpenGeo additions:
publishing convenience and AWS workflows for teams, collaboration, archives and
versioned records/publications through familiar Python and Observable interfaces.
The pre-release and intended-versus-implemented distinctions remain intact.

Local map-definition/workspace/static-render regression checks and six focused
binding cases pass. These cover strict reference shape, current authorization,
exact query identity/dataset/checksum parameters and refusal to render an inline
fallback. They use repository transaction substitutes, not actual PostgreSQL or
multi-composition browser acceptance. No cloud, remote CI or build ran in this batch.

Changed-module Ruff and mypy pass, as do README local-link and whitespace checks.
Foundation inventory retains 10 issues; parity reports 97 artifact mismatches.
These gates remain open and no unrelated evidence seals were refreshed.

## September 19: current-access Style resolution for private rendering

Saved-map job submission now resolves exact Style revisions inside its tenant
transaction, rechecking source resource access, dataset association, format, revision
and checksum. It hashes retained bytes and deduplicates identical dependencies for
the request. Missing/revoked/corrupt dependencies do not fall back to latest.

The static compiler accepts resolved detached MapLibre geometry Styles within its
existing bounded scalar/categorical profile. It validates geometry, explicit paint
properties, external dependency absence and checksum, combines composition opacity,
and keeps original Style bytes unchanged. Unsupported formats, symbols, filters,
zoom/layout rules and ambiguous renderer defaults fail explicitly. The map definition
seal retains original reference provenance; derived render bytes have their own hash.
Public publication validation continues to reject unresolved Style references;
audience/rights checks and browser rendering/selection remain open. This does not
complete RM-05 or establish two-composition UI acceptance.

README now acknowledges the open-source ecosystem evenly, removes repeated/bold
GeoLibre/GeoLens callouts and softens slogans. Product motivation leads: connect,
organize, reuse and publish team work through standard tools and familiar interfaces.
User-deleted callouts remain removed.

Local static-render/job regressions, exact-paint/checksum tests and resolver access/
dataset/deduplication checks pass. Authorization query tests use transaction doubles;
no actual PostgreSQL, worker execution or browser-binding acceptance is claimed.
Changed-module mypy passes. No build, AWS call, remote Actions or deployment ran.

Final gates: README local links, whitespace and changed-file Ruff pass. Foundation
inventory remains at 10 issues and parity at 97 artifact mismatches; no seals
were refreshed. These broader gates remain open.

## September 19: GeoLens pin, consolidated parity scope and browser Style reads

GeoLens latest published release v1.20.0 (September 18) was resolved through its
annotated tag to `f5fee67d8cf053d741590a00a55fe1870eed2b92`, also the observed main
head. The source lock records exact README/changelog/license hashes and tag object.
Only public metadata/documents were fetched; no upstream stack, demo crawl, code
import, paid service or remote Actions run was used. The shared baseline now owns
eight GeoLens rows alongside the seven existing products. C01/C06 search/discovery
were merged; aliases remain. Analysis, sharing/publication and automation complete
the reviewed feature scope. Crosswalk links existing rows and RM work so overlapping
requirements reuse implementation and evidence only when each criterion is verified.
Counts are 8 products / 50 rows: 15 pass, 26 partial, 8 not started, 1 conditional
not applicable. GeoLens has zero accepted evidence and no parity eligibility.

Browser Style resolution now checks resource/dataset association, exact revision and
checksum, rejects incompatible/non-detached styles, and renders bounded geometry
passes with composition opacity. Resolved definitions live only in runtime state;
saved definitions/local drafts preserve the reference at schema 1.4. Unavailable
references do not render inline fallbacks. Bound style controls are read-only with
an explicit reload, and portable export is blocked pending dependency support.
Public map previews also reject unresolved references until audience checks exist.

Focused helper/renderer tests exercise two serialized compositions sharing one Style
reference, reopening exact paint, per-composition opacity, missing access, mismatched
association and corrupt/substituted revisions. These use a renderer double, not real
GPU or authenticated persistence acceptance. Map-definition/Layer regressions pass.
The GeoLens structure/crosswalk test passes; full parity still has existing artifact
hash failures. The Studio build/check passes (seven routes, 256 files). Selecting a
Style in the workbench, independent browser/real persistence acceptance, publication
rights/dependency integration and broader styling profiles remain open RM-05 work.

Final bundled build/check passes for seven routes and 256 files. Public-preview
reference rejection, changed-file Ruff, local documentation links and whitespace
checks pass. Foundation inventory has 10 issues; full parity reports 98 artifact
checksum mismatches (including newly changed owned code). Structural parity checks
pass with path verification disabled, but the full gate remains failing. No seals
were refreshed and no passing claims were added for these local increments.

## September 19: workbench Style selection

Editors can now find governed records for a selected vector Layer, list Styles on
a chosen record and apply an exact version after current resource/dataset access,
identity, checksum and renderer compatibility checks. Lookup happens on demand and
record pagination is bounded. An unsuccessful lookup preserves the prior selection.
Applying stores only the dependency reference and runtime compiled paint separately;
normal Project save retains it with existing map-version conflict handling.
Bound Layers expose reload and explicit restoration of previous inline styling.
Removing a reference leaves the shared Style untouched. New local drafts record
binding choices, including an explicit detach, without treating older drafts as
detachment requests. A rendering exception restores the previous binding/presentation.

Focused picker, reference-renderer and serialization tests pass, including exact
historical selection, failed lookup preservation and two independently serialized
compositions sharing one Style. The bundled seven-route/257-file Studio build passes.
These checks do not replace actual API/PostgreSQL multi-user save/reopen, GPU render
acceptance or publication/export rights handling; those remain RM-05 and RM-V1 work.
No cloud, remote CI, migrations or deployment ran.

Built Chromium also passes exact Style selection through the production client
against the local HTTP substitute: version 2 is selected from a latest-version-3
listing, verified and applied as a reference. This tests the built picker component;
it is not a full workbench database save or real GPU rendering result. Existing
metadata/discovery/history checks also pass with external requests blocked.
Whitespace checks pass. Foundation inventory retains 10 issues and parity 98
artifact mismatches; no seals were refreshed. Updated local receipts remain under
`.local-archives/resource-model-20260919/`.


## September 19: real PostgreSQL Style reuse and revocation

Added `scripts/check-style-reuse-postgres.py`, a bounded offline check using the
cached, digest-pinned PostGIS image, no published ports, one temporary Unix socket,
synthetic records and automatic container/volume cleanup. All 106 current migrations
apply to a fresh database. Production repositories and the production PostgreSQL
transaction executor run as `opengeo_runtime`, verified without superuser or RLS bypass.

Two separate access containers persist compositions referencing one dataset and
one exact Style revision. After saving Style revision 2, both compositions reopen
unchanged and resolve revision 1. Revoking the editor's source-container membership
leaves their destination compositions readable but blocks dependency resolution and
further saves. A different tenant cannot read the composition. The check passes and
the temporary container was removed; zero AWS/provider/remote CI calls occurred.

This proves direct repository persistence and runtime authorization against real
PostgreSQL. It does not prove HTTP/session authentication, the complete Studio
save/reopen journey, GPU rendering, data-object reads, Aurora or deployment.
The local receipt is `.local-archives/resource-model-20260919/style-postgres-receipt.json`.
Next: connect the actual workbench selection/save/reopen journey to the local API
and database, then address Artifact/export/publication dependency handling. RM-05
and RM-V1 remain open; no aggregate parity row is promoted.


## September 19: workbench Style permissions and save recovery

Fixed the workspace-to-workbench role mapping so account admins retain their
editing controls even when their explicit project role is viewer. This now matches
the workspace's existing edit capability check and server authorization. Ordinary
viewers remain restricted. A save rejected with `map_style_reference_unavailable`
now explains the unavailable Style, retains the draft and directs the user to
check access or select an available version. It no longer reports this dependency
failure as a stale map-version conflict or directs the user to reload their draft.

The actual ProjectWorkspacePage/WorkbenchView component journey passes: select a
compatible saved Style, save as an admin with a viewer project role, receive the
access rejection, then retry the unchanged composition successfully. The nine-case
owning workspace suite passes, including viewer restrictions and existing source
and durable-job behavior. This is DOM/component evidence with an adapter substitute;
it does not replace the pending full Studio-to-API/database session journey.


## September 19: built workbench, real HTTP and PostgreSQL Style reuse

The bounded `scripts/check-style-reuse-postgres.py --browser` journey now runs the
built ProjectWorkspacePage and WorkbenchView in Chromium through the production API
client, HTTP routes, database principal lookup and runtime-role repositories. It
uses the cached PostGIS image, applies all 106 migrations and reuses the existing
Studio build. Only token verification is a local fixture; the renderer is disabled
and the synthetic dataset has no geometry payload. This is not Cognito/Aurora,
GPU, dataset-byte delivery or deployed acceptance.

The integrated run exposed a real race: background Layer hydration rebuilt the
Style picker while a resource lookup was pending, discarding the visible results.
The workbench now retains one picker per working Layer through unrelated renders.
The owning component test forces a render during a pending lookup and verifies the
same control and results survive. Detached pickers still cannot apply late results.

The final browser journey passes with 54 local HTTP requests: both compositions
select exact revision 1 from a latest-revision-2 listing, save successfully and
reopen with the same shared Style reference. A database assertion confirms both
references are identical and only one Style exists. The repository journey also
retains revocation, tenant isolation and immutable-version acceptance. No provider
requests were attempted, no AWS/remote CI ran, and the API thread and temporary
container/volumes were cleaned up. The local receipt is
`.local-archives/resource-model-20260919/style-postgres-receipt.json`.

The nine-case owning workspace suite, runner lint, Studio build and artifact check
pass (7 routes, 257 files; build digest
`de56ffbd272d10dfacbebc18d205285221cebf31ecd88e239ce52d31cde45106`).
This establishes the bounded local RM-05 selection/save/reopen journey. Broader
renderer/export/publication dependencies and live authentication remain open;
no product parity row is promoted. Next implement RM-06 identity/navigation adapters
for authored compositions and Publications, preserving legacy access-container URLs.


## September 19: authored composition identity adapter

Audited `app.maps`/`app.projects`, workspace URLs, map selection, creation, Save as,
and preview loading. Added read-only `GET /compositions/{id}`: the composition ID is
an `app.maps` identity; `resource_type=project` names the product concept, while
`access_container_id` explicitly identifies the existing authorization container.
Resolution, current role checks and bounded definition reads share one tenant
transaction. Missing and unreadable compositions stay hidden. Responses are
`no-store`; inspection creates no records and performs no migration or copy.

Studio accepts `/workspaces?composition=<uuid>` without requiring the caller to
reconstruct access context. The canonical client validates returned identity and
retains container context internally for existing save APIs. New map creation,
Save as, map switching and selected-map navigation emit canonical links. Existing
`?project=<container>&map=<composition>` links and all legacy APIs remain supported.
The selected composition is exact, including outside the first catalog page;
unavailable identities do not fall back to a different map. Directory loading is
reused, avoiding a second authentication/directory bootstrap for resolution.

The bounded local browser/API/PostgreSQL journey passes with one canonical and one
legacy URL, exact Style selection, saves and reloads (56 local requests, no provider
requests). Repository checks cover cross-tenant denial; a focused check confirms
an unreadable same-tenant container fails before definition loading. Client/fixture
checks, owning workspace/route tests, creation tests, lint, focused API type checks
and the single Studio build/artifact check pass. Build digest:
`3a9d270aa2084e71800fdaedf2596fa78979e3b8cb147d92dea5d73587aea26c`.
The local journey still substitutes token verification and disables GPU rendering;
no Cognito/Aurora/deployment acceptance is claimed. Temporary services were removed.

RM-06 remains partial. Next audit and adapt independent Publication/site/source
identity and links, then distinguish authored Projects from access containers in
the directory and remaining management labels. No new database table, destructive
rename, new static route, remote CI or cloud operation was required.


## September 19: exact Publication identity and read-only entry

Audited Publication directory grouping, site/source/edition relationships, creation,
container routing and editor selection. Sites already supply a stable editable
identity distinct from access containers and published editions. Added
`GET /publications/{id}` with `resource_type=publication`, `access_container_id`
and the authorized compatibility `site` representation. Resolution and SITE_READ
checks share a tenant transaction; missing/unreadable identities remain hidden.
Successful responses are `no-store`. No grant, copy, build or publication occurs.

Studio accepts `/workspaces?publication=<site UUID>`, validates the returned identity
and context, and opens exactly that Publication. It does not default to a sibling
site or load a composition. The heading uses the Publication title. Directory
source/site actions and completed Publication creation emit canonical links;
legacy container publishing links and source/site APIs remain compatible. Unbound
hosted destinations are not assigned invented Publication identities.

Focused client/fixture, directory, creation, publisher UI, API and repository checks
pass, along with lint, focused API type checks and one bundled Studio build. The
first local persistence run rejected an invalid dataset-as-page fixture; replacing
it with an editorial document preserved the actual page-type constraint. The final
built-browser/local-HTTP/PostgreSQL run passes (72 local requests): the second of
two Publications in one container opens/reopens exactly and adds no writes. Real
runtime-role checks also verify cross-tenant and revoked-membership denial, while
the shared-Style/composition journey remains passing. Temporary services were
removed, and no provider requests, cloud operations or remote CI ran.

Build digest: `8cc6b165e77423a3cd8e80ee4cdd0feadd0ac2efc7101a521f5d97e1f2f81745`
(7 routes, 257 files). Local receipt:
`.local-archives/resource-model-20260919/style-postgres-receipt.json`.
Token verification is a local fixture and GPU rendering is disabled; no live
login, Aurora, publication deployment or parity completion is claimed.

Next in RM-06: distinguish authored Project records from access containers in the
directory and remaining management labels, retain compatibility paths, and expose
clear identity/context to users without reconstructing resources. RM-07/RM-08
still own reusable Artifact and publication dependency acceptance.


## September 19: authored Projects directory and access workspaces

The Projects directory now lists `app.maps` compositions through bounded
`GET /compositions` summaries instead of presenting `app.projects` access containers
as authored Projects. Search and active/archived/all filtering occur on the server
with current organization/project-role filtering before pagination. Responses carry
identity, explicit access-context ID/name, title/description, state, version and
updated time, without map definitions or provider reads. Default page size is 50,
maximum 100, maximum offset 10,000 and query length 200; responses are `no-store`.

Studio links each row to the canonical composition entry, identifies its access
workspace separately, supports deliberate load-more and retries the same offset
after failure. Search is debounced and superseded requests are cancelled. The old
container list remains under Access workspaces and opens management settings;
its search/status labels and delayed-loading state preservation were updated.
Empty and Publication-only workspaces no longer appear as authored Projects.
API client identity return annotations were also corrected without changing their
runtime payloads.

Focused directory paging/retry/search and identity checks pass. All 34 owning
directory interaction checks pass, including creation, Publication links, archive
filter preservation and access management. Focused API filter/bounds/no-store
checks, lint and API type checks pass. The built local browser/API/PostgreSQL journey
passes with 79 local requests: two authored rows, server-filtered search, canonical
and legacy save/reopen, exact Publication reopening and no provider requests.
Repository checks verify same-tenant membership revocation removes a composition,
admins retain visibility and another tenant sees no records. Temporary services
were removed; no AWS, remote CI or deployment ran.

The Studio artifact check passes (7 routes, 258 files; digest
`51fc1ecab5d43c1dc1dfe6f6046fdbeecbd9fba7fab05f861d48e0bdf3fabbc4`).
The artifact exercises the runtime changes; subsequent client annotation-only edits
needed no additional rebuild. Token verification remains a local fixture, GPU
rendering is disabled, and no overall parity claim is made.

RM-06 remains partial: next align composition title/context presentation and
remaining workspace-management terminology without changing authorization or old
URLs, then continue Artifact/dependency integration in RM-07/RM-08. Legacy access
workspace loading remains bounded to its existing first 100 records; composition
listing/search does not inherit that restriction, but has its own pagination bounds.

## September 19: Project titles, isolated drafts and saved-state previews

Workbench titles, contents and export names now identify the authored composition;
settings identify its access workspace separately. Visibility, archive/restore and
workspace-switch controls describe the access container they actually modify.
Archiving a workspace explicitly retains individual Projects/Publications and does
not withdraw publication or revoke access. Existing APIs and routes are unchanged.

Managed browser drafts and temporary work are scoped by access workspace, Account,
user and composition. Sibling Projects no longer restore or overwrite each other's
draft settings. Ambiguous older workspace-wide drafts are preserved and offered as
a download in settings, without guessing their Project. Unavailable browser storage
does not break the recovery panel. Publication map-export previews skip both draft
and temporary-layer restoration, preserving their selected saved composition state.

The focused component journey verifies separate sibling draft writes, exact draft
restoration, retained legacy bytes, authored titles and saved-state-only previews.
Ten workbench checks pass; directory and lifecycle suites pass with normal process
isolation. A combined no-isolation run exposed shared DOM hooks between those suites;
no application workaround was introduced. One Studio build and artifact validation
pass: 7 routes, 258 files, digest
`a89433201a59a3111a81793a9452b969655129224daba8020b230ac9fff94538`.
This increment has component/build evidence, not new deployed or integrated browser
acceptance. No AWS, remote CI or provider run occurred. Foundation/parity gates still
report 10 inventory issues and 102 checksum mismatches; seals remain unchanged.

The local RM-06 identity/navigation/context baseline is in place. Continue with
RM-07: audit existing export/render records, then connect a common Artifact manifest
with exact Project version and explicit data/Style/config dependencies, immutable
versions and a current pointer. Reuse unchanged inputs and retain authorization,
rights and Publication dependency boundaries. Wider RM-06 live acceptance remains
in the verification queue; full parity is not established.

## September 19: saved-image Project Artifact manifest

Audited saved-map jobs, immutable revision bindings/source pins, download validation
and portable browser exports. Existing render jobs already provide stable image
edition identities and exact source/output hashes; there is no common durable
Artifact current pointer across representations. Reused these records through a
read-only `opengeo.project-artifact.1.0.0` manifest endpoint and a deliberate Studio
Download Artifact manifest action on completed saved-map images.

The manifest identifies the authored composition independently of its access workspace,
exact Project/resource versions, request/recipe/runtime identity, ordered repeated
source occurrences, configuration hashes and output byte checksum. Source-resource
license/attribution keep their recorded scope; distribution and output rights remain
unknown. It exposes no storage coordinates or signed URLs. Current render/source
permissions and the existing saved-map seal are checked in one tenant transaction.
Incomplete outputs, absent bindings and revoked sources fail; reads neither build
nor fetch output bytes. A canonical checksum remains stable for unchanged editions.

Seven new API/repository cases pass, including real seal validation over transaction
fixtures, stable repeat reads, unfinished outputs, revocation and route no-store.
The 30 owning saved-map seal checks pass. The saved-map browser-component/client
suite verifies deliberate request behavior, response identity rejection and recoverable
manifest denial without creating another job. API type checks and lint pass. One
Studio build/artifact check passes: 7 routes, 258 files, digest
`69986b9b2facdb2f22db5e757e41407c3f8d5b941dc4dbb2204f0b41bd293bb5`.
No real-database/new integrated-browser or deployed acceptance is claimed for this
increment. No AWS/provider calls or remote CI ran.

Whitespace passes. Repository gates report 10 inventory issues and 105 checksum
mismatches after the affected API/client/UI edits; no seals were refreshed. Continue
RM-07 with durable Artifact identity/current pointers and content-based reuse across
image and HTML/JS/CSS/config outputs, then RM-08 explicit current/pinned Publication
references. The existing reusable-Style publication/seal limitation remains open.
See [the Artifact contract](project-artifacts.md) for this adapter's exact boundary.

## September 19: private Artifact reads retain reusable Style dependencies

Closed a read-path gap: saved-map requests could compile authorized reusable Style
versions, but later seal verification compiled without resolving them. Private
image reads now use the same exact-version resolver under the tenant transaction,
checking current Style resource access, dataset association and original byte hash
before rebuilding and comparing the immutable recipe. Missing, revoked, corrupt
or substituted revisions fail without latest-version or inline fallback.

Seals and Artifact manifests preserve original per-Layer Style references when
present. Existing inline-only manifests retain their prior field shape. Style
license and redistribution knowledge remain unknown. Public seal verification
explicitly refuses referenced Styles until independent distribution/audience rules
are implemented; private access is not treated as public authorization.

All 54 focused Style-resolution, saved-map seal/access and Artifact checks pass.
Tests cover exact version selection, recipe equivalence, lineage, revocation and
public refusal using transaction fixtures. API type checks and lint pass. No frontend
source changed, so the prior valid Studio build was reused. No AWS, remote CI,
provider calls or worker builds ran. This is not real-database/worker/browser or
deployed acceptance for Style-bound output. Worker admission/cancellation after
upstream Style revocation remains open, while private reads enforce revocation.

Continue RM-07 durable Artifact identity/current pointers and content-based reuse;
retain public Style rights and integrated output acceptance as explicit dependencies.
Foundation/parity gates remain failing with 10 inventory issues and 105 checksum
mismatches; no evidence seals were refreshed.

## September 19: durable image Artifact editions and current pointer

Added migration 0107 for stable Artifact identities separate from authored maps and
render jobs, immutable numbered manifest editions, and a tenant/identity-qualified
current pointer. An insert guard requires a completed sealed render of the same
saved map/resource. Runtime identity mutation/history deletion and worker access are
withheld; head updates retain actor/time. Manifest storage is bounded to 48 KiB.

API registration revalidates the existing output and all dependencies in the same
transaction, locks the Artifact identity, checks its revision and stores a new edition.
Exact-job retries reuse an edition; registration never selects current. Explicit
current selection verifies the chosen edition and rejects concurrent revision changes.
Pinned/current reads revalidate; metadata-only state inspection returns up to 100
edition identities without output access, allowing recovery from revoked dependencies.
No output bytes are copied or fetched and no processing is dispatched.

Studio now offers deliberate Artifact state/image-history loading, edition registration,
numbered inspection and current selection in the map resource panel. Conflict recovery
requires fresh state. Registration remains separate from current selection/publication.
Existing image-manifest shape and render/download/publication paths remain compatible.

Local database tests exercise the new migration over real saved-map job completion,
immutable editions, pointer foreign keys, runtime column permissions and tenant RLS.
Thirteen focused Artifact API/repository/route checks pass; the owning saved-map seal
suite also passes. Component/client owning suites cover no automatic work, registration,
current-selection conflict and recovery. API type checks and lint pass. One Studio
build/artifact check passes: 7 routes, 259 files, digest
`a5eec7d278273a750ada718dc2fcc26299237205959d476f8b0999fbbb6d1d89`.

This is local PGlite/transaction-fixture/component evidence, not connected deployment
acceptance. No cloud calls, provider runs or GitHub Actions ran. Migration 0107 is not
deployed. Whitespace passes; repository gates retain 10 inventory issues and 105
checksum mismatches, with no seal refresh. Next verify edition registration/reopening
and current switching through the real local API/database/browser path, then finish
content-based build reuse, portable outputs and explicit Publication Artifact references.

## September 19: connected Artifact edition persistence and Studio recovery

Extended the maintained offline PostgreSQL runner with `--artifacts`, using a separate
receipt and the existing Studio build. All 107 migrations apply. Production runtime
repositories save exact Project/data/Style bindings and create two jobs; database
worker claim/completion functions record synthetic image-output metadata. No renderer,
storage provider, signing or output-byte reads are exercised by this fixture.

The actual built Resources panel, local HTTP API and PostgreSQL runtime role complete
registration without advancing current, explicit selection, second-edition registration,
resource reopening, numbered inspection, concurrent selection conflict/recovery and
return to the first edition. Its manifest remains identical. Database checks confirm
exactly two editions and the original two jobs. Revoking the upstream Style workspace
grant blocks private edition reads with `saved_map_style_unavailable`; state-only
inspection retains the pointer and exposes no output manifest.

The passed receipt at `.local-archives/resource-model-20260919/artifact-postgres-receipt.json`
records 46 local HTTP requests, zero provider requests and cleanup. The run completed
at 2026-09-19 14:33:13 UTC. Earlier setup attempts exposed fixture mistakes (the resource
ID accessor and a draft dataset status); both were corrected, and each failed attempt
removed its temporary container. No product permission checks were bypassed.

Studio digest `a5eec7d278273a750ada718dc2fcc26299237205959d476f8b0999fbbb6d1d89`
was reused without rebuilding. Token verification is a local fixture; principal lookup,
resource permissions and database isolation use production paths. This establishes
connected metadata persistence, not rendering accuracy, storage-byte availability,
Cognito/Aurora or deployment. No AWS or GitHub Actions ran. Script formatting after
acceptance changed no runtime behavior and did not trigger another database journey.

Whitespace and script syntax checks pass. Repository gates retain 10 foundation
inventory issues and 105 checksum mismatches; no seals were refreshed. Next implement
content-based build reuse and portable Artifact adapters, then explicit current/pinned
Publication consumption, keeping image-byte/render acceptance visible.

## September 19: completed-render reuse without duplicate processing

Added migration 0108 for immutable retry-key aliases to completed saved-map jobs,
a shared key-namespace guard and a partial completed-input index. The request path
resolves current Style/data access and exact sources, matches recipe/output settings
plus the complete ordered source-pin vector, then revalidates the composition before
returning completed output with dispatch disabled. New keys retain the same result;
changed inputs under a retained key conflict. No style/profile/job/object/edition is
created on reuse, and Artifact current pointers remain deliberate choices.

Only completed sealed PNG output is eligible. In-progress, failed and cancelled jobs
are excluded. Metadata/preview pin changes remain distinct; pending-job coalescing and
cross-metadata byte reuse are still open. Inspection performs no provider/storage fetch.
Studio copy now explains when existing output is reused and when processing starts.

All 28 focused saved-map request checks pass; database tests exercise migration 0108,
key collisions in both directions, unfinished-output refusal and immutable aliases.
API lint/type checks pass. Connected acceptance applies all 108 migrations and passes
through real local HTTP/PostgreSQL and the actual built Resources panel. Create map
image returns the original completed job without dispatch; retained-key retry and
changed-input rejection pass. Edition registration/reopening/current conflict recovery,
Style revocation and metadata recovery remain passing. Only two original jobs and
two editions exist. The receipt records 47 local HTTP requests, zero provider calls,
and cleanup at 2026-09-19 14:43:44 UTC.

The first real-database attempt caught an unnecessary FOR SHARE lock requiring update
permission on render jobs. It was removed without expanding runtime privileges. A
subsequent browser selector ambiguity was corrected. Each failed run removed its
container. Output metadata is synthetic; no rendering, uploaded-byte availability,
Cognito/Aurora or deployment acceptance is claimed.

The connected journey reused Studio digest
`a5eec7d278273a750ada718dc2fcc26299237205959d476f8b0999fbbb6d1d89`.
A later copy-only build/artifact check passes (7 routes, 259 files), digest
`344bc8c6d314f9a3f66c42605e89d7c61fc12617a746c2989644e30077c08d5f`;
no database rerun was needed for that wording change. Migration 0108 is undeployed.
No AWS/provider calls or GitHub Actions ran. Whitespace passes; full gates retain
10 foundation inventory issues and 105 checksum mismatches, without seal refresh.

Next adapt portable HTML/JS/CSS/config output into Artifact manifests and persistence,
then explicit current/pinned Publication references. The export audit must distinguish
saved Project input from browser state and currently loaded feature subsets, retain
runtime/source/rights dependencies, and preserve existing downloads and insertion.

### GeoLens shared-feature review — September 19

Rechecked the live GitHub latest-release API: v1.20.0 remains current; retained
its exact commit/source lock. Expanded the existing eight-family crosswalk to
include overlapping Google Earth Pro, GeoMoose, GeoNode, OpenLayers and MapServer
rows. The reader-facing workflow table now includes all eight reference products.
Unique requirements remain in the authoritative baseline; no acceptance status
was promoted. Next continue RM-07 portable Artifact work in the active sequence;
reuse these overlap links when planning bounded acceptance journeys. This review
requires no application build, remote CI, provider execution or AWS run.

Verification: the focused GeoLens baseline/crosswalk test and `git diff --check`
pass. Required aggregate checks still fail on dependency inventory omissions and
existing artifact checksum drift; no evidence hashes were refreshed. Logs:
`/tmp/geolens-review-foundations.log` and `/tmp/geolens-review-parity.log`.

### Portable Artifact provenance and insertion — September 19

Portable exports now carry deterministic HTML/input/runtime/source hashes, explicit
loaded-vector versus live-tile dependencies and unknown rights. Browser snapshots
retain `project: null`; no saved version or durable registration is invented.
Publication picker insertion verifies byte binding and retains both authored files.
Manual insertion also accepts a bounded optional downloaded JSON sidecar. The picker
awaits insertion; destination/source changes during verification reject stale writes.
Existing HTML-only download/import remains available.

Local standalone Chromium acceptance passes offline and in a sandboxed iframe with
zero network requests. The real picker/workspace/export components, using synthetic
adapter records and intercepted requests, preserve the exact-byte manifest and both
Publication insertion files without modifying the source map. Receipt:
`/tmp/opengeo-saved-map-picker-ZrDAQX/receipt.json`. This exercises the insertion
helper, not saved Publication persistence or the complete editor upload/reopen path.
Focused manifest/export/insertion tests pass. Manual sidecar parsing is covered by
focused checks; its new file input still needs rendered editor acceptance. No AWS,
provider runtime, remote build or deployment was invoked. Next connect saved-Project
version binding and durable portable editions, then explicit current/pinned embeds.

Final batch verification: the Studio build and whitespace check pass. Required
aggregate checks still report existing foundation inventory omissions and artifact
checksum drift (`/tmp/portable-final-foundations.log`,
`/tmp/portable-final-parity.log`); no evidence seals were refreshed.

### Portable snapshot originating Project — September 19

The workbench now preserves the loaded saved composition identity/version/definition
separately from mutable browser state. Successful saves refresh this origin; opening
export review freezes it. Manifests record its definition hash and explicit
non-authoritative provenance while `project` remains null. This keeps the originating
Project discoverable without asserting that loaded feature subsets and unsaved views
are a reproducible saved-Project build. The full definition is not exported.

Focused manifest, composition identity and export tests pass, including mutation
isolation, provenance checksum binding and invalid version rejection. The actual
picker/workspace/browser export journey verifies composition ID/version retention,
exact output hashes and sidecar retention with synthetic adapters and intercepted
requests. One bundled Studio build and whitespace checks pass. Foundation inventory
and evidence checksum gates retain their existing failures; no seals were refreshed.
No AWS, deployment or remote CI run occurred. Browser receipt:

{"realSavedMapLoader":true,"reviewRequired":true,"exactByteManifest":true,"publicationSidecarRetained":true,"sourceMapUnchanged":true,"writes":[],"reads":["listMaps","getSession","selectOrganization","getCurrentOrganization","listProjects","getProject","listMaps","listDatasets","listSources","listProjectDatasetConnectionBindings","listProjectBasemapConnectionBindings","listFeatures"],"standaloneOfflineMap":true,"awsRequests":0,"artifactDirectory":"/tmp/opengeo-saved-map-picker-HgvjZh"}

Next: server-authorized portable edition registration with independently resolved
saved-version inputs and output storage, followed by current/pinned Publication
references. This provenance increment does not close durable Artifact acceptance.

### Portable/server checksum interoperability — September 19

Registration audit found that portable exports used JavaScript JSON serialization,
whereas server Artifacts use code-point ordering and plain-decimal numbers. Small
coordinates and numeric property keys could prevent saved-definition and manifest
hashes matching. New portable manifests explicitly identify a matching canonical
encoding. Earlier downloaded manifests retain their original verification path;
unknown encodings fail closed. No stored image hashes or upstream import hashes
were changed.

An independent Python test invokes the real browser compiler and validates manifest,
origin definition and HTML byte hashes, including Unicode/numeric keys and small/large
numbers. Focused browser-module checks cover legacy verification. Next implement
server-authorized portable registration using retained output objects and independently
resolved saved versions; existing image-only schema and trigger require a forward
migration before accepting portable editions. No provider or paid execution occurred.

### Portable registration validation boundary — September 19

Added server-side bounded validation for portable HTML/manifest bytes and a separate
saved-origin comparison against an independently loaded composition/version. It
rejects mismatched output/hash/size, duplicate JSON keys, nonfinite values, unsupported
encodings, invalid snapshot scope and changed origin versions/definitions. The
cross-language compiler check exercises this validator using real browser-generated
bytes and deliberate tampering. Validation grants no authorization and does not
attest that browser HTML reproduces the Project. No registration route is exposed
until storage, current dependency authorization and representation-specific edition
bindings are wired together. Existing image registration is unchanged.

Focused interoperability checks pass; no application build is needed for this
server-only validation module. Next wire authorized retained-output registration
with a forward migration that preserves existing image edition constraints. No AWS,
provider, deployment or remote CI calls were used.

### Portable Artifact persistence foundation — September 19

Added forward migration 0109 for independent immutable portable output-object
metadata and exact saved-version edition bindings. It extends the existing Artifact
identity/current-pointer model and preserves the completed-image trigger branch.
Portable output no longer needs a synthetic dataset or Publication source owner.
An edition binds exactly one image job or portable object; portable manifests must
match retained output metadata and saved origin. Tenant RLS, immutable records and
worker exclusions remain explicit. Registration/API/upload wiring is still pending;
this migration is local and has not been deployed.

The focused PGlite database journey checks the new portable edition/current pointer,
wrong size, absent/nonexistent saved version, immutable objects and cross-tenant
visibility, alongside existing saved-image behavior. Initial validation exposed a
test helper masking the worker-denial error by resetting a role inside an aborted
transaction; the check now restores its savepoint before switching roles. Next wire
bounded upload/finalization and registration with actual byte verification and
source authorization. No paid services, browser build or remote CI were invoked.

Verification: all 12 focused database checks pass, including existing image
registration/reuse. Whitespace checks pass; aggregate inventory/checksum failures
remain in `/tmp/portable-schema-foundations.log` and
`/tmp/portable-schema-parity.log`. No evidence hashes were refreshed.

### Portable edition repository registration — September 19

Added internal registration of already-retained portable objects through the render
repository. Exact byte validation precedes a transaction that checks resource
render-configuration permission, saved origin/hash and composition references,
retained object facts and Artifact revision. Identical manifests reuse their edition
after revalidation, including retries with an old expected revision; new editions
increment the head revision without changing current. No storage object is invented
from client metadata and no HTTP route is exposed yet.

Focused cross-language and transaction tests pass for creation, retry, conflict,
permission denial and revoked references. Reference validation is invoked in the same
transaction; test substitution proves orchestration, not real database authorization.
Next wire bounded upload/finalization and portable reads/current selection, then run
one connected persistence journey. No application build, AWS or remote CI run occurred.

### Portable edition inspection and current pointer — September 19

Extended existing Artifact GET/current-selection endpoints with explicit portable
representation selection, keeping image defaults. Stored portable manifests are
checksum-verified against exact origin history and retained object facts; current
composition references are revalidated through a shared helper on registration,
inspection and selection. Revoked references produce a domain conflict. Metadata-only
history remains a bounded recovery path, exposing no output or storage coordinates.

Focused repository tests cover portable reads, current selection, reference revocation
and metadata recovery alongside existing image behavior. HTTP checks cover the
representation selector, no-store responses and unsupported values. These use
synthetic rows; real portable persistence and storage remain pending. Next implement
bounded upload/finalization and connect Studio edition controls. No AWS, application
build or remote CI run occurred.

### Studio portable Artifact controls — September 19

Connected the existing edition panel and API client to portable inspection/current
selection. Representation changes clear stale revision/selection and perform no
request. Image registration is hidden in portable mode; its absence is explained.
The manifest summary distinguishes browser snapshots from attested Project builds.
History parsing now accepts portable object identities alongside image job identities
and rejects ambiguous/missing output identity. Existing image calls retain defaults.

Focused client/component tests, a local Chromium control journey and one bundled
Studio build pass. The browser uses the real component with synthetic adapter records,
three explicit operations and zero provider requests; it is not connected persistence
acceptance. Logs: `/tmp/portable-controls-tests.log`,
`/tmp/portable-controls-browser.log`, `/tmp/portable-controls-build.log`.
Build digest: `fe1f210994e120de022a8cb372f928023b4c40d5d9878b73d6966455932beb67`.
Next wire bounded portable upload/finalization and registration, then exercise one
connected storage/database journey. No AWS or remote CI run occurred.

### Portable retained-output finalization — September 19

Wired a retained-output registration endpoint using the existing exact-version
storage reader. It accepts object identity plus bounded sidecar JSON, authorizes
before obtaining server-recorded coordinates, reads at most 4 MiB and calls edition
registration with fresh permission/origin/reference checks. The request accepts no
bucket/key/version coordinates. UTF-8 byte bounds supplement request character limits.

Focused tests cover one exact-version read, no read on initial denial, no write when
permission is revoked during I/O, no-store responses and rejection of caller storage
coordinates or oversized UTF-8 manifests. Storage and transaction records are fake;
no AWS was contacted. Next implement upload intents/tickets and verified retention
so Studio can submit new portable outputs, then connected persistence acceptance.

### Portable upload intent and ticket foundation — September 19

Added migration 0110 and an internal bounded ticket issuer using the existing upload
service. Manifest validation is now separately reusable before bytes exist, while
final byte validation remains mandatory. Issuance verifies origin/references, locks
the Artifact revision and limits pending uploads to three per user/Artifact. Intent
completion must reference matching retained output, with immutable expected facts
and tenant/worker boundaries. Production upload routes remain disabled until verified
completion, cleanup and prefix permissions are implemented.

Seven focused API/interoperability checks and all 12 focused PGlite checks pass,
including intent immutability and mismatched/repeated completion rejection. Signing
and storage are simulated; no AWS or CI run occurred and no application build was
needed. Next implement exact-byte upload completion and cleanup, then wire the
bounded route and Studio registration journey. Logs: `/tmp/portable-upload-tests.log`
and `/tmp/portable-upload-db.log`.

### Verified portable upload completion — September 19

Implemented internal exact-version upload completion. It requires the original
requesting actor and current resource/reference authority, rejects expired pending
intents, verifies HEAD facts and exact HTML bytes, and atomically retains the output
with the completion marker after reauthorization under an intent lock. Completed
retries return the same receipt with no repeated storage read. No edition/current
pointer/publication is created implicitly.

Eight focused interoperability/upload checks pass, including completed retry,
expiry, revocation during I/O and same-size byte tampering. These use synthetic
transaction rows and storage; connected persistence acceptance remains open. Log:
`/tmp/portable-completion-tests.log`. Whitespace and focused lint checks pass.
Next implement abandoned-upload cleanup and explicit storage wiring, then expose
upload routes and connect Studio registration. No AWS, build or remote CI run occurred.

### Bounded abandoned-upload cleanup — September 19

Added an internal cleanup operation for one actor-owned expired incomplete intent,
with a one-day grace period, row lock and retained-key exclusion. It accepts at most
16 exact-key immutable versions, validates the whole inventory before deletion and
never deletes the unversioned current key. Receipts distinguish observed emptiness
from terminal cleanup; late uploads and interrupted partial deletion remain explicit.
No storage lifecycle rule can accidentally expire registered Artifact bytes.

Eight focused orchestration checks pass for bounds, explicit versions, retry,
authorization/missing/retained exclusions and hostile inventories. Storage and SQL
rows are substituted, so real database selection and cloud deletion are not proven.
Log: `/tmp/portable-cleanup-tests.log`. Next implement the production cleanup adapter
and reviewed storage-prefix wiring, retain operational cleanup receipts, then expose
upload routes. No AWS deletion, build, deployment or remote CI run occurred.

### Exact-version cleanup storage adapter — September 19

Added a production-capable cleanup adapter over the existing bounded AWS signer,
without extending its permitted methods. It constrains the bucket and generated
portable key pattern, limits listing/XML size, names every deleted version and
checks per-object confirmation/errors. No current-key deletion or automatic retry
loop is introduced. AWS request semantics were checked against official API docs.
The adapter remains uninstantiated and production permissions unchanged.

Fourteen initial local cleanup/adapter checks pass with fake transports, covering
retained-output exclusions, scope restrictions, request checksums, bounded listing,
version-specific confirmation and malformed/error responses. Added a UTF-16/NUL XML
rejection guard and reran the affected adapter suite. No AWS storage call, deletion,
build or remote CI run occurred. Next persist operational cleanup receipts and wire
the complete upload/cleanup routes with explicit storage configuration, then exercise
the connected journey locally. Logs: `/tmp/portable-cleanup-adapter-tests.log` and
`/tmp/portable-cleanup-adapter-final.log`.

### Durable cleanup receipts and explicit storage injection — September 19

Migration 0111 records cleanup attempt start before external I/O and immutable final
observations/failures afterward. Partial deletion records only confirmed successes;
ambiguous failures use sanitized codes. Process/database loss can leave a visible
started attempt for reconciliation. Current authority is checked again before I/O.
The render repository now exposes internal upload/completion/cleanup methods with
optional dedicated adapters; Artifact reads use their own configurable download
adapter while existing image storage remains unchanged. Absent adapters fail closed.

Nine cleanup tests and all 12 focused database checks pass, including final receipt
immutability. Existing portable interoperability/upload checks were rerun for storage
injection. Logs: `/tmp/portable-cleanup-receipts-tests.log`,
`/tmp/portable-cleanup-receipts-db.log`, `/tmp/portable-storage-injection-tests.log`.
Next wire application configuration and bounded HTTP routes, including authenticated
receipt retrieval, then the Studio upload/registration flow and local persistence
acceptance. No AWS, deployment, application build or remote CI run occurred.

### Portable lifecycle API and default-off storage configuration — September 19

Wired authenticated upload-ticket, completion, cleanup and bounded receipt-history
routes. Request manifests have UTF-8 byte bounds and unknown fields are rejected;
responses are no-store. The explicit portable_artifacts_enabled setting defaults off
and requires configured application storage in the reviewed cleanup region. Enabled
repositories receive separate upload/download/cleanup adapters. No IAM changes or
runtime flag activation were made. Receipt reads authorize the original requesting
actor and resource, expose at most 50 newest records, and do no storage I/O.

The combined configuration/interoperability/cleanup suite passes (39 checks), followed
by 10 focused checks including new route authentication/no-store and default-off
configuration cases. Tests substitute storage/repositories; connected persistence
is still required. Logs: `/tmp/portable-upload-routes-tests.log` and
`/tmp/portable-upload-route-acceptance.log`. Next connect Studio's deliberate upload,
completion and registration flow, then verify one local full journey. No AWS, build,
deployment or remote CI run occurred.

### Studio portable upload and registration — September 19

Connected file-pair selection, local byte/manifest verification, bounded upload,
completion and registration to the existing Artifact panel/client. A completed
upload receipt survives registration conflicts within the panel; retries do not
reupload. An uncertain upload is checked for server completion before resending.
Legacy/unbound sidecars request a fresh saved-Project export for registration.
Registration still leaves current unchanged, and disabled backend storage reports
an explicit error. No capability is inferred from a successful local download.

Focused manifest/retry/client/component tests and one bundled Studio build pass.
A real Chromium component journey with synthetic adapters verifies file selection,
verification and ordered ticket/upload/complete/register calls with no implicit
current selection. Fixture corrections added an explicit visibility value and secure
local origin for Web Crypto. No external request or AWS operation occurred. Logs:
`/tmp/portable-upload-ui-tests.log`, `/tmp/portable-upload-ui-build.log`,
`/tmp/portable-upload-ui-browser.log`. Next verify the complete production repository
and database flow against local exact-byte storage, then address receipt/reopen and
remaining deployment/permission acceptance. Unfinished upload state currently survives
only within the open panel. No remote CI run or deployment occurred.

### Connected portable persistence and cheaper retries — September 19

Added a maintained `--portable-artifacts` mode to the local PostgreSQL acceptance
runner. It applies all 111 migrations, uses the real runtime role/repositories and
actual browser compiler with 3,106 synthetic HTML bytes held in exact-version local
storage. Ticket issuance, verified retention, registration, explicit current selection,
fresh-repository reopening, upstream Style revocation and metadata recovery pass.
One immutable edition survives retries without changing its manifest.

The first run revealed an avoidable registration-retry storage read. Retained-output
registration now revalidates an existing edition/manifest/origin/reference set in its
authorization transaction and returns it without reading storage. The second run
confirms one HEAD and two reads total (completion and first registration), with no
extra read for completed or registered retries. Both temporary containers were removed.
Latest receipt: `.local-archives/resource-model-20260919/portable-artifact-postgres-receipt.json`,
finished 2026-09-19T15:56:16.878229Z. No AWS, remote CI or application build was used.

Focused interoperability tests also pass. Storage transport remains synthetic, and
this runner does not exercise browser-to-API/S3, Cognito, deployed IAM, public delivery
or full renderer equivalence. Next connect authorized portable output retrieval and
Publication current/pinned consumption, then expand one representative connected
browser journey rather than rerunning unchanged evidence.

### Portable output download checkpoint — September 19

Added explicit authorized retrieval of retained portable editions through an expiring,
exact-version attachment ticket. Current resolution and pinned selection revalidate
resource access, saved origin, manifest and upstream references. Studio offers the
pinned download only after inspection and clears links when changing context. No
output is rebuilt or read just to issue a ticket; no current pointer changes.

Twelve focused interoperability checks, component checks and a Chromium journey with
intercepted requests pass. One Studio build passes (tree digest
`517d7aaa1592b7bb0227f0ba0ba1021b6105023399349d12f5c191ad7d381b46`).
The maintained PostgreSQL runner applies 111 migrations and verifies exact-version
selection and revoked-Style denial using synthetic signing; one HEAD and two reads
remain sufficient for the complete retention journey. Receipt finished
2026-09-19T16:05:06.060475Z; the network-isolated container was removed. Logs are
`/tmp/portable-download-{tests,ui-tests,browser,build,postgres}.log`.

No AWS, deployment or remote CI was used. Foundations/parity gates retain dependency
inventory omissions and evidence checksum drift; no seals or parity claims were
promoted. Actual S3 delivery, deployed authorization and full browser/API persistence
remain separate acceptance items. Next implement durable current/pinned Artifact
references in Publications, resolving current once into exact build inputs. Issued
attachment tickets remain usable until their bounded expiry and are never durable
references. This local checkpoint does not push application changes to GitHub.

### Publication Artifact reference persistence — September 19

Added migration 0112, bounded reference validation/resolution, authenticated read/write
routes and optimistic immutable reference-set revisions. Current and pinned intent now
survive repository reopening without copying output or storing a signed URL. Saving
requires Publication edit permission and current Artifact/upstream authorization;
metadata reads and clearing references support recovery. Compiler consumption is still
pending; build creation checks references before job reuse and rejects unsupported
staging, with a database insert guard as a second boundary. Studio controls remain next.

Focused reference, HTTP and existing build-reuse checks pass after updating fake
transactions for the additional reference query and the HTTP fixture's request method.
The connected local PostgreSQL journey applied all 112 migrations and verified save,
reopen, stale-edit conflict, current-to-pinned change and clearing with no extra storage
reads. An initial run found a missing required download-adapter constructor argument;
the fixed resolver uses unavailable storage because resolution performs no I/O. Final
receipt finished 2026-09-19T16:12:56.640582Z; the temporary container was removed.
Storage remains synthetic; no deployed or public-delivery acceptance is claimed.

Evidence: `/tmp/publication-artifact-postgres.log`, `/tmp/publication-artifact-tests.log`
(with five obsolete call-count assertions corrected and verified separately in
`/tmp/publication-artifact-retry-tests.log`), focused reference/route logs under
`/tmp/publication-reference-*`. Foundations/parity still report dependency inventory
omissions and evidence checksum drift. No frontend changes, new Studio build, AWS,
remote CI, deployment or push. Next carry resolved editions into immutable build
inputs/staging, then connect Publication authoring controls and a connected journey.

### Immutable Publication Artifact inputs — September 19

Added migration 0113, preparation/reopening APIs and an immutable resolved input
manifest. Current references now resolve into exact retained edition/object pins
alongside a Publication source revision checksum and reference-set revision. Identical
preparations reuse the snapshot after reauthorization, without copying output or
reading storage. Reopening uses the retained pins even after authoring references
change or are removed. Combined path/count/size/root validation prevents staging
collisions. Fixed non-adjacent prefix collision detection in reference authoring too.

Sixteen focused reference/input checks and a separate HTTP route check pass. The
maintained runtime-role PostgreSQL journey applies 113 migrations and verifies source
revision creation, preparation, reuse and reopening after reference removal. It retains
one HEAD/two Artifact reads for the full earlier retention journey, with no additional
storage I/O for snapshots. Receipt finished 2026-09-19T16:19:34.720151Z; the isolated
container was removed. Evidence: `/tmp/publication-inputs-{tests,routes,postgres}.log`.
No AWS, frontend build, deployment, remote CI or push occurred. Foundations/parity
retain existing dependency-inventory and evidence-checksum failures; no seals updated.

This is an input prerequisite, not reference-aware compilation. Next connect the
snapshot to the build request seal, coordinator claim/staging, exact-byte verification,
result seal and preview reauthorization as one compatible increment. Keep the current
build guard until the complete consumption path is supported; then add Studio authoring
and connected acceptance. Existing publications without Artifact references still work.

### Portable Artifact compiler/staging interoperability — September 19

Added closed preview-only Artifact invocation/request versions, independent compiler
and coordinator snapshot validation, bounded exact-version storage reads, Podman input
staging and resolution rechecks around execution/completion. Repeated references to the
same retained object share one storage read within a build. The actual browser compiler
and Publication static compiler preserve identical HTML bytes through the coordinator;
no map rebuild is performed. Tampered bytes, wrong Artifact identities and resolution
changes before/after execution prevent completion. Legacy contracts remain supported.

Focused compiler checks, nine coordinator contract checks and eleven production-adapter
checks pass using local fixtures/fake transports. Eight legacy builder checks passed
initially; the archive compiler case encountered sandbox child-process EPERM and passed
when rerun with local process permission. Logs: `/tmp/artifact-compiler-tests.log`,
`/tmp/artifact-coordinator-final.log`, `/tmp/artifact-coordinator-regression.log`,
`/tmp/artifact-storage-tests.log`, `/tmp/artifact-compiler-archive-recheck.log`.
No container image rebuild, AWS call, remote CI, deployment or push occurred. Existing
foundations inventory omissions and parity evidence checksum drift remain unchanged.

Database build admission, leased Artifact resolution, result/preview authorization and
compiler image promotion remain unimplemented. Consequently the existing API/SQL build
guard remains active; this is local contract interoperability, not a complete user
workflow. Next connect those authority boundaries, then Studio references and the
connected browser/persistence journey. Public redistribution rights and Framework
incremental attachment invalidation remain explicit acceptance items.


### Publication Artifact admission and preview checkpoint — September 19

The local implementation now connects migration 0114, preview build admission,
lease-bound Artifact resolution, completion input counts and preview reauthorization.
The original actor and live coordinator token are verified before resolving retained
objects. Identical build inputs reuse the existing job. Preview issuance and exchange
recheck upstream access; already issued delivery credentials retain their existing TTL.
The feature remains disabled by default. Production requires a reviewed compiler image,
IAM/storage acceptance and the trusted coordinator Artifact API origin configuration.

The maintained isolated PostgreSQL journey passed all 114 migrations using the runtime
role and actual static Publication compiler. It verified exact retained HTML, build
reuse, rejection of a wrong lease actor/token and preview denial after upstream access
revocation. Storage and the compiler bridge transport remain synthetic; this does not
prove deployed S3, Cognito, IAM or the Studio authoring experience. The receipt finished
2026-09-19T16:50:05.764360Z, recorded zero AWS requests and confirmed container removal.
Two lease transport checks and eleven adapter regression checks also passed. Existing
foundation inventory omissions and parity evidence checksum drift remain unresolved.

This GitHub checkpoint publishes documentation only; the application implementation
and local evidence logs remain in the working tree and are not included in this commit.
Next connect Studio Artifact reference authoring and exercise a representative connected
browser/persistence journey. Keep compiler promotion and deployed acceptance separate;
no full workflow or parity completion is claimed.


### RM-08 Publication reference editor — September 19

Publication settings now expose retained Artifact references through the existing
source identity. Users can load map resources in the current access workspace, add a
retained portable Artifact, choose current or pinned editions, set its asset path,
remove references and save optimistically. Reads are deliberate; opening settings
starts no build, storage read or provider call. Conflicting saves retain the draft;
explicit discard reloads saved state. Existing inaccessible references remain visible
for metadata recovery and removal. Client validation rejects overlapping paths and
ambiguous current/pinned selections.

Focused DOM/client checks and existing saved-preview regression checks pass
(`/tmp/publication-reference-ui-tests.log`). These use synthetic adapters, not a
connected browser/API persistence journey. Foundations and parity checks still report
existing dependency inventory gaps and evidence checksum drift; no seals were changed.
This is local implementation, with no deployment, remote CI or AWS run.

Next connect preview request v2 parsing, immutable input preparation and exact snapshot
selection to saved-preview reuse. The existing preview currently matches source revision
only, so saving reference intent does not update it. Then extend selection across access
workspaces and verify the connected browser/persistence journey. Production remains
default-off; reference authoring alone does not close RM-08 or a parity target.


### RM-08 exact Artifact preview selection — September 19

Saved preview now separates explicit Artifact input preparation from read-only history
checks. With saved references, opening the panel does not prepare a snapshot or create
a job. Preparation resolves the saved reference revision through the existing API;
history reuse then requires both source revision and the exact Artifact input checksum.
The prepared selection remains frozen until deliberately prepared again. Preparation
clears the old preview pane; changed inputs cannot silently select an older build.
Uncertain submissions retain the same input ID and idempotency key across retries, and
selection changes are disabled while a request is uncertain or its job is running.

The client now accepts closed preview-only request v2 and submits `artifact_input_id`.
It checks preparation response source/revision/reference identities. Legacy previews
without references retain their existing path. Existing editions can still be inspected
through build history; preparing a new selection requires management authorization.

Focused client and DOM interaction checks pass, including changed-current history
filtering and response-loss retries (`/tmp/artifact-preview-client-tests.log`). One
Studio build passed: tree
`66972c84f439637430e76e1fa8da2ff801f804166fe386b4f4e99e169ff599f7`,
263 files and 5,715,888 PWA shell bytes (`/tmp/artifact-preview-studio-build.log`).
Foundations/parity retain dependency inventory and evidence checksum failures; no seals
were refreshed. No AWS call, remote CI, deployment or push occurred.

Next extend Artifact resource selection across authorized workspaces and exercise the
reference editor, preparation, build reuse and reopen together through a real local
browser/API/PostgreSQL journey. DOM tests use synthetic adapters and do not establish
that connected acceptance. Production admission remains disabled pending compiler/IAM
acceptance. No parity target is closed by this increment.


### RM-08 cross-workspace authoring and connected acceptance — September 19

Artifact authoring now pages through authorized workspaces and map resources. Switching
workspaces clears the resource choice and resets its pagination while retaining the
Publication reference draft. Edition lookup uses the chosen workspace; saving still
uses the original Publication identity. New default asset paths avoid collisions after
reference removal. Workspace/resource reads remain explicit and do not copy data.

The maintained local PostgreSQL journey now also drives the built reference editor and
saved-preview control in Chromium through the real HTTP API and runtime-role database.
It selected an Artifact from another workspace, saved a pinned reference, reloaded and
reopened it, prepared exact inputs and excluded the older preview. The browser made 12
local API requests, zero external requests and zero build submissions. Only token
verification is substituted for this browser author; principal membership and roles
come from PostgreSQL. The surrounding journey still verifies actual static compilation,
lease actor/token checks and preview revocation with synthetic object storage.

All 114 migrations and the connected journey passed; receipt finished
2026-09-19T17:07:06.571523Z and confirmed container removal. Evidence:
`/tmp/artifact-cross-workspace-postgres.log`,
`.local-archives/resource-model-20260919/portable-artifact-postgres-receipt.json`.
Focused editor checks pass. One affected Studio build passed, tree
`47ed0a687afe0b3a1b42dd7eb7ef0f7ec6e84e47559a00cbd38ac05d76029dfa`,
5,717,592 PWA shell bytes. No AWS, remote CI, deployment or push occurred.
Foundations inventory gaps and parity evidence checksum drift remain unresolved.

This proves connected authoring/reopen/preparation and old-preview exclusion, not
browser-triggered compilation or delivered preview rendering. Next connect that final
browser build/reuse path and test current-edition advancement versus pinned stability.
Reviewed compiler promotion, deployed IAM/storage delivery and public redistribution
acceptance remain separate required work. Production admission remains default-off;
no parity status advances from this bounded journey alone.


### RM-08 browser build and reopen reuse — September 19

Extended the existing connected acceptance journey through the actual Build saved
revision control. The real HTTP route admits the sealed input selection into PostgreSQL;
a local dispatcher runs the existing coordinator/compiler fixture against the actual
lease and stores its sealed completion through the database function. The browser checks
completion, reloads, prepares the unchanged selection and finds the completed preview
without another build submission. Exactly one browser build request and two total local
compiler invocations (including the earlier repository fixture) were observed.

The 114-migration journey passed with 18 local browser API requests, zero external
requests and synthetic storage. Receipt finished 2026-09-19T17:09:09.089070Z and confirms
container removal. Evidence: `/tmp/artifact-browser-build-postgres.log` and the maintained
portable Artifact PostgreSQL receipt. The existing Studio build was reused; no rebuild,
AWS call, remote CI, deployment or push occurred. Focused Python lint and diff checks
pass. Foundations inventory gaps and parity evidence checksum drift remain unchanged.

This proves browser submission and completed-build discovery/reuse through real local
persistence. The dispatcher is a synchronous local fixture; S3/output transport and
coordinator heartbeat/resolution transport inside the compiler bridge remain synthetic.
The browser does not yet render the delivered preview. Next verify current-edition
advancement versus pinned stability and the delivery boundary; retain reviewed compiler
image, IAM and deployed authorization acceptance as explicit release requirements.
No full workflow or parity completion is claimed.


### RM-08 current advancement and pinned stability — September 19

Extended the real local persistence journey with a second retained portable edition
containing different HTML. Registration leaves current at edition 1; explicit selection
moves it to edition 2. Preparing the unchanged current-reference revision then creates
new exact inputs for edition 2. Previously prepared current and pinned snapshots reopen
unchanged, and newly prepared pinned references still resolve edition 1. None of these
edition-management/preparation operations dispatches another Publication build.

The full 114-migration journey passed, including the existing connected browser build
and reopen/reuse checks. Receipt finished 2026-09-19T17:11:10.356079Z and confirms container
removal. Evidence: `/tmp/artifact-edition-advancement-postgres.log` and the maintained
portable Artifact PostgreSQL receipt. The two-edition retention transport recorded two
HEADs/four reads; compiler storage remains a separate synthetic transport. No Studio
rebuild, AWS, remote CI, deployment or push occurred. Lint/diff checks pass; foundations
inventory omissions and parity evidence drift remain unchanged.

Corrected the ordered execution register to reflect locally verified portable retention
and active RM-08 consumption work, rather than continuing to label portable outputs as
unstarted. Next address delivered preview rendering and reviewed compiler/runtime
integration, while preserving the distinction between local synthetic storage and
production authorization. Edition advancement here is verified through real repositories
and PostgreSQL; the browser separately verifies reference authoring/build reuse.
No broader parity status is promoted.


### RM-08 local preview delivery — September 19

Connected the actual private-preview shell and API capability exchange to local compiler
output. The fixture uses an ephemeral RSA key with the production cookie signer. A local
browser route adapter verifies the signed policy, expiry, key identity and exact build
prefix before serving retained compiler files. Chromium opens the saved Publication in
a separate window and sees its nested Artifact document; fetching another build prefix
is denied. Temporary output files and signing material are not published or retained.

The first journey failed because the loopback transport changed fetch metadata. The
fixture now asserts the browser Origin and restores same-origin fetch metadata across
that transport; API origin checks remain unchanged. The final full 114-migration journey
passed with 20 local API requests and no external requests. Receipt finished
2026-09-19T17:15:23.529331Z, with container cleanup confirmed. Evidence:
`/tmp/artifact-preview-delivery-postgres.log` and the maintained portable Artifact receipt.
The prior Studio build was reused. Lint/diff checks pass; foundations inventory gaps and
parity evidence checksum drift remain. No AWS, remote CI, deployment or push occurred.

This establishes the local shell/exchange/document-delivery path, including cookie scope,
not deployed CloudFront/S3 behavior. Edge delivery and storage remain test adapters;
the retained map uses a synthetic runtime, so visible document delivery does not prove
interactive GIS rendering. The coordinator README now describes the implemented lease
resolver and default-off activation boundaries. Next wire reviewed opt-in runtime origin
configuration and exact-version Artifact IAM access, retain compiler-image promotion
gates, and establish container/deployed acceptance in an authorized release window.
No parity completion is claimed.


### RM-08 opt-in GitHub runtime configuration — September 19

The reviewed GitHub workflow can now receive `STUDIO_ARTIFACT_API_ORIGIN` as the trusted
coordinator API origin. It remains empty unless configured in the GitHub environment.
The IAM stack/entrypoint accepts an optional bounded array of account UUIDs and adds
only exact-version reads of retained Artifact `map.html` objects under those accounts.
It adds no list/current-read/write/delete/publication permissions, service resources or
trust activation. Existing KMS constraints and lease authorization remain in force.

Local IAM synthesis/assertions, infrastructure TypeScript checking, CI policy checking
and diff checking pass. Evidence: `/tmp/artifact-runtime-iam-tests.log`,
`/tmp/artifact-runtime-types.log`, `/tmp/artifact-runtime-ci.log`. Foundations inventory
and parity evidence checksum failures remain. No Studio rebuild, PostgreSQL replay,
GitHub dispatch/push, AWS call, variable installation or deployment occurred.

The coordinator README records the required combined activation: reviewed compiler and
runtime pins, migration, default-off API flag, scoped IAM grants and trusted origin.
The isolated EC2 coordinator additionally needs a reviewed private API route; no public
egress was added. Next establish the reviewed compiler/container contract for invocation
v3 and prepare a bounded release package. Deployed IAM/network/storage acceptance remains
unproven and requires an authorized window; independent local parity work can continue.


### RM-08 container boundary and Framework Artifact output fix — September 19

A bounded Podman check exposed a missing integration: Framework did not emit ordinary
iframe HTML targets even though sealed Artifact bytes reached its input tree. Static
HTML compilation already retained them. Framework compilation now explicitly retains
admitted Artifact inputs under the source-relative output path, reads their exact checked
bytes and rejects generated-page collisions or symlink parents. Existing identical output
is reusable; generated pages are never overwritten. Final output inspection still owns
file/count/size constraints and result seals.

Static HTML and Framework Markdown now pass through the existing unprivileged, read-only,
network-disabled Podman runner, preserving exact Artifact bytes. Focused input/output
checks cover immutable input validation, collisions and symlinks. Evidence:
`/tmp/artifact-container-acceptance.log`, `/tmp/artifact-output-tests.log`.
Local candidate image: `sha256:17e57fea2df1b21f83b98801abad4e54b6fde33b80620d6753e4f1a63f6e15a0`.
It layers current compiler source over cached amd64 image
`99160fd14bed4c999ffd0cd5da7ebd92e62fdc217ac88da1b86bc227d45d6149`;
this is not a clean production Dockerfile build, vulnerability scan or release approval.
No packages were installed, network requests made, registry images pushed or production
pins changed. The candidate was rebuilt only after the integration failure was fixed.

Next verify incremental Framework attachment invalidation and prepare the reviewed
compiler release inputs. Existing container evidence must not be presented as ARM64,
production dependency closure or security attestation. Foundations inventory/evidence
seal failures remain outside this fix; no unrelated hashes were refreshed.


### RM-08 incremental Artifact attachment acceptance — September 19

The maintained compiler-container check now has an incremental mode covering a page
with an ordinary Artifact iframe and a second page consuming that Artifact through
Framework FileAttachment. Cold compilation renders both pages; unchanged inputs reuse
both. Changing the sealed Artifact edition/bytes rerenders only the attachment consumer,
reuses the independent iframe page and emits the new exact Artifact HTML. The complete
incremental output tree matches a clean build byte for byte. The iframe page need not
rerender when its URL is unchanged; its retained target is refreshed independently.

Evidence: `/tmp/artifact-incremental-container.log`. Used the existing local candidate
`sha256:17e57fea2df1b21f83b98801abad4e54b6fde33b80620d6753e4f1a63f6e15a0`
with no image rebuild, provider/network request, AWS call, registry push or deployment.
An initial fixture failed the required source-file ordering before compilation; sorting
that fixture corrected it without relaxing the compiler contract. Diff checks pass;
foundations inventory omissions and parity evidence drift remain. This local cached
candidate still does not establish clean production dependency closure or security review.

The existing compiler promotion plan is pinned to the earlier reviewed image and must
not be repurposed by changing its hashes to this candidate. Next assemble fresh reviewed
release inputs under the established promotion process, with scan/SBOM/platform evidence
and explicit release authorization. Continue independent application work while those
release-specific gates remain open; local RM-08 evidence does not close broader parity.


### RM-08 authoring convenience and status reconciliation — September 19

Artifact authoring can now load the saved source layout, choose an HTML/Markdown page
and provide sandboxed, no-referrer iframe markup relative to that page. New reference
paths use the admitted source root and avoid existing source/reference filenames.
Clipboard failure leaves selectable markup. This does not edit source bytes, publish
or build; authors still paste into the selected page and save. Native notebook-cell
insertion and direct source-editor integration remain separate work.

Focused path/editor checks and one Studio build pass. Evidence:
`/tmp/artifact-authoring-help-tests.log`, `/tmp/artifact-authoring-help-build.log`;
Studio tree `a63b69ce13ea14250cc831e344335645933f300af0c310f75087feea7bcb99e6`.
No deployed acceptance, AWS, remote CI or push occurred. Foundation inventory/evidence
seal failures remain. Connected acceptance of the new layout/copy interaction is still
open; prior connected Artifact evidence does not establish this new control's behavior.

Reconciled the reader-facing roadmap summary with current work: 15 required rows recorded
pass, 26 partial, 8 not started; these are not a completion percentage. Local integrated
publishing progress is distinct from full parity and release readiness. Collections,
broader Account sharing, Locations/context and remaining GIS families remain open.
Continue release preparation and independent application completion without treating
repeated local checks or successful builds as product-level parity closure.


### Connected authoring completion and RM-09 boundary audit — September 19

The built source-layout helper now passes through Chromium, the real local API and
PostgreSQL: default Artifact path uses the saved source root, relative embed markup
matches the chosen page, and unsaved reference edits survive actual Publication tab
switches. The same journey still verifies cross-workspace save/reopen, one build request,
reuse and preview delivery. Receipt finished 2026-09-19T20:47:22.239117Z: 21 local API
requests, no external requests, container removed. Evidence:
`/tmp/artifact-authoring-connected.log`. Studio output was reused; no AWS, remote CI,
deployment or push occurred. This verifies markup generation, not OS clipboard behavior.
Existing foundation inventory/evidence drift gates remain unresolved.

Audited the next independent domain: existing Collection names/routes are OGC dataset
or service groupings, not product Collections. Added `docs/workspace-collections.md`
with identity, ordering, optimistic writes, explicit account grants and independent
member authorization requirements. Next implement that connected RM-09 increment while
reviewed RM-08 release inputs remain open. Do not rename legacy access workspaces or
count a Collection grant as permission to read the referenced content.


## September 19: independent Collection persistence and Studio authoring

Added migration 0115, tenant-aware Collection repository and HTTP routes with
explicit reader/editor grants, optimistic revisions and member access resolved
independently. A Collection grant never grants underlying Project/Publication
access. Ordered unavailable references remain maintainable without exposing
target metadata; removing references preserves the resources.

The bounded local runtime-role PostgreSQL/API journey passed, including stale
writes, cross-account denial, member revocation and grant revocation; zero AWS
requests and container cleanup confirmed. Studio now adds a Collections directory
and editor with paged authored member selection, ordering, saving and conflict
draft retention. Focused DOM/client tests pass. Sharing UI and connected browser
acceptance are next; this is local implementation, not deployment or parity closure.
Existing aggregate foundation inventory/evidence checksum failures remain open.


### Collection sharing inspection and controls

Added owner/admin-only paginated grant inspection and Studio account-member
selection, reader/editor grants and revocation. Sharing retains independent member
authorization and uses the Collection revision; unsaved content blocks sharing
changes until saved or discarded. Existing account directory permissions remain.
Runtime-role PostgreSQL/API acceptance passed (21:02:56 UTC), including inspection
denial for readers and another account, pagination and revocation. Focused DOM/client
and Ruff checks pass; the single Studio build passed, tree
`5a26918063648af27446952477151ec3570b70837b7090c36bfbe1c7e4c22592`.
No AWS/remote CI/deployment. Existing foundation inventory/evidence drift gates
remain open. Next: connected browser/API/PostgreSQL Collection journey and navigation
continuity, without claiming RM-09 or broader parity complete.


### Connected Collection authoring and sharing accepted locally

The actual built Collection controls and API client now pass against local HTTP
and runtime-role PostgreSQL: create, select both authored member types, reorder,
save/reopen, grant a reader, hide a Project under revoked underlying workspace
access, revoke the Collection grant, and remove a reference. Finished
2026-09-19T21:09:19.338830Z; 23 browser API requests, zero external/AWS requests,
temporary container removed. The companion API journey verifies conflicts,
cross-account isolation and resource preservation.

This connected run found and corrected two product defects: empty optional
descriptions were rejected by the client, and the destination-based Publication
picker omitted native map/page Publications. A bounded, authorized authored-member
candidate endpoint now supplies both types. Focused client/DOM regression checks,
Ruff and the affected Studio build pass; built tree
`229a78728c85b33ab1973ac313db29836dea344148e139a9acf45c3abeab2016`.
No deployed/Cognito/full-account-shell acceptance is claimed. Existing foundation
inventory and evidence checksum drift still fail their gates. Next: durable
Collection links and navigation/account draft continuity, then remaining account
sharing acceptance. RM-08 release work and broader parity remain open.


### Durable Collection links and draft navigation

Collections now expose `/workspaces?view=collections&collection=<uuid>` links.
Opening or reloading a saved link reads that identity directly in the selected
account rather than scanning directory pages. Opening a different saved Collection
updates the address without creating another history entry; member routes and old
workspace URLs remain unchanged. A link is not an access grant and does not switch
accounts implicitly. Wrong-account/revoked reads retain API authorization.

The editor guards unfinished drafts and pending requests during directory changes,
Back navigation, refresh and sign-out. A document leave uses the native browser
warning; in-page navigation keeps the draft and asks the user to save/discard.
Back navigation restores the Collection URL with a history entry. Private drafts
are not persisted to browser storage. Account switching and Cognito remain separate
full-shell acceptance work.

The existing connected local journey now verifies durable-link reload alongside
authoring, sharing and revocation: finished 21:12:05 UTC, 22 local browser API
requests, zero external/AWS requests, temporary container removed. It used Studio
tree `76ce2fbe20e25f9a02511ff835cc8c14d155ff5ecab4e72ec50cd53eb2938a68`.
Subsequent parent-directory refresh/sign-out guards have focused DOM coverage and
a successful build, tree
`b24da6660490c09146b650c9f352c4da0497b182e82a5e8c4c17d36c4c346b24`;
unchanged Collection/API/database behavior was not rerun solely for those guards.
Existing aggregate inventory/evidence checksum failures remain. No deployment.
Next: full Studio account-shell Collection entry and account-switch isolation,
then remaining RM-10 acceptance and Location identity work.


### Account-aware Collection directory acceptance

Added an explicit account selector to the Studio directory using existing session
memberships. A Collection draft/pending request blocks switching; a successful
selection clears the old view and Collection URL before reloading account data.
Returning to the original account restores access through normal authorization.
No grants, resources, jobs or accounts are created by switching.

The browser journey now mounts the actual built `PlatformDirectory`, Collection
controls and API client against local runtime-role PostgreSQL. It verifies authoring,
ordered/durable reopen, reader grants and revocation, underlying member isolation,
blocked switching with a draft, no Collection disclosure in the other account, a
404 for the original identity there, and successful reopen after switching back.
The harness supplies synthetic verified identities and initial adapter account
selection; it does not prove Cognito, browser session storage or the workspaces
Markdown bootstrap/deployed shell.

The same journey initially made 81 local API requests. Collections were falling
through to every directory supplement; an explicit empty supplement scope now
avoids clients, teams, connections and publication-destination reads. Reverification
passed at 21:17:32 UTC with 45 local requests, zero external/AWS requests and container
cleanup. This establishes request reduction, not a deployed latency measurement.
Core account/workspace checks remain. Focused directory, Collection and platform
checks and the Studio build pass, tree
`af6fe5039aaa47323ec781e567e8a07e904a3d49a1f96c83cb660596383c5804`.
Foundation/parity inventory/evidence-drift gates remain failing; no deployment.
Next independent domain: RM-11 Location identity and permission-aware resource
relationships. Keep broader RM-10 acceptance, Cognito/deployed release and full
parity requirements open rather than treating this directory journey as completion.


### RM-11 independent Location identity and versioned knowledge

Audit found map-local portal camera bookmarks but no persistent place identity.
Preserved those map definitions and added migration 0116 plus `/locations`
list/create/read/version/update APIs. Locations have independent account identity,
creator/owner, immutable document history and optimistic edits. Initial access is
owner/account-admin only; active membership and tenant fences apply throughout.
Documents retain aliases, external identifiers, canonical URI, optional validated
CRS84 geometry and the existing source/normalized/curated/inferred knowledge model.
Null geometry and unknown rights stay unknown. Reads create no maps, copies or jobs.

The bounded runtime-role PostgreSQL/HTTP journey passed at 21:22:40 UTC: create/list,
private-object and cross-account denial, current/old-version reopen, stale conflict,
unknown knowledge preservation and invalid-coordinate rejection. All 116 migrations
applied; temporary container removed, zero AWS/network requests. Focused Ruff checks
and whitespace checks pass. Required aggregate checks still report inventory gaps
and evidence checksum drift. No Studio build was needed for this backend-only
change; no deployment or remote CI occurred.

Next implement the connected Studio Location editor and revisit immutable revisions,
then hierarchy, explicit sharing and permission-aware Layer/Project/Publication/
Collection relationships. See [Location contract](workspace-locations.md). This is
partial RM-11, not completed Location workflow or a parity-row promotion.


### Connected Studio Location editor

Locations now have directory navigation, explicit create/list/edit, durable identity
links and read-only historical revision inspection. Names, aliases, canonical URI,
optional GeoJSON and advanced identifier/knowledge JSON save through the versioned
API. History reads retain unfinished drafts; stale writes retain edits. Untouched
alias arrays, source text, nested knowledge and unknown geometry remain preserved.

Generalized the directory resource-draft guard for both Collections and Locations
(account switches, links, Back, refresh and sign-out). Removed an accidentally
misplaced guard in the independent invitation panel that referenced an unavailable
directory variable. Existing Collection/directory tests and new Location conflict/
history checks pass. No unrelated directory supplement loads were added.

The actual built directory and Location editor pass against local HTTP/runtime-role
PostgreSQL, including geometry save/reopen, historical null geometry, direct links,
draft-blocked account switching, cross-account denial and return/reopen. Finished
21:27:31 UTC with 25 local API requests, no external/AWS requests and container
cleanup. Studio build tree
`d925d2a5dab4363c4b5df054b9f84d2cff7e0a99076325d3c99fceae48241e92`;
Ruff/whitespace checks pass. Foundation inventory and evidence checksum gates still
fail. Authentication/bootstrap/deployed acceptance remain separate.

Next: explicit geographic hierarchy, Location sharing and permission-aware Layer/
Project/Publication/Collection relationships. Graphical geometry editing is also
open. This increment does not close RM-11 or any aggregate parity target.


### Location grants and current authority over history

Migration 0117 adds explicit same-account reader/editor grants with a separate
access revision. Sharing changes do not create content revisions; editors save
content without taking ownership, while only owners/account administrators manage
grants. Current authorization gates historical reads as well as current records.
Studio shares parameterized grant controls with Collections, protects unfinished
drafts and gives readers disabled content editing plus usable history inspection.

Updated local API/PostgreSQL acceptance verifies reader/editor behavior, private and
cross-account boundaries, stale sharing edits, independent content/access revisions
and denied historical access after revocation. The built directory journey verifies
reader history and sharing revocation alongside authoring/account switching. A test
harness bug (reader identity lost on clean-URL reload) was corrected with per-tab
synthetic identity retention; prior API checks were valid, but previous browser
reload observations alone were weaker. The corrected Location and Collection
journeys both pass using the same temporary database.

Finished 2026-09-19T21:45:06.796856Z after 117 migrations: 40 Location and 45 Collection
browser API requests, zero external/AWS requests, temporary container removed.
Focused DOM checks, Ruff, whitespace and the Studio build pass, tree
`b9178a0ea20099de9b0726b654572ca7c0b7405ce66c54472de3dabccef9aea8`.
Foundation inventory/evidence checksum checks remain failing; no deployment or
remote CI. Cognito/bootstrap/live acceptance remains separate. Next implement
cycle-safe geographic hierarchy and permission-aware resource relationships,
without propagating Location grants to linked resources. RM-11 and parity stay open.


### Location parent hierarchy persistence

Migration 0118 and the parent API add explicit, versioned geographic parent
relationships with evidence/confidence. Content, sharing and hierarchy revisions
remain independent. Assignment requires child edit and parent read authority;
removal preserves both records and history. Current/historical reads omit parent
identity, title and relationship metadata when the reader cannot access that parent.

Account-scoped transaction advisory locking serializes graph mutations before
Location row locks. A bounded ancestor check rejects self-links/cycles. The real
runtime-role PostgreSQL/HTTP journey passed after 118 migrations, including
simultaneous opposing parent updates (one success, one conflict), hidden-parent
redaction, historical access after a grant, independent content revisions, stale
edits and cross-account denial. Finished 2026-09-19T21:48:17.769654Z; container
removed, no AWS/external calls. Focused Ruff and whitespace checks pass. Existing
foundation/evidence checksum gates remain failing. No Studio rebuild was needed
for this backend-only increment.

Next connect Studio parent selection, removal, relationship-history inspection
and navigation, then permission-aware Layer/Project/Publication/Collection links.
Single-parent hierarchy is curated, not a geometric containment assertion; no
ancestor/descendant directory or arbitrary-SQL cycle enforcement is claimed.
RM-11, live release and full parity remain open.


### Studio parent-place selection and relationship history

Connected the Location parent API to a deliberate Studio panel: authorized paged
parent selection, evidence/confidence editing, save/reopen, explicit removal,
permission-aware parent links and read-only relationship history. Content and
parent drafts are independent and mutually guard editing; both block navigation,
account switching and sharing until saved/discarded. Failed writes retain the
parent selection/evidence, and history inspection never replaces that draft.

The built directory/browser/API/PostgreSQL journey passed at
2026-09-19T21:52:18.419936Z: parent save/reopen, disabled content save during a
parent draft, hidden parent for a shared child reader, removal with retained
historical parent, plus prior authoring/account/sharing checks. 59 local API
requests, zero external/AWS requests; temporary container removed. Companion
PostgreSQL checks retain concurrent cycle rejection and hierarchy revision evidence.
Focused hierarchy conflict/history and existing directory/editor tests pass;
Studio build tree `0a8c2ec9f618c18552e163c17fe93266e41f431326d51039d7847d3a4eaa1a2a`.
Whitespace checks pass; aggregate inventory/evidence checksum failures remain.
No deployment or remote CI.

Next: permission-aware Location relationships to Layers, Projects, Publications
and Collections, retaining relationship evidence and independent authority. Broader
hierarchy traversal, graphical editing, authentication/bootstrap/deployed acceptance
and the parity target remain open.


### Location links across resource domains

Added migration 0119 and versioned Location link APIs for canonical Layers,
Projects, Publications and Collections. Every new reference resolves the target's
existing authorization in the same tenant transaction. Ordered snapshots retain
relationship/evidence/confidence without copying target data. Content, hierarchy,
access and link revisions remain separate. Hidden entries expose only their local
entry identity and availability, allowing retention/removal without disclosure.
Historical snapshots still enforce current target permissions.

The bounded runtime-role PostgreSQL/HTTP journey passed after 119 migrations at
2026-09-19T21:57:10.960100Z: all four target types, private Collection redaction,
revoked Project access, forbidden new target selection, stale conflict, retention
of hidden entries, empty active snapshot, historical reopening and preserved target
records. Existing Location hierarchy/sharing checks also pass. Container removed;
zero AWS/external calls. Focused Ruff/whitespace checks pass. Required aggregate
checks still fail on inventory gaps and evidence checksum drift. No Studio rebuild
or deployment for this backend-only change.

Next connect Studio resource-link selection, ordered editing and history, using
authorized candidates and shared draft guards. Back-reference/spatial discovery,
remaining RM-11/RM-12 breadth and full parity acceptance remain open.


### Connected Location links across the workspace

Studio now connects Locations to authorized Layers, authored Projects, Publications
and Collections through one bounded picker. It supports ordered reference edits,
relationship/evidence/confidence, explicit removal, canonical target navigation and
read-only historical snapshots. Hidden entries remain removable/reorderable without
metadata disclosure. Pending assertion fields must be added or discarded before
save. Content, hierarchy and link drafts use separate guarded state.

The actual built directory/API/runtime-role PostgreSQL journey passes all four
target selections, order/save/reopen, link history, reader redaction and removal,
alongside existing Location authoring, parent, account and sharing checks. Finished
2026-09-19T22:02:13.028263Z with 78 local API requests, zero external/AWS requests and
container cleanup. Focused hidden-entry/conflict/pending-assertion tests plus existing
editor/navigation tests pass. The affected Studio build passed once, tree
`543463af37fa22c653f31a8b819593cdc0ee4fb85d5cce3b61928875cae0e24f`.
Whitespace checks pass; existing foundation inventory/evidence checksum failures
remain. No deployment or remote CI.

Next: RM-12 provider context integration audit and bounded reference-first workflow,
including current provider terms before implementation. Preserve outstanding RM-11
graphical geometry, hierarchy/back-reference discovery and authentication/bootstrap/
deployed acceptance; these local connected links do not close the parity target.


### Manual provider context retained with Locations

Studio now records KartaView and Mapillary observation references in the Location
knowledge draft and reopens them as safe external links with supplied attribution
and relationship confidence. Separate curator assertions retain manual provenance,
time and explicit unknown rights; no source metadata or permission is fabricated.
Unfinished observation fields must be added or cleared before saving. Readers see
references without editing. Navigation/save perform no provider retrieval or build.
The [provider integration contract](provider-context-integrations.md) records reviewed
provider documentation, exact supported forms and remaining scope.

Focused preservation, link safety, reader display and pending-draft checks pass.
One Studio build passed, tree
`d8910a3e52826078468059ee9eca87d89bba91278cf8232c4957edee6efd335a`.
The connected built-directory/API/runtime-role PostgreSQL journey passed at
2026-09-19T22:10:40.954543Z after 119 migrations, including both provider references
saved/reopened, unknown rights and all prior Location account/history/sharing/link
checks: 78 local browser API requests, zero external/AWS requests, container removed.
Dependency-inventory and evidence-checksum aggregate failures remain; no deployment
or remote CI. This does not establish imagery availability, provider discovery,
verified metadata retrieval or parity closure.

Next: reconcile GeoLens comparison rows against existing connected workflows and
identify reusable evidence versus missing independent-client acceptance. Continue
bounded provider discovery and guided metadata work from explicit unresolved
requirements, retaining RM-08 production delivery and broader Location acceptance.


### GeoLens criteria reconciled with retained composition evidence

Reviewed the existing real PostgreSQL two-composition/one-Layer/one-Style assertions
and the successful September 19 22:10 receipt. Retained that receipt and reviewed
source hashes in `parity/reports/geolens-004-local-composition.json`; linked a scoped
contract packet to `geolens.map-composition`. The row is now partial, not passing:
visual presentation, visibility/order/filter comparison and full Studio/deployed
acceptance remain open. No new build, database journey, AWS or remote CI was run.

The GeoLens comparison now distinguishes reusable implementation candidates from
missing acceptance for every family. Canonical dataset search lacks spatial extent
filtering, while the presentation inventory remains a distinct compatibility path.
Next complete composition interaction/rendering acceptance with the existing Style
workbench harness and reusable built artifact, then address canonical spatial search
with explicit CRS/unknown-extent handling. Scope remains 50 rows: 15 pass, 27 partial,
7 not started and 1 conditional not applicable. No product parity claim is eligible.

Verification: the focused GeoLens ledger contract and whitespace check pass.
Coverage calculation confirms 158 packets and 43 linked rows. Required foundations
and parity gates still fail on existing dependency inventory and retained artifact
checksum discrepancies; no unrelated evidence was resealed.


### Composition visibility and canvas rendering acceptance

Fixed referenced point Style opacity: fill and outline both multiply the composition
opacity, including optional saved circle-stroke-opacity. Shared Style bytes remain
unchanged. Added actual built Studio hide/save/reopen assertions and a local MapLibre
canvas probe using production Style resolution/installation. It checks pinned line
color, visibility, opacity, draw order and zero/fractional point-outline opacity.
Focused checks also establish explicit rejection of unsupported filtered Styles
with valid identity/checksum bytes, rather than silently dropping their filters.

The extended connected runtime-role PostgreSQL/browser journey passed at
2026-09-19T22:20:36.820032Z: 81 local API requests, zero provider/AWS requests and
container cleanup. One affected Studio build passed, tree
`197440dca7601985d5e913d90533ca3926d361edd49209ac7743942852a1f20d`.
An initial connected run covered line pixels; the extended point regression used
the same build. Both receipts passed. No remote CI or deployment. Focused Style
checks pass; aggregate foundation inventory/evidence-checksum failures remain.

GeoLens composition stays partial. Retained the extended receipt and exact limits
in its criterion report: synthetic geometry/point styles, substituted token
verification, no physical GPU/deployed claims. Canvas ordering does not prove
persisted multi-Layer UI ordering. Next complete that ordering and filter/disclosure
journey, then canonical catalog spatial filtering with audited coordinate semantics.


### Persisted composition order and unsupported Style filtering

Extended the existing built Studio/API/PostgreSQL journey with two presentations
of the same canonical Layer. Actual move-up controls change order, save both
Projects and reopen the same order. The post-browser database check confirms
ordered layer identities and shared pinned Style identity, without duplicating
the canonical dataset. Canvas acceptance still resolves the intended bound Layer
after reordering. The focused picker check supplies valid-checksum filtered Style
bytes and verifies that incompatibility is disclosed while the active selection
remains unchanged; it does not claim support for filtered Styles.

Passed at 2026-09-19T22:23:07.500259Z: 85 local API requests, zero provider/AWS
requests, temporary container removed. Reused the unchanged Studio tree
`197440dca7601985d5e913d90533ca3926d361edd49209ac7743942852a1f20d`;
no build, deployment or remote CI. Updated the GeoLens criterion report with the
receipt and exact boundaries. The row remains partial: independent portrayal,
broader filtering, full account/bootstrap and deployed/physical-browser evidence
remain open. Next implement canonical catalog spatial filtering after auditing
extent CRS and missing/antimeridian behavior; it must compose with existing
lexical filters and authorization without creating a Project.

Verification: focused picker/GeoLens contract and whitespace checks pass. Required
aggregate gates remain failing on existing dependency-inventory gaps and retained
artifact checksum drift. No unrelated evidence was resealed.


### Canonical Layer catalog spatial discovery

Audited native vector/raster source extents and CRS before adding spatial search.
Migration 0120 retains those fields and derives indexed CRS84 geometry at write time.
Known EPSG projections use bounded boundary transformation; geographic date-line
extents split explicitly. Unknown, mixed, invalid or untransformable extents remain
in ordinary catalog results but do not falsely match a spatial filter. Queries use
the selected current dataset version and existing object/account authorization.

Connected Studio now combines optional longitude/latitude bounds with lexical and
existing catalog filters through `/datasets`. It supports deliberate search, clearing
bounds and invalid-input recovery without map creation, source retrieval or copying.
Legacy project dataset listing accepts the same bbox parameter. Fixture-only data
rejects unsupported spatial filtering explicitly instead of returning unfiltered
matches. See `docs/catalog-spatial-discovery.md` for CRS, approximation and release
limits; `docs/catalog-spatial-local-evidence.json` retains the successful receipt.

The connected runtime-role PostgreSQL/HTTP/Studio journey passed at
2026-09-19T22:31:33.095183Z after 120 migrations: native/projected and date-line extents,
unknown CRS, lexical combination, account denial, invalid bounds and unchanged map
count; eight local browser API requests, zero external/AWS requests, container removed.
The affected Studio build passed once, tree
`ba6b28d6915362da17c85325c33ec892d366cbea5397476aaaa038fb12c77d67`.
The fixture-only explicit rejection guard was added afterward and syntax checked;
the connected API build evidence does not assert fixture-mode acceptance.
Focused API catalog tests, API-client tests and Ruff pass. Integration found and fixed
an omitted canonical query predicate; subsequent harness failures were an allowlist
entry and result-label punctuation. No deployment or remote CI. Required aggregate
checks retain existing foundation inventory and evidence checksum failures.

Next: expose spatial-coverage availability and connect saved Location geometry to
catalog discovery, then reconcile exact GeoLens catalog criteria. Keep independent
client, broad projection/discontinuity, representative-volume/index-plan and deployed
authentication acceptance open. The generated-column/index migration needs bounded
release planning for existing table size and locks; no production migration occurred.


### Saved Locations supply canonical catalog bounds

Added deliberate, paginated Location selection to the authorized Resources catalog.
The current authorized Location geometry supplies an editable enclosing rectangle,
with the source title/revision reported. Search remains explicit and preserves
other filters. Unknown geometry and failed reads preserve the existing bounds;
manual edits during a pending lookup win over its late result. Disposed account
views receive no late geometry. No Location write, radius inference, provider request
or Project creation occurs. Other catalog modes disable these controls.

The connected built Studio/API/runtime-role PostgreSQL journey passed at
2026-09-19T22:35:37.188786Z: saved Point Location bounds, unchanged bounds for unknown
geometry, spatial/text results, excluded outside records, clear/recovery and all
prior source-CRS/date-line/account checks. Eleven local browser API requests, zero
external/AWS requests, temporary container removed. Receipt retained in
`docs/catalog-location-local-evidence.json`. Studio build tree
`f317fe1f33aa26991b1aa537e5a4e0f8d9ad81e3278d956b56e6e86aeb5fbfd6`.
A final rebuild included the disabled-control guard for direct published-catalog
entry. Focused late-response draft protection, Ruff and whitespace checks pass;
aggregate dependency-inventory and evidence-checksum failures remain. No deployment
or remote CI.

Next expose whether a dataset has usable spatial search coverage and complete the
canonical catalog inspection/reopen acceptance before updating its GeoLens row.
Independent comparisons, graphical bounds, exact polygon search, broad projections,
representative-volume latency and deployed identity remain open. Date-line split
Location geometries use their planar enclosing rectangle; crossing bounds remain
editable explicitly. No aggregate parity row closes from this connector.


### Spatial coverage availability and canonical Layer reopen

Dataset responses now expose nullable spatial-search availability from the selected
version's derived geometry. The catalog and Layer inspector distinguish usable,
unavailable and unreported coverage without inferring absence of source data or
permission. Older responses remain compatible. The connected browser journey now
follows the actual catalog Layer link and reloads its canonical identity with no
writes, provider calls or Project creation.

Passed at 2026-09-19T22:38:32.403005Z after 120 migrations: 19 local browser API
requests, zero external/AWS requests, temporary container removed. The affected
Studio build passed, tree
`7a6a1e793a654fa299c5d4594a8c6a6e34c4393aa59298ca7c85618ea10dca83`.
Focused API catalog, API-client/Layer inspector, GeoLens contract, Ruff and whitespace
checks pass. Required aggregate checks still fail on dependency inventory gaps and
retained evidence checksum drift. No remote CI, deployment or new live-service use.

GeoLens catalog now links scoped local evidence and is partial. Its report retains
the real receipt, source hashes and limits; no independent GeoLens runtime, full
Observable bootstrap/Cognito, representative-volume or global-projection acceptance
is inferred. Counts are 15 pass, 28 partial, 6 not started and 1 conditional not
applicable. No product-level parity claim is eligible.

Next resolve the direct-dependency foundation inventory gate using actual manifests
and installed package license/source metadata, without changing package versions or
resealing unrelated evidence. This is a shared release prerequisite; retain guided
metadata/source coverage, independent comparisons and deployed acceptance in scope.


### Foundation dependency inventory gate restored

Reconciled direct manifests and existing package-lock entries with installed npm
metadata/license files. Added notebook-kit, markdown-it, monaco-editor,
path-browserify, Observable Inputs, esbuild, htl and JSZip; corrected builder usage
and evidence paths for Plot/D3. Preserved exact resolved versions and license
expressions, including JSZip's dual-license expression. Retained local metadata and
license hashes in `governance/foundation-inventory-review-20260919.json` and updated
the public engineering inventory table.

`npm run foundations:check` now passes: 43 direct packages, 17 platform foundations
and 7 source-audited references. No dependencies, lockfiles, compiler artifacts or
release images changed; no downloads, build, remote CI or AWS checks were needed.
Shipped notices, transitive/OS SBOMs, exact release review and historical parity
artifact drift remain separate. No new platform/reference source audit is claimed.

Next audit parity checksum failures by owning claim and changed path. Classify which
packets need targeted revalidation versus superseding evidence; do not blindly
refresh hashes. Continue independent feature work where release evidence is blocked,
retaining full parity scope and deployed acceptance requirements.


### Parity drift ownership and first scoped revalidation

Added a read-only drift auditor that groups failing fixture seals by file, owning
packets, row and candidate verification commands. Initial audit: 105 mismatches
across 38 paths/23 rows, no embedded-data drift. Reviewed the exact-object reader
MIME addition against its sealed HEAD version; 15 local signing/exact-read tests
passed. Refreshed only its source and test seals, retaining old/new hashes and
scope in `parity/reports/publish-001-object-read-revalidation.json`. Historical
ledger dates and broader publishing claims remain unchanged.

Remaining: 103 path mismatches across 36 files/23 rows. The review plan and retained
ownership snapshot identify coherent API, shared-browser, infrastructure/dependency
and final-documentation batches. No package install, build, remote CI or AWS call
was required. Next execute the API publishing/control review batch and targeted
checks, preserving independent persistence and deployed acceptance limits. Full
parity is still unproven; a historical passing packet does not validate all changes.


## September 19 continuation: startup and selected-Layer inspection

User production screenshots show slow/failing `/workspaces`, a catalog Open map link
into a seven-layer access workspace, and legacy access containers under Projects.
Request IDs: `6ba4d58c-6c77-40e9-917d-8c88332b3ab7` and
`8e5b6146-041e-4756-917c-fddceabd4578`. A single bounded CloudWatch lookup was denied
by the production operator role; this establishes no API root cause. No role policies
were changed and no further remote probes or deployments were performed.

`workspaces.md` now renders static startup status before Observable/module/configuration
loading. `DirectoryLoading` adds an indeterminate status bar to its real stages;
`authConfig.js` bounds configuration fetch/body wait to 15 seconds. Directory errors
provide a retry/support request-ID explanation. Existing account request deadlines and
permission checks remain in effect; no measured production latency reduction is claimed.

Catalog Open map now expands only its selected Layer. ImageServer rendering uses the
existing validated exportImage tile template in `MapView`, an empty local background,
initial provider extent when its CRS can be transformed, navigation/scale controls and
rendering feedback. This avoids loading the full Project workspace and its other Layers.
No ingestion, saved composition write or archived-data substitution occurs. A separately
labelled containing-Project link preserves compatibility. Feature previews retain their
bounded sampling behavior. Direct save/assignment into a canonical Project is still open;
the legacy resource attachment selector is not accepted as that workflow.

The local Projects directory already uses `CompositionDirectory` (`app.maps`) and a
separate access-workspace disclosure; Publications retain their separate route. The
screenshots therefore remain a deployment/acceptance gap, not evidence that the local
separation is live. See `studio-startup-layer-preview-local-evidence.json` for this batch.

The preceding Collection image batch passed connected local browser/API/PostgreSQL
acceptance, including PNG decoding and disappearance after revocation. Its exact receipt
is `studio-collection-image-preview-local-evidence.json`; no cloud/renderer proof is inferred.


## Catalog preview → canonical Project save

`CatalogProjectSave` now connects the temporary preview to deliberate composition saves.
Saved-map Layer views preserve the inspected occurrence's source pin, configuration and
Style reference; registered FeatureServer/ImageServer connections construct a governed
Layer definition. Inspection still performs no save. New Projects contain only that Layer
and capture the preview camera; existing compositions append one occurrence and retain
other Layers, configuration and views. Containing-Project links use canonical composition
URLs. Dataset identity is retained across both paths, with existing server authorization
and optimistic versions governing writes. No database rename or migration was needed.

Project selection searches/pages canonical `/compositions` only. New Projects currently
use the source access workspace. Existing destinations in another access workspace first
use the existing dataset-reference attachment API, then versioned map update. This is not
an atomic transaction: the UI explicitly reports a successful link followed by a failed
map save. A repeated existing-map save in the same dialog recognizes the occurrence ID;
new-map response ambiguity suppresses immediate repeat submission and requires checking
Projects. Native modal and beforeunload guards are present; full SPA navigation/account
change coverage remains to be accepted. Source revocation remains enforced by existing
server map-reference validation, not client metadata claims.

Local built-control acceptance created/reopened one Project and updated/reopened another
through 12 real local API requests, preserving existing content and the Layer/Style pin.
The temporary PostgreSQL container was removed; zero external/provider/AWS calls.
`catalog-project-save-local-evidence.json` records exact scope and remaining gaps. The
full live ImageServer catalog → preview → save path is not claimed by this control fixture.


## Durable Project creation recovery and pending-save shell guards

Migration 0126 adds tenant-scoped, creator-scoped `map_creation_requests`. Optional
`creation_key` on map creation is recorded in the same transaction as the map and its
initial version. The digest covers destination access workspace, title, description and
complete definition. Same-key retries are serialized, return the existing map and reject
changed intent. Current create and source-reference authority is checked before receipt
lookup; a receipt never grants access. Runtime can insert/read but not mutate receipts;
worker access is denied. Existing clients without a key retain their original behavior.

Catalog Save freezes its intent and camera for uncertain create responses, retains the
key, and offers Retry Save. This recovers the original map without automatic retries or
new processing. The key is durable on the server; dialog state is not persisted across
reloads. Existing Project optimistic update and partial-link reporting are unchanged.

Connected local browser/API/database evidence deliberately replaces a successful create
response with 502: the retry returned the same Project and the directory contained one
matching Project. Changed intent returned conflict; the revoked-source editor save was
denied. Sixteen local API calls, 126 migrations, zero AWS/provider calls, container removed.
See `catalog-save-recovery-local-evidence.json`. Navigation, Back URL restoration, refresh,
account switching and sign-out now check for pending catalog save dialogs; completion and
Cancel release the guard. Focused guard tests pass, but full-shell browser coverage is open.


## Full catalog ImageServer save and shell acceptance

`check-catalog-image-save-postgres.mjs` now exercises the built `PlatformDirectory`,
actual catalog results, source loader, MapLibre preview, Save dialog, canonical Project
list and API client together. It registers an ImageServer through the local API, serves
one controlled provider metadata response and local PNG tile fixtures, and saves/reopens
one canonical composition. No save occurs during inspection. Source dataset identity,
revision, URL, display configuration and single-Layer membership survive persistence;
the preview camera becomes the new Project view.

This journey exposed hard-coded ImageServer display settings in `MapView`. The preview
now takes the registered Layer configuration for bands, tile size, image format and
interpolation; the fixture checks band_ids [2,1,0] both on tile requests and saved state.
Actual shell handlers reject pending-save navigation, Back, account changes and sign-out;
Escape retains the modal. Completion permits normal navigation and reload of Projects.

The final local receipt records 18 browser API calls plus one source-registration setup
request, one metadata fixture and 20 PNG tile fixtures; 126 migrations, no external/AWS
requests, database cleanup confirmed. Build and 11 focused preview tests pass. Scope and
limits live in `catalog-image-project-local-evidence.json`; this does not measure NOAA
or production startup performance. A bare-root fixture ImageServer URL was accepted by
source registration but not projected as a catalog service; the representative fixture
uses the conventional ArcGIS service path. Root-path consistency is a separate follow-up.

## Root-level ArcGIS catalog references

The projection sanitizer previously required a nonempty directory before the
service name, so an otherwise valid `https://host.example/ImageServer` lost its
provider reference. The path matcher now accepts the root service while retaining
existing HTTPS/credential/query/host/traversal constraints. Nested paths preserve
their existing behavior. Focused tests cover root service and numbered feature/map
layers, reject ImageServer child operations and traversal, and verify the catalog
query projection retains the root identity. Thirty-one focused checks pass; no
provider fetch, database migration or deployed acceptance is claimed. The previously
sealed native build input remains its historical snapshot and does not include this
later API edit; reconcile candidate contents before release.

## Project and Publication metadata hosts (local)

`AuthoredResourceMetadata.js` supplies an on-demand panel around the existing
ResourceKnowledge editor. Canonical composition views mount Project metadata using
`state.selectedMap.id`; the legacy access container is never substituted. Each
Publication workspace mounts metadata using its own site ID, regardless of whether
it edits Framework source or maps/pages. Metadata rights remain governed by the
existing API response's `canEdit`, not the container role guessed by the host.

The workspace-level guard checks all mounted metadata editors, including hidden
Publication panels. Dirty or busy editors block refresh, same-tab links and account
commands; browser Back restores the current URL, and beforeunload warns on leaving.
Saving/discarding clears the shared editor's guard state. Event listeners are removed
when the workspace disconnects. Switching Publication panels retains their mounted
drafts rather than discarding them. Metadata panels make no background API requests.

Two focused DOM journeys cover Project/Publication identities, on-demand reads,
unknown license preservation, save/reopen and navigation guard release. Existing
shared-editor, publication-workspace and durable-job workspace checks pass.
These checks use local adapters/DOM; real authenticated API/database host acceptance,
rendered layout and the next bundled Studio build remain required. No AWS or build
execution occurred for this increment. Native execution remains separately awaiting
approval after automatic review rejected the private-source export/paid runner.

## Built authored-metadata persistence acceptance

The actual ProjectWorkspacePage and Publication workspace now pass local Chromium
acceptance against OpenGeoApiClient, live local HTTP handlers and PostgreSQL under
`opengeo_runtime`, with all 126 migrations. Both hosts save an explicitly unknown
license, reopen it after reload, and remove edit controls for the fixture reader.
The shared cached-container harness also retains its existing composition/Style and
permission assertions. No external provider was contacted; the temporary container
was removed. [Exact evidence](authored-metadata-hosts-local-evidence.json) binds the
Studio tree and records synthetic-token and navigation/visual coverage limits.
The unreleased Demo artifact was preserved before the Studio build replaced dist.

## Authored metadata browser guards and mobile layout

The existing built/API/PostgreSQL journey now also verifies same-tab link blocking,
Back restoring the original URL and draft, and cancellation of Chromium's reload
prompt. Saving still releases the guard and metadata reopens for readers.
A width-only assertion initially passed while the Project editor was clipped by
the navigation strip and covered by the fixed mobile map. Screenshot inspection
caught this false-positive visual evidence. The Project panel is now a separate
scrollable sibling of the map; canonical Project pages let the mobile map participate
in the page layout. The public Demo layout retains its existing rules.

The stronger check requires the full textarea inside the viewport and its center
hit-test to identify the textarea itself. The final 390-pixel screenshots were
visually inspected for both resource types. The repeated runs were driven by those
observed failures and code corrections; the final API/database journey passes and
container removal is verified. Account-command and refresh guards still have DOM
coverage rather than new full-browser acceptance. No live identity/provider/deploy
claim follows from this local evidence.

## ImageServer save permission acceptance

The existing built catalog/ImageServer/API/PostgreSQL journey now includes a reader
attempting new-Project save and an editor whose workspace access is revoked while
the save form is open. Before revocation, the real membership API confirms the editor
role and the normal dataset/source endpoint returns the source. Both saves fail with
permission errors, preserve the entered title and allow cancellation. An administrator
reads the composition inventory to confirm neither denied title was created.
The authorized create/reopen path, source identity/band retention, inspection without
writes and shell navigation guards continue to pass in the same journey.

The final run used 126 local migrations, 29 browser API calls, two metadata fixtures
and 40 intercepted image tiles. Additional setup/revocation/inventory requests are
local control-plane calls, not included in the browser count. No provider or AWS
request occurred; container cleanup is verified. See [evidence](catalog-image-permissions-local-evidence.json).
This does not establish live Cognito, deployed permissions or denied append to an
existing composition. The initial strengthened precondition used an incorrect test
URL; corrected the harness to the application's dataset/source route before acceptance.

## Demo empty-Project catalog entry follow-up

The empty Demo map now offers **Browse Layer catalog** and explains catalog selection,
source registration and browser save limits. New Project already opens that catalog;
the explicit empty-map action also returns to its searchable list. This corrects the
misleading project-dataset-only prompt without changing Studio's managed data flow.

Built local registration acceptance passed, including new Project → searchable catalog
→ review → add without changing Project, rendering and metadata reopening. Receipt:
`.local-archives/demo-catalog-entry-20260919/registration-check.json`; build tree
`f366d1226a1d3fdbf03ae5b62f2497f2da1a7a95938b2c278cc7246094630a4d`.
The journey intercepted 69 synthetic service requests and contacted no external provider
or private API. Build, whitespace and foundations checks pass; aggregate parity still
fails historical evidence hash mismatches. This copy increment is not deployed.
Next bundle it with the next Demo release; independent simultaneous KML editing and
provider discovery remain separate acceptance gaps.

## KML render ownership prerequisite (local)

KML map handles now retain their Layer's document. Image resources/overlays resolve
against that document, and region refresh visits each document handle independently.
Legacy `kml-places` handles still adapt the old global document; ordinary Layers never
inherit it. Initial hydration, reviewed import, edits and browser restoration attach
the document to the existing Layer. Region counters aggregate across rendered handles.

A focused two-document renderer check proves distinct coordinates survive global-editor
selection changes, separate overlay visibility and legacy fallback. The built Demo
registration journey passes against tree
`c9f45d121ae79e27d697b071ea67bcabc52f66ead869909618a8041bc10798d9`, including actual KML
point rendering and metadata reload. Receipt:
`.local-archives/kml-render-ownership-20260919/registration-check.json`.
There were 88 intercepted synthetic service requests, no external provider/private API
requests and no AWS calls. Foundations and whitespace pass; aggregate parity retains
historical evidence-hash failures. No deployment or multiple-document UI claim.

Next: replace import's single occurrence and migrate selected editor/NetworkLink state,
then persist per-occurrence documents with old-draft compatibility. Verify two KML
Layers together, independent editing/visibility/overlays and save/reload before claiming
simultaneous KML support. The import currently still replaces the active KML occurrence.

## Independent Demo KML documents (local acceptance)

Demo imports/catalog additions now retain prior KML occurrences. Selecting a KML
Layer selects its document, metadata draft and NetworkLink session context. Context
switches cancel pending requests/timers; an epoch guard prevents late responses from
writing into a different document. Removed inactive contexts are pruned. Region refresh
uses each handle's complete feature collection so already-loaded linked features are
not overwritten by the root document alone. Child edits preserve curated Layer titles.

Demo drafts retain each document, report and bounded NetworkLink receipts on its Layer;
a format marker distinguishes these drafts from the old top-level single document.
Old drafts still adapt without destructive changes. Session approvals, controllers and
timers are not persisted. Managed Studio retains the old import/schema path until its
persistence migration is implemented; this is not full managed KML parity.

The built browser journey adds two registered KML sources, edits a child in each,
hides one, saves and reloads, checks both distinct documents and visibility, then shows
both and requires MapLibre rendered features from both occurrences. Existing source
review/cancellation/catalog/metadata/remote-reference cases also pass. See
[kml-context-local-evidence.json](kml-context-local-evidence.json). Focused rendering,
annotation, authoring and NetworkLink contract checks pass. Whitespace/foundations pass;
aggregate parity still fails historical evidence hashes. No provider/private API/AWS
calls or deployment. Synthetic WMS requests remain intercepted fixtures.

Next migrate the managed map-definition and portable serialization paths to retain
all KML documents, then verify save/export/reimport and managed API reopening. Add
cross-document KMZ overlay and late NetworkLink-response acceptance to the shared
journey. Current two-point Demo acceptance does not establish those behaviors.

## All KML documents in native Demo export (September 20, local)

Export project JSON now preserves each Demo KML Layer's bounded document, report,
NetworkLink receipts and source/normalized/curated metadata, using the same Layer
serializer as browser drafts. Session approvals/controllers/timers are not exported.
The built browser journey downloads through the Project menu, parses the file, passes
it through the client definition upgrader and compares both independently edited
source documents with the reopened browser draft. See
[kml-export-local-evidence.json](kml-export-local-evidence.json).

Acceptance also exposed catalog redraws replacing search controls during selection.
The browser catalog now retains its panel and search state across map/status renders;
registration changes invalidate the panel. The journey targets each requested row by
its exact Layer title. Its clock is fixed during the persistence journey to avoid
crossing the real daily-reset boundary; production expiry is unchanged.

The final built registration/export journey passes with 67 intercepted WMS fixture
requests and no provider/private API/AWS calls. Whitespace and foundations pass;
aggregate parity still fails historical evidence hashes. Intermediate reruns addressed
observed midnight expiry and search redraw failures; no live release was attempted.

The next integration is recorded in [KML persistence](kml-layer-persistence.md): managed
catalog identity/authorization, bounded per-occurrence schema and hydration, native
Project-file reopening, then KMZ overlays/late NetworkLink response acceptance. Current
native JSON preservation does not prove any of those or GeoLibre interchange.

## Native Demo Project reopening (September 20, local acceptance)

Project → Open project JSON now reads an exported Demo file without fetching sources
or writing storage, validates bounded/unique Layer identities and available data, then
shows a review dialog. Cancel preserves the current draft; the user can export it
before confirming replacement. Confirm writes the normalized draft under current Demo
expiry rules and reloads the workbench. Storage/validation errors leave it unchanged.

The reader limits files to 2 MB, 64 Layers and bounded JSON complexity. It normalizes
KML documents and rejects managed Style references, missing data, unavailable catalog
identities and unsupported sources. Local vector data is now included by native export
when browser storage policy allows it. KML preview features are reconstructed from the
saved document rather than requiring duplicate GeoJSON in the file. Legacy single-KML
exports adapt their top-level document/report/receipts into the Layer representation.
The restored Project's title/tree are retained; its banner no longer applies the
sample publication's title/license to a different composition.

The actual built browser journey exports two independently edited KML Layers, rejects
a duplicate-identity file without storage changes, cancels a valid review without
changes, confirms at 390px, reloads and checks both documents/metadata, the Project
banner and MapLibre rendered features from both Layers. See
[kml-native-open-local-evidence.json](kml-native-open-local-evidence.json). The focused
reader checks also pass. Whitespace/foundations pass; aggregate parity retains historical
hash failures. The final run intercepted 68 fixture WMS calls; no provider/private API/
AWS call or deployment occurred. Harness corrections used the real file-chooser event
and disambiguated the status text's compact/expanded copies; no unchanged build was
required for those harness corrections.

Next implement managed catalog identity/authorization and per-occurrence persistence
as specified in [KML persistence](kml-layer-persistence.md). Native Demo KML reopening
does not prove all-format portability, KMZ overlay acceptance, provider refresh or
managed registration of previously unknown sources in an imported Project.

## Worker KML source inspection prerequisite (September 20, local)

Managed source audit found no KML/KMZ upload format in the API/database pipeline.
The worker now has a bounded KML inspection branch and source filename/type handling,
ready for that integration. It accepts UTF-8 KML 2.2 up to 4 MiB, 20,000 elements and
32 levels; rejects entity declarations, unsupported encodings/namespaces and malformed
XML; records the original byte checksum and structural counts; and produces no derived
artifact. Source bytes remain unchanged. Geometry, extent, CRS and license remain
unknown; a null inspected license is not a finding that the source has no license.
NetworkLinks and image references are not fetched. The existing malware-scan wrapper
still applies; the tests use fixture scanner evidence, not a fresh live scanner receipt.

Seven focused KML checks and lint pass. The surrounding inspector regression passed
22 checks with one existing skip before the extra byte-limit case was added. Whitespace
and foundations pass; aggregate parity retains historical evidence-hash mismatches.
See [worker evidence](kml-worker-inspection-local-evidence.json). No application build,
AWS/provider call, migration or deployment was needed for this worker prerequisite.

Next wire raw-source preservation into the managed upload format contract, forward
DB enum migration and catalog registration; retain the existing object checksums,
authority checks and bounded metadata. Then connect review/registration and multi-Layer
map hydration/save/reopen with local API/database acceptance. Do not enable the Demo
import branch for managed Projects as a shortcut. KMZ archive validation remains a
separate missing part; this UTF-8 KML inspector does not establish KMZ or rendering
support, managed ingestion completion, standards conformance or full parity.

## Managed KML upload and activation contracts (September 20, local)

The direct-upload API accepts `.kml` with `application/vnd.google-earth.kml+xml`,
bounded by the smaller of the deployment quota and 4 MiB. Original filename, declared
size and SHA-256 remain on the existing signed-upload contract. KMZ is not enabled.
Forward migration 0128 adds KML to the dataset format enum without renaming tables or
changing prior values. Client dataset/upload-ticket parsing and exact-object download
MIME handling recognize KML; existing source and account authorization still apply.

Integration inspection found that worker completion requires at least one artifact.
The worker now emits a small derived JSON structure report (under 2 KiB in the fixture),
not a duplicate source or converted geometry. This supersedes the prior inspector's
zero-artifact result. The original KML and checksum remain authoritative; geometry,
extent and CRS remain unknown. The report is descriptive, not a rendering or license
conformance claim.

API/download checks pass (35), focused KML worker checks pass (7), client KML parsing
passes, and PGlite verifies both enum compatibility and worker-role activation. The
latter rejects a wrong worker token, retains the original object/checksum/content type,
activates a version with null geometry metadata, and returns already-completed on
replay. Object receipts and scanner evidence are synthetic; this is not full live S3
or HTTP-to-PostgreSQL acceptance. See [evidence](kml-managed-upload-local-evidence.json).
Lint, whitespace and foundations pass; aggregate parity retains historical hash failures.
No AWS/provider calls, application rebuild or deployment occurred.

Next connect managed source review and durable curated metadata, then deliberate
Project assignment with per-occurrence KML hydration/save/reopen. Keep failed-step
retry from duplicating an uploaded source. Run one local HTTP/API/database journey
through registration and reopening before enabling the managed UI. Deploy the API,
migration and compatible worker together; an older worker cannot process KML jobs.

## Managed KML registration session (September 22, local)

The interrupted registration work was inspected and completed as a client-side
prerequisite. `createManagedUploadSession` retains hashing/ticket/upload/completion
state. It shares concurrent calls, verifies an uncertain upload before another POST,
and reuses completion for later metadata retries. A lost initial ticket response stops
with `upload_ticket_unresolved`; it does not silently create another registration.
Backend idempotency/lookup and reload recovery remain necessary for that case.

`createManagedKmlRegistration` freezes the reviewed input, requires an owning-scope
guard, and uses the existing dataset knowledge API. Unknown licensing stays null on
the uploaded distribution. Source-asserted KML title and curator title stay separate;
credit text uses schema.org, and unestablished confidence is not invented. The original
source remains the uploaded version rather than being duplicated in the 49 KiB metadata
record. Read-before-retry recognizes an identical saved revision after a lost response;
a different existing revision is never overwritten automatically.

Focused checks cover metadata failure/lost response, uncertain upload, unresolved ticket,
concurrent attempts, account change and conflicting metadata. The actual API knowledge
validator accepts a document generated by the JS mapper. Existing managed-upload checks,
whitespace and foundations pass; aggregate parity retains historical hash failures.
See [session evidence](kml-registration-session-local-evidence.json). No build, deployment,
AWS/provider call or remote CI run was needed. This module is not yet connected to the
managed review UI and does not establish real persistence or authorization acceptance.

Next connect the owning managed review dialog and account/user guard, expose retained
source identity on partial failure, and exercise registration/metadata retry through the
local HTTP/API/database path. Complete initial-request recovery before claiming all retry
paths safe, then integrate Project assignment and per-occurrence hydration/save/reopen.

## Main-road mixed-detail local acceptance (September 22)

Reconciled stale roadmap state with retained artifacts: the mixed-detail candidate
already restores all 31,330 road records. Reused its native attribute and packed-tile
budget checks; ran the missing independent ten-segment geometry check and one built
Studio archive-selector journey. All fine records rendered alongside overzoomed
ordinary roads; source identity survived saving, and returning/reopening caused no
archive reads. Sixteen intercepted reads transferred 3,133,495 bytes, with no live
provider or AWS call. No build was repeated. A sandbox launch failure and successful
host receipt are retained separately. See [evidence](mainroad-mixed-detail-local-evidence.json).

This proves record coverage and the declared fine-segment geometry tolerance, not
complete multipart geometry or hosted latency. The source profile's 27 records with
collapsed components at zoom 14 remain an explicit display limitation. Foundations and whitespace pass; aggregate parity retains evidence-hash failures.
Next review the remaining collapsed multipart components before preparing
private preservation/admission; do not enable the
candidate from local tests alone. Hosted account acceptance remains outstanding.

## Main-road multipart correction (September 22, local)

Added a bounded source-component audit, reconciling all 54,812 components with the
retained profile. Seventeen components in 17 otherwise present records collapsed
at ordinary detail. Extended the mixed-detail builder's optional line recipe to
promote their whole records while moving retained overview fragments into the fine
layer. This preserves logical record counts without duplicate catalog identities
or a new runtime descriptor. Existing polygon and ten-short-line recipes remain
available. The candidate is 32,417,865 bytes and took 9.151 seconds to build.

Native review passes all 31,330 identities and exact attributes. The independent
geometry review covers 78 components in 27 promoted records with 9,711 endpoint
and midpoint samples. A separate overview comparison proves 284,241 fragments
unchanged across 4,207 tiles. Packed payloads pass reader limits. Browser acceptance
now targets the actual collapsed-component coordinates, rather than centering the
bounding box of a multipart record. Foundations and whitespace pass; aggregate
parity still fails historical evidence seals. No app build, AWS call or provider
request was needed. Preserve old receipts; candidate admission remains separate.

The corrected candidate subsequently passed the built browser journey at all 27
component locations: visibility/style reload, saved live identity and return/reopen
without archive reads. It used 36 intercepted reads and 4,515,369 bytes; no live
requests. See [the acceptance evidence](mainroad-components-local-evidence.json).
Next prepare the exact preservation/admission package, retaining both previous
candidates and their evidence. Hosted sign-in and catalog admission remain separate.

## Corrected main-road preservation preparation (September 22)

Extended mixed-line admission evidence for complete multipart sampling, exact
source/hash linkage, overview preservation and component-location browser checks.
Preservation now includes these sidecars, and eventual descriptors retain their
versioned evidence references. Mixed-detail packages consistently use the tested
external checksum index even for small files. The prior inline-index draft was
never executed and is superseded.

The 14-object plan and block index pass local byte/hash review; five focused
admission tests include rejected partial components, wrong source, sample count
and browser location. Compilation, foundations and whitespace pass; aggregate
parity retains checksum failures. No AWS calls, builds or remote CI. See
[preparation evidence](mainroad-preservation-preparation-evidence.json) for the exact
plan. Next verify live scope and deployed modules, preserve exact versions and
generate the actual admission descriptor. Do not invent object version receipts.

## Agricultural display continuation; road upload approval (September 22)

The exact main-road upload command was rejected before execution by automatic
approval review for insufficient trusted payload/destination authorization. An
explicit question is pending; no AWS calls occurred. Matched and reused the six
previously verified frontend module hashes without refreshing live evidence.
Independent work started the agricultural-land display from the hash-verified
1,068,854,575-byte original. Profiling confirms 92,514 unique spatial polygons.
The bounded local conversion remains on session 44769; poll that handle and inspect
its terminal receipt rather than relaunching. See
[progress](agricultural-display-progress-20260922.json). Native and browser reviews
remain pending.

## Agricultural exterior precision reviewed (September 22)

Generalized the existing 2016 polygon profiler to accept an explicit local candidate
directory, keeping its source hash/count checks, 300-second deadline, no-overwrite
guard and historical default. The agricultural audit covers 92,514 exteriors with
none collapsing at zooms 14, 20 or 22 (70.27 seconds locally). Compilation,
foundations and whitespace pass. No new build or external call was initiated in
this increment. Existing conversion session 44769 remains confirmed live; inspect
its terminal receipt before native verification. This is source-grid evidence,
not packed tile or filled-renderer acceptance. Road upload approval is still pending.

## Agricultural candidate accepted locally; Nepal bytes reconciled (September 22)

The retained agricultural conversion completed in 472.97 seconds without restart.
Native verification passes 92,514 identities and exact attributes; every packed
tile meets reader limits. Eight smallest polygon probes match source edges within
the declared quantization tolerance and render in the built Workbench. The browser
used 61 intercepted reads, 7,760,377 bytes and no external requests. The candidate
is 118,632,743 bytes. Fixed the producer to include the intended probe zoom, and
updated this retained probe list without rebuilding the archive. Compilation,
foundations and whitespace pass. See [evidence](agricultural-display-local-evidence.json).

Added an offline Nepal OSM reconciliation: source ETags/sizes match the retained
listing, and SHA-256 checks pass for 75 companions and 15 prepared GeoJSON displays.
Three larger groups remain outside this plan. Null S3 versions are not immutable;
no fresh cloud/catalog claim is made. A running registration receipt was observed;
do not duplicate its writes. No AWS or CI calls were used. Next connect agricultural
selector acceptance and preservation evidence before admission; road upload
remains pending explicit package/destination approval.

## Agricultural selector and admission guards (September 22, local)

Extended the existing archive-selector journey with a bounded polygon-directory
option; retained app assets and exact archive bytes were reused. All eight source
probes, storage consent, visibility/style reload, live identity on save and
return/reopen without reads pass (33 intercepted requests, 9,757,280 bytes).
Admission now requires these behaviors for larger ordinary polygon displays, with
matching geometry/native/budget receipts. Preservation uses the selector result
and retains its geometry sidecars and checksum index. Six focused tests reject
missing save/consent/reopen behavior, incomplete geometry probes and wrong hashes
or zoom. Compilation, foundations and whitespace pass. No cloud calls or builds.

Prepared and hash-checked the exact package; reused existing release evidence for
the five tested frontend modules without another network check. See
[evidence](agricultural-selector-preparation-evidence.json). Private preservation,
version-bound admission and hosted account acceptance remain separate. Road upload
authorization is still pending; do not bypass its automatic-review rejection.

## Contour profile and bounded build (September 22)

Added a hash-verified, five-minute offline contour profiler. All 212,944 records
were examined: nine null, 212,935 spatial, 244,914 parts and 23,472,238 vertices.
At zoom 14, 25 records wholly collapse and 37 have collapsed components; none do
at zoom 22. No elevation units were inferred. The source remains untouched.
A separate bounded ordinary-detail builder reuses this receipt, records its hash
and all required fine-record identities, and writes progress every ten seconds.
Session 1346 is active; no other contour conversion was started. Native/geometry
and renderer checks plus fine-detail correction are mandatory before admission.
See [progress](contour-display-progress-20260922.json). Compilation, foundations
and whitespace pass. No cloud or CI calls. Road upload approval remains pending.

## Contour fine-detail cost/precision decision (September 22)

Extracted complete source geometry and attributes for all 37 affected contour
records: 263 components, 330,207 vertices, 38 collapsed ordinary-detail components.
The unbuffered segment traversal estimate at zoom 22 is 1,449,744, so a bounded
native-encoder trial evaluated lower detail. Zoom 16 loses component 8197:3;
zoom 17 retains all 263 components in 21,894 tiles (2,664,830 encoded bytes).
Rejected evidence remains explicit. This does not establish full artifact equality
or actual rendering. The shared mixed-detail builder now supports a chosen line
zoom/title and demands matching source/component probe evidence below zoom 22.
Preservation retains and checks that optional receipt. Six admission checks and
syntax/compilation/foundations/whitespace pass. No cloud calls or duplicate full
build. Session 1346 remains the active ordinary-detail build; poll its existing
handle. See [progress](contour-display-progress-20260922.json).

The same ordinary-detail build subsequently finished successfully. Native content
review is now on session 1405 and packed-budget review on 42896. The progress file
records the final output size/hash and completed build time. Do not restart the
conversion or infer that the intermediate can be admitted before correction.
