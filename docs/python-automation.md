# Python and manifest automation

## Analysis console in a map

Open **View → Analysis console** or **Processing → Analysis console**. The
console docks below the map; **Ctrl+`** opens or closes it. Choose JavaScript,
Python or Bash, select the input Layers, and press **Run**. **Stop** cancels a
running script. Results stay separate until you select **Add result to map**;
that action creates a local derived Layer with execution and input provenance.
Original Layers and Catalog records remain intact. Download a script to keep it;
editor buffers currently last only for the open workspace.

Browser JavaScript runs in an isolated worker with networking disabled and a
10-second deadline. It receives `opengeo.layers`, `opengeo.emit(geojson)` and
`console.log`. Select at most 16 fully loaded vector Layers, with a combined
16 MiB input limit. Scripts cap at 64 KiB, logs at 128 KiB and GeoJSON results at
8 MiB. Browser memory has no hard heap limit. Tiled displays and live viewport
subsets are not console inputs.

The Local profile uses the existing loopback development environment. Supply
`--analysis-profile /absolute/path/profile.json` alongside `--development` and
`--state-directory`. The operator profile names the installed immutable Podman
image ID and interpreter for each available language, for example:

```json
{
  "profiles": {
    "python": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/usr/local/bin/python3"},
    "javascript": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/usr/local/bin/node"},
    "bash": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/bin/bash"}
  },
  "timeoutSeconds": 10,
  "memoryMiB": 256
}
```

Replace the image placeholders with reviewed local image IDs containing the
chosen interpreters and packages. Execution never pulls an image. The optional
timeout is 1–30 seconds and memory is 256 or 512 MiB. Each run uses a nonroot,
network-disabled container with read-only inputs, bounded temporary storage,
one CPU and 32 processes. Cancellation removes the exact container and staged
inputs; a cleanup failure prevents further execution until resolved. Launching
without the profile flag disables the retained opt-in configuration.

Python, Bash and local JavaScript read `/input/layers.json`, an array of
`{id, title, path}` records pointing to GeoJSON files. To return a Layer, print
one line beginning `OPEN_GEO_GEOJSON:` followed by compact GeoJSON. The Python
example in the editor demonstrates this protocol. Only successful, validated
results can be added to a map.

Both Local and Managed profiles are part of the intended workflow. Browser/local
execution is accepted locally. Managed source now provides authenticated private
jobs, pinned snapshots/results, source-access rechecks, cancellation and bounded
host lifecycle control. Explicit submission sends one identity-only queue message
and wakes the exact configured controller; opening a page or reading status does
not start compute. Failed dispatch retains the same frozen job for deliberate retry.
Analysis snapshots/results use application storage, separate from geodata intake.

Managed configuration defaults off. The request-driven API requires an existing
analysis-only queue, `OPEN_GEO_ANALYSIS_CONTROLLER_FUNCTION_ARN`, application storage
and `OPEN_GEO_ANALYSIS_RUNTIME_PROFILES` with all three immutable image profiles.
The deployment's explicit `OPEN_GEO_ANALYSIS_ENABLED` switch imports these admitted
identities; it does not create a host or controller. The controller's periodic
rule stays disabled between reserved windows. Existing private endpoints are a
separate shared operating cost; no zero-total-idle-cost claim is made.

Each host accepts at most four jobs. Startup waits retain the same queue receipt;
idle, job-limit and deadline exits close that window to further submissions before
the existing controller removes the host. A job admitted before an ordinary idle
close keeps the consumer active. Current native database checks verify profile
matching, the four-job window cap, ordinary close preserving a pending submission,
and signal close retiring the window and fencing the previous controller. Concurrent
transaction interleavings and the complete fresh-host consumer lifecycle remain open.

Actual local coordinator checks cover Python, JavaScript, Bash and cancellation;
native SQL checks cover the selected permission, lease and cleanup groups. The
current ASGI routes also pass 17 requests against the real principal and tenant
repositories and PostgreSQL roles, including idempotent submission, account/actor
privacy and cancellation after access revocation. Identity tokens, object storage
and dispatch are explicit local peers; the isolated database uses a fixture-only
loopback connection, which does not establish production TLS. No managed execution host was started.
The complete managed browser/API/execution workflow, concurrent transactions, an
admitted AMI, fresh-boot rootless execution, current image security and real AWS
cleanup remain open. The optional AMI package,
host verifier and installer are source prerequisites, not a verified baked host.
The console never runs user code inside the API or publication compiler.

## Existing API automation

`scripts/opengeo_client.py` is a dependency-free Python interface to existing
OpenGeo routes. Use it directly from Python or as a CLI. Layer identity, account
authority and analysis limits remain enforced by the server. This initial interface
reads Layer records and metadata, performs explicit analysis previews and saves
version-checked metadata with read-only recovery. It does
not upload, register a Layer, save a Project, publish or start background polling.

Supply an existing short-lived bearer token through `OPENGEO_ACCESS_TOKEN` for the
CLI or a token provider in your own Python process. The client does not log in,
refresh tokens, write credentials to disk or accept credentials in manifests.
Use your deployment's API base URL, including `/api` when its proxy requires it.
HTTPS is mandatory except for loopback development servers. Redirects are refused
rather than forwarding credentials to another destination. Responses are capped at
2,300,000 bytes; each request has a 15-second socket timeout (configurable in Python,
maximum 60 seconds). The timeout is not a whole-workflow deadline. No automatic
retry, pagination, provider discovery, paid processing or AI call occurs.

Read signed-in identity and organization memberships before choosing an account:

```sh
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" session
```

Python: `OpenGeoClient(api_url, None, token).session()`. This single `/auth/session`
read sends no organization header. It validates identity/membership fields and omits
unmapped response extensions. It does not sign in, select an account, grant access
or save credentials. Choose a returned organization explicitly for data commands;
those commands fail locally without that choice. With `--organization`, session
also checks the server's selected membership against the requested organization.

The existing local checker covers session bootstrap, credential-free output, scope
and invalid selection alongside preview/403/redirect/manifest checks in seven requests.
October 3 deployed acceptance now passes through genuine normal SRP sign-in: Python
and CLI agree on identity/account; bounded search, wrong-account403 and anonymous401
complete six GETs with zero writes. Prior direct-password/hosted-UI failures remain
recorded. The first authenticated read timed out at15s; one diagnosed retry with a
45s first-read deadline passed in3.576s. No cold-start cause or latency SLA is claimed.
The temporary official SDK/local session is removed; application credentials, grants
and client settings are unchanged. This acceptance helper does not add login to the
Python client. [Scoped evidence](../parity/reports/geolens-008-automation.json).


```sh
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" layer "$PROJECT_ID" "$DATASET_ID"
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" metadata "$DATASET_ID"
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" preview analysis.json > preview.geojson
```

A preview manifest (replace the UUIDs and generation with your selected records):

```json
{
  "schemaVersion": "opengeo.analysis-request.1",
  "projectId": "10000000-0000-4000-8000-000000000001",
  "datasetId": "10000000-0000-4000-8000-000000000002",
  "request": {"operation": "centroid", "source_generation": 1}
}
```

Manifests cap at 16 KiB and permit only declared fields. Use `buffer` with
`distance_meters`; `clip`, `intersection`, `join`, `join-summary` and
`select-by-location` require `target_dataset_id` and `target_generation`.
`measure`, `dissolve` and `centroid` require only source generation. Generations
are deliberately supplied, never silently refreshed after a conflict. Preview
responses must match input identities, generations, operation version, parameters,
CRS and the unpersisted flag. Metadata JSON is returned without normalization.
A preview file is not a registered catalog Layer; persistence remains a separate
workflow. Server operation limits are in [the analysis contract](vector-analysis-preview.md).

```python
# From a repository checkout (or put scripts/ on PYTHONPATH).
import os
from scripts.opengeo_client import OpenGeoClient

