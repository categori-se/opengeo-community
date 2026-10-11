"""Resumable exact-revision export, intended for the on-demand queue controller.

Never run this long operation as a fire-and-forget API task. A durable job owns
its command; replay reconciles GitHub's immutable revision ref and DB receipt.
"""

import asyncio
from collections.abc import Callable
from typing import Protocol
from uuid import UUID

from opengeo_api.github_publications import (
    GitHubConnection,
    GitHubPublicationRepository,
    GitHubSourceReceipt,
)
from opengeo_api.observable_sources import (
    ObservableSourceConflict,
    ObservableSourceFileContent,
    ObservableSourceRevision,
)
from opengeo_api.tenant_database import TenantContext


class GitHubExportRepository(Protocol):
    async def prepare_github_export(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
    ) -> tuple[UUID, GitHubConnection, ObservableSourceRevision]: ...

    async def read_revision_file(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        relative_path: str,
    ) -> ObservableSourceFileContent: ...

    async def retain_github_receipt(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        receipt: GitHubSourceReceipt,
    ) -> None: ...


async def synchronize_github_revision(
    *,
    context: TenantContext,
    project_id: UUID,
    source_project_id: UUID,
    revision_id: UUID,
    repository: GitHubExportRepository,
    github_factory: Callable[[GitHubConnection], GitHubPublicationRepository],
) -> GitHubSourceReceipt:
    prepared = await repository.prepare_github_export(
        context, project_id, source_project_id, revision_id
    )
    connection_id, connection, revision = prepared
    files: dict[str, bytes] = {}
    # Four bounded reads at a time, no project commands or network loaders.
    # read_revision_file already verifies exact S3 versions/checksums and access.
    for offset in range(0, len(revision.files), 4):
        responses = await asyncio.gather(
            *[
                repository.read_revision_file(
                    context, project_id, source_project_id, revision_id, file.relative_path
                )
                for file in revision.files[offset : offset + 4]
            ]
        )
        for response in responses:
            files[response.relative_path] = response.body
    confirmed = await repository.prepare_github_export(
        context, project_id, source_project_id, revision_id
    )
    if confirmed != prepared:
        raise ObservableSourceConflict("github_export_authorization_changed")
    github = await asyncio.to_thread(github_factory, connection)
    receipt = await asyncio.to_thread(
        github.mirror_revision,
        source_project_id=source_project_id,
        revision_id=revision_id,
        created_at=revision.created_at,
        files=files,
    )
    # If authority is revoked after export, do not advertise a successful receipt.
    # The immutable remote object is retained; recovery must not delete source.
    confirmed = await repository.prepare_github_export(
        context, project_id, source_project_id, revision_id
    )
    if confirmed != prepared:
        raise ObservableSourceConflict("github_export_authorization_changed")
    await repository.retain_github_receipt(context, project_id, connection_id, receipt)
    return receipt
