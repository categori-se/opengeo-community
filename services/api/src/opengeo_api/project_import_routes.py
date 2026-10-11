import json
import logging
from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.external_source_routes import SourceDefinition
from opengeo_api.logging import get_request_id
from opengeo_api.map_definitions import validate_map_definition
from opengeo_api.project_imports import (
    EmbeddedImportCandidate,
    ExternalImportCandidate,
    PostgresProjectImportRepository,
    ProjectImport,
    ProjectImportAccessDenied,
    ProjectImportConflict,
    ProjectImportDraft,
    ProjectImportNotFound,
    ProjectImportRepository,
    ProjectImportStoreUnavailable,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["recoverable project imports"])

ImportRef = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=10,
        max_length=210,
        pattern=r"^geolibre:[A-Za-z0-9._:-]{1,200}$",
    ),
]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)
]
Checksum = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9A-Fa-f]{64}$",
    ),
]
Tag = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=64),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExternalImportCandidateRequest(RequestModel):
    import_ref: ImportRef
    name: Name
    description: Description | None = None
    classification: Literal["public", "internal", "confidential", "restricted"] = "internal"
    tags: list[Tag] = Field(default_factory=list, max_length=12)
    source: SourceDefinition

    @field_validator("tags", mode="after")
    @classmethod
    def unique_tags(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("tags must be unique")
        return values


class EmbeddedImportCandidateRequest(RequestModel):
    import_ref: ImportRef
    name: Name
    description: Description | None = None
    classification: Literal["public", "internal", "confidential", "restricted"] = "internal"
    format: Literal["geojson"]
    filename: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=3,
            max_length=255,
            pattern=r"^[A-Za-z0-9][A-Za-z0-9._ -]*\.geojson$",
        ),
    ]
    content_type: Literal["application/geo+json"]
    size_bytes: int = Field(ge=1, le=1_048_576)
    checksum_sha256: Checksum
    tags: list[Tag] = Field(default_factory=list, max_length=12)

    @field_validator("tags", mode="after")
    @classmethod
    def unique_tags(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("tags must be unique")
        return values


class CreateProjectImportRequest(RequestModel):
    idempotency_key: UUID
    map_id: UUID
    expected_map_version: int = Field(ge=1)
    source_product: Literal["geolibre"]
    source_version: Literal["2.6.0", "3.0.0"]
    source_sha256: Checksum
    plan_digest: Checksum
    map_definition: dict[str, Any]
    conversion_report: dict[str, Any]
    external_sources: list[ExternalImportCandidateRequest] = Field(
        default_factory=list, max_length=200
    )
    embedded_datasets: list[EmbeddedImportCandidateRequest] = Field(
        default_factory=list, max_length=200
    )

    @model_validator(mode="after")
    def validate_plan(self) -> "CreateProjectImportRequest":
        validate_map_definition(
            self.map_definition,
            allow_import_references=True,
            require_current=True,
        )
        try:
            report_bytes = len(
                json.dumps(
                    self.conversion_report,
                    allow_nan=False,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
        except (TypeError, ValueError) as error:
            raise ValueError("conversion_report must be finite JSON") from error
        if report_bytes > 65_536:
            raise ValueError("conversion_report exceeds 64 KiB")
        candidates = [
            *(candidate.import_ref for candidate in self.external_sources),
            *(candidate.import_ref for candidate in self.embedded_datasets),
        ]
        if len(candidates) != len(set(candidates)):
            raise ValueError("import_ref values must be unique")
        layers = self.map_definition.get("layers")
        if not isinstance(layers, list) or any(not isinstance(layer, dict) for layer in layers):
            raise ValueError("map_definition.layers must be an array of objects")
        layer_refs = [layer.get("importRef") for layer in layers if "importRef" in layer]
        if any(not isinstance(value, str) for value in layer_refs):
            raise ValueError("layer importRef values must be strings")
        if len(layer_refs) != len(set(cast(list[str], layer_refs))):
            raise ValueError("layer importRef values must be unique")
        if set(cast(list[str], layer_refs)) != set(candidates):
            raise ValueError("every imported layer must have exactly one governed candidate")
        return self


class BindImportedDatasetRequest(RequestModel):
    dataset_id: UUID


class ProjectImportItemResponse(BaseModel):
    import_ref: str
    kind: str
    expected_source_type: str
    expected_format: str
    candidate: dict[str, Any]
    state: str
    dataset_id: UUID | None
    bound_at: str | None


class ProjectImportResponse(BaseModel):
    import_id: UUID
    project_id: UUID
    map_id: UUID
    idempotency_key: UUID
    source_product: str
    source_version: str
    source_sha256: str
    plan_digest: str
    expected_map_version: int
    state: str
    ready: bool
    unresolved_import_refs: list[str]
    items: list[ProjectImportItemResponse]
    created_by: UUID
    created_at: str
    updated_at: str
    completed_at: str | None
    final_map_version: int | None


def repository_from_request(request: Request) -> ProjectImportRepository:
    repository = request.app.state.project_import_repository
    if not isinstance(repository, PostgresProjectImportRepository):
        return cast(ProjectImportRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_import[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except ProjectImportAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except ProjectImportNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except ProjectImportConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except ProjectImportStoreUnavailable as error:
        logger.error("project_import_store_unavailable", exc_info=error)
        raise HTTPException(status_code=503, detail="project_import_store_unavailable") from error


def import_response(record: ProjectImport) -> ProjectImportResponse:
    return ProjectImportResponse(
        import_id=record.import_id,
        project_id=record.project_id,
        map_id=record.map_id,
        idempotency_key=record.idempotency_key,
        source_product=record.source_product,
        source_version=record.source_version,
        source_sha256=record.source_sha256,
        plan_digest=record.plan_digest,
        expected_map_version=record.expected_map_version,
        state=record.state,
        ready=record.ready,
        unresolved_import_refs=[item.import_ref for item in record.items if item.state != "bound"],
        items=[
            ProjectImportItemResponse(
                import_ref=item.import_ref,
                kind=item.kind,
                expected_source_type=item.expected_source_type,
                expected_format=item.expected_format,
                candidate=item.candidate,
                state=item.state,
                dataset_id=item.dataset_id,
                bound_at=item.bound_at.isoformat() if item.bound_at else None,
            )
            for item in record.items
        ],
        created_by=record.created_by,
        created_at=record.created_at.isoformat(),
        updated_at=record.updated_at.isoformat(),
        completed_at=record.completed_at.isoformat() if record.completed_at else None,
        final_map_version=record.final_map_version,
    )


@router.post(
    "/projects/{project_id}/imports",
    response_model=ProjectImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_import(
    project_id: UUID,
    payload: CreateProjectImportRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ProjectImportRepository, Depends(repository_from_request)],
) -> ProjectImportResponse:
    external_sources = tuple(
        ExternalImportCandidate(
            import_ref=candidate.import_ref,
            name=candidate.name,
            description=candidate.description,
            classification=candidate.classification,
            source_type=candidate.source.type,
            source_url=candidate.source.url,
            configuration=candidate.source.configuration(),
            tags=tuple(candidate.tags),
        )
        for candidate in payload.external_sources
    )
    embedded_datasets = tuple(
        EmbeddedImportCandidate(
            import_ref=candidate.import_ref,
            name=candidate.name,
            description=candidate.description,
            classification=candidate.classification,
            format=candidate.format,
            filename=candidate.filename,
            content_type=candidate.content_type,
            size_bytes=candidate.size_bytes,
            checksum_sha256=candidate.checksum_sha256,
            tags=tuple(candidate.tags),
        )
        for candidate in payload.embedded_datasets
    )
    record = await execute_import(
        repository.create_import(
            tenant_context(session),
            project_id,
            ProjectImportDraft(
                idempotency_key=payload.idempotency_key,
                map_id=payload.map_id,
                expected_map_version=payload.expected_map_version,
                source_product=payload.source_product,
                source_version=payload.source_version,
                source_sha256=payload.source_sha256,
                plan_digest=payload.plan_digest,
                map_definition=payload.map_definition,
                conversion_report=payload.conversion_report,
                external_sources=external_sources,
                embedded_datasets=embedded_datasets,
            ),
            get_request_id(),
        )
    )
    return import_response(record)


@router.get("/projects/{project_id}/imports/{import_id}", response_model=ProjectImportResponse)
async def get_import(
    project_id: UUID,
    import_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ProjectImportRepository, Depends(repository_from_request)],
) -> ProjectImportResponse:
    return import_response(
        await execute_import(repository.get_import(tenant_context(session), project_id, import_id))
    )


@router.put(
    "/projects/{project_id}/imports/{import_id}/items/{import_ref}/dataset",
    response_model=ProjectImportResponse,
)
async def bind_dataset(
    project_id: UUID,
    import_id: UUID,
    import_ref: ImportRef,
    payload: BindImportedDatasetRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ProjectImportRepository, Depends(repository_from_request)],
) -> ProjectImportResponse:
    return import_response(
        await execute_import(
            repository.bind_dataset(
                tenant_context(session),
                project_id,
                import_id,
                import_ref,
                payload.dataset_id,
                get_request_id(),
            )
        )
    )


@router.post(
    "/projects/{project_id}/imports/{import_id}/finalize",
    response_model=ProjectImportResponse,
)
async def finalize_import(
    project_id: UUID,
    import_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ProjectImportRepository, Depends(repository_from_request)],
) -> ProjectImportResponse:
    return import_response(
        await execute_import(
            repository.finalize_import(
                tenant_context(session), project_id, import_id, get_request_id()
            )
        )
    )
