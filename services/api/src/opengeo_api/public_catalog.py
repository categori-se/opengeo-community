import asyncio
import json
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, cast
from uuid import UUID

from opengeo_api.document_previews import (
    DOCUMENT_PREVIEW_SCHEMA,
    MAX_DOCUMENT_PREVIEW_BYTES,
    MAX_PDF_VISUAL_PRESENTATION_BYTES,
    PDF_VISUAL_PRESENTATION_SCHEMAS,
    DocumentPreviewInvalid,
    parse_document_preview,
)
from opengeo_api.map_definitions import validate_map_definition
from opengeo_api.page_renderer_contract import PAGE_RENDERER_VERSION
from opengeo_api.resources import ResourceKind
from opengeo_api.s3_downloads import (
    DownloadStorage,
    DownloadStorageUnavailable,
    ExactObjectSpec,
    UnavailableDownloadStorage,
)
from opengeo_api.site_export import render_page_preview_html
from opengeo_api.spatial_previews import (
    MAX_SPATIAL_PREVIEW_BYTES,
    SpatialPreviewInvalid,
    parse_spatial_preview,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE = 10_000
MAX_PUBLIC_DOCUMENT_CONTENT_BYTES = 16 * 1024
MAX_PUBLIC_DOCUMENT_PREVIEW_BYTES = 256 * 1024
MAX_PUBLIC_MAP_LAYERS = 64
MAX_PUBLIC_MAP_LAYER_PREVIEW_BYTES = 512 * 1024
MAX_PUBLIC_MAP_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_PUBLIC_MAP_PREVIEW_FEATURES = 50_000
_ANONYMOUS_DATABASE_USER_ID = UUID(int=0)


class PublicCatalogStoreUnavailable(RuntimeError):
    pass


class PublicCatalogPreviewConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class PublicCatalogFilters:
    query: str | None = None
    kind: ResourceKind | None = None
    project_id: UUID | None = None
    keyword: str | None = None
    license: str | None = None
    origin_namespace: str | None = None
    bbox: tuple[float, float, float, float] | None = None
    temporal_start: datetime | None = None
    temporal_end: datetime | None = None
    limit: int = 24
    offset: int = 0


@dataclass(frozen=True, slots=True)
class PublicCatalogRecord:
    resource_id: UUID
    organization_id: UUID
    organization_slug: str
    organization_name: str
    project_id: UUID
    project_name: str
    kind: ResourceKind
    slug: str
    version_number: int
    title: str
    abstract: str | None
    language: str
    license: str | None
    attribution: str | None
    keywords: tuple[str, ...]
    spatial_extent: tuple[float, float, float, float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None
    origin_namespace: str | None
    origin_identifier: str | None
    origin_version: str | None
    origin_observed_at: datetime | None
    public_relationship_count: int
    rating_count: int
    rating_average: float | None
    preview_kind: Literal["map", "dataset", "dataset-document", "document", "metadata"]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class PublicCatalogFacet:
    value: str
    label: str
    count: int


@dataclass(frozen=True, slots=True)
class PublicCatalogPage:
    records: tuple[PublicCatalogRecord, ...]
    number_matched: int
    facets: dict[str, tuple[PublicCatalogFacet, ...]]
    facet_sample_size: int
    facets_truncated: bool


@dataclass(frozen=True, slots=True)
class PublicSpatialPreviewTarget:
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    dataset_version_id: UUID
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    feature_count: int | None


@dataclass(frozen=True, slots=True)
class PublicSpatialPreview:
    resource_id: UUID
    resource_version_number: int
    number_returned: int
    number_matched: int | None
    may_be_truncated: bool
    geojson: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PublicDocumentPreview:
    resource_id: UUID
    resource_version_number: int
    resource_kind: Literal["document", "story", "dashboard"]
    renderer_version: str
    dependency_references_omitted: int
    html: str


@dataclass(frozen=True, slots=True)
class PublicDatasetDocumentPreviewTarget:
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    dataset_version_id: UUID
    dataset_version_number: int
    source_format: Literal["pdf", "odt"]
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class PublicDatasetDocumentPreview:
    resource_id: UUID
    resource_version_number: int
    dataset_version_number: int
    source_format: Literal["pdf", "odt"]
    presentation_kind: Literal["semantic", "visual"]
    presentation: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PublicMapLayerTarget:
    layer_id: str
    title: str
    visible: bool
    opacity: float
    order: int
    style: dict[str, Any]
    labels: dict[str, Any]
    dataset_id: UUID
    dataset_version_id: UUID
    dataset_version_number: int
    resource_version_id: UUID
    resource_version_number: int
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    feature_count: int | None


@dataclass(frozen=True, slots=True)
class PublicMapPreviewTarget:
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    map_id: UUID
    map_version: int
    bound_map_version: int | None
    projection: Literal["mercator", "globe"]
    color_mode: Literal["light", "dark"]
    layers: tuple[PublicMapLayerTarget, ...]


@dataclass(frozen=True, slots=True)
class PublicMapPreviewLayer:
    layer_id: str
    title: str
    visible: bool
    opacity: float
    order: int
    style: dict[str, Any]
    labels: dict[str, Any]
    number_returned: int
    number_matched: int | None
    may_be_truncated: bool
    geojson: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PublicMapPreview:
    resource_id: UUID
    resource_version_number: int
    map_version: int
    projection: Literal["mercator", "globe"]
    color_mode: Literal["light", "dark"]
    layers: tuple[PublicMapPreviewLayer, ...]


class PublicCatalogRepository(Protocol):
    async def list_public_resources(
        self,
        organization_id: UUID,
        filters: PublicCatalogFilters,
    ) -> PublicCatalogPage: ...

    async def get_public_resource(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicCatalogRecord | None: ...

    async def get_public_spatial_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicSpatialPreview | None: ...

    async def get_public_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDocumentPreview | None: ...

    async def get_public_dataset_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDatasetDocumentPreview | None: ...

    async def get_public_map_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicMapPreview | None: ...


class PostgresPublicCatalogRepository:
    """Read a fail-closed anonymous projection inside one organization RLS scope."""

    def __init__(
        self,
        executor: TenantTransactionExecutor,
        storage: DownloadStorage | None = None,
    ) -> None:
        self._executor = executor
        self._storage = storage or UnavailableDownloadStorage()

    async def _run(
        self,
        organization_id: UUID,
        operation: Callable[[TenantTransaction], Awaitable[Any]],
    ) -> Any:
        try:
            return await self._executor.run(
                TenantContext(
                    user_id=_ANONYMOUS_DATABASE_USER_ID,
                    organization_id=organization_id,
                ),
                operation,
            )
        except TenantDatabaseUnavailable as error:
            raise PublicCatalogStoreUnavailable("public catalog operation failed") from error

    async def list_public_resources(
        self,
        organization_id: UUID,
        filters: PublicCatalogFilters,
    ) -> PublicCatalogPage:
        where, parameters = self._filters(organization_id, filters)

        async def operation(transaction: TenantTransaction) -> PublicCatalogPage:
            count_row = await transaction.fetch_one(
                f"""
                SELECT count(*)::bigint
                {self._from_clause()}
                WHERE {where}
                """,
                parameters,
            )
            number_matched = cast(int, count_row[0]) if count_row is not None else 0
            rows = await transaction.fetch_all(
                f"""
                {self._record_select()}
                WHERE {where}
                ORDER BY lower(version.title), resource.id
                LIMIT %s OFFSET %s
                """,
                (*parameters, filters.limit, filters.offset),
            )
            facet_rows = await transaction.fetch_all(
                f"""
                SELECT resource.kind::text, resource.project_id, project.name,
                       version.license, version.keywords,
                       origin.namespace
                {self._from_clause()}
                WHERE {where}
                ORDER BY resource.id
                LIMIT %s
                """,
                (*parameters, PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE + 1),
            )
            bounded_facets = facet_rows[:PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE]
            return PublicCatalogPage(
                records=tuple(self._record(row) for row in rows),
                number_matched=number_matched,
                facets=self._facets(bounded_facets),
                facet_sample_size=len(bounded_facets),
                facets_truncated=len(facet_rows) > PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE,
            )

        return cast(PublicCatalogPage, await self._run(organization_id, operation))

    async def get_public_resource(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicCatalogRecord | None:
        async def operation(transaction: TenantTransaction) -> PublicCatalogRecord | None:
            row = await transaction.fetch_one(
                f"""
                {self._record_select()}
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                  AND resource.state = 'published'
                  AND resource.visibility = 'public'
                """,
                (organization_id, project_id, resource_id),
            )
            return self._record(row) if row is not None else None

        return cast(
            PublicCatalogRecord | None,
            await self._run(organization_id, operation),
        )

    async def get_public_spatial_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicSpatialPreview | None:
        async def resolve(
            transaction: TenantTransaction,
        ) -> PublicSpatialPreviewTarget | None:
            return await self._public_spatial_preview_target(
                transaction,
                organization_id,
                project_id,
                resource_id,
            )

        target = cast(
            PublicSpatialPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if target is None:
            return None
        try:
            exact = await self._storage.read_exact_object(
                ExactObjectSpec(
                    bucket=target.bucket,
                    key=target.key,
                    version_id=target.s3_version_id,
                    content_type=target.content_type,
                    size_bytes=target.size_bytes,
                    checksum_sha256=target.checksum_sha256,
                    maximum_bytes=MAX_SPATIAL_PREVIEW_BYTES,
                )
            )
        except DownloadStorageUnavailable as error:
            raise PublicCatalogStoreUnavailable("public preview storage unavailable") from error
        checked = cast(
            PublicSpatialPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if checked != target:
            raise PublicCatalogPreviewConflict("public_spatial_preview_target_changed")
        try:
            geojson = parse_spatial_preview(exact.body)
        except SpatialPreviewInvalid as error:
            raise PublicCatalogPreviewConflict("public_spatial_preview_invalid") from error
        number_returned = len(cast(list[object], geojson["features"]))
        if target.feature_count is not None and number_returned > target.feature_count:
            raise PublicCatalogPreviewConflict("public_spatial_preview_invalid")
        return PublicSpatialPreview(
            resource_id=resource_id,
            resource_version_number=target.resource_version_number,
            number_returned=number_returned,
            number_matched=target.feature_count,
            may_be_truncated=(
                target.feature_count is None or number_returned < target.feature_count
            ),
            geojson=geojson,
        )

    async def get_public_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDocumentPreview | None:
        async def operation(
            transaction: TenantTransaction,
        ) -> PublicDocumentPreview | None:
            row = await transaction.fetch_one(
                """
                SELECT version.version_number, resource.kind::text,
                       version.title, version.abstract, version.content
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                  AND resource.state = 'published'
                  AND resource.visibility = 'public'
                  AND resource.kind IN ('document', 'story', 'dashboard')
                """,
                (organization_id, project_id, resource_id),
            )
            if row is None:
                return None
            content = row[4]
            if not isinstance(content, dict):
                raise PublicCatalogPreviewConflict("public_document_preview_invalid")
            encoded_content = json.dumps(
                content,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            if len(encoded_content) > MAX_PUBLIC_DOCUMENT_CONTENT_BYTES:
                raise PublicCatalogPreviewConflict("public_document_preview_invalid")
            blocks = content.get("blocks")
            if not isinstance(blocks, list) or len(blocks) > 24:
                raise PublicCatalogPreviewConflict("public_document_preview_invalid")
            omitted = sum(
                1
                for block in blocks
                if isinstance(block, dict)
                and block.get("type") in {"map", "dataset", "image", "file", "document"}
            )
            kind = cast(Literal["document", "story", "dashboard"], row[1])
            html_bytes = render_page_preview_html(
                resource_id=resource_id,
                title=cast(str, row[2]),
                abstract=cast(str | None, row[3]),
                kind=kind,
                content=content,
                references={},
                assets={},
            )
            if len(html_bytes) > MAX_PUBLIC_DOCUMENT_PREVIEW_BYTES:
                raise PublicCatalogPreviewConflict("public_document_preview_invalid")
            return PublicDocumentPreview(
                resource_id=resource_id,
                resource_version_number=cast(int, row[0]),
                resource_kind=kind,
                renderer_version=PAGE_RENDERER_VERSION,
                dependency_references_omitted=omitted,
                html=html_bytes.decode("utf-8"),
            )

        return cast(
            PublicDocumentPreview | None,
            await self._run(organization_id, operation),
        )

    async def get_public_dataset_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDatasetDocumentPreview | None:
        async def resolve(
            transaction: TenantTransaction,
        ) -> PublicDatasetDocumentPreviewTarget | None:
            return await self._public_dataset_document_preview_target(
                transaction,
                organization_id,
                project_id,
                resource_id,
            )

        target = cast(
            PublicDatasetDocumentPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if target is None:
            return None
        try:
            exact = await self._storage.read_exact_object(
                ExactObjectSpec(
                    bucket=target.bucket,
                    key=target.key,
                    version_id=target.s3_version_id,
                    content_type=target.content_type,
                    size_bytes=target.size_bytes,
                    checksum_sha256=target.checksum_sha256,
                    maximum_bytes=(
                        MAX_PDF_VISUAL_PRESENTATION_BYTES
                        if target.key.endswith("/document/visual-presentation.json")
                        else MAX_DOCUMENT_PREVIEW_BYTES
                    ),
                )
            )
        except DownloadStorageUnavailable as error:
            raise PublicCatalogStoreUnavailable("public preview storage unavailable") from error
        checked = cast(
            PublicDatasetDocumentPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if checked != target:
            raise PublicCatalogPreviewConflict("public_dataset_document_preview_target_changed")
        try:
            presentation = parse_document_preview(exact.body)
        except DocumentPreviewInvalid as error:
            raise PublicCatalogPreviewConflict("public_dataset_document_preview_invalid") from error
        if presentation.get("sourceFormat") != target.source_format:
            raise PublicCatalogPreviewConflict("public_dataset_document_preview_invalid")
        return PublicDatasetDocumentPreview(
            resource_id=target.resource_id,
            resource_version_number=target.resource_version_number,
            dataset_version_number=target.dataset_version_number,
            source_format=target.source_format,
            presentation_kind=(
                "visual"
                if presentation.get("schemaVersion") in PDF_VISUAL_PRESENTATION_SCHEMAS
                else "semantic"
            ),
            presentation=presentation,
        )

    async def get_public_map_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicMapPreview | None:
        async def resolve(
            transaction: TenantTransaction,
        ) -> PublicMapPreviewTarget | None:
            return await self._public_map_preview_target(
                transaction,
                organization_id,
                project_id,
                resource_id,
            )

        target = cast(
            PublicMapPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if target is None:
            return None
        if sum(layer.size_bytes for layer in target.layers) > MAX_PUBLIC_MAP_PREVIEW_BYTES:
            raise PublicCatalogPreviewConflict("public_map_preview_too_large")
        try:
            objects = await asyncio.gather(
                *(
                    self._storage.read_exact_object(
                        ExactObjectSpec(
                            bucket=layer.bucket,
                            key=layer.key,
                            version_id=layer.s3_version_id,
                            content_type=layer.content_type,
                            size_bytes=layer.size_bytes,
                            checksum_sha256=layer.checksum_sha256,
                            maximum_bytes=MAX_PUBLIC_MAP_LAYER_PREVIEW_BYTES,
                        )
                    )
                    for layer in target.layers
                )
            )
        except DownloadStorageUnavailable as error:
            raise PublicCatalogStoreUnavailable("public preview storage unavailable") from error
        checked = cast(
            PublicMapPreviewTarget | None,
            await self._run(organization_id, resolve),
        )
        if checked != target:
            raise PublicCatalogPreviewConflict("public_map_preview_target_changed")
        layers: list[PublicMapPreviewLayer] = []
        total_features = 0
        for layer, exact in zip(target.layers, objects, strict=True):
            try:
                geojson = parse_spatial_preview(exact.body)
            except SpatialPreviewInvalid as error:
                raise PublicCatalogPreviewConflict("public_map_preview_invalid") from error
            number_returned = len(cast(list[object], geojson["features"]))
            total_features += number_returned
            if total_features > MAX_PUBLIC_MAP_PREVIEW_FEATURES or (
                layer.feature_count is not None and number_returned > layer.feature_count
            ):
                raise PublicCatalogPreviewConflict("public_map_preview_invalid")
            layers.append(
                PublicMapPreviewLayer(
                    layer_id=layer.layer_id,
                    title=layer.title,
                    visible=layer.visible,
                    opacity=layer.opacity,
                    order=layer.order,
                    style=layer.style,
                    labels=layer.labels,
                    number_returned=number_returned,
                    number_matched=layer.feature_count,
                    may_be_truncated=(
                        layer.feature_count is None or number_returned < layer.feature_count
                    ),
                    geojson=geojson,
                )
            )
        return PublicMapPreview(
            resource_id=target.resource_id,
            resource_version_number=target.resource_version_number,
            map_version=target.map_version,
            projection=target.projection,
            color_mode=target.color_mode,
            layers=tuple(layers),
        )

    @classmethod
    async def _public_map_preview_target(
        cls,
        transaction: TenantTransaction,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicMapPreviewTarget | None:
        resource_row = await transaction.fetch_one(
            """
            SELECT resource.current_version_id, version.version_number,
                   resource.map_id, version.provenance,
                   binding.map_version, binding.map_id
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
             AND version.id = resource.current_version_id
            LEFT JOIN app.map_resource_version_bindings binding
              ON binding.organization_id = resource.organization_id
             AND binding.project_id = resource.project_id
             AND binding.resource_id = resource.id
             AND binding.resource_version_id = resource.current_version_id
            WHERE resource.organization_id = %s
              AND resource.project_id = %s
              AND resource.id = %s
              AND resource.state = 'published'
              AND resource.visibility = 'public'
              AND resource.kind = 'map'
              AND resource.map_id IS NOT NULL
            """,
            (organization_id, project_id, resource_id),
        )
        if resource_row is None:
            return None
        map_id = cast(UUID, resource_row[2])
        bound_map_version = resource_row[4]
        if bound_map_version is not None or resource_row[5] is not None:
            pinned_map_id = resource_row[5]
            map_version = bound_map_version
        else:
            # Preserve already published legacy previews without inventing a binding.
            # Once an exact binding exists, authored provenance is never authoritative.
            provenance = resource_row[3]
            if not isinstance(provenance, dict):
                raise PublicCatalogPreviewConflict("public_map_preview_not_sealed")
            try:
                pinned_map_id = UUID(str(provenance["mapId"]))
                map_version = provenance["mapVersion"]
            except (KeyError, TypeError, ValueError, AttributeError) as error:
                raise PublicCatalogPreviewConflict("public_map_preview_not_sealed") from error
        if (
            pinned_map_id != map_id
            or isinstance(map_version, bool)
            or not isinstance(map_version, int)
            or map_version < 1
        ):
            raise PublicCatalogPreviewConflict("public_map_preview_not_sealed")
        map_row = await transaction.fetch_one(
            """
            SELECT version.definition
            FROM app.maps map
            JOIN app.map_versions version
              ON version.organization_id = map.organization_id
             AND version.map_id = map.id
             AND version.version = %s
            WHERE map.organization_id = %s
              AND map.project_id = %s
              AND map.id = %s
              AND map.status = 'active'
            """,
            (map_version, organization_id, project_id, map_id),
        )
        if map_row is None or not isinstance(map_row[0], dict):
            raise PublicCatalogPreviewConflict("public_map_preview_not_sealed")
        definition = cast(dict[str, Any], map_row[0])
        try:
            validate_map_definition(definition, require_current=True)
        except ValueError as error:
            raise PublicCatalogPreviewConflict("public_map_preview_invalid") from error
        raw_layers = definition.get("layers")
        if not isinstance(raw_layers, list) or len(raw_layers) > MAX_PUBLIC_MAP_LAYERS:
            raise PublicCatalogPreviewConflict("public_map_preview_layer_limit_exceeded")
        if any(isinstance(layer, dict) and "styleReference" in layer for layer in raw_layers):
            raise PublicCatalogPreviewConflict("public_map_preview_style_resolution_required")
        layer_references: list[tuple[UUID, UUID, int]] = []
        for layer in raw_layers:
            if not isinstance(layer, dict) or layer.get("sourceType") != "governed-dataset":
                raise PublicCatalogPreviewConflict("public_map_preview_dependency_not_public")
            try:
                dataset_id = UUID(str(layer["datasetId"]))
                dataset_version_id = UUID(str(layer["datasetVersionId"]))
                dataset_version_number = layer["sourceVersion"]
            except (KeyError, TypeError, ValueError, AttributeError) as error:
                raise PublicCatalogPreviewConflict("public_map_preview_not_sealed") from error
            if (
                isinstance(dataset_version_number, bool)
                or not isinstance(dataset_version_number, int)
                or dataset_version_number < 1
            ):
                raise PublicCatalogPreviewConflict("public_map_preview_not_sealed")
            layer_references.append((dataset_id, dataset_version_id, dataset_version_number))
        unique_references = tuple(dict.fromkeys(layer_references))
        rows = []
        if unique_references:
            rows = await transaction.fetch_all(
                """
                SELECT resource.dataset_id, resource.current_version_id,
                       resource_version.version_number, resource_version.provenance,
                       dataset_version.id, dataset_version.version_number,
                       dataset_version.feature_count, object.id, object.bucket,
                       object.object_key, object.s3_version_id, object.content_type,
                       object.size_bytes, object.checksum_sha256
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions resource_version
                  ON resource_version.organization_id = resource.organization_id
                 AND resource_version.resource_id = resource.id
                 AND resource_version.id = resource.current_version_id
                JOIN app.datasets dataset
                  ON dataset.organization_id = resource.organization_id
                 AND dataset.id = resource.dataset_id
                JOIN app.dataset_versions dataset_version
                  ON dataset_version.organization_id = dataset.organization_id
                 AND dataset_version.dataset_id = dataset.id
                 AND dataset_version.id = ANY(%s::uuid[])
                JOIN app.dataset_version_objects link
                  ON link.organization_id = dataset_version.organization_id
                 AND link.dataset_id = dataset_version.dataset_id
                 AND link.dataset_version_id = dataset_version.id
                JOIN app.data_objects object
                  ON object.organization_id = link.organization_id
                 AND object.id = link.data_object_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.kind = 'dataset'
                  AND resource.state = 'published'
                  AND resource.visibility = 'public'
                  AND resource.dataset_id = ANY(%s::uuid[])
                  AND dataset.status = 'active'
                  AND dataset_version.state = 'active'
                  AND object.role = 'derived'
                  AND object.content_type = 'application/geo+json'
                  AND object.object_key LIKE '%%/preview/preview.geojson'
                  AND object.size_bytes BETWEEN 1 AND %s
                ORDER BY resource.dataset_id, dataset_version.id, object.id
                """,
                (
                    [reference[1] for reference in unique_references],
                    organization_id,
                    project_id,
                    [reference[0] for reference in unique_references],
                    MAX_PUBLIC_MAP_LAYER_PREVIEW_BYTES,
                ),
            )
        resolved: dict[tuple[UUID, UUID, int], tuple[Any, ...]] = {}
        for row in rows:
            dataset_id = cast(UUID, row[0])
            dataset_version_id = cast(UUID, row[4])
            dataset_version_number = cast(int, row[5])
            key = (dataset_id, dataset_version_id, dataset_version_number)
            dependency_provenance = row[3]
            if (
                key not in unique_references
                or key in resolved
                or not isinstance(dependency_provenance, dict)
                or str(dependency_provenance.get("datasetId", dataset_id)) != str(dataset_id)
                or str(dependency_provenance.get("datasetVersionId")) != str(dataset_version_id)
            ):
                raise PublicCatalogPreviewConflict("public_map_preview_dependency_not_public")
            resolved[key] = row
        if set(resolved) != set(unique_references):
            raise PublicCatalogPreviewConflict("public_map_preview_dependency_not_public")
        layers: list[PublicMapLayerTarget] = []
        for layer, reference in zip(raw_layers, layer_references, strict=True):
            row = resolved[reference]
            layers.append(
                PublicMapLayerTarget(
                    layer_id=cast(str, layer["layerId"]),
                    title=cast(str, layer["title"]),
                    visible=cast(bool, layer["visible"]),
                    opacity=float(cast(float | int, layer["opacity"])),
                    order=cast(int, layer["order"]),
                    style=cast(dict[str, Any], layer["style"]),
                    labels=cast(dict[str, Any], layer["labels"]),
                    dataset_id=reference[0],
                    dataset_version_id=reference[1],
                    dataset_version_number=reference[2],
                    resource_version_id=cast(UUID, row[1]),
                    resource_version_number=cast(int, row[2]),
                    object_id=cast(UUID, row[7]),
                    bucket=cast(str, row[8]),
                    key=cast(str, row[9]),
                    s3_version_id=cast(str, row[10]),
                    content_type=cast(str, row[11]),
                    size_bytes=cast(int, row[12]),
                    checksum_sha256=cast(str, row[13]),
                    feature_count=cast(int | None, row[6]),
                )
            )
        return PublicMapPreviewTarget(
            resource_id=resource_id,
            resource_version_id=cast(UUID, resource_row[0]),
            resource_version_number=cast(int, resource_row[1]),
            map_id=map_id,
            map_version=map_version,
            bound_map_version=cast(int | None, bound_map_version),
            projection=cast(Literal["mercator", "globe"], definition["projection"]),
            color_mode=cast(Literal["light", "dark"], definition["colorMode"]),
            layers=tuple(layers),
        )

    @staticmethod
    async def _public_dataset_document_preview_target(
        transaction: TenantTransaction,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDatasetDocumentPreviewTarget | None:
        resource_row = await transaction.fetch_one(
            """
            SELECT resource.current_version_id, version.version_number,
                   resource.dataset_id, version.provenance, dataset.format::text
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
             AND version.id = resource.current_version_id
            JOIN app.datasets dataset
              ON dataset.organization_id = resource.organization_id
             AND dataset.id = resource.dataset_id
            WHERE resource.organization_id = %s
              AND resource.project_id = %s
              AND resource.id = %s
              AND resource.kind = 'dataset'
              AND resource.state = 'published'
              AND resource.visibility = 'public'
              AND dataset.format::text IN ('pdf', 'odt')
            """,
            (organization_id, project_id, resource_id),
        )
        if resource_row is None:
            return None
        dataset_id = cast(UUID, resource_row[2])
        provenance = resource_row[3]
        try:
            pinned_dataset_id = UUID(str(provenance["datasetId"]))
            dataset_version_id = UUID(str(provenance["datasetVersionId"]))
            dataset_version_number = provenance["datasetVersionNumber"]
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise PublicCatalogPreviewConflict(
                "public_dataset_document_preview_not_sealed"
            ) from error
        if (
            pinned_dataset_id != dataset_id
            or isinstance(dataset_version_number, bool)
            or not isinstance(dataset_version_number, int)
            or dataset_version_number < 1
        ):
            raise PublicCatalogPreviewConflict("public_dataset_document_preview_not_sealed")
        rows = await transaction.fetch_all(
            """
            SELECT version.version_number, object.id, object.bucket,
                   object.object_key, object.s3_version_id, object.content_type,
                   object.size_bytes, object.checksum_sha256
            FROM app.datasets dataset
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = dataset.organization_id
             AND project_dataset.dataset_id = dataset.id
             AND project_dataset.project_id = %s
            JOIN app.dataset_versions version
              ON version.organization_id = dataset.organization_id
             AND version.dataset_id = dataset.id
             AND version.id = %s
            JOIN app.dataset_version_objects link
              ON link.organization_id = version.organization_id
             AND link.dataset_id = version.dataset_id
             AND link.dataset_version_id = version.id
            JOIN app.data_objects object
              ON object.organization_id = link.organization_id
             AND object.dataset_id = link.dataset_id
             AND object.id = link.data_object_id
            WHERE dataset.organization_id = %s
              AND dataset.id = %s
              AND dataset.classification = 'public'
              AND dataset.status = 'active'
              AND dataset.format::text = %s
              AND version.state = 'active'
              AND version.geometry_type = 'document'
              AND object.role = 'derived'
              AND object.content_type = 'application/json'
              AND version.quality_results #>> '{safety_scan,status}' = 'passed'
              AND version.quality_results #>> '{safety_scan,engine}' = 'ClamAV'
              AND version.quality_results #>>
                    '{safety_scan,comprehensive_malware_scan}' = 'true'
              AND coalesce(
                    version.quality_results #>> '{safety_scan,engine_version}', ''
                  ) <> ''
              AND coalesce(
                    version.quality_results #>> '{safety_scan,signature_version}', ''
                  ) ~ '^[1-9][0-9]*$'
              AND (
                (
                  dataset.format::text = 'odt'
                  AND object.object_key LIKE '%%/document/accessible-preview.json'
                  AND object.size_bytes BETWEEN 1 AND 524288
                  AND version.schema_definition #>> '{document,kind}' = 'odf_text'
                  AND version.schema_definition #>> '{document,source_format}' = 'odt'
                  AND version.schema_definition #>>
                        '{document,accessible_preview_schema}' = %s
                ) OR (
                  dataset.format::text = 'pdf'
                  AND app.pdf_document_publication_facts_valid_v1(
                    version.schema_definition,
                    object.object_key,
                    object.size_bytes
                  )
                )
              )
            ORDER BY CASE
              WHEN object.object_key LIKE '%%/document/visual-presentation.json' THEN 0
              ELSE 1
            END, object.id
            """,
            (
                project_id,
                dataset_version_id,
                organization_id,
                dataset_id,
                cast(str, resource_row[4]),
                DOCUMENT_PREVIEW_SCHEMA,
            ),
        )
        accessible = [
            row for row in rows if cast(str, row[3]).endswith("/document/accessible-preview.json")
        ]
        visual = [
            row for row in rows if cast(str, row[3]).endswith("/document/visual-presentation.json")
        ]
        source_format = cast(Literal["pdf", "odt"], resource_row[4])
        if (
            len(accessible) != 1
            or len(visual) > 1
            or (source_format == "odt" and visual)
            or len(rows) != len(accessible) + len(visual)
            or cast(int, accessible[0][0]) != dataset_version_number
            or any(cast(int, row[0]) != dataset_version_number for row in visual)
        ):
            raise PublicCatalogPreviewConflict("public_dataset_document_preview_not_sealed")
        selected = visual[0] if visual else accessible[0]
        return PublicDatasetDocumentPreviewTarget(
            resource_id=resource_id,
            resource_version_id=cast(UUID, resource_row[0]),
            resource_version_number=cast(int, resource_row[1]),
            dataset_version_id=dataset_version_id,
            dataset_version_number=dataset_version_number,
            source_format=source_format,
            object_id=cast(UUID, selected[1]),
            bucket=cast(str, selected[2]),
            key=cast(str, selected[3]),
            s3_version_id=cast(str, selected[4]),
            content_type=cast(str, selected[5]),
            size_bytes=cast(int, selected[6]),
            checksum_sha256=cast(str, selected[7]),
        )

    @staticmethod
    async def _public_spatial_preview_target(
        transaction: TenantTransaction,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicSpatialPreviewTarget | None:
        rows = await transaction.fetch_all(
            """
            SELECT resource.current_version_id, resource_version.version_number,
                   dataset.current_version_id, object.id, object.bucket,
                   object.object_key, object.s3_version_id, object.content_type,
                   object.size_bytes, object.checksum_sha256,
                   dataset_version.feature_count
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions resource_version
              ON resource_version.organization_id = resource.organization_id
             AND resource_version.resource_id = resource.id
             AND resource_version.id = resource.current_version_id
            JOIN app.datasets dataset
              ON dataset.organization_id = resource.organization_id
             AND dataset.id = resource.dataset_id
            JOIN app.dataset_versions dataset_version
              ON dataset_version.organization_id = dataset.organization_id
             AND dataset_version.dataset_id = dataset.id
             AND dataset_version.id = dataset.current_version_id
            JOIN app.dataset_version_objects link
              ON link.organization_id = dataset_version.organization_id
             AND link.dataset_id = dataset_version.dataset_id
             AND link.dataset_version_id = dataset_version.id
            JOIN app.data_objects object
              ON object.organization_id = link.organization_id
             AND object.id = link.data_object_id
            WHERE resource.organization_id = %s
              AND resource.project_id = %s
              AND resource.id = %s
              AND resource.state = 'published'
              AND resource.visibility = 'public'
              AND resource.kind IN ('dataset', 'service')
              AND dataset.status = 'active'
              AND dataset.format::text IN
                ('geojson', 'csv', 'shapefile', 'geopackage', 'geoparquet')
              AND dataset_version.state = 'active'
              AND dataset_version.geometry_type IS NOT NULL
              AND dataset_version.geometry_type NOT IN ('document', 'image', 'raster')
              AND object.role = 'derived'
              AND object.content_type = 'application/geo+json'
              AND object.object_key LIKE '%%/preview/preview.geojson'
              AND object.size_bytes BETWEEN 1 AND %s
            """,
            (
                organization_id,
                project_id,
                resource_id,
                MAX_SPATIAL_PREVIEW_BYTES,
            ),
        )
        if len(rows) != 1:
            return None
        row = rows[0]
        return PublicSpatialPreviewTarget(
            resource_id=resource_id,
            resource_version_id=cast(UUID, row[0]),
            resource_version_number=cast(int, row[1]),
            dataset_version_id=cast(UUID, row[2]),
            object_id=cast(UUID, row[3]),
            bucket=cast(str, row[4]),
            key=cast(str, row[5]),
            s3_version_id=cast(str, row[6]),
            content_type=cast(str, row[7]),
            size_bytes=cast(int, row[8]),
            checksum_sha256=cast(str, row[9]),
            feature_count=cast(int | None, row[10]),
        )

    @staticmethod
    def _filters(
        organization_id: UUID,
        filters: PublicCatalogFilters,
    ) -> tuple[str, tuple[Any, ...]]:
        bbox = filters.bbox or (None, None, None, None)
        statement = """
            resource.organization_id = %s
            AND resource.state = 'published'
            AND resource.visibility = 'public'
            AND (%s::app.governed_resource_kind IS NULL
                 OR resource.kind = %s::app.governed_resource_kind)
            AND (%s::uuid IS NULL OR resource.project_id = %s::uuid)
            AND (
              %s::text IS NULL
              OR version.search_document @@ websearch_to_tsquery('simple', %s::text)
              OR EXISTS (
                SELECT 1 FROM unnest(version.keywords) candidate
                WHERE lower(candidate) LIKE '%%' || lower(%s::text) || '%%'
              )
            )
            AND (
              %s::text IS NULL
              OR EXISTS (
                SELECT 1 FROM unnest(version.keywords) candidate
                WHERE lower(candidate) = lower(%s::text)
              )
            )
            AND (%s::text IS NULL OR lower(version.license) = lower(%s::text))
            AND (%s::text IS NULL OR lower(origin.namespace) = lower(%s::text))
            AND (
              %s::double precision IS NULL
              OR (version.spatial_extent IS NOT NULL AND (
                (version.spatial_extent->>0)::double precision <= %s::double precision
                AND (version.spatial_extent->>2)::double precision >= %s::double precision
                AND (version.spatial_extent->>1)::double precision <= %s::double precision
                AND (version.spatial_extent->>3)::double precision >= %s::double precision
              ))
            )
            AND (%s::timestamptz IS NULL OR version.temporal_end IS NULL
                 OR version.temporal_end >= %s::timestamptz)
            AND (%s::timestamptz IS NULL OR version.temporal_start IS NULL
                 OR version.temporal_start <= %s::timestamptz)
        """
        parameters: tuple[Any, ...] = (
            organization_id,
            filters.kind,
            filters.kind,
            filters.project_id,
            filters.project_id,
            filters.query,
            filters.query,
            filters.query,
            filters.keyword,
            filters.keyword,
            filters.license,
            filters.license,
            filters.origin_namespace,
            filters.origin_namespace,
            bbox[0],
            bbox[2],
            bbox[0],
            bbox[3],
            bbox[1],
            filters.temporal_start,
            filters.temporal_start,
            filters.temporal_end,
            filters.temporal_end,
        )
        return statement, parameters

    @staticmethod
    def _from_clause() -> str:
        return """
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
             AND version.id = resource.current_version_id
            JOIN app.organizations organization
              ON organization.id = resource.organization_id
            JOIN app.projects project
              ON project.organization_id = resource.organization_id
             AND project.id = resource.project_id
            LEFT JOIN LATERAL (
              SELECT identifier.namespace, identifier.identifier,
                     identifier.source_version, identifier.imported_at
              FROM app.governed_resource_external_identifiers identifier
              WHERE identifier.organization_id = resource.organization_id
                AND identifier.resource_id = resource.id
              ORDER BY identifier.imported_at DESC, identifier.namespace
              LIMIT 1
            ) origin ON true
            LEFT JOIN app.governed_resource_rating_summaries rating_summary
              ON rating_summary.organization_id = resource.organization_id
             AND rating_summary.project_id = resource.project_id
             AND rating_summary.resource_id = resource.id
        """

    @classmethod
    def _record_select(cls) -> str:
        return f"""
            SELECT resource.id, resource.organization_id,
                   organization.slug, organization.name,
                   resource.project_id, project.name,
                   resource.kind::text, resource.slug,
                   version.version_number, version.title, version.abstract,
                   version.language, version.license, version.attribution,
                   version.keywords, version.spatial_extent,
                   version.temporal_start, version.temporal_end,
                   origin.namespace, origin.identifier,
                   origin.source_version, origin.imported_at,
                   (
                     SELECT count(*)::bigint
                     FROM app.governed_resource_relationships relationship
                     JOIN app.governed_resources related
                       ON related.organization_id = relationship.organization_id
                      AND related.project_id = relationship.project_id
                      AND related.id = CASE
                        WHEN relationship.source_resource_id = resource.id
                        THEN relationship.target_resource_id
                        ELSE relationship.source_resource_id
                      END
                     WHERE relationship.organization_id = resource.organization_id
                       AND relationship.project_id = resource.project_id
                       AND (relationship.source_resource_id = resource.id
                            OR relationship.target_resource_id = resource.id)
                       AND related.state = 'published'
                       AND related.visibility = 'public'
                   ) AS public_relationship_count,
                   COALESCE(rating_summary.rating_count, 0)::bigint,
                   CASE WHEN COALESCE(rating_summary.rating_count, 0) = 0
                     THEN NULL
                     ELSE rating_summary.rating_sum::double precision
                       / rating_summary.rating_count::double precision
                   END AS rating_average,
                   CASE
                     WHEN resource.map_id IS NOT NULL THEN 'map'
                     WHEN resource.kind = 'dataset'
                       AND resource.dataset_id IS NOT NULL
                       AND EXISTS (
                         SELECT 1
                         FROM app.datasets preview_dataset
                         WHERE preview_dataset.organization_id = resource.organization_id
                           AND preview_dataset.id = resource.dataset_id
                           AND preview_dataset.format::text IN ('pdf', 'odt')
                       ) THEN 'dataset-document'
                     WHEN resource.dataset_id IS NOT NULL THEN 'dataset'
                     WHEN resource.kind IN ('document', 'story', 'dashboard') THEN 'document'
                     ELSE 'metadata'
                   END AS preview_kind,
                   resource.created_at, resource.updated_at
            {cls._from_clause()}
        """

    @staticmethod
    def _record(row: tuple[Any, ...]) -> PublicCatalogRecord:
        raw_extent = cast(list[Any] | None, row[15])
        extent = (
            cast(
                tuple[float, float, float, float],
                tuple(float(value) for value in raw_extent),
            )
            if raw_extent is not None
            else None
        )
        return PublicCatalogRecord(
            resource_id=cast(UUID, row[0]),
            organization_id=cast(UUID, row[1]),
            organization_slug=cast(str, row[2]),
            organization_name=cast(str, row[3]),
            project_id=cast(UUID, row[4]),
            project_name=cast(str, row[5]),
            kind=cast(ResourceKind, row[6]),
            slug=cast(str, row[7]),
            version_number=cast(int, row[8]),
            title=cast(str, row[9]),
            abstract=cast(str | None, row[10]),
            language=cast(str, row[11]),
            license=cast(str | None, row[12]),
            attribution=cast(str | None, row[13]),
            keywords=tuple(cast(list[str], row[14])),
            spatial_extent=extent,
            temporal_start=cast(datetime | None, row[16]),
            temporal_end=cast(datetime | None, row[17]),
            origin_namespace=cast(str | None, row[18]),
            origin_identifier=cast(str | None, row[19]),
            origin_version=cast(str | None, row[20]),
            origin_observed_at=cast(datetime | None, row[21]),
            public_relationship_count=cast(int, row[22]),
            rating_count=cast(int, row[23]),
            rating_average=cast(float | None, row[24]),
            preview_kind=cast(
                Literal["map", "dataset", "dataset-document", "document", "metadata"],
                row[25],
            ),
            created_at=cast(datetime, row[26]),
            updated_at=cast(datetime, row[27]),
        )

    @classmethod
    def _facets(
        cls,
        rows: list[tuple[Any, ...]],
    ) -> dict[str, tuple[PublicCatalogFacet, ...]]:
        counters: dict[str, Counter[tuple[str, str]]] = {
            "kind": Counter(),
            "project": Counter(),
            "license": Counter(),
            "keyword": Counter(),
            "origin": Counter(),
        }
        for row in rows:
            kind = cast(str, row[0])
            project_id = cast(UUID, row[1])
            project_name = cast(str, row[2])
            license_value = cast(str | None, row[3])
            keywords = cast(list[str], row[4])
            origin = cast(str | None, row[5])
            counters["kind"][(kind, kind.replace("_", " ").title())] += 1
            counters["project"][(str(project_id), project_name)] += 1
            if license_value is not None:
                counters["license"][(license_value, license_value)] += 1
            for keyword in set(keywords):
                counters["keyword"][(keyword, keyword)] += 1
            if origin is not None:
                counters["origin"][(origin, origin)] += 1
        return {
            name: tuple(
                PublicCatalogFacet(value=value, label=label, count=count)
                for (value, label), count in sorted(
                    counter.items(),
                    key=lambda item: (-item[1], item[0][1].casefold(), item[0][0]),
                )[:50]
            )
            for name, counter in counters.items()
        }
