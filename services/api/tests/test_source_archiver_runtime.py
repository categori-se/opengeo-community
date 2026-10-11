import asyncio
import hashlib
import json
from collections import deque
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.rds_data import DataApiResult
from opengeo_api.source_archive_dispatch import SourceArchiveDispatchUnavailable
from opengeo_api.source_archiver import (
    FetchedArchive,
    SourceArchiveFailure,
    StoredArchive,
)
from opengeo_api.source_archiver_runtime import (
    CompletedSourceArchive,
    RdsDataSourceArchiveCoordinator,
    SourceArchiveClaim,
    SourceArchiveCommand,
    SourceArchiveCommandInvalid,
    SourceArchiveDependencyUnavailable,
    SourceArchiveProcessor,
    SourceArchiverRuntimeSettings,
    handle_sqs_event,
    parse_source_archive_command,
)

JOB_ID = UUID("91000000-0000-4000-8000-000000000001")
WORKER_ID = UUID("92000000-0000-4000-8000-000000000001")
ARTIFACT_ID = UUID("93000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
SOURCE_ID = UUID("80000000-0000-4000-8000-000000000001")
DESTINATION_ID = UUID("81000000-0000-4000-8000-000000000001")
BUCKET = "opengeo-geodata"
KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DESTINATION_ID}/"
    f"uploads/{JOB_ID}/original/snapshot.png"
)
FEATURE_KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DESTINATION_ID}/"
    f"uploads/{JOB_ID}/original/snapshot.geojson"
)
PNG = b"\x89PNG\r\n\x1a\nsource"
SHA256 = hashlib.sha256(PNG).hexdigest()


def claim() -> SourceArchiveClaim:
    return SourceArchiveClaim(
        snapshot_job_id=JOB_ID,
        organization_id=ORG_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_ID,
        source_revision_number=3,
        source_type="wms",
        source_url="https://maps.example.com/wms",
        source_configuration={
            "version": "1.3.0",
            "layers": ["massgis:wetlands"],
            "styles": [""],
            "format": "image/png",
            "transparent": True,
            "crs": "EPSG:3857",
            "tile_size": 256,
            "attribution": "MassGIS",
        },
        copy_method="bounded_map_capture",
        capture_scope={
            "kind": "bounded_image",
            "bounds": [-71.5, 42.0, -71.0, 42.5],
            "width": 64,
            "height": 64,
        },
        maximum_requests=1,
        maximum_output_bytes=81_920,
        output_content_type="image/png",
        attribution="MassGIS",
        destination_dataset_id=DESTINATION_ID,
        destination_bucket=BUCKET,
        output_object_key=KEY,
        request_checksum_sha256="f" * 64,
        attempt_count=1,
    )


def feature_claim() -> SourceArchiveClaim:
    return SourceArchiveClaim(
        snapshot_job_id=JOB_ID,
        organization_id=ORG_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_ID,
        source_revision_number=4,
        source_type="arcgis",
        source_url="https://services.example.com/ArcGIS/rest/services/facilities/FeatureServer/0",
        source_configuration={
            "object_id_field": "OBJECTID",
            "fields": ["OBJECTID", "name"],
            "geometry_type": "Point",
            "page_size": 1000,
            "attribution": "Example agency",
        },
        copy_method="bounded_feature_capture",
        capture_scope={
            "kind": "bounded_features",
            "bounds": [-71.5, 42.0, -71.0, 42.5],
            "maximum_features": 1500,
            "page_size": 1000,
        },
        maximum_requests=2,
        maximum_output_bytes=24_641_536,
        output_content_type="application/geo+json",
        attribution="Example agency",
        destination_dataset_id=DESTINATION_ID,
        destination_bucket=BUCKET,
        output_object_key=FEATURE_KEY,
        request_checksum_sha256="e" * 64,
        attempt_count=1,
    )


