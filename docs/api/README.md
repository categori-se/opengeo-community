# OpenGeo API contract

Inspect the current backend interface without a database, sign-in or hosted
deployment. [openapi.json](openapi.json) is generated from the maintained FastAPI
application; [examples.json](examples.json) contains synthetic request and response
examples validated against its Python models. These files describe the current
OpenGeo contract, including incomplete specification coverage.

From the repository root, using the API's [locked development environment](../../services/api/README.md#local-checks):

```bash
services/api/.venv/bin/python services/api/scripts/export_openapi.py --check
```

The check compares two fresh-process exports with the saved contract, validates
FastAPI's document model, local references, unique operation IDs and OpenAPI 3.1
component schemas, and validates all eight examples against real Pydantic models.
It does not run an independent full-document OpenAPI specification validator.
Regenerate without `--check` and review the schema diff with the source change.
Export blocks network/process calls and uses an empty environment; production
documentation exposure is unchanged. [Selected route-check evidence](evidence/route-checks.json)
records the exact reproduction command, assertions and cached environment. Those
checks use synthetic token verification, in-memory repositories and mocked input
resolution; they do not establish connected authentication, persistence, provider
access or cloud delivery.

## Authentication and scope

The operations below require `Authorization: Bearer <access-token>`. Production
verification accepts configured Cognito RS256 access tokens, then resolves the
subject and current memberships through the identity store. Select a membership
with `X-OpenGeo-Organization: <organization-uuid>` when needed. A sole membership
is selected automatically. With zero or multiple memberships, omitting the selector
returns `409 organization_scope_required` for these tenant-scoped operations.
The header cannot grant membership. Resource authorization and transaction-local
tenant scope still apply; metadata, geographic tags and Collections grant no access.

Project owners and editors can create/update maps and register sources. Project
owners, editors, reviewers and viewers can read maps. Source reads also support
dataset ownership or explicit dataset grants; source updates support ownership
or `manage`/`edit` grants. Classification changes have a separate authority check.
Publication input preparation requires `SITE_MANAGE` (project owner/editor), while
publication review requires `SITE_PUBLISH` (project owner/reviewer). Organization
administrators are allowed by the role matrix, with resource scope still checked.
See [authorization.py](../../services/api/src/opengeo_api/authorization.py) and the
repositories for the full decisions.

## Read and register a source

| Method and route | Behavior |
| --- | --- |
| `GET /projects/{project_id}/sources` | List readable references; `limit` defaults to 50 (1–100), `offset` to 0 (0–10,000). |
| `POST /projects/{project_id}/sources` | Register a supported reference; return `201 ExternalSourceResponse`. |
| `GET /projects/{project_id}/datasets/{dataset_id}/source` | Read one reference and server-computed capabilities. |
| `PATCH /projects/{project_id}/datasets/{dataset_id}/source` | Append a source revision or make one classification decision. |
| `GET /projects/{project_id}/datasets/{dataset_id}/source/revisions` | Read retained source revisions with the same pagination bounds. |

The `CreateExternalSourceRequest` example registers a public HTTPS XYZ template
under the default `internal` classification. Registration validates syntax; it
does not fetch tiles, copy data or prove provider availability. The example
response has `access_mode: direct_browser`, `credential_mode: none` and
`verification_state: syntax_only`. It is synthetic, not a live provider receipt.

Updates require `expected_version`, taken from the last read's `version_number`.
A source revision and a classification decision cannot be combined. Classification
decisions additionally require `expected_classification`; selecting `public`
requires `public_eligibility_reviewed: true`. These fields do not bypass authority
or rights checks. See [the route models](../../services/api/src/opengeo_api/external_source_routes.py).

## Save and reopen a map

| Method and route | Behavior |
| --- | --- |
| `POST /projects/{project_id}/maps` | Create a map; return `201 MapResponse` with persistent `id` and `version`. |
| `GET /projects/{project_id}/maps/{map_id}` | Reopen that exact map, including its saved definition. |
| `PATCH /projects/{project_id}/maps/{map_id}` | Save changed fields using `expected_version`; return the new version. |
| `GET /compositions/{composition_id}` | Read the same authored map identity with explicit `access_container_id`. |
| `GET /compositions/{composition_id}/versions/{version}` | Read an exact retained definition. |

The legacy `project_id` in map routes identifies the access container; it is not
the authored composition's identity. Retain the returned map `id` to reopen it.
Optional `creation_key` makes creation retryable for the same actor and unchanged
request; reusing it with changed content conflicts. For PATCH, pass the current
`version` as `expected_version` and at least one changed map field. An optional
`change_message` accompanies the revision. On conflict, read current state and
reconcile edits before retrying; do not blindly overwrite the newer definition.

