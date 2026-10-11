import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from hashlib import sha256
from json import dumps
from math import isfinite
from pathlib import PurePosixPath
from secrets import token_hex
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import Action, AuthorizationDenied, ProjectRole, Roles, authorize
from opengeo_api.document_previews import (
    DOCUMENT_PREVIEW_SCHEMA,
    MAX_PDF_OCR_PAGES,
    MAX_PDF_OCR_PIXELS,
    PDF_DOCUMENT_PREVIEW_SCHEMA,
    PDF_OCR_DOCUMENT_PREVIEW_SCHEMA,
    PDF_OCR_MODELS,
    PDF_OCR_VISUAL_PRESENTATION_SCHEMA,
    PDF_VISUAL_PRESENTATION_SCHEMA,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.page_renderer_contract import PAGE_RENDERER_VERSION
from opengeo_api.site_layouts import (
    SiteLayoutError,
    empty_print_layout,
    parse_print_layout,
    print_layout_resource_ids,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

SiteState = Literal["draft", "review", "published"]
PublicationReach = Literal["unpublished", "unlisted", "listed"]
MAX_SITE_REFERENCES = 128
MAX_SITE_MANIFEST_BYTES = 131_072
MAX_SITE_SNAPSHOTS = 16
MAX_SITE_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_SITE_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024
MAX_SITE_ASSETS = 16
MAX_SITE_ASSET_BYTES = 4 * 1024 * 1024
MAX_SITE_ASSET_TOTAL_BYTES = 32 * 1024 * 1024
PUBLIC_RELEASE_LICENSES = frozenset({"CC-BY-4.0", "CC0-1.0", "PDDL-1.0"})
SITE_IMAGE_CONTENT_TYPES = frozenset({"image/png"})
SITE_FILE_CONTENT_TYPES = frozenset(
    {
        "application/csv",
        "application/geo+json",
        "application/geopackage+sqlite3",
        "application/json",
        "application/octet-stream",
        "application/pdf",
        "application/vnd.apache.parquet",
        "application/vnd.pmtiles",
        "application/vnd.sqlite3",
        "application/x-parquet",
        "application/x-zip-compressed",
        "application/zip",
        "image/geotiff",
        "image/png",
        "image/tiff",
        "text/csv",
    }
)
SiteTheme = Literal["paper", "atlas", "minimal"]
SiteOperationResult = TypeVar("SiteOperationResult")


class SiteStoreUnavailable(RuntimeError):
    pass


class SiteAccessDenied(RuntimeError):
    pass


class SiteNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class SiteConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class SitePageDraft:
    slug: str
    navigation_label: str
    resource_id: UUID
    resource_version: int
    is_home: bool = False


@dataclass(frozen=True, slots=True)
class SiteDraft:
    title: str
    description: str | None
    language: str
    theme: SiteTheme
    theme_options: dict[str, Any]
    pages: tuple[SitePageDraft, ...]
    change_message: str | None = None
    print_layout: dict[str, Any] = field(default_factory=empty_print_layout)


@dataclass(frozen=True, slots=True)
class SitePublicationDestination:
    revision: int
    reach: PublicationReach
    listed_slug: str | None
    is_primary: bool
    configured_by: UUID
    configured_at: datetime


@dataclass(frozen=True, slots=True)
class SiteMapSnapshotDraft:
    resource_id: UUID
    render_job_id: UUID


@dataclass(frozen=True, slots=True)
class SiteAssetDraft:
    kind: Literal["image", "file", "document"]
    dataset_id: UUID
    dataset_version_id: UUID
    object_id: UUID


@dataclass(frozen=True, slots=True)
class PublishedPageSource:
    source_id: UUID
    source_block_id: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    dialect: str
    dialect_version: str
    compiler_version: str


@dataclass(frozen=True, slots=True)
class SitePage:
    page_id: UUID
    slug: str
    navigation_label: str
    position: int
    is_home: bool
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    resource_kind: str
    resource_title: str
    resource_abstract: str | None
    resource_language: str
    resource_license: str | None
    resource_attribution: str | None
    resource_content: dict[str, Any]
    resource_state: str
    resource_visibility: str
    page_source: PublishedPageSource | None = None


@dataclass(frozen=True, slots=True)
class SiteEdition:
    edition_id: UUID
    site_id: UUID
    site_version_id: UUID
    site_version_number: int
    edition_number: int
    manifest: dict[str, Any]
    manifest_checksum_sha256: str
    published_by: UUID
    published_at: datetime
    revoked_by: UUID | None
    revoked_at: datetime | None
    publication_reach: PublicationReach = "listed"
    listed_slug: str | None = None
    unlisted_token: str | None = None
    is_primary: bool = False


@dataclass(frozen=True, slots=True)
class ProjectSite:
    site_id: UUID
    project_id: UUID
    slug: str
    version_id: UUID
    version_number: int
    state: SiteState
    title: str
    description: str | None
    language: str
    theme: str
    theme_options: dict[str, Any]
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    pages: tuple[SitePage, ...]
    active_edition: SiteEdition | None
    print_layout: dict[str, Any] = field(default_factory=empty_print_layout)
    publication_destination: SitePublicationDestination | None = None


@dataclass(frozen=True, slots=True)
class PublishedLegendItem:
    label: str
    symbol: Literal["fill", "line", "circle"]
    color: str
    opacity: float


@dataclass(frozen=True, slots=True)
class PublishedMapLegend:
    title: str
    profile_checksum_sha256: str
    items: tuple[PublishedLegendItem, ...]


def _legend_from_render_configuration(
    configuration: object, checksum: object
) -> PublishedMapLegend | None:
    if not isinstance(configuration, dict) or not _valid_sha256(checksum):
        raise SiteConflict("site_snapshot_legend_invalid")
    raw_legend = configuration.get("legend")
    if not isinstance(raw_legend, dict) or not isinstance(raw_legend.get("enabled"), bool):
        raise SiteConflict("site_snapshot_legend_invalid")
    if not raw_legend["enabled"]:
        return None
    title = raw_legend.get("title")
    geometry = configuration.get("geometry")
    if not isinstance(title, str) or not 1 <= len(title) <= 100 or not isinstance(geometry, dict):
        raise SiteConflict("site_snapshot_legend_invalid")
    symbol = geometry.get("type")
    color = geometry.get("color")
    opacity = geometry.get("opacity")
    if (
        symbol not in {"fill", "line", "circle"}
        or not _valid_color(color)
        or isinstance(opacity, bool)
        or not isinstance(opacity, (int, float))
        or not isfinite(float(opacity))
        or not 0 <= float(opacity) <= 1
    ):
        raise SiteConflict("site_snapshot_legend_invalid")
    items: list[PublishedLegendItem] = []
    classification = geometry.get("classification")
    if classification is None:
        items.append(
            PublishedLegendItem(title, cast(Any, symbol), cast(str, color).lower(), float(opacity))
        )
    elif isinstance(classification, dict):
        rules = classification.get("rules")
        fallback = classification.get("fallback_color")
        if not isinstance(rules, list) or not 1 <= len(rules) <= 16 or not _valid_color(fallback):
            raise SiteConflict("site_snapshot_legend_invalid")
        for rule in rules:
            if not isinstance(rule, dict):
                raise SiteConflict("site_snapshot_legend_invalid")
            label = rule.get("label")
            rule_color = rule.get("color")
            if (
                not isinstance(label, str)
                or not 1 <= len(label) <= 100
                or not _valid_color(rule_color)
            ):
                raise SiteConflict("site_snapshot_legend_invalid")
            items.append(
                PublishedLegendItem(
                    label, cast(Any, symbol), cast(str, rule_color).lower(), float(opacity)
                )
            )
        items.append(
            PublishedLegendItem(
                "Other", cast(Any, symbol), cast(str, fallback).lower(), float(opacity)
            )
        )
    else:
        raise SiteConflict("site_snapshot_legend_invalid")
    return PublishedMapLegend(title, cast(str, checksum), tuple(items))


def _legend_from_manifest(raw: object) -> PublishedMapLegend | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {"title", "profileChecksumSha256", "items"}:
        raise SiteNotFound("site_edition")
    title = raw.get("title")
    checksum = raw.get("profileChecksumSha256")
    items = raw.get("items")
    if (
        not isinstance(title, str)
        or not 1 <= len(title) <= 100
        or not _valid_sha256(checksum)
        or not isinstance(items, list)
        or not 1 <= len(items) <= 17
    ):
        raise SiteNotFound("site_edition")
    parsed: list[PublishedLegendItem] = []
    for raw_item in items:
        if not isinstance(raw_item, dict) or set(raw_item) != {
            "label",
            "symbol",
            "color",
            "opacity",
        }:
            raise SiteNotFound("site_edition")
        label = raw_item.get("label")
        symbol = raw_item.get("symbol")
        color = raw_item.get("color")
        opacity = raw_item.get("opacity")
        if (
            not isinstance(label, str)
            or not 1 <= len(label) <= 100
            or symbol not in {"fill", "line", "circle"}
            or not _valid_color(color)
            or isinstance(opacity, bool)
            or not isinstance(opacity, (int, float))
            or not isfinite(float(opacity))
            or not 0 <= float(opacity) <= 1
        ):
            raise SiteNotFound("site_edition")
        parsed.append(
            PublishedLegendItem(label, cast(Any, symbol), cast(str, color).lower(), float(opacity))
        )
    return PublishedMapLegend(title, cast(str, checksum), tuple(parsed))


def _valid_color(value: object) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?", value) is not None
    )


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


@dataclass(frozen=True, slots=True)
class PublishedMapSnapshot:
    render_job_id: UUID
    output_object_id: UUID
    storage_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    width: int
    height: int
    bbox: tuple[float, float, float, float]
    crs: str
    legend: PublishedMapLegend | None = None
    saved_map: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class PublishedResourceReference:
    resource_id: UUID
    version_id: UUID
    version_number: int
    kind: str
    title: str
    abstract: str | None
    attribution: str | None
    license: str | None
    wms_service_id: UUID | None
    wms_layer_name: str | None
    snapshot: PublishedMapSnapshot | None = None


@dataclass(frozen=True, slots=True)
class PublishedSiteAsset:
    kind: Literal["image", "file", "document"]
    dataset_id: UUID
    dataset_version_id: UUID
    object_id: UUID
    bucket: str
    object_key: str
    storage_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    filename: str


@dataclass(frozen=True, slots=True)
class SiteAssetCandidate:
    kind: Literal["image", "file", "document"]
    dataset_id: UUID
    dataset_name: str
    dataset_version_id: UUID
    dataset_version_number: int
    object_id: UUID
    role: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    filename: str


@dataclass(frozen=True, slots=True)
class PublishedSite:
    site: ProjectSite
    edition: SiteEdition
    references: tuple[PublishedResourceReference, ...]
    assets: tuple[PublishedSiteAsset, ...] = ()


@dataclass(frozen=True, slots=True)
class PublicSiteDirectoryRecord:
    project_id: UUID
    project_name: str
    site_id: UUID
    edition_id: UUID
    listed_slug: str
    title: str
    description: str | None
    language: str
    theme: str
    page_count: int
    published_at: datetime
    is_primary: bool


@dataclass(frozen=True, slots=True)
class PublicSiteDirectoryPage:
    records: tuple[PublicSiteDirectoryRecord, ...]
    number_matched: int


class SitePublicationRepository(Protocol):
    async def list_asset_candidates(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[SiteAssetCandidate, ...]: ...

    async def list_sites(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ProjectSite, ...]: ...

    async def get_publication(
        self, context: TenantContext, publication_id: UUID
    ) -> ProjectSite: ...

    async def get_site(
        self, context: TenantContext, project_id: UUID, site_id: UUID
    ) -> ProjectSite: ...

    async def create_site(
        self,
        context: TenantContext,
        project_id: UUID,
        slug: str,
        draft: SiteDraft,
        request_id: str,
    ) -> ProjectSite: ...

    async def update_site(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        draft: SiteDraft,
        request_id: str,
    ) -> ProjectSite: ...

    async def configure_site_publication_destination(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_revision: int,
        reach: PublicationReach,
        listed_slug: str | None,
        is_primary: bool,
        request_id: str,
    ) -> ProjectSite: ...

    async def submit_site_for_review(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        reason: str | None,
        request_id: str,
    ) -> ProjectSite: ...

    async def publish_site(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        reason: str | None,
        map_snapshots: tuple[SiteMapSnapshotDraft, ...],
        request_id: str,
    ) -> ProjectSite: ...

    async def list_editions(
        self, context: TenantContext, project_id: UUID, site_id: UUID
    ) -> tuple[SiteEdition, ...]: ...

    async def revoke_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        edition_id: UUID,
        request_id: str,
    ) -> SiteEdition: ...

    async def get_public_site(
        self,
        context: TenantContext,
        project_id: UUID,
        *,
        site_slug: str | None = None,
        edition_id: UUID | None = None,
        unlisted_token: str | None = None,
    ) -> PublishedSite: ...

    async def list_public_sites(
        self,
        context: TenantContext,
        *,
        limit: int = 24,
        offset: int = 0,
    ) -> PublicSiteDirectoryPage: ...

    async def get_public_site_by_destination(
        self,
        context: TenantContext,
        *,
        listed_slug: str | None = None,
        primary: bool = False,
    ) -> PublishedSite: ...


class PostgresSitePublicationRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[SiteOperationResult]],
    ) -> SiteOperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise SiteConflict("site_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise SiteStoreUnavailable("site publication operation failed") from error

    async def list_sites(self, context: TenantContext, project_id: UUID) -> tuple[ProjectSite, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[ProjectSite, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT id
                FROM app.project_sites
                WHERE organization_id = %s AND project_id = %s
                ORDER BY lower(slug), id
                LIMIT 100
                """,
                (context.organization_id, project_id),
            )
            return tuple(
                [
                    await self._load_site(transaction, context, project_id, cast(UUID, row[0]))
                    for row in rows
                ]
            )

        return await self._run(context, operation)

    async def configure_site_publication_destination(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_revision: int,
        reach: PublicationReach,
        listed_slug: str | None,
        is_primary: bool,
        request_id: str,
    ) -> ProjectSite:
        self._validate_publication_destination(reach, listed_slug, is_primary)

        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_PUBLISH, roles)
            row = await transaction.fetch_one(
                """
                SELECT revision, reach::text, listed_slug, is_primary
                FROM app.project_site_publication_destinations
                WHERE organization_id = %s AND project_id = %s AND site_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, site_id),
            )
            if row is None:
                raise SiteNotFound("site_publication_destination")
            revision = cast(int, row[0])
            if revision != expected_revision:
                raise SiteConflict(
                    "site_publication_destination_conflict",
                    current_version=revision,
                )
            next_revision = revision + 1
            await transaction.execute(
                """
                UPDATE app.project_site_publication_destinations
                SET revision = %s, reach = %s, listed_slug = %s, is_primary = %s,
                    configured_by = %s, configured_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND site_id = %s
                """,
                (
                    next_revision,
                    reach,
                    listed_slug,
                    is_primary,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    site_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_site_publication_destination_events
                  (organization_id, project_id, site_id, destination_revision,
                   source_reach, target_reach, source_listed_slug,
                   target_listed_slug, source_is_primary, target_is_primary,
                   request_id, actor_user_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    site_id,
                    next_revision,
                    cast(str, row[1]),
                    reach,
                    cast(str | None, row[2]),
                    listed_slug,
                    cast(bool, row[3]),
                    is_primary,
                    request_id,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.publication.destination.configured",
                site_id,
                request_id,
                {
                    "revision": next_revision,
                    "reach": reach,
                    "listedSlug": listed_slug,
                    "primary": is_primary,
                },
            )
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def list_asset_candidates(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[SiteAssetCandidate, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[SiteAssetCandidate, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT object.id, object.dataset_id, version.id,
                       object.bucket, object.object_key, object.s3_version_id,
                       object.content_type, object.size_bytes, object.checksum_sha256,
                       object.role::text, dataset.classification::text,
                       dataset.status::text, version.state::text,
                       dataset.name, version.version_number, version.quality_results,
                       dataset.format::text, version.geometry_type,
                       version.schema_definition
                FROM app.project_datasets project_dataset
                JOIN app.datasets dataset
                  ON dataset.organization_id = project_dataset.organization_id
                 AND dataset.id = project_dataset.dataset_id
                JOIN app.dataset_versions version
                  ON version.organization_id = dataset.organization_id
                 AND version.dataset_id = dataset.id
                 AND version.id = dataset.current_version_id
                JOIN app.dataset_version_objects link
                  ON link.organization_id = version.organization_id
                 AND link.dataset_id = version.dataset_id
                 AND link.dataset_version_id = version.id
                JOIN app.data_objects object
                  ON object.organization_id = link.organization_id
                 AND object.dataset_id = link.dataset_id
                 AND object.id = link.data_object_id
                WHERE project_dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND dataset.classification = 'public'
                  AND dataset.status = 'active'
                  AND version.state = 'active'
                  AND object.size_bytes BETWEEN 1 AND %s
                  AND (
                    (
                      object.content_type = ANY(%s::text[])
                      AND object.role::text = ANY(%s::text[])
                    )
                    OR (
                      object.content_type = ANY(%s::text[])
                      AND object.role::text = ANY(%s::text[])
                    )
                  )
                ORDER BY lower(dataset.name), dataset.id, version.version_number DESC,
                         object.role::text, object.id
                LIMIT 100
                """,
                (
                    context.organization_id,
                    project_id,
                    MAX_SITE_ASSET_BYTES,
                    sorted(SITE_IMAGE_CONTENT_TYPES),
                    ["derived", "published", "thumbnail"],
                    sorted(SITE_FILE_CONTENT_TYPES),
                    ["derived", "original", "published", "thumbnail"],
                ),
            )
            candidates: list[SiteAssetCandidate] = []
            for row in rows:
                kind: Literal["image", "file", "document"]
                if self._document_facts_valid(
                    row[16] if len(row) > 16 else None,
                    row[17] if len(row) > 17 else None,
                    row[18] if len(row) > 18 else None,
                    row[4],
                ):
                    kind = "document"
                elif row[6] in SITE_IMAGE_CONTENT_TYPES and row[9] in {
                    "derived",
                    "published",
                    "thumbnail",
                }:
                    kind = "image"
                else:
                    kind = "file"
                asset = self._asset_from_row(
                    kind,
                    row,
                    row[15] if len(row) > 15 else None,
                    dataset_format=row[16] if len(row) > 16 else None,
                    geometry_type=row[17] if len(row) > 17 else None,
                    schema_definition=row[18] if len(row) > 18 else None,
                )
                candidates.append(
                    SiteAssetCandidate(
                        kind=kind,
                        dataset_id=asset.dataset_id,
                        dataset_name=cast(str, row[13]),
                        dataset_version_id=asset.dataset_version_id,
                        dataset_version_number=cast(int, row[14]),
                        object_id=asset.object_id,
                        role=cast(str, row[9]),
                        content_type=asset.content_type,
                        size_bytes=asset.size_bytes,
                        checksum_sha256=asset.checksum_sha256,
                        filename=asset.filename,
                    )
                )
            return tuple(candidates)

        return await self._run(context, operation)

    async def get_publication(self, context: TenantContext, publication_id: UUID) -> ProjectSite:
        """Resolve a Publication identity, retaining site/editor compatibility."""

        async def operation(transaction: TenantTransaction) -> ProjectSite:
            row = await transaction.fetch_one(
                "SELECT project_id FROM app.project_sites WHERE organization_id = %s AND id = %s",
                (context.organization_id, publication_id),
            )
            if row is None:
                raise SiteNotFound("publication")
            project_id = cast(UUID, row[0])
            try:
                roles = await self._project_roles(transaction, context, project_id)
                self._require(Action.SITE_READ, roles)
            except (SiteAccessDenied, SiteNotFound) as error:
                raise SiteNotFound("publication") from error
            return await self._load_site(transaction, context, project_id, publication_id)

        return await self._run(context, operation)

    async def get_site(
        self, context: TenantContext, project_id: UUID, site_id: UUID
    ) -> ProjectSite:
        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def create_site(
        self,
        context: TenantContext,
        project_id: UUID,
        slug: str,
        draft: SiteDraft,
        request_id: str,
    ) -> ProjectSite:
        self._validate_draft(draft)
        site_id = uuid4()
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"{context.organization_id}:{project_id}:site:{slug.casefold()}",),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_sites
                  (id, organization_id, project_id, slug, current_version_id,
                   current_version_number, state, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, 1, 'draft', %s, %s)
                """,
                (
                    site_id,
                    context.organization_id,
                    project_id,
                    slug,
                    version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await self._insert_version(
                transaction, context, project_id, site_id, version_id, 1, draft
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.created",
                site_id,
                request_id,
                {"slug": slug, "version": 1, "pageCount": len(draft.pages)},
            )
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def update_site(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        draft: SiteDraft,
        request_id: str,
    ) -> ProjectSite:
        self._validate_draft(draft)
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            row = await transaction.fetch_one(
                """
                SELECT current_version_number
                FROM app.project_sites
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, site_id),
            )
            if row is None:
                raise SiteNotFound("site")
            current_version = cast(int, row[0])
            if current_version != expected_version:
                raise SiteConflict("site_version_conflict", current_version=current_version)
            next_version = current_version + 1
            await self._insert_version(
                transaction,
                context,
                project_id,
                site_id,
                version_id,
                next_version,
                draft,
            )
            await transaction.execute(
                """
                UPDATE app.project_sites
                SET current_version_id = %s, current_version_number = %s, state = 'draft',
                    updated_by = %s, updated_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    version_id,
                    next_version,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    site_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.version.created",
                site_id,
                request_id,
                {"version": next_version, "pageCount": len(draft.pages)},
            )
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def submit_site_for_review(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        reason: str | None,
        request_id: str,
    ) -> ProjectSite:
        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            row = await self._lock_site(transaction, context, project_id, site_id)
            current_version = cast(int, row[1])
            if current_version != expected_version:
                raise SiteConflict("site_version_conflict", current_version=current_version)
            if row[2] != "draft":
                raise SiteConflict("site_not_draft")
            await transaction.execute(
                """
                UPDATE app.project_sites
                SET state = 'review', updated_by = %s, updated_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.user_id, context.organization_id, project_id, site_id),
            )
            await self._insert_workflow_event(
                transaction,
                context,
                project_id,
                site_id,
                cast(UUID, row[0]),
                current_version,
                "draft",
                "review",
                reason,
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.review.requested",
                site_id,
                request_id,
                {"version": current_version, "reason": reason},
            )
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def publish_site(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        expected_version: int,
        reason: str | None,
        map_snapshots: tuple[SiteMapSnapshotDraft, ...],
        request_id: str,
    ) -> ProjectSite:
        async def operation(transaction: TenantTransaction) -> ProjectSite:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_PUBLISH, roles)
            row = await self._lock_site(transaction, context, project_id, site_id)
            version_id = cast(UUID, row[0])
            current_version = cast(int, row[1])
            if current_version != expected_version:
                raise SiteConflict("site_version_conflict", current_version=current_version)
            if row[2] != "review":
                raise SiteConflict("site_not_in_review")
            site = await self._load_site_version(
                transaction, context, project_id, site_id, version_id
            )
            destination = site.publication_destination
            if destination is None:
                raise SiteConflict("site_publication_destination_missing")
            unlisted_token = token_hex(16) if destination.reach == "unlisted" else None
            references = await self._load_current_references(
                transaction, context, project_id, site.pages
            )
            self._require_public_release(site.pages, references)
            references = await self._seal_map_snapshots(
                transaction, context, project_id, references, map_snapshots
            )
            assets = await self._seal_site_assets(
                transaction,
                context,
                project_id,
                self._referenced_asset_drafts(site.pages),
            )
            self._require_print_layout_release(site, references, assets)
            edition_row = await transaction.fetch_one(
                """
                SELECT COALESCE(max(edition_number), 0) + 1
                FROM app.project_site_editions
                WHERE organization_id = %s AND site_id = %s
                """,
                (context.organization_id, site_id),
            )
            edition_number = cast(int, edition_row[0]) if edition_row is not None else 1
            edition_id = uuid4()
            published_at = datetime.now(UTC)
            manifest = self._manifest(
                context,
                site,
                edition_id,
                edition_number,
                published_at,
                references,
                assets,
                destination,
                unlisted_token,
            )
            manifest_bytes = canonical_json_bytes(manifest)
            stored_manifest_bytes = dumps(
                manifest, ensure_ascii=False, separators=(", ", ": "), sort_keys=True
            ).encode("utf-8")
            if len(stored_manifest_bytes) > MAX_SITE_MANIFEST_BYTES:
                raise SiteConflict("site_manifest_too_large")
            manifest_checksum = sha256(manifest_bytes).hexdigest()
            await transaction.execute(
                """
                UPDATE app.project_site_editions
                SET revoked_by = %s, revoked_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND site_id = %s
                  AND revoked_at IS NULL
                """,
                (context.user_id, context.organization_id, project_id, site_id),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_site_editions
                  (id, organization_id, project_id, site_id, site_version_id,
                   site_version_number, edition_number, manifest,
                   manifest_checksum_sha256, published_by, published_at,
                   publication_reach, listed_slug, unlisted_token, is_primary)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    edition_id,
                    context.organization_id,
                    project_id,
                    site_id,
                    version_id,
                    current_version,
                    edition_number,
                    Jsonb(manifest),
                    manifest_checksum,
                    context.user_id,
                    published_at,
                    destination.reach,
                    destination.listed_slug if destination.reach == "listed" else None,
                    unlisted_token,
                    destination.is_primary,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.project_sites
                SET state = 'published', updated_by = %s, updated_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.user_id, context.organization_id, project_id, site_id),
            )
            await self._insert_workflow_event(
                transaction,
                context,
                project_id,
                site_id,
                version_id,
                current_version,
                "review",
                "published",
                reason,
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.edition.published",
                edition_id,
                request_id,
                {
                    "siteId": str(site_id),
                    "siteVersion": current_version,
                    "edition": edition_number,
                    "manifestChecksumSha256": manifest_checksum,
                    "publicationReach": destination.reach,
                    "listedSlug": (
                        destination.listed_slug if destination.reach == "listed" else None
                    ),
                    "primary": destination.is_primary,
                },
                resource_type="site_edition",
            )
            return await self._load_site(transaction, context, project_id, site_id)

        return await self._run(context, operation)

    async def list_editions(
        self, context: TenantContext, project_id: UUID, site_id: UUID
    ) -> tuple[SiteEdition, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[SiteEdition, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            await self._load_site(transaction, context, project_id, site_id)
            rows = await transaction.fetch_all(
                f"""{self._edition_select()}
                WHERE edition.organization_id = %s AND edition.project_id = %s
                  AND edition.site_id = %s
                ORDER BY edition.edition_number DESC
                """,
                (context.organization_id, project_id, site_id),
            )
            return tuple(self._edition(row) for row in rows)

        return await self._run(context, operation)

    async def revoke_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        edition_id: UUID,
        request_id: str,
    ) -> SiteEdition:
        async def operation(transaction: TenantTransaction) -> SiteEdition:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_PUBLISH, roles)
            row = await transaction.fetch_one(
                f"""{self._edition_select()}
                WHERE edition.organization_id = %s AND edition.project_id = %s
                  AND edition.site_id = %s AND edition.id = %s
                FOR UPDATE OF edition
                """,
                (context.organization_id, project_id, site_id, edition_id),
            )
            if row is None:
                raise SiteNotFound("site_edition")
            if row[10] is not None:
                raise SiteConflict("site_edition_already_revoked")
            await transaction.execute(
                """
                UPDATE app.project_site_editions
                SET revoked_by = %s, revoked_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s
                  AND site_id = %s AND id = %s AND revoked_at IS NULL
                """,
                (context.user_id, context.organization_id, project_id, site_id, edition_id),
            )
            updated = await transaction.fetch_one(
                f"""{self._edition_select()}
                WHERE edition.organization_id = %s AND edition.project_id = %s
                  AND edition.site_id = %s AND edition.id = %s
                """,
                (context.organization_id, project_id, site_id, edition_id),
            )
            if updated is None:
                raise SiteNotFound("site_edition")
            await self._record_event(
                transaction,
                context,
                project_id,
                "site.edition.revoked",
                edition_id,
                request_id,
                {"siteId": str(site_id), "edition": cast(int, row[4])},
                resource_type="site_edition",
            )
            return self._edition(updated)

        return await self._run(context, operation)

    async def get_public_site(
        self,
        context: TenantContext,
        project_id: UUID,
        *,
        site_slug: str | None = None,
        edition_id: UUID | None = None,
        unlisted_token: str | None = None,
    ) -> PublishedSite:
        if sum(locator is not None for locator in (site_slug, edition_id, unlisted_token)) != 1:
            raise ValueError("exactly one public site locator is required")

        async def operation(transaction: TenantTransaction) -> PublishedSite:
            if site_slug is not None:
                edition_row = await transaction.fetch_one(
                    f"""{self._edition_select()}
                    WHERE edition.organization_id = %s AND edition.project_id = %s
                      AND edition.publication_reach = 'listed'
                      AND lower(edition.listed_slug) = lower(%s)
                      AND edition.revoked_at IS NULL
                    """,
                    (context.organization_id, project_id, site_slug),
                )
            elif edition_id is not None:
                edition_row = await transaction.fetch_one(
                    f"""{self._edition_select()}
                    WHERE edition.organization_id = %s AND edition.project_id = %s
                      AND edition.id = %s AND edition.revoked_at IS NULL
                      AND edition.publication_reach <> 'unpublished'
                    """,
                    (context.organization_id, project_id, edition_id),
                )
            else:
                edition_row = await transaction.fetch_one(
                    f"""{self._edition_select()}
                    WHERE edition.organization_id = %s AND edition.project_id = %s
                      AND edition.publication_reach = 'unlisted'
                      AND edition.unlisted_token = %s
                      AND edition.revoked_at IS NULL
                    """,
                    (context.organization_id, project_id, unlisted_token),
                )
            if edition_row is None:
                raise SiteNotFound("site_edition")
            return await self._load_publication(
                transaction,
                context,
                project_id,
                edition_row,
            )

        return await self._run(context, operation)

    async def list_public_sites(
        self,
        context: TenantContext,
        *,
        limit: int = 24,
        offset: int = 0,
    ) -> PublicSiteDirectoryPage:
        if not 1 <= limit <= 100 or not 0 <= offset <= 10_000:
            raise ValueError("public site directory bounds are invalid")

        async def operation(
            transaction: TenantTransaction,
        ) -> PublicSiteDirectoryPage:
            count_row = await transaction.fetch_one(
                """
                SELECT count(*)::bigint
                FROM app.project_site_editions edition
                WHERE edition.organization_id = %s
                  AND edition.publication_reach = 'listed'
                  AND edition.listed_slug IS NOT NULL
                  AND edition.revoked_at IS NULL
                """,
                (context.organization_id,),
            )
            rows = await transaction.fetch_all(
                """
                WITH active_primary AS (
                  SELECT candidate.id
                  FROM app.project_site_editions candidate
                  WHERE candidate.organization_id = %s
                    AND candidate.publication_reach = 'listed'
                    AND candidate.is_primary
                    AND candidate.revoked_at IS NULL
                  ORDER BY candidate.published_at DESC, candidate.id DESC
                  LIMIT 1
                )
                SELECT edition.project_id, project.name, edition.site_id,
                       edition.id, edition.listed_slug, version.title,
                       version.description, version.language, version.theme,
                       (
                         SELECT count(*)::integer
                         FROM app.project_site_pages page
                         WHERE page.organization_id = edition.organization_id
                           AND page.project_id = edition.project_id
                           AND page.site_id = edition.site_id
                           AND page.site_version_id = edition.site_version_id
                       ),
                       edition.published_at,
                       edition.id = (SELECT id FROM active_primary)
                FROM app.project_site_editions edition
                JOIN app.projects project
                  ON project.organization_id = edition.organization_id
                 AND project.id = edition.project_id
                JOIN app.project_site_versions version
                  ON version.organization_id = edition.organization_id
                 AND version.project_id = edition.project_id
                 AND version.site_id = edition.site_id
                 AND version.id = edition.site_version_id
                WHERE edition.organization_id = %s
                  AND edition.publication_reach = 'listed'
                  AND edition.listed_slug IS NOT NULL
                  AND edition.revoked_at IS NULL
                ORDER BY 12 DESC, lower(version.title), edition.listed_slug,
                         edition.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, context.organization_id, limit, offset),
            )
            return PublicSiteDirectoryPage(
                records=tuple(self._public_directory_record(row) for row in rows),
                number_matched=cast(int, count_row[0]) if count_row is not None else 0,
            )

        return await self._run(context, operation)

    async def get_public_site_by_destination(
        self,
        context: TenantContext,
        *,
        listed_slug: str | None = None,
        primary: bool = False,
    ) -> PublishedSite:
        if (listed_slug is None) == (not primary):
            raise ValueError("exactly one account publication destination is required")

        async def operation(transaction: TenantTransaction) -> PublishedSite:
            if primary:
                row = await transaction.fetch_one(
                    """
                    SELECT edition.project_id, edition.id, edition.site_id,
                           edition.site_version_id, edition.site_version_number,
                           edition.edition_number, edition.manifest,
                           edition.manifest_checksum_sha256, edition.published_by,
                           edition.published_at, edition.revoked_by,
                           edition.revoked_at, edition.publication_reach::text,
                           edition.listed_slug, edition.unlisted_token,
                           edition.is_primary
                    FROM app.project_site_editions edition
                    WHERE edition.organization_id = %s
                      AND edition.publication_reach = 'listed'
                      AND edition.is_primary
                      AND edition.revoked_at IS NULL
                    ORDER BY edition.published_at DESC, edition.id DESC
                    LIMIT 1
                    """,
                    (context.organization_id,),
                )
            else:
                row = await transaction.fetch_one(
                    """
                    SELECT edition.project_id, edition.id, edition.site_id,
                           edition.site_version_id, edition.site_version_number,
                           edition.edition_number, edition.manifest,
                           edition.manifest_checksum_sha256, edition.published_by,
                           edition.published_at, edition.revoked_by,
                           edition.revoked_at, edition.publication_reach::text,
                           edition.listed_slug, edition.unlisted_token,
                           edition.is_primary
                    FROM app.project_site_editions edition
                    WHERE edition.organization_id = %s
                      AND edition.publication_reach = 'listed'
                      AND lower(edition.listed_slug) = lower(%s)
                      AND edition.revoked_at IS NULL
                    """,
                    (context.organization_id, listed_slug),
                )
            if row is None:
                raise SiteNotFound("site_edition")
            project_id = cast(UUID, row[0])
            return await self._load_publication(
                transaction,
                context,
                project_id,
                row[1:],
            )

        return await self._run(context, operation)

    async def _load_publication(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        edition_row: tuple[Any, ...],
    ) -> PublishedSite:
        edition = self._edition(edition_row)
        site = await self._load_site_version(
            transaction,
            context,
            project_id,
            edition.site_id,
            edition.site_version_id,
            active_edition=edition,
        )
        references = await self._load_manifest_references(
            transaction, context, project_id, edition.manifest
        )
        assets = await self._load_manifest_assets(
            transaction, context, project_id, edition.manifest
        )
        self._require_public_release(site.pages, references)
        self._require_print_layout_release(site, references, assets)
        if {draft.object_id for draft in self._referenced_asset_drafts(site.pages)} != {
            asset.object_id for asset in assets
        }:
            raise SiteNotFound("site_edition")
        return PublishedSite(
            site=site,
            edition=edition,
            references=references,
            assets=assets,
        )

    async def _insert_version(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        version_id: UUID,
        version_number: int,
        draft: SiteDraft,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.project_site_versions
              (id, organization_id, project_id, site_id, version_number,
               title, description, language, theme, theme_options, print_layout,
               change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                project_id,
                site_id,
                version_number,
                draft.title,
                draft.description,
                draft.language,
                draft.theme,
                Jsonb(draft.theme_options),
                Jsonb(draft.print_layout),
                draft.change_message,
                context.user_id,
            ),
        )
        for position, page in enumerate(draft.pages):
            version_row = await transaction.fetch_one(
                """
                SELECT id
                FROM app.governed_resource_versions
                WHERE organization_id = %s AND resource_id = %s AND version_number = %s
                """,
                (context.organization_id, page.resource_id, page.resource_version),
            )
            if version_row is None:
                raise SiteConflict("site_page_resource_version_not_found")
            await transaction.execute(
                """
                INSERT INTO app.project_site_pages
                  (id, organization_id, project_id, site_id, site_version_id,
                   site_version_number, page_slug, navigation_label, position,
                   is_home, resource_id, resource_version_id,
                   resource_version_number, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    uuid4(),
                    context.organization_id,
                    project_id,
                    site_id,
                    version_id,
                    version_number,
                    page.slug,
                    page.navigation_label,
                    position,
                    page.is_home,
                    page.resource_id,
                    cast(UUID, version_row[0]),
                    page.resource_version,
                    context.user_id,
                ),
            )

    async def _load_site(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
    ) -> ProjectSite:
        row = await transaction.fetch_one(
            """
            SELECT current_version_id
            FROM app.project_sites
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (context.organization_id, project_id, site_id),
        )
        if row is None:
            raise SiteNotFound("site")
        active_row = await transaction.fetch_one(
            f"""{self._edition_select()}
            WHERE edition.organization_id = %s AND edition.project_id = %s
              AND edition.site_id = %s AND edition.revoked_at IS NULL
            """,
            (context.organization_id, project_id, site_id),
        )
        return await self._load_site_version(
            transaction,
            context,
            project_id,
            site_id,
            cast(UUID, row[0]),
            active_edition=self._edition(active_row) if active_row is not None else None,
        )

    async def _load_site_version(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        version_id: UUID,
        *,
        active_edition: SiteEdition | None = None,
    ) -> ProjectSite:
        row = await transaction.fetch_one(
            """
            SELECT site.id, site.project_id, site.slug, version.id,
                   version.version_number, site.state::text, version.title,
                   version.description, version.language, version.theme,
                   version.theme_options, version.change_message,
                   site.created_by, site.created_at, site.updated_by, site.updated_at,
                   version.print_layout, destination.revision,
                   destination.reach::text, destination.listed_slug,
                   destination.is_primary, destination.configured_by,
                   destination.configured_at
            FROM app.project_sites site
            JOIN app.project_site_versions version
              ON version.organization_id = site.organization_id
             AND version.project_id = site.project_id
             AND version.site_id = site.id
             AND version.id = %s
            JOIN app.project_site_publication_destinations destination
              ON destination.organization_id = site.organization_id
             AND destination.project_id = site.project_id
             AND destination.site_id = site.id
            WHERE site.organization_id = %s AND site.project_id = %s AND site.id = %s
            """,
            (version_id, context.organization_id, project_id, site_id),
        )
        if row is None:
            raise SiteNotFound("site")
        page_rows = await transaction.fetch_all(
            """
            SELECT page.id, page.page_slug, page.navigation_label, page.position,
                   page.is_home, page.resource_id, page.resource_version_id,
                   page.resource_version_number, resource.kind::text,
                   resource_version.title, resource_version.abstract,
                   resource_version.language, resource_version.license,
                   resource_version.attribution, resource_version.content,
                   resource.state::text, resource.visibility::text,
                   page_source.id, page_source.source_block_id,
                   page_source.s3_version_id, page_source.etag,
                   page_source.content_type, page_source.size_bytes,
                   page_source.checksum_sha256, page_source.dialect,
                   page_source.dialect_version, page_source.compiler_version
            FROM app.project_site_pages page
            JOIN app.governed_resources resource
              ON resource.organization_id = page.organization_id
             AND resource.project_id = page.project_id
             AND resource.id = page.resource_id
            JOIN app.governed_resource_versions resource_version
              ON resource_version.organization_id = page.organization_id
             AND resource_version.resource_id = page.resource_id
             AND resource_version.id = page.resource_version_id
             AND resource_version.version_number = page.resource_version_number
            LEFT JOIN app.page_source_objects page_source
              ON page_source.organization_id = page.organization_id
             AND page_source.project_id = page.project_id
             AND page_source.resource_id = page.resource_id
             AND page_source.resource_version_id = page.resource_version_id
            WHERE page.organization_id = %s AND page.project_id = %s
              AND page.site_id = %s AND page.site_version_id = %s
            ORDER BY page.position, page.id
            """,
            (context.organization_id, project_id, site_id, version_id),
        )
        pages = tuple(
            SitePage(
                page_id=cast(UUID, page[0]),
                slug=cast(str, page[1]),
                navigation_label=cast(str, page[2]),
                position=cast(int, page[3]),
                is_home=cast(bool, page[4]),
                resource_id=cast(UUID, page[5]),
                resource_version_id=cast(UUID, page[6]),
                resource_version_number=cast(int, page[7]),
                resource_kind=cast(str, page[8]),
                resource_title=cast(str, page[9]),
                resource_abstract=cast(str | None, page[10]),
                resource_language=cast(str, page[11]),
                resource_license=cast(str | None, page[12]),
                resource_attribution=cast(str | None, page[13]),
                resource_content=cast(dict[str, Any], page[14]),
                resource_state=cast(str, page[15]),
                resource_visibility=cast(str, page[16]),
                page_source=(
                    PublishedPageSource(
                        source_id=cast(UUID, page[17]),
                        source_block_id=cast(str, page[18]),
                        s3_version_id=cast(str, page[19]),
                        etag=cast(str, page[20]),
                        content_type=cast(str, page[21]),
                        size_bytes=cast(int, page[22]),
                        checksum_sha256=cast(str, page[23]),
                        dialect=cast(str, page[24]),
                        dialect_version=cast(str, page[25]),
                        compiler_version=cast(str, page[26]),
                    )
                    if len(page) > 17 and page[17] is not None
                    else None
                ),
            )
            for page in page_rows
        )
        return ProjectSite(
            site_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            slug=cast(str, row[2]),
            version_id=cast(UUID, row[3]),
            version_number=cast(int, row[4]),
            state=cast(SiteState, row[5]),
            title=cast(str, row[6]),
            description=cast(str | None, row[7]),
            language=cast(str, row[8]),
            theme=cast(str, row[9]),
            theme_options=cast(dict[str, Any], row[10]),
            change_message=cast(str | None, row[11]),
            created_by=cast(UUID, row[12]),
            created_at=cast(datetime, row[13]),
            updated_by=cast(UUID, row[14]),
            updated_at=cast(datetime, row[15]),
            pages=pages,
            active_edition=active_edition,
            print_layout=cast(dict[str, Any], row[16]),
            publication_destination=SitePublicationDestination(
                revision=cast(int, row[17]),
                reach=cast(PublicationReach, row[18]),
                listed_slug=cast(str | None, row[19]),
                is_primary=cast(bool, row[20]),
                configured_by=cast(UUID, row[21]),
                configured_at=cast(datetime, row[22]),
            ),
        )

    async def _load_current_references(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        pages: tuple[SitePage, ...],
    ) -> tuple[PublishedResourceReference, ...]:
        resource_ids = self._referenced_resource_ids(pages)
        if len(resource_ids) > MAX_SITE_REFERENCES:
            raise SiteConflict("site_reference_limit_exceeded")
        if not resource_ids:
            return ()
        rows = await transaction.fetch_all(
            """
            SELECT resource.id, version.id, version.version_number,
                   resource.kind::text, version.title, version.abstract,
                   version.attribution, version.license,
                   resource.state::text, resource.visibility::text,
                   public_service.id, publication.wms_name
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
             AND version.id = resource.current_version_id
            LEFT JOIN app.wms_layer_publications publication
              ON publication.organization_id = resource.organization_id
             AND publication.project_id = resource.project_id
             AND publication.resource_id = resource.id
             AND publication.withdrawn_at IS NULL
            LEFT JOIN app.public_wms_services public_service
              ON public_service.organization_id = resource.organization_id
             AND public_service.project_id = resource.project_id
             AND public_service.disabled_at IS NULL
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = ANY(%s::uuid[])
            ORDER BY resource.id
            """,
            (context.organization_id, project_id, list(resource_ids)),
        )
        found = {cast(UUID, row[0]) for row in rows}
        if found != resource_ids:
            raise SiteConflict("site_reference_not_found")
        if any(row[8] != "published" or row[9] != "public" for row in rows):
            raise SiteConflict("site_reference_not_public")
        return tuple(self._reference(row) for row in rows)

    async def _load_manifest_references(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        manifest: dict[str, Any],
    ) -> tuple[PublishedResourceReference, ...]:
        raw_references = manifest.get("references")
        if not isinstance(raw_references, list) or len(raw_references) > MAX_SITE_REFERENCES:
            raise SiteNotFound("site_edition")
        bindings: list[tuple[UUID, UUID]] = []
        sealed: dict[UUID, dict[str, Any]] = {}
        try:
            for raw in raw_references:
                if not isinstance(raw, dict):
                    raise ValueError
                resource_id = UUID(str(raw["resourceId"]))
                version_id = UUID(str(raw["versionId"]))
                if resource_id in sealed:
                    raise ValueError
                sealed[resource_id] = raw
                bindings.append((resource_id, version_id))
        except (KeyError, TypeError, ValueError) as error:
            raise SiteNotFound("site_edition") from error
        if not bindings:
            return ()
        resource_ids = [binding[0] for binding in bindings]
        version_ids = [binding[1] for binding in bindings]
        rows = await transaction.fetch_all(
            """
            SELECT resource.id, version.id, version.version_number,
                   resource.kind::text, version.title, version.abstract,
                   version.attribution, version.license,
                   resource.state::text, resource.visibility::text
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = ANY(%s::uuid[]) AND version.id = ANY(%s::uuid[])
            ORDER BY resource.id
            """,
            (context.organization_id, project_id, resource_ids, version_ids),
        )
        if len(rows) != len(bindings):
            raise SiteNotFound("site_edition")
        result: list[PublishedResourceReference] = []
        snapshot_jobs: set[UUID] = set()
        snapshot_total_bytes = 0
        for row in rows:
            resource_id = cast(UUID, row[0])
            raw = sealed[resource_id]
            if str(row[1]) != str(raw.get("versionId")) or row[2] != raw.get("versionNumber"):
                raise SiteNotFound("site_edition")
            if row[8] != "published" or row[9] != "public":
                raise SiteNotFound("site_edition")
            raw_service_id = raw.get("wmsServiceId")
            try:
                service_id = UUID(str(raw_service_id)) if raw_service_id is not None else None
            except ValueError as error:
                raise SiteNotFound("site_edition") from error
            layer_name = raw.get("wmsLayerName")
            if layer_name is not None and not isinstance(layer_name, str):
                raise SiteNotFound("site_edition")
            snapshot = self._manifest_snapshot(raw.get("snapshot"))
            if snapshot is not None:
                if row[3] == "map":
                    from opengeo_api.rendering import RenderConflict
                    from opengeo_api.saved_map_publication import load_saved_map_seal

                    try:
                        saved_map = await load_saved_map_seal(
                            transaction,
                            context,
                            project_id,
                            resource_id,
                            cast(UUID, row[1]),
                            snapshot.render_job_id,
                            public=True,
                        )
                    except RenderConflict as error:
                        raise SiteNotFound("site_edition") from error
                    if snapshot.saved_map != saved_map:
                        raise SiteNotFound("site_edition")
                elif snapshot.saved_map is not None:
                    raise SiteNotFound("site_edition")
                if snapshot.render_job_id in snapshot_jobs:
                    raise SiteNotFound("site_edition")
                snapshot_jobs.add(snapshot.render_job_id)
                snapshot_total_bytes += snapshot.size_bytes
                if (
                    len(snapshot_jobs) > MAX_SITE_SNAPSHOTS
                    or snapshot_total_bytes > MAX_SITE_SNAPSHOT_TOTAL_BYTES
                ):
                    raise SiteNotFound("site_edition")
            result.append(
                PublishedResourceReference(
                    resource_id=resource_id,
                    version_id=cast(UUID, row[1]),
                    version_number=cast(int, row[2]),
                    kind=cast(str, row[3]),
                    title=cast(str, row[4]),
                    abstract=cast(str | None, row[5]),
                    attribution=cast(str | None, row[6]),
                    license=cast(str | None, row[7]),
                    wms_service_id=service_id,
                    wms_layer_name=layer_name,
                    snapshot=snapshot,
                )
            )
        return tuple(result)

    @classmethod
    async def _seal_site_assets(
        cls,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        drafts: tuple[SiteAssetDraft, ...],
    ) -> tuple[PublishedSiteAsset, ...]:
        if not drafts:
            return ()
        if len(drafts) > MAX_SITE_ASSETS:
            raise SiteConflict("site_asset_limit_exceeded")
        object_ids = [draft.object_id for draft in drafts]
        rows = await transaction.fetch_all(
            """
            SELECT object.id, object.dataset_id, link.dataset_version_id,
                   object.bucket, object.object_key, object.s3_version_id,
                   object.content_type, object.size_bytes, object.checksum_sha256,
                   object.role::text, dataset.classification::text, dataset.status::text,
                   version.state::text, version.quality_results,
                   dataset.format::text, version.geometry_type,
                   version.schema_definition
            FROM app.data_objects object
            JOIN app.dataset_version_objects link
              ON link.organization_id = object.organization_id
             AND link.dataset_id = object.dataset_id
             AND link.data_object_id = object.id
            JOIN app.dataset_versions version
              ON version.organization_id = link.organization_id
             AND version.dataset_id = link.dataset_id
             AND version.id = link.dataset_version_id
            JOIN app.datasets dataset
              ON dataset.organization_id = object.organization_id
             AND dataset.id = object.dataset_id
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = object.organization_id
             AND project_dataset.dataset_id = object.dataset_id
             AND project_dataset.project_id = %s
            WHERE object.organization_id = %s
              AND object.id = ANY(%s::uuid[])
            ORDER BY object.id
            """,
            (project_id, context.organization_id, object_ids),
        )
        row_by_id = {cast(UUID, row[0]): row for row in rows}
        if set(object_ids) != set(row_by_id):
            raise SiteConflict("site_asset_not_found")
        assets: list[PublishedSiteAsset] = []
        total_size = 0
        for draft in drafts:
            row = row_by_id[draft.object_id]
            if row[1] != draft.dataset_id or row[2] != draft.dataset_version_id:
                raise SiteConflict("site_asset_version_mismatch")
            if row[10] != "public" or row[11] != "active" or row[12] != "active":
                raise SiteConflict("site_asset_not_public")
            asset = cls._asset_from_row(
                draft.kind,
                row,
                row[13] if len(row) > 13 else None,
                dataset_format=row[14] if len(row) > 14 else None,
                geometry_type=row[15] if len(row) > 15 else None,
                schema_definition=row[16] if len(row) > 16 else None,
            )
            total_size += asset.size_bytes
            assets.append(asset)
        if total_size > MAX_SITE_ASSET_TOTAL_BYTES:
            raise SiteConflict("site_asset_total_too_large")
        return tuple(assets)

    @classmethod
    async def _load_manifest_assets(
        cls,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        manifest: dict[str, Any],
    ) -> tuple[PublishedSiteAsset, ...]:
        raw_assets = manifest.get("assets", [])
        if not isinstance(raw_assets, list) or len(raw_assets) > MAX_SITE_ASSETS:
            raise SiteNotFound("site_edition")
        if not raw_assets:
            return ()
        sealed: dict[UUID, dict[str, Any]] = {}
        try:
            for raw in raw_assets:
                if not isinstance(raw, dict):
                    raise ValueError
                object_id = UUID(str(raw["objectId"]))
                if object_id in sealed:
                    raise ValueError
                sealed[object_id] = raw
        except (KeyError, TypeError, ValueError) as error:
            raise SiteNotFound("site_edition") from error
        rows = await transaction.fetch_all(
            """
            SELECT object.id, object.dataset_id, link.dataset_version_id,
                   object.bucket, object.object_key, object.s3_version_id,
                   object.content_type, object.size_bytes, object.checksum_sha256,
                   object.role::text, dataset.classification::text, dataset.status::text,
                   version.state::text, version.quality_results,
                   dataset.format::text, version.geometry_type,
                   version.schema_definition
            FROM app.data_objects object
            JOIN app.dataset_version_objects link
              ON link.organization_id = object.organization_id
             AND link.dataset_id = object.dataset_id
             AND link.data_object_id = object.id
            JOIN app.dataset_versions version
              ON version.organization_id = link.organization_id
             AND version.dataset_id = link.dataset_id
             AND version.id = link.dataset_version_id
            JOIN app.datasets dataset
              ON dataset.organization_id = object.organization_id
             AND dataset.id = object.dataset_id
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = object.organization_id
             AND project_dataset.dataset_id = object.dataset_id
             AND project_dataset.project_id = %s
            WHERE object.organization_id = %s
              AND object.id = ANY(%s::uuid[])
            ORDER BY object.id
            """,
            (project_id, context.organization_id, list(sealed)),
        )
        if len(rows) != len(sealed):
            raise SiteNotFound("site_edition")
        result: list[PublishedSiteAsset] = []
        total_size = 0
        for row in rows:
            object_id = cast(UUID, row[0])
            raw = sealed[object_id]
            kind = raw.get("kind")
            if kind not in {"image", "file", "document"}:
                raise SiteNotFound("site_edition")
            try:
                asset = cls._asset_from_row(
                    cast(Literal["image", "file", "document"], kind),
                    row,
                    row[13] if len(row) > 13 else None,
                    dataset_format=row[14] if len(row) > 14 else None,
                    geometry_type=row[15] if len(row) > 15 else None,
                    schema_definition=row[16] if len(row) > 16 else None,
                )
            except SiteConflict as error:
                raise SiteNotFound("site_edition") from error
            if (
                str(asset.dataset_id) != raw.get("datasetId")
                or str(asset.dataset_version_id) != raw.get("datasetVersionId")
                or asset.storage_version_id != raw.get("storageVersionId")
                or asset.content_type != raw.get("contentType")
                or asset.size_bytes != raw.get("sizeBytes")
                or asset.checksum_sha256 != raw.get("checksumSha256")
                or asset.filename != raw.get("filename")
                or row[10] != "public"
                or row[11] != "active"
                or row[12] != "active"
            ):
                raise SiteNotFound("site_edition")
            total_size += asset.size_bytes
            result.append(asset)
        if total_size > MAX_SITE_ASSET_TOTAL_BYTES:
            raise SiteNotFound("site_edition")
        return tuple(result)

    @staticmethod
    def _asset_from_row(
        kind: Literal["image", "file", "document"],
        row: tuple[Any, ...],
        quality_results: object = None,
        *,
        dataset_format: object = None,
        geometry_type: object = None,
        schema_definition: object = None,
    ) -> PublishedSiteAsset:
        content_type = cast(str, row[6]).lower()
        size_bytes = cast(int, row[7])
        checksum = cast(str, row[8])
        allowed = (
            SITE_IMAGE_CONTENT_TYPES
            if kind == "image"
            else frozenset({"application/json"})
            if kind == "document"
            else SITE_FILE_CONTENT_TYPES
        )
        roles = (
            {"derived", "published", "thumbnail"}
            if kind == "image"
            else {"derived"}
            if kind == "document"
            else {
                "derived",
                "original",
                "published",
                "thumbnail",
            }
        )
        if (
            content_type not in allowed
            or row[9] not in roles
            or not 1 <= size_bytes <= MAX_SITE_ASSET_BYTES
            or re.fullmatch(r"[0-9a-f]{64}", checksum) is None
            or not isinstance(row[5], str)
            or not 1 <= len(row[5]) <= 1_024
        ):
            raise SiteConflict("site_asset_invalid")
        if kind == "document" and (
            not PostgresSitePublicationRepository._document_facts_valid(
                dataset_format, geometry_type, schema_definition, row[4]
            )
            or (
                not cast(str, row[4]).endswith("/document/visual-presentation.json")
                and size_bytes > 512 * 1024
            )
        ):
            raise SiteConflict("site_document_preview_invalid")
        if content_type == "application/pdf" or kind == "document":
            scan = quality_results.get("safety_scan") if isinstance(quality_results, dict) else None
            if (
                not isinstance(scan, dict)
                or scan.get("status") != "passed"
                or scan.get("engine") != "ClamAV"
                or scan.get("comprehensive_malware_scan") is not True
                or not isinstance(scan.get("engine_version"), str)
                or not isinstance(scan.get("signature_version"), int)
                or isinstance(scan.get("signature_version"), bool)
                or cast(int, scan["signature_version"]) < 1
            ):
                raise SiteConflict("site_document_scan_not_verified")
        return PublishedSiteAsset(
            kind=kind,
            dataset_id=cast(UUID, row[1]),
            dataset_version_id=cast(UUID, row[2]),
            object_id=cast(UUID, row[0]),
            bucket=cast(str, row[3]),
            object_key=cast(str, row[4]),
            storage_version_id=row[5],
            content_type=content_type,
            size_bytes=size_bytes,
            checksum_sha256=checksum,
            filename=PostgresSitePublicationRepository._safe_asset_filename(
                cast(str, row[4]), cast(UUID, row[0]), content_type
            ),
        )

    @staticmethod
    def _document_facts_valid(
        dataset_format: object,
        geometry_type: object,
        schema_definition: object,
        object_key: object,
    ) -> bool:
        document = (
            schema_definition.get("document") if isinstance(schema_definition, dict) else None
        )
        if (
            geometry_type != "document"
            or not isinstance(document, dict)
            or not isinstance(object_key, str)
        ):
            return False
        if dataset_format == "odt":
            return (
                object_key.endswith("/document/accessible-preview.json")
                and document.get("kind") == "odf_text"
                and document.get("source_format") == "odt"
                and document.get("accessible_preview_schema") == DOCUMENT_PREVIEW_SCHEMA
            )
        pdf_common_facts = (
            dataset_format == "pdf"
            and document.get("kind") == "pdf"
            and document.get("source_format") == "pdf"
            and document.get("reading_order") == "heuristic"
            and isinstance(document.get("tagged"), bool)
            and isinstance(document.get("text_available"), bool)
            and isinstance(document.get("text_block_count"), int)
            and not isinstance(document.get("text_block_count"), bool)
            and 0 <= cast(int, document["text_block_count"]) <= 2_000
            and isinstance(document.get("text_characters"), int)
            and not isinstance(document.get("text_characters"), bool)
            and 0 <= cast(int, document["text_characters"]) <= 200_000
            and (cast(int, document["text_characters"]) > 0)
            is cast(bool, document["text_available"])
        )
        legacy_pdf_facts = (
            document.get("accessible_preview_schema") == PDF_DOCUMENT_PREVIEW_SCHEMA
            and document.get("text_extraction") == "poppler_pdftotext"
            and document.get("ocr_performed") is False
        )
        ocr_pdf_facts = PostgresSitePublicationRepository._pdf_ocr_facts_valid(document)
        if not pdf_common_facts or not (legacy_pdf_facts or ocr_pdf_facts):
            return False
        if object_key.endswith("/document/accessible-preview.json"):
            return True
        return (
            object_key.endswith("/document/visual-presentation.json")
            and document.get("visual_presentation_schema")
            == (
                PDF_OCR_VISUAL_PRESENTATION_SCHEMA
                if ocr_pdf_facts
                else PDF_VISUAL_PRESENTATION_SCHEMA
            )
            and document.get("visual_renderer") == "poppler_pdftoppm"
            and document.get("visual_media_type") == "image/jpeg"
            and document.get("visual_annotations_hidden") is True
            and isinstance(document.get("page_count"), int)
            and not isinstance(document.get("page_count"), bool)
            and 1 <= cast(int, document["page_count"]) <= 200
            and document.get("visual_page_count") == document.get("page_count")
            and isinstance(document.get("visual_target_max_dimension"), int)
            and not isinstance(document.get("visual_target_max_dimension"), bool)
            and 64 <= cast(int, document["visual_target_max_dimension"]) <= 1_000
            and isinstance(document.get("visual_total_pixels"), int)
            and not isinstance(document.get("visual_total_pixels"), bool)
            and 1 <= cast(int, document["visual_total_pixels"]) <= 20_000_000
            and isinstance(document.get("visual_total_image_bytes"), int)
            and not isinstance(document.get("visual_total_image_bytes"), bool)
            and 1 <= cast(int, document["visual_total_image_bytes"]) <= 2_400_000
        )

    @staticmethod
    def _pdf_ocr_facts_valid(document: dict[str, object]) -> bool:
        pages = document.get("ocr_pages")
        page_count = document.get("page_count")
        ocr_page_count = document.get("ocr_page_count")
        truncated = document.get("ocr_truncated")
        return (
            document.get("accessible_preview_schema") == PDF_OCR_DOCUMENT_PREVIEW_SCHEMA
            and document.get("text_extraction") == "poppler_pdftotext_tesseract"
            and document.get("ocr_performed") is True
            and document.get("ocr_engine") == "tesseract"
            and isinstance(document.get("ocr_engine_version"), str)
            and re.fullmatch(
                r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]{0,24})?",
                cast(str, document["ocr_engine_version"]),
            )
            is not None
            and document.get("ocr_model") in PDF_OCR_MODELS
            and document.get("ocr_page_limit") == MAX_PDF_OCR_PAGES
            and isinstance(page_count, int)
            and not isinstance(page_count, bool)
            and 1 <= page_count <= 200
            and isinstance(ocr_page_count, int)
            and not isinstance(ocr_page_count, bool)
            and 1 <= ocr_page_count <= MAX_PDF_OCR_PAGES
            and isinstance(pages, list)
            and len(pages) == ocr_page_count
            and all(
                isinstance(page, int) and not isinstance(page, bool) and 1 <= page <= page_count
                for page in pages
            )
            and pages == sorted(set(cast(list[int], pages)))
            and document.get("ocr_pixel_limit") == MAX_PDF_OCR_PIXELS
            and isinstance(document.get("ocr_maximum_dimension"), int)
            and not isinstance(document.get("ocr_maximum_dimension"), bool)
            and 300 <= cast(int, document["ocr_maximum_dimension"]) <= 1_600
            and isinstance(document.get("ocr_total_pixels"), int)
            and not isinstance(document.get("ocr_total_pixels"), bool)
            and 1 <= cast(int, document["ocr_total_pixels"]) <= MAX_PDF_OCR_PIXELS
            and isinstance(truncated, bool)
            and (not truncated or (ocr_page_count == MAX_PDF_OCR_PAGES and page_count > 32))
        )

    @staticmethod
    def _safe_asset_filename(object_key: str, object_id: UUID, content_type: str) -> str:
        candidate = PurePosixPath(object_key).name
        if re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._ -]{0,179}", candidate):
            return candidate
        extension = {
            "application/csv": ".csv",
            "application/geo+json": ".geojson",
            "application/json": ".json",
            "application/pdf": ".pdf",
            "application/zip": ".zip",
            "image/png": ".png",
            "text/csv": ".csv",
        }.get(content_type, ".bin")
        return f"{object_id}{extension}"

    @staticmethod
    async def _seal_map_snapshots(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        references: tuple[PublishedResourceReference, ...],
        drafts: tuple[SiteMapSnapshotDraft, ...],
    ) -> tuple[PublishedResourceReference, ...]:
        if len(drafts) > MAX_SITE_SNAPSHOTS:
            raise SiteConflict("site_snapshot_limit_exceeded")
        resource_ids = [draft.resource_id for draft in drafts]
        job_ids = [draft.render_job_id for draft in drafts]
        if len(resource_ids) != len(set(resource_ids)) or len(job_ids) != len(set(job_ids)):
            raise SiteConflict("site_snapshot_duplicate")
        reference_by_id = {reference.resource_id: reference for reference in references}
        if not set(resource_ids) <= set(reference_by_id):
            raise SiteConflict("site_snapshot_reference_not_found")
        if not drafts:
            return references
        rows = await transaction.fetch_all(
            """
            SELECT job.id, job.resource_id, profile.resource_version_id,
                   job.output_object_id, object.s3_version_id,
                   object.content_type, object.size_bytes, object.checksum_sha256,
                   job.width, job.height, job.bbox, job.crs,
                   profile.configuration, profile.checksum_sha256
            FROM app.map_render_jobs job
            JOIN app.map_render_profile_versions profile
              ON profile.organization_id = job.organization_id
             AND profile.profile_id = job.profile_id
             AND profile.id = job.profile_version_id
            JOIN app.data_objects object
              ON object.organization_id = job.organization_id
             AND object.id = job.output_object_id
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.id = ANY(%s::uuid[]) AND job.state = 'completed'
              AND job.format = 'png' AND object.content_type = 'image/png'
            ORDER BY job.id
            """,
            (context.organization_id, project_id, job_ids),
        )
        row_by_job = {cast(UUID, row[0]): row for row in rows}
        if set(job_ids) != set(row_by_job):
            raise SiteConflict("site_snapshot_render_unavailable")
        snapshots: dict[UUID, PublishedMapSnapshot] = {}
        total_size = 0
        for draft in drafts:
            row = row_by_job[draft.render_job_id]
            reference = reference_by_id[draft.resource_id]
            if row[1] != draft.resource_id or row[2] != reference.version_id:
                raise SiteConflict("site_snapshot_version_mismatch")
            saved_map: dict[str, Any] | None = None
            if reference.kind == "map":
                from opengeo_api.rendering import RenderConflict
                from opengeo_api.saved_map_publication import load_saved_map_seal

                try:
                    saved_map = await load_saved_map_seal(
                        transaction,
                        context,
                        project_id,
                        reference.resource_id,
                        reference.version_id,
                        draft.render_job_id,
                        public=True,
                    )
                except RenderConflict as error:
                    raise SiteConflict(error.code) from error
            size_bytes = cast(int, row[6])
            if not 1 <= size_bytes <= MAX_SITE_SNAPSHOT_BYTES:
                raise SiteConflict("site_snapshot_too_large")
            total_size += size_bytes
            snapshots[draft.resource_id] = PublishedMapSnapshot(
                render_job_id=cast(UUID, row[0]),
                output_object_id=cast(UUID, row[3]),
                storage_version_id=cast(str, row[4]),
                content_type=cast(str, row[5]),
                size_bytes=size_bytes,
                checksum_sha256=cast(str, row[7]),
                width=cast(int, row[8]),
                height=cast(int, row[9]),
                bbox=cast(
                    tuple[float, float, float, float],
                    tuple(float(value) for value in cast(list[Any], row[10])),
                ),
                crs=cast(str, row[11]),
                legend=(
                    _legend_from_render_configuration(row[12], row[13])
                    if saved_map is None
                    else None
                ),
                saved_map=saved_map,
            )
        if total_size > MAX_SITE_SNAPSHOT_TOTAL_BYTES:
            raise SiteConflict("site_snapshot_total_too_large")
        return tuple(
            replace(reference, snapshot=snapshots.get(reference.resource_id))
            for reference in references
        )

    @staticmethod
    def _manifest_snapshot(raw: object) -> PublishedMapSnapshot | None:
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise SiteNotFound("site_edition")
        try:
            raw_bbox = raw["bbox"]
            storage_version_id = raw["storageVersionId"]
            content_type = raw["contentType"]
            size_bytes = raw["sizeBytes"]
            checksum = raw["checksumSha256"]
            width = raw["width"]
            height = raw["height"]
            crs = raw["crs"]
            legend = _legend_from_manifest(raw.get("legend"))
            saved_map = raw.get("savedMap")
            if saved_map is not None and (
                not isinstance(saved_map, dict)
                or saved_map.get("schemaVersion") != "opengeo.saved-map-publication.1.0.0"
            ):
                raise ValueError
            if (
                not isinstance(raw_bbox, list)
                or not isinstance(storage_version_id, str)
                or not isinstance(content_type, str)
                or not isinstance(size_bytes, int)
                or isinstance(size_bytes, bool)
                or not isinstance(checksum, str)
                or not isinstance(width, int)
                or isinstance(width, bool)
                or not isinstance(height, int)
                or isinstance(height, bool)
                or not isinstance(crs, str)
            ):
                raise ValueError
            bbox = tuple(float(value) for value in raw_bbox)
            snapshot = PublishedMapSnapshot(
                render_job_id=UUID(str(raw["renderJobId"])),
                output_object_id=UUID(str(raw["outputObjectId"])),
                storage_version_id=storage_version_id,
                content_type=content_type,
                size_bytes=size_bytes,
                checksum_sha256=checksum,
                width=width,
                height=height,
                bbox=cast(tuple[float, float, float, float], bbox),
                crs=crs,
                legend=legend,
                saved_map=saved_map,
            )
        except (KeyError, TypeError, ValueError) as error:
            raise SiteNotFound("site_edition") from error
        if (
            len(snapshot.bbox) != 4
            or not all(isfinite(value) for value in snapshot.bbox)
            or snapshot.bbox[0] >= snapshot.bbox[2]
            or snapshot.bbox[1] >= snapshot.bbox[3]
            or snapshot.content_type != "image/png"
            or not 1 <= snapshot.size_bytes <= MAX_SITE_SNAPSHOT_BYTES
            or not 32 <= snapshot.width <= 4096
            or not 32 <= snapshot.height <= 4096
            or len(snapshot.checksum_sha256) != 64
            or any(character not in "0123456789abcdef" for character in snapshot.checksum_sha256)
            or not 1 <= len(snapshot.storage_version_id) <= 1_024
            or snapshot.crs not in {"CRS:84", "EPSG:3857"}
        ):
            raise SiteNotFound("site_edition")
        return snapshot

    @staticmethod
    async def _lock_site(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
    ) -> tuple[Any, ...]:
        row = await transaction.fetch_one(
            """
            SELECT current_version_id, current_version_number, state::text
            FROM app.project_sites
            WHERE organization_id = %s AND project_id = %s AND id = %s
            FOR UPDATE
            """,
            (context.organization_id, project_id, site_id),
        )
        if row is None:
            raise SiteNotFound("site")
        return row

    @staticmethod
    async def _insert_workflow_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        version_id: UUID,
        version_number: int,
        source_state: SiteState,
        target_state: SiteState,
        reason: str | None,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.project_site_workflow_events
              (id, organization_id, project_id, site_id, site_version_id,
               site_version_number, source_state, target_state, reason, actor_user_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                uuid4(),
                context.organization_id,
                project_id,
                site_id,
                version_id,
                version_number,
                source_state,
                target_state,
                reason,
                context.user_id,
            ),
        )

    @staticmethod
    def _manifest(
        context: TenantContext,
        site: ProjectSite,
        edition_id: UUID,
        edition_number: int,
        published_at: datetime,
        references: tuple[PublishedResourceReference, ...],
        assets: tuple[PublishedSiteAsset, ...],
        destination: SitePublicationDestination,
        unlisted_token: str | None,
    ) -> dict[str, Any]:
        return {
            "schemaVersion": "opengeo.site-edition.1.4.0",
            "rendererVersion": PAGE_RENDERER_VERSION,
            "organizationId": str(context.organization_id),
            "projectId": str(site.project_id),
            "siteId": str(site.site_id),
            "siteSlug": site.slug,
            "siteVersionId": str(site.version_id),
            "siteVersionNumber": site.version_number,
            "editionId": str(edition_id),
            "editionNumber": edition_number,
            "publishedAt": published_at.isoformat().replace("+00:00", "Z"),
            "publication": {
                "reach": destination.reach,
                "listedSlug": (destination.listed_slug if destination.reach == "listed" else None),
                "unlistedToken": unlisted_token,
                "primary": destination.is_primary,
            },
            "title": site.title,
            "language": site.language,
            "theme": site.theme,
            "themeOptions": site.theme_options,
            "printLayout": site.print_layout,
            "pages": [
                {
                    "slug": page.slug,
                    "navigationLabel": page.navigation_label,
                    "position": page.position,
                    "home": page.is_home,
                    "resourceId": str(page.resource_id),
                    "resourceVersionId": str(page.resource_version_id),
                    "resourceVersionNumber": page.resource_version_number,
                    "pageSource": (
                        {
                            "sourceId": str(page.page_source.source_id),
                            "sourceBlockId": page.page_source.source_block_id,
                            "s3VersionId": page.page_source.s3_version_id,
                            "etag": page.page_source.etag,
                            "contentType": page.page_source.content_type,
                            "sizeBytes": page.page_source.size_bytes,
                            "checksumSha256": page.page_source.checksum_sha256,
                            "dialect": page.page_source.dialect,
                            "dialectVersion": page.page_source.dialect_version,
                            "compilerVersion": page.page_source.compiler_version,
                        }
                        if page.page_source is not None
                        else None
                    ),
                }
                for page in site.pages
            ],
            "references": [
                {
                    "resourceId": str(reference.resource_id),
                    "versionId": str(reference.version_id),
                    "versionNumber": reference.version_number,
                    "kind": reference.kind,
                    "wmsServiceId": (
                        str(reference.wms_service_id) if reference.wms_service_id else None
                    ),
                    "wmsLayerName": reference.wms_layer_name,
                    "snapshot": (
                        {
                            "renderJobId": str(reference.snapshot.render_job_id),
                            "outputObjectId": str(reference.snapshot.output_object_id),
                            "storageVersionId": reference.snapshot.storage_version_id,
                            "contentType": reference.snapshot.content_type,
                            "sizeBytes": reference.snapshot.size_bytes,
                            "checksumSha256": reference.snapshot.checksum_sha256,
                            "width": reference.snapshot.width,
                            "height": reference.snapshot.height,
                            "bbox": list(reference.snapshot.bbox),
                            "crs": reference.snapshot.crs,
                            "savedMap": reference.snapshot.saved_map,
                            "legend": (
                                {
                                    "title": reference.snapshot.legend.title,
                                    "profileChecksumSha256": (
                                        reference.snapshot.legend.profile_checksum_sha256
                                    ),
                                    "items": [
                                        {
                                            "label": item.label,
                                            "symbol": item.symbol,
                                            "color": item.color,
                                            "opacity": item.opacity,
                                        }
                                        for item in reference.snapshot.legend.items
                                    ],
                                }
                                if reference.snapshot.legend is not None
                                else None
                            ),
                        }
                        if reference.snapshot is not None
                        else None
                    ),
                }
                for reference in references
            ],
            "assets": [
                {
                    "kind": asset.kind,
                    "datasetId": str(asset.dataset_id),
                    "datasetVersionId": str(asset.dataset_version_id),
                    "objectId": str(asset.object_id),
                    "storageVersionId": asset.storage_version_id,
                    "contentType": asset.content_type,
                    "sizeBytes": asset.size_bytes,
                    "checksumSha256": asset.checksum_sha256,
                    "filename": asset.filename,
                }
                for asset in assets
            ],
            "revocation": {
                "platformRecordIsRevocable": True,
                "downloadedOrPrintedCopiesCannotBeRecalled": True,
            },
        }

    @staticmethod
    def _referenced_resource_ids(pages: tuple[SitePage, ...]) -> set[UUID]:
        result = {page.resource_id for page in pages if page.resource_kind == "map"}
        for page in pages:
            blocks = page.resource_content.get("blocks")
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") not in {"map", "dataset"}:
                    continue
                try:
                    result.add(UUID(str(block.get("resource_id"))))
                except (TypeError, ValueError):
                    raise SiteConflict("site_reference_invalid") from None
        return result

    @staticmethod
    def _referenced_asset_drafts(pages: tuple[SitePage, ...]) -> tuple[SiteAssetDraft, ...]:
        drafts: dict[UUID, SiteAssetDraft] = {}
        for page in pages:
            blocks = page.resource_content.get("blocks")
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") not in {
                    "image",
                    "file",
                    "document",
                }:
                    continue
                try:
                    draft = SiteAssetDraft(
                        kind=cast(Literal["image", "file", "document"], block["type"]),
                        dataset_id=UUID(str(block["dataset_id"])),
                        dataset_version_id=UUID(str(block["dataset_version_id"])),
                        object_id=UUID(str(block["object_id"])),
                    )
                except (KeyError, TypeError, ValueError) as error:
                    raise SiteConflict("site_asset_reference_invalid") from error
                previous = drafts.get(draft.object_id)
                if previous is not None and previous != draft:
                    raise SiteConflict("site_asset_reference_conflict")
                drafts[draft.object_id] = draft
        if len(drafts) > MAX_SITE_ASSETS:
            raise SiteConflict("site_asset_limit_exceeded")
        return tuple(drafts[object_id] for object_id in sorted(drafts, key=str))

    @staticmethod
    def _require_public_release(
        pages: tuple[SitePage, ...],
        references: tuple[PublishedResourceReference, ...],
    ) -> None:
        if not 1 <= len(pages) <= 64 or sum(page.is_home for page in pages) != 1:
            raise SiteConflict("site_pages_invalid")
        if any(
            page.resource_state != "published" or page.resource_visibility != "public"
            for page in pages
        ):
            raise SiteConflict("site_page_not_public")
        if any(
            page.resource_license not in PUBLIC_RELEASE_LICENSES
            or not page.resource_attribution
            or not page.resource_attribution.strip()
            for page in pages
        ):
            raise SiteConflict("site_page_public_rights_incomplete")
        expected = PostgresSitePublicationRepository._referenced_resource_ids(pages)
        if expected != {reference.resource_id for reference in references}:
            raise SiteConflict("site_reference_seal_mismatch")
        reference_by_id = {reference.resource_id: reference for reference in references}
        for page in pages:
            blocks = page.resource_content.get("blocks")
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") not in {"map", "dataset"}:
                    continue
                pinned_version = block.get("resource_version_number")
                if pinned_version is None:
                    continue
                try:
                    reference = reference_by_id[UUID(str(block["resource_id"]))]
                except (KeyError, TypeError, ValueError) as error:
                    raise SiteConflict("site_reference_seal_mismatch") from error
                if (
                    not isinstance(pinned_version, int)
                    or isinstance(pinned_version, bool)
                    or pinned_version != reference.version_number
                ):
                    raise SiteConflict("site_reference_version_drift")
        if any(
            reference.license not in PUBLIC_RELEASE_LICENSES
            or not reference.attribution
            or not reference.attribution.strip()
            for reference in references
        ):
            raise SiteConflict("site_reference_public_rights_incomplete")

    @staticmethod
    def _validate_draft(draft: SiteDraft) -> None:
        if not 1 <= len(draft.pages) <= 64:
            raise SiteConflict("site_page_count_invalid")
        if sum(page.is_home for page in draft.pages) != 1:
            raise SiteConflict("site_home_page_invalid")
        slugs = [page.slug.casefold() for page in draft.pages]
        resources = [page.resource_id for page in draft.pages]
        if len(slugs) != len(set(slugs)):
            raise SiteConflict("site_page_slug_duplicate")
        if len(resources) != len(set(resources)):
            raise SiteConflict("site_page_resource_duplicate")
        try:
            layout = parse_print_layout(draft.print_layout)
        except SiteLayoutError as error:
            raise SiteConflict(str(error)) from error
        if not {page.site_page_slug for page in layout.pages} <= set(slugs):
            raise SiteConflict("site_print_layout_page_not_found")

    @staticmethod
    def _validate_publication_destination(
        reach: PublicationReach,
        listed_slug: str | None,
        is_primary: bool,
    ) -> None:
        if reach not in {"unpublished", "unlisted", "listed"}:
            raise SiteConflict("site_publication_reach_invalid")
        if (
            listed_slug is not None
            and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?", listed_slug) is None
        ):
            raise SiteConflict("site_publication_slug_invalid")
        if reach == "listed" and listed_slug is None:
            raise SiteConflict("site_publication_slug_required")
        if is_primary and reach != "listed":
            raise SiteConflict("site_publication_primary_requires_listed")

    @staticmethod
    def _require_print_layout_release(
        site: ProjectSite,
        references: tuple[PublishedResourceReference, ...],
        assets: tuple[PublishedSiteAsset, ...],
    ) -> None:
        try:
            layout = parse_print_layout(site.print_layout)
            resource_ids = print_layout_resource_ids(site.print_layout)
        except SiteLayoutError as error:
            raise SiteConflict(str(error)) from error
        reference_by_id = {reference.resource_id: reference for reference in references}
        if any(
            resource_id not in reference_by_id
            or reference_by_id[resource_id].kind != "map"
            or reference_by_id[resource_id].snapshot is None
            for resource_id in resource_ids
        ):
            raise SiteConflict("site_print_layout_snapshot_not_sealed")
        page_by_slug = {page.slug: page for page in site.pages}
        asset_by_id = {asset.object_id: asset for asset in assets}
        for layout_page in layout.pages:
            page = page_by_slug.get(layout_page.site_page_slug)
            if page is None:
                raise SiteConflict("site_print_layout_page_not_found")
            raw_blocks = page.resource_content.get("blocks")
            blocks = (
                {
                    block.get("id"): block
                    for block in raw_blocks
                    if isinstance(block, dict) and isinstance(block.get("id"), str)
                }
                if isinstance(raw_blocks, list)
                else {}
            )
            maps = {
                element.element_id: element
                for element in layout_page.elements
                if element.type == "map_frame"
            }
            for element in layout_page.elements:
                if element.type == "legend_frame":
                    target = maps.get(element.map_frame_id or "")
                    reference = (
                        reference_by_id.get(target.resource_id)
                        if target is not None and target.resource_id is not None
                        else None
                    )
                    if (
                        reference is None
                        or reference.snapshot is None
                        or reference.snapshot.legend is None
                    ):
                        raise SiteConflict("site_print_layout_legend_not_sealed")
                if element.block_id is None:
                    continue
                block = blocks.get(element.block_id)
                expected_type = {
                    "image_frame": "image",
                    "table_frame": "table",
                    "chart_frame": "chart",
                }.get(element.type)
                if block is None or block.get("type") != expected_type:
                    raise SiteConflict("site_print_layout_content_block_not_sealed")
                if element.type == "image_frame":
                    try:
                        object_id = UUID(str(block["object_id"]))
                    except (KeyError, TypeError, ValueError) as error:
                        raise SiteConflict("site_print_layout_image_not_sealed") from error
                    asset = asset_by_id.get(object_id)
                    if asset is None or asset.kind != "image" or asset.content_type != "image/png":
                        raise SiteConflict("site_print_layout_image_not_sealed")

    @staticmethod
    def _reference(row: tuple[Any, ...]) -> PublishedResourceReference:
        return PublishedResourceReference(
            resource_id=cast(UUID, row[0]),
            version_id=cast(UUID, row[1]),
            version_number=cast(int, row[2]),
            kind=cast(str, row[3]),
            title=cast(str, row[4]),
            abstract=cast(str | None, row[5]),
            attribution=cast(str | None, row[6]),
            license=cast(str | None, row[7]),
            wms_service_id=cast(UUID | None, row[10]),
            wms_layer_name=cast(str | None, row[11]),
        )

    @staticmethod
    def _edition(row: tuple[Any, ...]) -> SiteEdition:
        manifest = cast(dict[str, Any], row[5])
        return SiteEdition(
            edition_id=cast(UUID, row[0]),
            site_id=cast(UUID, row[1]),
            site_version_id=cast(UUID, row[2]),
            site_version_number=cast(int, row[3]),
            edition_number=cast(int, row[4]),
            manifest=manifest,
            manifest_checksum_sha256=cast(str, row[6]),
            published_by=cast(UUID, row[7]),
            published_at=cast(datetime, row[8]),
            revoked_by=cast(UUID | None, row[9]),
            revoked_at=cast(datetime | None, row[10]),
            publication_reach=(cast(PublicationReach, row[11]) if len(row) > 11 else "listed"),
            listed_slug=(
                cast(str | None, row[12])
                if len(row) > 12
                else cast(str | None, manifest.get("siteSlug"))
            ),
            unlisted_token=cast(str | None, row[13]) if len(row) > 13 else None,
            is_primary=cast(bool, row[14]) if len(row) > 14 else False,
        )

    @staticmethod
    def _public_directory_record(row: tuple[Any, ...]) -> PublicSiteDirectoryRecord:
        return PublicSiteDirectoryRecord(
            project_id=cast(UUID, row[0]),
            project_name=cast(str, row[1]),
            site_id=cast(UUID, row[2]),
            edition_id=cast(UUID, row[3]),
            listed_slug=cast(str, row[4]),
            title=cast(str, row[5]),
            description=cast(str | None, row[6]),
            language=cast(str, row[7]),
            theme=cast(str, row[8]),
            page_count=cast(int, row[9]),
            published_at=cast(datetime, row[10]),
            is_primary=cast(bool, row[11]),
        )

    @staticmethod
    def _edition_select() -> str:
        return """
            SELECT edition.id, edition.site_id, edition.site_version_id,
                   edition.site_version_number, edition.edition_number,
                   edition.manifest, edition.manifest_checksum_sha256,
                   edition.published_by, edition.published_at,
                   edition.revoked_by, edition.revoked_at,
                   edition.publication_reach::text, edition.listed_slug,
                   edition.unlisted_token, edition.is_primary
            FROM app.project_site_editions edition
        """

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
            raise SiteAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise SiteNotFound("project")
        return Roles(
            organization=cast(OrganizationRole, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise SiteAccessDenied("action forbidden") from error

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        event_type: str,
        resource_id: UUID,
        request_id: str,
        payload: dict[str, Any],
        *,
        resource_type: str = "project_site",
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )
