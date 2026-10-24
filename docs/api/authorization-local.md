# Check authorization with local PostGIS

The integrated pilot exercises the real FastAPI routes, authorization rules and
PostgreSQL transactions with disposable synthetic identities. The results below
describe the retained local scenario; they do not establish hosted authentication
or cloud delivery.

From the repository root, run:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/run-integrated-pilot-local.py
```

Podman and the exact cached image identities pinned by the runner must be
available. A fresh image build does not recreate those historical IDs.
The runner uses `--pull=never`, mounts current source into the cached
API and worker images, and creates a disposable network-isolated PostGIS
database. It prints a local result directory and removes its containers and
database volumes after execution. See the [development guide](../community-development.md)
for the maintained image build instructions.

The scenario creates a site through the API, invites a second identity as a
Project viewer, promotes that identity to editor, and then revokes its Project
and organization memberships. For `S = /projects/{project_id}/sites/{site_id}`,
the observed results were:

| Identity and current access | Request | HTTP result |
| --- | --- | --- |
| Owner, organization admin | `GET S` | `200` |
| Second identity, no organization membership | `GET S` | `403 organization_access_denied` |
| Project viewer, organization guest | `GET S` | `200`, same site and version |
| Project viewer | `PUT S` | `403 action_forbidden` |
| Project viewer | `POST S/publish` | `403 action_forbidden` |
| Owner | Promote viewer to editor through membership `PATCH` | `200` |
| Project editor | `PUT S` | `200`, version advances from 1 to 2 |
| Owner, using stale version 1 | `PUT S` | `409 site_version_conflict`, current version 2 |
| Project editor | `POST S/publish` | `403 action_forbidden` |
| Owner, after review | `POST S/publish` | `200`, local edition created |
| Owner | Revoke Project membership | `204`; next `GET S` returns `403 action_forbidden` |
| Owner | Revoke organization membership | `204`; next `GET S` returns `403 organization_access_denied` |

Each of the four rejected writes compares the complete owner-authorized site
response, edition list, completed render-job response and local queue before and
after the request. All four comparisons passed. Denied reads contain only the
`detail` field. The existing pilot also
withdraws the local edition and verifies anonymous HTML and ZIP reads return `404`.

Requests use in-process ASGI transport and the real `opengeo_runtime` database
role; token verification, identity provisioning, object storage and queue delivery
use local substitutes. The owner and collaborator are synthetic identities. The
containers use cached dependencies and run as container user `0`; database
operations use the restricted runtime role. This check covers local authorization
and persistence, with no Cognito sign-in, AWS acceptance or external publication.

Project membership revocation returns `403 action_forbidden` for this site route;
it should not be interpreted as a `404` response. Use the maintained development
guide for the current local Studio setup. This cached-image pilot does not verify
an independent installation.
