import asyncio
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from urllib.parse import quote

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.tenant_database import TenantContext
from opengeo_api.user_connections import UserDatasetConnection
from opengeo_api.user_dataset_verification_runtime import (
    AwsJsonTransport,
    DatasetVerificationDependencyUnavailable,
    UrlAwsTransport,
    _signed_headers,
)


class DatasetRepositoryUnavailable(RuntimeError):
    pass


class DatasetRepositoryAccessDenied(RuntimeError):
    pass


class DatasetRepositoryResponseInvalid(RuntimeError):
    pass


class DatasetRepositoryObjectNotFound(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DatasetRepositoryEntry:
    kind: Literal["prefix", "object"]
    relative_path: str
    name: str
    size_bytes: int | None = None
    last_modified: datetime | None = None
    storage_class: str | None = None
    version_id: str | None = None


@dataclass(frozen=True, slots=True)
class DatasetRepositoryPage:
    prefix: str
    parent_prefix: str | None
    entries: tuple[DatasetRepositoryEntry, ...]
    truncated: bool
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class DatasetRepositoryObject:
    relative_path: str
    name: str
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    version_id: str | None
    checksum_sha256: str | None


@dataclass(frozen=True, slots=True)
class DatasetRepositoryObjectVersion:
    version_id: str
    is_latest: bool
    is_delete_marker: bool
    last_modified: datetime
    size_bytes: int | None
    etag: str | None
    storage_class: str | None


@dataclass(frozen=True, slots=True)
class DatasetRepositoryObjectVersionsPage:
    relative_path: str
    entries: tuple[DatasetRepositoryObjectVersion, ...]
    truncated: bool
    next_cursor: str | None


class UserDatasetRepositoryBrowser(Protocol):
    @property
    def available(self) -> bool: ...

    async def browse(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_prefix: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryPage: ...

    async def inspect(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        version_id: str | None = None,
    ) -> DatasetRepositoryObject: ...

    async def versions(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryObjectVersionsPage: ...


class UnavailableUserDatasetRepositoryBrowser:
    available = False

    async def browse(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_prefix: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryPage:
        del context, connection, relative_prefix, cursor, limit
        raise DatasetRepositoryUnavailable("dataset repository browsing is not configured")

    async def inspect(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        version_id: str | None = None,
    ) -> DatasetRepositoryObject:
        del context, connection, relative_path, version_id
        raise DatasetRepositoryUnavailable("dataset repository browsing is not configured")

    async def versions(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryObjectVersionsPage:
        del context, connection, relative_path, cursor, limit
        raise DatasetRepositoryUnavailable("dataset repository browsing is not configured")


class AwsLambdaUserDatasetRepositoryBrowser:
    """Invoke the isolated metadata browser without giving the API S3 credentials."""

    available = True
    _COMMAND_SCHEMA = "opengeo.dataset-repository-browser.command.v1"
    _RESPONSE_SCHEMA = "opengeo.dataset-repository-browser.response.v1"
    _OBJECT_COMMAND_SCHEMA = "opengeo.dataset-repository-object.command.v1"
    _OBJECT_RESPONSE_SCHEMA = "opengeo.dataset-repository-object.response.v1"
    _OBJECT_VERSIONS_COMMAND_SCHEMA = "opengeo.dataset-repository-object-versions.command.v1"
    _OBJECT_VERSIONS_RESPONSE_SCHEMA = "opengeo.dataset-repository-object-versions.response.v1"
    _OBJECT_VERSION_COMMAND_SCHEMA = "opengeo.dataset-repository-object-version.command.v1"
    _MAX_RESPONSE_BYTES = 262_144

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: AwsJsonTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.user_dataset_repository_browser_configured:
            raise ValueError("user dataset repository browser is not configured")
        assert settings.aws_region is not None
        assert settings.user_dataset_repository_browser_function_name is not None
        self._region = settings.aws_region
        self._function_name = settings.user_dataset_repository_browser_function_name
        self._credentials = credentials or AwsCredentialProvider()
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def browse(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_prefix: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryPage:
        payload = {
            "schema": self._COMMAND_SCHEMA,
            "organization_id": str(context.organization_id),
            "owner_user_id": str(context.user_id),
            "connection_id": str(connection.connection_id),
            "prefix": relative_prefix,
            "cursor": cursor,
            "limit": limit,
        }
        envelope = await asyncio.to_thread(self._invoke, payload, self._RESPONSE_SCHEMA)
        return self._decode_page(envelope)

    async def inspect(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        version_id: str | None = None,
    ) -> DatasetRepositoryObject:
        payload = {
            "schema": (
                self._OBJECT_COMMAND_SCHEMA
                if version_id is None
                else self._OBJECT_VERSION_COMMAND_SCHEMA
            ),
            "organization_id": str(context.organization_id),
            "owner_user_id": str(context.user_id),
            "connection_id": str(connection.connection_id),
            "relative_path": relative_path,
        }
        if version_id is not None:
            payload["version_id"] = version_id
        envelope = await asyncio.to_thread(self._invoke, payload, self._OBJECT_RESPONSE_SCHEMA)
        return self._decode_object(envelope)

    async def versions(
        self,
        context: TenantContext,
        connection: UserDatasetConnection,
        relative_path: str,
        cursor: str | None,
        limit: int,
    ) -> DatasetRepositoryObjectVersionsPage:
        payload = {
            "schema": self._OBJECT_VERSIONS_COMMAND_SCHEMA,
            "organization_id": str(context.organization_id),
            "owner_user_id": str(context.user_id),
            "connection_id": str(connection.connection_id),
            "relative_path": relative_path,
            "cursor": cursor,
            "limit": limit,
        }
        envelope = await asyncio.to_thread(
            self._invoke, payload, self._OBJECT_VERSIONS_RESPONSE_SCHEMA
        )
        return self._decode_versions_page(envelope)

    def _invoke(self, payload: Mapping[str, Any], response_schema: str) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        host = f"lambda.{self._region}.amazonaws.com"
        function = quote(self._function_name, safe="-_.~")
        path = f"/2015-03-31/functions/{function}/invocations"
        try:
            headers = _signed_headers(
                method="POST",
                canonical_uri=path,
                canonical_query="",
                host=host,
                region=self._region,
                service="lambda",
                credentials=self._credentials.load(),
                body=body,
                now=self._now(),
                extra_headers={"content-type": "application/json"},
            )
            status, response_headers, response_body = self._transport.call(
                "POST",
                f"https://{host}{path}",
                headers,
                body,
                12.0,
                self._MAX_RESPONSE_BYTES,
            )
        except (IdentityProvisioningUnavailable, DatasetVerificationDependencyUnavailable) as error:
            raise DatasetRepositoryUnavailable("isolated repository browser unavailable") from error
        normalized_headers = {key.lower(): value for key, value in response_headers.items()}
        if status != 200 or "x-amz-function-error" in normalized_headers:
            raise DatasetRepositoryUnavailable("isolated repository browser failed")
        try:
            envelope = json.loads(response_body)
        except (TypeError, ValueError) as error:
            raise DatasetRepositoryResponseInvalid("invalid repository response") from error
        if not isinstance(envelope, dict) or envelope.get("schema") != response_schema:
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        if envelope.get("ok") is False:
            if set(envelope) != {"schema", "ok", "error"}:
                raise DatasetRepositoryResponseInvalid("invalid repository response")
            error_code = envelope.get("error")
            if error_code == "access_denied":
                raise DatasetRepositoryAccessDenied("repository access denied")
            if error_code == "not_found":
                raise DatasetRepositoryObjectNotFound("repository object not found")
            if error_code == "unavailable":
                raise DatasetRepositoryUnavailable("isolated repository browser unavailable")
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        if envelope.get("ok") is not True:
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        return envelope

    @classmethod
    def _decode_page(cls, envelope: Any) -> DatasetRepositoryPage:
        if not isinstance(envelope, dict) or set(envelope) != {"schema", "ok", "page"}:
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        page = envelope.get("page")
        if not isinstance(page, dict) or set(page) != {
            "prefix",
            "parent_prefix",
            "entries",
            "truncated",
            "next_cursor",
        }:
            raise DatasetRepositoryResponseInvalid("invalid repository page")
        entries = page.get("entries")
        if (
            not isinstance(page.get("prefix"), str)
            or (
                page.get("parent_prefix") is not None
                and not isinstance(page.get("parent_prefix"), str)
            )
            or not isinstance(entries, list)
            or len(entries) > 100
            or not isinstance(page.get("truncated"), bool)
            or (
                page.get("next_cursor") is not None and not isinstance(page.get("next_cursor"), str)
            )
        ):
            raise DatasetRepositoryResponseInvalid("invalid repository entries")
        try:
            decoded_entries = tuple(cls._decode_entry(entry) for entry in entries)
        except (TypeError, ValueError) as error:
            raise DatasetRepositoryResponseInvalid("invalid repository entry") from error
        return DatasetRepositoryPage(
            prefix=page["prefix"],
            parent_prefix=page["parent_prefix"],
            entries=decoded_entries,
            truncated=page["truncated"],
            next_cursor=page["next_cursor"],
        )

    @staticmethod
    def _decode_object(envelope: Any) -> DatasetRepositoryObject:
        if not isinstance(envelope, dict) or set(envelope) != {"schema", "ok", "object"}:
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        record = envelope.get("object")
        if not isinstance(record, dict) or set(record) != {
            "relative_path",
            "name",
            "size_bytes",
            "last_modified",
            "content_type",
            "etag",
            "storage_class",
            "version_id",
            "checksum_sha256",
        }:
            raise DatasetRepositoryResponseInvalid("invalid repository object")
        try:
            modified = datetime.fromisoformat(str(record["last_modified"]).replace("Z", "+00:00"))
            return DatasetRepositoryObject(
                relative_path=record["relative_path"],
                name=record["name"],
                size_bytes=record["size_bytes"],
                last_modified=modified,
                content_type=record["content_type"],
                etag=record["etag"],
                storage_class=record["storage_class"],
                version_id=record["version_id"],
                checksum_sha256=record["checksum_sha256"],
            )
        except (TypeError, ValueError) as error:
            raise DatasetRepositoryResponseInvalid("invalid repository object") from error

    @staticmethod
    def _decode_versions_page(envelope: Any) -> DatasetRepositoryObjectVersionsPage:
        if not isinstance(envelope, dict) or set(envelope) != {"schema", "ok", "page"}:
            raise DatasetRepositoryResponseInvalid("invalid repository response")
        page = envelope.get("page")
        if not isinstance(page, dict) or set(page) != {
            "relative_path",
            "entries",
            "truncated",
            "next_cursor",
        }:
            raise DatasetRepositoryResponseInvalid("invalid repository versions page")
        entries = page.get("entries")
        if (
            not isinstance(page.get("relative_path"), str)
            or not isinstance(entries, list)
            or len(entries) > 100
            or not isinstance(page.get("truncated"), bool)
            or (
                page.get("next_cursor") is not None and not isinstance(page.get("next_cursor"), str)
            )
        ):
            raise DatasetRepositoryResponseInvalid("invalid repository versions page")
        try:
            decoded_entries = tuple(
                AwsLambdaUserDatasetRepositoryBrowser._decode_version(entry) for entry in entries
            )
        except (TypeError, ValueError) as error:
            raise DatasetRepositoryResponseInvalid("invalid repository object version") from error
        return DatasetRepositoryObjectVersionsPage(
            relative_path=page["relative_path"],
            entries=decoded_entries,
            truncated=page["truncated"],
            next_cursor=page["next_cursor"],
        )

    @staticmethod
    def _decode_version(entry: Any) -> DatasetRepositoryObjectVersion:
        if not isinstance(entry, dict) or set(entry) != {
            "version_id",
            "is_latest",
            "is_delete_marker",
            "last_modified",
            "size_bytes",
            "etag",
            "storage_class",
        }:
            raise ValueError("invalid repository object version")
        modified = datetime.fromisoformat(str(entry["last_modified"]).replace("Z", "+00:00"))
        return DatasetRepositoryObjectVersion(
            version_id=entry["version_id"],
            is_latest=entry["is_latest"],
            is_delete_marker=entry["is_delete_marker"],
            last_modified=modified,
            size_bytes=entry["size_bytes"],
            etag=entry["etag"],
            storage_class=entry["storage_class"],
        )

    @staticmethod
    def _decode_entry(entry: Any) -> DatasetRepositoryEntry:
        if not isinstance(entry, dict) or set(entry) != {
            "kind",
            "relative_path",
            "name",
            "size_bytes",
            "last_modified",
            "storage_class",
            "version_id",
        }:
            raise ValueError("invalid repository entry")
        modified = entry["last_modified"]
        if modified is not None:
            modified = datetime.fromisoformat(str(modified).replace("Z", "+00:00"))
        return DatasetRepositoryEntry(
            kind=entry["kind"],
            relative_path=entry["relative_path"],
            name=entry["name"],
            size_bytes=entry["size_bytes"],
            last_modified=modified,
            storage_class=entry["storage_class"],
            version_id=entry["version_id"],
        )
