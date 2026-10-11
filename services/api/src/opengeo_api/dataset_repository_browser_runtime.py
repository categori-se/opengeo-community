import asyncio
import base64
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from hashlib import sha256
from typing import Any, Protocol
from urllib.parse import unquote
from uuid import UUID
from xml.etree import ElementTree

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.rds_data import DataApiResult, RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.s3_endpoints import bucket_path, object_path, regional_s3_host
from opengeo_api.user_dataset_verification_runtime import (
    AssumeRoleDenied,
    AwsJsonTransport,
    AwsStsRoleAssumer,
    AwsUserDatasetCredentialLoader,
    DatasetVerificationClaim,
    DatasetVerificationDependencyUnavailable,
    DatasetVerificationRejected,
    UrlAwsTransport,
    UserDatasetVerifierSettings,
    _form_query,
    _signed_headers,
)

_COMMAND_SCHEMA = "opengeo.dataset-repository-browser.command.v1"
_RESPONSE_SCHEMA = "opengeo.dataset-repository-browser.response.v1"
_OBJECT_COMMAND_SCHEMA = "opengeo.dataset-repository-object.command.v1"
_OBJECT_RESPONSE_SCHEMA = "opengeo.dataset-repository-object.response.v1"
_OBJECT_VERSIONS_COMMAND_SCHEMA = "opengeo.dataset-repository-object-versions.command.v1"
_OBJECT_VERSIONS_RESPONSE_SCHEMA = "opengeo.dataset-repository-object-versions.response.v1"
_OBJECT_VERSION_COMMAND_SCHEMA = "opengeo.dataset-repository-object-version.command.v1"
_MAX_COMMAND_BYTES = 8_192
_MAX_CURSOR_BYTES = 384
_MAX_VERSION_CURSOR_CHARACTERS = 1_536
_MAX_S3_RESPONSE_BYTES = 524_288


class RepositoryBrowserCommandInvalid(RuntimeError):
    pass


class RepositoryBrowserUnavailable(RuntimeError):
    pass


class RepositoryBrowserAccessDenied(RuntimeError):
    pass


