import asyncio
import hashlib
import hmac
import json
import logging
import re
from _thread import LockType
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from time import monotonic
from typing import Any, Literal, Protocol, TypeVar, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, AuthorizationDenied, ProjectRole, Roles, authorize
from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

logger = logging.getLogger(__name__)

ConnectionProvider = Literal["postgresql"]
ConnectionTlsMode = Literal["verify_full"]
ConnectionNetworkMode = Literal["public_internet"]
ConnectionStatus = Literal[
    "configuration_valid",
    "network_reachable",
    "credentials_verified",
    "catalog_verified",
    "degraded",
    "disabled",
    "revoked",
]
ConnectionVerificationState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
OperationResult = TypeVar("OperationResult")


class ConnectionStoreUnavailable(RuntimeError):
    pass


class ConnectionAccessDenied(RuntimeError):
    pass


class ConnectionNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class ConnectionConflict(RuntimeError):
    pass


class ConnectionSecretStoreUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ConnectionCapabilities:
    read: bool
    manage: bool


@dataclass(frozen=True, slots=True)
class ExternalConnection:
    connection_id: UUID
    project_id: UUID
    provider: ConnectionProvider
    display_name: str
    endpoint_host: str
    endpoint_port: int
    database_name: str
    allowed_schemas: tuple[str, ...]
    read_only: bool
    tls_mode: ConnectionTlsMode
    network_mode: ConnectionNetworkMode
    configured_secret_fields: tuple[str, ...]
    status: ConnectionStatus
    current_revision_number: int
    last_verified_at: datetime | None
    schema_fingerprint_sha256: str | None
    sanitized_error_code: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    capabilities: ConnectionCapabilities


@dataclass(frozen=True, slots=True)
class ExternalConnectionRevision:
    revision_id: UUID
    connection_id: UUID
    revision_number: int
    configuration: dict[str, Any]
    change_summary: str
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ExternalConnectionVerification:
    verification_id: UUID
    connection_id: UUID
    connection_revision_number: int
    state: ConnectionVerificationState
    attempt_count: int
    network_reachable: bool
    tls_verified: bool
    credentials_verified: bool
    postgis_verified: bool
    sanitized_error_code: str | None
    duration_ms: int | None
    requested_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class ExternalConnectionVerificationSubmission:
    verification: ExternalConnectionVerification
    created: bool


@dataclass(frozen=True, slots=True, repr=False)
class ExternalConnectionDraft:
    provider: ConnectionProvider
    display_name: str
    endpoint_host: str
    endpoint_port: int
    database_name: str
    allowed_schemas: tuple[str, ...]
    read_only: bool
    tls_mode: ConnectionTlsMode
    network_mode: ConnectionNetworkMode
    username: str
    password: str

    def public_configuration(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "endpointHost": self.endpoint_host,
            "endpointPort": self.endpoint_port,
            "databaseName": self.database_name,
            "allowedSchemas": list(self.allowed_schemas),
            "readOnly": self.read_only,
            "tlsMode": self.tls_mode,
            "networkMode": self.network_mode,
        }


@dataclass(frozen=True, slots=True)
class StoredConnectionSecret:
    reference: str
    configured_fields: tuple[str, ...]


class ConnectionSecretStore(Protocol):
    async def create(
        self,
        organization_id: UUID,
        project_id: UUID,
        connection_id: UUID,
        username: str,
        password: str,
    ) -> StoredConnectionSecret: ...

    async def discard(self, reference: str) -> None: ...


class UnavailableConnectionSecretStore:
    async def create(
        self,
        organization_id: UUID,
        project_id: UUID,
        connection_id: UUID,
        username: str,
        password: str,
    ) -> StoredConnectionSecret:
        del organization_id, project_id, connection_id, username, password
        raise ConnectionSecretStoreUnavailable("connection secret storage is not configured")

    async def discard(self, reference: str) -> None:
        del reference
        raise ConnectionSecretStoreUnavailable("connection secret storage is not configured")

    async def create_user_dataset_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        credentials: Mapping[str, str],
    ) -> StoredConnectionSecret:
        del (
            organization_id,
            owner_user_id,
            connection_id,
            credential_version_id,
            credentials,
        )
        raise ConnectionSecretStoreUnavailable("connection secret storage is not configured")

    async def create_user_basemap_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        api_key: str,
    ) -> StoredConnectionSecret:
        del organization_id, owner_user_id, connection_id, credential_version_id, api_key
        raise ConnectionSecretStoreUnavailable("connection secret storage is not configured")

    async def get_user_basemap_connection_api_key(self, reference: str) -> str:
        del reference
        raise ConnectionSecretStoreUnavailable("connection secret storage is not configured")


