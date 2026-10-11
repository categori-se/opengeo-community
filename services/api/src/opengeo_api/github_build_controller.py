"""On-demand GitHub dispatch controller; no compiler or publication credentials.

The Lambda timeout MUST be <=900 seconds, below the database's 1000-second
takeover lease. Configure SQS batch size 1 and visibility >=1000 seconds. The
same ID-only queue command used by Studio's existing Build button is retained.
"""

import asyncio
import json
import logging
import traceback
from collections.abc import Callable
from typing import Any, Protocol
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.config import Settings
from opengeo_api.connections import AwsConnectionSecretStore
from opengeo_api.github_build_logs import download_build_logs, unavailable_logs
from opengeo_api.github_publications import (
    GitHubConnection,
    GitHubHttpTransport,
    GitHubInstallationTokens,
    GitHubPublicationError,
    GitHubPublicationRepository,
)
from opengeo_api.github_source_sync import synchronize_github_revision
from opengeo_api.observable_sources import PostgresObservableSourceRepository
from opengeo_api.processing_dispatch import AwsSqsRenderDispatcher
from opengeo_api.rds_data import RdsDataApiClient
from opengeo_api.s3_downloads import AwsS3DownloadStorage
from opengeo_api.tenant_database import RdsDataApiTenantQueryExecutor, TenantContext


class GitHubDispatchLedger(Protocol):
    async def claim(self, job: UUID, token: UUID) -> dict[str, Any]: ...

    async def retain_logs(
        self, job: UUID, token: UUID, run: int, attempt: int, logs: dict[str, Any]
    ) -> bool: ...

    async def advance(
        self,
        job: UUID,
        token: UUID,
        stage: str,
        *,
        commit: str | None = None,
        run: int | None = None,
        attempt: int | None = None,
        error: str | None = None,
        run_status: str | None = None,
        conclusion: str | None = None,
    ) -> bool: ...


class DataApiGitHubDispatchLedger:
    def __init__(self, client: RdsDataApiClient) -> None:
        self.client = client

    async def retain_logs(
        self, job: UUID, token: UUID, run: int, attempt: int, logs: dict[str, Any]
    ) -> bool:
        result = await self.client.execute(
            "SELECT app.retain_github_build_logs(%s, %s, %s::bigint, %s::integer, %s::jsonb)",
            (job, token, run, attempt, Jsonb(logs)),
        )
        return result.records == ((True,),)

    async def claim(self, job: UUID, token: UUID) -> dict[str, Any]:
        result = await self.client.execute(
            "SELECT app.claim_github_build_dispatch(%s, %s)", (job, token)
        )
        if len(result.records) != 1 or len(result.records[0]) != 1:
            raise GitHubPublicationError("github_claim_invalid")
        value = result.records[0][0]
        if isinstance(value, str):
            value = json.loads(value)
        if not isinstance(value, dict):
            raise GitHubPublicationError("github_claim_invalid")
        return value

    async def advance(
        self,
        job: UUID,
        token: UUID,
        stage: str,
        *,
        commit: str | None = None,
        run: int | None = None,
        attempt: int | None = None,
        error: str | None = None,
        run_status: str | None = None,
        conclusion: str | None = None,
    ) -> bool:
        result = await self.client.execute(
            "SELECT app.advance_github_build_dispatch("
            "%s, %s, %s, %s, %s::bigint, %s::integer, %s, %s, %s)",
            (job, token, stage, commit, run, attempt, error, run_status, conclusion),
        )
        return result.records == ((True,),)