def claim_row(**changes: Any) -> tuple[Any, ...]:
    row: list[Any] = [
        "claimed",
        JOB_ID,
        ORG_ID,
        PROJECT_ID,
        SOURCE_ID,
        3,
        "wms",
        "https://maps.example.com/wms",
        dict(claim().source_configuration),
        "bounded_map_capture",
        dict(claim().capture_scope),
        1,
        81_920,
        "png",
        "image/png",
        "MassGIS",
        DESTINATION_ID,
        BUCKET,
        KEY,
        "f" * 64,
        1,
    ]
    indexes = {
        "status": 0,
        "job_id": 1,
        "source_type": 6,
        "source_url": 7,
        "source_configuration": 8,
        "copy_method": 9,
        "capture_scope": 10,
        "maximum_requests": 11,
        "maximum_output_bytes": 12,
        "output_format": 13,
        "output_content_type": 14,
        "destination_bucket": 17,
        "output_object_key": 18,
        "attempt_count": 20,
    }
    for name, value in changes.items():
        row[indexes[name]] = value
    return tuple(row)


def completed_row(**changes: Any) -> tuple[Any, ...]:
    row: list[Any] = [
        JOB_ID,
        BUCKET,
        KEY,
        "version-1",
        "0123456789abcdef",
        "image/png",
        len(PNG),
        SHA256,
    ]
    indexes = {
        "job_id": 0,
        "bucket": 1,
        "object_key": 2,
        "s3_version_id": 3,
        "etag": 4,
        "content_type": 5,
        "size_bytes": 6,
        "checksum_sha256": 7,
    }
    for name, value in changes.items():
        row[indexes[name]] = value
    return tuple(row)


class DataApi:
    def __init__(self, results: list[DataApiResult]) -> None:
        self.results = deque(results)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, statement, parameters=(), transaction_id=None):
        assert transaction_id is None
        self.calls.append((statement, tuple(parameters)))
        assert self.results
        return self.results.popleft()


def result(*records: tuple[Any, ...]) -> DataApiResult:
    return DataApiResult(tuple(records), 0)


def test_rds_coordinator_claims_only_exact_sealed_database_facts() -> None:
    data_api = DataApi([result(claim_row())])
    coordinator = RdsDataSourceArchiveCoordinator(data_api, expected_bucket=BUCKET)

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 600))

    assert record == claim()
    assert data_api.calls[0][1] == (JOB_ID, WORKER_ID, 600)
    assert "app.claim_external_source_snapshot" in data_api.calls[0][0]


def test_rds_coordinator_accepts_exact_bounded_feature_archive_tuple() -> None:
    expected = feature_claim()
    row = list(claim_row())
    row[5] = expected.source_revision_number
    row[6] = expected.source_type
    row[7] = expected.source_url
    row[8] = expected.source_configuration
    row[9] = expected.copy_method
    row[10] = expected.capture_scope
    row[11] = expected.maximum_requests
    row[12] = expected.maximum_output_bytes
    row[13] = "geojson"
    row[14] = expected.output_content_type
    row[15] = expected.attribution
    row[18] = expected.output_object_key
    row[19] = expected.request_checksum_sha256
    coordinator = RdsDataSourceArchiveCoordinator(
        DataApi([result(tuple(row))]),
        expected_bucket=BUCKET,
    )

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 600))

    assert record == expected


def test_rds_coordinator_recovers_completed_geojson_artifact() -> None:
    body = b'{"type":"FeatureCollection","features":[]}'
    row = list(claim_row(status="already_completed"))
    row[6] = "arcgis"
    row[9] = "bounded_feature_capture"
    row[10] = feature_claim().capture_scope
    row[11] = 2
    row[12] = 24_641_536
    row[13] = "geojson"
    row[14] = "application/geo+json"
    row[18] = FEATURE_KEY
    completed = completed_row(
        object_key=FEATURE_KEY,
        content_type="application/geo+json",
        size_bytes=len(body),
        checksum_sha256=hashlib.sha256(body).hexdigest(),
    )
    coordinator = RdsDataSourceArchiveCoordinator(
        DataApi([result(tuple(row)), result(completed)]),
        expected_bucket=BUCKET,
    )

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 600))

    assert isinstance(record, CompletedSourceArchive)
    assert record.artifact.object_key == FEATURE_KEY
    assert record.artifact.content_type == "application/geo+json"


