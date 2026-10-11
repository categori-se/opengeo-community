"""GitHub boundary for Studio's on-demand publication controller.

These adapters do not grant Studio permissions: callers must authorize the tenant,
project, source revision and connection before use. Author source is stored on a
revision-specific ref, never merged into the trusted workflow branch. No project
code runs in this process and no GitHub response body is included in an error.
"""

import base64
import hashlib
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

import jwt

SHA = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SOURCE_PATH = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$"
)
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 64 * 1024 * 1024
FORBIDDEN_SOURCE = re.compile(
    r"(^|/)(node_modules|dist|build|cache)(/|$)|"
    r"(^|/)(credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|"
    r"id_rsa|[^/]+\.(?:pem|key|p12|pfx))$",
    re.IGNORECASE,
)


class GitHubPublicationError(RuntimeError):
    def __init__(self, code: str, *, status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class GitHubTransport(Protocol):
    def request(
        self, method: str, path: str, token: str, body: Mapping[str, Any] | None = None
    ) -> dict[str, Any]: ...


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: Any, msg: Any, headers: Any, newurl: Any
    ) -> None:
        return None


class GitHubHttpTransport:
    """Fixed GitHub origin, no redirects, bounded reads; never log bearer tokens."""

    def request(
        self, method: str, path: str, token: str, body: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        if (
            not path.startswith("/")
            or path.startswith("//")
            or any(char in path for char in "\r\n#")
        ):
            raise GitHubPublicationError("github_path_invalid")
        request = Request(
            "https://api.github.com" + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2026-03-10",
                "User-Agent": "OpenGeo-Studio-Publications",
            },
        )
        try:
            with build_opener(NoRedirect()).open(request, timeout=15) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            raise GitHubPublicationError("github_http_error", status=error.code) from None
        except (URLError, TimeoutError, OSError):
            # The write may already have succeeded. The controller must reconcile
            # its persisted operation identity, not assume that nothing happened.
            raise GitHubPublicationError("github_observation_unavailable") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise GitHubPublicationError("github_response_too_large")
        try:
            value = json.loads(raw) if raw else {}
        except (ValueError, UnicodeError):
            raise GitHubPublicationError("github_response_invalid") from None
        if not isinstance(value, dict):
            raise GitHubPublicationError("github_response_invalid")
        return value


@dataclass(frozen=True)
class GitHubConnection:
    installation_id: int
    repository_id: int
    repository: str

    def __post_init__(self) -> None:
        if (
            type(self.installation_id) is not int
            or self.installation_id <= 0
            or type(self.repository_id) is not int
            or self.repository_id <= 0
            or not REPOSITORY.fullmatch(self.repository)
            or any(part in {".", ".."} for part in self.repository.split("/"))
        ):
            raise GitHubPublicationError("github_connection_invalid")


