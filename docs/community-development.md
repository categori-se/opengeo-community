# Develop OpenGeo Studio on Linux

Run Studio, the API, PostgreSQL/PostGIS and the GIS worker on one Linux computer.
Development mode retains your work between runs and needs no AWS credentials.
For an installation with real identity and delivery services, see
[deployment choices](community-deployments.md) and the [AWS guide](community-aws.md).

## Prepare dependencies

Install Node.js `>=24.19.0 <25` with npm, Python 3.13, rootless Podman and system
Chromium at `/usr/bin/chromium`, `/usr/bin/chromium-browser` or
`/usr/bin/google-chrome`. Interactive development requires a graphical session
and a functioning Chromium sandbox. The initial dependency installation, image
builds and Studio build need Internet access.

From the repository root:

```bash
npm ci --prefix app
podman build --tag localhost/opengeo-community-api \
  --file services/api/Dockerfile services/api
podman build --tag localhost/opengeo-community-worker \
  --file services/worker/Dockerfile services/worker
podman pull docker.io/postgis/postgis@sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932
```

The worker includes GIS, malware-scanning and OCR tools, so allow time and disk
space for its first build. Reuse installed images when their inputs are unchanged.
Image redistribution requires the applicable security, license and SBOM review.

## Start Studio

Resolve the local tags to immutable image IDs, then choose a private state directory:

```bash
community_api_image="$(podman image inspect --format '{{.Id}}' localhost/opengeo-community-api)"
community_worker_image="$(podman image inspect --format '{{.Id}}' localhost/opengeo-community-worker)"
PYTHONDONTWRITEBYTECODE=1 python3 scripts/run-integrated-studio-local.py \
  --development \
  --state-directory .opengeo/community \
  --api-image "$community_api_image" \
  --worker-image "$community_worker_image"
```

Keep `--development` in the command to retain work. The default automated-check
mode is disposable.

The runner uses existing images; it never pulls or rebuilds them. Image arguments
accept immutable IDs or digest references. The first launch builds Studio in the
state directory; later launches reuse that verified staged frontend.

The managed Chromium window opens a development page with a link to Studio and
synthetic owner sign-in. Choose **Blank canvas**: requests to external basemap
providers are blocked.

**Keep this environment local.** Only `127.0.0.1` is served. API and database
containers have no external network or published host ports. Do not expose the
runner through a proxy, port-forwarder or shared computer account. Synthetic
identity and local file/queue transports are development substitutes; they do
not test Cognito, S3 encryption or AWS delivery.

## Save, stop and reopen

1. Create a Project and map through Studio's normal controls.
2. Add data. When an upload, conversion or image request queues work, return to
   the development page and choose **Process queued local jobs**, then refresh
   the result in Studio. This starts no paid processing.
3. Save the Project and reopen it to check the retained result.
4. Close every managed Chromium window to stop the environment. Run the same
   command with the same state directory to reopen your work.

Stopping retains the database's named volume, uploaded objects, queued jobs and
staged Studio. The state directory must have mode `0700`; symlinks, simultaneous
opens and changed database schema/image identities are rejected. A rejected
upgrade leaves the state intact. Use a reviewed upgrade to continue with that
data; a different state directory creates a separate database.

Dataset and source multipart uploads are limited to 1 MiB in this local profile.
Ordinary API JSON requests have a 512 KiB limit. Exact ticketed portable HTML
Artifact uploads have a separate 4 MiB allowance plus 64 KiB for multipart fields.
These local transport limits do not define hosted capacity.

## Change code and retain data

Add `--rebuild-studio` to the launch command after frontend changes. It replaces
the staged frontend while retaining the database and uploaded files. Rebuild the
API or worker image after its inputs change and pass its new immutable ID.

Use `--reuse-studio-tree SHA256` to select an existing sealed frontend, using the
digest in `studio-build-manifest.json`. This serves retained bytes; it does not
establish that they match newer source.

Never commit `.opengeo/`, database state, uploads, credentials, build outputs or
dependency directories. A copy of the state directory alone is **not a database
backup**. The database container name is recorded in `development-state.json`;
its named volume has the same name plus `-data`. Retain that volume and use
PostgreSQL dump and restore for a consistent backup. The
[local restore implementation](../scripts/integrated_studio_restore.py) describes
database and object copying; it is not an automatic backup service.

## Troubleshoot a local run

| Symptom | Check or recovery |
| --- | --- |
| An image is missing or a mutable tag is rejected | Build the maintained image, resolve its ID with `podman image inspect`, then pass that immutable ID. The runner does not install images. |
| Chromium cannot open | Check the installed executable, graphical session and browser sandbox. Interactive development requires a working sandbox. |
| A queued result has not appeared | Choose **Process queued local jobs** on the development page, then refresh Studio. Reuse the existing job rather than submitting it again. |
| The map background is empty | Choose **Blank canvas**. External provider requests are deliberately blocked. |
| An upload exceeds the local limit | Check the transport limits above. Large dataset uploads are outside this profile's accepted scope. |
| A state-directory or schema check fails | Keep the existing state and named volume. Check permissions and other running instances; review any required upgrade before changing identities. |
| Data is missing from a copied development directory | Restore the database as well as the object files. Copying the directory does not copy its named database volume. |

