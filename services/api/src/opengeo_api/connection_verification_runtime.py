import asyncio
import hashlib
import hmac
import json
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.connection_verification import (
    PostgreSqlConnectionVerifier,
    PostgreSqlCredentials,
    PostgreSqlVerificationTarget,
    VerificationOutcome,
)
from opengeo_api.connections import SecretsManagerTransport, UrlSecretsManagerTransport
from opengeo_api.rds_data import DataApiResult, RdsDataApiClient, RdsDataApiUnavailable

_COMMAND_SCHEMA = "opengeo.connection-verification.command.v1"
_MAX_COMMAND_BYTES = 512


class VerificationCommandInvalid(RuntimeError):
    pass


class VerificationDependencyUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class VerificationCommand:
    verification_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class VerificationClaim:
    verification_id: UUID
    organization_id: UUID
    project_id: UUID
    connection_id: UUID
    connection_revision_number: int
    endpoint_host: str
    endpoint_port: int
    database_name: str
    tls_mode: str
    network_mode: str
    secret_reference: str


class VerificationCoordinator(Protocol):
    async def claim(
        self, verification_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> VerificationClaim | None: ...

    async def complete(
        self,
        verification_id: UUID,
        worker_token: UUID,
        outcome: VerificationOutcome,
    ) -> bool: ...

    async def release(
        self, verification_id: UUID, worker_token: UUID, max_attempts: int
    ) -> str: ...


class VerificationSecretLoader(Protocol):
    async def load(self, secret_reference: str) -> PostgreSqlCredentials: ...


class VerificationDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


@dataclass(frozen=True, slots=True)
class VerifierRuntimeSettings:
    stage: str
    region: str
    database_cluster_arn: str
    database_secret_arn: str
    database_name: str = "opengeo"

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None
    ) -> "VerifierRuntimeSettings":
        values = environment if environment is not None else os.environ
        required = {
            "stage": values.get("OPEN_GEO_CONNECTION_VERIFIER_STAGE"),
            "region": values.get("OPEN_GEO_DATA_API_REGION"),
            "database_cluster_arn": values.get("OPEN_GEO_DATA_API_CLUSTER_ARN"),
            "database_secret_arn": values.get("OPEN_GEO_DATA_API_SECRET_ARN"),
        }
        missing = [name for name, value in required.items() if value is None]
        if missing:
            raise VerificationDependencyUnavailable(
                "connection verifier configuration is incomplete"
            )
        stage = cast(str, required["stage"])
        region = cast(str, required["region"])
        cluster_arn = cast(str, required["database_cluster_arn"])
        secret_arn = cast(str, required["database_secret_arn"])
        database_name = values.get("OPEN_GEO_DB_NAME", "opengeo")
        cluster_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):rds:([^:]+):(\d{12}):cluster:[A-Za-z0-9-]{1,63}",
            cluster_arn,
        )
        secret_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):secretsmanager:([^:]+):(\d{12}):"
            r"secret:[A-Za-z0-9/_+=.@-]+",
            secret_arn,
        )
        if (
            stage not in {"dev", "staging", "production"}
            or re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region) is None
            or cluster_match is None
            or secret_match is None
            or cluster_match.groups() != secret_match.groups()
            or cluster_match.group(2) != region
            or database_name != "opengeo"
        ):
            raise VerificationDependencyUnavailable("connection verifier configuration is invalid")
        return cls(stage, region, cluster_arn, secret_arn, database_name)

    @property
    def account_id(self) -> str:
        return self.database_secret_arn.split(":", 5)[4]

    @property
    def partition(self) -> str:
        return self.database_secret_arn.split(":", 2)[1]

    def data_api_settings(self) -> Settings:
        return Settings(
            env="test",
            data_api_region=self.region,
            data_api_cluster_arn=self.database_cluster_arn,
            data_api_secret_arn=self.database_secret_arn,
            db_name=self.database_name,
        )