class RepositoryObjectNotFound(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class RepositoryBrowserCommand:
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    prefix: str
    cursor: str | None
    limit: int


@dataclass(frozen=True, slots=True)
class RepositoryObjectInspectionCommand:
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    relative_path: str


@dataclass(frozen=True, slots=True)
class RepositoryObjectVersionsCommand:
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    relative_path: str
    cursor: str | None
    limit: int


@dataclass(frozen=True, slots=True)
class RepositoryObjectVersionInspectionCommand:
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    relative_path: str
    version_id: str


@dataclass(frozen=True, slots=True, repr=False)
class RepositoryBrowserTarget:
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    target_revision: int
    credential_revision: int
    bucket_name: str
    region_name: str
    object_prefix: str
    credential_mode: str
    role_arn: str | None
    secret_reference: str | None


class RepositoryTargetDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


class RepositoryTargetResolver(Protocol):
    async def resolve(
        self,
        command: RepositoryBrowserCommand
        | RepositoryObjectInspectionCommand
        | RepositoryObjectVersionsCommand
        | RepositoryObjectVersionInspectionCommand,
    ) -> RepositoryBrowserTarget: ...


class RdsDataRepositoryTargetResolver:
    def __init__(self, client: RepositoryTargetDataApi) -> None:
        self._client = client

    async def resolve(
        self,
        command: RepositoryBrowserCommand
        | RepositoryObjectInspectionCommand
        | RepositoryObjectVersionsCommand
        | RepositoryObjectVersionInspectionCommand,
    ) -> RepositoryBrowserTarget:
        try:
            result = await self._client.execute(
                """
                SELECT organization_id, owner_user_id, connection_id,
                       target_revision, credential_revision, bucket_name,
                       region_name, object_prefix, credential_mode, role_arn,
                       secret_arn
                FROM app.resolve_user_dataset_repository_target(%s, %s, %s)
                """,
                (command.organization_id, command.owner_user_id, command.connection_id),
            )
        except RdsDataApiUnavailable as error:
            raise RepositoryBrowserUnavailable("repository target unavailable") from error
        if not result.records:
            raise RepositoryBrowserAccessDenied("repository target denied")
        if len(result.records) != 1 or len(result.records[0]) != 11:
            raise RepositoryBrowserUnavailable("repository target invalid")
        row = result.records[0]
        try:
            target = RepositoryBrowserTarget(
                organization_id=_uuid(row[0]),
                owner_user_id=_uuid(row[1]),
                connection_id=_uuid(row[2]),
                target_revision=_positive_int(row[3]),
                credential_revision=_non_negative_int(row[4]),
                bucket_name=_bucket(row[5]),
                region_name=_region(row[6]),
                object_prefix=_object_prefix(row[7]),
                credential_mode=_credential_mode(row[8]),
                role_arn=_optional_role_arn(row[9]),
                secret_reference=_optional_string(row[10], 2048),
            )
        except (TypeError, ValueError) as error:
            raise RepositoryBrowserUnavailable("repository target invalid") from error
        if (
            target.organization_id != command.organization_id
            or target.owner_user_id != command.owner_user_id
            or target.connection_id != command.connection_id
        ):
            raise RepositoryBrowserUnavailable("repository target scope invalid")
        return target


class S3RepositoryLister:
    def __init__(
        self,
        transport: AwsJsonTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def list(
        self,
        credentials: AwsCredentials,
        target: RepositoryBrowserTarget,
        relative_prefix: str,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        return self._list(credentials, target, relative_prefix, cursor, limit)

    def _list(
        self,
        credentials: AwsCredentials,
        target: RepositoryBrowserTarget,
        relative_prefix: str,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        continuation = _decode_cursor(cursor) if cursor is not None else None
        full_prefix = target.object_prefix + relative_prefix
        parameters = {
            "delimiter": "/",
            "encoding-type": "url",
            "list-type": "2",
            "max-keys": str(limit),
            "prefix": full_prefix,
        }
        if continuation is not None:
            parameters["continuation-token"] = continuation
        status, _, body = self._request(
            credentials, target.bucket_name, target.region_name, parameters
        )
        if status in {401, 403}:
            raise RepositoryBrowserAccessDenied("S3 repository access denied")
        if status in {301, 307, 400}:
            raise RepositoryBrowserUnavailable("S3 region or request invalid")
        if status >= 500:
            raise RepositoryBrowserUnavailable("S3 repository unavailable")
        if status != 200:
            raise RepositoryBrowserUnavailable("S3 repository response invalid")
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError as error:
            raise RepositoryBrowserUnavailable("S3 repository response invalid") from error
        if _local_name(root.tag) != "ListBucketResult":
            raise RepositoryBrowserUnavailable("S3 repository response invalid")
        try:
            returned_bucket = _root_text(root, "Name")
            returned_prefix = unquote(_root_text(root, "Prefix"))
            returned_maximum = _bounded_int(_root_text(root, "MaxKeys"), 1, 100)
            _bounded_int(_root_text(root, "KeyCount"), 0, limit)
        except (TypeError, ValueError) as error:
            raise RepositoryBrowserUnavailable("S3 repository response invalid") from error
        if (
            returned_bucket != target.bucket_name
            or returned_prefix != full_prefix
            or returned_maximum != limit
        ):
            raise RepositoryBrowserUnavailable("S3 repository response scope invalid")
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for child in root:
            kind = _local_name(child.tag)
            if kind == "CommonPrefixes":
                encoded = _child_text(child, "Prefix")
                path = _relative_s3_path(encoded, target.object_prefix, full_prefix)
                if path == relative_prefix or not path.endswith("/") or path in seen:
                    continue
                seen.add(path)
                entries.append(_entry("prefix", path, _display_name(path), None, None, None))
            elif kind == "Contents":
                encoded = _child_text(child, "Key")
                path = _relative_s3_path(encoded, target.object_prefix, full_prefix)
                if not path or path in seen:
                    continue
                size = _bounded_int(_child_text(child, "Size"), 0, 5_368_709_120_000)
                modified = _timestamp(_child_text(child, "LastModified"))
                storage_class = _optional_text(_child_text(child, "StorageClass"), 64)
                seen.add(path)
                entries.append(
                    _entry(
                        "object",
                        path,
                        _display_name(path),
                        size,
                        modified.isoformat().replace("+00:00", "Z"),
                        storage_class,
                    )
                )
        truncated_text = _root_text(root, "IsTruncated")
        if truncated_text not in {"true", "false"}:
            raise RepositoryBrowserUnavailable("S3 repository pagination invalid")
        truncated = truncated_text == "true"
        next_token = _root_optional_text(root, "NextContinuationToken")
        if truncated != (next_token is not None):
            raise RepositoryBrowserUnavailable("S3 repository pagination invalid")
        next_cursor = _encode_cursor(next_token) if next_token is not None else None
        return {
            "prefix": relative_prefix,
            "parent_prefix": _parent_prefix(relative_prefix),
            "entries": entries,
            "truncated": truncated,
            "next_cursor": next_cursor,
        }

    async def versions(
        self,
        credentials: AwsCredentials,
        target: RepositoryBrowserTarget,
        relative_path: str,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        cursor_scope = f"{target.connection_id}/{relative_path}"
        version_marker = (
            _decode_version_cursor(cursor, cursor_scope) if cursor is not None else None
        )
        full_key = target.object_prefix + relative_path
        parameters = {
            "encoding-type": "url",
            "max-keys": str(limit),
            "prefix": full_key,
            "versions": "",
        }
        if version_marker is not None:
            parameters["key-marker"] = full_key
            parameters["version-id-marker"] = version_marker
        status, _, body = self._request(
            credentials, target.bucket_name, target.region_name, parameters
        )
        if status in {401, 403}:
            raise RepositoryBrowserAccessDenied("S3 object versions access denied")
        if status in {301, 307, 400} or status >= 500:
            raise RepositoryBrowserUnavailable("S3 object versions unavailable")
        if status != 200:
            raise RepositoryBrowserUnavailable("S3 object versions response invalid")
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError as error:
            raise RepositoryBrowserUnavailable("S3 object versions response invalid") from error
        if _local_name(root.tag) != "ListVersionsResult":
            raise RepositoryBrowserUnavailable("S3 object versions response invalid")
        try:
            returned_bucket = _root_text(root, "Name")
            returned_prefix = unquote(_root_text(root, "Prefix"))
            returned_maximum = _bounded_int(_root_text(root, "MaxKeys"), 1, 100)
        except (TypeError, ValueError) as error:
            raise RepositoryBrowserUnavailable("S3 object versions response invalid") from error
        if (
            returned_bucket != target.bucket_name
            or returned_prefix != full_key
            or returned_maximum != limit
        ):
            raise RepositoryBrowserUnavailable("S3 object versions response scope invalid")

        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for child in root:
            kind = _local_name(child.tag)
            if kind not in {"Version", "DeleteMarker"}:
                continue
            returned_key = unquote(_child_text(child, "Key"))
            if returned_key != full_key:
                # ListObjectVersions applies prefix matching. A sibling such as
                # roads.geojson.bak can share the requested prefix, but it must
                # never cross the exact-object response contract.
                continue
            version_id = _version_id(_child_text(child, "VersionId"), optional=False)
            if version_id is None or version_id in seen:
                raise RepositoryBrowserUnavailable("S3 returned an invalid object version")
            latest_text = _child_text(child, "IsLatest")
            if latest_text not in {"true", "false"}:
                raise RepositoryBrowserUnavailable("S3 returned an invalid object version")
            modified = _timestamp(_child_text(child, "LastModified"))
            delete_marker = kind == "DeleteMarker"
            if delete_marker:
                size = None
                etag = None
                storage_class = None
            else:
                size = _bounded_int(_child_text(child, "Size"), 0, 5_368_709_120_000)
                etag = _required_header(_child_text(child, "ETag"), 1024)
                storage_class = _optional_header(_child_optional_text(child, "StorageClass"), 64)
            seen.add(version_id)
            entries.append(
                {
                    "version_id": version_id,
                    "is_latest": latest_text == "true",
                    "is_delete_marker": delete_marker,
                    "last_modified": modified.isoformat().replace("+00:00", "Z"),
                    "size_bytes": size,
                    "etag": etag,
                    "storage_class": storage_class,
                }
            )
        if len(entries) > limit:
            raise RepositoryBrowserUnavailable("S3 object versions exceed page limit")
        truncated_text = _root_text(root, "IsTruncated")
        if truncated_text not in {"true", "false"}:
            raise RepositoryBrowserUnavailable("S3 object versions pagination invalid")
        provider_truncated = truncated_text == "true"
        next_key = _root_optional_text(root, "NextKeyMarker")
        next_version = _root_optional_text(root, "NextVersionIdMarker")
        if provider_truncated and (next_key is None or next_version is None):
            raise RepositoryBrowserUnavailable("S3 object versions pagination invalid")
        if not provider_truncated and (next_key is not None or next_version is not None):
            raise RepositoryBrowserUnavailable("S3 object versions pagination invalid")
        # A marker for a sibling key means the requested object's history has
        # ended even when the provider response has more prefix matches.
        truncated = provider_truncated and unquote(next_key or "") == full_key
        next_cursor = (
            _encode_version_cursor(cursor_scope, next_version)
            if truncated and next_version is not None
            else None
        )
        return {
            "relative_path": relative_path,
            "entries": entries,
            "truncated": truncated,
            "next_cursor": next_cursor,
        }

    def _request(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        parameters: Mapping[str, str],
    ) -> tuple[int, Mapping[str, str], bytes]:
        host = regional_s3_host(region)
        path = bucket_path(bucket)
        query = _form_query(parameters)
        headers = _signed_headers(
            method="GET",
            canonical_uri=path,
            canonical_query=query,
            host=host,
            region=region,
            service="s3",
            credentials=credentials,
            body=b"",
            now=self._now(),
        )
        return self._transport.call(
            "GET", f"https://{host}{path}?{query}", headers, b"", 8.0, _MAX_S3_RESPONSE_BYTES
        )

    async def inspect(
        self,
        credentials: AwsCredentials,
        target: RepositoryBrowserTarget,
        relative_path: str,
        version_id: str | None = None,
    ) -> dict[str, Any]:
        requested_version_id = version_id
        full_key = target.object_prefix + relative_path
        host = regional_s3_host(target.region_name)
        path = object_path(target.bucket_name, full_key)
        query = "" if version_id is None else _form_query({"versionId": version_id})
        headers = _signed_headers(
            method="HEAD",
            canonical_uri=path,
            canonical_query=query,
            host=host,
            region=target.region_name,
            service="s3",
            credentials=credentials,
            body=b"",
            now=self._now(),
        )
        url = f"https://{host}{path}" + (f"?{query}" if query else "")
        status, response_headers, body = self._transport.call("HEAD", url, headers, b"", 8.0, 0)
        if body:
            raise RepositoryBrowserUnavailable("S3 object metadata response invalid")
        if status in {401, 403}:
            raise RepositoryBrowserAccessDenied("S3 object access denied")
        if status in {404, 405}:
            raise RepositoryObjectNotFound("S3 object not found")
        if status in {301, 307, 400} or status >= 500:
            raise RepositoryBrowserUnavailable("S3 object metadata unavailable")
        if status != 200:
            raise RepositoryBrowserUnavailable("S3 object metadata response invalid")
        normalized = {key.lower(): value for key, value in response_headers.items()}
        try:
            size = _bounded_int(normalized["content-length"], 0, 5_368_709_120_000)
            modified = parsedate_to_datetime(normalized["last-modified"])
            if modified.tzinfo is None or modified.utcoffset() is None:
                raise ValueError("last-modified must include a timezone")
            etag = _required_header(normalized.get("etag"), 1024)
            content_type = _optional_header(normalized.get("content-type"), 256)
            storage_class = _optional_header(normalized.get("x-amz-storage-class"), 64)
            returned_version_id = _version_id(normalized.get("x-amz-version-id"), optional=True)
            checksum = _checksum_sha256(normalized.get("x-amz-checksum-sha256"))
        except (KeyError, TypeError, ValueError) as error:
            raise RepositoryBrowserUnavailable("S3 object metadata response invalid") from error
        if requested_version_id is None and returned_version_id == "null":
            returned_version_id = None
        if requested_version_id is not None and returned_version_id != requested_version_id:
            raise RepositoryBrowserUnavailable("S3 object version identity changed")
        return {
            "relative_path": relative_path,
            "name": _display_name(relative_path),
            "size_bytes": size,
            "last_modified": modified.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "content_type": content_type,
            "etag": etag,
            "storage_class": storage_class,
            "version_id": returned_version_id,
            "checksum_sha256": checksum,
        }


class RepositoryBrowserProcessor:
    def __init__(
        self,
        resolver: RepositoryTargetResolver,
        secret_loader: AwsUserDatasetCredentialLoader,
        role_assumer: AwsStsRoleAssumer,
        task_credentials: CredentialProvider,
        lister: S3RepositoryLister,
    ) -> None:
        self._resolver = resolver
        self._secret_loader = secret_loader
        self._role_assumer = role_assumer
        self._task_credentials = task_credentials
        self._lister = lister

    async def browse(self, command: RepositoryBrowserCommand) -> dict[str, Any]:
        target = await self._resolver.resolve(command)
        credentials = await self._credentials(target)
        return await self._lister.list(
            credentials, target, command.prefix, command.cursor, command.limit
        )

    async def inspect(self, command: RepositoryObjectInspectionCommand) -> dict[str, Any]:
        target = await self._resolver.resolve(command)
        credentials = await self._credentials(target)
        return await self._lister.inspect(credentials, target, command.relative_path)

    async def versions(self, command: RepositoryObjectVersionsCommand) -> dict[str, Any]:
        target = await self._resolver.resolve(command)
        credentials = await self._credentials(target)
        return await self._lister.versions(
            credentials,
            target,
            command.relative_path,
            command.cursor,
            command.limit,
        )

    async def inspect_version(
        self, command: RepositoryObjectVersionInspectionCommand
    ) -> dict[str, Any]:
        target = await self._resolver.resolve(command)
        credentials = await self._credentials(target)
        return await self._lister.inspect(
            credentials, target, command.relative_path, command.version_id
        )

    async def _credentials(self, target: RepositoryBrowserTarget) -> AwsCredentials:
        claim = DatasetVerificationClaim(
            verification_id=UUID(int=0),
            organization_id=target.organization_id,
            owner_user_id=target.owner_user_id,
            connection_id=target.connection_id,
            target_revision=target.target_revision,
            credential_revision=target.credential_revision,
            bucket_name=target.bucket_name,
            region_name=target.region_name,
            object_prefix=target.object_prefix,
            credential_mode=target.credential_mode,
            role_arn=target.role_arn,
            secret_reference=target.secret_reference,
        )
        try:
            loaded = await self._secret_loader.load(claim)
            if target.credential_mode == "assume_role":
                external_id = loaded.values.get("external_id")
                if target.role_arn is None or not external_id:
                    raise RepositoryBrowserAccessDenied("repository credentials invalid")
                try:
                    credentials = await self._role_assumer.assume(target.role_arn, external_id)
                except AssumeRoleDenied as error:
                    raise RepositoryBrowserAccessDenied("repository role denied") from error
            elif target.credential_mode == "access_key":
                credentials = AwsCredentials(
                    loaded.values["access_key_id"],
                    loaded.values["secret_access_key"],
                    loaded.values.get("session_token"),
                )
            elif target.credential_mode == "workload_identity":
                credentials = self._task_credentials.load()
            else:
                raise RepositoryBrowserAccessDenied("repository credentials invalid")
        except (DatasetVerificationRejected, KeyError, IdentityProvisioningUnavailable) as error:
            raise RepositoryBrowserAccessDenied("repository credentials invalid") from error
        except DatasetVerificationDependencyUnavailable as error:
            raise RepositoryBrowserUnavailable("repository credentials unavailable") from error
        return credentials


def parse_command(event: Mapping[str, Any]) -> RepositoryBrowserCommand:
    try:
        encoded = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository browser command invalid") from error
    if (
        len(encoded) > _MAX_COMMAND_BYTES
        or set(event)
        != {
            "schema",
            "organization_id",
            "owner_user_id",
            "connection_id",
            "prefix",
            "cursor",
            "limit",
        }
        or event.get("schema") != _COMMAND_SCHEMA
    ):
        raise RepositoryBrowserCommandInvalid("repository browser command invalid")
    prefix = event.get("prefix")
    cursor = event.get("cursor")
    limit = event.get("limit")
    if (
        not isinstance(prefix, str)
        or not _valid_relative_prefix(prefix)
        or (
            cursor is not None
            and (
                not isinstance(cursor, str)
                or len(cursor) > 512
                or re.fullmatch(r"[A-Za-z0-9_-]+", cursor) is None
            )
        )
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 100
    ):
        raise RepositoryBrowserCommandInvalid("repository browser command invalid")
    try:
        command = RepositoryBrowserCommand(
            _uuid(event.get("organization_id")),
            _uuid(event.get("owner_user_id")),
            _uuid(event.get("connection_id")),
            prefix,
            cursor,
            limit,
        )
        if cursor is not None:
            _decode_cursor(cursor)
        return command
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository browser command invalid") from error


def parse_object_command(event: Mapping[str, Any]) -> RepositoryObjectInspectionCommand:
    try:
        encoded = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository object command invalid") from error
    if (
        len(encoded) > _MAX_COMMAND_BYTES
        or set(event)
        != {
            "schema",
            "organization_id",
            "owner_user_id",
            "connection_id",
            "relative_path",
        }
        or event.get("schema") != _OBJECT_COMMAND_SCHEMA
    ):
        raise RepositoryBrowserCommandInvalid("repository object command invalid")
    relative_path = event.get("relative_path")
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or relative_path.endswith("/")
        or not _valid_relative_path(relative_path)
    ):
        raise RepositoryBrowserCommandInvalid("repository object command invalid")
    try:
        return RepositoryObjectInspectionCommand(
            _uuid(event.get("organization_id")),
            _uuid(event.get("owner_user_id")),
            _uuid(event.get("connection_id")),
            relative_path,
        )
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository object command invalid") from error


def parse_object_versions_command(
    event: Mapping[str, Any],
) -> RepositoryObjectVersionsCommand:
    try:
        encoded = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository versions command invalid") from error
    if (
        len(encoded) > _MAX_COMMAND_BYTES
        or set(event)
        != {
            "schema",
            "organization_id",
            "owner_user_id",
            "connection_id",
            "relative_path",
            "cursor",
            "limit",
        }
        or event.get("schema") != _OBJECT_VERSIONS_COMMAND_SCHEMA
    ):
        raise RepositoryBrowserCommandInvalid("repository versions command invalid")
    relative_path = event.get("relative_path")
    cursor = event.get("cursor")
    limit = event.get("limit")
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or relative_path.endswith("/")
        or not _valid_relative_path(relative_path)
        or (
            cursor is not None
            and (
                not isinstance(cursor, str)
                or len(cursor) > _MAX_VERSION_CURSOR_CHARACTERS
                or re.fullmatch(r"[A-Za-z0-9_-]+", cursor) is None
            )
        )
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 100
    ):
        raise RepositoryBrowserCommandInvalid("repository versions command invalid")
    try:
        command = RepositoryObjectVersionsCommand(
            _uuid(event.get("organization_id")),
            _uuid(event.get("owner_user_id")),
            _uuid(event.get("connection_id")),
            relative_path,
            cursor,
            limit,
        )
        if cursor is not None:
            _decode_version_cursor(
                cursor,
                f"{command.connection_id}/{command.relative_path}",
            )
        return command
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository versions command invalid") from error


def parse_object_version_command(
    event: Mapping[str, Any],
) -> RepositoryObjectVersionInspectionCommand:
    try:
        encoded = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository version command invalid") from error
    if (
        len(encoded) > _MAX_COMMAND_BYTES
        or set(event)
        != {
            "schema",
            "organization_id",
            "owner_user_id",
            "connection_id",
            "relative_path",
            "version_id",
        }
        or event.get("schema") != _OBJECT_VERSION_COMMAND_SCHEMA
    ):
        raise RepositoryBrowserCommandInvalid("repository version command invalid")
    relative_path = event.get("relative_path")
    version_id = event.get("version_id")
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or relative_path.endswith("/")
        or not _valid_relative_path(relative_path)
        or not isinstance(version_id, str)
        or not 1 <= len(version_id) <= 1024
        or len(version_id.encode()) > 1024
        or _has_controls(version_id)
    ):
        raise RepositoryBrowserCommandInvalid("repository version command invalid")
    try:
        return RepositoryObjectVersionInspectionCommand(
            _uuid(event.get("organization_id")),
            _uuid(event.get("owner_user_id")),
            _uuid(event.get("connection_id")),
            relative_path,
            version_id,
        )
    except (TypeError, ValueError) as error:
        raise RepositoryBrowserCommandInvalid("repository version command invalid") from error


_DEFAULT_PROCESSOR: RepositoryBrowserProcessor | None = None


def default_processor() -> RepositoryBrowserProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        settings = UserDatasetVerifierSettings.from_environment()
        task_credentials = AwsCredentialProvider()
        _DEFAULT_PROCESSOR = RepositoryBrowserProcessor(
            RdsDataRepositoryTargetResolver(RdsDataApiClient(settings.data_api_settings())),
            AwsUserDatasetCredentialLoader(settings, credentials=task_credentials),
            AwsStsRoleAssumer(settings.region, credentials=task_credentials),
            task_credentials,
            S3RepositoryLister(),
        )
    return _DEFAULT_PROCESSOR


async def handle_event(
    event: Mapping[str, Any], processor: RepositoryBrowserProcessor
) -> dict[str, Any]:
    command_schema = event.get("schema")
    response_schema_key = command_schema if isinstance(command_schema, str) else ""
    response_schema = {
        _OBJECT_COMMAND_SCHEMA: _OBJECT_RESPONSE_SCHEMA,
        _OBJECT_VERSION_COMMAND_SCHEMA: _OBJECT_RESPONSE_SCHEMA,
        _OBJECT_VERSIONS_COMMAND_SCHEMA: _OBJECT_VERSIONS_RESPONSE_SCHEMA,
    }.get(response_schema_key, _RESPONSE_SCHEMA)
    try:
        if command_schema == _OBJECT_COMMAND_SCHEMA:
            record = await processor.inspect(parse_object_command(event))
            return {"schema": response_schema, "ok": True, "object": record}
        if command_schema == _OBJECT_VERSION_COMMAND_SCHEMA:
            record = await processor.inspect_version(parse_object_version_command(event))
            return {"schema": response_schema, "ok": True, "object": record}
        if command_schema == _OBJECT_VERSIONS_COMMAND_SCHEMA:
            page = await processor.versions(parse_object_versions_command(event))
            return {"schema": response_schema, "ok": True, "page": page}
        page = await processor.browse(parse_command(event))
        return {"schema": response_schema, "ok": True, "page": page}
    except RepositoryBrowserAccessDenied:
        return {"schema": response_schema, "ok": False, "error": "access_denied"}
    except RepositoryObjectNotFound:
        return {"schema": response_schema, "ok": False, "error": "not_found"}
    except (RepositoryBrowserCommandInvalid, RepositoryBrowserUnavailable):
        return {"schema": response_schema, "ok": False, "error": "unavailable"}
    except Exception:
        return {"schema": response_schema, "ok": False, "error": "unavailable"}


def handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    del context
    return asyncio.run(handle_event(event, default_processor()))


def _entry(
    kind: str,
    path: str,
    name: str,
    size: int | None,
    modified: str | None,
    storage_class: str | None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "relative_path": path,
        "name": name,
        "size_bytes": size,
        "last_modified": modified,
        "storage_class": storage_class,
        "version_id": None,
    }


def _valid_relative_prefix(value: str) -> bool:
    if len(value.encode()) > 1024 or value.startswith(("/", "\\")) or "\\" in value:
        return False
    if value and not value.endswith("/"):
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    return all(segment not in {".", ".."} for segment in value.split("/"))


def _valid_relative_path(value: str) -> bool:
    if len(value.encode()) > 1024 or value.startswith(("/", "\\")) or "\\" in value:
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    return all(segment not in {".", ".."} for segment in value.split("/"))


def _encode_cursor(value: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode()) > _MAX_CURSOR_BYTES:
        raise RepositoryBrowserUnavailable("S3 continuation token exceeds bound")
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def _decode_cursor(value: str) -> str:
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
        text = decoded.decode()
    except (ValueError, UnicodeDecodeError) as error:
        raise RepositoryBrowserCommandInvalid("repository cursor invalid") from error
    if not text or len(decoded) > _MAX_CURSOR_BYTES:
        raise RepositoryBrowserCommandInvalid("repository cursor invalid")
    return text


def _version_cursor_scope(scope: str) -> str:
    return sha256(scope.encode()).hexdigest()[:24]


def _encode_version_cursor(scope: str, version_marker: str) -> str:
    if (
        not isinstance(scope, str)
        or not scope
        or not isinstance(version_marker, str)
        or not version_marker
        or len(version_marker.encode()) > 1024
        or _has_controls(version_marker)
    ):
        raise RepositoryBrowserUnavailable("S3 object version marker exceeds bound")
    payload = json.dumps(
        {"scope": _version_cursor_scope(scope), "version": version_marker},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_version_cursor(value: str, scope: str) -> str:
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
        payload = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RepositoryBrowserCommandInvalid("repository version cursor invalid") from error
    if not isinstance(payload, dict) or set(payload) != {"scope", "version"}:
        raise RepositoryBrowserCommandInvalid("repository version cursor invalid")
    scope_token = payload.get("scope")
    version_marker = payload.get("version")
    if (
        scope_token != _version_cursor_scope(scope)
        or not isinstance(version_marker, str)
        or not version_marker
        or len(version_marker.encode()) > 1024
        or _has_controls(version_marker)
    ):
        raise RepositoryBrowserCommandInvalid("repository version cursor invalid")
    return version_marker


def _relative_s3_path(encoded: str, root_prefix: str, requested_prefix: str) -> str:
    value = unquote(encoded)
    if (
        not value.startswith(requested_prefix)
        or not value.startswith(root_prefix)
        or len(value.encode()) > 1024
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise RepositoryBrowserUnavailable("S3 returned an out-of-scope key")
    relative = value[len(root_prefix) :]
    if relative.startswith(("/", "\\")) or "\\" in relative:
        raise RepositoryBrowserUnavailable("S3 returned an unsafe relative key")
    if any(segment in {".", ".."} for segment in relative.split("/")):
        raise RepositoryBrowserUnavailable("S3 returned an unsafe relative key")
    return relative


def _parent_prefix(value: str) -> str | None:
    if not value:
        return None
    parts = value.rstrip("/").split("/")
    return "" if len(parts) == 1 else "/".join(parts[:-1]) + "/"


def _display_name(path: str) -> str:
    name = path.rstrip("/").rsplit("/", 1)[-1]
    if not 1 <= len(name) <= 1024:
        raise RepositoryBrowserUnavailable("S3 returned an invalid name")
    return name


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child_text(element: ElementTree.Element, name: str) -> str:
    for child in element:
        if _local_name(child.tag) == name and child.text is not None:
            return child.text
    raise RepositoryBrowserUnavailable("S3 repository field missing")


def _child_optional_text(element: ElementTree.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name:
            return child.text
    return None


def _root_text(root: ElementTree.Element, name: str) -> str:
    value = _root_optional_text(root, name)
    if value is None:
        raise RepositoryBrowserUnavailable("S3 repository field missing")
    return value


def _root_optional_text(root: ElementTree.Element, name: str) -> str | None:
    for child in root:
        if _local_name(child.tag) == name:
            return child.text
    return None


def _timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must have timezone")
    return parsed.astimezone(UTC)


def _bounded_int(value: str, minimum: int, maximum: int) -> int:
    parsed = int(value)
    if not minimum <= parsed <= maximum:
        raise ValueError("integer outside bound")
    return parsed


def _optional_text(value: str, maximum: int) -> str | None:
    return value if value and len(value) <= maximum else None


def _required_header(value: str | None, maximum: int) -> str:
    if value is None or not 1 <= len(value) <= maximum or _has_controls(value):
        raise ValueError("invalid required header")
    return value


def _optional_header(value: str | None, maximum: int) -> str | None:
    if value is None or value == "":
        return None
    if len(value) > maximum or _has_controls(value):
        raise ValueError("invalid optional header")
    return value


def _version_id(value: str | None, *, optional: bool) -> str | None:
    if optional and (value is None or value == ""):
        return None
    parsed = _required_header(value, 1024)
    if len(parsed.encode()) > 1024:
        raise ValueError("invalid version id")
    return parsed


def _checksum_sha256(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise ValueError("invalid checksum") from error
    if len(decoded) != 32:
        raise ValueError("invalid checksum")
    return value


def _has_controls(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _uuid(value: Any) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


def _positive_int(value: Any) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError("positive integer required")
    return parsed


def _non_negative_int(value: Any) -> int:
    parsed = int(value)
    if parsed < 0:
        raise ValueError("non-negative integer required")
    return parsed


def _bucket(value: Any) -> str:
    text = str(value)
    if re.fullmatch(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", text) is None:
        raise ValueError("invalid bucket")
    return text


def _region(value: Any) -> str:
    text = str(value)
    if re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+", text) is None:
        raise ValueError("invalid region")
    return text


def _object_prefix(value: Any) -> str:
    text = str(value)
    if len(text.encode()) > 1024 or text.startswith(("/", "\\")) or "\\" in text:
        raise ValueError("invalid prefix")
    if any(ord(character) < 32 or ord(character) == 127 for character in text):
        raise ValueError("invalid prefix")
    return text


def _credential_mode(value: Any) -> str:
    text = str(value)
    if text not in {"workload_identity", "assume_role", "access_key"}:
        raise ValueError("invalid credential mode")
    return text


def _optional_role_arn(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    if re.fullmatch(r"arn:aws(?:-us-gov)?:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/-]+", text) is None:
        raise ValueError("invalid role ARN")
    return text


def _optional_string(value: Any, maximum: int) -> str | None:
    if value is None:
        return None
    text = str(value)
    if not 1 <= len(text) <= maximum:
        raise ValueError("invalid string")
    return text
