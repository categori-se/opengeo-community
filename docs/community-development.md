# Develop OpenGeo Studio on Linux

Run Studio, the API, PostgreSQL/PostGIS and the GIS worker locally. Development
mode keeps your work between runs; the default automated check mode is disposable.
This setup is for one local developer and does not require AWS credentials.

Local checks cover Project save and reopen after a database restart, selected
GIS processing and two native publication editions with private preview and
release reopening. Viewer access, revoked grants and expiry also pass within the
local security boundary described below.
These checks used cached images and synthetic sign-in. The October23 current-lock
clean-directory app installation now passes offline on supported Node 24.21.0:
443 packages, real core-js/esbuild lifecycle scripts, a native esbuild transform
and 20 PDF/font/geographic/notice cases. Each process has external networking
physically disabled. The corrected lock preserves Monaco's exact DOMPurify3.4.8,
Cesium's3.4.16 and a separate optional jsPDF3.4.17 dependency. Converter identities
and bytes match the accepted vector/geographic PDF proof, which is reused.

Earlier independent app installation also passed154 API-client cases and the
isolated public-source frontend build/artifact check. That build reuses Framework
package-version indexes and the CSV parser cache; application modules are generated
from its then-fresh installed graph. It does not verify every optional Framework
library, and the current lock-only correction does not claim another app build.
The maintained standalone API image also builds from current community source.
It includes the reviewed libuuid/SQLite fixes and reuses unchanged Python
dependencies when those OS packages change. Its real server starts as user 10001
on a read-only filesystem with networking disabled; `/health/live` returns HTTP
200 and package versions match. The test container is removed.
That liveness check does not establish database readiness or authentication.
Independent full-stack installation, production identity/delivery and large
uploads remain separate acceptance work.
See the [release record](../COMMUNITY-RELEASE.json) for detailed results.

