import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.logging import get_request_id
from opengeo_api.metadata_adapters import (
    MetadataImportInvalid,
    assert_safe_metadata_source,
    build_metadata_import_plan,
)
from opengeo_api.metadata_profiles import (
    MetadataAccessDenied,
    MetadataConflict,
    MetadataFieldType,
    MetadataNotFound,
    MetadataProfile,
    MetadataProfileDraft,
    MetadataProfileRepository,
    MetadataProfileUpdate,
    MetadataStoreUnavailable,
    canonical_metadata_json,
    export_datacite_4_7,
    export_datacite_4_7_xml,
    export_dcat_3,
    export_geodcat_ap_3_1,
    export_iso_19115_3,
    export_schema_org_dataset,
    export_stac_1_1,
    metadata_definition_checksum,
    resource_metadata_document,
    validate_metadata_document,
)
from opengeo_api.ogc_records import export_ogc_record
from opengeo_api.resource_routes import (
    GovernedResourceResponse,
    execute_resource,
    resource_response,
    tenant_context,
)
from opengeo_api.resource_routes import (
    repository_from_request as resource_repository_from_request,
)
from opengeo_api.resources import MetadataSourceDocument, MetadataSourceFormat, ResourceRepository

logger = logging.getLogger(__name__)
router = APIRouter(tags=["metadata governance"])

Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$",
    ),
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)
]
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
ResourceSlug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=160,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$",
    ),
]
CanonicalSha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
FieldName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z][a-z0-9_]{0,99}$",
    ),
]
Term = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
LanguageTag = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=2,
        max_length=40,
        pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    ),
]
CoreField = Literal[
    "title",
    "abstract",
    "language",
    "license",
    "attribution",
    "keywords",
    "spatial_extent",
    "temporal_start",
    "temporal_end",
]
CoreVocabularyField = Literal["language", "license", "keywords"]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MetadataExtensionFieldRequest(RequestModel):
    namespace: Slug
    name: FieldName
    type: MetadataFieldType
    title: Title
    description: Description | None = None
    required: bool = False
    vocabulary: list[Term] = Field(default_factory=list, max_length=128)

    @field_validator("vocabulary", mode="after")
    @classmethod
    def unique_vocabulary(cls, values: list[str]) -> list[str]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("metadata field vocabulary values must be unique")
        return values

    @model_validator(mode="after")
    def compatible_vocabulary(self) -> "MetadataExtensionFieldRequest":
        if self.vocabulary and self.type not in {"string", "string_list"}:
            raise ValueError("vocabularies require a string or string_list field")
        return self


