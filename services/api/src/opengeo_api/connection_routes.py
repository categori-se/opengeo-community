import ipaddress
import logging
import re
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.connections import (
    ConnectionAccessDenied,
    ConnectionConflict,
    ConnectionNotFound,
    ConnectionStoreUnavailable,
    ExternalConnection,
    ExternalConnectionDraft,
    ExternalConnectionRepository,
    ExternalConnectionRevision,
    ExternalConnectionVerification,
    PostgresExternalConnectionRepository,
)
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import (
    ConnectionVerificationDispatcher,
    ProcessingDispatchUnavailable,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["external database connections"])

DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
DatabaseIdentifier = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=63,
        pattern=r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$",
    ),
]

_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_BLOCKED_HOSTS = frozenset({"localhost", "localhost.localdomain"})
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PostgreSqlCredentials(RequestModel):
    username: SecretStr = Field(min_length=1, max_length=128)
    password: SecretStr = Field(min_length=1, max_length=1024)

    @field_validator("username", "password", mode="after")
    @classmethod
    def reject_control_characters(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        has_control = any(ord(character) < 32 or ord(character) == 127 for character in raw)
        if raw != raw.strip() or has_control:
            raise ValueError("credential contains unsupported whitespace or control characters")
        return value


class CreateExternalConnectionRequest(RequestModel):
    provider: Literal["postgresql"]
    display_name: DisplayName
    endpoint_host: Annotated[
        str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=4, max_length=253)
    ]
    endpoint_port: int = Field(default=5432, ge=1, le=65535)
    database_name: DatabaseIdentifier
    allowed_schemas: list[DatabaseIdentifier] = Field(min_length=1, max_length=16)
    read_only: Literal[True] = True
    tls_mode: Literal["verify_full"] = "verify_full"
    network_mode: Literal["public_internet"] = "public_internet"
    credentials: PostgreSqlCredentials

    @field_validator("endpoint_host", mode="after")
    @classmethod
    def validate_public_dns_shape(cls, value: str) -> str:
        host = value.rstrip(".")
        if host in _BLOCKED_HOSTS or host.endswith(_BLOCKED_SUFFIXES):
            raise ValueError("connection endpoint must be a public DNS host")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            labels = host.split(".")
            if len(labels) < 2 or any(_HOST_LABEL.fullmatch(label) is None for label in labels):
                raise ValueError("connection endpoint host is invalid") from None
        else:
            raise ValueError("connection endpoint must use a DNS host name")
        return host

    @field_validator("allowed_schemas", mode="after")
    @classmethod
    def unique_schemas(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("allowed_schemas must be unique")
        return values


class ConnectionCapabilitiesResponse(BaseModel):
    read: bool
    manage: bool


class ExternalConnectionResponse(BaseModel):
    connection_id: UUID
    project_id: UUID
    provider: str
    display_name: str
    endpoint_host: str
    endpoint_port: int
    database_name: str
    allowed_schemas: list[str]
    read_only: bool
    tls_mode: str
    network_mode: str
    configured_secret_fields: list[str]
    status: str
    current_revision_number: int
    last_verified_at: datetime | None
    schema_fingerprint_sha256: str | None
    sanitized_error_code: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    capabilities: ConnectionCapabilitiesResponse
    verification_available: bool
    discovery_available: Literal[False] = False
    preview_available: Literal[False] = False
    snapshot_available: Literal[False] = False


class ExternalConnectionRevisionResponse(BaseModel):
    revision_id: UUID
    connection_id: UUID
    revision_number: int
    configuration: dict[str, Any]
    change_summary: str
    created_by: UUID
    created_at: datetime


class ExternalConnectionVerificationResponse(BaseModel):
    verification_id: UUID
    connection_id: UUID
    connection_revision_number: int
    state: str
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


class ExternalConnectionVerificationSubmissionResponse(BaseModel):
    verification: ExternalConnectionVerificationResponse
    created: bool


def repository_from_request(request: Request) -> ExternalConnectionRepository:
    repository = request.app.state.connection_repository
    if not isinstance(repository, PostgresExternalConnectionRepository):
        return cast(ExternalConnectionRepository, repository)
    return repository


def verification_dispatcher_from_request(request: Request) -> ConnectionVerificationDispatcher:
    return cast(
        ConnectionVerificationDispatcher,
        request.app.state.connection_verification_dispatcher,
    )


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_connection[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except ConnectionAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except ConnectionNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except ConnectionConflict as error:
        raise HTTPException(status_code=409, detail="external_connection_conflict") from error
    except ConnectionStoreUnavailable as error:
        logger.error("connection.store_unavailable")
        raise HTTPException(
            status_code=503, detail="external_connection_store_unavailable"
        ) from error


def connection_response(
    record: ExternalConnection, *, verification_available: bool
) -> ExternalConnectionResponse:
    return ExternalConnectionResponse(
        connection_id=record.connection_id,
        project_id=record.project_id,
        provider=record.provider,
        display_name=record.display_name,
        endpoint_host=record.endpoint_host,
        endpoint_port=record.endpoint_port,
        database_name=record.database_name,
        allowed_schemas=list(record.allowed_schemas),
        read_only=record.read_only,
        tls_mode=record.tls_mode,
        network_mode=record.network_mode,
        configured_secret_fields=list(record.configured_secret_fields),
        status=record.status,
        current_revision_number=record.current_revision_number,
        last_verified_at=record.last_verified_at,
        schema_fingerprint_sha256=record.schema_fingerprint_sha256,
        sanitized_error_code=record.sanitized_error_code,
        created_by=record.created_by,
        created_at=record.created_at,
        updated_by=record.updated_by,
        updated_at=record.updated_at,
        capabilities=ConnectionCapabilitiesResponse(
            read=record.capabilities.read,
            manage=record.capabilities.manage,
        ),
        verification_available=verification_available,
    )


def revision_response(
    record: ExternalConnectionRevision,
) -> ExternalConnectionRevisionResponse:
    return ExternalConnectionRevisionResponse(
        revision_id=record.revision_id,
        connection_id=record.connection_id,
        revision_number=record.revision_number,
        configuration=record.configuration,
        change_summary=record.change_summary,
        created_by=record.created_by,
        created_at=record.created_at,
    )


def verification_response(
    record: ExternalConnectionVerification,
) -> ExternalConnectionVerificationResponse:
    return ExternalConnectionVerificationResponse(
        verification_id=record.verification_id,
        connection_id=record.connection_id,
        connection_revision_number=record.connection_revision_number,
        state=record.state,
        attempt_count=record.attempt_count,
        network_reachable=record.network_reachable,
        tls_verified=record.tls_verified,
        credentials_verified=record.credentials_verified,
        postgis_verified=record.postgis_verified,
        sanitized_error_code=record.sanitized_error_code,
        duration_ms=record.duration_ms,
        requested_by=record.requested_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
    )


@router.get(
    "/projects/{project_id}/connections",
    response_model=list[ExternalConnectionResponse],
)
async def list_connections(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        ConnectionVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
) -> list[ExternalConnectionResponse]:
    records = await execute_connection(
        repository.list_connections(tenant_context(session), project_id)
    )
    return [
        connection_response(record, verification_available=dispatcher.available)
        for record in records
    ]


@router.post(
    "/projects/{project_id}/connections",
    response_model=ExternalConnectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_connection(
    project_id: UUID,
    payload: CreateExternalConnectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        ConnectionVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
) -> ExternalConnectionResponse:
    record = await execute_connection(
        repository.create_connection(
            tenant_context(session),
            project_id,
            ExternalConnectionDraft(
                provider=payload.provider,
                display_name=payload.display_name,
                endpoint_host=payload.endpoint_host,
                endpoint_port=payload.endpoint_port,
                database_name=payload.database_name,
                allowed_schemas=tuple(payload.allowed_schemas),
                read_only=payload.read_only,
                tls_mode=payload.tls_mode,
                network_mode=payload.network_mode,
                username=payload.credentials.username.get_secret_value(),
                password=payload.credentials.password.get_secret_value(),
            ),
            get_request_id(),
        )
    )
    return connection_response(record, verification_available=dispatcher.available)


@router.get(
    "/projects/{project_id}/connections/{connection_id}",
    response_model=ExternalConnectionResponse,
)
async def get_connection(
    project_id: UUID,
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        ConnectionVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
) -> ExternalConnectionResponse:
    record = await execute_connection(
        repository.get_connection(tenant_context(session), project_id, connection_id)
    )
    return connection_response(record, verification_available=dispatcher.available)


@router.get(
    "/projects/{project_id}/connections/{connection_id}/revisions",
    response_model=list[ExternalConnectionRevisionResponse],
)
async def list_connection_revisions(
    project_id: UUID,
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
) -> list[ExternalConnectionRevisionResponse]:
    records = await execute_connection(
        repository.list_revisions(tenant_context(session), project_id, connection_id)
    )
    return [revision_response(record) for record in records]


@router.post(
    "/projects/{project_id}/connections/{connection_id}/verifications",
    response_model=ExternalConnectionVerificationSubmissionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_connection_verification(
    project_id: UUID,
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        ConnectionVerificationDispatcher, Depends(verification_dispatcher_from_request)
    ],
) -> ExternalConnectionVerificationSubmissionResponse:
    if not dispatcher.available:
        raise HTTPException(status_code=503, detail="connection_verification_unavailable")
    submission = await execute_connection(
        repository.request_verification(
            tenant_context(session), project_id, connection_id, get_request_id()
        )
    )
    try:
        await dispatcher.dispatch_connection_verification(submission.verification.verification_id)
    except ProcessingDispatchUnavailable as error:
        logger.error("connection.verification_dispatch_unavailable")
        raise HTTPException(
            status_code=503, detail="connection_verification_dispatch_unavailable"
        ) from error
    return ExternalConnectionVerificationSubmissionResponse(
        verification=verification_response(submission.verification),
        created=submission.created,
    )


@router.get(
    "/projects/{project_id}/connections/{connection_id}/verifications",
    response_model=list[ExternalConnectionVerificationResponse],
)
async def list_connection_verifications(
    project_id: UUID,
    connection_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
) -> list[ExternalConnectionVerificationResponse]:
    records = await execute_connection(
        repository.list_verifications(tenant_context(session), project_id, connection_id)
    )
    return [verification_response(record) for record in records]


@router.delete(
    "/projects/{project_id}/connections/{connection_id}/verifications/{verification_id}",
    response_model=ExternalConnectionVerificationResponse,
)
async def cancel_connection_verification(
    project_id: UUID,
    connection_id: UUID,
    verification_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalConnectionRepository, Depends(repository_from_request)],
) -> ExternalConnectionVerificationResponse:
    record = await execute_connection(
        repository.cancel_verification(
            tenant_context(session),
            project_id,
            connection_id,
            verification_id,
            get_request_id(),
        )
    )
    return verification_response(record)