class RdsDataVerificationCoordinator:
    def __init__(self, client: VerificationDataApi) -> None:
        self._client = client

    async def claim(
        self, verification_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> VerificationClaim | None:
        try:
            result = await self._client.execute(
                """
                SELECT claim_status, verification_id, organization_id, project_id,
                       connection_id, connection_revision_number, provider,
                       endpoint_host, endpoint_port, database_name, tls_mode,
                       network_mode, secret_arn, attempt_count
                FROM app.claim_external_connection_verification(%s, %s, %s)
                """,
                (verification_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise VerificationDependencyUnavailable(
                "connection verification claim is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 14:
            raise VerificationDependencyUnavailable(
                "connection verification claim returned an invalid result"
            )
        row = result.records[0]
        if row[0] != "claimed":
            return None
        try:
            claim = VerificationClaim(
                verification_id=_uuid(row[1]),
                organization_id=_uuid(row[2]),
                project_id=_uuid(row[3]),
                connection_id=_uuid(row[4]),
                connection_revision_number=_positive_int(row[5]),
                endpoint_host=_bounded_string(row[7], 253),
                endpoint_port=_bounded_port(row[8]),
                database_name=_bounded_string(row[9], 63),
                tls_mode=_bounded_string(row[10], 32),
                network_mode=_bounded_string(row[11], 32),
                secret_reference=_bounded_string(row[12], 512),
            )
        except (TypeError, ValueError) as error:
            raise VerificationDependencyUnavailable(
                "connection verification claim returned invalid fields"
            ) from error
        if claim.verification_id != verification_id or row[6] != "postgresql":
            raise VerificationDependencyUnavailable(
                "connection verification claim returned the wrong identity"
            )
        return claim

    async def complete(
        self,
        verification_id: UUID,
        worker_token: UUID,
        outcome: VerificationOutcome,
    ) -> bool:
        try:
            result = await self._client.execute(
                """
                SELECT app.complete_external_connection_verification(
                  %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    verification_id,
                    worker_token,
                    outcome.network_reachable,
                    outcome.tls_verified,
                    outcome.credentials_verified,
                    outcome.postgis_verified,
                    outcome.sanitized_error_code,
                    outcome.duration_ms,
                ),
            )
        except RdsDataApiUnavailable as error:
            raise VerificationDependencyUnavailable(
                "connection verification completion is unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise VerificationDependencyUnavailable(
                "connection verification completion returned an invalid result"
            )
        return result.records[0][0]

    async def release(self, verification_id: UUID, worker_token: UUID, max_attempts: int) -> str:
        try:
            result = await self._client.execute(
                """
                SELECT app.release_external_connection_verification(%s, %s, %s)
                """,
                (verification_id, worker_token, max_attempts),
            )
        except RdsDataApiUnavailable as error:
            raise VerificationDependencyUnavailable(
                "connection verification release is unavailable"
            ) from error
        if (
            len(result.records) != 1
            or len(result.records[0]) != 1
            or result.records[0][0] not in {"queued", "failed", "lost"}
        ):
            raise VerificationDependencyUnavailable(
                "connection verification release returned an invalid result"
            )
        return cast(str, result.records[0][0])


class AwsConnectionVerificationSecretLoader:
    def __init__(
        self,
        settings: VerifierRuntimeSettings,
        *,
        credentials: CredentialProvider | None = None,
        transport: SecretsManagerTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._region = settings.region
        self._account_id = settings.account_id
        self._partition = settings.partition
        self._stage = settings.stage
        self._timeout_seconds = 3.0
        self._credentials = credentials or AwsCredentialProvider(timeout_seconds=3.0)
        self._transport = transport or UrlSecretsManagerTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def load(self, secret_reference: str) -> PostgreSqlCredentials:
        expected = re.fullmatch(
            rf"arn:{re.escape(self._partition)}:secretsmanager:{re.escape(self._region)}:"
            rf"{re.escape(self._account_id)}:secret:opengeo/{re.escape(self._stage)}/"
            r"connections/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{6}",
            secret_reference,
        )
        if expected is None:
            raise VerificationDependencyUnavailable(
                "connection verification secret reference is invalid"
            )
        result = await asyncio.to_thread(self._get_secret, secret_reference)
        if result.get("ARN") != secret_reference:
            raise VerificationDependencyUnavailable(
                "connection verification secret identity is invalid"
            )
        secret_string = result.get("SecretString")
        if not isinstance(secret_string, str) or len(secret_string.encode()) > 4096:
            raise VerificationDependencyUnavailable(
                "connection verification secret value is invalid"
            )
        try:
            value = json.loads(secret_string)
        except ValueError as error:
            raise VerificationDependencyUnavailable(
                "connection verification secret value is invalid"
            ) from error
        if not isinstance(value, dict) or set(value) != {"password", "username"}:
            raise VerificationDependencyUnavailable(
                "connection verification secret schema is invalid"
            )
        username = value.get("username")
        password = value.get("password")
        if not _credential_string(username, 128) or not _credential_string(password, 1024):
            raise VerificationDependencyUnavailable(
                "connection verification credentials are invalid"
            )
        return PostgreSqlCredentials(cast(str, username), cast(str, password))

    def _get_secret(self, secret_reference: str) -> dict[str, Any]:
        body = json.dumps(
            {"SecretId": secret_reference}, separators=(",", ":"), sort_keys=True
        ).encode()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = f"secretsmanager.{self._region}.amazonaws.com"
        canonical = {
            "content-type": "application/x-amz-json-1.1",
            "host": host,
            "x-amz-date": amz_date,
            "x-amz-target": "secretsmanager.GetSecretValue",
        }
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise VerificationDependencyUnavailable(
                "connection verification AWS credentials are unavailable"
            ) from error
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        payload_hash = hashlib.sha256(body).hexdigest()
        signed_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{name}:{canonical[name]}\n" for name in sorted(canonical))
        canonical_request = "\n".join(
            ["POST", "/", "", canonical_headers, signed_names, payload_hash]
        )
        scope = f"{date_stamp}/{self._region}/secretsmanager/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            _aws_signing_key(credentials, date_stamp, self._region),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }
        status_code, response = self._transport.call(
            f"https://{host}/", headers, body, self._timeout_seconds
        )
        if status_code != 200 or len(response) > 65_536:
            raise VerificationDependencyUnavailable("connection verification secret read failed")
        try:
            decoded = json.loads(response)
        except ValueError as error:
            raise VerificationDependencyUnavailable(
                "connection verification secret response is invalid"
            ) from error
        if not isinstance(decoded, dict):
            raise VerificationDependencyUnavailable(
                "connection verification secret response is invalid"
            )
        return cast(dict[str, Any], decoded)


def parse_verification_command(body: str) -> VerificationCommand:
    if len(body.encode("utf-8")) > _MAX_COMMAND_BYTES:
        raise VerificationCommandInvalid("connection_verification_command_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise VerificationCommandInvalid("connection_verification_command_invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "verification_id"}:
        raise VerificationCommandInvalid("connection_verification_command_invalid")
    if payload.get("schema") != _COMMAND_SCHEMA:
        raise VerificationCommandInvalid("connection_verification_command_invalid")
    raw_id = payload.get("verification_id")
    try:
        verification_id = UUID(raw_id) if isinstance(raw_id, str) else None
    except ValueError as error:
        raise VerificationCommandInvalid("connection_verification_command_invalid") from error
    if verification_id is None or str(verification_id) != raw_id:
        raise VerificationCommandInvalid("connection_verification_command_invalid")
    return VerificationCommand(verification_id)


class ConnectionVerificationProcessor:
    def __init__(
        self,
        coordinator: VerificationCoordinator,
        secret_loader: VerificationSecretLoader,
        verifier: PostgreSqlConnectionVerifier,
        *,
        lease_seconds: int = 20,
    ) -> None:
        if not 10 <= lease_seconds <= 60:
            raise ValueError("verification lease must be between 10 and 60 seconds")
        self._coordinator = coordinator
        self._secret_loader = secret_loader
        self._verifier = verifier
        self._lease_seconds = lease_seconds

    async def process(self, command: VerificationCommand) -> bool:
        worker_token = uuid4()
        claim = await self._coordinator.claim(
            command.verification_id, worker_token, self._lease_seconds
        )
        if claim is None:
            return False
        try:
            credentials = await self._secret_loader.load(claim.secret_reference)
        except VerificationDependencyUnavailable:
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise
        except Exception as error:
            dependency_error = VerificationDependencyUnavailable(
                "connection verification secret is unavailable"
            )
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise dependency_error from error

        try:
            outcome = await self._verifier.verify(
                PostgreSqlVerificationTarget(
                    host=claim.endpoint_host,
                    port=claim.endpoint_port,
                    database_name=claim.database_name,
                    tls_mode=claim.tls_mode,
                    network_mode=claim.network_mode,
                ),
                credentials,
            )
        except Exception as error:
            dependency_error = VerificationDependencyUnavailable(
                "connection verification execution is unavailable"
            )
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise dependency_error from error
        finally:
            del credentials
        try:
            return await self._coordinator.complete(claim.verification_id, worker_token, outcome)
        except VerificationDependencyUnavailable:
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise
        except Exception as error:
            dependency_error = VerificationDependencyUnavailable(
                "connection verification completion is unavailable"
            )
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise dependency_error from error


async def handle_sqs_event(
    event: Mapping[str, Any], processor: ConnectionVerificationProcessor
) -> dict[str, list[dict[str, str]]]:
    records = event.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise VerificationCommandInvalid("connection_verification_event_invalid")
    failures: list[dict[str, str]] = []
    for record in records:
        message_id = record.get("messageId") if isinstance(record, dict) else None
        body = record.get("body") if isinstance(record, dict) else None
        if (
            not isinstance(message_id, str)
            or not 1 <= len(message_id) <= 128
            or not isinstance(body, str)
        ):
            raise VerificationCommandInvalid("connection_verification_event_invalid")
        try:
            try:
                routed = json.loads(body) if len(body.encode()) <= _MAX_COMMAND_BYTES else None
            except (ValueError, UnicodeError):
                routed = None
            if (
                isinstance(routed, dict)
                and routed.get("schema") == "opengeo.connection-catalog-discovery.command.v1"
            ):
                from opengeo_api.postgis_catalog_runtime import (
                    default_processor as catalog_processor,
                )
                from opengeo_api.postgis_catalog_runtime import parse_catalog_discovery_command

                await catalog_processor().process(parse_catalog_discovery_command(body))
                continue
            command = parse_verification_command(body)
            await processor.process(command)
        except (VerificationCommandInvalid, VerificationDependencyUnavailable):
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_DEFAULT_PROCESSOR: ConnectionVerificationProcessor | None = None


def default_processor() -> ConnectionVerificationProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        runtime = VerifierRuntimeSettings.from_environment()
        client = RdsDataApiClient(runtime.data_api_settings())
        _DEFAULT_PROCESSOR = ConnectionVerificationProcessor(
            RdsDataVerificationCoordinator(client),
            AwsConnectionVerificationSecretLoader(runtime),
            PostgreSqlConnectionVerifier(),
        )
    return _DEFAULT_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    if event.get("schema") == "opengeo.postgis-preview.command.v1":
        from opengeo_api.postgis_preview_runtime import handler as preview_handler

        return preview_handler(event, context)
    del context
    return asyncio.run(handle_sqs_event(event, default_processor()))


def _uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        parsed = UUID(value)
        if str(parsed) == value:
            return parsed
    raise ValueError("invalid UUID")


def _positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("invalid positive integer")
    return value


def _bounded_port(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("invalid port")
    return value


def _bounded_string(value: Any, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        raise ValueError("invalid string")
    return value


def _credential_string(value: Any, maximum: int) -> bool:
    return bool(
        isinstance(value, str)
        and 1 <= len(value) <= maximum
        and value == value.strip()
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _aws_signing_key(credentials: AwsCredentials, date_stamp: str, region: str) -> bytes:
    date_key = hmac.new(
        f"AWS4{credentials.secret_access_key}".encode(),
        date_stamp.encode(),
        hashlib.sha256,
    ).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"secretsmanager", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
