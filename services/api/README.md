# OpenGeo Studio API

The API connects Studio to persistent Catalog resources, Projects, processing
jobs and Publications. It verifies sign-in and current resource permissions,
then commits versioned changes and activity through PostgreSQL transactions.

Start with the [architecture and API entry points](../../docs/community-architecture.md#api-entry-points),
then [run the connected local environment](../../docs/community-development.md)
or follow the [AWS installation guide](../../docs/community-aws.md).
The interface notes below describe implementation boundaries and retained
acceptance history; they do not establish production acceptance of every route.

## Implemented API surface

This is the production API runtime foundation. The current surface includes:

- `GET /health/live` proves the process can serve requests and never depends on PostgreSQL.
- `GET /health/ready` proves PostgreSQL accepts `SELECT 1`; failures return a sanitized `503` body.
- `GET /auth/session` verifies a Cognito RS256 access token, resolves the subject to the application identity store, and returns its organization memberships.
- `GET /organizations/current` performs the first RLS-protected domain read using verified user and organization values local to one PostgreSQL transaction.
- organization/project membership reads plus client, project, and persistent-map REST operations described by the [workspace route modules](src/opengeo_api/workspace_routes.py) and their focused tests.
- map compare-and-swap updates, version history, duplication, and archive status, with every durable write and activity event committed in one transaction.
- project dataset list/read plus an exact signed S3 POST request→upload→verified completion flow that atomically creates object, logical version, queued job, and activity records without exposing storage coordinates in catalog responses.
- organization/project catalog search and filters, authorized logical-version history, per-user dataset grants, and exact immutable-object download tickets with server-computed capabilities and no exposed storage coordinates.
- governed anonymous XYZ/WMS/PMTiles catalog references with strict no-fetch URL and protocol validation, append-only source revisions, compare-and-swap updates, safe activity, and no processing-worker table authority.
- recoverable authoritative project imports that pin source hashes and plans, register governed references, bind only completed managed datasets, and finalize placeholder-free maps atomically under compare-and-swap.
- governed deterministic render profiles/jobs with authenticated OGC-shaped map discovery, bounded exact CRS84/EPSG:3857 SVG/PNG delivery, a one-layer resource WMS, and an explicitly published project WMS catalog with stable exact names such as `cite:Lakes`. Publication requires a published dataset/service and a governed default profile; names are case-fold reserved, withdrawal is irreversible, and project GetMap seals ordered composition of up to sixteen unique publications over the same activation-only work path. Compositions use top-layer-first shared label collision and one reserved consolidated legend. A separate opaque service identity can expose only active publications whose governed targets remain published/public. Its headerless one-to-sixteen-layer GetMap path is exact-prewarmed-cache-only, requires an exact ordered sealed composition, rechecks every public target, and has no dispatcher dependency; shared `auth.categori.se` remains required for every publication, prewarm, service creation, and disable action. The official Basic WMS ETS remains unrun. Ten fixed dataset-specific requests are source-inventoried, but the 49-template always-run request surface still needs capability-resolved successful-image materialization. The optional loopback diagnostic bridge can create a bounded credential-free checksum manifest for that purpose; it is not official test evidence, so no conformance claim is made.
- project-service coverage administration plus authenticated WCS 2.0.1 KVP discovery, rectified-grid description, and whole-coverage exact GeoTIFF retrieval. Publication accepts only a current active validated COG original and freezes its logical/storage/raster identity. Withdrawal is irreversible; stale heads fail closed; admin responses omit storage coordinates; and the exact download is authorized and target-checked before and after signing. Duplicate/unknown/oversized KVP and subset/scale/reprojection/range/alternate- format requests fail closed. Reads never dispatch processing. This bounded GDAL-verified lane makes no WCS conformance or full-product-parity claim.
- explicit immutable coverage derivatives under the project-service administration path. A bounded within-source subset, optional sorted one-based source bands, either target dimensions/`EPSG:` reprojection or source-CRS resolution, and nearest/bilinear/cubic resampling queue only from a shared- auth POST. A policy publishes pixel/sample and 64-retained/four-active quotas, queued-only cancellation, a 24-hour minimum reclamation age, and a 15-minute checksum-bound preview. A second shared-auth manager POST queues exact-version physical deletion through the activation-only worker while omitting bucket, key, ETag, and storage version from browser/API contracts. Queueing immediately makes the output unavailable; derivative/reclamation/activity history remains, and successful deletion releases one retained-job quota slot. Candidate-draft- shaped collection, coverage, domain-set, range-type, and schema GETs resolve only an exact source or already completed COG, never create work, and keep `conformsTo` empty. Exact downloads recheck authorization/source availability and target identity around signing.

Every HTTP response receives `X-Request-ID`. A caller-supplied value is retained only when it uses a bounded safe character set; otherwise the API generates a UUID. One JSON completion/failure event is written per request without query strings or database error text.

## Continuous integration

The [API contract and metadata workflow](../../.github/workflows/api-contract.yml)
checks changes to API source, tests, dependency locks and contract fixtures in
pushes and pull requests to `main`, and supports manual runs. One Python 3.14 job
installs the existing hash-locked dependencies, checks that the saved OpenAPI
contract matches two fresh exports, and runs focused workspace, exporter,
metadata adapter/profile and CKAN tests. Pip downloads are cached by both
lockfiles; the job records the resolved Python and dependency versions. It has
read-only repository permissions, cancels superseded runs for the same ref and
stops after 15 minutes.
The [selected hosted run](../../docs/api/evidence/api-ci.json) records the actual
installation, 89 passing checks and deterministic export for its source commit.

After installing the development lock, reproduce these checks from `services/api`:

```bash
.venv/bin/python scripts/export_openapi.py --check
.venv/bin/python -m pytest \
  tests/test_openapi_export.py \
  tests/test_workspace_routes.py \
  tests/test_metadata_adapters.py \
  tests/test_metadata_profiles.py \
  tests/test_ckan_export.py \
  tests/test_ckan.py \
  tests/test_ckan_routes.py
```

These checks use synthetic identities, repository/provider substitutes and local
fixtures. They require no AWS or provider credentials and do not establish
connected database, sign-in, cloud deployment or publication acceptance.

## Local Checks

Inspect the [current API contract](../../docs/api/README.md), including source
registration, map save/reopen and publication preparation/review examples. After
installing the locked development dependencies below, validate the saved contract
from the repository root with:

```bash
services/api/.venv/bin/python services/api/scripts/export_openapi.py --check
```

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes --requirement requirements-dev.lock
.venv/bin/ruff check src tests
.venv/bin/ruff format --check src tests
.venv/bin/mypy src
.venv/bin/pytest
```

`requirements.in` and `requirements-dev.in` are the maintainer-owned dependency inputs. Regenerate both complete locks intentionally from this directory:

```bash
python -m pip install pip-tools==7.6.0
pip-compile --generate-hashes --resolver=backtracking --strip-extras --output-file=requirements.lock requirements.in
pip-compile --generate-hashes --resolver=backtracking --strip-extras --output-file=requirements-dev.lock requirements-dev.in
```

Review the resulting version changes, then rerun the clean hash-locked install and all checks. Do not hand-edit transitive lock entries.

Start a development process with:

```bash
PYTHONPATH=src OPEN_GEO_EXPOSE_DOCS=true .venv/bin/python -m opengeo_api
```

Dev/test may start without PostgreSQL or Cognito so liveness remains useful; readiness and authentication will be unavailable. Staging and production fail configuration validation unless either `OPEN_GEO_DATABASE_URL` or all of `OPEN_GEO_DB_HOST`, `OPEN_GEO_DB_USER`, and `OPEN_GEO_DB_PASSWORD` are supplied, or the complete alternative `OPEN_GEO_DATA_API_REGION`, `OPEN_GEO_DATA_API_CLUSTER_ARN`, and `OPEN_GEO_DATA_API_SECRET_ARN` group is supplied. Direct and Data API database groups are mutually exclusive. Cognito still requires all of `OPEN_GEO_COGNITO_REGION`, `OPEN_GEO_COGNITO_USER_POOL_ID`, and `OPEN_GEO_COGNITO_CLIENT_ID`. An API that serves more than one reviewed browser shell may also set `OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS` to one to three unique, exact, comma-separated clients from that same pool. This is an allowlist, never a wildcard or an issuer override.

The default `IDLE-001` cloud path uses Data API. It signs bounded `BeginTransaction`, `Execute`, `Commit`, and `Rollback` calls without a general AWS SDK; translates positional SQL; restores UUID/JSON/time/array/blob result types; and sets tenant, statement-timeout, and UTC context inside the same transaction as the domain operation. The exact AWS `DatabaseResumingException` is retried within `OPEN_GEO_DATA_API_RESUME_TIMEOUT_SECONDS` (default 12, range 1–20); ambiguous errors and writes are not replayed.

The read-only account lookup has a separate `OPEN_GEO_PRINCIPAL_LOOKUP_TIMEOUT_SECONDS`
budget (default 20, range 1–20). Its transport and explicit database-resume waits share
that total deadline, allowing a paused database to wake without repeatedly hitting
the three-second readiness-probe timeout. Other operations keep their existing
budgets. A timed-out request is cancelled locally and is never automatically replayed
by the Data API client. Identity failures retain the safe underlying exception type
in operator logs; query text, response messages, credentials and subjects are excluded.
This does not bypass token verification or current account-membership resolution.

Map reads preserve the 256 KiB API contract while respecting the Data API's 64 KiB row limit: metadata and definitions are selected separately, definitions are returned as ordered 24,576-byte `bytea` chunks, and reconstruction validates strict UTF-8, indexes, chunk sizes, exact length, and JSON-object shape. List reads batch map ids within the aggregate-result bound. Live Aurora/PostGIS/RLS/ CAS, pause/resume, and billing checks remain required before production acceptance; local direct-PostgreSQL and composed Data API tests pass.

`Dockerfile.lambda` runs the same FastAPI application as a non-root ARM64 Lambda container through an API Gateway HTTP API payload-v2/ASGI adapter and bounded custom runtime. It preserves binary bodies and repeated cookies while bounding the invocation envelope, headers, cookies, decoded body, streamed response, and serialized handler response. `Dockerfile` remains the explicit transitional Uvicorn/Fargate image. The Gateway event contains a buffered request body and no live client-disconnect signal. The adapter therefore waits for response completion after body consumption; it does not treat an exhausted body as cancellation. Direct ASGI disconnect detection remains separate, and existing database deadlines bound Gateway preview work.

Managed upload configuration is one complete group: `OPEN_GEO_AWS_REGION`, `OPEN_GEO_GEODATA_BUCKET`, and `OPEN_GEO_GEODATA_KMS_KEY_ARN`. The optional `OPEN_GEO_UPLOAD_URL_TTL_SECONDS` defaults to 900 (range 60–3,600), and `OPEN_GEO_UPLOAD_MAX_BYTES` defaults to 536,870,912 (hard ceiling 5 GiB). `OPEN_GEO_DOWNLOAD_URL_TTL_SECONDS` defaults to 300 and is restricted to 60–900 seconds. Download URLs bind an exact S3 `versionId`; API IAM therefore needs `s3:GetObjectVersion` only on the managed original/derivative prefixes. Without the complete group, ingestion endpoints fail safely as unavailable.

Governed page-source and Observable source-project uploads additionally require `OPEN_GEO_APPLICATION_BUCKET`. They reuse the configured region, KMS key, and upload/download TTLs, but are restricted to private page-source objects and `organizations/*/projects/*/source-projects/*/uploads/*/files/*` objects. Each `document`, `story`, or `dashboard` save first creates a checksum- and size-bound browser POST intent and then atomically binds the verified S3 version to the new resource version. The generic resource-update path rejects page kinds so it cannot bypass the required exact source and change summary. The authenticated page-preview route reauthorizes the current page plus every exact map/dataset resource-version pin and media dataset/version/object identity. It returns a canonical content checksum, a bounded dependency list, and CSP-inert HTML from `opengeo-page-renderer-1.1.0`, the same typed block renderer used by public site delivery. Preview media contains no storage URL or bytes. Page-version saves repeat the dependency check, while publication rejects present pins that drift and records the renderer identity in the new edition manifest and HTML. For an authored page version, publication also copies its exact source ID/block, S3 version, ETag, media, length, SHA-256, dialect and compiler facts into the edition; migration `0042` verifies that copy against the immutable source row. This preview/source increment is locally verified and not yet deployed.

Page editors also have `GET`/`PUT`/`DELETE` private recovery routes at `/projects/{project}/resources/{resource}/page-draft`. A recovery revision is a complete valid editor document, including applied or unapplied Markdown, and is isolated by forced organization-plus-owner RLS. Changed saves require the exact governed base version and current draft revision; canonical checksums make an identical retry idempotent. Explicit discard is exact, and a successful governed page save deletes only the caller's matching-base journal in the same transaction. Failed commits retain it. Migration `0043` caps each immutable journal at 512 revisions, denies worker and direct runtime delete authority, and keeps drafts out of preview, publication, public reads, editions, and activity. This recovery increment is locally verified and not yet deployed.

Renderer 1.1 accepts portable structural headings, safe typed callouts, and same-document navigation. Headings are levels 2–4 with no skipped outline level; callouts use a closed tone set and at most 2,000 safe-Markdown characters; navigation resolves one to 12 distinct exact heading block IDs in document order. Preview and public HTML escape all labels/content, emit stable anchors and a named navigation landmark, and flow print retains semantic text. Migration `0044` defaults new source rows and new editions to renderer 1.1 while retaining immutable historical 1.0 source seals. This structural increment is locally verified and not yet deployed.

Multi-file Observable source projects additionally require `OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST`, which accepts only an exact lowercase `sha256:` digest. Migration `0045` binds one source project to one existing site, stores exact single-use upload/object facts, atomically appends sorted immutable source revisions, and stages build-job records with Observable Framework 1.13.4, npm lockfile-v3, deny-all networking, and fixed resource limits. The API and Studio can hash/upload/commit the source tree and stage preview jobs. Database coordination functions remain ungranted to the API runtime and existing GIS worker, and any future completion must prove a credential-free, zero-network, read-only, unprivileged sandbox plus bounded exact output facts. Build success has no publication side effect. This persistence increment is locally verified and not yet deployed. The separate `services/observable-builder` image now passes its local exact-input, repeatable Framework-build and no-network/read-only-root/non-root container checks, but it has no API or database authority. The `services/observable-coordinator` independently stages exact immutable inputs, runs that pinned image through the Podman isolation adapter, rechecks all outputs, and now includes bounded Data API/exact-version S3 production adapters plus an optional isolated zero-to-one host stack. When `OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL` is absent the API reports execution unconfigured and the explicit dispatch route returns `503` before database access. When it is present, job creation durably persists first and sends only the build UUID; dispatch failure preserves the pending job for an authorized retry at `/projects/{project}/observable-build-jobs/{job}/dispatch`. This is local synthesis only; the private-preview origin and runtime are not advertised or live until their separate operator gates pass.

The private-delivery contract is now locally implemented separately from execution. Migration `0046` supplies hash-only, one-time capability exchange; the API redacts storage coordinates from successful build evidence and issues only exact-path CloudFront cookies after current access is rechecked. When `OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN`, `OPEN_GEO_OBSERVABLE_PREVIEW_KEY_PAIR_ID`, and `OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN` are all configured, the API loads the exact JSON secret (`key_pair_id`, `private_key_pem`) from Secrets Manager with task-role SigV4 and caches the validated RSA key in process. A failed key load makes preview issuance unavailable before a capability can be consumed. The edge/migration/configuration remain non-deployed; this does not change the ungranted coordinator boundary.

The issuer and JWKS URL are derived from the Cognito region and pool id. Access tokens must use RS256, carry `token_use=access`, and name one exact configured app client in `client_id`. The verified session preserves the token's actual client id. JWKS responses are size-bounded, cached, fetched without redirects, and rate-limited for unknown key ids. `X-OpenGeo-Organization` never grants access; it selects only from the memberships returned for the verified subject by `app.resolve_principal`.

Tenant operations set `app.user_id`, `app.organization_id`, and `statement_timeout` with transaction-local PostgreSQL settings before executing domain role checks, queries, and writes. `OPEN_GEO_DATABASE_QUERY_TIMEOUT_SECONDS` defaults to 10 seconds and bounds both the server statement and the API wait.

External connection verification remains unavailable unless `OPEN_GEO_CONNECTION_VERIFICATION_QUEUE_URL` is an exact same-region SQS URL. When configured, project owners can request and cancel verification attempts; project readers can list sanitized status. The API persists through fixed repository functions and dispatches only the verification UUID to that queue. It never receives connection-secret read authority and never performs DNS, TLS, or PostgreSQL work. The isolated SQS handler entry point is `opengeo_api.connection_verification_runtime.handler`; it validates the stage/account/region-specific connector and connection secret identities before running the bounded verifier. CDK supplies the queue URL only under the explicit production advertise gate.

Secret values use Pydantic's `SecretStr` and are never placed in health responses. The transitional ECS service requires `OPEN_GEO_DB_SSLMODE=verify-full` and uses the official RDS global CA bundle installed in the image only after its SHA-256 checksum passes. A local `verify-full` connection must likewise set `OPEN_GEO_DB_SSLROOTCERT` to a trusted CA file whose hostname matches the server.

Both containers use a digest-pinned Python 3.13.15/Alpine 3.23 base and run as numeric uid/gid 10001. The ARM64 CI lane builds and smoke-tests the Lambda image, rejects Critical OS or Python findings with a checksum-pinned scanner, and uploads a validated CycloneDX SBOM.

Request-driven PDF/PNG print also pins `python-bidi==0.6.11` and `arabic-reshaper==3.0.1` for bounded natural implicit bidi ordering and common Arabic/Persian/Urdu contextual shaping. Production installs them only from the hash locks; they must remain visible in the image SBOM. They add no process or cloud resource. Author-supplied invisible bidi formatting is rejected, and this surface does not claim full UAX #9 or general complex-script conformance.
