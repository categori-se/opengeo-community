from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.cognito_provisioning import AwsCredentialProvider, CredentialProvider
from opengeo_api.config import Settings
from opengeo_api.geonode_federation_runtime import (
    GeoNodeHarvestCommand,
    GeoNodeHarvestDependencyUnavailable,
    GeoNodeHarvestProcessor,
    RdsDataGeoNodeHarvestCoordinator,
)
from opengeo_api.rds_data import DataApiResult, RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.source_archive_dispatch import (
    SourceArchiveDispatchUnavailable,
    SourceArchiveIngestionDispatcher,
)
from opengeo_api.source_archiver import (
    MAXIMUM_OUTPUT_BYTES,
    AnonymousSourceFetcher,
    ArchiveContentType,
    ArchiveCopyMethod,
    ArchiveFetchSpec,
    ArchiveSourceType,
    AwsS3ArchiveStorage,
    FetchedArchive,
    SourceArchiveFailure,
    StoredArchive,
    canonical_artifact_json,
)
from opengeo_api.source_discovery_runtime import (
    RdsDataSourceDiscoveryCoordinator,
    SourceDiscoveryCommand,
    SourceDiscoveryDependencyUnavailable,
    SourceDiscoveryProcessor,
)

_COMMAND_SCHEMA = "opengeo.external-source-snapshot.command.1.0.0"
_DISCOVERY_COMMAND_SCHEMA = "opengeo.external-source-discovery.command.1.0.0"
_GEONODE_HARVEST_COMMAND_SCHEMA = "opengeo.geonode-harvest.command.1.0.0"
_MAXIMUM_COMMAND_BYTES = 512
_LEASE_SECONDS = 600
_ERROR_CODE = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_ETAG = re.compile(r"^[A-Fa-f0-9]{16,128}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class SourceArchiveCommandInvalid(RuntimeError):
    pass


class SourceArchiveDependencyUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SourceArchiveCommand:
    snapshot_job_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class SourceArchiveClaim:
    snapshot_job_id: UUID
    organization_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    source_revision_number: int
    source_type: ArchiveSourceType
    source_url: str
    source_configuration: Mapping[str, Any]
    copy_method: ArchiveCopyMethod
    capture_scope: Mapping[str, Any]
    maximum_requests: int
    maximum_output_bytes: int
    output_content_type: ArchiveContentType
    attribution: str
    destination_dataset_id: UUID
    destination_bucket: str
    output_object_key: str
    request_checksum_sha256: str
    attempt_count: int

    def fetch_spec(self) -> ArchiveFetchSpec:
        return ArchiveFetchSpec(
            self.source_type,
            self.source_url,
            self.source_configuration,
            self.copy_method,
            self.capture_scope,
            self.maximum_requests,
            self.maximum_output_bytes,
            self.output_content_type,
        )


@dataclass(frozen=True, slots=True)
class CompletedSourceArchive:
    snapshot_job_id: UUID
    artifact: StoredArchive


class SourceArchiveCoordinator(Protocol):
    async def claim(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> SourceArchiveClaim | CompletedSourceArchive | None: ...

    async def heartbeat(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> bool: ...

    async def complete(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        artifact: Mapping[str, Any],
    ) -> bool: ...

    async def fail(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool: ...

    async def release(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str: ...


class SourceFetcher(Protocol):
    async def fetch(self, spec: ArchiveFetchSpec, destination: Path) -> FetchedArchive: ...


class ArchiveStorage(Protocol):
    @property
    def bucket(self) -> str: ...

    async def store(
        self,
        object_key: str,
        source: Path,
        fetched: FetchedArchive,
    ) -> StoredArchive: ...


class IngestionDispatcher(Protocol):
    async def dispatch(self, snapshot_job_id: UUID, artifact: StoredArchive) -> None: ...


class SourceArchiveDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


@dataclass(frozen=True, slots=True)
class SourceArchiverRuntimeSettings:
    stage: str
    region: str
    database_cluster_arn: str
    database_secret_arn: str
    geodata_bucket: str
    geodata_kms_key_arn: str
    processing_queue_url: str
    account_id: str
    database_name: str = "opengeo"

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> SourceArchiverRuntimeSettings:
        values = environment if environment is not None else os.environ
        required = {
            "stage": values.get("OPEN_GEO_SOURCE_ARCHIVER_STAGE"),
            "region": values.get("OPEN_GEO_DATA_API_REGION"),
            "database_cluster_arn": values.get("OPEN_GEO_DATA_API_CLUSTER_ARN"),
            "database_secret_arn": values.get("OPEN_GEO_DATA_API_SECRET_ARN"),
            "geodata_bucket": values.get("OPEN_GEO_GEODATA_BUCKET"),
            "geodata_kms_key_arn": values.get("OPEN_GEO_GEODATA_KMS_KEY_ARN"),
            "processing_queue_url": values.get("OPEN_GEO_PROCESSING_QUEUE_URL"),
        }
        if any(value is None for value in required.values()):
            raise SourceArchiveDependencyUnavailable("source archiver configuration is incomplete")
        stage = cast(str, required["stage"])
        region = cast(str, required["region"])
        cluster_arn = cast(str, required["database_cluster_arn"])
        secret_arn = cast(str, required["database_secret_arn"])
        bucket = cast(str, required["geodata_bucket"])
        kms_key_arn = cast(str, required["geodata_kms_key_arn"])
        processing_queue_url = cast(str, required["processing_queue_url"])
        database_name = values.get("OPEN_GEO_DB_NAME", "opengeo")
        explicit_region = values.get("OPEN_GEO_AWS_REGION")
        cluster_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):rds:([^:]+):(\d{12}):cluster:[A-Za-z0-9-]{1,63}",
            cluster_arn,
        )
        secret_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):secretsmanager:([^:]+):(\d{12}):"
            r"secret:[A-Za-z0-9/_+=.@-]+",
            secret_arn,
        )
        kms_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):kms:([^:]+):(\d{12}):key/[A-Za-z0-9-]+",
            kms_key_arn,
        )
        queue_match = re.fullmatch(
            r"https://sqs\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com/"
            r"(\d{12})/[A-Za-z0-9_-]{1,80}",
            processing_queue_url,
        )
        if (
            stage not in {"dev", "staging", "production"}
            or re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region) is None
            or cluster_match is None
            or secret_match is None
            or kms_match is None
            or queue_match is None
            or cluster_match.groups() != secret_match.groups()
            or cluster_match.groups() != kms_match.groups()
            or cluster_match.group(2) != region
            or queue_match.group(1) != region
            or queue_match.group(2) != cluster_match.group(3)
            or (explicit_region is not None and explicit_region != region)
            or database_name != "opengeo"
            or not _valid_bucket(bucket)
        ):
            raise SourceArchiveDependencyUnavailable("source archiver configuration is invalid")
        return cls(
            stage,
            region,
            cluster_arn,
            secret_arn,
            bucket,
            kms_key_arn,
            processing_queue_url,
            cluster_match.group(3),
            database_name,
        )

    def data_api_settings(self) -> Settings:
        return Settings(
            env="test",
            data_api_region=self.region,
            data_api_cluster_arn=self.database_cluster_arn,
            data_api_secret_arn=self.database_secret_arn,
            db_name=self.database_name,
        )