def test_rds_coordinator_recovers_exact_completed_object_facts_for_replay() -> None:
    data_api = DataApi(
        [
            result(claim_row(status="already_completed")),
            result(completed_row()),
        ]
    )
    coordinator = RdsDataSourceArchiveCoordinator(data_api, expected_bucket=BUCKET)

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 600))

    assert record == CompletedSourceArchive(
        JOB_ID,
        StoredArchive(
            BUCKET,
            KEY,
            "version-1",
            "0123456789abcdef",
            "image/png",
            len(PNG),
            SHA256,
        ),
    )
    assert "app.get_completed_external_source_snapshot_artifact" in data_api.calls[1][0]
    assert data_api.calls[1][1] == (JOB_ID,)


@pytest.mark.parametrize(
    "changes",
    [
        {"job_id": UUID("91000000-0000-4000-8000-000000000002")},
        {"source_type": "xyz"},
        {"copy_method": "exact_object_copy"},
        {"maximum_requests": 2},
        {"maximum_output_bytes": 536_870_913},
        {"destination_bucket": "other-bucket"},
        {"output_object_key": "organizations/wrong"},
        {"attempt_count": 4},
    ],
)
def test_rds_coordinator_rejects_malformed_or_redirected_claims(
    changes: dict[str, Any],
) -> None:
    coordinator = RdsDataSourceArchiveCoordinator(
        DataApi([result(claim_row(**changes))]),
        expected_bucket=BUCKET,
    )
    with pytest.raises(SourceArchiveDependencyUnavailable):
        asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 600))


def test_rds_coordinator_calls_only_fixed_lifecycle_functions() -> None:
    data_api = DataApi(
        [
            result((True,)),
            result((True,)),
            result((True,)),
            result(("queued",)),
        ]
    )
    coordinator = RdsDataSourceArchiveCoordinator(data_api, expected_bucket=BUCKET)
    artifact = {
        "id": str(ARTIFACT_ID),
        "role": "original",
        "bucket": BUCKET,
        "object_key": KEY,
        "s3_version_id": "version-1",
        "etag": "0123456789abcdef",
        "content_type": "image/png",
        "size_bytes": len(PNG),
        "checksum_sha256": SHA256,
    }

    assert asyncio.run(coordinator.heartbeat(JOB_ID, WORKER_ID, 600)) is True
    assert asyncio.run(coordinator.complete(JOB_ID, WORKER_ID, artifact)) is True
    assert asyncio.run(coordinator.fail(JOB_ID, WORKER_ID, "response_invalid")) is True
    assert asyncio.run(coordinator.release(JOB_ID, WORKER_ID, "archive_timeout")) == "queued"

    statements = [call[0] for call in data_api.calls]
    assert "app.heartbeat_external_source_snapshot" in statements[0]
    assert "app.complete_external_source_snapshot" in statements[1]
    assert "app.fail_external_source_snapshot" in statements[2]
    assert "app.release_external_source_snapshot" in statements[3]
    assert "https://maps.example.com" not in repr(data_api.calls)


class Coordinator:
    def __init__(
        self,
        *,
        record: SourceArchiveClaim | None = None,
        heartbeat: bool = True,
        complete: bool = True,
        fail: bool = True,
        release: str = "queued",
    ) -> None:
        self.record = record if record is not None else claim()
        self.heartbeat_result = heartbeat
        self.complete_result = complete
        self.fail_result = fail
        self.release_result = release
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def claim(self, snapshot_job_id, worker_token, lease_seconds):
        self.calls.append(("claim", (snapshot_job_id, worker_token, lease_seconds)))
        return self.record

    async def heartbeat(self, snapshot_job_id, worker_token, lease_seconds):
        self.calls.append(("heartbeat", (snapshot_job_id, worker_token, lease_seconds)))
        return self.heartbeat_result

    async def complete(self, snapshot_job_id, worker_token, artifact):
        self.calls.append(("complete", (snapshot_job_id, worker_token, artifact)))
        return self.complete_result

    async def fail(self, snapshot_job_id, worker_token, error_code):
        self.calls.append(("fail", (snapshot_job_id, worker_token, error_code)))
        return self.fail_result

    async def release(self, snapshot_job_id, worker_token, error_code):
        self.calls.append(("release", (snapshot_job_id, worker_token, error_code)))
        return self.release_result


class Fetcher:
    def __init__(self, error: SourceArchiveFailure | None = None) -> None:
        self.error = error
        self.specs = []

    async def fetch(self, spec, destination):
        self.specs.append(spec)
        if self.error is not None:
            raise self.error
        _write_bytes(destination, PNG)
        return FetchedArchive("image/png", len(PNG), SHA256)


