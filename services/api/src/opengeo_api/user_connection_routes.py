import base64
import binascii
import ipaddress
import logging
import re
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.dataset_repository_browser import (
    DatasetRepositoryAccessDenied,
    DatasetRepositoryObject,
    DatasetRepositoryObjectNotFound,
    DatasetRepositoryObjectVersion,
    DatasetRepositoryObjectVersionsPage,
    DatasetRepositoryPage,
    DatasetRepositoryResponseInvalid,
    DatasetRepositoryUnavailable,
    UserDatasetRepositoryBrowser,
)
from opengeo_api.ingestion import (
    IngestionAccessDenied,
    IngestionConflict,
    IngestionNotFound,
    IngestionRepository,
    IngestionStoreUnavailable,
    PostgresIngestionRepository,
    RepositoryObjectDraft,
    RepositoryObjectRegistration,
)
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import (
    ProcessingDispatchUnavailable,
    UserDatasetVerificationDispatcher,
)
from opengeo_api.tenant_database import TenantContext
from opengeo_api.user_connections import (
    ProjectDatasetConnectionBinding,
    UserConnectionAccessDenied,
    UserConnectionConflict,
    UserConnectionNotFound,
    UserConnectionStoreUnavailable,
    UserDatasetConnection,
    UserDatasetConnectionDraft,
    UserDatasetConnectionOverview,
    UserDatasetConnectionProjectReference,
    UserDatasetConnectionRepository,
    UserDatasetConnectionVerification,
    UserDatasetCredentials,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["user dataset connections"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
RegionName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=3,
        max_length=32,
        pattern=r"^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$",
    ),
]
RoleArn = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=32,
        max_length=2048,
        pattern=r"^arn:aws(?:-us-gov)?:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/-]+$",
    ),
]
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000),
]
Tag = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=64),
]
RepositoryDatasetFormat = Literal[
    "geojson",
    "csv",
    "shapefile",
    "geopackage",
    "geoparquet",
    "cog",
    "pmtiles",
    "png",
    "jpeg",
    "pdf",
    "odt",
]

_REPOSITORY_FORMAT_EXTENSIONS: dict[RepositoryDatasetFormat, frozenset[str]] = {
    "geojson": frozenset({".geojson", ".json"}),
    "csv": frozenset({".csv"}),
    "shapefile": frozenset({".zip"}),
    "geopackage": frozenset({".gpkg"}),
    "geoparquet": frozenset({".parquet", ".geoparquet"}),
    "cog": frozenset({".tif", ".tiff"}),
    "pmtiles": frozenset({".pmtiles"}),
    "png": frozenset({".png"}),
    "jpeg": frozenset({".jpg", ".jpeg"}),
    "pdf": frozenset({".pdf"}),
    "odt": frozenset({".odt"}),
}

_BUCKET_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.-]*[a-z0-9]$")
_RESERVED_BUCKET_PREFIXES = ("xn--", "sthree-", "amzn-s3-demo-")
_RESERVED_BUCKET_SUFFIXES = ("-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3")


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateUserDatasetConnectionRequest(RequestModel):
    provider: Literal["s3"] = "s3"
    display_name: Name
    bucket_name: Annotated[
        str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=63)
    ]
    region_name: RegionName = "us-east-1"
    object_prefix: str = Field(default="", max_length=1024)
    credential_mode: Literal["workload_identity", "assume_role", "access_key"]
    role_arn: RoleArn | None = None

    @field_validator("bucket_name", mode="after")
    @classmethod
    def valid_s3_bucket(cls, value: str) -> str:
        if (
            _BUCKET_PATTERN.fullmatch(value) is None
            or ".." in value
            or ".-" in value
            or "-." in value
            or value.startswith(_RESERVED_BUCKET_PREFIXES)
            or value.endswith(_RESERVED_BUCKET_SUFFIXES)
        ):
            raise ValueError("bucket_name is not a supported S3 general-purpose bucket name")
        try:
            ipaddress.ip_address(value)
        except ValueError:
            return value
        raise ValueError("bucket_name must not use IP address notation")

    @field_validator("object_prefix", mode="after")
    @classmethod
    def valid_object_prefix(cls, value: str) -> str:
        if value.startswith(("/", "\\")) or "\\" in value:
            raise ValueError("object_prefix must be an S3 key prefix, not a local path")
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("object_prefix contains a control character")
        return value

    @model_validator(mode="after")
    def valid_role_mode(self) -> "CreateUserDatasetConnectionRequest":
        if self.credential_mode == "assume_role" and self.role_arn is None:
            raise ValueError("role_arn is required for assume_role")
        if self.credential_mode != "assume_role" and self.role_arn is not None:
            raise ValueError("role_arn is supported only for assume_role")
        return self


class UpdateUserDatasetConnectionRequest(RequestModel):
    display_name: Name | None = None
    bucket_name: str | None = Field(default=None, min_length=3, max_length=63)
    region_name: RegionName | None = None
    object_prefix: str | None = Field(default=None, max_length=1024)
    role_arn: RoleArn | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def validate_changes(self) -> "UpdateUserDatasetConnectionRequest":
        if not self.model_fields_set:
            raise ValueError("at least one connection field is required")
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("connection update fields cannot be null")
        if "bucket_name" in self.model_fields_set:
            normalized = CreateUserDatasetConnectionRequest.valid_s3_bucket(
                cast(str, self.bucket_name).strip().lower()
            )
            object.__setattr__(self, "bucket_name", normalized)
        if "object_prefix" in self.model_fields_set:
            CreateUserDatasetConnectionRequest.valid_object_prefix(cast(str, self.object_prefix))
        return self


