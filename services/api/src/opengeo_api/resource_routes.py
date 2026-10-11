import json
import logging
import math
import re
from asyncio import gather
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import Annotated, Any, Literal, cast
from uuid import UUID
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
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
from opengeo_api.external_source_routes import _validate_public_https_url
from opengeo_api.geonode_adapter import (
    GEONODE_COMMIT,
    GEONODE_VERSION,
    assert_safe_geonode_tree,
    build_geonode_import_plan,
    export_geonode_resource,
)
from opengeo_api.ingestion import IngestionRepository
from opengeo_api.ingestion_routes import (
    execute_ingestion,
)
from opengeo_api.ingestion_routes import (
    repository_from_request as ingestion_repository_from_request,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.logging import get_request_id
from opengeo_api.mapserver_config import (
    MAXIMUM_MAPFILE_BYTES,
    MAXIMUM_MAPSCRIPT_BYTES,
    MapServerConfigurationInvalid,
    MapServerConfigurationUnsafe,
    convert_mapserver_configuration,
    export_mapserver_configuration,
)
from opengeo_api.metadata_catalog import validate_catalog_extensions
from opengeo_api.page_renderer_contract import PAGE_RENDERER_VERSION
from opengeo_api.resources import (
    GovernedResource,
    PageSource,
    PageSourceUploadDraft,
    PageSourceUploadTicket,
    PageVersion,
    PageWorkingDraft,
    PageWorkingDraftUpdate,
    PostgresResourceRepository,
    ResourceAccessDenied,
    ResourceCapabilities,
    ResourceConflict,
    ResourceDraft,
    ResourceFilters,
    ResourceKind,
    ResourceMetadata,
    ResourceMetadataInvalid,
    ResourceNotFound,
    ResourcePermission,
    ResourcePermissionGrant,
    ResourceRelation,
    ResourceRepository,
    ResourceSearchInvalid,
    ResourceState,
    ResourceStoreUnavailable,
    ResourceStyle,
    ResourceStyleDraft,
    ResourceStyleFormat,
    ResourceStyleUpdate,
    ResourceSummary,
    ResourceUpdate,
    ResourceVisibility,
    ResourceWorkflowEvent,
)
from opengeo_api.s3_downloads import DownloadStorageUnavailable
from opengeo_api.s3_uploads import UploadObjectNotFound, UploadStorageUnavailable
from opengeo_api.site_export import render_page_preview_html
from opengeo_api.site_publications import SiteAssetCandidate, SitePublicationRepository
from opengeo_api.site_routes import (
    execute_site,
)
from opengeo_api.site_routes import (
    repository_from_request as site_repository_from_request,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["governed resources"])

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Abstract = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8_000)]
Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=160,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$",
    ),
]
Language = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=2,
        max_length=40,
        pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    ),
]
Rights = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
Attribution = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000)
]
Keyword = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Profile = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z0-9][a-z0-9._-]{0,99}$",
    ),
]
BlockId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
MapServerLayerId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z][A-Za-z0-9._:-]{0,99}$",
    ),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MarkdownBlock(RequestModel):
    id: BlockId
    type: Literal["markdown"]
    markdown: Annotated[str, StringConstraints(min_length=1, max_length=8_000)]


class HeadingBlock(RequestModel):
    id: BlockId
    type: Literal["heading"]
    level: Literal[2, 3, 4]
    text: Title


class CalloutBlock(RequestModel):
    id: BlockId
    type: Literal["callout"]
    tone: Literal["note", "tip", "warning", "important"]
    title: Title
    markdown: Annotated[str, StringConstraints(min_length=1, max_length=2_000)]


class NavigationBlock(RequestModel):
    id: BlockId
    type: Literal["navigation"]
    label: Label
    heading_block_ids: list[BlockId] = Field(min_length=1, max_length=12)

    @field_validator("heading_block_ids", mode="after")
    @classmethod
    def unique_targets(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("navigation heading targets must be unique")
        return values


class ResourceReferenceBlock(RequestModel):
    id: BlockId
    type: Literal["map", "dataset"]
    resource_id: UUID
    resource_version_number: int | None = Field(default=None, ge=1)
    caption: Label | None = None


class LinkBlock(RequestModel):
    id: BlockId
    type: Literal["link"]
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2_048)]
    label: Label

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        _validate_public_https_url(value, allow_query=True)
        return value


class CitationBlock(RequestModel):
    id: BlockId
    type: Literal["citation"]
    title: Title
    doi: (
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True,
                min_length=6,
                max_length=200,
                pattern=r"^10\.[0-9]{4,9}/\S+$",
            ),
        ]
        | None
    ) = None
    url: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2_048)]
        | None
    ) = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        if value is not None:
            _validate_public_https_url(value, allow_query=True)
        return value

    @model_validator(mode="after")
    def require_locator(self) -> "CitationBlock":
        if self.doi is None and self.url is None:
            raise ValueError("citation requires a DOI or URL")
        return self


class TableBlock(RequestModel):
    id: BlockId
    type: Literal["table"]
    caption: Label
    columns: list[Label] = Field(min_length=1, max_length=12)
    rows: list[list[Any]] = Field(default_factory=list, max_length=50)

    @field_validator("columns", mode="after")
    @classmethod
    def unique_columns(cls, values: list[str]) -> list[str]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("table columns must be unique")
        return values

    @model_validator(mode="after")
    def validate_rows(self) -> "TableBlock":
        for row in self.rows:
            if len(row) != len(self.columns):
                raise ValueError("every table row must match the column count")
            for cell in row:
                if cell is None or isinstance(cell, bool):
                    continue
                if isinstance(cell, int):
                    if abs(cell) > 10**15:
                        raise ValueError("table integer is out of bounds")
                    continue
                if isinstance(cell, float):
                    if not math.isfinite(cell) or abs(cell) > 10**15:
                        raise ValueError("table number is out of bounds")
                    continue
                if isinstance(cell, str) and len(cell) <= 300:
                    continue
                raise ValueError("table cell must be a bounded JSON scalar")
        return self


class ChartBlock(RequestModel):
    id: BlockId
    type: Literal["chart"]
    chart_type: Literal["bar", "line"]
    title: Title
    alt_text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)
    ]
    table_block_id: BlockId
    x_column: Label
    y_columns: list[Label] = Field(min_length=1, max_length=4)

    @field_validator("y_columns", mode="after")
    @classmethod
    def unique_y_columns(cls, values: list[str]) -> list[str]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("chart value columns must be unique")
        return values


class ImageBlock(RequestModel):
    id: BlockId
    type: Literal["image"]
    dataset_id: UUID
    dataset_version_id: UUID
    object_id: UUID
    alt_text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)
    ]
    caption: Label | None = None


class FileBlock(RequestModel):
    id: BlockId
    type: Literal["file"]
    dataset_id: UUID
    dataset_version_id: UUID
    object_id: UUID
    label: Label
    description: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
        | None
    ) = None


class DocumentBlock(RequestModel):
    id: BlockId
    type: Literal["document"]
    dataset_id: UUID
    dataset_version_id: UUID
    object_id: UUID
    label: Label


class PreservedBlock(RequestModel):
    id: BlockId
    type: Literal["preserved"]
    namespace: Profile
    label: Label


ContentBlock = Annotated[
    MarkdownBlock
    | HeadingBlock
    | CalloutBlock
    | NavigationBlock
    | ResourceReferenceBlock
    | LinkBlock
    | CitationBlock
    | TableBlock
    | ChartBlock
    | ImageBlock
    | FileBlock
    | DocumentBlock
    | PreservedBlock,
    Field(discriminator="type"),
]