class Storage:
    def __init__(self, bucket: str = BUCKET) -> None:
        self._bucket = bucket
        self.calls = []

    @property
    def bucket(self) -> str:
        return self._bucket

    async def store(self, object_key, source, fetched):
        body = _read_bytes(source)
        self.calls.append((object_key, body, fetched))
        return StoredArchive(
            self._bucket,
            object_key,
            "version-1",
            "0123456789abcdef",
            fetched.content_type,
            fetched.size_bytes,
            fetched.checksum_sha256,
        )


class Dispatcher:
    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.calls: list[tuple[UUID, StoredArchive]] = []

    async def dispatch(self, snapshot_job_id, artifact):
        self.calls.append((snapshot_job_id, artifact))
        if self.failures:
            self.failures -= 1
            raise SourceArchiveDispatchUnavailable("queue unavailable")


def _write_bytes(path: Any, body: bytes) -> None:
    path.write_bytes(body)


def _read_bytes(path: Any) -> bytes:
    return path.read_bytes()


def uuid_factory():
    values = iter((WORKER_ID, ARTIFACT_ID))
    return lambda: next(values)


def test_processor_fetches_stores_heartbeats_and_completes_exact_artifact() -> None:
    coordinator = Coordinator()
    fetcher = Fetcher()
    storage = Storage()
    dispatcher = Dispatcher()
    processor = SourceArchiveProcessor(
        coordinator,
        fetcher,
        storage,
        dispatcher,
        uuid_factory=uuid_factory(),
    )

    assert asyncio.run(processor.process(SourceArchiveCommand(JOB_ID))) is True

    assert [name for name, _ in coordinator.calls] == [
        "claim",
        "heartbeat",
        "heartbeat",
        "complete",
    ]
    artifact = coordinator.calls[-1][1][2]
    assert artifact == {
        "id": str(ARTIFACT_ID),
        "role": "original",
        "bucket": BUCKET,
        "object_key": KEY,
        "s3_version_id": "version-1",
        "etag": "0123456789abcdef",
        "content_type": "image/png",
        "size_bytes": len(PNG),
        "checksum_sha256": SHA256,
    }
    assert storage.calls[0][0:2] == (KEY, PNG)
    assert dispatcher.calls == [
        (
            JOB_ID,
            StoredArchive(
                BUCKET,
                KEY,
                "version-1",
                "0123456789abcdef",
                "image/png",
                len(PNG),
                SHA256,
            ),
        )
    ]


def test_processor_records_terminal_fetch_rejection_without_queue_retry() -> None:
    coordinator = Coordinator()
    processor = SourceArchiveProcessor(
        coordinator,
        Fetcher(SourceArchiveFailure("unsafe_network_target", retryable=False)),
        Storage(),
        Dispatcher(),
        uuid_factory=lambda: WORKER_ID,
    )

    assert asyncio.run(processor.process(SourceArchiveCommand(JOB_ID))) is False
    assert [name for name, _ in coordinator.calls] == ["claim", "fail"]
    assert coordinator.calls[-1][1][-1] == "unsafe_network_target"


def test_processor_releases_transient_failure_and_requests_sqs_retry() -> None:
    coordinator = Coordinator(release="queued")
    processor = SourceArchiveProcessor(
        coordinator,
        Fetcher(SourceArchiveFailure("archive_timeout", retryable=True)),
        Storage(),
        Dispatcher(),
        uuid_factory=lambda: WORKER_ID,
    )

    with pytest.raises(SourceArchiveDependencyUnavailable):
        asyncio.run(processor.process(SourceArchiveCommand(JOB_ID)))
    assert [name for name, _ in coordinator.calls] == ["claim", "release"]
    assert coordinator.calls[-1][1][-1] == "archive_timeout"


def test_processor_acks_after_database_marks_third_transient_attempt_failed() -> None:
    coordinator = Coordinator(release="failed")
    processor = SourceArchiveProcessor(
        coordinator,
        Fetcher(SourceArchiveFailure("upstream_unavailable", retryable=True)),
        Storage(),
        Dispatcher(),
        uuid_factory=lambda: WORKER_ID,
    )

    assert asyncio.run(processor.process(SourceArchiveCommand(JOB_ID))) is False
    assert coordinator.calls[-1][0] == "release"