class ReplaceUserDatasetCredentialsRequest(RequestModel):
    expected_credential_revision: int = Field(ge=0)
    external_id: SecretStr | None = Field(default=None, min_length=2, max_length=1224)
    access_key_id: SecretStr | None = Field(default=None, min_length=16, max_length=128)
    secret_access_key: SecretStr | None = Field(default=None, min_length=20, max_length=256)
    session_token: SecretStr | None = Field(default=None, min_length=16, max_length=4096)

    @field_validator("external_id", "access_key_id", "secret_access_key", "session_token")
    @classmethod
    def valid_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return value
        raw = value.get_secret_value()
        if raw != raw.strip() or any(
            ord(character) < 32 or ord(character) == 127 for character in raw
        ):
            raise ValueError("credential contains unsupported whitespace or control characters")
        return value

    def secret_values(self) -> dict[str, str]:
        return {
            field: cast(SecretStr, getattr(self, field)).get_secret_value()
            for field in ("external_id", "access_key_id", "secret_access_key", "session_token")
            if getattr(self, field) is not None
        }


class CreateProjectDatasetConnectionBindingRequest(RequestModel):
    connection_id: UUID
    display_name: Name


class RegisterRepositoryObjectRequest(RequestModel):
    project_id: UUID
    relative_path: str = Field(min_length=1, max_length=1024)
    version_id: str = Field(min_length=1, max_length=1024)
    name: Name
    description: Description | None = None
    classification: Literal["public", "internal", "confidential", "restricted"] = "internal"
    format: RepositoryDatasetFormat
    tags: list[Tag] = Field(default_factory=list, max_length=12)

    @field_validator("relative_path", mode="after")
    @classmethod
    def valid_relative_path(cls, value: str) -> str:
        if not _valid_repository_relative_value(value) or value.endswith("/"):
            raise ValueError("relative_path must identify one repository object")
        return value

    @field_validator("version_id", mode="after")
    @classmethod
    def exact_immutable_version(cls, value: str) -> str:
        if (
            value == "null"
            or len(value.encode()) > 1024
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            raise ValueError("version_id must identify an immutable provider version")
        return value

    @field_validator("tags", mode="after")
    @classmethod
    def normalized_unique_tags(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(values))
        if len(normalized) != len(values):
            raise ValueError("tags must be unique")
        return normalized

    @model_validator(mode="after")
    def format_matches_path(self) -> "RegisterRepositoryObjectRequest":
        filename = self.relative_path.rsplit("/", maxsplit=1)[-1].lower()
        extensions = _REPOSITORY_FORMAT_EXTENSIONS[self.format]
        if not any(filename.endswith(extension) for extension in extensions):
            raise ValueError("format does not match the repository object name")
        return self


class UserDatasetConnectionResponse(BaseModel):
    connection_id: UUID
    owner_user_id: UUID
    provider: str
    display_name: str
    bucket_name: str
    region_name: str
    object_prefix: str
    credential_mode: str
    role_arn: str | None
    configured_secret_fields: list[str]
    credential_revision: int
    target_revision: int
    credential_ready: bool
    status: str
    last_verified_at: datetime | None
    sanitized_error_code: str | None
    created_at: datetime
    updated_at: datetime
    owned_by_caller: bool
    verification_available: bool = False
    repository_browse_available: bool = False


class DatasetRepositoryEntryResponse(BaseModel):
    kind: Literal["prefix", "object"]
    relative_path: str
    name: str
    size_bytes: int | None
    last_modified: datetime | None
    storage_class: str | None
    version_id: str | None


class DatasetRepositoryPageResponse(BaseModel):
    connection_id: UUID
    prefix: str
    parent_prefix: str | None
    entries: list[DatasetRepositoryEntryResponse]
    truncated: bool
    next_cursor: str | None


class DatasetRepositoryObjectResponse(BaseModel):
    connection_id: UUID
    relative_path: str
    name: str
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    version_id: str | None
    checksum_sha256: str | None


class DatasetRepositoryObjectVersionResponse(BaseModel):
    version_id: str
    is_latest: bool
    is_delete_marker: bool
    last_modified: datetime
    size_bytes: int | None
    etag: str | None
    storage_class: str | None


class DatasetRepositoryObjectVersionsPageResponse(BaseModel):
    connection_id: UUID
    relative_path: str
    entries: list[DatasetRepositoryObjectVersionResponse]
    truncated: bool
    next_cursor: str | None


class RepositoryObjectSourceResponse(BaseModel):
    dataset_id: UUID
    connection_id: UUID
    connection_target_revision: int
    provider: Literal["s3"]
    bucket_name: str
    region_name: str
    object_prefix: str
    relative_path: str
    provider_version_id: str
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    provider_checksum_sha256: str | None
    created_by: UUID
    created_at: datetime


class RepositoryObjectRegistrationResponse(BaseModel):
    dataset_id: UUID
    project_id: UUID
    name: str
    classification: str
    format: str
    created: bool
    attached: bool
    source: RepositoryObjectSourceResponse


class ProjectDatasetConnectionBindingResponse(BaseModel):
    binding_id: UUID
    project_id: UUID
    display_name: str
    created_by: UUID
    created_at: datetime
    connection: UserDatasetConnectionResponse


class UserDatasetConnectionVerificationResponse(BaseModel):
    verification_id: UUID
    connection_id: UUID
    target_revision: int
    credential_revision: int
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    attempt_count: int
    bucket_access_confirmed: bool
    object_access_confirmed: bool
    deny_canaries_confirmed: bool
    objects_observed: int
    sanitized_error_code: str | None
    duration_ms: int | None
    requested_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class UserDatasetConnectionVerificationSubmissionResponse(BaseModel):
    verification: UserDatasetConnectionVerificationResponse
    created: bool


class UserDatasetConnectionProjectReferenceResponse(BaseModel):
    binding_id: UUID
    project_id: UUID
    project_name: str
    project_status: Literal["active", "archived"]
    display_name: str
    created_at: datetime


class UserDatasetConnectionOverviewResponse(BaseModel):
    connection_id: UUID
    target_revision: int
    credential_revision: int
    health: Literal[
        "healthy",
        "checking",
        "needs_verification",
        "check_failed",
        "needs_credentials",
        "disabled",
    ]
    latest_verification: UserDatasetConnectionVerificationResponse | None
    project_references: list[UserDatasetConnectionProjectReferenceResponse]


def repository_from_request(request: Request) -> UserDatasetConnectionRepository:
    return cast(UserDatasetConnectionRepository, request.app.state.user_connection_repository)


def verification_dispatcher_from_request(
    request: Request,
) -> UserDatasetVerificationDispatcher:
    return cast(
        UserDatasetVerificationDispatcher,
        request.app.state.user_dataset_verification_dispatcher,
    )


def repository_browser_from_request(request: Request) -> UserDatasetRepositoryBrowser:
    return cast(
        UserDatasetRepositoryBrowser,
        request.app.state.user_dataset_repository_browser,
    )


def ingestion_repository_from_request(request: Request) -> IngestionRepository:
    repository = request.app.state.ingestion_repository
    if not isinstance(repository, PostgresIngestionRepository):
        return cast(IngestionRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_user_connection[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except UserConnectionAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except UserConnectionNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except UserConnectionConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except UserConnectionStoreUnavailable as error:
        logger.error(
            "user_connection.store_unavailable",
            extra={"error_type": type(error).__name__},
        )
        raise HTTPException(status_code=503, detail="user_connection_store_unavailable") from error


async def execute_repository_registration[ResponseT](
    operation: Awaitable[ResponseT],
) -> ResponseT:
    try:
        return await operation
    except IngestionAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except IngestionNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except IngestionConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except IngestionStoreUnavailable as error:
        logger.error(
            "dataset_repository.registration_store_unavailable",
            extra={"error_type": type(error).__name__},
        )
        raise HTTPException(
            status_code=503, detail="dataset_repository_registration_unavailable"
        ) from error


def connection_response(
    record: UserDatasetConnection,
    *,
    verification_available: bool = False,
    repository_browse_available: bool = False,
) -> UserDatasetConnectionResponse:
    credential_ready = record.credential_mode != "access_key" or record.credential_revision > 0
    return UserDatasetConnectionResponse(
        connection_id=record.connection_id,
        owner_user_id=record.owner_user_id,
        provider=record.provider,
        display_name=record.display_name,
        bucket_name=record.bucket_name,
        region_name=record.region_name,
        object_prefix=record.object_prefix,
        credential_mode=record.credential_mode,
        role_arn=record.role_arn,
        configured_secret_fields=list(record.configured_secret_fields),
        credential_revision=record.credential_revision,
        target_revision=record.target_revision,
        credential_ready=credential_ready,
        status=record.status,
        last_verified_at=record.last_verified_at,
        sanitized_error_code=record.sanitized_error_code,
        created_at=record.created_at,
        updated_at=record.updated_at,
        owned_by_caller=record.owned_by_caller,
        verification_available=verification_available,
        repository_browse_available=repository_browse_available,
    )


def repository_page_response(
    connection_id: UUID,
    page: DatasetRepositoryPage,
    *,
    requested_prefix: str,
    limit: int,
) -> DatasetRepositoryPageResponse:
    _validate_repository_page(page, requested_prefix=requested_prefix, limit=limit)
    return DatasetRepositoryPageResponse(
        connection_id=connection_id,
        prefix=page.prefix,
        parent_prefix=page.parent_prefix,
        entries=[
            DatasetRepositoryEntryResponse(
                kind=entry.kind,
                relative_path=entry.relative_path,
                name=entry.name,
                size_bytes=entry.size_bytes,
                last_modified=entry.last_modified,
                storage_class=entry.storage_class,
                version_id=entry.version_id,
            )
            for entry in page.entries
        ],
        truncated=page.truncated,
        next_cursor=page.next_cursor,
    )


def repository_object_response(
    connection_id: UUID,
    record: DatasetRepositoryObject,
    *,
    requested_path: str,
) -> DatasetRepositoryObjectResponse:
    _validate_repository_object(record, requested_path=requested_path)
    return DatasetRepositoryObjectResponse(
        connection_id=connection_id,
        relative_path=record.relative_path,
        name=record.name,
        size_bytes=record.size_bytes,
        last_modified=record.last_modified,
        content_type=record.content_type,
        etag=record.etag,
        storage_class=record.storage_class,
        version_id=record.version_id,
        checksum_sha256=record.checksum_sha256,
    )


def repository_object_versions_response(
    connection_id: UUID,
    page: DatasetRepositoryObjectVersionsPage,
    *,
    requested_path: str,
    limit: int,
) -> DatasetRepositoryObjectVersionsPageResponse:
    _validate_repository_object_versions_page(page, requested_path=requested_path, limit=limit)
    return DatasetRepositoryObjectVersionsPageResponse(
        connection_id=connection_id,
        relative_path=page.relative_path,
        entries=[
            DatasetRepositoryObjectVersionResponse(
                version_id=entry.version_id,
                is_latest=entry.is_latest,
                is_delete_marker=entry.is_delete_marker,
                last_modified=entry.last_modified,
                size_bytes=entry.size_bytes,
                etag=entry.etag,
                storage_class=entry.storage_class,
            )
            for entry in page.entries
        ],
        truncated=page.truncated,
        next_cursor=page.next_cursor,
    )


def repository_object_registration_response(
    registration: RepositoryObjectRegistration,
) -> RepositoryObjectRegistrationResponse:
    source = registration.source
    return RepositoryObjectRegistrationResponse(
        dataset_id=registration.dataset.dataset_id,
        project_id=registration.dataset.project_id,
        name=registration.dataset.name,
        classification=registration.dataset.classification,
        format=registration.dataset.format,
        created=registration.created,
        attached=registration.attached,
        source=RepositoryObjectSourceResponse(
            dataset_id=source.dataset_id,
            connection_id=source.connection_id,
            connection_target_revision=source.connection_target_revision,
            provider=source.provider,
            bucket_name=source.bucket_name,
            region_name=source.region_name,
            object_prefix=source.object_prefix,
            relative_path=source.relative_path,
            provider_version_id=source.provider_version_id,
            size_bytes=source.size_bytes,
            last_modified=source.last_modified,
            content_type=source.content_type,
            etag=source.etag,
            storage_class=source.storage_class,
            provider_checksum_sha256=source.provider_checksum_sha256,
            created_by=source.created_by,
            created_at=source.created_at,
        ),
    )


def _validate_repository_page(
    page: DatasetRepositoryPage, *, requested_prefix: str, limit: int
) -> None:
    if page.prefix != requested_prefix or not _valid_relative_repository_prefix(page.prefix):
        raise DatasetRepositoryResponseInvalid("repository page prefix is invalid")
    expected_parent = _repository_parent_prefix(page.prefix)
    if page.parent_prefix != expected_parent or (
        page.parent_prefix is not None and not _valid_relative_repository_prefix(page.parent_prefix)
    ):
        raise DatasetRepositoryResponseInvalid("repository page parent is invalid")
    if len(page.entries) > limit:
        raise DatasetRepositoryResponseInvalid("repository page exceeds its limit")
    if page.truncated != (page.next_cursor is not None) or (
        page.next_cursor is not None
        and (
            len(page.next_cursor) > 512 or re.fullmatch(r"[A-Za-z0-9_-]+", page.next_cursor) is None
        )
    ):
        raise DatasetRepositoryResponseInvalid("repository page pagination is invalid")

    seen_paths: set[str] = set()
    for entry in page.entries:
        if (
            entry.kind not in {"prefix", "object"}
            or not isinstance(entry.relative_path, str)
            or not isinstance(entry.name, str)
            or not _valid_relative_repository_path(entry.relative_path)
            or not entry.relative_path.startswith(page.prefix)
            or entry.relative_path == page.prefix
            or entry.relative_path in seen_paths
            or not _valid_repository_entry_name(entry.name)
            or _repository_entry_name(entry.relative_path) != entry.name
            or (entry.kind == "prefix" and not entry.relative_path.endswith("/"))
            or (entry.kind == "object" and entry.relative_path.endswith("/"))
            or (
                entry.kind == "prefix"
                and any(
                    value is not None
                    for value in (
                        entry.size_bytes,
                        entry.last_modified,
                        entry.storage_class,
                        entry.version_id,
                    )
                )
            )
            or (
                entry.size_bytes is not None
                and (
                    isinstance(entry.size_bytes, bool)
                    or not isinstance(entry.size_bytes, int)
                    or entry.size_bytes < 0
                )
            )
            or (
                entry.last_modified is not None
                and (
                    not isinstance(entry.last_modified, datetime)
                    or entry.last_modified.tzinfo is None
                    or entry.last_modified.utcoffset() is None
                )
            )
            or (
                entry.storage_class is not None
                and (
                    not isinstance(entry.storage_class, str)
                    or not 0 < len(entry.storage_class) <= 64
                    or any(
                        ord(character) < 32 or ord(character) == 127
                        for character in entry.storage_class
                    )
                )
            )
            or (
                entry.version_id is not None
                and (
                    not isinstance(entry.version_id, str)
                    or not 0 < len(entry.version_id) <= 1024
                    or any(
                        ord(character) < 32 or ord(character) == 127
                        for character in entry.version_id
                    )
                )
            )
        ):
            raise DatasetRepositoryResponseInvalid("repository entry is invalid")
        seen_paths.add(entry.relative_path)


def _validate_repository_object(record: DatasetRepositoryObject, *, requested_path: str) -> None:
    if (
        record.relative_path != requested_path
        or not _valid_repository_relative_value(record.relative_path)
        or not record.relative_path
        or record.relative_path.endswith("/")
        or not _valid_repository_entry_name(record.name)
        or _repository_entry_name(record.relative_path) != record.name
        or isinstance(record.size_bytes, bool)
        or not isinstance(record.size_bytes, int)
        or not 0 <= record.size_bytes <= 5_368_709_120_000
        or not isinstance(record.last_modified, datetime)
        or record.last_modified.tzinfo is None
        or record.last_modified.utcoffset() is None
        or not _valid_repository_metadata(record.content_type, 256, optional=True)
        or not _valid_repository_metadata(record.etag, 1024, optional=False)
        or not _valid_repository_metadata(record.storage_class, 64, optional=True)
        or not _valid_repository_metadata(record.version_id, 1024, optional=True)
        or not _valid_repository_checksum(record.checksum_sha256)
    ):
        raise DatasetRepositoryResponseInvalid("repository object is invalid")


def _validate_repository_object_versions_page(
    page: DatasetRepositoryObjectVersionsPage, *, requested_path: str, limit: int
) -> None:
    if (
        page.relative_path != requested_path
        or not _valid_relative_repository_path(page.relative_path)
        or page.relative_path.endswith("/")
        or len(page.entries) > limit
        or page.truncated != (page.next_cursor is not None)
        or (
            page.next_cursor is not None
            and (
                len(page.next_cursor) > 1536
                or re.fullmatch(r"[A-Za-z0-9_-]+", page.next_cursor) is None
            )
        )
    ):
        raise DatasetRepositoryResponseInvalid("repository object versions page is invalid")
    seen: set[str] = set()
    latest_count = 0
    for entry in page.entries:
        if (
            not isinstance(entry, DatasetRepositoryObjectVersion)
            or not _valid_repository_metadata(entry.version_id, 1024, optional=False)
            or len(entry.version_id.encode()) > 1024
            or entry.version_id in seen
            or not isinstance(entry.is_latest, bool)
            or not isinstance(entry.is_delete_marker, bool)
            or not isinstance(entry.last_modified, datetime)
            or entry.last_modified.tzinfo is None
            or entry.last_modified.utcoffset() is None
            or (
                entry.size_bytes is not None
                and (
                    isinstance(entry.size_bytes, bool)
                    or not isinstance(entry.size_bytes, int)
                    or not 0 <= entry.size_bytes <= 5_368_709_120_000
                )
            )
            or not _valid_repository_metadata(entry.etag, 1024, optional=True)
            or not _valid_repository_metadata(entry.storage_class, 64, optional=True)
            or (
                entry.is_delete_marker
                and any(
                    value is not None
                    for value in (entry.size_bytes, entry.etag, entry.storage_class)
                )
            )
            or (not entry.is_delete_marker and (entry.size_bytes is None or entry.etag is None))
        ):
            raise DatasetRepositoryResponseInvalid("repository object version is invalid")
        seen.add(entry.version_id)
        latest_count += int(entry.is_latest)
    if latest_count > 1:
        raise DatasetRepositoryResponseInvalid(
            "repository object versions latest marker is invalid"
        )


def _valid_repository_metadata(value: str | None, maximum: int, *, optional: bool) -> bool:
    if value is None:
        return optional
    return 0 < len(value) <= maximum and not any(
        ord(character) < 32 or ord(character) == 127 for character in value
    )


def _valid_repository_checksum(value: str | None) -> bool:
    if value is None:
        return True
    try:
        return len(base64.b64decode(value, validate=True)) == 32
    except (binascii.Error, ValueError):
        return False


def _repository_parent_prefix(prefix: str) -> str | None:
    if not prefix:
        return None
    parent_end = prefix[:-1].rfind("/")
    return "" if parent_end < 0 else prefix[: parent_end + 1]


def _repository_entry_name(relative_path: str) -> str:
    normalized = relative_path[:-1] if relative_path.endswith("/") else relative_path
    return normalized.rsplit("/", maxsplit=1)[-1]


def _valid_repository_entry_name(value: str) -> bool:
    return (
        0 < len(value) <= 1024
        and "/" not in value
        and "\\" not in value
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _valid_relative_repository_path(value: str) -> bool:
    return bool(value) and _valid_repository_relative_value(value)


def binding_response(
    record: ProjectDatasetConnectionBinding,
) -> ProjectDatasetConnectionBindingResponse:
    return ProjectDatasetConnectionBindingResponse(
        binding_id=record.binding_id,
        project_id=record.project_id,
        display_name=record.display_name,
        created_by=record.created_by,
        created_at=record.created_at,
        connection=connection_response(record.connection),
    )


def verification_response(
    record: UserDatasetConnectionVerification,
) -> UserDatasetConnectionVerificationResponse:
    return UserDatasetConnectionVerificationResponse(
        verification_id=record.verification_id,
        connection_id=record.connection_id,
        target_revision=record.target_revision,
        credential_revision=record.credential_revision,
        state=record.state,
        attempt_count=record.attempt_count,
        bucket_access_confirmed=record.bucket_access_confirmed,
        object_access_confirmed=record.object_access_confirmed,
        deny_canaries_confirmed=record.deny_canaries_confirmed,
        objects_observed=record.objects_observed,
        sanitized_error_code=record.sanitized_error_code,
        duration_ms=record.duration_ms,
        requested_by=record.requested_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
    )


def project_reference_response(
    record: UserDatasetConnectionProjectReference,
) -> UserDatasetConnectionProjectReferenceResponse:
    return UserDatasetConnectionProjectReferenceResponse(
        binding_id=record.binding_id,
        project_id=record.project_id,
        project_name=record.project_name,
        project_status=record.project_status,
        display_name=record.display_name,
        created_at=record.created_at,
    )


def connection_overview_response(
    record: UserDatasetConnectionOverview,
) -> UserDatasetConnectionOverviewResponse:
    return UserDatasetConnectionOverviewResponse(
        connection_id=record.connection_id,
        target_revision=record.target_revision,
        credential_revision=record.credential_revision,
        health=record.health,
        latest_verification=(
            verification_response(record.latest_verification)
            if record.latest_verification is not None
            else None
        ),
        project_references=[
            project_reference_response(reference) for reference in record.project_references
        ],
    )


@router.get("/me/dataset-connections", response_model=list[UserDatasetConnectionResponse])
async def list_my_dataset_connections(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
) -> list[UserDatasetConnectionResponse]:
    records = await execute_user_connection(repository.list_my_connections(tenant_context(session)))
    return [
        connection_response(
            record,
            verification_available=dispatcher.available,
            repository_browse_available=browser.available,
        )
        for record in records
    ]


@router.post(
    "/me/dataset-connections",
    response_model=UserDatasetConnectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_my_dataset_connection(
    payload: CreateUserDatasetConnectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
) -> UserDatasetConnectionResponse:
    record = await execute_user_connection(
        repository.create_connection(
            tenant_context(session),
            UserDatasetConnectionDraft(
                provider=payload.provider,
                display_name=payload.display_name,
                bucket_name=payload.bucket_name,
                region_name=payload.region_name,
                object_prefix=payload.object_prefix,
                credential_mode=payload.credential_mode,
                role_arn=payload.role_arn,
            ),
            get_request_id(),
        )
    )
    return connection_response(
        record,
        verification_available=dispatcher.available,
        repository_browse_available=browser.available,
    )


@router.get("/me/dataset-connections/{connection_id}", response_model=UserDatasetConnectionResponse)
async def get_my_dataset_connection(
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
) -> UserDatasetConnectionResponse:
    record = await execute_user_connection(
        repository.get_my_connection(tenant_context(session), connection_id)
    )
    return connection_response(
        record,
        verification_available=dispatcher.available,
        repository_browse_available=browser.available,
    )


@router.get(
    "/me/dataset-connections/{connection_id}/overview",
    response_model=UserDatasetConnectionOverviewResponse,
)
async def get_my_dataset_connection_overview(
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
) -> UserDatasetConnectionOverviewResponse:
    record = await execute_user_connection(
        repository.get_my_connection_overview(tenant_context(session), connection_id)
    )
    return connection_overview_response(record)


@router.patch(
    "/me/dataset-connections/{connection_id}", response_model=UserDatasetConnectionResponse
)
async def update_my_dataset_connection(
    connection_id: UUID,
    payload: UpdateUserDatasetConnectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
) -> UserDatasetConnectionResponse:
    changes: dict[str, Any] = {field: getattr(payload, field) for field in payload.model_fields_set}
    record = await execute_user_connection(
        repository.update_connection(
            tenant_context(session), connection_id, changes, get_request_id()
        )
    )
    return connection_response(
        record,
        verification_available=dispatcher.available,
        repository_browse_available=browser.available,
    )


@router.put(
    "/me/dataset-connections/{connection_id}/credentials",
    response_model=UserDatasetConnectionResponse,
)
async def replace_my_dataset_connection_credentials(
    connection_id: UUID,
    payload: ReplaceUserDatasetCredentialsRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
) -> UserDatasetConnectionResponse:
    record = await execute_user_connection(
        repository.rotate_credentials(
            tenant_context(session),
            connection_id,
            payload.expected_credential_revision,
            UserDatasetCredentials(payload.secret_values()),
            get_request_id(),
        )
    )
    return connection_response(
        record,
        verification_available=dispatcher.available,
        repository_browse_available=browser.available,
    )


@router.get(
    "/me/dataset-connections/{connection_id}/repository",
    response_model=DatasetRepositoryPageResponse,
)
async def browse_my_dataset_connection_repository(
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
    prefix: str = "",
    cursor: str | None = None,
    limit: int = 100,
) -> DatasetRepositoryPageResponse:
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="repository_limit_invalid")
    if not _valid_relative_repository_prefix(prefix):
        raise HTTPException(status_code=422, detail="repository_prefix_invalid")
    if cursor is not None and (
        len(cursor) > 512 or re.fullmatch(r"[A-Za-z0-9_-]+", cursor) is None
    ):
        raise HTTPException(status_code=422, detail="repository_cursor_invalid")
    context = tenant_context(session)
    connection = await execute_user_connection(repository.get_my_connection(context, connection_id))
    if not browser.available:
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable")
    if connection.status != "verified":
        raise HTTPException(status_code=409, detail={"code": "connection_not_verified"})
    try:
        page = await browser.browse(context, connection, prefix, cursor, limit)
        response = repository_page_response(
            connection_id,
            page,
            requested_prefix=prefix,
            limit=limit,
        )
    except DatasetRepositoryAccessDenied as error:
        raise HTTPException(status_code=403, detail="dataset_repository_access_denied") from error
    except DatasetRepositoryResponseInvalid as error:
        logger.error("dataset_repository.response_invalid")
        raise HTTPException(
            status_code=502, detail="dataset_repository_response_invalid"
        ) from error
    except DatasetRepositoryUnavailable as error:
        logger.error("dataset_repository.unavailable")
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable") from error
    return response


@router.get(
    "/me/dataset-connections/{connection_id}/repository/object/versions",
    response_model=DatasetRepositoryObjectVersionsPageResponse,
)
async def list_my_dataset_connection_repository_object_versions(
    connection_id: UUID,
    path: str,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
    cursor: str | None = None,
    limit: int = 50,
) -> DatasetRepositoryObjectVersionsPageResponse:
    if not path or path.endswith("/") or not _valid_repository_relative_value(path):
        raise HTTPException(status_code=422, detail="repository_object_path_invalid")
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="repository_limit_invalid")
    if cursor is not None and (
        len(cursor) > 1536 or re.fullmatch(r"[A-Za-z0-9_-]+", cursor) is None
    ):
        raise HTTPException(status_code=422, detail="repository_cursor_invalid")
    context = tenant_context(session)
    connection = await execute_user_connection(repository.get_my_connection(context, connection_id))
    if not browser.available:
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable")
    if connection.status != "verified":
        raise HTTPException(status_code=409, detail={"code": "connection_not_verified"})
    try:
        page = await browser.versions(context, connection, path, cursor, limit)
        return repository_object_versions_response(
            connection_id, page, requested_path=path, limit=limit
        )
    except DatasetRepositoryAccessDenied as error:
        raise HTTPException(status_code=403, detail="dataset_repository_access_denied") from error
    except DatasetRepositoryResponseInvalid as error:
        logger.error("dataset_repository.versions_response_invalid")
        raise HTTPException(
            status_code=502, detail="dataset_repository_response_invalid"
        ) from error
    except DatasetRepositoryUnavailable as error:
        logger.error("dataset_repository.versions_unavailable")
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable") from error


@router.get(
    "/me/dataset-connections/{connection_id}/repository/object",
    response_model=DatasetRepositoryObjectResponse,
)
async def inspect_my_dataset_connection_repository_object(
    connection_id: UUID,
    path: str,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
    version_id: str | None = None,
) -> DatasetRepositoryObjectResponse:
    if not path or path.endswith("/") or not _valid_repository_relative_value(path):
        raise HTTPException(status_code=422, detail="repository_object_path_invalid")
    if version_id is not None and (
        not 1 <= len(version_id) <= 1024
        or len(version_id.encode()) > 1024
        or any(ord(character) < 32 or ord(character) == 127 for character in version_id)
    ):
        raise HTTPException(status_code=422, detail="repository_object_version_invalid")
    context = tenant_context(session)
    connection = await execute_user_connection(repository.get_my_connection(context, connection_id))
    if not browser.available:
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable")
    if connection.status != "verified":
        raise HTTPException(status_code=409, detail={"code": "connection_not_verified"})
    try:
        record = await browser.inspect(context, connection, path, version_id)
        if version_id is not None and record.version_id != version_id:
            raise DatasetRepositoryResponseInvalid("repository object version changed")
        return repository_object_response(connection_id, record, requested_path=path)
    except DatasetRepositoryAccessDenied as error:
        raise HTTPException(status_code=403, detail="dataset_repository_access_denied") from error
    except DatasetRepositoryObjectNotFound as error:
        raise HTTPException(
            status_code=404, detail="dataset_repository_object_not_found"
        ) from error
    except DatasetRepositoryResponseInvalid as error:
        logger.error("dataset_repository.object_response_invalid")
        raise HTTPException(
            status_code=502, detail="dataset_repository_response_invalid"
        ) from error
    except DatasetRepositoryUnavailable as error:
        logger.error("dataset_repository.object_unavailable")
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable") from error


@router.post(
    "/me/dataset-connections/{connection_id}/repository/object/registrations",
    response_model=RepositoryObjectRegistrationResponse,
)
async def register_my_dataset_connection_repository_object(
    connection_id: UUID,
    payload: RegisterRepositoryObjectRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    connection_repository: Annotated[
        UserDatasetConnectionRepository, Depends(repository_from_request)
    ],
    browser: Annotated[UserDatasetRepositoryBrowser, Depends(repository_browser_from_request)],
    ingestion_repository: Annotated[
        IngestionRepository, Depends(ingestion_repository_from_request)
    ],
) -> RepositoryObjectRegistrationResponse:
    context = tenant_context(session)
    connection = await execute_user_connection(
        connection_repository.get_my_connection(context, connection_id)
    )
    if not browser.available:
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable")
    if connection.status != "verified":
        raise HTTPException(status_code=409, detail={"code": "connection_not_verified"})
    try:
        record = await browser.inspect(
            context,
            connection,
            payload.relative_path,
            payload.version_id,
        )
        _validate_repository_object(record, requested_path=payload.relative_path)
        if record.version_id != payload.version_id:
            raise DatasetRepositoryResponseInvalid("repository object version changed")
    except DatasetRepositoryAccessDenied as error:
        raise HTTPException(status_code=403, detail="dataset_repository_access_denied") from error
    except DatasetRepositoryObjectNotFound as error:
        raise HTTPException(
            status_code=404, detail="dataset_repository_object_not_found"
        ) from error
    except DatasetRepositoryResponseInvalid as error:
        logger.error("dataset_repository.registration_response_invalid")
        raise HTTPException(
            status_code=502, detail="dataset_repository_response_invalid"
        ) from error
    except DatasetRepositoryUnavailable as error:
        logger.error("dataset_repository.registration_unavailable")
        raise HTTPException(status_code=503, detail="dataset_repository_unavailable") from error
    if record.size_bytes < 1:
        raise HTTPException(status_code=422, detail="repository_object_empty")

    registration = await execute_repository_registration(
        ingestion_repository.register_repository_object(
            context,
            payload.project_id,
            RepositoryObjectDraft(
                connection_id=connection_id,
                expected_target_revision=connection.target_revision,
                relative_path=record.relative_path,
                provider_version_id=payload.version_id,
                name=payload.name,
                description=payload.description,
                classification=payload.classification,
                format=payload.format,
                size_bytes=record.size_bytes,
                last_modified=record.last_modified,
                content_type=record.content_type,
                etag=record.etag,
                storage_class=record.storage_class,
                provider_checksum_sha256=record.checksum_sha256,
                tags=tuple(payload.tags),
            ),
            get_request_id(),
        )
    )
    return repository_object_registration_response(registration)


def _valid_relative_repository_prefix(value: str) -> bool:
    return _valid_repository_relative_value(value) and (not value or value.endswith("/"))


def _valid_repository_relative_value(value: str) -> bool:
    if len(value) > 1024 or value.startswith(("/", "\\")) or "\\" in value:
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    return all(segment not in {".", ".."} for segment in value.split("/"))


@router.post(
    "/me/dataset-connections/{connection_id}/verifications",
    response_model=UserDatasetConnectionVerificationSubmissionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_my_dataset_connection_verification(
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        UserDatasetVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
) -> UserDatasetConnectionVerificationSubmissionResponse:
    if not dispatcher.available:
        raise HTTPException(status_code=503, detail="dataset_verification_unavailable")
    submission = await execute_user_connection(
        repository.request_verification(tenant_context(session), connection_id, get_request_id())
    )
    try:
        await dispatcher.dispatch_user_dataset_verification(submission.verification.verification_id)
    except ProcessingDispatchUnavailable as error:
        logger.error("user_dataset_connection.verification_dispatch_unavailable")
        raise HTTPException(
            status_code=503,
            detail="dataset_verification_dispatch_unavailable",
        ) from error
    return UserDatasetConnectionVerificationSubmissionResponse(
        verification=verification_response(submission.verification),
        created=submission.created,
    )


@router.get(
    "/me/dataset-connections/{connection_id}/verifications",
    response_model=list[UserDatasetConnectionVerificationResponse],
)
async def list_my_dataset_connection_verifications(
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
) -> list[UserDatasetConnectionVerificationResponse]:
    records = await execute_user_connection(
        repository.list_verifications(tenant_context(session), connection_id)
    )
    return [verification_response(record) for record in records]


@router.get(
    "/projects/{project_id}/dataset-connection-bindings",
    response_model=list[ProjectDatasetConnectionBindingResponse],
)
async def list_project_dataset_connection_bindings(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
) -> list[ProjectDatasetConnectionBindingResponse]:
    records = await execute_user_connection(
        repository.list_project_bindings(tenant_context(session), project_id)
    )
    return [binding_response(record) for record in records]


@router.post(
    "/projects/{project_id}/dataset-connection-bindings",
    response_model=ProjectDatasetConnectionBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_dataset_connection_binding(
    project_id: UUID,
    payload: CreateProjectDatasetConnectionBindingRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
) -> ProjectDatasetConnectionBindingResponse:
    record = await execute_user_connection(
        repository.create_project_binding(
            tenant_context(session),
            project_id,
            payload.connection_id,
            payload.display_name,
            get_request_id(),
        )
    )
    return binding_response(record)


@router.delete(
    "/projects/{project_id}/dataset-connection-bindings/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_project_dataset_connection_binding(
    project_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserDatasetConnectionRepository, Depends(repository_from_request)],
) -> Response:
    await execute_user_connection(
        repository.remove_project_binding(
            tenant_context(session), project_id, binding_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
