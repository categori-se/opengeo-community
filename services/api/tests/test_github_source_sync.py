import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest

from opengeo_api.github_publications import GitHubConnection, GitHubSourceReceipt
from opengeo_api.github_source_sync import synchronize_github_revision
from opengeo_api.observable_sources import ObservableSourceConflict
from opengeo_api.tenant_database import TenantContext


def test_sync_reauthorizes_before_export_and_retains_receipt_only_after_confirmation(monkeypatch):
    async def inline(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", inline)
    identity = UUID("11111111-1111-4111-8111-111111111111")
    context = TenantContext(identity, identity)
    connection = GitHubConnection(7, 123, "owner/private")
    revision = SimpleNamespace(
        created_at=datetime(2026, 9, 10, tzinfo=UTC),
        files=[SimpleNamespace(relative_path="src/index.md")],
    )
    receipt = GitHubSourceReceipt(
        123,
        identity,
        identity,
        "a" * 40,
        "b" * 40,
        f"heads/studio/sources/{identity}/revisions/{identity}",
        "c" * 64,
    )
    calls = []
    revoked = False

    class Repository:
        async def prepare_github_export(self, *args):
            calls.append("authorize")
            if revoked and "read" in calls:
                raise ObservableSourceConflict("github_connection_unavailable")
            return identity, connection, revision

        async def read_revision_file(self, *args):
            calls.append("read")
            return SimpleNamespace(relative_path="src/index.md", body=b"# Source")

        async def retain_github_receipt(self, *args):
            calls.append("receipt")
            assert args[-1] == receipt

    class GitHub:
        def mirror_revision(self, **kwargs):
            calls.append("export")
            assert kwargs["files"] == {"src/index.md": b"# Source"}
            return receipt

    def execute():
        return asyncio.run(
            synchronize_github_revision(
                context=context,
                project_id=identity,
                source_project_id=identity,
                revision_id=identity,
                repository=Repository(),
                github_factory=lambda grant: GitHub(),
            )
        )

    assert execute() == receipt
    assert calls == ["authorize", "read", "authorize", "export", "authorize", "receipt"]
    calls.clear()
    revoked = True
    with pytest.raises(ObservableSourceConflict, match="github_connection_unavailable"):
        execute()
    assert calls == ["authorize", "read", "authorize"]