class GitHubInstallationTokens:
    """Mint a short-lived token narrowed to one verified repository and operation."""

    def __init__(
        self,
        app_id: int,
        private_key: bytes,
        transport: GitHubTransport,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if type(app_id) is not int or app_id <= 0:
            raise GitHubPublicationError("github_app_invalid")
        self.app_id = app_id
        self.private_key = private_key
        self.transport = transport
        self.now = now

    def issue(self, connection: GitHubConnection, *, write_source: bool) -> str:
        epoch = int(self.now().timestamp())
        assertion = jwt.encode(
            {"iat": epoch - 30, "exp": epoch + 540, "iss": str(self.app_id)},
            self.private_key,
            algorithm="RS256",
        )
        permissions = (
            {"contents": "write"} if write_source else {"contents": "read", "actions": "write"}
        )
        result = self.transport.request(
            "POST",
            f"/app/installations/{connection.installation_id}/access_tokens",
            assertion,
            {"repository_ids": [connection.repository_id], "permissions": permissions},
        )
        token = result.get("token")
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise GitHubPublicationError("github_token_invalid")
        return token


@dataclass(frozen=True)
class GitHubSourceReceipt:
    repository_id: int
    source_project_id: UUID
    revision_id: UUID
    commit_sha: str
    tree_sha: str
    ref: str
    manifest_sha256: str


@dataclass(frozen=True)
class GitHubBuildRun:
    run_id: int
    attempt: int
    status: str
    conclusion: str | None
    url: str


def _sha(value: Any) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise GitHubPublicationError("github_object_invalid")
    return value


def _blob_sha(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


class GitHubPublicationRepository:
    def __init__(
        self,
        connection: GitHubConnection,
        token: str,
        transport: GitHubTransport | None = None,
    ) -> None:
        self.connection = connection
        self.token = token
        self.transport = transport or GitHubHttpTransport()
        self.prefix = f"/repos/{connection.repository}"

    def _call(
        self, method: str, path: str, body: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return self.transport.request(method, self.prefix + path, self.token, body)

    def verify_repository(self, *, require_private: bool = True) -> None:
        result = self._call("GET", "")
        if (
            result.get("id") != self.connection.repository_id
            or result.get("full_name", "").lower() != self.connection.repository.lower()
            or (require_private and result.get("private") is not True)
            or result.get("archived") is not False
            or result.get("disabled") is not False
        ):
            raise GitHubPublicationError("github_repository_not_authorized")

    def verify_private_repository(self) -> None:
        self.verify_repository()

    def mirror_revision(
        self,
        *,
        source_project_id: UUID,
        revision_id: UUID,
        created_at: datetime,
        files: Mapping[str, bytes],
    ) -> GitHubSourceReceipt:
        """Append one immutable source snapshot; replay verifies before returning.

        Never PATCH refs, overwrite a branch, or copy project-authored workflows.
        The caller persists this receipt with the authorized Studio revision.
        """
        if not isinstance(source_project_id, UUID) or not isinstance(revision_id, UUID):
            raise GitHubPublicationError("github_revision_invalid")
        if created_at.tzinfo is None or not 1 <= len(files) <= 128:
            raise GitHubPublicationError("github_source_invalid")
        paths = sorted(files)
        for index, path in enumerate(paths):
            if (
                not SOURCE_PATH.fullmatch(path)
                or len(path) > 512
                or FORBIDDEN_SOURCE.search(path) is not None
                or any(part.endswith(".") for part in path.split("/"))
                or not isinstance(files[path], bytes)
                or not 1 <= len(files[path]) <= 4_194_304
                or any(
                    path.casefold() == other.casefold()
                    or other.casefold().startswith(path.casefold() + "/")
                    or path.casefold().startswith(other.casefold() + "/")
                    for other in paths[index + 1 :]
                )
            ):
                raise GitHubPublicationError("github_source_invalid")
        if sum(len(content) for content in files.values()) > MAX_SOURCE_BYTES:
            raise GitHubPublicationError("github_source_too_large")
        manifest = json.dumps(
            {
                "schema": "opengeo.github-source.1.0.0",
                "source_project_id": str(source_project_id),
                "revision_id": str(revision_id),
                "created_at": created_at.astimezone(UTC).isoformat(),
                "files": [
                    {
                        "path": path,
                        "size_bytes": len(files[path]),
                        "sha256": hashlib.sha256(files[path]).hexdigest(),
                    }
                    for path in paths
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        contents = {**files, ".opengeo/source-revision.json": manifest}
        expected = {path: _blob_sha(content) for path, content in contents.items()}
        ref = f"heads/studio/sources/{source_project_id}/revisions/{revision_id}"
        self.verify_private_repository()
        existing = self._read_ref(ref)
        if existing is not None:
            commit = existing
        else:
            entries = []
            for path, content in sorted(contents.items()):
                blob = self._call(
                    "POST",
                    "/git/blobs",
                    {
                        "content": base64.b64encode(content).decode(),
                        "encoding": "base64",
                    },
                )
                if _sha(blob.get("sha")) != expected[path]:
                    raise GitHubPublicationError("github_blob_mismatch")
                entries.append(
                    {"path": path, "mode": "100644", "type": "blob", "sha": expected[path]}
                )
            tree = _sha(self._call("POST", "/git/trees", {"tree": entries}).get("sha"))
            identity = {
                "name": "OpenGeo Studio",
                "email": "studio@opengeo.tools",
                "date": created_at.astimezone(UTC).isoformat(),
            }
            commit = _sha(
                self._call(
                    "POST",
                    "/git/commits",
                    {
                        "message": f"Studio source revision {revision_id}",
                        "tree": tree,
                        "parents": [],
                        "author": identity,
                        "committer": identity,
                    },
                ).get("sha")
            )
            self._verify_commit(commit, expected)
            # A timeout is ambiguous, while 422 may mean another retry won. Both
            # are reconciled by reading this exact ref; no force-update is allowed.
            try:
                self._call("POST", "/git/refs", {"ref": "refs/" + ref, "sha": commit})
            except GitHubPublicationError as error:
                if (
                    error.status not in {409, 422}
                    and error.code != "github_observation_unavailable"
                ):
                    raise
                observed = self._read_ref(ref)
                if observed is None:
                    raise error
                commit = observed
        tree = self._verify_commit(commit, expected)
        # Confirm the bookmark still refers to the verified commit. Builds use
        # commit_sha, never a movable ref or a caller-supplied branch checkout.
        if self._read_ref(ref) != commit:
            raise GitHubPublicationError("github_revision_ref_changed")
        return GitHubSourceReceipt(
            self.connection.repository_id,
            source_project_id,
            revision_id,
            commit,
            tree,
            ref,
            hashlib.sha256(manifest).hexdigest(),
        )

    def _read_ref(self, ref: str) -> str | None:
        try:
            value = self._call("GET", "/git/ref/" + ref)
        except GitHubPublicationError as error:
            if error.status == 404:
                return None
            raise
        obj = value.get("object", {})
        if value.get("ref") != "refs/" + ref or obj.get("type") != "commit":
            raise GitHubPublicationError("github_reference_invalid")
        return _sha(obj.get("sha"))

    def _verify_commit(self, commit: str, expected: Mapping[str, str]) -> str:
        value = self._call("GET", f"/git/commits/{_sha(commit)}")
        if value.get("sha") != commit:
            raise GitHubPublicationError("github_commit_mismatch")
        tree = _sha(value.get("tree", {}).get("sha"))
        result = self._call("GET", f"/git/trees/{tree}?recursive=1")
        if result.get("sha") != tree or result.get("truncated") is not False:
            raise GitHubPublicationError("github_tree_incomplete")
        entries = result.get("tree")
        if not isinstance(entries, list):
            raise GitHubPublicationError("github_tree_incomplete")
        actual = {}
        for item in entries:
            if not isinstance(item, dict):
                raise GitHubPublicationError("github_tree_invalid")
            if item.get("type") == "tree" and item.get("mode") == "040000":
                continue
            path = item.get("path")
            if (
                not isinstance(path, str)
                or path in actual
                or item.get("type") != "blob"
                or item.get("mode") != "100644"
            ):
                raise GitHubPublicationError("github_tree_invalid")
            actual[path] = _sha(item.get("sha"))
        if actual != expected:
            raise GitHubPublicationError("github_revision_conflict")
        return tree

    def dispatch_build(
        self,
        *,
        workflow_id: int,
        workflow_ref: str,
        workflow_sha: str,
        build_job_id: UUID,
        source_commit: str | None,
        source_mode: str = "github",
    ) -> int | None:
        """Dispatch trusted workflow only; persist dispatch intent BEFORE calling.

        GitHub dispatch has no exactly-once key. A controller must reconcile a
        lost response using the durable build ID, and workers must claim the
        existing fenced Studio job before doing work. Never invent another ID.
        """
        if (
            type(workflow_id) is not int
            or workflow_id <= 0
            or not re.fullmatch(r"studio-runtime-[0-9a-f]{40}", workflow_ref)
            or not isinstance(build_job_id, UUID)
        ):
            raise GitHubPublicationError("github_workflow_invalid")
        _sha(workflow_sha)
        if source_mode == "github":
            _sha(source_commit)
        elif source_mode != "opengeo" or source_commit is not None:
            raise GitHubPublicationError("github_source_mode_invalid")
        self.verify_repository(require_private=source_mode == "github")
        workflow = self._call("GET", f"/actions/workflows/{workflow_id}")
        if (
            workflow.get("id") != workflow_id
            or workflow.get("state") != "active"
            or workflow.get("path") != ".github/workflows/studio-framework-build.yml"
        ):
            raise GitHubPublicationError("github_workflow_invalid")
        if self._read_ref("heads/" + workflow_ref) != workflow_sha:
            raise GitHubPublicationError("github_workflow_revision_changed")
        result = self._call(
            "POST",
            f"/actions/workflows/{workflow_id}/dispatches",
            {
                "ref": workflow_ref,
                "inputs": {
                    "build_job_id": str(build_job_id),
                    "source_commit": source_commit or "",
                    "expected_workflow_sha": workflow_sha,
                    **({"source_mode": "opengeo"} if source_mode == "opengeo" else {}),
                },
            },
        )
        if not result:
            return None  # Older GitHub response: recover through the run listing.
        run_id = result.get("workflow_run_id")
        if type(run_id) is not int or run_id < 1:
            raise GitHubPublicationError("github_dispatch_receipt_invalid")
        return run_id

    def find_build_runs(
        self,
        *,
        workflow_id: int,
        workflow_sha: str,
        build_job_id: UUID,
        page: int = 1,
        source_mode: str = "github",
    ) -> tuple[tuple[GitHubBuildRun, ...], bool]:
        """Recover run identities after dispatch timeouts without another dispatch.

        Return a continuation flag, not a false "no run" when a page is full.
        An empty result is an observation, not permission to restart work: the
        durable controller owns its reconciliation deadline and fenced job state.
        """
        if (
            type(workflow_id) is not int
            or workflow_id < 1
            or not isinstance(build_job_id, UUID)
            or type(page) is not int
            or not 1 <= page <= 10
        ):
            raise GitHubPublicationError("github_run_query_invalid")
        _sha(workflow_sha)
        if source_mode not in {"github", "opengeo"}:
            raise GitHubPublicationError("github_source_mode_invalid")
        self.verify_repository(require_private=source_mode == "github")
        result = self._call(
            "GET",
            f"/actions/workflows/{workflow_id}/runs?"
            f"event=workflow_dispatch&head_sha={workflow_sha}&per_page=100&page={page}",
        )
        records = result.get("workflow_runs")
        if not isinstance(records, list) or len(records) > 100:
            raise GitHubPublicationError("github_runs_invalid")
        found = []
        for record in records:
            if not isinstance(record, dict):
                raise GitHubPublicationError("github_runs_invalid")
            if record.get("display_title") != f"studio-build-{build_job_id}":
                continue
            found.append(self._build_run(record, workflow_id, workflow_sha, build_job_id))
        return tuple(found), len(records) == 100

    def get_build_run(
        self,
        *,
        workflow_id: int,
        workflow_sha: str,
        build_job_id: UUID,
        run_id: int,
        attempt: int,
        source_mode: str = "github",
    ) -> GitHubBuildRun:
        if type(run_id) is not int or run_id < 1 or type(attempt) is not int or attempt < 1:
            raise GitHubPublicationError("github_run_query_invalid")
        _sha(workflow_sha)
        if source_mode not in {"github", "opengeo"}:
            raise GitHubPublicationError("github_source_mode_invalid")
        self.verify_repository(require_private=source_mode == "github")
        record = self._call("GET", f"/actions/runs/{run_id}/attempts/{attempt}")
        run = self._build_run(record, workflow_id, workflow_sha, build_job_id)
        if run.run_id != run_id or run.attempt != attempt:
            raise GitHubPublicationError("github_run_identity_invalid")
        return run

    def _build_run(
        self,
        record: dict[str, Any],
        workflow_id: int,
        workflow_sha: str,
        build_job_id: UUID,
    ) -> GitHubBuildRun:
        if (
            record.get("display_title") != f"studio-build-{build_job_id}"
            or record.get("workflow_id") != workflow_id
            or record.get("head_sha") != workflow_sha
            or record.get("event") != "workflow_dispatch"
            or record.get("head_branch") != "studio-runtime-" + workflow_sha
            or record.get("repository", {}).get("id") != self.connection.repository_id
            or record.get("head_repository", {}).get("id") != self.connection.repository_id
            or type(record.get("id")) is not int
            or record["id"] < 1
            or type(record.get("run_attempt")) is not int
            or record["run_attempt"] < 1
            or record.get("status")
            not in {"queued", "in_progress", "completed", "waiting", "requested", "pending"}
            or record.get("conclusion")
            not in {
                None,
                "success",
                "failure",
                "neutral",
                "cancelled",
                "skipped",
                "timed_out",
                "action_required",
                "stale",
                "startup_failure",
            }
        ):
            raise GitHubPublicationError("github_run_identity_invalid")
        return GitHubBuildRun(
            record["id"],
            record["run_attempt"],
            record["status"],
            record.get("conclusion"),
            f"https://github.com/{self.connection.repository}/actions/runs/{record['id']}",
        )