class ResourceContentRequest(RequestModel):
    blocks: list[ContentBlock] = Field(default_factory=list, max_length=24)

    @field_validator("blocks", mode="after")
    @classmethod
    def unique_ids(cls, values: list[ContentBlock]) -> list[ContentBlock]:
        ids = [value.id for value in values]
        if len(ids) != len(set(ids)):
            raise ValueError("content block ids must be unique")
        headings = {value.id: value for value in values if isinstance(value, HeadingBlock)}
        heading_positions = {
            value.id: index for index, value in enumerate(values) if isinstance(value, HeadingBlock)
        }
        previous_heading_level: int | None = None
        for value in values:
            if isinstance(value, HeadingBlock):
                if previous_heading_level is None and value.level != 2:
                    raise ValueError("the first structural heading must be level 2")
                if previous_heading_level is not None and value.level > previous_heading_level + 1:
                    raise ValueError("structural heading levels cannot be skipped")
                previous_heading_level = value.level
            if isinstance(value, NavigationBlock):
                if any(target not in headings for target in value.heading_block_ids):
                    raise ValueError("navigation must target headings in the same resource")
                positions = [heading_positions[target] for target in value.heading_block_ids]
                if positions != sorted(positions):
                    raise ValueError("navigation headings must preserve document order")
        tables = {value.id: value for value in values if isinstance(value, TableBlock)}
        for value in values:
            if not isinstance(value, ChartBlock):
                continue
            table = tables.get(value.table_block_id)
            if table is None:
                raise ValueError("chart must reference a table block in the same resource")
            columns = {column.casefold(): index for index, column in enumerate(table.columns)}
            if value.x_column.casefold() not in columns:
                raise ValueError("chart category column is absent from its table")
            if value.x_column.casefold() in {column.casefold() for column in value.y_columns}:
                raise ValueError("chart category and value columns must differ")
            for column in value.y_columns:
                index = columns.get(column.casefold())
                if index is None:
                    raise ValueError("chart value column is absent from its table")
                values_in_column = [row[index] for row in table.rows if row[index] is not None]
                if not values_in_column or any(
                    isinstance(cell, bool) or not isinstance(cell, (int, float))
                    for cell in values_in_column
                ):
                    raise ValueError("chart value columns must contain only numbers")
        return values

    @model_validator(mode="after")
    def bounded(self) -> "ResourceContentRequest":
        _bounded_json(self.model_dump(mode="json"), 16_384, "resource content")
        return self


class LocalizedResourceMetadataRequest(RequestModel):
    title: Title
    abstract: Abstract | None = None
    attribution: Attribution | None = None
    keywords: list[Keyword] = Field(default_factory=list, max_length=64)

    @field_validator("keywords", mode="after")
    @classmethod
    def unique_keywords(cls, values: list[str]) -> list[str]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("translated metadata keywords must be unique")
        return values


class ResourceMetadataRequest(RequestModel):
    title: Title
    abstract: Abstract | None = None
    language: Language = "en"
    license: Rights | None = None
    attribution: Attribution | None = None
    keywords: list[Keyword] = Field(default_factory=list, max_length=64)
    spatial_extent: list[float] | None = Field(default=None, min_length=4, max_length=4)
    temporal_start: datetime | None = None
    temporal_end: datetime | None = None
    profile: Profile = "opengeo.core.v1"
    extensions: dict[str, Any] = Field(default_factory=dict)
    translations: dict[Language, LocalizedResourceMetadataRequest] = Field(
        default_factory=dict, max_length=8
    )
    managed_profile_id: UUID | None = None
    managed_profile_version: int | None = Field(default=None, ge=1)

    @field_validator("keywords", mode="after")
    @classmethod
    def unique_keywords(cls, values: list[str]) -> list[str]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("metadata keywords must be unique")
        return values

    @field_validator("language", mode="after")
    @classmethod
    def normalize_language(cls, value: str) -> str:
        return value.lower()

    @field_validator("translations", mode="after")
    @classmethod
    def normalize_translations(
        cls, values: dict[str, LocalizedResourceMetadataRequest]
    ) -> dict[str, LocalizedResourceMetadataRequest]:
        normalized: dict[str, LocalizedResourceMetadataRequest] = {}
        for language, value in values.items():
            key = language.lower()
            if key in normalized:
                raise ValueError("translated metadata languages must be unique")
            normalized[key] = value
        _bounded_json(
            {key: value.model_dump(mode="json") for key, value in normalized.items()},
            16_384,
            "translated metadata",
        )
        return normalized

    @field_validator("spatial_extent", mode="after")
    @classmethod
    def validate_extent(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return None
        if not all(math.isfinite(item) for item in value):
            raise ValueError("spatial extent must be finite")
        min_x, min_y, max_x, max_y = value
        if not (-180 <= min_x <= max_x <= 180 and -90 <= min_y <= max_y <= 90):
            raise ValueError("spatial extent must be an ordered EPSG:4326 bbox")
        return value

    @field_validator("temporal_start", "temporal_end", mode="after")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("temporal extent must include a timezone")
        return value

    @field_validator("extensions", mode="after")
    @classmethod
    def validate_extensions(cls, value: dict[str, Any]) -> dict[str, Any]:
        if any(
            not key
            or len(key) > 100
            or not key[0].isalnum()
            or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789._-" for character in key)
            for key in value
        ):
            raise ValueError("metadata extension keys must be lowercase namespaces")
        assert_safe_geonode_tree(value, maximum_nodes=5_000)
        value = validate_catalog_extensions(value)
        _bounded_json(value, 8_192, "metadata extensions")
        return value

    @model_validator(mode="after")
    def validate_temporal_order(self) -> "ResourceMetadataRequest":
        if (self.managed_profile_id is None) != (self.managed_profile_version is None):
            raise ValueError("managed_profile_id and managed_profile_version are required together")
        if (
            self.temporal_start is not None
            and self.temporal_end is not None
            and self.temporal_start > self.temporal_end
        ):
            raise ValueError("temporal_start must not exceed temporal_end")
        if self.language in self.translations:
            raise ValueError("primary language must not be duplicated in translations")
        return self


class CreateResourceRequest(RequestModel):
    kind: ResourceKind
    slug: Slug
    dataset_id: UUID | None = None
    map_id: UUID | None = None
    expected_map_version: int | None = Field(
        default=None, ge=1, le=9_007_199_254_740_991, strict=True
    )
    visibility: Literal["restricted", "organization"] = "restricted"
    metadata: ResourceMetadataRequest
    content: ResourceContentRequest = Field(default_factory=ResourceContentRequest)
    provenance: dict[str, Any] = Field(default_factory=dict)

    @field_validator("provenance", mode="after")
    @classmethod
    def validate_provenance(cls, value: dict[str, Any]) -> dict[str, Any]:
        assert_safe_geonode_tree(value, maximum_nodes=2_000)
        _bounded_json(value, 4_096, "resource provenance")
        return value

    @model_validator(mode="after")
    def validate_binding(self) -> "CreateResourceRequest":
        if self.dataset_id is not None and self.kind not in {"dataset", "service"}:
            raise ValueError("dataset_id is valid only for dataset or service resources")
        if self.map_id is not None and self.kind != "map":
            raise ValueError("map_id is valid only for map resources")
        if self.expected_map_version is not None and self.kind != "map":
            raise ValueError("expected_map_version is valid only for map resources")
        if self.dataset_id is not None and self.map_id is not None:
            raise ValueError("a resource cannot bind both a dataset and a map")
        if self.kind == "dataset" and self.dataset_id is None:
            raise ValueError("locally created dataset resources require dataset_id")
        if self.kind == "map" and self.map_id is None:
            raise ValueError("locally created map resources require map_id")
        return self


class UpdateResourceRequest(RequestModel):
    expected_version: int = Field(ge=1)
    visibility: Literal["restricted", "organization"]
    metadata: ResourceMetadataRequest
    content: ResourceContentRequest
    provenance: dict[str, Any] = Field(default_factory=dict)
    change_message: ChangeMessage | None = None
    expected_map_version: int | None = Field(
        default=None, ge=1, le=9_007_199_254_740_991, strict=True
    )

    @field_validator("provenance", mode="after")
    @classmethod
    def validate_provenance(cls, value: dict[str, Any]) -> dict[str, Any]:
        assert_safe_geonode_tree(value, maximum_nodes=2_000)
        _bounded_json(value, 4_096, "resource provenance")
        return value


class RequestPageSourceUpload(RequestModel):
    expected_version: int = Field(ge=1)
    source_block_id: BlockId
    size_bytes: int = Field(ge=1, le=65_536)
    checksum_sha256: Annotated[
        str,
        StringConstraints(strip_whitespace=True, to_lower=True, pattern=r"^[0-9a-f]{64}$"),
    ]


class CreatePageVersionRequest(UpdateResourceRequest):
    upload_id: UUID
    change_message: ChangeMessage


class PutPageWorkingDraftRequest(RequestModel):
    expected_resource_version: int = Field(ge=1)
    expected_draft_revision: int = Field(ge=0, le=512)
    visibility: Literal["restricted", "organization"]
    metadata: ResourceMetadataRequest
    content: ResourceContentRequest
    provenance: dict[str, Any] = Field(default_factory=dict)
    source_block_id: BlockId | None = None
    source_markdown: Annotated[str, StringConstraints(max_length=8_000)]
    change_summary: ChangeMessage | None = None

    @field_validator("provenance", mode="after")
    @classmethod
    def validate_provenance(cls, value: dict[str, Any]) -> dict[str, Any]:
        assert_safe_geonode_tree(value, maximum_nodes=2_000)
        _bounded_json(value, 4_096, "resource provenance")
        return value


class PreviewPageVersionRequest(RequestModel):
    title: Title
    abstract: Abstract | None = None
    content: ResourceContentRequest


class CreateRelationshipRequest(RequestModel):
    target_resource_id: UUID
    relation: ResourceRelation


class BindResourceRequest(RequestModel):
    expected_version: int = Field(ge=1)
    dataset_id: UUID | None = None
    map_id: UUID | None = None

    @model_validator(mode="after")
    def exactly_one_binding(self) -> "BindResourceRequest":
        if (self.dataset_id is None) == (self.map_id is None):
            raise ValueError("exactly one dataset_id or map_id is required")
        return self


class TransitionResourceRequest(RequestModel):
    expected_version: int = Field(ge=1)
    target_state: Literal["review", "published", "archived"]
    visibility: Literal["organization", "public"] | None = None
    reason: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
        | None
    ) = None

    @model_validator(mode="after")
    def publication_visibility(self) -> "TransitionResourceRequest":
        if self.target_state == "published" and self.visibility is None:
            raise ValueError("published transitions require visibility")
        if self.target_state != "published" and self.visibility is not None:
            raise ValueError("visibility is accepted only when publishing")
        return self


