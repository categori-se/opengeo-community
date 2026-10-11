import asyncio
import base64
import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.repository_object_copier_runtime import (
    CompletedRepositoryCopy,
    RepositoryCopyClaim,
    RepositoryCopyCommand,
    RepositoryCopyCommandInvalid,
    RepositoryCopyDependencyUnavailable,
    RepositoryCopyFailure,
    RepositoryObjectCopyProcessor,
    S3ExactVersionFetcher,
    handle_event,
    parse_command,
)
from opengeo_api.source_archiver import FetchedArchive, SourceArchiveFailure, StoredArchive
from opengeo_api.user_dataset_verification_runtime import DatasetConnectionCredentials

JOB_ID = UUID("91000000-0000-4000-8000-000000000066")
ORG_ID = UUID("10000000-0000-4000-8000-000000000066")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000066")
SOURCE_ID = UUID("80000000-0000-4000-8000-000000000066")
DESTINATION_ID = UUID("81000000-0000-4000-8000-000000000066")
OWNER_ID = UUID("20000000-0000-4000-8000-000000000066")
CONNECTION_ID = UUID("a0000000-0000-4000-8000-000000000066")
BODY = b'{"type":"FeatureCollection","features":[]}'
CHECKSUM = hashlib.sha256(BODY).hexdigest()
KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DESTINATION_ID}/"
    f"uploads/{JOB_ID}/original/source.geojson"
)
TASK_CREDENTIALS = AwsCredentials("TASKACCESSKEY", "task-secret", "task-token")
SOURCE_CREDENTIALS = AwsCredentials("SOURCEACCESSKEY", "source-secret", "source-token")


def claim(**changes: Any) -> RepositoryCopyClaim:
    values: dict[str, Any] = {
        "copy_job_id": JOB_ID,
        "organization_id": ORG_ID,
        "project_id": PROJECT_ID,
        "source_dataset_id": SOURCE_ID,
        "source_owner_user_id": OWNER_ID,
        "connection_id": CONNECTION_ID,
        "connection_target_revision": 2,
        "credential_revision": 3,
        "credential_mode": "access_key",
        "role_arn": None,
        "secret_reference": "arn:aws:secretsmanager:us-east-1:111111111111:secret:exact",
        "source_bucket": "source-bucket",
        "source_region": "us-east-1",
        "source_object_key": "ma/source.geojson",
        "source_version_id": "provider-version-7",
        "source_etag": '"0123456789abcdef"',
        "source_checksum_sha256": base64.b64encode(bytes.fromhex(CHECKSUM)).decode(),
        "output_format": "geojson",
        "output_content_type": "application/geo+json",
        "maximum_output_bytes": len(BODY),
        "destination_dataset_id": DESTINATION_ID,
        "destination_bucket": "opengeo-geodata",
        "output_object_key": KEY,
        "request_checksum_sha256": "b" * 64,
        "attribution": "Example agency",
        "attempt_count": 1,
    }
    values.update(changes)
    return RepositoryCopyClaim(**values)


def stored() -> StoredArchive:
    return StoredArchive(
        "opengeo-geodata",
        KEY,
        "archive-version-1",
        "0123456789abcdef",
        "application/geo+json",
        len(BODY),
        CHECKSUM,
    )


class Coordinator:
    def __init__(
        self, claimed: RepositoryCopyClaim | CompletedRepositoryCopy | None = None
    ) -> None:
        self.claimed = claimed if claimed is not None else claim()
        self.completed: list[dict[str, Any]] = []
        self.failed: list[str] = []
        self.released: list[str] = []

    async def claim(self, copy_job_id, worker_token, lease_seconds):
        assert copy_job_id == JOB_ID
        assert lease_seconds == 900
        self.worker_token = worker_token
        return self.claimed

    async def heartbeat(self, copy_job_id, worker_token, lease_seconds):
        assert (copy_job_id, worker_token, lease_seconds) == (JOB_ID, self.worker_token, 900)
        return True

    async def complete(self, copy_job_id, worker_token, artifact):
        assert (copy_job_id, worker_token) == (JOB_ID, self.worker_token)
        self.completed.append(dict(artifact))
        return True

    async def fail(self, copy_job_id, worker_token, error_code):
        assert (copy_job_id, worker_token) == (JOB_ID, self.worker_token)
        self.failed.append(error_code)
        return True

    async def release(self, copy_job_id, worker_token, error_code):
        assert (copy_job_id, worker_token) == (JOB_ID, self.worker_token)
        self.released.append(error_code)
        return "queued"


class SecretLoader:
    async def load(self, credential_claim):
        assert credential_claim.connection_id == CONNECTION_ID
        assert credential_claim.target_revision == 2
        return DatasetConnectionCredentials(
            {
                "access_key_id": SOURCE_CREDENTIALS.access_key_id,
                "secret_access_key": SOURCE_CREDENTIALS.secret_access_key,
                "session_token": SOURCE_CREDENTIALS.session_token or "",
            }
        )


class RoleAssumer:
    async def assume(self, role_arn, external_id):
        raise AssertionError((role_arn, external_id))


class TaskCredentials:
    def load(self):
        return TASK_CREDENTIALS


class Fetcher:
    def __init__(self, failure: RepositoryCopyFailure | None = None) -> None:
        self.failure = failure
        self.credentials = None

    async def fetch(self, copy_claim, credentials, destination: Path):
        assert copy_claim == claim()
        self.credentials = credentials
        if self.failure:
            raise self.failure
        await asyncio.to_thread(destination.write_bytes, BODY)
        return FetchedArchive("application/geo+json", len(BODY), CHECKSUM)