A fresh public-source checkout and initially empty local database now also pass
Studio opening, Project/map creation and the [real Berkshire study's](../examples/berkshires-acecs/README.md)
Publication ZIP import. The actual Files editor saves draft revision 1 and reopens
all four files with unchanged hashes. Rights remain unreviewed; nothing is built
or published during this import check. It reuses cached dependencies, images and
a sealed frontend, with synthetic sign-in and local transports. This is fresh-state
acceptance by the same operator; a clean-machine installation by another operator
and configured production identity/HTTPS delivery remain open.

The [deployment guide](community-deployments.md) explains how local development,
the public site, hosted Studio and the anonymous demo relate.

Development mode opens a managed Chromium window with synthetic owner sign-in.
Only `127.0.0.1` is served. API and database containers have no external network or
published host ports. External browser requests are blocked, including basemap
providers; choose **Blank canvas**. Do not expose this mode through a proxy,
port-forwarder or shared computer account. Synthetic identity and local file/queue
transports are development substitutes, not Cognito, S3 encryption or AWS evidence.

## Prepare dependencies

Use Linux, Node.js `>=24.19.0 <25`/npm, Python 3.13, rootless Podman, and system Chromium at
`/usr/bin/chromium`, `/usr/bin/chromium-browser` or `/usr/bin/google-chrome`.
Interactive development requires a graphical session and a functioning Chromium
sandbox. Internet access is required to install dependencies, build the initial
images and populate the Observable cache during the first Studio build. This setup does not require AWS credentials or a provider account.

From the repository root:

```bash
npm ci --prefix app
podman build --tag localhost/opengeo-community-api \
  --file services/api/Dockerfile services/api
podman build --tag localhost/opengeo-community-worker \
  --file services/worker/Dockerfile services/worker
podman pull docker.io/postgis/postgis@sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932
```

Podman's default OCI format omits Dockerfile health-check metadata. The
standalone server check verifies the HTTP endpoint directly; automatic image
health checks are not part of that acceptance.

These are the existing maintained images and build commands. The worker includes
native GIS tools, malware signatures, OCR tools and their licenses, so its first
build is substantial. Image/SBOM/security review remains required before
redistributing binary images. This guide does not publish images or reuse another
release's security approval.

## Run and reopen

Resolve local tags to immutable image IDs and use a dedicated private directory:

```bash
community_api_image="$(podman image inspect --format '{{.Id}}' localhost/opengeo-community-api)"
community_worker_image="$(podman image inspect --format '{{.Id}}' localhost/opengeo-community-worker)"
PYTHONDONTWRITEBYTECODE=1 python3 scripts/run-integrated-studio-local.py \
  --development \
  --state-directory .opengeo/community \
  --api-image "$community_api_image" \
  --worker-image "$community_worker_image"
```

The runner requires these images to exist locally; it never pulls or rebuilds
containers. Image arguments accept immutable IDs or digest references, not mutable
tags. The first launch builds Studio through its existing builder in the selected
state directory. Later launches reuse that exact verified staged tree. A previous
sealed Studio tree can instead be selected with `--reuse-studio-tree SHA256`;
that serves its retained bytes and does not claim they match newer frontend source.

The first Chromium page explains the development boundary and links to Studio.
Create a Project and map through the normal controls. After an upload, conversion
or image request queues work, return to that first page and choose **Process queued
local jobs**, then refresh the result in Studio. No paid processing runs. The
synthetic upload transport has a 1 MiB multipart-body limit; larger source uploads
are outside this development mode's accepted scope.

Close every managed Chromium window to stop. The API and worker containers are
removed, and the database container is stopped. The named database volume,
uploaded objects, queued jobs and staged Studio remain. Run the same command with
the same state directory to reopen them. The private directory must have mode
`0700`; symlinks, simultaneous opens and changed database schema/image identities
are rejected. A schema rejection preserves the state and requires a reviewed
upgrade; selecting a new directory creates a separate database.

The maintained five-facility CC0 smoke has completed actual compiled UI upload,
ingest, Catalog preview without changing the Project, deliberate map addition,
styling, Save and rendered reopening. It also verifies the same saved version and
rendered features after stopping and restarting the database. This local evidence
uses synthetic identity and local transports; independent installation and
configured production identity/delivery remain separate acceptance work.

Use `--rebuild-studio` after changing frontend source. It replaces only the staged
frontend in that development directory and preserves the database and uploaded
files. Rebuild the maintained API/worker images after dependency changes and pass
their new immutable IDs. Never commit `.opengeo/`, database state, uploaded files,
credentials, build outputs or dependency directories.

The database container name is recorded in `development-state.json`; its named
volume is that name plus `-data`. A filesystem copy of the development directory
alone is **not** a database backup. Retain the named volume and use PostgreSQL dump
and restore procedures for a consistent database backup. The existing
[local restore implementation](../scripts/integrated_studio_restore.py)
shows how the integrated workflow handles database and object copies; it is not
an automatic backup service.

### Retained-map Print check

After the maintained five-facility smoke has saved and reopened its map, the same
runner can exercise Print with `--development --print-smoke`, the same private
`--state-directory`, cached API/worker image IDs and exact `--reuse-studio-tree`
digest from `studio-build-manifest.json`. It requires that retained synthetic
map and existing stopped database; it never creates or ingests replacement data.
Optional profile files are preserved while their runtimes remain inactive.

The check uses normal Print controls to save one main/inset layout, reopen it in
a fresh page, recapture both views and inspect one A4 SVG. Its cumulative receipts
bound API requests, captures, save/output attempts and active time. An uncertain
save requires exact readback, and an existing output is inspected from retained
bytes. Keep those receipts across interruptions; do not reset them to replay a
completed write. Local acceptance covers real API/SQL and actual map pixels with
synthetic identity/transport, not provider basemaps or independent human use.

Print frames can also be arranged directly on the paper with mm/inch rulers,
snapping and page-margin alignment. Arrow keys act within the canvas (one mm,
Shift ten, Alt0.1); focus the resize handle to resize instead. Escape cancels a
gesture and Ctrl/Cmd+Z undoes it. Display units and editor guides stay local;
geometry is saved in millimeters through the existing explicit layout save.

### Local PostGIS Layer fixture

Use `--postgis-fixture` with `--development` and a separate private state directory
to exercise the external-database interface without AWS or a provider account.
It supplies one synthetic verified connection and a private 123-row PostGIS table.
The normal tenant repositories, catalog discovery, preview processor and bounded
SQL reader run against the local database. Credentials, connection verification,
name resolution and TLS transport are explicit local substitutes. Production
discovery/preview settings stay disabled unless configured independently.
This fixture permits one discovery and two feature previews across restarts;
its counters and committed registration are retained rather than reset on retry.

Open the fixture workspace's **Services → External PostgreSQL / PostGIS**, load
the connection, inspect its discovery and register the selected relation as a
Catalog Layer. **Open Catalog Layer → Open map** opens a temporary private view;
choose **Use blank basemap** while external browser requests are blocked. The
preview reports the 100-feature ceiling, omitted matches and exact-number string
encodings. It does not copy the source into managed storage or save a Project.

The existing development smoke can exercise this fixture headlessly:

```bash
OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/run-integrated-studio-local.py \
  --development --postgis-fixture \
  --state-directory .opengeo/postgis-fixture \
  --api-image "$community_api_image" \
  --worker-image "$community_worker_image"
```

Use `--reuse-studio-tree SHA256` to select an existing sealed frontend instead of
building the initial tree. As with ordinary development, closing the browser
stops compute and retains the database and its named volume. Omitting the fixture
option disables its local transport on the next launch. This profile does not
establish configured provider, DNS/TLS, AWS, deployment or independent installation
acceptance.

The maintained compiled browser check passes owner/viewer rendering of 100 out of
123 records, exact large-number strings, truncation disclosure and denial after
project-grant removal through the authenticated API. It creates one Catalog Layer
and no managed source version, object, processing job or saved map. The accepted
continuation reuses the already committed discovery and Layer after a locator
failure. This remains local fixture evidence with the substitutions above.

### Optional fresh installation check

In GitHub Actions, open **Core workflows and API contract**, choose **Run
workflow**, and enable `fresh_installation`. This manual input defaults to
`false`. It uses the existing two jobs on Ubuntu 24.04: the frontend job has a
28-minute ceiling and the API job has 10 minutes, at most 38 summed job minutes.
Ordinary validation retains its existing 8/15-minute limits.
Image preparation, compiled Studio save/reopen and native publication stages have
12-, 6- and 5-minute limits respectively.

Preflight requires Linux x64, rootless Podman with cgroup v2, `setfacl`, an installed system
Chrome/Chromium executable and at least 12 GiB free disk. The run starts isolated,
empty Podman image and npm download stores, builds the maintained public source
images and invokes the canonical local runner. It makes no AWS account calls,
saves no caches and uploads no artifacts.

The image stage builds the API, broad GIS worker, dedicated PMTiles converter and
publication compiler using their maintained Dockerfiles. The built-Studio check
passes the dedicated converter's exact ID through `--pmtiles-worker-image`.
That fresh-state option binds a separate file queue and pristine runtime control
through real admission/completion SQL; it does not activate a retained development
database or hosted converter. The full GIS worker remains responsible for PNGs.
Receipts record image and host architectures separately, so emulated local checks
cannot establish native architecture or production controller acceptance.

The [latest public fresh run](https://github.com/categori-se/opengeo-community/actions/runs/39107327665)
at `92124cfd` passes the owned, empty image-store preflight, pinned PostGIS
preparation, all three maintained source builds and API checks. Compiled Studio
opens and exercises invitations and access restrictions, then an outdated test
disclosure stops navigation to Data access. Native publication is skipped; isolated
cleanup passes. The fixture now follows the current Data access and Basemap
navigation, visible layer controls and PMTiles labels. Current local acceptance
covers authorization/lifecycle, uploads, styling, exact saved-map reopening,
dedicated PMTiles v2 conversion, PNG rendering and both dataset publications.
The next map-resource check now expects reuse of the existing governed identity
and explicit selection of its saved revision. Its corrected full publication,
export and revocation tail, and fresh connected/native acceptance, remain open.

The pinned database pull precedes source builds and uses `--retry=0` only when
pull help advertises that exact option. Legacy Podman may make three internal
transient copy retries, at most four copy attempts, under the same 12-minute
stage limit with no outer retry.

These checks use synthetic local identity and local object/queue transports. The
existing automated browser runs without Chromium's sandbox; source-build success
does not establish sandboxed-browser, configured AWS/Cognito, HTTPS/CDN or
independent operator acceptance.

## Native publication development

The same development runner connects saved source to native compilation,
private preview and local publication. From the repository root, build the
maintained compiler image and resolve its immutable ID:

```bash
podman build --tag localhost/opengeo-community-compiler \
  --file services/observable-builder/Dockerfile services/observable-builder
community_compiler_image="$(podman image inspect --format '{{.Id}}' localhost/opengeo-community-compiler)"
PYTHONDONTWRITEBYTECODE=1 python3 scripts/run-integrated-studio-local.py \
  --development \
  --state-directory .opengeo/community \
  --api-image "$community_api_image" \
  --worker-image "$community_worker_image" \
  --publication-compiler-digest "$community_compiler_image"
```

This uses the API and worker IDs resolved above and the compiler Dockerfile's
pinned `NODE_IMAGE` and `DISTROLESS_NODE_IMAGE` defaults. The compiler build needs
Internet access to install dependencies and prepare its Framework cache. If you
already retain the compiler image locally, reuse its exact `sha256:` image ID
instead of rebuilding. The runner never pulls or rebuilds images and uses no
cloud service. Add `--publication-only` to run the bounded two-edition check
through the actual source and Publish controls. Keep the same private state
directory to retain source, jobs, output and release history.

For ordinary authoring, keep the initial development page open. Its **Local
publication destination** form connects an existing Project and source project
to `publication.local.invalid`. Copy the IDs from the selected source's API record
or the browser's request inspector. The source must belong to the local development
owner. One retained destination is supported per development state; selecting a
different source fails without replacing it.

Save and build a revision in Studio, then choose **Process queued local jobs** on
the development page. Open the completed private preview in Studio. To publish,
prepare the publication review, acknowledge its output and approve the release in
Studio; return to the development page to process that approved job. Reload the
review to open the published result. Processing handles at most four publication
jobs, one canonical step of at most 64 files each. A larger output stays queued;
process again deliberately to continue. Destination setup never approves rights
or publishes a release. The local hostname uses the existing browser transport
mapping; this does not configure public DNS, HTTPS or cloud delivery.

The compiler profile also enables retaining portable map Artifacts and using pinned
editions in native private previews. The local coordinator resolves each Artifact
through the normal live lease and tenant permissions, using the retained local
object versions. Uploading or selecting an edition does not compile or publish it.
Only exact, ticketed portable HTML uploads receive the 4 MiB file allowance plus
64 KiB for multipart fields. Dataset and source multipart uploads remain limited
to 1 MiB; ordinary API requests retain the 512 KiB JSON boundary. Expired Artifact
upload cleanup is unconfigured in this local profile and never selects AWS storage.

Preview and anonymous delivery run on separate loopback ports. The anonymous
server reads only activated, separately retained public objects. It batches up to
32 asset reads per process, with at most four active processes and 64 outstanding
assets; each batch retains canonical file and checksum checks under the activation
lock and a 50 MB aggregate limit. Failed individual reads leave valid siblings
available. The retained Berkshire study passes anonymous map and calculated-table
rendering without another build or publication. The local canonical hostname uses
an explicit browser transport mapping; it does not establish DNS, TLS or CDN delivery. Ordinary startup without the compiler option
leaves this profile disabled. The accepted local CC0 study demonstrates two
revisions, private previews, publication and reopening earlier editions. Viewer
opening, revoked grants and real capability expiry also pass. Signed-cookie
expiry uses a qualified local verifier clock; issued cookies remain valid until
their 15-minute expiry. The current compiler Dockerfile also builds with its pinned
defaults and passes its existing credential-free compilation fixture. No source
overlay or publication replay is used. Independent full-stack installation and
production identity/delivery remain separate acceptance work.

## Release limits

The local workflow provides actual application authorization and persistent
PostGIS records with synthetic identities. It does not establish real sign-in,
production tenant administration, managed storage/encryption, remote provider
availability, hosted publication delivery or operational recovery. The existing
[integrated runner](../scripts/run-integrated-studio-local.py) and
[focused checks](../scripts/test_integrated_local.py) retain the development and
automated acceptance modes in one maintained path.

Use the [AWS deployment guide](community-aws.md) for account-owned Cognito,
encrypted storage, queues, database initialization, infrastructure deployment and
sealed Studio releases. That guide records standalone AWS acceptance and the
remaining native publication deployment increment. The
[community roadmap](../ROADMAP.md) sequences feature work by public benefit.

Preserve the [foundation register](../governance/open-source-foundations.json),
[license and attribution guidance](open-source-foundations.md), upstream license
and NOTICE files, and [reference acknowledgements](../ACKNOWLEDGEMENTS.md).
Software availability does not grant rights to any example dataset or provider
service. Original-source terms and distribution-specific rights remain separate.