class GitHubBuildController:
    def __init__(
        self,
        ledger: GitHubDispatchLedger,
        repository: PostgresObservableSourceRepository,
        github_factory: Callable[[GitHubConnection, bool], GitHubPublicationRepository],
        log_reader: Callable[[str, str, int, int], dict[str, Any]] = download_build_logs,
    ) -> None:
        self.ledger = ledger
        self.repository = repository
        self.github_factory = github_factory
        self.log_reader = log_reader

    async def process(self, job: UUID) -> bool:
        """True acknowledges work, False retries observation of this same command."""
        token = uuid4()
        claim = await self.ledger.claim(job, token)
        status = claim.get("status")
        if status in {"completed", "failed", "finished"}:
            return True
        if status in {"busy", "unavailable", "configuration_changed"}:
            return False
        if status != "claimed" or claim.get("build_job_id") != str(job):
            raise GitHubPublicationError("github_claim_invalid")
        try:
            context = TenantContext(UUID(claim["user_id"]), UUID(claim["organization_id"]))
            project = UUID(claim["project_id"])
            source = UUID(claim["source_project_id"])
            revision = UUID(claim["source_revision_id"])
            connection_id = UUID(claim["connection_id"])
            connection = GitHubConnection(
                claim["installation_id"], claim["repository_id"], claim["repository"]
            )
            stage = claim["stage"]
            commit = claim["source_commit"]
            source_mode = claim.get("source_mode", "github")
            if source_mode not in {"opengeo", "github"} or (
                source_mode == "opengeo" and (commit is not None or stage == "syncing")
            ):
                raise GitHubPublicationError("github_source_mode_invalid")
            if stage == "syncing":
                await self.repository.authorize_build_dispatch(context, project, job)
                receipt = await synchronize_github_revision(
                    context=context,
                    project_id=project,
                    source_project_id=source,
                    revision_id=revision,
                    repository=self.repository,
                    github_factory=lambda grant: self.github_factory(grant, True),
                )
                commit = receipt.commit_sha
                if not await self.ledger.advance(job, token, "ready", commit=commit):
                    return False
                stage = "ready"
            github = await asyncio.to_thread(self.github_factory, connection, False)
            if stage == "dispatched":
                run_record = await asyncio.to_thread(
                    github.get_build_run,
                    workflow_id=claim["workflow_id"],
                    workflow_sha=claim["workflow_sha"],
                    build_job_id=job,
                    run_id=claim["run_id"],
                    attempt=claim["run_attempt"],
                    source_mode=source_mode,
                )
                complete = run_record.status == "completed"
                if complete and run_record.conclusion is None:
                    return False
                if complete:
                    # Only the verified exact run attempt may supply these logs.
                    # This reads existing logs; it never reruns the workflow.
                    try:
                        logs = await asyncio.to_thread(
                            self.log_reader,
                            connection.repository,
                            github.token,
                            run_record.run_id,
                            run_record.attempt,
                        )
                    except (GitHubPublicationError, TimeoutError, OSError):
                        # Logging availability cannot erase a verified terminal outcome.
                        # Never persist exception text (it may contain a signed URL).
                        logs = unavailable_logs(
                            "Studio could not retain logs for this attempt. "
                            "The verified build outcome is preserved; open GitHub logs for details."
                        )
                    if not await self.ledger.retain_logs(
                        job, token, run_record.run_id, run_record.attempt, logs
                    ):
                        return False
                next_stage = (
                    ("completed" if run_record.conclusion == "success" else "failed")
                    if complete
                    else "dispatched"
                )
                retained = await self.ledger.advance(
                    job,
                    token,
                    next_stage,
                    run=run_record.run_id,
                    attempt=run_record.attempt,
                    run_status=run_record.status,
                    conclusion=run_record.conclusion,
                    error=f"github_run_{run_record.conclusion}" if next_stage == "failed" else None,
                )
                return retained and complete
            if stage == "ready":
                # Recheck build authority. Canonical S3 mode never requests an
                # export or requires a publication-to-repository source link.
                prepared = await (
                    self.repository.prepare_github_build(context, project, source, revision)
                    if source_mode == "opengeo"
                    else self.repository.prepare_github_export(context, project, source, revision)
                )
                if prepared[0] != connection_id or prepared[1] != connection:
                    raise GitHubPublicationError("github_connection_changed")
                await self.repository.authorize_build_dispatch(context, project, job)
                if not await self.ledger.advance(job, token, "dispatching"):
                    return False
                # Persist the intent BEFORE sending. Never repeat this POST after
                # an uncertain response, even if GitHub's listing is briefly empty.
                try:
                    run = await asyncio.to_thread(
                        github.dispatch_build,
                        workflow_id=claim["workflow_id"],
                        workflow_ref="studio-runtime-" + claim["workflow_sha"],
                        workflow_sha=claim["workflow_sha"],
                        build_job_id=job,
                        source_commit=commit,
                        source_mode=source_mode,
                    )
                except GitHubPublicationError as error:
                    if error.status in {400, 401, 403, 404, 422, 429}:
                        return await self.ledger.advance(
                            job, token, "failed", error="github_dispatch_rejected"
                        )
                    # Both a network failure and an invalid success receipt are
                    # ambiguous; recover the original run on the next invocation.
                    return False
                if run is not None:
                    await self.ledger.advance(job, token, "dispatched", run=run, attempt=1)
                    return False
                stage = "dispatching"
            if stage != "dispatching":
                raise GitHubPublicationError("github_dispatch_stage_invalid")
            for page in range(1, 11):
                runs, more = await asyncio.to_thread(
                    github.find_build_runs,
                    workflow_id=claim["workflow_id"],
                    workflow_sha=claim["workflow_sha"],
                    build_job_id=job,
                    page=page,
                    source_mode=source_mode,
                )
                if len(runs) > 1:
                    return await self.ledger.advance(
                        job, token, "failed", error="github_multiple_runs_review_required"
                    )
                if runs:
                    await self.ledger.advance(
                        job,
                        token,
                        "dispatched",
                        run=runs[0].run_id,
                        attempt=runs[0].attempt,
                        run_status=runs[0].status,
                        conclusion=runs[0].conclusion,
                    )
                    return False
                if not more:
                    break
            return False
        finally:
            await self.ledger.advance(job, token, "release")