class MetadataProfileDefinitionRequest(RequestModel):
    schema_version: Literal["1.0.0"] = "1.0.0"
    required_core: list[CoreField] = Field(default_factory=list, max_length=9)
    core_vocabularies: dict[CoreVocabularyField, list[Term]] = Field(default_factory=dict)
    required_languages: list[LanguageTag] = Field(default_factory=list, max_length=8)
    extension_fields: list[MetadataExtensionFieldRequest] = Field(
        default_factory=list, max_length=128
    )

    @field_validator("required_core", mode="after")
    @classmethod
    def unique_required_core(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("required core metadata fields must be unique")
        return values

    @field_validator("required_languages", mode="after")
    @classmethod
    def unique_required_languages(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("required metadata languages must be unique")
        return values

    @field_validator("core_vocabularies", mode="after")
    @classmethod
    def valid_core_vocabularies(cls, value: dict[str, list[str]]) -> dict[str, list[str]]:
        for name, terms in value.items():
            if not terms:
                raise ValueError(f"{name} vocabulary must not be empty")
            if len(terms) > 128 or len({term.casefold() for term in terms}) != len(terms):
                raise ValueError(f"{name} vocabulary must contain at most 128 unique values")
        return value

    @field_validator("extension_fields", mode="after")
    @classmethod
    def unique_extension_fields(
        cls, values: list[MetadataExtensionFieldRequest]
    ) -> list[MetadataExtensionFieldRequest]:
        keys = [(value.namespace, value.name) for value in values]
        if len(keys) != len(set(keys)):
            raise ValueError("metadata extension field paths must be unique")
        return values

    @model_validator(mode="after")
    def bounded(self) -> "MetadataProfileDefinitionRequest":
        value = self.model_dump(mode="json")
        if len(metadata_definition_bytes(value)) > 32_768:
            raise ValueError("metadata profile definition exceeds 32768 bytes")
        return self


class CreateMetadataProfileRequest(RequestModel):
    slug: Slug
    title: Title
    description: Description | None = None
    definition: MetadataProfileDefinitionRequest


class UpdateMetadataProfileRequest(RequestModel):
    expected_version: int = Field(ge=1)
    title: Title
    description: Description | None = None
    definition: MetadataProfileDefinitionRequest
    change_message: ChangeMessage | None = None


class ValidateResourceMetadataRequest(RequestModel):
    profile_id: UUID
    expected_profile_version: int = Field(ge=1)


class ImportResourceMetadataRequest(RequestModel):
    source_namespace: Slug
    slug: ResourceSlug
    visibility: Literal["restricted", "organization"] = "restricted"
    document: dict[str, Any] | str
    source_sha256: CanonicalSha256
    managed_profile_id: UUID | None = None
    managed_profile_version: int | None = Field(default=None, ge=1)

    @field_validator("document", mode="after")
    @classmethod
    def safe_document(cls, value: dict[str, Any] | str) -> dict[str, Any] | str:
        assert_safe_metadata_source(value)
        return value

    @model_validator(mode="after")
    def paired_profile(self) -> "ImportResourceMetadataRequest":
        if (self.managed_profile_id is None) != (self.managed_profile_version is None):
            raise ValueError("managed_profile_id and managed_profile_version are required together")
        return self


class MetadataProfileResponse(BaseModel):
    id: UUID
    slug: str
    title: str
    description: str | None
    version_number: int
    definition: dict[str, Any]
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    version_created_by: UUID
    created_at: datetime
    updated_at: datetime
    version_created_at: datetime


class MetadataValidationResponse(BaseModel):
    resource_id: UUID
    resource_version: int
    profile_id: UUID
    profile_version: int
    profile_checksum_sha256: str
    report: dict[str, Any]


class MetadataExportResponse(BaseModel):
    target: Literal[
        "dcat_3",
        "stac_1_1",
        "ogc_records_1_0",
        "iso_19115_3",
        "schema_org_dataset",
        "datacite_4_7",
        "datacite_4_7_xml",
        "geodcat_ap_3_1",
    ]
    target_version: str
    media_type: str
    status: str
    document: dict[str, Any] | None
    document_text: str | None
    report: dict[str, Any]


class MetadataSourceResponse(BaseModel):
    id: UUID
    resource_id: UUID
    resource_version_id: UUID
    source_format: MetadataSourceFormat
    source_version: str
    source_namespace: str
    source_identifier: str
    document: dict[str, Any] | str
    source_sha256: str
    checksum_basis: Literal["canonical_json", "raw_utf8"]
    canonical_json_sha256: str | None
    conversion_report: dict[str, Any]
    imported_by: UUID
    imported_at: datetime


class MetadataImportResponse(BaseModel):
    idempotent: bool
    resource: GovernedResourceResponse
    source: MetadataSourceResponse


def metadata_definition_bytes(value: dict[str, Any]) -> bytes:
    return canonical_metadata_json(value)


def repository_from_request(request: Request) -> MetadataProfileRepository:
    return cast(MetadataProfileRepository, request.app.state.metadata_profile_repository)


async def execute_metadata[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except MetadataAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except MetadataNotFound as error:
        raise HTTPException(status_code=404, detail="metadata_profile_not_found") from error
    except MetadataConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except MetadataStoreUnavailable as error:
        logger.error("metadata.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="metadata_store_unavailable") from error


@router.get("/metadata-profiles", response_model=list[MetadataProfileResponse])
async def list_metadata_profiles(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
) -> list[MetadataProfileResponse]:
    records = await execute_metadata(repository.list_profiles(tenant_context(session)))
    return [_profile_response(record) for record in records]


@router.post(
    "/metadata-profiles",
    response_model=MetadataProfileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_metadata_profile(
    payload: CreateMetadataProfileRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
) -> MetadataProfileResponse:
    definition = payload.definition.model_dump(mode="json")
    record = await execute_metadata(
        repository.create_profile(
            tenant_context(session),
            MetadataProfileDraft(
                slug=payload.slug,
                title=payload.title,
                description=payload.description,
                definition=definition,
                checksum_sha256=metadata_definition_checksum(definition),
            ),
            get_request_id(),
        )
    )
    return _profile_response(record)


@router.get("/metadata-profiles/{profile_id}", response_model=MetadataProfileResponse)
async def get_metadata_profile(
    profile_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
) -> MetadataProfileResponse:
    return _profile_response(
        await execute_metadata(repository.get_profile(tenant_context(session), profile_id))
    )


@router.put("/metadata-profiles/{profile_id}", response_model=MetadataProfileResponse)
async def update_metadata_profile(
    profile_id: UUID,
    payload: UpdateMetadataProfileRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
) -> MetadataProfileResponse:
    definition = payload.definition.model_dump(mode="json")
    return _profile_response(
        await execute_metadata(
            repository.update_profile(
                tenant_context(session),
                profile_id,
                MetadataProfileUpdate(
                    expected_version=payload.expected_version,
                    title=payload.title,
                    description=payload.description,
                    definition=definition,
                    checksum_sha256=metadata_definition_checksum(definition),
                    change_message=payload.change_message,
                ),
                get_request_id(),
            )
        )
    )


@router.post(
    "/projects/{project_id}/resources/{resource_id}/metadata/validate",
    response_model=MetadataValidationResponse,
)
async def validate_resource_metadata(
    project_id: UUID,
    resource_id: UUID,
    payload: ValidateResourceMetadataRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    metadata_repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
    resource_repository: Annotated[ResourceRepository, Depends(resource_repository_from_request)],
) -> MetadataValidationResponse:
    context = tenant_context(session)
    profile = await execute_metadata(metadata_repository.get_profile(context, payload.profile_id))
    if profile.version_number != payload.expected_profile_version:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "metadata_profile_version_conflict",
                "current_version": profile.version_number,
            },
        )
    resource = await execute_resource(
        resource_repository.get_resource(context, project_id, resource_id)
    )
    report = validate_metadata_document(resource_metadata_document(resource), profile.definition)
    return MetadataValidationResponse(
        resource_id=resource_id,
        resource_version=resource.summary.version_number,
        profile_id=profile.profile_id,
        profile_version=profile.version_number,
        profile_checksum_sha256=profile.checksum_sha256,
        report=report,
    )


@router.post(
    "/projects/{project_id}/resources/imports/metadata/{source_format}",
    response_model=MetadataImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_resource_metadata(
    project_id: UUID,
    source_format: MetadataSourceFormat,
    payload: ImportResourceMetadataRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    metadata_repository: Annotated[MetadataProfileRepository, Depends(repository_from_request)],
    resource_repository: Annotated[ResourceRepository, Depends(resource_repository_from_request)],
) -> MetadataImportResponse:
    context = tenant_context(session)
    metadata_profile = "opengeo.core.v1"
    if payload.managed_profile_id is not None:
        profile = await execute_metadata(
            metadata_repository.get_profile(context, payload.managed_profile_id)
        )
        if profile.version_number != payload.managed_profile_version:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "metadata_profile_version_conflict",
                    "current_version": profile.version_number,
                },
            )
        metadata_profile = profile.slug
    try:
        plan = build_metadata_import_plan(
            source_format,
            payload.source_namespace,
            payload.slug,
            payload.visibility,
            payload.document,
            payload.source_sha256,
            managed_profile_id=payload.managed_profile_id,
            managed_profile_version=payload.managed_profile_version,
            metadata_profile=metadata_profile,
        )
    except MetadataImportInvalid as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "metadata_source_invalid", "message": str(error)},
        ) from error
    result = await execute_resource(
        resource_repository.import_metadata_resource(context, project_id, plan, get_request_id())
    )
    return MetadataImportResponse(
        idempotent=result.idempotent,
        resource=resource_response(result.resource),
        source=_source_response(result.source),
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/metadata/source",
    response_model=MetadataSourceResponse,
)
async def get_resource_metadata_source(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    resource_repository: Annotated[ResourceRepository, Depends(resource_repository_from_request)],
) -> MetadataSourceResponse:
    source = await execute_resource(
        resource_repository.get_metadata_source(tenant_context(session), project_id, resource_id)
    )
    return _source_response(source)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/metadata/export/{target}",
    response_model=MetadataExportResponse,
)
async def export_resource_metadata(
    project_id: UUID,
    resource_id: UUID,
    target: Literal[
        "dcat_3",
        "stac_1_1",
        "ogc_records_1_0",
        "iso_19115_3",
        "schema_org_dataset",
        "datacite_4_7",
        "datacite_4_7_xml",
        "geodcat_ap_3_1",
    ],
    session: Annotated[AuthSession, Depends(current_session)],
    resource_repository: Annotated[ResourceRepository, Depends(resource_repository_from_request)],
    language: Annotated[
        str | None,
        Query(
            max_length=40,
            pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
        ),
    ] = None,
) -> MetadataExportResponse:
    if language is not None and target != "ogc_records_1_0":
        raise HTTPException(
            status_code=422,
            detail={"code": "metadata_export_language_not_supported"},
        )
    resource = await execute_resource(
        resource_repository.get_resource(tenant_context(session), project_id, resource_id)
    )
    if target == "dcat_3":
        result = export_dcat_3(resource)
    elif target == "stac_1_1":
        result = export_stac_1_1(resource)
    elif target == "ogc_records_1_0":
        result = export_ogc_record(resource, project_id, language)
    elif target == "iso_19115_3":
        result = export_iso_19115_3(resource)
    elif target == "schema_org_dataset":
        result = export_schema_org_dataset(resource)
    elif target == "datacite_4_7":
        result = export_datacite_4_7(resource)
    elif target == "datacite_4_7_xml":
        result = export_datacite_4_7_xml(resource)
    else:
        result = export_geodcat_ap_3_1(resource)
    return MetadataExportResponse(
        target=cast(Any, result["target"]),
        target_version=cast(str, result["targetVersion"]),
        media_type=cast(str, result["mediaType"]),
        status=cast(str, result["status"]),
        document=cast(dict[str, Any] | None, result["document"]),
        document_text=cast(str | None, result.get("documentText")),
        report=cast(dict[str, Any], result["report"]),
    )