class RdsDataSourceArchiveCoordinator:
    def __init__(self, client: SourceArchiveDataApi, *, expected_bucket: str) -> None:
        if not _valid_bucket(expected_bucket):
            raise ValueError("expected archive bucket is invalid")
        self._client = client
        self._expected_bucket = expected_bucket

    async def claim(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> SourceArchiveClaim | CompletedSourceArchive | None:
        try:
            result = await self._client.execute(
                """
                SELECT claim_status, job_id, organization_id, project_id,
                       source_dataset_id, source_revision_number, source_type,
                       source_url, source_configuration, copy_method,
                       capture_scope, maximum_requests, maximum_output_bytes,
                       output_format, output_content_type, attribution,
                       destination_dataset_id, destination_bucket,
                       output_object_key, request_checksum_sha256, attempt_count
                FROM app.claim_external_source_snapshot(%s, %s, %s)
                """,
                (snapshot_job_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 21:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim returned an invalid result"
            )
        row = result.records[0]
        status = row[0]
        if status not in {
            "claimed",
            "not_ready",
            "busy",
            "already_completed",
            "already_failed",
            "already_cancelled",
        }:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim returned an invalid state"
            )
        if status != "claimed":
            if row[1] is not None and _uuid(row[1]) != snapshot_job_id:
                raise SourceArchiveDependencyUnavailable(
                    "source archive claim returned the wrong identity"
                )
            if status == "already_completed":
                return await self._completed_archive(snapshot_job_id)
            return None
        try:
            claim = _claim_from_row(row)
        except (TypeError, ValueError) as error:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim returned invalid fields"
            ) from error
        if claim.snapshot_job_id != snapshot_job_id:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim returned the wrong identity"
            )
        if claim.destination_bucket != self._expected_bucket:
            raise SourceArchiveDependencyUnavailable(
                "source archive claim returned the wrong destination"
            )
        return claim

    async def _completed_archive(self, snapshot_job_id: UUID) -> CompletedSourceArchive:
        try:
            result = await self._client.execute(
                "SELECT * FROM app.get_completed_external_source_snapshot_artifact(%s)",
                (snapshot_job_id,),
            )
        except RdsDataApiUnavailable as error:
            raise SourceArchiveDependencyUnavailable(
                "completed source archive lookup is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 8:
            raise SourceArchiveDependencyUnavailable(
                "completed source archive lookup returned an invalid result"
            )
        try:
            completed = _completed_archive_from_row(result.records[0])
        except (TypeError, ValueError) as error:
            raise SourceArchiveDependencyUnavailable(
                "completed source archive lookup returned invalid fields"
            ) from error
        if (
            completed.snapshot_job_id != snapshot_job_id
            or completed.artifact.bucket != self._expected_bucket
        ):
            raise SourceArchiveDependencyUnavailable(
                "completed source archive lookup returned the wrong identity"
            )
        return completed

    async def heartbeat(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> bool:
        return await self._boolean_function(
            "heartbeat_external_source_snapshot",
            (snapshot_job_id, worker_token, lease_seconds),
            "heartbeat",
        )

    async def complete(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        artifact: Mapping[str, Any],
    ) -> bool:
        if len(json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()) > 8_192:
            raise SourceArchiveDependencyUnavailable(
                "source archive artifact exceeds the database bound"
            )
        return await self._boolean_function(
            "complete_external_source_snapshot",
            (snapshot_job_id, worker_token, Jsonb(dict(artifact))),
            "completion",
        )

    async def fail(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool:
        _validate_error_code(error_code)
        return await self._boolean_function(
            "fail_external_source_snapshot",
            (snapshot_job_id, worker_token, error_code),
            "failure recording",
        )

    async def release(
        self,
        snapshot_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str:
        _validate_error_code(error_code)
        try:
            result = await self._client.execute(
                "SELECT app.release_external_source_snapshot(%s, %s, %s)",
                (snapshot_job_id, worker_token, error_code),
            )
        except RdsDataApiUnavailable as error:
            raise SourceArchiveDependencyUnavailable(
                "source archive release is unavailable"
            ) from error
        if (
            len(result.records) != 1
            or len(result.records[0]) != 1
            or result.records[0][0] not in {"queued", "failed", "lost"}
        ):
            raise SourceArchiveDependencyUnavailable(
                "source archive release returned an invalid result"
            )
        return cast(str, result.records[0][0])

    async def _boolean_function(
        self,
        function_name: str,
        parameters: tuple[Any, ...],
        operation: str,
    ) -> bool:
        if function_name not in {
            "heartbeat_external_source_snapshot",
            "complete_external_source_snapshot",
            "fail_external_source_snapshot",
        }:
            raise ValueError("source archive function is not allowlisted")
        placeholders = ", ".join("%s" for _ in parameters)
        try:
            result = await self._client.execute(
                f"SELECT app.{function_name}({placeholders})",
                parameters,
            )
        except RdsDataApiUnavailable as error:
            raise SourceArchiveDependencyUnavailable(
                f"source archive {operation} is unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise SourceArchiveDependencyUnavailable(
                f"source archive {operation} returned an invalid result"
            )
        return result.records[0][0]


class SourceArchiveProcessor:
    def __init__(
        self,
        coordinator: SourceArchiveCoordinator,
        fetcher: SourceFetcher,
        storage: ArchiveStorage,
        ingestion_dispatcher: IngestionDispatcher,
        *,
        uuid_factory: Callable[[], UUID] = uuid4,
        lease_seconds: int = _LEASE_SECONDS,
    ) -> None:
        if not 60 <= lease_seconds <= 900:
            raise ValueError("source archive lease is outside the database bound")
        self._coordinator = coordinator
        self._fetcher = fetcher
        self._storage = storage
        self._ingestion_dispatcher = ingestion_dispatcher
        self._uuid_factory = uuid_factory
        self._lease_seconds = lease_seconds

    async def process(self, command: SourceArchiveCommand) -> bool:
        worker_token = self._uuid_factory()
        claim_result = await self._coordinator.claim(
            command.snapshot_job_id,
            worker_token,
            self._lease_seconds,
        )
        if isinstance(claim_result, CompletedSourceArchive):
            await self._dispatch_ingestion(claim_result)
            return False
        if claim_result is None:
            return False
        claim = claim_result
        if claim.destination_bucket != self._storage.bucket:
            return await self._terminal_failure(claim, worker_token, "destination_conflict")

        try:
            with tempfile.TemporaryDirectory(prefix="opengeo-source-archive-") as directory:
                destination = Path(directory) / "source.bin"
                fetched = await self._fetcher.fetch(claim.fetch_spec(), destination)
                await self._require_heartbeat(claim, worker_token)
                stored = await self._storage.store(
                    claim.output_object_key,
                    destination,
                    fetched,
                )
                await self._require_heartbeat(claim, worker_token)
                artifact = canonical_artifact_json(
                    stored,
                    str(self._uuid_factory()),
                )
                if fetched.count_evidence is not None:
                    artifact["count_evidence"] = dict(fetched.count_evidence)
                if not await self._coordinator.complete(
                    claim.snapshot_job_id,
                    worker_token,
                    artifact,
                ):
                    raise SourceArchiveDependencyUnavailable(
                        "source archive completion was rejected"
                    )
                await self._dispatch_ingestion(
                    CompletedSourceArchive(claim.snapshot_job_id, stored)
                )
                return True
        except SourceArchiveFailure as error:
            if error.retryable:
                await self._release_or_raise(claim, worker_token, error.code)
                return False
            return await self._terminal_failure(claim, worker_token, error.code)
        except SourceArchiveDependencyUnavailable:
            await self._release_or_raise(claim, worker_token, "archive_unavailable")
            return False
        except Exception as error:
            await self._release_or_raise(claim, worker_token, "archive_unavailable")
            raise SourceArchiveDependencyUnavailable(
                "source archiver failed unexpectedly"
            ) from error

    async def _dispatch_ingestion(self, completed: CompletedSourceArchive) -> None:
        try:
            await self._ingestion_dispatcher.dispatch(
                completed.snapshot_job_id,
                completed.artifact,
            )
        except SourceArchiveDependencyUnavailable:
            raise
        except SourceArchiveDispatchUnavailable as error:
            raise SourceArchiveDependencyUnavailable(
                "source archive ingestion dispatch is unavailable"
            ) from error
        except Exception as error:
            raise SourceArchiveDependencyUnavailable(
                "source archive ingestion dispatch failed unexpectedly"
            ) from error

    async def _require_heartbeat(
        self,
        claim: SourceArchiveClaim,
        worker_token: UUID,
    ) -> None:
        if not await self._coordinator.heartbeat(
            claim.snapshot_job_id,
            worker_token,
            self._lease_seconds,
        ):
            raise SourceArchiveDependencyUnavailable("source archive lease was lost")

    async def _terminal_failure(
        self,
        claim: SourceArchiveClaim,
        worker_token: UUID,
        error_code: str,
    ) -> bool:
        if not await self._coordinator.fail(
            claim.snapshot_job_id,
            worker_token,
            error_code,
        ):
            raise SourceArchiveDependencyUnavailable(
                "source archive terminal failure could not be recorded"
            )
        return False

    async def _release_or_raise(
        self,
        claim: SourceArchiveClaim,
        worker_token: UUID,
        error_code: str,
    ) -> None:
        state = await self._coordinator.release(
            claim.snapshot_job_id,
            worker_token,
            error_code,
        )
        if state == "failed":
            return
        raise SourceArchiveDependencyUnavailable("source archive retry is required")


def parse_source_archive_command(body: str) -> SourceArchiveCommand:
    if not isinstance(body, str) or not 1 <= len(body.encode("utf-8")) <= _MAXIMUM_COMMAND_BYTES:
        raise SourceArchiveCommandInvalid("source_archive_command_invalid")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise SourceArchiveCommandInvalid("source_archive_command_invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "snapshot_job_id"}:
        raise SourceArchiveCommandInvalid("source_archive_command_invalid")
    if payload.get("schema") != _COMMAND_SCHEMA:
        raise SourceArchiveCommandInvalid("source_archive_command_invalid")
    try:
        snapshot_job_id = _uuid(payload.get("snapshot_job_id"))
    except (TypeError, ValueError) as error:
        raise SourceArchiveCommandInvalid("source_archive_command_invalid") from error
    return SourceArchiveCommand(snapshot_job_id)


def parse_source_discovery_command(body: str) -> SourceDiscoveryCommand:
    if not isinstance(body, str) or not 1 <= len(body.encode("utf-8")) <= _MAXIMUM_COMMAND_BYTES:
        raise SourceArchiveCommandInvalid("source_discovery_command_invalid")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise SourceArchiveCommandInvalid("source_discovery_command_invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "discovery_job_id"}:
        raise SourceArchiveCommandInvalid("source_discovery_command_invalid")
    if payload.get("schema") != _DISCOVERY_COMMAND_SCHEMA:
        raise SourceArchiveCommandInvalid("source_discovery_command_invalid")
    try:
        discovery_job_id = _uuid(payload.get("discovery_job_id"))
    except (TypeError, ValueError) as error:
        raise SourceArchiveCommandInvalid("source_discovery_command_invalid") from error
    return SourceDiscoveryCommand(discovery_job_id)


def parse_geonode_harvest_command(body: str) -> GeoNodeHarvestCommand:
    if not isinstance(body, str) or not 1 <= len(body.encode("utf-8")) <= _MAXIMUM_COMMAND_BYTES:
        raise SourceArchiveCommandInvalid("geonode_harvest_command_invalid")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise SourceArchiveCommandInvalid("geonode_harvest_command_invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "harvest_job_id"}:
        raise SourceArchiveCommandInvalid("geonode_harvest_command_invalid")
    if payload.get("schema") != _GEONODE_HARVEST_COMMAND_SCHEMA:
        raise SourceArchiveCommandInvalid("geonode_harvest_command_invalid")
    try:
        harvest_job_id = _uuid(payload.get("harvest_job_id"))
    except (TypeError, ValueError) as error:
        raise SourceArchiveCommandInvalid("geonode_harvest_command_invalid") from error
    return GeoNodeHarvestCommand(harvest_job_id)


def parse_source_worker_command(
    body: str,
) -> SourceArchiveCommand | SourceDiscoveryCommand | GeoNodeHarvestCommand:
    try:
        payload = json.loads(body)
    except (TypeError, ValueError, UnicodeError) as error:
        raise SourceArchiveCommandInvalid("source_worker_command_invalid") from error
    if isinstance(payload, dict) and payload.get("schema") == _DISCOVERY_COMMAND_SCHEMA:
        return parse_source_discovery_command(body)
    if isinstance(payload, dict) and payload.get("schema") == _GEONODE_HARVEST_COMMAND_SCHEMA:
        return parse_geonode_harvest_command(body)
    return parse_source_archive_command(body)


async def handle_sqs_event(
    event: Mapping[str, Any],
    processor: SourceArchiveProcessor,
    discovery_processor: SourceDiscoveryProcessor | None = None,
    geonode_harvest_processor: GeoNodeHarvestProcessor | None = None,
) -> dict[str, list[dict[str, str]]]:
    records = event.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise SourceArchiveCommandInvalid("source_archive_event_invalid")
    failures: list[dict[str, str]] = []
    for record in records:
        message_id = record.get("messageId") if isinstance(record, dict) else None
        body = record.get("body") if isinstance(record, dict) else None
        if (
            not isinstance(message_id, str)
            or not 1 <= len(message_id) <= 128
            or not isinstance(body, str)
        ):
            raise SourceArchiveCommandInvalid("source_archive_event_invalid")
        try:
            command = parse_source_worker_command(body)
            if isinstance(command, SourceDiscoveryCommand):
                if discovery_processor is None:
                    raise SourceDiscoveryDependencyUnavailable(
                        "source discovery processor is unavailable"
                    )
                await discovery_processor.process(command)
            elif isinstance(command, GeoNodeHarvestCommand):
                if geonode_harvest_processor is None:
                    raise GeoNodeHarvestDependencyUnavailable(
                        "GeoNode harvest processor is unavailable"
                    )
                await geonode_harvest_processor.process(command)
            else:
                await processor.process(command)
        except (
            SourceArchiveCommandInvalid,
            SourceArchiveDependencyUnavailable,
            SourceDiscoveryDependencyUnavailable,
            GeoNodeHarvestDependencyUnavailable,
        ):
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_DEFAULT_PROCESSOR: SourceArchiveProcessor | None = None
_DEFAULT_DISCOVERY_PROCESSOR: SourceDiscoveryProcessor | None = None
_DEFAULT_GEONODE_HARVEST_PROCESSOR: GeoNodeHarvestProcessor | None = None


def default_processor() -> SourceArchiveProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        runtime = SourceArchiverRuntimeSettings.from_environment()
        credentials: CredentialProvider = AwsCredentialProvider()
        data_api = RdsDataApiClient(
            runtime.data_api_settings(),
            credentials=credentials,
        )
        _DEFAULT_PROCESSOR = SourceArchiveProcessor(
            RdsDataSourceArchiveCoordinator(
                data_api,
                expected_bucket=runtime.geodata_bucket,
            ),
            AnonymousSourceFetcher(),
            AwsS3ArchiveStorage(
                region=runtime.region,
                bucket=runtime.geodata_bucket,
                kms_key_arn=runtime.geodata_kms_key_arn,
                credentials=credentials,
            ),
            SourceArchiveIngestionDispatcher(
                region=runtime.region,
                account_id=runtime.account_id,
                queue_url=runtime.processing_queue_url,
                credentials=credentials,
            ),
        )
    return _DEFAULT_PROCESSOR


def default_discovery_processor() -> SourceDiscoveryProcessor:
    global _DEFAULT_DISCOVERY_PROCESSOR
    if _DEFAULT_DISCOVERY_PROCESSOR is None:
        runtime = SourceArchiverRuntimeSettings.from_environment()
        credentials = AwsCredentialProvider()
        data_api = RdsDataApiClient(
            runtime.data_api_settings(),
            credentials=credentials,
        )
        _DEFAULT_DISCOVERY_PROCESSOR = SourceDiscoveryProcessor(
            RdsDataSourceDiscoveryCoordinator(data_api),
            document_storage=AwsS3ArchiveStorage(
                region=runtime.region,
                bucket=runtime.geodata_bucket,
                kms_key_arn=runtime.geodata_kms_key_arn,
                credentials=credentials,
                timeout_seconds=20.0,
            ),
        )
    return _DEFAULT_DISCOVERY_PROCESSOR


def default_geonode_harvest_processor() -> GeoNodeHarvestProcessor:
    global _DEFAULT_GEONODE_HARVEST_PROCESSOR
    if _DEFAULT_GEONODE_HARVEST_PROCESSOR is None:
        runtime = SourceArchiverRuntimeSettings.from_environment()
        data_api = RdsDataApiClient(
            runtime.data_api_settings(),
            credentials=AwsCredentialProvider(),
        )
        _DEFAULT_GEONODE_HARVEST_PROCESSOR = GeoNodeHarvestProcessor(
            RdsDataGeoNodeHarvestCoordinator(data_api)
        )
    return _DEFAULT_GEONODE_HARVEST_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, list[dict[str, str]]]:
    del context
    return asyncio.run(
        handle_sqs_event(
            event,
            default_processor(),
            default_discovery_processor(),
            default_geonode_harvest_processor(),
        )
    )


def _claim_from_row(row: tuple[Any, ...]) -> SourceArchiveClaim:
    source_type = _literal(row[6], {"wms", "pmtiles", "arcgis", "wfs"})
    copy_method = _literal(
        row[9], {"bounded_map_capture", "exact_object_copy", "bounded_feature_capture"}
    )
    output_format = _literal(row[13], {"png", "pmtiles", "geojson"})
    output_content_type = _literal(
        row[14], {"image/png", "application/vnd.pmtiles", "application/geo+json"}
    )
    expected_tuple = {
        ("wms", "bounded_map_capture", "png", "image/png"),
        (
            "pmtiles",
            "exact_object_copy",
            "pmtiles",
            "application/vnd.pmtiles",
        ),
        ("arcgis", "bounded_feature_capture", "geojson", "application/geo+json"),
        ("wfs", "bounded_feature_capture", "geojson", "application/geo+json"),
    }
    if (source_type, copy_method, output_format, output_content_type) not in expected_tuple:
        raise ValueError("invalid source archive contract tuple")
    maximum_requests = _bounded_requests(row[11])
    if source_type in {"wms", "pmtiles"} and maximum_requests != 1:
        raise ValueError("single-object archive request count must be one")
    job_id = _uuid(row[1])
    organization_id = _uuid(row[2])
    project_id = _uuid(row[3])
    source_dataset_id = _uuid(row[4])
    destination_dataset_id = _uuid(row[16])
    expected_filename = {
        "png": "snapshot.png",
        "pmtiles": "source.pmtiles",
        "geojson": "snapshot.geojson",
    }[output_format]
    expected_key = (
        f"organizations/{organization_id}/projects/{project_id}/datasets/"
        f"{destination_dataset_id}/uploads/{job_id}/original/{expected_filename}"
    )
    source_configuration = _mapping(row[8], 16_384)
    capture_scope = _mapping(row[10], 8_192)
    source_url = _bounded_string(row[7], 2_048)
    attribution = _bounded_string(row[15], 1_000)
    destination_bucket = _bounded_string(row[17], 63)
    output_object_key = _bounded_string(row[18], 1_024)
    checksum = _bounded_string(row[19], 64)
    if output_object_key != expected_key or _SHA256.fullmatch(checksum) is None:
        raise ValueError("invalid source archive destination")
    return SourceArchiveClaim(
        job_id,
        organization_id,
        project_id,
        source_dataset_id,
        _positive_int(row[5]),
        cast(ArchiveSourceType, source_type),
        source_url,
        source_configuration,
        cast(ArchiveCopyMethod, copy_method),
        capture_scope,
        maximum_requests,
        _bounded_output_bytes(row[12]),
        cast(ArchiveContentType, output_content_type),
        attribution,
        destination_dataset_id,
        destination_bucket,
        output_object_key,
        checksum,
        _attempt(row[20]),
    )


def _completed_archive_from_row(row: tuple[Any, ...]) -> CompletedSourceArchive:
    snapshot_job_id = _uuid(row[0])
    bucket = _bounded_string(row[1], 63)
    object_key = _bounded_string(row[2], 1_024)
    s3_version_id = _bounded_string(row[3], 1_024)
    etag = _bounded_string(row[4], 128).casefold()
    content_type = _literal(
        row[5], {"image/png", "application/vnd.pmtiles", "application/geo+json"}
    )
    size_bytes = _bounded_output_bytes(row[6])
    checksum = _bounded_string(row[7], 64)
    match = re.fullmatch(
        r"organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/datasets/"
        r"[0-9a-f-]{36}/uploads/(?P<job>[0-9a-f-]{36})/original/"
        r"(?P<filename>snapshot\.png|source\.pmtiles|snapshot\.geojson)",
        object_key,
    )
    expected_type = {
        "snapshot.png": "image/png",
        "source.pmtiles": "application/vnd.pmtiles",
        "snapshot.geojson": "application/geo+json",
    }
    if (
        not _valid_bucket(bucket)
        or s3_version_id == "null"
        or _ETAG.fullmatch(etag) is None
        or _SHA256.fullmatch(checksum) is None
        or match is None
        or _uuid(match.group("job")) != snapshot_job_id
        or content_type != expected_type.get(match.group("filename"))
    ):
        raise ValueError("invalid completed source archive")
    return CompletedSourceArchive(
        snapshot_job_id,
        StoredArchive(
            bucket,
            object_key,
            s3_version_id,
            etag,
            cast(ArchiveContentType, content_type),
            size_bytes,
            checksum,
        ),
    )


def _uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        parsed = UUID(value)
        if str(parsed) == value:
            return parsed
    raise ValueError("invalid UUID")


def _literal(value: Any, allowed: set[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError("invalid literal")
    return value


def _bounded_string(value: Any, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid string")
    return value


def _mapping(value: Any, maximum_bytes: int) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("invalid object")
    if len(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()) > maximum_bytes:
        raise ValueError("object exceeds bound")
    return cast(dict[str, Any], value)


def _positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("invalid positive integer")
    return value


def _bounded_requests(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 64:
        raise ValueError("archive request count is outside the accepted bound")
    return value


def _bounded_output_bytes(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= MAXIMUM_OUTPUT_BYTES
    ):
        raise ValueError("archive output bound is invalid")
    return value


def _attempt(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 3:
        raise ValueError("archive attempt is invalid")
    return value


def _validate_error_code(value: str) -> None:
    if not isinstance(value, str) or len(value) > 100 or _ERROR_CODE.fullmatch(value) is None:
        raise SourceArchiveDependencyUnavailable("source archive error code is invalid")


def _valid_bucket(value: str) -> bool:
    return bool(
        re.fullmatch(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value)
        and ".." not in value
        and ".-" not in value
        and "-." not in value
        and re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", value) is None
    )