class SecretsManagerTransport(Protocol):
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]: ...


class UrlSecretsManagerTransport:
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]:
        request = Request(url, data=body, headers=dict(headers), method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                response_body = response.read(65_537)
                if len(response_body) > 65_536:
                    raise ConnectionSecretStoreUnavailable("Secrets Manager response is too large")
                return response.status, response_body
        except HTTPError as error:
            return error.code, error.read(65_537)
        except (URLError, TimeoutError, OSError) as error:
            raise ConnectionSecretStoreUnavailable(
                "Secrets Manager could not be reached"
            ) from error


class AwsConnectionSecretStore:
    """Versioned credentials, with separate browser-key and server-App readers."""

    _BROWSER_KEY_CACHE_SECONDS = 60.0
    _BROWSER_KEY_CACHE_ENTRIES = 128

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: SecretsManagerTransport | None = None,
        now: Callable[[], datetime] | None = None,
        cache_clock: Callable[[], float] | None = None,
    ) -> None:
        if not settings.upload_configured:
            raise ValueError("AWS region and KMS key must be configured")
        assert settings.aws_region is not None
        assert settings.geodata_kms_key_arn is not None
        self._region = settings.aws_region
        self._kms_key_arn = settings.geodata_kms_key_arn
        kms_arn_parts = self._kms_key_arn.split(":")
        self._partition = kms_arn_parts[1]
        self._account_id = kms_arn_parts[4]
        self._stage = settings.env
        self._timeout_seconds = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlSecretsManagerTransport()
        self._now = now or (lambda: datetime.now(UTC))
        self._github_app_secret_arn = settings.github_app_secret_arn
        self._cache_clock = cache_clock or monotonic
        self._browser_key_cache: dict[str, tuple[float, str]] = {}
        self._browser_key_cache_lock = Lock()
        # Fixed stripes bound synchronization memory and coalesce exact-version reads.
        self._browser_key_load_locks = tuple(Lock() for _ in range(16))

    async def get_github_app_credentials(self) -> tuple[int, bytes]:
        reference = self._github_app_secret_arn
        expected_prefix = (
            f"arn:{self._partition}:secretsmanager:{self._region}:{self._account_id}:secret:"
        )
        if reference is None or not reference.startswith(expected_prefix):
            raise ConnectionSecretStoreUnavailable("GitHub App secret is not configured")
        response = await asyncio.to_thread(self._call, "GetSecretValue", {"SecretId": reference})
        try:
            raw = response["SecretString"]
            if not isinstance(raw, str) or len(raw) > 16_384:
                raise ValueError()
            value = json.loads(raw)
            if (
                not isinstance(value, dict)
                or set(value) != {"app_id", "private_key_pem"}
                or type(value["app_id"]) is not int
                or value["app_id"] < 1
                or not isinstance(value["private_key_pem"], str)
            ):
                raise ValueError()
            return value["app_id"], value["private_key_pem"].encode("ascii")
        except (KeyError, TypeError, ValueError, UnicodeError):
            raise ConnectionSecretStoreUnavailable("GitHub App secret is invalid") from None

    async def create(
        self,
        organization_id: UUID,
        project_id: UUID,
        connection_id: UUID,
        username: str,
        password: str,
    ) -> StoredConnectionSecret:
        name = f"opengeo/{self._stage}/connections/{organization_id}/{connection_id}"
        payload = {
            "Name": name,
            "Description": "OpenGeo external connection credentials",
            "KmsKeyId": self._kms_key_arn,
            "ClientRequestToken": str(connection_id),
            "SecretString": json.dumps(
                {"password": password, "username": username},
                separators=(",", ":"),
                sort_keys=True,
            ),
            "Tags": [
                {"Key": "opengeo:organization-id", "Value": str(organization_id)},
                {"Key": "opengeo:project-id", "Value": str(project_id)},
                {"Key": "opengeo:connection-id", "Value": str(connection_id)},
            ],
        }
        response = await asyncio.to_thread(self._call, "CreateSecret", payload)
        reference = response.get("ARN")
        if (
            not isinstance(reference, str)
            or re.fullmatch(
                r"arn:aws(?:-us-gov)?:secretsmanager:[a-z0-9-]+:[0-9]{12}:"
                r"secret:opengeo/[A-Za-z0-9/_+=.@-]+",
                reference,
            )
            is None
        ):
            raise ConnectionSecretStoreUnavailable(
                "Secrets Manager returned an invalid connection secret reference"
            )
        return StoredConnectionSecret(reference, ("password", "username"))

    async def discard(self, reference: str) -> None:
        await asyncio.to_thread(self._discard, reference)

    def _discard(self, reference: str) -> None:
        if not self._is_versioned_browser_connection_reference(reference):
            self._call("DeleteSecret", {"SecretId": reference, "RecoveryWindowInDays": 7})
            return
        with self._browser_key_load_lock(reference):
            try:
                self._call("DeleteSecret", {"SecretId": reference, "RecoveryWindowInDays": 7})
            finally:
                with self._browser_key_cache_lock:
                    self._browser_key_cache.pop(reference, None)

    async def create_user_dataset_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        credentials: Mapping[str, str],
    ) -> StoredConnectionSecret:
        configured_fields = tuple(sorted(credentials))
        if configured_fields not in {
            ("external_id",),
            ("access_key_id", "secret_access_key"),
            ("access_key_id", "secret_access_key", "session_token"),
        }:
            raise ConnectionSecretStoreUnavailable("unsupported connection credential shape")
        name = (
            f"opengeo/{self._stage}/user-connections/{organization_id}/"
            f"{owner_user_id}/{connection_id}/{credential_version_id}"
        )
        response = await asyncio.to_thread(
            self._call,
            "CreateSecret",
            {
                "Name": name,
                "Description": "OpenGeo user dataset connection credentials",
                "KmsKeyId": self._kms_key_arn,
                "ClientRequestToken": str(credential_version_id),
                "SecretString": json.dumps(
                    dict(credentials), separators=(",", ":"), sort_keys=True
                ),
                "Tags": [
                    {"Key": "opengeo:organization-id", "Value": str(organization_id)},
                    {"Key": "opengeo:owner-user-id", "Value": str(owner_user_id)},
                    {"Key": "opengeo:connection-id", "Value": str(connection_id)},
                    {
                        "Key": "opengeo:credential-version-id",
                        "Value": str(credential_version_id),
                    },
                ],
            },
        )
        reference = response.get("ARN")
        if (
            not isinstance(reference, str)
            or re.fullmatch(
                r"arn:aws(?:-us-gov)?:secretsmanager:[a-z0-9-]+:[0-9]{12}:"
                r"secret:opengeo/[A-Za-z0-9/_+=.@-]+",
                reference,
            )
            is None
        ):
            raise ConnectionSecretStoreUnavailable(
                "Secrets Manager returned an invalid connection secret reference"
            )
        return StoredConnectionSecret(reference, configured_fields)

    async def create_user_basemap_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        api_key: str,
    ) -> StoredConnectionSecret:
        name = (
            f"opengeo/{self._stage}/browser-connections/{organization_id}/"
            f"{owner_user_id}/{connection_id}/{credential_version_id}"
        )
        response = await asyncio.to_thread(
            self._call,
            "CreateSecret",
            {
                "Name": name,
                "Description": "OpenGeo client-visible basemap provider API key",
                "KmsKeyId": self._kms_key_arn,
                "ClientRequestToken": str(credential_version_id),
                "SecretString": json.dumps(
                    {"api_key": api_key}, separators=(",", ":"), sort_keys=True
                ),
                "Tags": [
                    {"Key": "opengeo:organization-id", "Value": str(organization_id)},
                    {"Key": "opengeo:owner-user-id", "Value": str(owner_user_id)},
                    {"Key": "opengeo:connection-id", "Value": str(connection_id)},
                    {"Key": "opengeo:credential-version-id", "Value": str(credential_version_id)},
                    {"Key": "opengeo:browser-visible", "Value": "true"},
                ],
            },
        )
        reference = response.get("ARN")
        if not isinstance(reference, str) or not self._is_browser_connection_reference(reference):
            raise ConnectionSecretStoreUnavailable(
                "Secrets Manager returned an invalid basemap connection secret reference"
            )
        return StoredConnectionSecret(reference, ("api_key",))

    async def get_user_basemap_connection_api_key(self, reference: str) -> str:
        if not self._is_browser_connection_reference(reference):
            raise ConnectionSecretStoreUnavailable("invalid basemap secret reference")
        return await asyncio.to_thread(self._get_user_basemap_connection_api_key, reference)

    def _get_user_basemap_connection_api_key(self, reference: str) -> str:
        # Legacy unversioned references retain their uncached behavior. The repository
        # still checks current access/status and selects the current ARN on every call.
        if not self._is_versioned_browser_connection_reference(reference):
            return self._load_user_basemap_connection_api_key(reference)
        with self._browser_key_load_lock(reference):
            timestamp = self._cache_clock()
            with self._browser_key_cache_lock:
                expired = [
                    key
                    for key, (deadline, _) in self._browser_key_cache.items()
                    if deadline <= timestamp
                ]
                for key in expired:
                    del self._browser_key_cache[key]
                cached = self._browser_key_cache.get(reference)
                if cached is not None:
                    return cached[1]
            api_key = self._load_user_basemap_connection_api_key(reference)
            with self._browser_key_cache_lock:
                if len(self._browser_key_cache) >= self._BROWSER_KEY_CACHE_ENTRIES:
                    oldest = min(
                        self._browser_key_cache,
                        key=lambda key: self._browser_key_cache[key][0],
                    )
                    del self._browser_key_cache[oldest]
                self._browser_key_cache[reference] = (
                    self._cache_clock() + self._BROWSER_KEY_CACHE_SECONDS,
                    api_key,
                )
            return api_key

    def _browser_key_load_lock(self, reference: str) -> LockType:
        return self._browser_key_load_locks[hash(reference) % len(self._browser_key_load_locks)]

    def _is_versioned_browser_connection_reference(self, reference: str) -> bool:
        if not self._is_browser_connection_reference(reference):
            return False
        parts = reference.rsplit("/", 4)[1:]
        if len(parts) != 4 or re.fullmatch(r"[A-Za-z0-9]{6}", parts[-1][-6:]) is None:
            return False
        if len(parts[-1]) != 43 or parts[-1][-7] != "-":
            return False
        parts[-1] = parts[-1][:-7]
        try:
            return all(str(UUID(part)) == part for part in parts)
        except ValueError:
            return False

    def _load_user_basemap_connection_api_key(self, reference: str) -> str:
        response = self._call("GetSecretValue", {"SecretId": reference})
        secret = response.get("SecretString")
        if not isinstance(secret, str) or len(secret) > 16_384:
            raise ConnectionSecretStoreUnavailable("invalid basemap secret response")
        try:
            payload = json.loads(secret)
        except json.JSONDecodeError as error:
            raise ConnectionSecretStoreUnavailable("invalid basemap secret payload") from error
        if not isinstance(payload, dict) or set(payload) != {"api_key"}:
            raise ConnectionSecretStoreUnavailable("invalid basemap secret payload")
        api_key = payload.get("api_key")
        if (
            not isinstance(api_key, str)
            or not 8 <= len(api_key) <= 512
            or api_key != api_key.strip()
            or any(
                character.isspace() or ord(character) < 32 or ord(character) == 127
                for character in api_key
            )
        ):
            raise ConnectionSecretStoreUnavailable("invalid basemap API key")
        return api_key

    def _is_browser_connection_reference(self, reference: str) -> bool:
        return (
            re.fullmatch(
                rf"arn:{re.escape(self._partition)}:secretsmanager:{re.escape(self._region)}:"
                rf"{re.escape(self._account_id)}:"
                rf"secret:opengeo/{re.escape(self._stage)}/browser-connections/"
                r"[A-Za-z0-9/_+=.@-]+",
                reference,
            )
            is not None
        )

    def _call(self, operation: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = f"secretsmanager.{self._region}.amazonaws.com"
        target = f"secretsmanager.{operation}"
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise ConnectionSecretStoreUnavailable("AWS credentials are unavailable") from error
        canonical = {
            "content-type": "application/x-amz-json-1.1",
            "host": host,
            "x-amz-date": amz_date,
            "x-amz-target": target,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{key}:{canonical[key]}\n" for key in sorted(canonical))
        canonical_request = "\n".join(
            ["POST", "/", "", canonical_headers, signed_names, hashlib.sha256(body).hexdigest()]
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
            _signing_key(credentials.secret_access_key, date_stamp, self._region),
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
        status_code, response_body = self._transport.call(
            f"https://{host}/", headers, body, self._timeout_seconds
        )
        if status_code < 200 or status_code >= 300:
            raise ConnectionSecretStoreUnavailable("connection secret operation failed")
        try:
            result = json.loads(response_body)
        except ValueError as error:
            raise ConnectionSecretStoreUnavailable(
                "Secrets Manager returned an invalid response"
            ) from error
        if not isinstance(result, dict):
            raise ConnectionSecretStoreUnavailable("Secrets Manager returned an invalid response")
        return cast(dict[str, Any], result)


class ExternalConnectionRepository(Protocol):
    async def list_connections(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ExternalConnection, ...]: ...

    async def get_connection(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> ExternalConnection: ...

    async def list_revisions(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> tuple[ExternalConnectionRevision, ...]: ...

    async def create_connection(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ExternalConnectionDraft,
        request_id: str,
    ) -> ExternalConnection: ...

    async def request_verification(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        request_id: str,
    ) -> ExternalConnectionVerificationSubmission: ...

    async def list_verifications(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> tuple[ExternalConnectionVerification, ...]: ...

    async def cancel_verification(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        verification_id: UUID,
        request_id: str,
    ) -> ExternalConnectionVerification: ...


class PostgresExternalConnectionRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        secret_store: ConnectionSecretStore,
    ) -> None:
        self._executor = executor
        self._secret_store = secret_store

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise ConnectionConflict("external_connection_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ConnectionStoreUnavailable("connection operation failed") from error

    async def list_connections(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ExternalConnection, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[ExternalConnection, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._connection_select()}
                WHERE connection.organization_id = %s AND connection.project_id = %s
                ORDER BY lower(connection.display_name), connection.id
                LIMIT 100
                """,
                (context.organization_id, project_id),
            )
            return tuple(self._connection(row, roles) for row in rows)

        return await self._run(context, operation)

    async def get_connection(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> ExternalConnection:
        async def operation(transaction: TenantTransaction) -> ExternalConnection:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            return await self._load_connection(
                transaction, context, project_id, connection_id, roles
            )

        return await self._run(context, operation)

    async def list_revisions(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> tuple[ExternalConnectionRevision, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ExternalConnectionRevision, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            await self._load_connection(transaction, context, project_id, connection_id, roles)
            rows = await transaction.fetch_all(
                """
                SELECT id, connection_id, revision_number, configuration,
                       change_summary, created_by, created_at
                FROM app.external_connection_revisions
                WHERE organization_id = %s AND project_id = %s AND connection_id = %s
                ORDER BY revision_number DESC
                LIMIT 100
                """,
                (context.organization_id, project_id, connection_id),
            )
            return tuple(self._revision(row) for row in rows)

        return await self._run(context, operation)

    async def create_connection(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ExternalConnectionDraft,
        request_id: str,
    ) -> ExternalConnection:
        connection_id = uuid4()

        async def authorize_operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)

        await self._run(context, authorize_operation)
        try:
            stored_secret = await self._secret_store.create(
                context.organization_id,
                project_id,
                connection_id,
                draft.username,
                draft.password,
            )
        except ConnectionSecretStoreUnavailable as error:
            raise ConnectionStoreUnavailable("connection secret storage failed") from error

        async def insert_operation(transaction: TenantTransaction) -> ExternalConnection:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)
            await transaction.execute(
                """
                INSERT INTO app.external_connections
                  (id, organization_id, project_id, provider, display_name,
                   endpoint_host, endpoint_port, database_name, allowed_schemas,
                   read_only, tls_mode, network_mode, secret_arn,
                   configured_secret_fields, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s)
                """,
                (
                    connection_id,
                    context.organization_id,
                    project_id,
                    draft.provider,
                    draft.display_name,
                    draft.endpoint_host,
                    draft.endpoint_port,
                    draft.database_name,
                    list(draft.allowed_schemas),
                    draft.read_only,
                    draft.tls_mode,
                    draft.network_mode,
                    stored_secret.reference,
                    list(stored_secret.configured_fields),
                    context.user_id,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.external_connection_revisions
                  (organization_id, project_id, connection_id, revision_number,
                   configuration, change_summary, created_by)
                VALUES (%s, %s, %s, 1, %s, 'Initial connection registration', %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    connection_id,
                    Jsonb(draft.public_configuration()),
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                VALUES (%s, %s, %s, 'connection.created', 'connection', %s, %s, %s)
                """,
                (
                    context.organization_id,
                    context.user_id,
                    project_id,
                    connection_id,
                    request_id,
                    Jsonb(
                        {
                            "provider": draft.provider,
                            "revision_number": 1,
                            "status": "configuration_valid",
                        }
                    ),
                ),
            )
            return await self._load_connection(
                transaction, context, project_id, connection_id, roles
            )

        try:
            return await self._run(context, insert_operation)
        except BaseException:
            try:
                await asyncio.shield(self._secret_store.discard(stored_secret.reference))
            except Exception:
                logger.error("connection.secret_cleanup_failed")
            raise

    async def request_verification(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        request_id: str,
    ) -> ExternalConnectionVerificationSubmission:
        async def operation(
            transaction: TenantTransaction,
        ) -> ExternalConnectionVerificationSubmission:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)
            await self._load_connection(transaction, context, project_id, connection_id, roles)
            queued = await transaction.fetch_one(
                """
                SELECT verification_id, created
                FROM app.request_external_connection_verification(%s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    connection_id,
                    context.user_id,
                    request_id,
                ),
            )
            if queued is None:
                raise ConnectionStoreUnavailable("verification request returned no result")
            verification = await self._load_verification(
                transaction,
                context,
                project_id,
                connection_id,
                cast(UUID, queued[0]),
            )
            return ExternalConnectionVerificationSubmission(verification, cast(bool, queued[1]))

        return await self._run(context, operation)

    async def list_verifications(
        self, context: TenantContext, project_id: UUID, connection_id: UUID
    ) -> tuple[ExternalConnectionVerification, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ExternalConnectionVerification, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            await self._load_connection(transaction, context, project_id, connection_id, roles)
            rows = await transaction.fetch_all(
                f"""{self._verification_select()}
                WHERE verification.organization_id = %s
                  AND verification.project_id = %s
                  AND verification.connection_id = %s
                ORDER BY verification.created_at DESC, verification.id DESC
                LIMIT 50
                """,
                (context.organization_id, project_id, connection_id),
            )
            return tuple(self._verification(row) for row in rows)

        return await self._run(context, operation)

    async def cancel_verification(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        verification_id: UUID,
        request_id: str,
    ) -> ExternalConnectionVerification:
        async def operation(transaction: TenantTransaction) -> ExternalConnectionVerification:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)
            await self._load_connection(transaction, context, project_id, connection_id, roles)
            await transaction.fetch_one(
                """
                SELECT app.cancel_external_connection_verification(
                  %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    context.organization_id,
                    project_id,
                    connection_id,
                    verification_id,
                    context.user_id,
                    request_id,
                ),
            )
            return await self._load_verification(
                transaction, context, project_id, connection_id, verification_id
            )

        return await self._run(context, operation)

    async def _load_connection(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        roles: Roles,
    ) -> ExternalConnection:
        row = await transaction.fetch_one(
            f"""{self._connection_select()}
            WHERE connection.organization_id = %s
              AND connection.project_id = %s
              AND connection.id = %s
            """,
            (context.organization_id, project_id, connection_id),
        )
        if row is None:
            raise ConnectionNotFound("connection")
        return self._connection(row, roles)

    async def _load_verification(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        verification_id: UUID,
    ) -> ExternalConnectionVerification:
        row = await transaction.fetch_one(
            f"""{self._verification_select()}
            WHERE verification.organization_id = %s
              AND verification.project_id = %s
              AND verification.connection_id = %s
              AND verification.id = %s
            """,
            (context.organization_id, project_id, connection_id, verification_id),
        )
        if row is None:
            raise ConnectionNotFound("connection_verification")
        return self._verification(row)

    @staticmethod
    def _connection_select() -> str:
        return """
            SELECT connection.id, connection.project_id, connection.provider::text,
                   connection.display_name, connection.endpoint_host,
                   connection.endpoint_port, connection.database_name,
                   connection.allowed_schemas, connection.read_only,
                   connection.tls_mode::text, connection.network_mode::text,
                   connection.configured_secret_fields, connection.status::text,
                   connection.current_revision_number, connection.last_verified_at,
                   connection.schema_fingerprint_sha256,
                   connection.sanitized_error_code, connection.created_by,
                   connection.created_at, connection.updated_by, connection.updated_at
            FROM app.external_connections connection
        """

    @staticmethod
    def _verification_select() -> str:
        return """
            SELECT verification.id, verification.connection_id,
                   verification.connection_revision_number,
                   verification.state::text, verification.attempt_count,
                   verification.network_reachable, verification.tls_verified,
                   verification.credentials_verified, verification.postgis_verified,
                   verification.sanitized_error_code, verification.duration_ms,
                   verification.requested_by, verification.created_at,
                   verification.started_at, verification.finished_at
            FROM app.external_connection_verifications verification
        """

    @staticmethod
    def _connection(row: tuple[Any, ...], roles: Roles) -> ExternalConnection:
        return ExternalConnection(
            connection_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            provider=cast(ConnectionProvider, row[2]),
            display_name=cast(str, row[3]),
            endpoint_host=cast(str, row[4]),
            endpoint_port=cast(int, row[5]),
            database_name=cast(str, row[6]),
            allowed_schemas=tuple(cast(list[str], row[7])),
            read_only=cast(bool, row[8]),
            tls_mode=cast(ConnectionTlsMode, row[9]),
            network_mode=cast(ConnectionNetworkMode, row[10]),
            configured_secret_fields=tuple(cast(list[str], row[11])),
            status=cast(ConnectionStatus, row[12]),
            current_revision_number=cast(int, row[13]),
            last_verified_at=cast(datetime | None, row[14]),
            schema_fingerprint_sha256=cast(str | None, row[15]),
            sanitized_error_code=cast(str | None, row[16]),
            created_by=cast(UUID, row[17]),
            created_at=cast(datetime, row[18]),
            updated_by=cast(UUID, row[19]),
            updated_at=cast(datetime, row[20]),
            capabilities=ConnectionCapabilities(
                read=True,
                manage=_is_allowed(Action.CONNECTION_MANAGE, roles),
            ),
        )

    @staticmethod
    def _revision(row: tuple[Any, ...]) -> ExternalConnectionRevision:
        return ExternalConnectionRevision(
            revision_id=cast(UUID, row[0]),
            connection_id=cast(UUID, row[1]),
            revision_number=cast(int, row[2]),
            configuration=cast(dict[str, Any], row[3]),
            change_summary=cast(str, row[4]),
            created_by=cast(UUID, row[5]),
            created_at=cast(datetime, row[6]),
        )

    @staticmethod
    def _verification(row: tuple[Any, ...]) -> ExternalConnectionVerification:
        return ExternalConnectionVerification(
            verification_id=cast(UUID, row[0]),
            connection_id=cast(UUID, row[1]),
            connection_revision_number=cast(int, row[2]),
            state=cast(ConnectionVerificationState, row[3]),
            attempt_count=cast(int, row[4]),
            network_reachable=cast(bool, row[5]),
            tls_verified=cast(bool, row[6]),
            credentials_verified=cast(bool, row[7]),
            postgis_verified=cast(bool, row[8]),
            sanitized_error_code=cast(str | None, row[9]),
            duration_ms=cast(int | None, row[10]),
            requested_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            started_at=cast(datetime | None, row[13]),
            finished_at=cast(datetime | None, row[14]),
        )

    async def _project_roles(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise ConnectionAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise ConnectionNotFound("project")
        return Roles(
            organization=cast(Any, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise ConnectionAccessDenied("action forbidden") from error


def _is_allowed(action: Action, roles: Roles) -> bool:
    try:
        authorize(action, roles)
    except AuthorizationDenied:
        return False
    return True


def _signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"secretsmanager", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