class Storage:
    bucket = "opengeo-geodata"

    def __init__(self, failure: SourceArchiveFailure | None = None) -> None:
        self.failure = failure

    async def store(self, object_key, source, fetched):
        assert object_key == KEY
        assert source.read_bytes() == BODY
        assert fetched.checksum_sha256 == CHECKSUM
        if self.failure:
            raise self.failure
        return stored()


class Dispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[UUID, StoredArchive]] = []

    async def dispatch(self, copy_job_id, artifact):
        self.calls.append((copy_job_id, artifact))


def processor(
    coordinator: Coordinator, fetcher: Fetcher, storage: Storage, dispatcher: Dispatcher
) -> RepositoryObjectCopyProcessor:
    return RepositoryObjectCopyProcessor(
        coordinator,  # type: ignore[arg-type]
        SecretLoader(),  # type: ignore[arg-type]
        RoleAssumer(),  # type: ignore[arg-type]
        TaskCredentials(),  # type: ignore[arg-type]
        fetcher,
        storage,
        dispatcher,
    )


def test_command_contains_only_the_sealed_database_identity() -> None:
    assert parse_command(
        json.dumps(
            {
                "schema": "opengeo.repository-object-copy.command.1.0.0",
                "copy_job_id": str(JOB_ID),
            }
        )
    ) == RepositoryCopyCommand(JOB_ID)
    for payload in (
        {},
        {"schema": "wrong", "copy_job_id": str(JOB_ID)},
        {
            "schema": "opengeo.repository-object-copy.command.1.0.0",
            "copy_job_id": str(JOB_ID),
            "source_bucket": "must-not-cross-queue",
        },
    ):
        with pytest.raises(RepositoryCopyCommandInvalid):
            parse_command(json.dumps(payload))


def test_processor_streams_exact_source_then_seals_and_dispatches_ingestion() -> None:
    coordinator = Coordinator()
    fetcher = Fetcher()
    dispatcher = Dispatcher()

    assert asyncio.run(
        processor(coordinator, fetcher, Storage(), dispatcher).process(
            RepositoryCopyCommand(JOB_ID)
        )
    )

    assert fetcher.credentials == SOURCE_CREDENTIALS
    assert coordinator.completed[0]["object_key"] == KEY
    assert coordinator.completed[0]["checksum_sha256"] == CHECKSUM
    assert coordinator.failed == []
    assert coordinator.released == []
    assert dispatcher.calls == [(JOB_ID, stored())]


def test_processor_fails_changed_source_and_releases_transient_source_failure() -> None:
    terminal = Coordinator()
    terminal_fetcher = Fetcher(RepositoryCopyFailure("source_object_changed", retryable=False))
    assert asyncio.run(
        processor(terminal, terminal_fetcher, Storage(), Dispatcher()).process(
            RepositoryCopyCommand(JOB_ID)
        )
    )
    assert terminal.failed == ["source_object_changed"]
    assert terminal.completed == []

    transient = Coordinator()
    transient_fetcher = Fetcher(RepositoryCopyFailure("source_unavailable", retryable=True))
    with pytest.raises(RepositoryCopyDependencyUnavailable):
        asyncio.run(
            processor(transient, transient_fetcher, Storage(), Dispatcher()).process(
                RepositoryCopyCommand(JOB_ID)
            )
        )
    assert transient.released == ["source_unavailable"]


def test_completed_copy_retries_only_the_idempotent_ingestion_dispatch() -> None:
    coordinator = Coordinator(CompletedRepositoryCopy(JOB_ID, stored()))
    dispatcher = Dispatcher()

    assert asyncio.run(
        processor(coordinator, Fetcher(), Storage(), dispatcher).process(
            RepositoryCopyCommand(JOB_ID)
        )
    )

    assert coordinator.completed == []
    assert dispatcher.calls == [(JOB_ID, stored())]


def test_exact_s3_response_must_match_all_registered_object_facts() -> None:
    fetcher = S3ExactVersionFetcher()
    matching = {
        "content-length": str(len(BODY)),
        "x-amz-version-id": "provider-version-7",
        "etag": '"0123456789abcdef"',
        "content-type": "application/geo+json; charset=utf-8",
    }
    fetcher._validate_headers(claim(), matching)

    for changed in (
        {**matching, "content-length": str(len(BODY) + 1)},
        {**matching, "x-amz-version-id": "latest"},
        {**matching, "etag": '"ffffffffffffffff"'},
        {**matching, "content-type": "application/json"},
    ):
        with pytest.raises(RepositoryCopyFailure) as failure:
            fetcher._validate_headers(claim(), changed)
        assert failure.value.code == "source_object_changed"
        assert failure.value.retryable is False


def test_queue_handler_returns_only_failed_record_id_without_sensitive_facts() -> None:
    class EventProcessor:
        async def process(self, command):
            assert command.copy_job_id == JOB_ID
            raise RepositoryCopyDependencyUnavailable("retry")

    result = asyncio.run(
        handle_event(
            {
                "Records": [
                    {
                        "messageId": "message-1",
                        "body": json.dumps(
                            {
                                "schema": "opengeo.repository-object-copy.command.1.0.0",
                                "copy_job_id": str(JOB_ID),
                            }
                        ),
                    }
                ]
            },
            EventProcessor(),  # type: ignore[arg-type]
        )
    )
    assert result == {"batchItemFailures": [{"itemIdentifier": "message-1"}]}
    assert "source-bucket" not in repr(result)