class GitHubSyncLedger(Protocol):
    async def claim(self, revision: UUID, token: UUID) -> dict[str, Any]: ...
    async def finish(self, revision: UUID, token: UUID, error: str | None) -> bool: ...


class DataApiGitHubSyncLedger:
    def __init__(self, client: RdsDataApiClient) -> None:
        self.client = client

    async def claim(self, revision: UUID, token: UUID) -> dict[str, Any]:
        result = await self.client.execute(
            "SELECT app.claim_github_source_sync(%s, %s)", (revision, token)
        )
        if len(result.records) != 1 or len(result.records[0]) != 1:
            raise GitHubPublicationError("github_sync_claim_invalid")
        value = result.records[0][0]
        if isinstance(value, str):
            value = json.loads(value)
        if not isinstance(value, dict):
            raise GitHubPublicationError("github_sync_claim_invalid")
        return value

    async def finish(self, revision: UUID, token: UUID, error: str | None) -> bool:
        result = await self.client.execute(
            "SELECT app.finish_github_source_sync(%s, %s, %s)", (revision, token, error)
        )
        return result.records == ((True,),)


class GitHubSourceSyncController:
    def __init__(
        self,
        ledger: GitHubSyncLedger,
        repository: PostgresObservableSourceRepository,
        github_factory: Callable[[GitHubConnection], GitHubPublicationRepository],
    ) -> None:
        self.ledger, self.repository, self.github_factory = ledger, repository, github_factory

    async def process(self, revision: UUID) -> bool:
        token = uuid4()
        claim = await self.ledger.claim(revision, token)
        if claim.get("status") in {"synced", "failed"}:
            return True
        if claim.get("status") != "claimed":
            return False
        if claim.get("source_revision_id") != str(revision):
            raise GitHubPublicationError("github_sync_claim_invalid")
        error = None
        try:
            await synchronize_github_revision(
                context=TenantContext(UUID(claim["user_id"]), UUID(claim["organization_id"])),
                project_id=UUID(claim["project_id"]),
                source_project_id=UUID(claim["source_project_id"]),
                revision_id=revision,
                repository=self.repository,
                github_factory=self.github_factory,
            )
        except Exception:
            error = "github_source_sync_retry_required"
        # Only a retained exact receipt can complete this durable source-only job.
        return await self.ledger.finish(revision, token, error)