class PublicationVisibilityRequest(RequestModel):
    expected_version: int = Field(ge=1, strict=True)
    expected_visibility: Literal["restricted", "organization", "public"]
    visibility: Literal["organization", "public"]


class PutResourcePermissionRequest(RequestModel):
    role: Literal["manage", "edit", "publish", "view"]


class CreateResourceStyleRequest(RequestModel):
    slug: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            to_lower=True,
            min_length=1,
            max_length=100,
            pattern=r"^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$",
        ),
    ]
    format: ResourceStyleFormat
    title: Title
    definition: Annotated[str, StringConstraints(min_length=2, max_length=49_152)]

    @model_validator(mode="after")
    def safe_definition(self) -> "CreateResourceStyleRequest":
        _validate_style_definition(self.format, self.definition)
        return self


class UpdateResourceStyleRequest(RequestModel):
    expected_version: int = Field(ge=1)
    format: ResourceStyleFormat
    title: Title
    definition: Annotated[str, StringConstraints(min_length=2, max_length=49_152)]
    change_message: ChangeMessage | None = None

    @model_validator(mode="after")
    def safe_definition(self) -> "UpdateResourceStyleRequest":
        _validate_style_definition(self.format, self.definition)
        return self


class ResourceStyleArchiveRequest(RequestModel):
    expected_version: int = Field(ge=1, le=9007199254740991)


class ImportMapServerStyleRequest(RequestModel):
    slug: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            to_lower=True,
            min_length=1,
            max_length=100,
            pattern=r"^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$",
        ),
    ]
    title: Title
    mapfile: Annotated[str, StringConstraints(min_length=2, max_length=MAXIMUM_MAPFILE_BYTES)]
    layer_name: MapServerLayerId | None = None
    mapscript: (
        Annotated[str, StringConstraints(min_length=1, max_length=MAXIMUM_MAPSCRIPT_BYTES)] | None
    ) = None


class GeoNodeNamedValue(RequestModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class GeoNodeExtent(RequestModel):
    coords: list[float] = Field(min_length=4, max_length=4)
    srid: Literal["EPSG:4326"] = "EPSG:4326"

    @field_validator("coords", mode="after")
    @classmethod
    def validate_coords(cls, value: list[float]) -> list[float]:
        return cast(list[float], ResourceMetadataRequest.validate_extent(value))


class GeoNodeResource(BaseModel):
    model_config = ConfigDict(extra="allow")

    pk: int = Field(ge=1)
    uuid: UUID
    resource_type: Literal[
        "dataset", "map", "document", "geoapp", "geostory", "story", "dashboard", "service"
    ]
    subtype: Literal["geostory", "story", "dashboard"] | None = None
    title: Title
    abstract: Abstract | None = None
    attribution: Attribution | None = None
    language: Language = "en"
    license: Rights | GeoNodeNamedValue | None = None
    keywords: list[Keyword | GeoNodeNamedValue] = Field(default_factory=list, max_length=64)
    temporal_extent_start: datetime | None = None
    temporal_extent_end: datetime | None = None
    extent: GeoNodeExtent | None = None
    is_published: bool = False
    is_approved: bool = False
    advertised: bool = False
    perms: dict[str, Any] | list[Any] | None = None
    styles: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    detail_url: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2_048)]
        | None
    ) = None
    thumbnail_url: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2_048)]
        | None
    ) = None
    links: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    data: Any = None
    owner: dict[str, Any] | None = None

    @field_validator("detail_url", "thumbnail_url", mode="after")
    @classmethod
    def validate_public_url(cls, value: str | None) -> str | None:
        if value is not None:
            _validate_public_https_url(value, allow_query=True)
        return value

    @model_validator(mode="after")
    def validate_geoapp(self) -> "GeoNodeResource":
        if self.resource_type == "geoapp" and self.subtype is None:
            raise ValueError("GeoNode geoapp resources require a supported subtype")
        if self.resource_type != "geoapp" and self.subtype is not None:
            raise ValueError("GeoNode subtype is valid only for geoapp resources")
        return self


class GeoNodeRelationship(RequestModel):
    source_uuid: UUID
    target_uuid: UUID
    relation: ResourceRelation

    @model_validator(mode="after")
    def reject_self(self) -> "GeoNodeRelationship":
        if self.source_uuid == self.target_uuid:
            raise ValueError("GeoNode relationships cannot be self-referential")
        return self


class GeoNodeImportRequest(RequestModel):
    source_product: Literal["geonode"]
    source_version: Literal["5.1.0"]
    source_commit: Literal["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"]
    source_url: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2_048)
    ]
    resources: list[GeoNodeResource] = Field(min_length=1, max_length=50)
    relationships: list[GeoNodeRelationship] = Field(default_factory=list, max_length=200)

    @field_validator("source_url", mode="after")
    @classmethod
    def validate_source_url(cls, value: str) -> str:
        _validate_public_https_url(value, allow_query=False)
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_package(self) -> "GeoNodeImportRequest":
        package = self.model_dump(mode="json")
        assert_safe_geonode_tree(package)
        _bounded_json(package, 262_144, "GeoNode import package")
        uuids = [resource.uuid for resource in self.resources]
        if len(uuids) != len(set(uuids)):
            raise ValueError("GeoNode resource UUIDs must be unique")
        relationships = [
            (item.source_uuid, item.target_uuid, item.relation) for item in self.relationships
        ]
        if len(relationships) != len(set(relationships)):
            raise ValueError("GeoNode relationships must be unique")
        return self