def test_processor_never_stores_after_lease_loss() -> None:
    coordinator = Coordinator(heartbeat=False, release="queued")
    storage = Storage()
    processor = SourceArchiveProcessor(
        coordinator,
        Fetcher(),
        storage,
        Dispatcher(),
        uuid_factory=lambda: WORKER_ID,
    )

    with pytest.raises(SourceArchiveDependencyUnavailable):
        asyncio.run(processor.process(SourceArchiveCommand(JOB_ID)))
    assert storage.calls == []
    assert [name for name, _ in coordinator.calls] == ["claim", "heartbeat", "release"]


def test_processor_rejects_database_bucket_redirect_before_fetch() -> None:
    redirected = replace(claim(), destination_bucket="attacker-bucket")
    coordinator = Coordinator(record=redirected)
    fetcher = Fetcher()
    processor = SourceArchiveProcessor(
        coordinator,
        fetcher,
        Storage(),
        Dispatcher(),
        uuid_factory=lambda: WORKER_ID,
    )

    assert asyncio.run(processor.process(SourceArchiveCommand(JOB_ID))) is False
    assert fetcher.specs == []
    assert coordinator.calls[-1][0] == "fail"


def test_processor_retries_dispatch_after_database_completion_without_refetching() -> None:
    first_coordinator = Coordinator(release="lost")
    first_dispatcher = Dispatcher(failures=1)
    first_fetcher = Fetcher()
    first_storage = Storage()
    first_processor = SourceArchiveProcessor(
        first_coordinator,
        first_fetcher,
        first_storage,
        first_dispatcher,
        uuid_factory=uuid_factory(),
    )

    with pytest.raises(SourceArchiveDependencyUnavailable):
        asyncio.run(first_processor.process(SourceArchiveCommand(JOB_ID)))
    assert [name for name, _ in first_coordinator.calls] == [
        "claim",
        "heartbeat",
        "heartbeat",
        "complete",
        "release",
    ]
    assert len(first_storage.calls) == 1

    stored = first_dispatcher.calls[0][1]
    retry_coordinator = Coordinator(record=CompletedSourceArchive(JOB_ID, stored))
    retry_dispatcher = Dispatcher()
    retry_fetcher = Fetcher()
    retry_storage = Storage()
    retry_processor = SourceArchiveProcessor(
        retry_coordinator,
        retry_fetcher,
        retry_storage,
        retry_dispatcher,
        uuid_factory=lambda: WORKER_ID,
    )

    assert asyncio.run(retry_processor.process(SourceArchiveCommand(JOB_ID))) is False
    assert [name for name, _ in retry_coordinator.calls] == ["claim"]
    assert retry_fetcher.specs == []
    assert retry_storage.calls == []
    assert retry_dispatcher.calls == [(JOB_ID, stored)]


def test_command_parser_accepts_only_uuid_identity_and_exact_schema() -> None:
    body = json.dumps(
        {
            "schema": "opengeo.external-source-snapshot.command.1.0.0",
            "snapshot_job_id": str(JOB_ID),
        }
    )
    assert parse_source_archive_command(body) == SourceArchiveCommand(JOB_ID)

    invalid = [
        "{}",
        json.dumps({"schema": "wrong", "snapshot_job_id": str(JOB_ID)}),
        json.dumps(
            {
                "schema": "opengeo.external-source-snapshot.command.1.0.0",
                "snapshot_job_id": "ABCDEF00-0000-4000-8000-000000000001",
            }
        ),
        json.dumps(
            {
                "schema": "opengeo.external-source-snapshot.command.1.0.0",
                "snapshot_job_id": str(JOB_ID),
                "source_url": "https://maps.example.com/wms",
            }
        ),
        "x" * 513,
    ]
    for value in invalid:
        with pytest.raises(SourceArchiveCommandInvalid):
            parse_source_archive_command(value)


class EventProcessor:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.commands: list[SourceArchiveCommand] = []

    async def process(self, command):
        self.commands.append(command)
        if self.fail:
            raise SourceArchiveDependencyUnavailable("retry")
        return True