The examples explicitly supply an `opengeo.map-definition.1.3.0` empty-map definition.
The runtime validates definitions, including their 256 KiB limit and source/layer
rules, beyond OpenAPI's generic object schema. See [map definitions](../../services/api/src/opengeo_api/map_definitions.py)
and [workspace routes](../../services/api/src/opengeo_api/workspace_routes.py).

## Prepare and review a native publication

These operations use an existing saved source project and exact source revision.
Set `base` to `/projects/{project_id}/source-projects/{source_project_id}`.

| Method and route | Behavior |
| --- | --- |
| `GET {base}/artifact-references` | Read the current Artifact selection and its revision. |
| `PUT {base}/artifact-references` | Replace the selection using `expected_revision`. |
| `POST {base}/revisions/{revision_id}/artifact-inputs` | Freeze a nonempty selection using `expected_reference_revision`; reuse an identical manifest. |
| `GET {base}/artifact-inputs/{input_id}` | Read exact retained pins and recheck their availability. |
| `GET {base}/publications` | Read authorized destinations, reviews and dispatch configuration. |
| `POST {base}/publications/reviews` | Review one successful build's exact output checksum and destination. |

Input preparation checks current permissions and resolves `current` Artifact
references once into exact versions. It does not compile or publish. A review
request supplies `review_id`, `build_job_id`, `mount_id` and
`result_checksum_sha256`; sources must have approved rights. Where required,
`distribution_approval_id` binds separately approved distribution inputs. Review
status retains output checksums, destination `expected_generation`, previous
release prefix and expiry. Approval rechecks the destination and review expiry.

Approval is a separate `POST {base}/publications/reviews/{review_id}/approve`
with `acknowledgment: publish-exact-previewed-output`. It can queue external
publication and is outside this offline reproduction. Without configured dispatch
it returns `503 framework_publication_dispatch_not_configured` before approval.
Build success and review alone do not publish. These native Framework routes are
distinct from the static site's `/projects/{project_id}/sites/{site_id}/review`.
See [native source routes](../../services/api/src/opengeo_api/observable_source_routes.py).

## Errors and specification limits

Implemented representative JSON responses include:

| Status | Body | Trigger |
| --- | --- | --- |
| 401 | `{"detail":"invalid_token"}` | Missing/invalid bearer token; includes `WWW-Authenticate`. |
| 403 | `{"detail":"organization_access_denied"}` | Organization selector is not a current membership. |
| 403 | `{"detail":"action_forbidden"}` | Map/source action denied. Native source actions use `observable_source_action_forbidden`. |
| 404 | `{"detail":"map_not_found"}` | Requested map is unavailable to the repository lookup. |
| 409 | `{"detail":{"code":"map_version_conflict","current_version":7}}` | Stale map version. Source conflicts use `external_source_version_conflict`. |
| 409 | `{"detail":{"code":"publication_artifact_revision_conflict","current_revision":2}}` | Artifact reference selection changed before preparation. |
| 503 | `{"detail":"external_source_store_unavailable"}` | Source backend unavailable; storage errors are sanitized. |

Request validation returns FastAPI's `422` detail list, including invalid UUIDs,
unknown request fields and model-validator failures. Runtime exception responses
above are not comprehensively declared in OpenAPI. Most routes advertise success
and validation responses only. The Artifact reference/input routes return
`dict[str, Any]`, so their response shapes are not fully specified. Map definitions
and source configuration responses are generic objects; Python validators and
repository checks impose additional bounds, URL rules, authorization and revision
semantics. The exported schema's bearer security scheme does not encode the role
matrix, transaction/RLS behavior, provider rights or all publication prerequisites.
Use route tests and source for these gaps; schema validation alone does not prove
a user journey, provider integration or standards conformance.

This default configuration omits the optional KML NetworkLink routes, which are
registered only when their fetch feature is enabled. Name-only map creation uses
a valid empty definition with `layers` and `measurements`. Explicit definitions
must also include `measurements`; the documented request supplies it.
[Request and route regressions](evidence/map-default.json) cover the name-only
request and confirm the regenerated contract remains unchanged.

## Changes and caller responsibilities

Preserve working routes, persistent identities and existing field semantics. New
operations, optional request fields with compatible defaults and additional
response fields are additive; callers should tolerate unknown response fields.
Removing/renaming fields or routes, adding mandatory input, changing types or
defaults, or changing custody and revision semantics is breaking. Explain such
changes and provide a compatibility/migration path; security fixes must preserve
access isolation. This policy does not introduce an API version prefix.

Every API change updates this generated contract and focused examples/tests in
the same review. Callers retain revision fields and exact resource pins, handle
conflicts explicitly and reauthorize through the API rather than treating cached
capabilities as a grant. Revisions may change independently of the caller's last
read; refresh and reconcile before another mutation.
