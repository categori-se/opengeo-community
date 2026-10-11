from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol, cast
from uuid import UUID, uuid4

import httpx2
from psycopg.types.json import Jsonb

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.rds_data import DataApiResult, RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.s3_endpoints import object_path, regional_s3_host
from opengeo_api.source_archive_dispatch import (
    SourceArchiveDispatchUnavailable,
    SourceArchiveIngestionDispatcher,
)
from opengeo_api.source_archiver import (
    AwsS3ArchiveStorage,
    FetchedArchive,
    SourceArchiveFailure,
    StoredArchive,
)
from opengeo_api.user_dataset_verification_runtime import (
    AssumeRoleDenied,
    AwsStsRoleAssumer,
    AwsUserDatasetCredentialLoader,
    DatasetVerificationClaim,
    DatasetVerificationDependencyUnavailable,
    DatasetVerificationRejected,
    UserDatasetVerifierSettings,
    _form_query,
    _signed_headers,
)

_COMMAND_SCHEMA = "opengeo.repository-object-copy.command.1.0.0"
_MAXIMUM_COMMAND_BYTES = 1024
_MAXIMUM_COPY_BYTES = 536_870_912
_LEASE_SECONDS = 900
_ERROR_CODE = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_CONTENT_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{2,99}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

CopyFailureCode = Literal[
    "destination_conflict",
    "destination_integrity_failed",
    "destination_unavailable",
    "response_invalid",
    "response_too_large",
    "source_access_denied",
    "source_contract_invalid",
    "source_credentials_invalid",
    "source_object_changed",
    "source_unavailable",
]


class RepositoryCopyCommandInvalid(RuntimeError):
    pass


class RepositoryCopyDependencyUnavailable(RuntimeError):
    pass


class RepositoryCopyFailure(RuntimeError):
    def __init__(self, code: CopyFailureCode, *, retryable: bool) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class RepositoryCopyCommand:
    copy_job_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class RepositoryCopyClaim:
    copy_job_id: UUID
    organization_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    source_owner_user_id: UUID
    connection_id: UUID
    connection_target_revision: int
    credential_revision: int
    credential_mode: str
    role_arn: str | None
    secret_reference: str | None
    source_bucket: str
    source_region: str
    source_object_key: str
    source_version_id: str
    source_etag: str
    source_checksum_sha256: str | None
    output_format: str
    output_content_type: str
    maximum_output_bytes: int
    destination_dataset_id: UUID
    destination_bucket: str
    output_object_key: str
    request_checksum_sha256: str
    attribution: str
    attempt_count: int


@dataclass(frozen=True, slots=True)
class CompletedRepositoryCopy:
    copy_job_id: UUID
    artifact: StoredArchive


class RepositoryCopyDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