class ResourceSummaryResponse(BaseModel):
    id: UUID
    project_id: UUID
    kind: ResourceKind
    slug: str
    dataset_id: UUID | None
    map_id: UUID | None
    visibility: ResourceVisibility
    state: ResourceState
    version_number: int
    title: str
    abstract: str | None
    language: str
    license: str | None
    attribution: str | None
    keywords: list[str]
    spatial_extent: list[float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None
    owner_user_id: UUID
    origin_namespace: str | None
    origin_identifier: str | None
    relationship_count: int
    created_at: datetime
    updated_at: datetime


class ExternalIdentifierResponse(BaseModel):
    namespace: str
    identifier: str
    source_url: str
    source_version: str
    source_payload_sha256: str
    imported_at: datetime


class RelationshipResponse(BaseModel):
    id: UUID
    source_resource_id: UUID
    target_resource_id: UUID
    relation: ResourceRelation
    created_by: UUID
    created_at: datetime


class ResourcePermissionResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    role: Literal["manage", "edit", "publish", "view"]
    granted_by: UUID
    created_at: datetime
    updated_at: datetime


class ResourceCapabilitiesResponse(BaseModel):
    can_read: bool
    can_update: bool
    can_publish: bool
    can_manage_permissions: bool


class ResourceStyleResponse(BaseModel):
    id: UUID
    resource_id: UUID
    slug: str
    format: ResourceStyleFormat
    version_number: int
    title: str
    media_type: str
    definition: str
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    archived: bool = False


class MapServerStyleImportResponse(BaseModel):
    style: ResourceStyleResponse
    canonical_mapfile: str
    report: dict[str, Any]
    activation: dict[str, Any]
    request_limits: dict[str, int]


class MapServerStyleExportResponse(BaseModel):
    style_id: UUID
    filename: str
    media_type: Literal["text/vnd.mapserver.mapfile"] = "text/vnd.mapserver.mapfile"
    mapfile: str
    report: dict[str, Any]


class ResourceWorkflowEventResponse(BaseModel):
    id: UUID
    source_state: ResourceState
    target_state: ResourceState
    reason: str | None
    actor_user_id: UUID
    created_at: datetime


class MapResourceSnapshotResponse(BaseModel):
    map_id: UUID
    map_version_id: UUID
    map_version: int
    definition_checksum_sha256: str


class GovernedResourceResponse(ResourceSummaryResponse):
    metadata_profile: str
    metadata_extensions: dict[str, Any]
    translations: dict[str, dict[str, Any]]
    content: dict[str, Any]
    provenance: dict[str, Any]
    change_message: str | None
    version_created_by: UUID
    version_created_at: datetime
    external_identifiers: list[ExternalIdentifierResponse]
    relationships: list[RelationshipResponse]
    managed_metadata_profile_id: UUID | None
    managed_metadata_profile_version: int | None
    metadata_validation: dict[str, Any] | None
    map_snapshot: MapResourceSnapshotResponse | None = None
    current_version_id: UUID | None = None


class PageSourceUploadInstructionsResponse(BaseModel):
    url: str
    method: Literal["POST"]
    fields: dict[str, str]


class PageSourceUploadResponse(BaseModel):
    upload_id: UUID
    resource_id: UUID
    expected_resource_version: int
    source_block_id: str
    expires_at: datetime
    upload: PageSourceUploadInstructionsResponse


class PageSourceResponse(BaseModel):
    id: UUID
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    parent_version_number: int | None
    source_block_id: str
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: Literal["text/markdown"]
    size_bytes: int
    checksum_sha256: str
    dialect: Literal["opengeo-markdown"]
    dialect_version: str
    compiler_version: str
    change_summary: str
    created_by: UUID
    created_at: datetime
    source_markdown: str | None


class PageVersionResponse(BaseModel):
    resource: GovernedResourceResponse
    source: PageSourceResponse


class PageWorkingDraftResponse(BaseModel):
    id: UUID
    resource_id: UUID
    owner_user_id: UUID
    base_resource_version: int
    revision_number: int
    visibility: ResourceVisibility
    metadata: dict[str, Any]
    content: dict[str, Any]
    provenance: dict[str, Any]
    source_block_id: str | None
    source_markdown: str
    change_summary: str | None
    document_checksum_sha256: str
    created_at: datetime
    updated_at: datetime


class PagePreviewDependencyResponse(BaseModel):
    block_id: str
    kind: Literal["map", "dataset", "image", "file", "document"]
    resource_id: UUID | None = None
    resource_version_number: int | None = None
    dataset_id: UUID | None = None
    dataset_version_id: UUID | None = None
    object_id: UUID | None = None
    checksum_sha256: str | None = None


class PagePreviewResponse(BaseModel):
    renderer_version: Literal["opengeo-page-renderer-1.1.0"]
    content_checksum_sha256: str
    html: Annotated[str, StringConstraints(min_length=1, max_length=131_072)]
    dependencies: list[PagePreviewDependencyResponse] = Field(max_length=24)


@dataclass(frozen=True, slots=True)
class _PreviewResourceReference:
    resource_id: UUID
    version_number: int
    kind: str
    title: str
    abstract: str | None
    attribution: str | None
    license: str | None
    wms_service_id: UUID | None = None
    wms_layer_name: str | None = None
    snapshot: None = None


class GeoNodeImportResponse(BaseModel):
    source_product: Literal["geonode"] = "geonode"
    source_version: Literal["5.1.0"] = GEONODE_VERSION
    source_commit: Literal["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"] = GEONODE_COMMIT
    idempotent: bool
    resources: list[GovernedResourceResponse]
    report: dict[str, Any]


class GeoNodeExportResponse(BaseModel):
    source_product: Literal["opengeo"] = "opengeo"
    target_product: Literal["geonode"] = "geonode"
    target_version: Literal["5.1.0"] = GEONODE_VERSION
    target_commit: Literal["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"] = GEONODE_COMMIT
    resource: dict[str, Any]
    report: dict[str, Any]


def repository_from_request(request: Request) -> ResourceRepository:
    repository = request.app.state.resource_repository
    if not isinstance(repository, PostgresResourceRepository):
        return cast(ResourceRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_resource[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except ResourceAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except ResourceNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except ResourceConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        if error.current_draft_revision is not None:
            detail["current_draft_revision"] = error.current_draft_revision
        response_status = 410 if error.code == "page_source_upload_expired" else 409
        raise HTTPException(status_code=response_status, detail=detail) from error
    except ResourceSearchInvalid as error:
        raise HTTPException(status_code=400, detail="invalid_resource_search") from error
    except ResourceMetadataInvalid as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "metadata_profile_validation_failed", "report": error.report},
        ) from error
    except ResourceStoreUnavailable as error:
        logger.error("resource.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="resource_store_unavailable") from error
    except UploadObjectNotFound as error:
        raise HTTPException(
            status_code=409, detail={"code": "page_source_upload_object_missing"}
        ) from error
    except UploadStorageUnavailable as error:
        logger.error("page_source.upload_storage_unavailable")
        raise HTTPException(status_code=503, detail="page_source_storage_unavailable") from error
    except DownloadStorageUnavailable as error:
        logger.error("page_source.download_storage_unavailable")
        raise HTTPException(status_code=503, detail="page_source_storage_unavailable") from error


async def _page_preview_context(
    *,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    expected_version: int,
    content: dict[str, Any],
    repository: ResourceRepository,
    site_repository: SitePublicationRepository,
) -> tuple[
    GovernedResource,
    dict[UUID, _PreviewResourceReference],
    dict[UUID, SiteAssetCandidate],
    list[PagePreviewDependencyResponse],
]:
    page = await execute_resource(repository.get_resource(context, project_id, resource_id))
    if page.summary.kind not in {"document", "story", "dashboard"}:
        raise HTTPException(status_code=409, detail={"code": "page_source_kind_unsupported"})
    if page.summary.version_number != expected_version:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "resource_version_conflict",
                "current_version": page.summary.version_number,
            },
        )
    blocks = cast(list[dict[str, Any]], content.get("blocks", []))
    resource_blocks = [block for block in blocks if block.get("type") in {"map", "dataset"}]
    requested_resources: dict[UUID, tuple[str, int]] = {}
    for block in resource_blocks:
        reference_id = UUID(str(block["resource_id"]))
        pinned_version = block.get("resource_version_number")
        if not isinstance(pinned_version, int) or isinstance(pinned_version, bool):
            raise HTTPException(
                status_code=409,
                detail={"code": "page_dependency_version_required"},
            )
        expected = (cast(str, block["type"]), pinned_version)
        previous = requested_resources.get(reference_id)
        if previous is not None and previous != expected:
            raise HTTPException(
                status_code=409,
                detail={"code": "page_dependency_conflict"},
            )
        requested_resources[reference_id] = expected
    loaded = await gather(
        *(
            execute_resource(repository.get_resource(context, project_id, reference_id))
            for reference_id in requested_resources
        )
    )
    references: dict[UUID, _PreviewResourceReference] = {}
    for record in loaded:
        expected_kind, pinned_version = requested_resources[record.summary.resource_id]
        if record.summary.kind != expected_kind:
            raise HTTPException(
                status_code=409,
                detail={"code": "page_dependency_kind_mismatch"},
            )
        if record.summary.version_number != pinned_version:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "page_dependency_version_conflict",
                    "current_version": record.summary.version_number,
                },
            )
        references[record.summary.resource_id] = _PreviewResourceReference(
            resource_id=record.summary.resource_id,
            version_number=record.summary.version_number,
            kind=record.summary.kind,
            title=record.summary.title,
            abstract=record.summary.abstract,
            attribution=record.summary.attribution,
            license=record.summary.license,
        )
    asset_blocks = [block for block in blocks if block.get("type") in {"image", "file", "document"}]
    candidates = (
        await execute_site(site_repository.list_asset_candidates(context, project_id))
        if asset_blocks
        else ()
    )
    candidate_by_object = {candidate.object_id: candidate for candidate in candidates}
    assets: dict[UUID, SiteAssetCandidate] = {}
    for block in asset_blocks:
        object_id = UUID(str(block["object_id"]))
        candidate = candidate_by_object.get(object_id)
        if (
            candidate is None
            or candidate.kind != block["type"]
            or candidate.dataset_id != UUID(str(block["dataset_id"]))
            or candidate.dataset_version_id != UUID(str(block["dataset_version_id"]))
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "page_asset_not_publishable"},
            )
        assets[object_id] = candidate
    dependencies = [
        PagePreviewDependencyResponse(
            block_id=cast(str, block["id"]),
            kind=cast(Literal["map", "dataset"], block["type"]),
            resource_id=UUID(str(block["resource_id"])),
            resource_version_number=cast(int, block["resource_version_number"]),
        )
        for block in resource_blocks
    ]
    dependencies.extend(
        PagePreviewDependencyResponse(
            block_id=cast(str, block["id"]),
            kind=cast(Literal["image", "file", "document"], block["type"]),
            dataset_id=UUID(str(block["dataset_id"])),
            dataset_version_id=UUID(str(block["dataset_version_id"])),
            object_id=UUID(str(block["object_id"])),
            checksum_sha256=assets[UUID(str(block["object_id"]))].checksum_sha256,
        )
        for block in asset_blocks
    )
    return page, references, assets, dependencies