client = OpenGeoClient(os.environ["OPENGEO_API_URL"],
                       os.environ["OPENGEO_ORGANIZATION"],
                       os.environ["OPENGEO_ACCESS_TOKEN"])
knowledge = client.metadata(os.environ["DATASET_ID"])
```

Local acceptance: `python scripts/check-opengeo-client.py` exercises real loopback
HTTP requests, redirect refusal, safe error summaries and strict manifest rejection.
The separate six-request `--automation-client` mode of the existing PostgreSQL
runner also passes Python Layer/metadata reads, CLI preview, stale-generation 409
and revoked-access 404 against the production local API/runtime role. Token
verification in this local runner remains synthetic; separate deployed identity
acceptance is recorded above. Full SDK surface parity is not claimed.
Durable writes/recovery, Artifact reuse and pinned CLI/SDK round-trip
comparison remain tracked in `parity/reports/geolens-008-automation.json`.

## Deliberate metadata writes and recovery

`save-metadata` sends one version-checked PUT; it never retries. Start with a
`metadata` read, preserve the entire `document`, and make deliberate edits to that
document. Use its `version` as `expectedVersion`. Source documents, unknown values,
normalized/curated/inferred assertions and distribution terms are not flattened.
The API remains the authority for knowledge validation and edit permission.

```json
{
  "schemaVersion": "opengeo.metadata-write.1",
  "datasetId": "10000000-0000-4000-8000-000000000002",
  "expectedVersion": 0,
  "document": {
    "schemaVersion": "1.0.0",
    "distributions": [],
    "metadata": {"source": [], "normalized": [], "curated": [], "inferred": []},
    "context": []
  }
}
```

This empty example is only for a previously empty record. For existing records,
copy and edit the returned complete document so you do not erase knowledge.
Manifests cap at 64 KiB, with documents capped at the API's 49,152-byte limit.
Credentials remain outside the manifest.

```sh
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" save-metadata metadata-write.json
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" recover-metadata metadata-write.json
```

If a write response is missing or uncertain, run `recover-metadata` before another
write. It only reads immutable revision `expectedVersion + 1`, returning
`matching_revision`, `conflicting_revision` or `unconfirmed` (404). A matching
revision establishes that the intended content exists at that revision, not that
this invocation authored it or that it is still the latest revision. `unconfirmed`
does not distinguish absent data from denied access and never authorizes a retry.
Read the current record and resolve differences explicitly before a new write.
Python exposes the same `save_metadata(manifest)` and `recover_metadata(manifest)`
methods. Saving metadata creates no data copy, analysis job or publication build.

## Reuse an exact Artifact edition

```sh
python scripts/opengeo_client.py --base-url "$OPENGEO_API_URL" \
  --organization "$OPENGEO_ORGANIZATION" artifact "$PROJECT_ID" "$RESOURCE_ID" \
  --version 1 --representation portable-map-html > artifact.json
