from datetime import datetime
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
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
from opengeo_api.auth_routes import current_session
from opengeo_api.logging import get_request_id
from opengeo_api.user_basemap_connections import (
    BasemapFlavor,
    ProjectBasemapConnectionBinding,
    ResolvedBasemapStyle,
    UserBasemapConnection,
    UserBasemapConnectionDraft,
    UserBasemapConnectionRepository,
)
from opengeo_api.user_connection_routes import execute_user_connection, tenant_context

router = APIRouter(tags=["user basemap connections"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def normalize_origin(value: str) -> str:
    raw = value.strip()
    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or any(ord(character) < 32 or ord(character) == 127 for character in raw)
    ):
        raise ValueError("allowed origin must contain only scheme, host, and optional port")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("allowed origin contains an invalid port") from error
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("allowed origin contains an invalid port")
    host = parsed.hostname.lower()
    if ":" in host:
        raise ValueError("IPv6 origins are not supported by this connection contract")
    authority = host if port is None else f"{host}:{port}"
    return f"{parsed.scheme}://{authority}"


def normalize_origins(values: list[str]) -> list[str]:
    normalized = [normalize_origin(value) for value in values]
    if len(set(normalized)) != len(normalized):
        raise ValueError("allowed origins must be unique")
    return normalized


class CreateUserBasemapConnectionRequest(RequestModel):
    provider: Literal["protomaps", "carto"] = "protomaps"
    display_name: Name
    allowed_origins: list[str] = Field(min_length=1, max_length=16)

    @field_validator("allowed_origins", mode="after")
    @classmethod
    def valid_origins(cls, value: list[str]) -> list[str]:
        return normalize_origins(value)


class UpdateUserBasemapConnectionRequest(RequestModel):
    display_name: Name | None = None
    allowed_origins: list[str] | None = Field(default=None, min_length=1, max_length=16)
    enabled: bool | None = None

    @field_validator("allowed_origins", mode="after")
    @classmethod
    def valid_origins(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else normalize_origins(value)

    @model_validator(mode="after")
    def validate_changes(self) -> "UpdateUserBasemapConnectionRequest":
        if not self.model_fields_set:
            raise ValueError("at least one connection field is required")
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("connection update fields cannot be null")
        return self


class ReplaceUserBasemapApiKeyRequest(RequestModel):
    expected_credential_revision: int = Field(ge=0)
    api_key: SecretStr = Field(min_length=8, max_length=512)

    @field_validator("api_key")
    @classmethod
    def valid_api_key(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        if raw != raw.strip() or any(
            character.isspace() or ord(character) < 32 or ord(character) == 127 for character in raw
        ):
            raise ValueError("API key contains unsupported whitespace or control characters")
        return value


class CreateProjectBasemapConnectionBindingRequest(RequestModel):
    connection_id: UUID
    display_name: Name


class UserBasemapConnectionResponse(BaseModel):
    connection_id: UUID
    owner_user_id: UUID
    provider: Literal["protomaps", "carto"]
    display_name: str
    allowed_origins: list[str]
    configured_secret_fields: list[Literal["api_key"]]
    credential_revision: int
    credential_ready: bool
    status: Literal["draft", "configured", "disabled"]
    browser_key_exposure: Literal["client_visible"] = "client_visible"
    created_at: datetime
    updated_at: datetime
    owned_by_caller: bool


class ProjectBasemapConnectionBindingResponse(BaseModel):
    binding_id: UUID
    project_id: UUID
    display_name: str
    created_by: UUID
    created_at: datetime
    connection: UserBasemapConnectionResponse


class ResolvedBasemapStyleResponse(BaseModel):
    binding_id: UUID
    connection_id: UUID
    provider: Literal["protomaps", "carto"]
    connection_name: str
    flavor: Literal[
        "light",
        "dark",
        "white",
        "grayscale",
        "black",
        "voyager",
        "positron",
        "dark-matter",
    ]
    resource_kind: Literal["maplibre-style", "raster"]
    resource_url: str
    attribution: str
    credential_revision: int
    browser_key_exposure: Literal["client_visible"] = "client_visible"


def repository_from_request(request: Request) -> UserBasemapConnectionRepository:
    return cast(
        UserBasemapConnectionRepository,
        request.app.state.user_basemap_connection_repository,
    )


def connection_response(record: UserBasemapConnection) -> UserBasemapConnectionResponse:
    return UserBasemapConnectionResponse(
        connection_id=record.connection_id,
        owner_user_id=record.owner_user_id,
        provider=record.provider,
        display_name=record.display_name,
        allowed_origins=list(record.allowed_origins),
        configured_secret_fields=cast(
            list[Literal["api_key"]], list(record.configured_secret_fields)
        ),
        credential_revision=record.credential_revision,
        credential_ready=record.credential_revision > 0,
        status=record.status,
        created_at=record.created_at,
        updated_at=record.updated_at,
        owned_by_caller=record.owned_by_caller,
    )


def binding_response(
    record: ProjectBasemapConnectionBinding,
) -> ProjectBasemapConnectionBindingResponse:
    return ProjectBasemapConnectionBindingResponse(
        binding_id=record.binding_id,
        project_id=record.project_id,
        display_name=record.display_name,
        created_by=record.created_by,
        created_at=record.created_at,
        connection=connection_response(record.connection),
    )


def style_response(record: ResolvedBasemapStyle) -> ResolvedBasemapStyleResponse:
    return ResolvedBasemapStyleResponse(
        binding_id=record.binding_id,
        connection_id=record.connection_id,
        provider=record.provider,
        connection_name=record.connection_name,
        flavor=record.flavor,
        resource_kind=record.resource_kind,
        resource_url=record.resource_url,
        attribution=record.attribution,
        credential_revision=record.credential_revision,
    )


@router.get("/me/basemap-connections", response_model=list[UserBasemapConnectionResponse])
async def list_my_basemap_connections(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> list[UserBasemapConnectionResponse]:
    records = await execute_user_connection(repository.list_my_connections(tenant_context(session)))
    return [connection_response(record) for record in records]


@router.post(
    "/me/basemap-connections",
    response_model=UserBasemapConnectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_my_basemap_connection(
    payload: CreateUserBasemapConnectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> UserBasemapConnectionResponse:
    record = await execute_user_connection(
        repository.create_connection(
            tenant_context(session),
            UserBasemapConnectionDraft(
                provider=payload.provider,
                display_name=payload.display_name,
                allowed_origins=tuple(payload.allowed_origins),
            ),
            get_request_id(),
        )
    )
    return connection_response(record)


@router.patch(
    "/me/basemap-connections/{connection_id}",
    response_model=UserBasemapConnectionResponse,
)
async def update_my_basemap_connection(
    connection_id: UUID,
    payload: UpdateUserBasemapConnectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> UserBasemapConnectionResponse:
    changes: dict[str, Any] = {
        field: tuple(value) if field == "allowed_origins" else value
        for field in payload.model_fields_set
        if (value := getattr(payload, field)) is not None
    }
    record = await execute_user_connection(
        repository.update_connection(
            tenant_context(session), connection_id, changes, get_request_id()
        )
    )
    return connection_response(record)


@router.put(
    "/me/basemap-connections/{connection_id}/browser-key",
    response_model=UserBasemapConnectionResponse,
)
async def replace_my_basemap_connection_browser_key(
    connection_id: UUID,
    payload: ReplaceUserBasemapApiKeyRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> UserBasemapConnectionResponse:
    record = await execute_user_connection(
        repository.rotate_api_key(
            tenant_context(session),
            connection_id,
            payload.expected_credential_revision,
            payload.api_key.get_secret_value(),
            get_request_id(),
        )
    )
    return connection_response(record)


@router.get(
    "/projects/{project_id}/basemap-connection-bindings",
    response_model=list[ProjectBasemapConnectionBindingResponse],
)
async def list_project_basemap_connection_bindings(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> list[ProjectBasemapConnectionBindingResponse]:
    records = await execute_user_connection(
        repository.list_project_bindings(tenant_context(session), project_id)
    )
    return [binding_response(record) for record in records]


@router.post(
    "/projects/{project_id}/basemap-connection-bindings",
    response_model=ProjectBasemapConnectionBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_basemap_connection_binding(
    project_id: UUID,
    payload: CreateProjectBasemapConnectionBindingRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> ProjectBasemapConnectionBindingResponse:
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
    "/projects/{project_id}/basemap-connection-bindings/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_project_basemap_connection_binding(
    project_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> Response:
    await execute_user_connection(
        repository.remove_project_binding(
            tenant_context(session), project_id, binding_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/projects/{project_id}/basemap-connection-bindings/{binding_id}/styles/{flavor}",
    response_model=ResolvedBasemapStyleResponse,
)
async def resolve_project_basemap_style(
    project_id: UUID,
    binding_id: UUID,
    flavor: BasemapFlavor,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[UserBasemapConnectionRepository, Depends(repository_from_request)],
) -> ResolvedBasemapStyleResponse:
    record = await execute_user_connection(
        repository.resolve_style(
            tenant_context(session), project_id, binding_id, flavor, get_request_id()
        )
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return style_response(record)