def _profile_response(record: MetadataProfile) -> MetadataProfileResponse:
    return MetadataProfileResponse(
        id=record.profile_id,
        slug=record.slug,
        title=record.title,
        description=record.description,
        version_number=record.version_number,
        definition=record.definition,
        checksum_sha256=record.checksum_sha256,
        change_message=record.change_message,
        created_by=record.created_by,
        version_created_by=record.version_created_by,
        created_at=record.created_at,
        updated_at=record.updated_at,
        version_created_at=record.version_created_at,
    )


def _source_response(record: MetadataSourceDocument) -> MetadataSourceResponse:
    checksum_basis: Literal["canonical_json", "raw_utf8"] = (
        "raw_utf8" if isinstance(record.source_document, str) else "canonical_json"
    )
    return MetadataSourceResponse(
        id=record.source_document_id,
        resource_id=record.resource_id,
        resource_version_id=record.resource_version_id,
        source_format=record.source_format,
        source_version=record.source_version,
        source_namespace=record.source_namespace,
        source_identifier=record.source_identifier,
        document=record.source_document,
        source_sha256=record.source_sha256,
        checksum_basis=checksum_basis,
        canonical_json_sha256=(
            record.source_sha256 if checksum_basis == "canonical_json" else None
        ),
        conversion_report=record.conversion_report,
        imported_by=record.imported_by,
        imported_at=record.imported_at,
    )