def test_sqs_handler_returns_only_retryable_batch_item_failures() -> None:
    body = json.dumps(
        {
            "schema": "opengeo.external-source-snapshot.command.1.0.0",
            "snapshot_job_id": str(JOB_ID),
        }
    )
    success = EventProcessor()
    assert asyncio.run(
        handle_sqs_event(
            {"Records": [{"messageId": "message-1", "body": body}]},
            success,  # type: ignore[arg-type]
        )
    ) == {"batchItemFailures": []}
    assert success.commands == [SourceArchiveCommand(JOB_ID)]

    failed = EventProcessor(fail=True)
    assert asyncio.run(
        handle_sqs_event(
            {"Records": [{"messageId": "message-2", "body": body}]},
            failed,  # type: ignore[arg-type]
        )
    ) == {"batchItemFailures": [{"itemIdentifier": "message-2"}]}


def runtime_environment() -> dict[str, str]:
    return {
        "OPEN_GEO_SOURCE_ARCHIVER_STAGE": "dev",
        "OPEN_GEO_DATA_API_REGION": "us-east-1",
        "OPEN_GEO_DATA_API_CLUSTER_ARN": (
            "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless"
        ),
        "OPEN_GEO_DATA_API_SECRET_ARN": (
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/source-AbCd"
        ),
        "OPEN_GEO_GEODATA_BUCKET": BUCKET,
        "OPEN_GEO_GEODATA_KMS_KEY_ARN": (
            "arn:aws:kms:us-east-1:111111111111:key/1234abcd-1234-4567-89ab-123456789abc"
        ),
        "OPEN_GEO_PROCESSING_QUEUE_URL": (
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
        "OPEN_GEO_DB_NAME": "opengeo",
    }


def test_runtime_settings_bind_database_storage_region_account_and_bucket() -> None:
    settings = SourceArchiverRuntimeSettings.from_environment(runtime_environment())
    assert settings.region == "us-east-1"
    assert settings.geodata_bucket == BUCKET
    assert settings.account_id == "111111111111"
    assert settings.processing_queue_url.endswith("/opengeo-processing")
    assert settings.data_api_settings().data_api_configured is True

    for key, value in [
        ("OPEN_GEO_SOURCE_ARCHIVER_STAGE", "test"),
        ("OPEN_GEO_AWS_REGION", "us-west-2"),
        (
            "OPEN_GEO_GEODATA_KMS_KEY_ARN",
            "arn:aws:kms:us-east-1:222222222222:key/1234abcd",
        ),
        ("OPEN_GEO_GEODATA_BUCKET", "127.0.0.1"),
        (
            "OPEN_GEO_PROCESSING_QUEUE_URL",
            "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-processing",
        ),
        (
            "OPEN_GEO_PROCESSING_QUEUE_URL",
            "https://sqs.us-east-1.amazonaws.com/222222222222/opengeo-processing",
        ),
    ]:
        environment = runtime_environment()
        environment[key] = value
        with pytest.raises(SourceArchiveDependencyUnavailable):
            SourceArchiverRuntimeSettings.from_environment(environment)


def test_processor_transports_server_count_summary_with_exact_stored_object():
    summary = {
        "schemaVersion": "opengeo.feature-capture-counts.1.0.0",
        "sourceType": "arcgis",
        "fetchedCount": 3,
        "numberMatched": 3,
        "countStatus": "matched_bounded_scope",
        "limitedByMaximumFeatures": False,
        "scope": {"kind": "bounded_features", "maximum_features": 3},
    }

    class CountedFetcher(Fetcher):
        async def fetch(self, spec, destination):
            return replace(await super().fetch(spec, destination), count_evidence=summary)

    coordinator = Coordinator()
    storage = Storage()
    processor = SourceArchiveProcessor(
        coordinator, CountedFetcher(), storage, Dispatcher(), uuid_factory=uuid_factory()
    )
    assert asyncio.run(processor.process(SourceArchiveCommand(JOB_ID))) is True
    artifact = coordinator.calls[-1][1][2]
    assert artifact["count_evidence"] == summary
    assert artifact["checksum_sha256"] == storage.calls[0][2].checksum_sha256
    assert artifact["s3_version_id"] == "version-1"