async def process_github_queue(
    event: dict[str, Any],
    controller: GitHubBuildController,
    sync_controller: GitHubSourceSyncController | None = None,
) -> dict[str, Any]:
    records = event.get("Records")
    if not isinstance(records, list) or len(records) != 1:
        raise GitHubPublicationError("github_queue_batch_invalid")
    record = records[0]
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("messageId"), str)
        or not isinstance(record.get("body"), str)
        or len(record["body"].encode()) > 512
    ):
        raise GitHubPublicationError("github_queue_message_invalid")
    try:
        command = json.loads(record["body"])
        if not isinstance(command, dict):
            raise GitHubPublicationError("github_queue_message_invalid")
        if (
            set(command) == {"schema", "source_revision_id"}
            and command["schema"] == "opengeo.github-source-sync.command.1.0.0"
            and sync_controller is not None
        ):
            complete = await sync_controller.process(UUID(command["source_revision_id"]))
        elif (
            set(command) == {"schema", "build_job_id"}
            and command["schema"] == "opengeo.observable-build.command.1.0.0"
        ):
            complete = await controller.process(UUID(command["build_job_id"]))
        else:
            raise GitHubPublicationError("github_queue_message_invalid")
    except Exception as error:
        # Raw dependency errors may contain response bodies. Keep them out of
        # queue logs; durable stages and the original job identify recovery work.
        frames = traceback.extract_tb(error.__traceback__)
        logging.getLogger(__name__).warning(
            "github_queue_retry exception=%s location=%s:%s",
            type(error).__name__,
            frames[-1].name if frames else "unknown",
            frames[-1].lineno if frames else 0,
        )
        complete = False
    return {"batchItemFailures": [] if complete else [{"itemIdentifier": record["messageId"]}]}


async def _production(event: dict[str, Any]) -> dict[str, Any]:
    settings = Settings()
    if settings.observable_build_provider != "github" or not settings.github_app_secret_arn:
        raise GitHubPublicationError("github_controller_not_configured")
    app_id, private_key = await AwsConnectionSecretStore(settings).get_github_app_credentials()
    transport = GitHubHttpTransport()
    tokens = GitHubInstallationTokens(app_id, private_key, transport)
    client = RdsDataApiClient(settings)
    source = PostgresObservableSourceRepository(
        RdsDataApiTenantQueryExecutor(settings, client),
        download_storage=AwsS3DownloadStorage(settings, bucket=settings.application_bucket),
    )
    controller = GitHubBuildController(
        DataApiGitHubDispatchLedger(client),
        source,
        lambda connection, write: GitHubPublicationRepository(
            connection,
            tokens.issue(connection, write_source=write),
            transport,
        ),
    )
    sync_controller = GitHubSourceSyncController(
        DataApiGitHubSyncLedger(client),
        source,
        lambda connection: GitHubPublicationRepository(
            connection, tokens.issue(connection, write_source=True), transport
        ),
    )
    result = await process_github_queue(event, controller, sync_controller)
    if result["batchItemFailures"]:
        # Recheck the same run without keeping a Lambda invocation alive. Crash
        # recovery retains the longer queue visibility and fenced DB lease.
        queue = AwsSqsRenderDispatcher(settings, queue_url=settings.observable_build_queue_url)
        await queue.change_visibility(event["Records"][0]["receiptHandle"], 60)
    return result


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del context
    return asyncio.run(_production(event))