class RepositoryCopyCoordinator(Protocol):
    async def claim(
        self, copy_job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> RepositoryCopyClaim | CompletedRepositoryCopy | None: ...

    async def heartbeat(
        self, copy_job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool: ...

    async def complete(
        self, copy_job_id: UUID, worker_token: UUID, artifact: Mapping[str, Any]
    ) -> bool: ...

    async def fail(self, copy_job_id: UUID, worker_token: UUID, error_code: str) -> bool: ...

    async def release(self, copy_job_id: UUID, worker_token: UUID, error_code: str) -> str: ...


class RepositoryObjectFetcher(Protocol):
    async def fetch(
        self,
        claim: RepositoryCopyClaim,
        credentials: AwsCredentials,
        destination: Path,
    ) -> FetchedArchive: ...


class ArchiveStorage(Protocol):
    @property
    def bucket(self) -> str: ...

    async def store(
        self, object_key: str, source: Path, fetched: FetchedArchive
    ) -> StoredArchive: ...


class IngestionDispatcher(Protocol):
    async def dispatch(self, copy_job_id: UUID, artifact: StoredArchive) -> None: ...


class RdsDataRepositoryCopyCoordinator:
    def __init__(self, client: RepositoryCopyDataApi, *, expected_bucket: str) -> None:
        self._client = client
        self._expected_bucket = expected_bucket

    async def claim(
        self, copy_job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> RepositoryCopyClaim | CompletedRepositoryCopy | None:
        try:
            result = await self._client.execute(
                "SELECT * FROM app.claim_repository_object_copy(%s, %s, %s)",
                (copy_job_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise RepositoryCopyDependencyUnavailable(
                "repository copy claim unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 27:
            raise RepositoryCopyDependencyUnavailable("repository copy claim invalid")
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
            raise RepositoryCopyDependencyUnavailable("repository copy claim state invalid")
        if status != "claimed":
            if row[1] is not None and _uuid(row[1]) != copy_job_id:
                raise RepositoryCopyDependencyUnavailable("repository copy claim identity invalid")
            if status == "already_completed":
                return await self._completed(copy_job_id)
            return None
        try:
            claim = _claim_from_row(row)
        except (TypeError, ValueError) as error:
            raise RepositoryCopyDependencyUnavailable("repository copy claim invalid") from error
        if claim.copy_job_id != copy_job_id or claim.destination_bucket != self._expected_bucket:
            raise RepositoryCopyDependencyUnavailable("repository copy claim scope invalid")
        return claim

    async def _completed(self, copy_job_id: UUID) -> CompletedRepositoryCopy:
        try:
            result = await self._client.execute(
                "SELECT * FROM app.get_completed_repository_object_copy_artifact(%s)",
                (copy_job_id,),
            )
        except RdsDataApiUnavailable as error:
            raise RepositoryCopyDependencyUnavailable(
                "completed repository copy unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 9:
            raise RepositoryCopyDependencyUnavailable("completed repository copy invalid")
        row = result.records[0]
        try:
            artifact = StoredArchive(
                bucket=_bounded_string(row[2], 63),
                object_key=_bounded_string(row[3], 1024),
                s3_version_id=_bounded_string(row[4], 1024),
                etag=_bounded_string(row[5], 128),
                content_type=cast(Any, _content_type(row[6])),
                size_bytes=_bounded_int(row[7], 1, _MAXIMUM_COPY_BYTES),
                checksum_sha256=_sha256(row[8]),
            )
            completed = CompletedRepositoryCopy(_uuid(row[0]), artifact)
        except (TypeError, ValueError) as error:
            raise RepositoryCopyDependencyUnavailable(
                "completed repository copy invalid"
            ) from error
        if completed.copy_job_id != copy_job_id or artifact.bucket != self._expected_bucket:
            raise RepositoryCopyDependencyUnavailable("completed repository copy scope invalid")
        return completed

    async def heartbeat(self, copy_job_id: UUID, worker_token: UUID, lease_seconds: int) -> bool:
        return await self._boolean(
            "heartbeat_repository_object_copy",
            (copy_job_id, worker_token, lease_seconds),
        )

    async def complete(
        self, copy_job_id: UUID, worker_token: UUID, artifact: Mapping[str, Any]
    ) -> bool:
        encoded = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()
        if len(encoded) > 8192:
            raise RepositoryCopyDependencyUnavailable("repository copy artifact too large")
        return await self._boolean(
            "complete_repository_object_copy",
            (copy_job_id, worker_token, Jsonb(dict(artifact))),
        )

    async def fail(self, copy_job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        _error_code(error_code)
        return await self._boolean(
            "fail_repository_object_copy", (copy_job_id, worker_token, error_code)
        )

    async def release(self, copy_job_id: UUID, worker_token: UUID, error_code: str) -> str:
        _error_code(error_code)
        try:
            result = await self._client.execute(
                "SELECT app.release_repository_object_copy(%s, %s, %s)",
                (copy_job_id, worker_token, error_code),
            )
        except RdsDataApiUnavailable as error:
            raise RepositoryCopyDependencyUnavailable(
                "repository copy release unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0][0] not in {"queued", "failed", "lost"}:
            raise RepositoryCopyDependencyUnavailable("repository copy release invalid")
        return cast(str, result.records[0][0])

    async def _boolean(self, function_name: str, parameters: tuple[Any, ...]) -> bool:
        if function_name not in {
            "heartbeat_repository_object_copy",
            "complete_repository_object_copy",
            "fail_repository_object_copy",
        }:
            raise ValueError("repository copy function is not allowlisted")
        placeholders = ", ".join("%s" for _ in parameters)
        try:
            result = await self._client.execute(
                f"SELECT app.{function_name}({placeholders})", parameters
            )
        except RdsDataApiUnavailable as error:
            raise RepositoryCopyDependencyUnavailable(
                "repository copy database unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise RepositoryCopyDependencyUnavailable("repository copy database result invalid")
        return result.records[0][0]


class S3ExactVersionFetcher:
    def __init__(self, *, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(UTC))

    async def fetch(
        self,
        claim: RepositoryCopyClaim,
        credentials: AwsCredentials,
        destination: Path,
    ) -> FetchedArchive:
        host = regional_s3_host(claim.source_region)
        path = object_path(claim.source_bucket, claim.source_object_key)
        query = _form_query({"versionId": claim.source_version_id})
        headers = _signed_headers(
            method="GET",
            canonical_uri=path,
            canonical_query=query,
            host=host,
            region=claim.source_region,
            service="s3",
            credentials=credentials,
            body=b"",
            now=self._now(),
        )
        url = f"https://{host}{path}?{query}"
        digest = hashlib.sha256()
        written = 0
        try:
            async with (
                httpx2.AsyncClient(timeout=120.0, follow_redirects=False) as client,
                client.stream("GET", url, headers=headers) as response,
            ):
                if response.status_code in {401, 403}:
                    raise RepositoryCopyFailure("source_access_denied", retryable=False)
                if response.status_code == 404:
                    raise RepositoryCopyFailure("source_object_changed", retryable=False)
                if response.status_code >= 500:
                    raise RepositoryCopyFailure("source_unavailable", retryable=True)
                if response.status_code != 200:
                    raise RepositoryCopyFailure("response_invalid", retryable=False)
                normalized = {name.casefold(): value for name, value in response.headers.items()}
                self._validate_headers(claim, normalized)
                with destination.open("xb") as stream:
                    async for chunk in response.aiter_bytes():
                        written += len(chunk)
                        if written > claim.maximum_output_bytes:
                            raise RepositoryCopyFailure("response_too_large", retryable=False)
                        digest.update(chunk)
                        stream.write(chunk)
        except RepositoryCopyFailure:
            await asyncio.to_thread(destination.unlink, missing_ok=True)
            raise
        except (httpx2.HTTPError, OSError) as error:
            await asyncio.to_thread(destination.unlink, missing_ok=True)
            raise RepositoryCopyFailure("source_unavailable", retryable=True) from error
        if written != claim.maximum_output_bytes:
            await asyncio.to_thread(destination.unlink, missing_ok=True)
            raise RepositoryCopyFailure("source_object_changed", retryable=False)
        checksum = digest.hexdigest()
        if claim.source_checksum_sha256 is not None:
            try:
                expected = base64.b64decode(claim.source_checksum_sha256, validate=True).hex()
            except (binascii.Error, ValueError) as error:
                await asyncio.to_thread(destination.unlink, missing_ok=True)
                raise RepositoryCopyFailure("source_contract_invalid", retryable=False) from error
            if len(expected) != 64:
                await asyncio.to_thread(destination.unlink, missing_ok=True)
                raise RepositoryCopyFailure("source_contract_invalid", retryable=False)
            if checksum != expected:
                await asyncio.to_thread(destination.unlink, missing_ok=True)
                raise RepositoryCopyFailure("source_object_changed", retryable=False)
        return FetchedArchive(
            content_type=cast(Any, claim.output_content_type),
            size_bytes=written,
            checksum_sha256=checksum,
        )

    @staticmethod
    def _validate_headers(claim: RepositoryCopyClaim, headers: Mapping[str, str]) -> None:
        try:
            length = int(headers["content-length"])
        except (KeyError, ValueError) as error:
            raise RepositoryCopyFailure("response_invalid", retryable=False) from error
        version = headers.get("x-amz-version-id")
        etag = headers.get("etag")
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().casefold()
        if (
            length != claim.maximum_output_bytes
            or version != claim.source_version_id
            or etag != claim.source_etag
            or content_type != claim.output_content_type
        ):
            raise RepositoryCopyFailure("source_object_changed", retryable=False)


class RepositoryObjectCopyProcessor:
    def __init__(
        self,
        coordinator: RepositoryCopyCoordinator,
        secret_loader: AwsUserDatasetCredentialLoader,
        role_assumer: AwsStsRoleAssumer,
        task_credentials: CredentialProvider,
        fetcher: RepositoryObjectFetcher,
        storage: ArchiveStorage,
        dispatcher: IngestionDispatcher,
    ) -> None:
        self._coordinator = coordinator
        self._secret_loader = secret_loader
        self._role_assumer = role_assumer
        self._task_credentials = task_credentials
        self._fetcher = fetcher
        self._storage = storage
        self._dispatcher = dispatcher

    async def process(self, command: RepositoryCopyCommand) -> bool:
        worker_token = uuid4()
        claim_result = await self._coordinator.claim(
            command.copy_job_id, worker_token, _LEASE_SECONDS
        )
        if claim_result is None:
            return True
        if isinstance(claim_result, CompletedRepositoryCopy):
            await self._dispatch(claim_result)
            return True
        claim = claim_result
        try:
            credentials = await self._source_credentials(claim)
            with tempfile.TemporaryDirectory(prefix="opengeo-repository-copy-") as directory:
                source = Path(directory) / "source"
                fetched = await self._fetcher.fetch(claim, credentials, source)
                if not await self._coordinator.heartbeat(
                    claim.copy_job_id, worker_token, _LEASE_SECONDS
                ):
                    raise RepositoryCopyDependencyUnavailable("repository copy lease lost")
                stored = await self._storage.store(claim.output_object_key, source, fetched)
            artifact = {
                "id": str(uuid4()),
                "role": "original",
                "bucket": stored.bucket,
                "object_key": stored.object_key,
                "s3_version_id": stored.s3_version_id,
                "etag": stored.etag,
                "content_type": stored.content_type,
                "size_bytes": stored.size_bytes,
                "checksum_sha256": stored.checksum_sha256,
            }
            if not await self._coordinator.complete(claim.copy_job_id, worker_token, artifact):
                raise RepositoryCopyDependencyUnavailable("repository copy completion rejected")
            await self._dispatch(CompletedRepositoryCopy(claim.copy_job_id, stored))
            return True
        except RepositoryCopyFailure as error:
            if error.retryable:
                await self._release(claim, worker_token, error.code)
                raise RepositoryCopyDependencyUnavailable(
                    "repository copy retry required"
                ) from error
            if not await self._coordinator.fail(claim.copy_job_id, worker_token, error.code):
                raise RepositoryCopyDependencyUnavailable(
                    "repository copy failure not recorded"
                ) from error
            return True
        except SourceArchiveFailure as error:
            if error.retryable:
                await self._release(claim, worker_token, error.code)
                raise RepositoryCopyDependencyUnavailable(
                    "repository copy retry required"
                ) from error
            if not await self._coordinator.fail(claim.copy_job_id, worker_token, error.code):
                raise RepositoryCopyDependencyUnavailable(
                    "repository copy failure not recorded"
                ) from error
            return True

    async def _source_credentials(self, claim: RepositoryCopyClaim) -> AwsCredentials:
        credential_claim = DatasetVerificationClaim(
            verification_id=UUID(int=0),
            organization_id=claim.organization_id,
            owner_user_id=claim.source_owner_user_id,
            connection_id=claim.connection_id,
            target_revision=claim.connection_target_revision,
            credential_revision=claim.credential_revision,
            bucket_name=claim.source_bucket,
            region_name=claim.source_region,
            object_prefix="",
            credential_mode=claim.credential_mode,
            role_arn=claim.role_arn,
            secret_reference=claim.secret_reference,
        )
        try:
            loaded = await self._secret_loader.load(credential_claim)
            if claim.credential_mode == "assume_role":
                external_id = loaded.values.get("external_id")
                if claim.role_arn is None or not external_id:
                    raise RepositoryCopyFailure("source_credentials_invalid", retryable=False)
                try:
                    return await self._role_assumer.assume(claim.role_arn, external_id)
                except AssumeRoleDenied as error:
                    raise RepositoryCopyFailure(
                        "source_credentials_invalid", retryable=False
                    ) from error
            if claim.credential_mode == "access_key":
                return AwsCredentials(
                    loaded.values["access_key_id"],
                    loaded.values["secret_access_key"],
                    loaded.values.get("session_token"),
                )
            if claim.credential_mode == "workload_identity":
                return self._task_credentials.load()
            raise RepositoryCopyFailure("source_credentials_invalid", retryable=False)
        except (DatasetVerificationRejected, KeyError, IdentityProvisioningUnavailable) as error:
            raise RepositoryCopyFailure("source_credentials_invalid", retryable=False) from error
        except DatasetVerificationDependencyUnavailable as error:
            raise RepositoryCopyFailure("source_unavailable", retryable=True) from error

    async def _release(
        self, claim: RepositoryCopyClaim, worker_token: UUID, error_code: str
    ) -> None:
        result = await self._coordinator.release(claim.copy_job_id, worker_token, error_code)
        if result == "lost":
            raise RepositoryCopyDependencyUnavailable("repository copy lease lost")

    async def _dispatch(self, completed: CompletedRepositoryCopy) -> None:
        try:
            await self._dispatcher.dispatch(completed.copy_job_id, completed.artifact)
        except SourceArchiveDispatchUnavailable as error:
            raise RepositoryCopyDependencyUnavailable(
                "repository copy ingestion dispatch unavailable"
            ) from error


def parse_command(body: str) -> RepositoryCopyCommand:
    if not isinstance(body, str) or len(body.encode()) > _MAXIMUM_COMMAND_BYTES:
        raise RepositoryCopyCommandInvalid("repository_copy_command_invalid")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise RepositoryCopyCommandInvalid("repository_copy_command_invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "copy_job_id"}:
        raise RepositoryCopyCommandInvalid("repository_copy_command_invalid")
    if payload.get("schema") != _COMMAND_SCHEMA:
        raise RepositoryCopyCommandInvalid("repository_copy_command_invalid")
    try:
        return RepositoryCopyCommand(UUID(str(payload["copy_job_id"])))
    except (TypeError, ValueError) as error:
        raise RepositoryCopyCommandInvalid("repository_copy_command_invalid") from error


async def handle_event(
    event: Mapping[str, Any], processor: RepositoryObjectCopyProcessor
) -> dict[str, list[dict[str, str]]]:
    records = event.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise RepositoryCopyCommandInvalid("repository_copy_event_invalid")
    failures: list[dict[str, str]] = []
    for record in records:
        message_id = record.get("messageId") if isinstance(record, dict) else None
        body = record.get("body") if isinstance(record, dict) else None
        if not isinstance(message_id, str) or not 1 <= len(message_id) <= 128:
            raise RepositoryCopyCommandInvalid("repository_copy_event_invalid")
        try:
            await processor.process(parse_command(cast(str, body)))
        except Exception:
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_DEFAULT_PROCESSOR: RepositoryObjectCopyProcessor | None = None


def default_processor() -> RepositoryObjectCopyProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        verifier_settings = UserDatasetVerifierSettings.from_environment()
        geodata_bucket = _required_environment("OPEN_GEO_GEODATA_BUCKET", 63)
        geodata_kms_key = _required_environment("OPEN_GEO_GEODATA_KMS_KEY_ARN", 2048)
        processing_queue = _required_environment("OPEN_GEO_PROCESSING_QUEUE_URL", 2048)
        task_credentials: CredentialProvider = AwsCredentialProvider()
        data_api = RdsDataApiClient(
            verifier_settings.data_api_settings(), credentials=task_credentials
        )
        _DEFAULT_PROCESSOR = RepositoryObjectCopyProcessor(
            RdsDataRepositoryCopyCoordinator(data_api, expected_bucket=geodata_bucket),
            AwsUserDatasetCredentialLoader(verifier_settings, credentials=task_credentials),
            AwsStsRoleAssumer(verifier_settings.region, credentials=task_credentials),
            task_credentials,
            S3ExactVersionFetcher(),
            AwsS3ArchiveStorage(
                region=verifier_settings.region,
                bucket=geodata_bucket,
                kms_key_arn=geodata_kms_key,
                credentials=task_credentials,
            ),
            SourceArchiveIngestionDispatcher(
                region=verifier_settings.region,
                account_id=verifier_settings.account_id,
                queue_url=processing_queue,
                credentials=task_credentials,
            ),
        )
    return _DEFAULT_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, list[dict[str, str]]]:
    del context
    return asyncio.run(handle_event(event, default_processor()))


def _claim_from_row(row: tuple[Any, ...]) -> RepositoryCopyClaim:
    if len(row) != 27 or row[0] != "claimed":
        raise ValueError("invalid repository copy claim")
    source_object_key = _bounded_string(row[14], 1024)
    output_key = _bounded_string(row[23], 1024)
    if (
        not source_object_key
        or source_object_key.startswith("/")
        or ".." in source_object_key.split("/")
    ):
        raise ValueError("invalid repository source key")
    if not output_key.startswith("organizations/"):
        raise ValueError("invalid repository destination key")
    return RepositoryCopyClaim(
        copy_job_id=_uuid(row[1]),
        organization_id=_uuid(row[2]),
        project_id=_uuid(row[3]),
        source_dataset_id=_uuid(row[4]),
        source_owner_user_id=_uuid(row[5]),
        connection_id=_uuid(row[6]),
        connection_target_revision=_bounded_int(row[7], 1, 2**63 - 1),
        credential_revision=_bounded_int(row[8], 0, 2**63 - 1),
        credential_mode=_one_of(row[9], {"assume_role", "access_key", "workload_identity"}),
        role_arn=_optional_string(row[10], 2048),
        secret_reference=_optional_string(row[11], 2048),
        source_bucket=_bounded_string(row[12], 63),
        source_region=_bounded_string(row[13], 32),
        source_object_key=source_object_key,
        source_version_id=_bounded_string(row[15], 1024),
        source_etag=_bounded_string(row[16], 1024),
        source_checksum_sha256=_optional_string(row[17], 64),
        output_format=_bounded_string(row[18], 32),
        output_content_type=_content_type(row[19]),
        maximum_output_bytes=_bounded_int(row[20], 1, _MAXIMUM_COPY_BYTES),
        destination_dataset_id=_uuid(row[21]),
        destination_bucket=_bounded_string(row[22], 63),
        output_object_key=output_key,
        request_checksum_sha256=_sha256(row[24]),
        attribution=_bounded_string(row[25], 1000),
        attempt_count=_bounded_int(row[26], 1, 3),
    )


def _required_environment(name: str, maximum: int) -> str:
    value = os.getenv(name)
    if value is None or not 1 <= len(value) <= maximum or any(ord(c) < 32 for c in value):
        raise RepositoryCopyDependencyUnavailable(f"{name} is invalid")
    return value


def _uuid(value: Any) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


def _bounded_int(value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError("invalid integer")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError("integer outside bounds")
    return number


def _bounded_string(value: Any, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value.encode()) <= maximum:
        raise ValueError("invalid string")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("invalid string")
    return value


def _optional_string(value: Any, maximum: int) -> str | None:
    return None if value is None else _bounded_string(value, maximum)


def _one_of(value: Any, allowed: set[str]) -> str:
    text = _bounded_string(value, 64)
    if text not in allowed:
        raise ValueError("unsupported value")
    return text


def _content_type(value: Any) -> str:
    text = _bounded_string(value, 100).casefold()
    if _CONTENT_TYPE.fullmatch(text) is None:
        raise ValueError("invalid content type")
    return text


def _sha256(value: Any) -> str:
    text = _bounded_string(value, 64)
    if _SHA256.fullmatch(text) is None:
        raise ValueError("invalid SHA-256")
    return text


def _error_code(value: str) -> None:
    if not isinstance(value, str) or len(value) > 100 or _ERROR_CODE.fullmatch(value) is None:
        raise ValueError("invalid repository copy error code")
