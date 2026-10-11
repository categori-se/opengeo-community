import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from opengeo_api.github_build_controller import (
    GitHubBuildController,
    GitHubSourceSyncController,
    process_github_queue,
)
from opengeo_api.github_publications import GitHubBuildRun, GitHubConnection, GitHubPublicationError

ID = UUID("11111111-1111-4111-8111-111111111111")
CONNECTION = GitHubConnection(7, 123, "owner/private")


def test_source_only_queue_resumes_revision_without_dispatching_build(monkeypatch):
    claim = {
        "status": "claimed",
        **{
            key: str(ID)
            for key in (
                "source_revision_id",
                "source_project_id",
                "project_id",
                "organization_id",
                "user_id",
            )
        },
    }
    ledger = SimpleNamespace(
        claim=AsyncMock(return_value=claim), finish=AsyncMock(side_effect=[False, True])
    )
    sync = AsyncMock(
        side_effect=[TimeoutError("lost response"), SimpleNamespace(commit_sha="a" * 40)]
    )
    monkeypatch.setattr("opengeo_api.github_build_controller.synchronize_github_revision", sync)
    source = GitHubSourceSyncController(ledger, object(), lambda connection: None)
    build = SimpleNamespace(process=AsyncMock(side_effect=AssertionError("No build authorized")))
    event = {
        "Records": [
            {
                "messageId": "same-command",
                "body": json.dumps(
                    {
                        "schema": "opengeo.github-source-sync.command.1.0.0",
                        "source_revision_id": str(ID),
                    }
                ),
            }
        ]
    }
    assert asyncio.run(process_github_queue(event, build, source))["batchItemFailures"]
    assert asyncio.run(process_github_queue(event, build, source)) == {"batchItemFailures": []}
    assert [call.kwargs["revision_id"] for call in sync.await_args_list] == [ID, ID]
    build.process.assert_not_awaited()


@pytest.mark.parametrize("lost_response", [False, True])
@pytest.mark.parametrize("conclusion", ["success", "failure"])
@pytest.mark.parametrize("logs_unavailable", [False, True])
@pytest.mark.parametrize("source_mode", ["github", "opengeo"])
def test_dispatch_resumes_same_run_and_retains_terminal_status(
    monkeypatch, lost_response, conclusion, logs_unavailable, source_mode
):
    async def inline(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", inline)
    state = {
        "status": "claimed",
        "build_job_id": str(ID),
        "user_id": str(ID),
        "organization_id": str(ID),
        "project_id": str(ID),
        "source_project_id": str(ID),
        "source_revision_id": str(ID),
        "connection_id": str(ID),
        "installation_id": 7,
        "repository_id": 123,
        "repository": "owner/private",
        "stage": "ready",
        "workflow_id": 42,
        "workflow_sha": "a" * 40,
        "source_commit": "b" * 40 if source_mode == "github" else None,
        "source_mode": source_mode,
    }
    dispatches = []
    observations = []
    retained_logs = []
    terminal = False

    class Ledger:
        async def retain_logs(self, job, token, run, attempt, logs):
            assert job == ID and run == 456 and attempt == 1
            retained_logs.append(logs)
            return True

        async def claim(self, job, token):
            assert job == ID
            if state["stage"] in {"completed", "failed"}:
                return {"status": state["stage"]}
            return dict(state)

        async def advance(self, job, token, stage, **kwargs):
            if stage == "release":
                return True
            state["stage"] = stage
            for key, value in kwargs.items():
                if value is not None:
                    state[{"run": "run_id", "attempt": "run_attempt"}.get(key, key)] = value
            return True

    class Repository:
        async def authorize_build_dispatch(self, *args):
            pass

        async def prepare_github_export(self, *args):
            assert source_mode == "github", "S3-only compilation never exports source"
            return ID, CONNECTION, None

        async def prepare_github_build(self, *args):
            assert source_mode == "opengeo"
            return ID, CONNECTION

    class GitHub:
        token = "test-installation-token"

        def dispatch_build(self, **kwargs):
            assert state["stage"] == "dispatching", "Persist intent before the remote POST"
            assert kwargs["source_mode"] == source_mode
            assert kwargs["source_commit"] == state["source_commit"]
            dispatches.append(kwargs)
            if lost_response:
                raise GitHubPublicationError("github_response_lost")
            return 456

        def find_build_runs(self, **kwargs):
            assert kwargs["source_mode"] == source_mode
            observations.append("recover")
            return (GitHubBuildRun(456, 1, "in_progress", None, "unused"),), False

        def get_build_run(self, **kwargs):
            assert kwargs["source_mode"] == source_mode
            assert kwargs["run_id"] == 456 and kwargs["attempt"] == 1
            observations.append("observe")
            return GitHubBuildRun(
                456,
                1,
                "completed" if terminal else "in_progress",
                conclusion if terminal else None,
                "unused",
            )

    def log_reader(repository, token, run, attempt):
        assert (repository, token, run, attempt) == ("owner/private", GitHub.token, 456, 1)
        if logs_unavailable:
            raise GitHubPublicationError("github_logs_unavailable")
        return {"state": "retained", "text": "Build diagnostic"}

    controller = GitHubBuildController(Ledger(), Repository(), lambda *args: GitHub(), log_reader)

    def run():
        return asyncio.run(controller.process(ID))

    assert run() is False
    if lost_response:
        assert state["stage"] == "dispatching"
        assert run() is False
    assert state["stage"] == "dispatched"
    assert run() is False
    assert state["run_status"] == "in_progress"
    terminal = True
    assert run() is True
    assert state["stage"] == ("completed" if conclusion == "success" else "failed")
    assert state["conclusion"] == conclusion
    assert run() is True
    assert len(dispatches) == 1, "Reload/retry must never dispatch a replacement build"
    assert observations.count("observe") == 2
    assert len(retained_logs) == 1
    if logs_unavailable:
        assert retained_logs[0]["state"] == "unavailable"
    else:
        assert retained_logs == [{"state": "retained", "text": "Build diagnostic"}]


@pytest.mark.parametrize(
    "source_mode,commit,stage",
    [("other", None, "ready"), ("opengeo", "a" * 40, "ready"), ("opengeo", None, "syncing")],
)
def test_invalid_canonical_mode_refuses_source_sync_or_github_calls(source_mode, commit, stage):
    claim = {
        "status": "claimed",
        **{
            key: str(ID)
            for key in (
                "build_job_id",
                "user_id",
                "organization_id",
                "project_id",
                "source_project_id",
                "source_revision_id",
                "connection_id",
            )
        },
        "installation_id": 7,
        "repository_id": 123,
        "repository": "owner/private",
        "source_mode": source_mode,
        "source_commit": commit,
        "stage": stage,
    }
    ledger = SimpleNamespace(claim=AsyncMock(return_value=claim), advance=AsyncMock())

    def factory(*_):
        pytest.fail("Invalid mode must fail before GitHub access")

    with pytest.raises(GitHubPublicationError, match="github_source_mode_invalid"):
        asyncio.run(GitHubBuildController(ledger, object(), factory).process(ID))
    ledger.advance.assert_awaited_once()
    assert ledger.advance.await_args.args[2] == "release"