```

Python: `client.artifact(project_id, resource_id, version=1,
representation="portable-map-html")`. Representations are `saved-map-image`
(default) and `portable-map-html`. The Project argument is the existing API access
workspace; the returned manifest separately identifies the authored composition.
An explicit edition number is required. The client never silently follows a
changing current pointer, requests a build, signs a download or fetches output bytes.
The server rechecks resource and upstream authority and retained manifest integrity.
The client checks the returned edition and representation and preserves all manifest
pins and rights fields. A copied manifest does not grant access to its dependencies.

The local API check exercises `saved-map-image` with synthetic completed-output
metadata: Python and CLI agree, job count stays unchanged, and upstream revocation
blocks rereading. A separate portable fixture verifies exact Python/CLI manifests, unchanged job
count, and refusal after all fixture Project grants are removed. No image rendering
or output download is claimed; deployed identity is separately accepted above.

## Catalog search

`client.search_layers("roads", limit=25, offset=0)` calls the existing authorized
catalog endpoint once. CLI: `search "roads" --limit 25 --offset 0` with the same
base URL and organization arguments. Queries cap at 200 characters, pages at
100 records, and offset at 10,000. No automatic pagination, discovery/provider
request or registration occurs. Local production API acceptance verifies a named match, an empty filtered result
and exclusion after all fixture Project grants are removed.