@router.get("/datasets/{dataset_id}/resources", response_model=list[ResourceSummaryResponse])
async def dataset_resources(
    dataset_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[ResourceSummaryResponse]:
    context = tenant_context(session)
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    records = await execute_resource(
        repository.list_dataset_resources(context, dataset_id, limit, offset)
    )
    response.headers["Cache-Control"] = "no-store"
    return [summary_response(record) for record in records]


@router.get(
    "/projects/{project_id}/resources",
    response_model=list[ResourceSummaryResponse],
)
async def list_resources(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    query: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    kind: ResourceKind | None = None,
    visibility: ResourceVisibility | None = None,
    resource_state: Annotated[ResourceState | None, Query(alias="state")] = None,
    bbox: Annotated[str | None, Query(min_length=7, max_length=100)] = None,
    temporal_start: datetime | None = None,
    temporal_end: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[ResourceSummaryResponse]:
    records = await execute_resource(
        repository.list_resources(
            tenant_context(session),
            project_id,
            ResourceFilters(
                query=query,
                kind=kind,
                visibility=visibility,
                state=resource_state,
                bbox=_parse_bbox(bbox),
                temporal_start=temporal_start,
                temporal_end=temporal_end,
                limit=limit,
                offset=offset,
            ),
        )
    )
    return [summary_response(record) for record in records]


@router.post(
    "/projects/{project_id}/resources",
    response_model=GovernedResourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_resource(
    project_id: UUID,
    payload: CreateResourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.create_resource(
            tenant_context(session),
            project_id,
            ResourceDraft(
                kind=payload.kind,
                slug=payload.slug,
                dataset_id=payload.dataset_id,
                map_id=payload.map_id,
                visibility=payload.visibility,
                state="draft",
                metadata=_metadata(payload.metadata),
                content=payload.content.model_dump(mode="json"),
                provenance=payload.provenance,
                expected_map_version=payload.expected_map_version,
            ),
            get_request_id(),
        )
    )
    return resource_response(record)


@router.get(
    "/projects/{project_id}/resources/{resource_id}",
    response_model=GovernedResourceResponse,
)
async def get_resource(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    return resource_response(
        await execute_resource(
            repository.get_resource(tenant_context(session), project_id, resource_id)
        )
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/capabilities",
    response_model=ResourceCapabilitiesResponse,
)
async def get_resource_capabilities(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceCapabilitiesResponse:
    capabilities = await execute_resource(
        repository.get_capabilities(tenant_context(session), project_id, resource_id)
    )
    return resource_capabilities_response(capabilities)


@router.put(
    "/projects/{project_id}/resources/{resource_id}",
    response_model=GovernedResourceResponse,
)
async def update_resource(
    project_id: UUID,
    resource_id: UUID,
    payload: UpdateResourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.update_resource(
            tenant_context(session),
            project_id,
            resource_id,
            ResourceUpdate(
                expected_version=payload.expected_version,
                visibility=payload.visibility,
                metadata=_metadata(payload.metadata),
                content=payload.content.model_dump(mode="json"),
                provenance=payload.provenance,
                change_message=payload.change_message,
                expected_map_version=payload.expected_map_version,
            ),
            get_request_id(),
        )
    )
    return resource_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/page-source-uploads",
    response_model=PageSourceUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def request_page_source_upload(
    project_id: UUID,
    resource_id: UUID,
    payload: RequestPageSourceUpload,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> PageSourceUploadResponse:
    ticket = await execute_resource(
        repository.request_page_source_upload(
            tenant_context(session),
            project_id,
            resource_id,
            PageSourceUploadDraft(
                expected_resource_version=payload.expected_version,
                source_block_id=payload.source_block_id,
                size_bytes=payload.size_bytes,
                checksum_sha256=payload.checksum_sha256,
            ),
            get_request_id(),
        )
    )
    return page_source_upload_response(ticket)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/page-draft",
    response_model=PageWorkingDraftResponse | None,
)
async def get_page_working_draft(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> PageWorkingDraftResponse | None:
    draft = await execute_resource(
        repository.get_page_working_draft(tenant_context(session), project_id, resource_id)
    )
    return None if draft is None else page_working_draft_response(draft)


@router.put(
    "/projects/{project_id}/resources/{resource_id}/page-draft",
    response_model=PageWorkingDraftResponse,
)
async def save_page_working_draft(
    project_id: UUID,
    resource_id: UUID,
    payload: PutPageWorkingDraftRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> PageWorkingDraftResponse:
    draft = await execute_resource(
        repository.save_page_working_draft(
            tenant_context(session),
            project_id,
            resource_id,
            PageWorkingDraftUpdate(
                expected_resource_version=payload.expected_resource_version,
                expected_draft_revision=payload.expected_draft_revision,
                visibility=payload.visibility,
                metadata=payload.metadata.model_dump(mode="json"),
                content=payload.content.model_dump(mode="json"),
                provenance=payload.provenance,
                source_block_id=payload.source_block_id,
                source_markdown=payload.source_markdown,
                change_summary=payload.change_summary,
            ),
        )
    )
    return page_working_draft_response(draft)


@router.delete(
    "/projects/{project_id}/resources/{resource_id}/page-draft",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def discard_page_working_draft(
    project_id: UUID,
    resource_id: UUID,
    expected_resource_version: Annotated[int, Query(ge=1)],
    expected_draft_revision: Annotated[int, Query(ge=1, le=512)],
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> Response:
    await execute_resource(
        repository.discard_page_working_draft(
            tenant_context(session),
            project_id,
            resource_id,
            expected_resource_version,
            expected_draft_revision,
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/page-versions",
    response_model=PageVersionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_page_version(
    project_id: UUID,
    resource_id: UUID,
    payload: CreatePageVersionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    site_repository: Annotated[SitePublicationRepository, Depends(site_repository_from_request)],
) -> PageVersionResponse:
    await _page_preview_context(
        context=tenant_context(session),
        project_id=project_id,
        resource_id=resource_id,
        expected_version=payload.expected_version,
        content=payload.content.model_dump(mode="json"),
        repository=repository,
        site_repository=site_repository,
    )
    record = await execute_resource(
        repository.create_page_version(
            tenant_context(session),
            project_id,
            resource_id,
            payload.upload_id,
            ResourceUpdate(
                expected_version=payload.expected_version,
                visibility=payload.visibility,
                metadata=_metadata(payload.metadata),
                content=payload.content.model_dump(mode="json"),
                provenance=payload.provenance,
                change_message=payload.change_message,
            ),
            get_request_id(),
        )
    )
    return page_version_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/page-versions/{version_number}/preview",
    response_model=PagePreviewResponse,
)
async def preview_page_version(
    project_id: UUID,
    resource_id: UUID,
    version_number: Annotated[int, Path(ge=1)],
    payload: PreviewPageVersionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    site_repository: Annotated[SitePublicationRepository, Depends(site_repository_from_request)],
) -> PagePreviewResponse:
    content = payload.content.model_dump(mode="json")
    page, references, assets, dependencies = await _page_preview_context(
        context=tenant_context(session),
        project_id=project_id,
        resource_id=resource_id,
        expected_version=version_number,
        content=content,
        repository=repository,
        site_repository=site_repository,
    )
    document = render_page_preview_html(
        resource_id=resource_id,
        title=payload.title,
        abstract=payload.abstract,
        kind=page.summary.kind,
        content=content,
        references=references,
        assets=assets,
    )
    return PagePreviewResponse(
        renderer_version=PAGE_RENDERER_VERSION,
        content_checksum_sha256=sha256(canonical_json_bytes(content)).hexdigest(),
        html=document.decode("utf-8"),
        dependencies=dependencies,
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/page-versions",
    response_model=list[PageSourceResponse],
)
async def list_page_versions(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> list[PageSourceResponse]:
    records = await execute_resource(
        repository.list_page_versions(tenant_context(session), project_id, resource_id)
    )
    return [page_source_response(record) for record in records]


@router.get(
    "/projects/{project_id}/resources/{resource_id}/page-source",
    response_model=PageSourceResponse,
)
async def get_current_page_source(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> PageSourceResponse:
    return page_source_response(
        await execute_resource(
            repository.get_page_source(
                tenant_context(session), project_id, resource_id, version_number=None
            )
        )
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/page-versions/{version_number}/source",
    response_model=PageSourceResponse,
)
async def get_page_version_source(
    project_id: UUID,
    resource_id: UUID,
    version_number: Annotated[int, Path(ge=1)],
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> PageSourceResponse:
    return page_source_response(
        await execute_resource(
            repository.get_page_source(
                tenant_context(session), project_id, resource_id, version_number
            )
        )
    )


@router.put(
    "/projects/{project_id}/resources/{resource_id}/binding",
    response_model=GovernedResourceResponse,
)
async def bind_resource(
    project_id: UUID,
    resource_id: UUID,
    payload: BindResourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.bind_resource(
            tenant_context(session),
            project_id,
            resource_id,
            payload.expected_version,
            payload.dataset_id,
            payload.map_id,
            get_request_id(),
        )
    )
    return resource_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/transitions",
    response_model=GovernedResourceResponse,
)
async def transition_resource(
    project_id: UUID,
    resource_id: UUID,
    payload: TransitionResourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.transition_resource(
            tenant_context(session),
            project_id,
            resource_id,
            payload.expected_version,
            payload.target_state,
            payload.visibility,
            payload.reason,
            get_request_id(),
        )
    )
    return resource_response(record)


@router.put(
    "/projects/{project_id}/resources/{resource_id}/publication-visibility",
    response_model=GovernedResourceResponse,
)
async def set_resource_publication_visibility(
    project_id: UUID,
    resource_id: UUID,
    response: Response,
    payload: PublicationVisibilityRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.set_publication_visibility(
            tenant_context(session),
            project_id,
            resource_id,
            payload.expected_version,
            payload.expected_visibility,
            payload.visibility,
            get_request_id(),
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return resource_response(record)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/permissions",
    response_model=list[ResourcePermissionResponse],
)
async def resource_permissions(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> list[ResourcePermissionResponse]:
    records = await execute_resource(
        repository.list_permissions(tenant_context(session), project_id, resource_id)
    )
    return [_permission_response(record) for record in records]


@router.put(
    "/projects/{project_id}/resources/{resource_id}/permissions/{user_id}",
    response_model=ResourcePermissionResponse,
)
async def put_resource_permission(
    project_id: UUID,
    resource_id: UUID,
    user_id: UUID,
    payload: PutResourcePermissionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourcePermissionResponse:
    record = await execute_resource(
        repository.put_permission(
            tenant_context(session),
            project_id,
            resource_id,
            ResourcePermissionGrant(user_id=user_id, role=payload.role),
            get_request_id(),
        )
    )
    return _permission_response(record)


@router.delete(
    "/projects/{project_id}/resources/{resource_id}/permissions/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_resource_permission(
    project_id: UUID,
    resource_id: UUID,
    user_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> Response:
    await execute_resource(
        repository.delete_permission(
            tenant_context(session), project_id, resource_id, user_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/styles",
    response_model=list[ResourceStyleResponse],
)
async def resource_styles(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    include_archived: bool = False,
) -> list[ResourceStyleResponse]:
    records = await execute_resource(
        repository.list_styles(
            tenant_context(session), project_id, resource_id, include_archived=include_archived
        )
    )
    return [_style_response(record) for record in records]


@router.get(
    "/projects/{project_id}/resources/{resource_id}/styles/{style_id}/versions/{version_number}",
    response_model=ResourceStyleResponse,
)
async def resource_style_version(
    project_id: UUID,
    resource_id: UUID,
    style_id: UUID,
    version_number: Annotated[int, Path(ge=1, le=9007199254740991)],
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceStyleResponse:
    record = await execute_resource(
        repository.get_style_version(
            tenant_context(session), project_id, resource_id, style_id, version_number
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return _style_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/styles",
    response_model=ResourceStyleResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_resource_style(
    project_id: UUID,
    resource_id: UUID,
    payload: CreateResourceStyleRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceStyleResponse:
    media_type = _style_media_type(payload.format)
    record = await execute_resource(
        repository.create_style(
            tenant_context(session),
            project_id,
            resource_id,
            ResourceStyleDraft(
                slug=payload.slug,
                format=payload.format,
                title=payload.title,
                media_type=media_type,
                definition=payload.definition,
                checksum_sha256=sha256(payload.definition.encode("utf-8")).hexdigest(),
            ),
            get_request_id(),
        )
    )
    return _style_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/styles/imports/mapserver",
    response_model=MapServerStyleImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_mapserver_style(
    project_id: UUID,
    resource_id: UUID,
    payload: ImportMapServerStyleRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> MapServerStyleImportResponse:
    try:
        converted = convert_mapserver_configuration(
            payload.mapfile,
            layer_name=payload.layer_name,
            mapscript=payload.mapscript,
        )
    except MapServerConfigurationUnsafe as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "mapserver_configuration_unsafe", "directive": error.directive},
        ) from error
    except MapServerConfigurationInvalid as error:
        raise HTTPException(status_code=422, detail={"code": str(error)}) from error
    record = await execute_resource(
        repository.create_style(
            tenant_context(session),
            project_id,
            resource_id,
            ResourceStyleDraft(
                slug=payload.slug,
                format="maplibre",
                title=payload.title,
                media_type=_style_media_type("maplibre"),
                definition=converted.style_definition,
                checksum_sha256=sha256(converted.style_definition.encode("utf-8")).hexdigest(),
            ),
            get_request_id(),
        )
    )
    return MapServerStyleImportResponse(
        style=_style_response(record),
        canonical_mapfile=converted.canonical_mapfile,
        report=converted.report,
        activation={
            "style_id": str(record.style_id),
            "geometry_layer_id": converted.geometry_layer_id,
            "label_layer_id": converted.label_layer_id,
            "minimum_scale_denominator": converted.minimum_scale_denominator,
            "maximum_scale_denominator": converted.maximum_scale_denominator,
            "include_legend": converted.include_legend,
        },
        request_limits=converted.request_limits,
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/styles/{style_id}/exports/mapserver",
    response_model=MapServerStyleExportResponse,
)
async def export_mapserver_style(
    project_id: UUID,
    resource_id: UUID,
    style_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> MapServerStyleExportResponse:
    records = await execute_resource(
        repository.list_styles(tenant_context(session), project_id, resource_id)
    )
    record = next((candidate for candidate in records if candidate.style_id == style_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="resource_style_not_found")
    try:
        mapfile, report = export_mapserver_configuration(record.definition)
    except MapServerConfigurationInvalid as error:
        raise HTTPException(status_code=409, detail={"code": str(error)}) from error
    return MapServerStyleExportResponse(
        style_id=record.style_id,
        filename=f"{record.slug}.map",
        mapfile=mapfile,
        report=report,
    )


@router.put(
    "/projects/{project_id}/resources/{resource_id}/styles/{style_id}",
    response_model=ResourceStyleResponse,
)
async def update_resource_style(
    project_id: UUID,
    resource_id: UUID,
    style_id: UUID,
    payload: UpdateResourceStyleRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceStyleResponse:
    record = await execute_resource(
        repository.update_style(
            tenant_context(session),
            project_id,
            resource_id,
            style_id,
            ResourceStyleUpdate(
                expected_version=payload.expected_version,
                format=payload.format,
                title=payload.title,
                media_type=_style_media_type(payload.format),
                definition=payload.definition,
                checksum_sha256=sha256(payload.definition.encode("utf-8")).hexdigest(),
                change_message=payload.change_message,
            ),
            get_request_id(),
        )
    )
    return _style_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/styles/{style_id}/archive",
    response_model=ResourceStyleResponse,
)
async def archive_resource_style(
    project_id: UUID,
    resource_id: UUID,
    style_id: UUID,
    payload: ResourceStyleArchiveRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceStyleResponse:
    return _style_response(await execute_resource(repository.set_style_archived(
        tenant_context(session), project_id, resource_id, style_id,
        payload.expected_version, True, get_request_id(),
    )))


@router.post(
    "/projects/{project_id}/resources/{resource_id}/styles/{style_id}/restore",
    response_model=ResourceStyleResponse,
)
async def restore_resource_style(
    project_id: UUID,
    resource_id: UUID,
    style_id: UUID,
    payload: ResourceStyleArchiveRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> ResourceStyleResponse:
    return _style_response(await execute_resource(repository.set_style_archived(
        tenant_context(session), project_id, resource_id, style_id,
        payload.expected_version, False, get_request_id(),
    )))


@router.get(
    "/projects/{project_id}/resources/{resource_id}/workflow",
    response_model=list[ResourceWorkflowEventResponse],
)
async def resource_workflow(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> list[ResourceWorkflowEventResponse]:
    records = await execute_resource(
        repository.list_workflow_events(tenant_context(session), project_id, resource_id)
    )
    return [_workflow_response(record) for record in records]


@router.post(
    "/projects/{project_id}/resources/{resource_id}/relationships",
    response_model=GovernedResourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_relationship(
    project_id: UUID,
    resource_id: UUID,
    payload: CreateRelationshipRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GovernedResourceResponse:
    record = await execute_resource(
        repository.add_relationship(
            tenant_context(session),
            project_id,
            resource_id,
            payload.target_resource_id,
            payload.relation,
            get_request_id(),
        )
    )
    return resource_response(record)


@router.post(
    "/projects/{project_id}/resources/imports/geonode",
    response_model=GeoNodeImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_geonode(
    project_id: UUID,
    payload: GeoNodeImportRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GeoNodeImportResponse:
    try:
        plan = build_geonode_import_plan(
            source_url=payload.source_url,
            resources=tuple(
                resource.model_dump(mode="python", exclude_none=False)
                for resource in payload.resources
            ),
            relationships=tuple(
                relationship.model_dump(mode="python") for relationship in payload.relationships
            ),
        )
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="invalid_geonode_import") from error
    result = await execute_resource(
        repository.import_resources(tenant_context(session), project_id, plan, get_request_id())
    )
    return GeoNodeImportResponse(
        idempotent=result.idempotent,
        resources=[resource_response(resource) for resource in result.resources],
        report=result.report,
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/export/geonode",
    response_model=GeoNodeExportResponse,
)
async def export_geonode(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> GeoNodeExportResponse:
    record = await execute_resource(
        repository.get_resource(tenant_context(session), project_id, resource_id)
    )
    export = export_geonode_resource(record)
    return GeoNodeExportResponse(resource=export["resource"], report=export["report"])


def summary_response(record: ResourceSummary) -> ResourceSummaryResponse:
    return ResourceSummaryResponse(
        id=record.resource_id,
        project_id=record.project_id,
        kind=record.kind,
        slug=record.slug,
        dataset_id=record.dataset_id,
        map_id=record.map_id,
        visibility=record.visibility,
        state=record.state,
        version_number=record.version_number,
        title=record.title,
        abstract=record.abstract,
        language=record.language,
        license=record.license,
        attribution=record.attribution,
        keywords=list(record.keywords),
        spatial_extent=list(record.spatial_extent) if record.spatial_extent else None,
        temporal_start=record.temporal_start,
        temporal_end=record.temporal_end,
        owner_user_id=record.owner_user_id,
        origin_namespace=record.origin_namespace,
        origin_identifier=record.origin_identifier,
        relationship_count=record.relationship_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def resource_response(record: GovernedResource) -> GovernedResourceResponse:
    summary = summary_response(record.summary).model_dump()
    return GovernedResourceResponse(
        **summary,
        metadata_profile=record.metadata_profile,
        metadata_extensions=record.metadata_extensions,
        translations=record.translations,
        current_version_id=record.current_version_id,
        content=record.content,
        provenance=record.provenance,
        change_message=record.change_message,
        version_created_by=record.version_created_by,
        version_created_at=record.version_created_at,
        external_identifiers=[
            ExternalIdentifierResponse(
                namespace=item.namespace,
                identifier=item.identifier,
                source_url=item.source_url,
                source_version=item.source_version,
                source_payload_sha256=item.source_payload_sha256,
                imported_at=item.imported_at,
            )
            for item in record.external_identifiers
        ],
        relationships=[
            RelationshipResponse(
                id=item.relationship_id,
                source_resource_id=item.source_resource_id,
                target_resource_id=item.target_resource_id,
                relation=item.relation,
                created_by=item.created_by,
                created_at=item.created_at,
            )
            for item in record.relationships
        ],
        managed_metadata_profile_id=record.managed_metadata_profile_id,
        managed_metadata_profile_version=record.managed_metadata_profile_version,
        metadata_validation=record.metadata_validation,
        map_snapshot=MapResourceSnapshotResponse(
            map_id=record.map_snapshot.map_id,
            map_version_id=record.map_snapshot.map_version_id,
            map_version=record.map_snapshot.map_version,
            definition_checksum_sha256=record.map_snapshot.definition_checksum_sha256,
        )
        if record.map_snapshot is not None
        else None,
    )


def resource_capabilities_response(
    record: ResourceCapabilities,
) -> ResourceCapabilitiesResponse:
    return ResourceCapabilitiesResponse(
        can_read=record.can_read,
        can_update=record.can_update,
        can_publish=record.can_publish,
        can_manage_permissions=record.can_manage_permissions,
    )


def page_source_upload_response(record: PageSourceUploadTicket) -> PageSourceUploadResponse:
    return PageSourceUploadResponse(
        upload_id=record.upload_id,
        resource_id=record.resource_id,
        expected_resource_version=record.expected_resource_version,
        source_block_id=record.source_block_id,
        expires_at=record.upload.expires_at,
        upload=PageSourceUploadInstructionsResponse(
            url=record.upload.url,
            method="POST",
            fields=dict(record.upload.fields),
        ),
    )


def page_working_draft_response(record: PageWorkingDraft) -> PageWorkingDraftResponse:
    return PageWorkingDraftResponse(
        id=record.draft_id,
        resource_id=record.resource_id,
        owner_user_id=record.owner_user_id,
        base_resource_version=record.base_resource_version,
        revision_number=record.revision_number,
        visibility=record.visibility,
        metadata=record.metadata,
        content=record.content,
        provenance=record.provenance,
        source_block_id=record.source_block_id,
        source_markdown=record.source_markdown,
        change_summary=record.change_summary,
        document_checksum_sha256=record.document_checksum_sha256,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def page_source_response(record: PageSource) -> PageSourceResponse:
    return PageSourceResponse(
        id=record.source_id,
        resource_id=record.resource_id,
        resource_version_id=record.resource_version_id,
        resource_version_number=record.resource_version_number,
        parent_version_number=record.parent_version_number,
        source_block_id=record.source_block_id,
        bucket=record.bucket,
        object_key=record.object_key,
        s3_version_id=record.s3_version_id,
        etag=record.etag,
        content_type="text/markdown",
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
        dialect="opengeo-markdown",
        dialect_version=record.dialect_version,
        compiler_version=record.compiler_version,
        change_summary=record.change_summary,
        created_by=record.created_by,
        created_at=record.created_at,
        source_markdown=record.source_markdown,
    )


def page_version_response(record: PageVersion) -> PageVersionResponse:
    return PageVersionResponse(
        resource=resource_response(record.resource),
        source=page_source_response(record.source),
    )


def _permission_response(record: ResourcePermission) -> ResourcePermissionResponse:
    return ResourcePermissionResponse(
        user_id=record.user_id,
        email=record.email,
        display_name=record.display_name,
        role=record.role,
        granted_by=record.granted_by,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _style_response(record: ResourceStyle) -> ResourceStyleResponse:
    return ResourceStyleResponse(
        id=record.style_id,
        resource_id=record.resource_id,
        slug=record.slug,
        format=record.format,
        version_number=record.version_number,
        title=record.title,
        media_type=record.media_type,
        definition=record.definition,
        checksum_sha256=record.checksum_sha256,
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at,
        updated_at=record.updated_at,
        archived=record.archived,
    )


def _workflow_response(record: ResourceWorkflowEvent) -> ResourceWorkflowEventResponse:
    return ResourceWorkflowEventResponse(
        id=record.event_id,
        source_state=record.source_state,
        target_state=record.target_state,
        reason=record.reason,
        actor_user_id=record.actor_user_id,
        created_at=record.created_at,
    )


def _metadata(value: ResourceMetadataRequest) -> ResourceMetadata:
    extent = (
        cast(tuple[float, float, float, float], tuple(value.spatial_extent))
        if value.spatial_extent is not None
        else None
    )
    return ResourceMetadata(
        title=value.title,
        abstract=value.abstract,
        language=value.language,
        license=value.license,
        attribution=value.attribution,
        keywords=tuple(value.keywords),
        spatial_extent=extent,
        temporal_start=value.temporal_start,
        temporal_end=value.temporal_end,
        profile=value.profile,
        extensions=value.extensions,
        translations={
            language: translation.model_dump(mode="json")
            for language, translation in value.translations.items()
        },
        managed_profile_id=value.managed_profile_id,
        managed_profile_version=value.managed_profile_version,
    )


def _parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    try:
        coordinates = [float(item.strip()) for item in value.split(",")]
    except ValueError as error:
        raise HTTPException(status_code=422, detail="invalid_bbox") from error
    try:
        parsed = ResourceMetadataRequest.validate_extent(coordinates)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="invalid_bbox") from error
    if parsed is None:
        raise HTTPException(status_code=422, detail="invalid_bbox")
    return cast(tuple[float, float, float, float], tuple(parsed))


def _style_media_type(format_value: ResourceStyleFormat) -> str:
    return {
        "maplibre": "application/vnd.mapbox.style+json",
        "geostyler": "application/vnd.geostyler+json",
        "sld_1_0": "application/vnd.ogc.sld+xml",
        "sld_1_1": "application/vnd.ogc.se+xml",
        "mapserver_mapfile": "text/vnd.mapserver.mapfile",
    }[format_value]


def _validate_style_definition(format_value: ResourceStyleFormat, definition: str) -> None:
    encoded = definition.encode("utf-8")
    if not 2 <= len(encoded) <= 49_152 or "\x00" in definition:
        raise ValueError("style definition has an invalid size or null byte")
    if format_value in {"maplibre", "geostyler"}:
        try:
            parsed = json.loads(definition)
        except (TypeError, ValueError) as error:
            raise ValueError("JSON style definition is invalid") from error
        if not isinstance(parsed, dict):
            raise ValueError("JSON style definition must be an object")
        assert_safe_geonode_tree(parsed, maximum_nodes=10_000)
        return
    if format_value in {"sld_1_0", "sld_1_1"}:
        lowered = definition.casefold()
        if any(marker in lowered for marker in ("<!doctype", "<!entity", "xinclude")):
            raise ValueError("SLD declarations and external inclusion are not allowed")
        try:
            root = ElementTree.fromstring(definition)
        except ElementTree.ParseError as error:
            raise ValueError("SLD XML is invalid") from error
        if root.tag != "{http://www.opengis.net/sld}StyledLayerDescriptor":
            raise ValueError("SLD root must be StyledLayerDescriptor")
        expected = "1.0.0" if format_value == "sld_1_0" else "1.1.0"
        if root.attrib.get("version") != expected:
            raise ValueError(f"{format_value} requires version {expected}")
        stack = [(root, 1)]
        element_count = 0
        attribute_count = 0
        while stack:
            element, depth = stack.pop()
            element_count += 1
            attribute_count += len(element.attrib)
            if element_count > 2_000 or attribute_count > 4_000 or depth > 32:
                raise ValueError("SLD XML exceeds its structural limits")
            stack.extend((child, depth + 1) for child in element)
        return
    forbidden = re.compile(
        r"(?im)^\s*(?:CONFIG|CONNECTION|CONNECTIONTYPE|DATA|FONTSET|INCLUDE|"
        r"PLUGIN|PROCESSING|SHAPEPATH|SYMBOLSET|TEMPLATE)\b"
    )
    if forbidden.search(definition):
        raise ValueError("detached MapServer styles cannot reference data, files, or plugins")
    normalized = definition.strip().upper()
    if not normalized.startswith("MAP") or "\n  STYLE" not in normalized:
        raise ValueError("MapServer style must be a detached MAP document containing STYLE")


def _bounded_json(value: Any, maximum_bytes: int, label: str) -> None:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite JSON") from error
    if len(encoded) > maximum_bytes:
        raise ValueError(f"{label} exceeds {maximum_bytes} bytes")