Podman's default OCI format omits Dockerfile health-check metadata. The
standalone server check reads the HTTP endpoint directly; liveness alone does
not establish database readiness or authentication.

## Optional local profiles

### Print from a retained map

After the maintained five-facility smoke has saved and reopened its map, add
`--print-smoke` to the development command. Use the same state directory, existing
API/worker IDs and exact `--reuse-studio-tree` digest. This profile requires the
retained synthetic map and stopped database; it does not create replacement data.

The check saves a main/inset layout through Print controls, reopens it, recaptures
both views and inspects an A4 SVG. Retain its receipts across interruptions. An
uncertain save needs readback, and an existing output can be inspected without
repeating the write. See [Print Studio](print-studio.md) for ordinary layout work.

### Inspect a local PostGIS source

Use a separate private state directory for the synthetic PostGIS fixture:

```bash
OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/run-integrated-studio-local.py \
  --development --postgis-fixture \
  --state-directory .opengeo/postgis-fixture \
  --api-image "$community_api_image" \
  --worker-image "$community_worker_image"
```

For interactive use, omit `OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE=1`. Open the fixture
workspace's **Services → External PostgreSQL / PostGIS**, load the connection,
inspect discovery and register the relation as a Catalog Layer. **Open map**
opens a temporary private view; choose **Use blank basemap**. It neither copies
the source into managed storage nor saves a Project.

The fixture contains 123 private synthetic records. Previews disclose their
100-feature ceiling, omitted matches and exact-number string encodings. One
discovery and two previews are permitted across restarts; counters and committed
registration are retained. Credentials, connection verification, DNS and TLS are
local substitutes. Omitting `--postgis-fixture` disables its transport next time.

### Develop native Publications

Build the maintained compiler and add its immutable ID to the development command:

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

The compiler uses its Dockerfile's pinned `NODE_IMAGE` and
`DISTROLESS_NODE_IMAGE` defaults. Its initial build needs Internet access; reuse
an unchanged installed image. Add `--publication-only` for the bounded two-edition
check through actual source and Publish controls.

For authoring, keep the first development page open:

1. In **Local publication destination**, connect an existing Project and a source
   owned by the local development owner. Copy their IDs from the selected source's
   API record or browser request inspector. One destination is retained per state;
   choosing another source does not replace it.
2. Save and build a revision in Studio. Choose **Process queued local jobs** on
   the development page, then open the completed private preview.
3. In Studio, prepare the publication review, acknowledge its output and approve
   the release. Process the approved job from the development page, then reload
   the review to open the published result.

Processing handles at most four publication jobs, one step of up to 64 files each.
A larger output stays queued; process it again deliberately to continue. Setting
a destination does not approve rights or publish a release.

Private preview and anonymous delivery use separate loopback ports. Anonymous
delivery reads only activated public objects. The `publication.local.invalid`
hostname uses a browser transport mapping; it does not configure public DNS,
HTTPS or CDN delivery. Portable map Artifacts retain their pinned editions and
use normal tenant permissions and leases. Selecting an edition does not compile
or publish it. Expired Artifact upload cleanup is unconfigured in this profile.
Without the compiler option, local publication is disabled.

## What local checks establish

The maintained workflow checks compiled Studio upload, ingestion, Catalog preview,
deliberate Layer addition, styling, save and rendered reopening after a database
restart. Local publication checks cover source revisions, private previews,
publication, earlier editions, viewer access and revocation. Expiry checks use a
qualified local verifier clock; issued cookies retain their 15-minute expiry.
See the [release record](../COMMUNITY-RELEASE.json) for exact results and limits.

These results reuse installed images, dependencies or sealed frontend bytes where
recorded. A fresh checkout or empty database is different from a fresh dependency
installation or a clean-machine installation by another operator.

For the separate fresh-installation check, open GitHub Actions → **Core workflows
and API contract** → **Run workflow**, then enable `fresh_installation` (off by
default). It requires Linux x64, rootless Podman with cgroup v2, `setfacl`, system
Chrome/Chromium and at least 12 GiB free disk. It starts with empty image and npm
download stores, builds the maintained images and invokes the same local runner.
It makes no AWS account calls, saves no caches and uploads no artifacts.

Source builds and selected local workflows have passing evidence; the complete
fresh connected/publication workflow and independent full-stack installation
remain separate acceptance work. Automated browser checks run without Chromium's
sandbox and do not establish the interactive sandboxed setup above. Synthetic
sign-in and local transports do not establish production identity, managed
storage/encryption, remote provider availability, HTTPS/CDN delivery or
operational recovery.

Use the [AWS guide](community-aws.md) for account-owned identity, encrypted storage,
queues, database initialization and sealed releases. Keep software licensing,
[source attribution](open-source-foundations.md) and dataset/provider rights
separate. For a contribution, follow [CONTRIBUTING.md](../CONTRIBUTING.md); for
installation help, use [SUPPORT.md](../SUPPORT.md).
