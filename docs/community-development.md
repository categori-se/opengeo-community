# Develop OpenGeo Studio on Linux

Run Studio, the API, PostgreSQL/PostGIS and the GIS worker locally. Development
mode keeps your work between runs; the default automated check mode is disposable.
This setup is for one local developer and does not require AWS credentials.

Local checks cover Project save and reopen after a database restart, selected
GIS processing and static publication. They used installed dependencies, cached
images and synthetic sign-in. Fresh dependency and image builds, large uploads
and the complete native publishing workflow still need verification. See the
[release record](../COMMUNITY-RELEASE.json) for detailed results.

The [deployment guide](community-deployments.md) explains how local development,
the public site, hosted Studio and the anonymous demo relate.

Development mode opens a managed Chromium window with synthetic owner sign-in.
Only `127.0.0.1` is served. API and database containers have no external network or
published host ports. External browser requests are blocked, including basemap
providers; choose **Blank canvas**. Do not expose this mode through a proxy,
port-forwarder or shared computer account. Synthetic identity and local file/queue
transports are development substitutes, not Cognito, S3 encryption or AWS evidence.

## Prepare dependencies

Use Linux, Node.js 24/npm, Python 3.13, rootless Podman, and system Chromium at
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

These are the existing maintained images and build commands. The worker includes
native GIS tools, malware signatures, OCR tools and their licenses, so its first
build is substantial. Image/SBOM/security review remains required before
redistributing binary images. This guide does not publish images or reuse another
release's security approval.

## Run and reopen

Resolve local tags to immutable image IDs and use a dedicated private directory:

```bash
community_api_image="$(podman image inspect --format '{{.ID}}' localhost/opengeo-community-api)"
community_worker_image="$(podman image inspect --format '{{.ID}}' localhost/opengeo-community-worker)"
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

## Browser save and reopen check

With the images resolved above, run this command twice from the repository
root. Choose a new state directory for the complete journey; an existing completed
check reopens its saved map.

```bash
OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/run-integrated-studio-local.py --development \
  --state-directory .opengeo/browser-persistence-check \
  --api-image "$community_api_image" --worker-image "$community_worker_image"
```

The first run builds Studio, creates a Project and map, uploads the fictional
[CC0 facilities fixture](community-examples.md), processes its queued job, adds the
layer, selects Blank canvas, changes the point color and opacity, and clicks Save.
The runner stops the database when Chromium closes. The second run starts the same
database and reopens the same map in a fresh browser context. It checks the saved
revision, layer and source identities, all five feature properties and coordinates,
rendered feature names, and the retained color and opacity. Both runs are bounded
to 100 API requests each.

The state directory retains `task3-saved.json`, `task3-reopened.json` and matching
screenshots, plus the exact saved API response in `development-smoke.json`.
This headless check uses synthetic sign-in and local object/queue transports;
Chromium runs without its browser sandbox. It makes no external provider requests.
The [selected local evidence](api/evidence/task-3.json) records the verified run,
including one failed selector check, recovery of its committed records, and the
same database container and volume before and after reopening.

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
