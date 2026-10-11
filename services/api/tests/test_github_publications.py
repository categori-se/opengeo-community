import base64
import copy
import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from opengeo_api.github_publications import (
    GitHubConnection,
    GitHubHttpTransport,
    GitHubInstallationTokens,
    GitHubPublicationError,
    GitHubPublicationRepository,
    _blob_sha,
)

SOURCE = UUID("11111111-1111-4111-8111-111111111111")
REVISION = UUID("22222222-2222-4222-8222-222222222222")
JOB = UUID("33333333-3333-4333-8333-333333333333")
NOW = datetime(2026, 9, 10, 12, tzinfo=UTC)
CONNECTION = GitHubConnection(7, 123, "owner/private-project")
FILES = {"src/index.md": b"# Hello\n", "src/data/data.json": b'{"value":1}'}


class GitHubFake:
    def __init__(self):
        self.calls = []
        self.refs = {}
        self.trees = {}
        self.commits = {}
        self.repo = {
            "id": 123,
            "full_name": CONNECTION.repository,
            "private": True,
            "archived": False,
            "disabled": False,
        }
        self.lose_ref_response = False
        self.tree_truncated = False
        self.dispatch_response_lost = False

    def request(self, method, path, token, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        assert token == "private-token"
        path = path.removeprefix("/repos/" + CONNECTION.repository)
        if method == "GET" and path == "":
            return self.repo.copy()
        if method == "GET" and path.startswith("/git/ref/"):
            ref = path.removeprefix("/git/ref/")
            if ref not in self.refs:
                raise GitHubPublicationError("github_http_error", status=404)
            return {"ref": "refs/" + ref, "object": {"type": "commit", "sha": self.refs[ref]}}
        if method == "POST" and path == "/git/blobs":
            return {"sha": _blob_sha(base64.b64decode(body["content"]))}
        if method == "POST" and path == "/git/trees":
            sha = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
            self.trees[sha] = copy.deepcopy(body["tree"])
            return {"sha": sha}
        if method == "POST" and path == "/git/commits":
            sha = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
            self.commits[sha] = {"sha": sha, "tree": {"sha": body["tree"]}}
            return {"sha": sha}
        if method == "POST" and path == "/git/refs":
            ref = body["ref"].removeprefix("refs/")
            if ref in self.refs:
                raise GitHubPublicationError("github_http_error", status=422)
            self.refs[ref] = body["sha"]
            if self.lose_ref_response:
                raise GitHubPublicationError("github_observation_unavailable")
            return {}
        if method == "GET" and path.startswith("/git/commits/"):
            return self.commits[path.split("/")[-1]]
        if method == "GET" and path.startswith("/git/trees/"):
            sha = path.split("/")[-1].split("?")[0]
            return {"sha": sha, "truncated": self.tree_truncated, "tree": self.trees[sha]}
        if method == "GET" and path == "/actions/workflows/42":
            return {
                "id": 42,
                "state": "active",
                "path": ".github/workflows/studio-framework-build.yml",
            }
        if method == "POST" and path == "/actions/workflows/42/dispatches":
            if self.dispatch_response_lost:
                raise GitHubPublicationError("github_observation_unavailable")
            return {}
        raise AssertionError((method, path))


def mirror(fake, **overrides):
    params = {
        "source_project_id": SOURCE,
        "revision_id": REVISION,
        "created_at": NOW,
        "files": FILES,
    }
    return GitHubPublicationRepository(CONNECTION, "private-token", fake).mirror_revision(
        **(params | overrides)
    )


def test_mirror_retains_exact_private_revision_without_changing_main():
    fake = GitHubFake()
    fake.refs["heads/main"] = "a" * 40
    receipt = mirror(fake)
    assert receipt.repository_id == 123
    assert receipt.revision_id == REVISION
    assert fake.refs["heads/main"] == "a" * 40
    assert fake.refs[receipt.ref] == receipt.commit_sha
    tree = fake.trees[receipt.tree_sha]
    assert {entry["path"] for entry in tree} == {*FILES, ".opengeo/source-revision.json"}
    assert all(entry["mode"] == "100644" for entry in tree)
    assert not any(method in {"PATCH", "DELETE"} for method, _, _ in fake.calls)


def test_retry_reuses_existing_verified_commit_without_writes():
    fake = GitHubFake()
    first = mirror(fake)
    fake.calls.clear()
    assert mirror(fake) == first
    assert all(method == "GET" for method, _, _ in fake.calls)


def test_lost_ref_response_reconciles_exact_identity():
    fake = GitHubFake()
    fake.lose_ref_response = True
    first = mirror(fake)
    assert mirror(fake) == first
    assert len(fake.refs) == 1


def test_conflicting_replay_does_not_overwrite_existing_revision():
    fake = GitHubFake()
    first = mirror(fake)
    fake.calls.clear()
    with pytest.raises(GitHubPublicationError, match="github_revision_conflict"):
        mirror(fake, files={"src/index.md": b"# Different source"})
    assert fake.refs[first.ref] == first.commit_sha
    assert all(method == "GET" for method, _, _ in fake.calls)


@pytest.mark.parametrize(
    "change",
    [
        {"private": False},
        {"id": 456},
        {"full_name": "other/repository"},
        {"archived": True},
        {"disabled": True},
    ],
)
def test_private_connection_revalidated_before_source_writes(change):
    fake = GitHubFake()
    fake.repo.update(change)
    with pytest.raises(GitHubPublicationError, match="github_repository_not_authorized"):
        mirror(fake)
    assert all(method == "GET" for method, _, _ in fake.calls)


@pytest.mark.parametrize(
    "files",
    [
        {},
        {"../file.md": b"no"},
        {".github/workflows/publish.yml": b"no"},
        {"src/link.md": b""},
        {"src/Foo.md": b"a", "src/foo.md": b"b"},
        {"src": b"a", "src/index.md": b"b"},
        {"src/file.": b"no"},
        {"src/index.md": b"x" * 4_194_305},
    ],
)
def test_invalid_snapshot_rejected_before_any_github_request(files):
    fake = GitHubFake()
    with pytest.raises(GitHubPublicationError, match="github_source_invalid"):
        mirror(fake, files=files)
    assert fake.calls == []


def test_truncated_tree_is_not_treated_as_verified():
    fake = GitHubFake()
    fake.tree_truncated = True
    with pytest.raises(GitHubPublicationError, match="github_tree_incomplete"):
        mirror(fake)
    assert not fake.refs


@pytest.mark.parametrize(
    "mode,kind", [("120000", "blob"), ("160000", "commit"), ("100755", "blob")]
)
def test_recovered_revision_rejects_symlinks_submodules_and_executables(mode, kind):
    fake = GitHubFake()
    receipt = mirror(fake)
    fake.trees[receipt.tree_sha][0].update(mode=mode, type=kind)
    with pytest.raises(GitHubPublicationError, match="github_tree_invalid"):
        mirror(fake)


def dispatch(fake, **overrides):
    sha = "a" * 40
    params = {
        "workflow_id": 42,
        "workflow_ref": "studio-runtime-" + sha,
        "workflow_sha": sha,
        "build_job_id": JOB,
        "source_commit": "b" * 40,
    }
    return GitHubPublicationRepository(CONNECTION, "private-token", fake).dispatch_build(
        **(params | overrides)
    )


def test_dispatch_uses_separate_trusted_workflow_and_exact_source_commit():
    fake = GitHubFake()
    fake.refs["heads/studio-runtime-" + "a" * 40] = "a" * 40
    dispatch(fake)
    assert fake.calls[-1][2] == {
        "ref": "studio-runtime-" + "a" * 40,
        "inputs": {
            "build_job_id": str(JOB),
            "source_commit": "b" * 40,
            "expected_workflow_sha": "a" * 40,
        },
    }


def test_runtime_branch_movement_refuses_dispatch():
    fake = GitHubFake()
    fake.refs["heads/studio-runtime-" + "a" * 40] = "c" * 40
    with pytest.raises(GitHubPublicationError, match="github_workflow_revision_changed"):
        dispatch(fake)
    assert all(method == "GET" for method, _, _ in fake.calls)


def test_canonical_source_dispatch_accepts_public_runtime_without_source_git_writes():
    fake = GitHubFake()
    fake.repo["private"] = False
    fake.refs["heads/studio-runtime-" + "a" * 40] = "a" * 40
    dispatch(fake, source_mode="opengeo", source_commit=None)
    assert fake.calls[-1][2]["inputs"] == {
        "build_job_id": str(JOB),
        "expected_workflow_sha": "a" * 40,
        "source_mode": "opengeo",
        "source_commit": "",
    }
    assert [path for method, path, _ in fake.calls if method == "POST"] == [
        "/repos/" + CONNECTION.repository + "/actions/workflows/42/dispatches"
    ]
    assert not fake.commits and not fake.trees
    with pytest.raises(GitHubPublicationError, match="github_repository_not_authorized"):
        mirror(fake)


@pytest.mark.parametrize("mode,commit", [("opengeo", "a" * 40), ("", None), ("other", None)])
def test_invalid_source_mode_fails_before_remote_access(mode, commit):
    fake = GitHubFake()
    with pytest.raises(GitHubPublicationError, match="github_source_mode_invalid"):
        dispatch(fake, source_mode=mode, source_commit=commit)
    assert fake.calls == []


def test_lost_dispatch_response_is_not_blindly_retried():
    fake = GitHubFake()
    fake.refs["heads/studio-runtime-" + "a" * 40] = "a" * 40
    fake.dispatch_response_lost = True
    with pytest.raises(GitHubPublicationError, match="github_observation_unavailable"):
        dispatch(fake)
    assert sum(method == "POST" for method, _, _ in fake.calls) == 1


def test_transport_rejects_alternate_origins_before_sending_credentials():
    for path in ["https://evil.test", "//evil.test", "/repos/test\r\nAuthorization: value"]:
        with pytest.raises(GitHubPublicationError, match="github_path_invalid"):
            GitHubHttpTransport().request("GET", path, "never-send-this")


def test_installation_token_is_repository_and_operation_scoped():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    calls = []

    class TokenTransport:
        def request(self, method, path, token, body):
            claims = jwt.decode(
                token,
                key.public_key(),
                algorithms=["RS256"],
                options={"verify_exp": False, "verify_iat": False},
            )
            assert claims == {
                "iat": int(NOW.timestamp()) - 30,
                "exp": int(NOW.timestamp()) + 540,
                "iss": "12",
            }
            calls.append((method, path, body))
            return {"token": "short-lived-token"}

    tokens = GitHubInstallationTokens(12, pem, TokenTransport(), now=lambda: NOW)
    assert tokens.issue(CONNECTION, write_source=True) == "short-lived-token"
    assert tokens.issue(CONNECTION, write_source=False) == "short-lived-token"
    assert calls == [
        (
            "POST",
            "/app/installations/7/access_tokens",
            {"repository_ids": [123], "permissions": {"contents": "write"}},
        ),
        (
            "POST",
            "/app/installations/7/access_tokens",
            {"repository_ids": [123], "permissions": {"contents": "read", "actions": "write"}},
        ),
    ]


def test_run_reconciliation_is_read_only_and_rejects_other_repository():
    sha = "a" * 40
    record = {
        "id": 456,
        "workflow_id": 42,
        "head_sha": sha,
        "event": "workflow_dispatch",
        "head_branch": "studio-runtime-" + sha,
        "display_title": f"studio-build-{JOB}",
        "run_attempt": 1,
        "status": "in_progress",
        "conclusion": None,
        "repository": {"id": 123},
        "head_repository": {"id": 123},
    }

    class RunTransport(GitHubFake):
        def request(self, method, path, token, body=None):
            assert method == "GET"
            if path.endswith("/actions/runs/456/attempts/1"):
                return record
            if "/runs?" in path:
                assert f"head_sha={sha}&per_page=100&page=1" in path
                return {"workflow_runs": [record]}
            return super().request(method, path, token, body)

    repository = GitHubPublicationRepository(CONNECTION, "private-token", RunTransport())
    runs, more = repository.find_build_runs(workflow_id=42, workflow_sha=sha, build_job_id=JOB)
    assert not more
    assert runs[0].run_id == 456
    assert (
        repository.get_build_run(
            workflow_id=42, workflow_sha=sha, build_job_id=JOB, run_id=456, attempt=1
        )
        == runs[0]
    )
    record["run_attempt"] = 2
    with pytest.raises(GitHubPublicationError, match="github_run_identity_invalid"):
        repository.get_build_run(
            workflow_id=42, workflow_sha=sha, build_job_id=JOB, run_id=456, attempt=1
        )
    record["run_attempt"] = 1
    record["head_repository"] = {"id": 789}
    with pytest.raises(GitHubPublicationError, match="github_run_identity_invalid"):
        repository.find_build_runs(workflow_id=42, workflow_sha=sha, build_job_id=JOB)
