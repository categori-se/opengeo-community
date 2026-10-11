import asyncio
from collections import deque
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderAccessDenied,
    RenderConflict,
    RenderLayerSelection,
    RenderNotFound,
    RenderProfileDraft,
    RenderRequest,
    SealedRenderOutput,
    render_request_checksum,
)
from opengeo_api.s3_downloads import DownloadSpec, DownloadTicket, ExactObject, ExactObjectSpec
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-0000000000d1")
ORG_ID = UUID("10000000-0000-4000-8000-0000000000d1")
PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000d1")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000d1")
RESOURCE_ID_2 = UUID("a0000000-0000-4000-8000-0000000000d2")
RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-0000000000d1")
DATASET_ID = UUID("80000000-0000-4000-8000-0000000000d1")
DATASET_VERSION_ID = UUID("81000000-0000-4000-8000-0000000000d1")
STYLE_ID = UUID("a2000000-0000-4000-8000-0000000000d1")
STYLE_VERSION_ID = UUID("a3000000-0000-4000-8000-0000000000d1")
PROFILE_ID = UUID("a4000000-0000-4000-8000-0000000000d1")
PROFILE_VERSION_ID = UUID("a5000000-0000-4000-8000-0000000000d1")
PROFILE_ID_2 = UUID("a4000000-0000-4000-8000-0000000000d2")
PROFILE_VERSION_ID_2 = UUID("a5000000-0000-4000-8000-0000000000d2")
PUBLICATION_ID = UUID("a9000000-0000-4000-8000-0000000000d1")
PUBLICATION_ID_2 = UUID("a9000000-0000-4000-8000-0000000000d2")
PUBLIC_SERVICE_ID = UUID("aa000000-0000-4000-8000-0000000000d1")
JOB_ID = UUID("a6000000-0000-4000-8000-0000000000d1")
OUTPUT_ID = UUID("a7000000-0000-4000-8000-0000000000d1")
NOW = datetime(2026, 8, 20, 15, tzinfo=UTC)


def style_definition() -> str:
    return (
        '{"version":8,"sources":{},"layers":['
        '{"id":"roads","type":"line","paint":{"line-color":"#275d52",'
        '"line-width":3}},'
        '{"id":"labels","type":"symbol","layout":{"text-field":["get","name"]},'
        '"paint":{"text-color":"#172824"}}]}'
    )


def profile_row(
    *,
    resource_id: UUID = RESOURCE_ID,
    profile_id: UUID = PROFILE_ID,
    title: str = "Roads SVG",
) -> tuple[Any, ...]:
    return (
        profile_id,
        PROJECT_ID,
        resource_id,
        "roads-svg",
        1,
        title,
        RESOURCE_VERSION_ID,
        DATASET_ID,
        DATASET_VERSION_ID,
        STYLE_ID,
        STYLE_VERSION_ID,
        {"schema": "opengeo.render.v1"},
        "c" * 64,
        None,
        USER_ID,
        NOW,
        NOW,
    )


def composition_profile_row(
    *,
    resource_id: UUID = RESOURCE_ID,
    profile_id: UUID = PROFILE_ID,
    title: str = "Roads SVG",
    text: bool = False,
) -> tuple[Any, ...]:
    row = list(profile_row(resource_id=resource_id, profile_id=profile_id, title=title))
    row[11] = {
        "schema": "opengeo.render.v1",
        "label": {"field": "name"} if text else None,
        "legend": {"enabled": text},
    }
    return tuple(row)


def publication_row(
    *,
    publication_id: UUID = PUBLICATION_ID,
    resource_id: UUID = RESOURCE_ID,
    name: str = "cite:RoadSegments",
    default_profile_id: UUID = PROFILE_ID,
    withdrawn: bool = False,
) -> tuple[Any, ...]:
    return (
        publication_id,
        PROJECT_ID,
        resource_id,
        name,
        default_profile_id,
        USER_ID,
        NOW,
        USER_ID if withdrawn else None,
        NOW if withdrawn else None,
    )


def public_service_row(*, disabled: bool = False) -> tuple[Any, ...]:
    return (
        PUBLIC_SERVICE_ID,
        PROJECT_ID,
        "Public research maps",
        USER_ID,
        NOW,
        USER_ID if disabled else None,
        NOW if disabled else None,
    )


def job_row(state: str = "queued") -> tuple[Any, ...]:
    completed = state == "completed"
    return (
        JOB_ID,
        PROJECT_ID,
        RESOURCE_ID,
        PROFILE_ID,
        PROFILE_VERSION_ID,
        1,
        DATASET_ID,
        DATASET_VERSION_ID,
        STYLE_ID,
        STYLE_VERSION_ID,
        [-71.2, 42.3, -71.0, 42.5],
        "CRS:84",
        800,
        600,
        "svg",
        None,
        False,
        "d" * 64,
        state,
        1 if completed else 0,
        OUTPUT_ID if completed else None,
        "image/svg+xml" if completed else None,
        4096 if completed else None,
        "e" * 64 if completed else None,
        None,
        USER_ID,
        NOW,
        NOW if completed else None,
        NOW if completed else None,
    )


class Transaction:
    def __init__(
        self,
        one: list[tuple[Any, ...] | None],
        all_rows: list[list[tuple[Any, ...]]] | None = None,
    ) -> None:
        self.one = deque(one)
        self.all_rows = deque(all_rows or [])
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.queries.append((statement, tuple(parameters)))
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.queries.append((statement, tuple(parameters)))
        return self.all_rows.popleft() if self.all_rows else []

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class Executor:
    def __init__(self, transaction: Transaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        del context
        return await operation(self.transaction)


class Downloads:
    def __init__(self, body: bytes = b"<svg/>") -> None:
        self.body = body
        self.specs: list[DownloadSpec] = []
        self.exact_specs: list[ExactObjectSpec] = []

    async def create_download_url(self, spec: DownloadSpec) -> DownloadTicket:
        self.specs.append(spec)
        return DownloadTicket("https://example.test/output.svg", "GET", NOW + timedelta(minutes=5))

    async def read_exact_object(self, spec: ExactObjectSpec) -> ExactObject:
        self.exact_specs.append(spec)
        return ExactObject(
            body=self.body,
            content_type=spec.content_type,
            size_bytes=spec.size_bytes,
            checksum_sha256=spec.checksum_sha256,
            version_id=spec.version_id,
        )


def repository(transaction: Transaction, downloads: Downloads | None = None):
    return PostgresRenderRepository(Executor(transaction), downloads or Downloads())  # type: ignore[arg-type]


def test_profile_creation_compiles_and_persists_an_exact_version_snapshot() -> None:
    definition = style_definition()
    transaction = Transaction(
        [
            ("member", "editor", None, False),
            (
                RESOURCE_VERSION_ID,
                DATASET_ID,
                DATASET_VERSION_ID,
                STYLE_ID,
                STYLE_VERSION_ID,
                4,
                definition,
                sha256(definition.encode()).hexdigest(),
            ),
            profile_row(),
        ]
    )

    record = asyncio.run(
        repository(transaction).create_profile(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            RenderProfileDraft(
                "roads-svg",
                "Roads SVG",
                STYLE_ID,
                "roads",
                "labels",
                None,
                2_000_000,
                True,
            ),
            "render-profile-create",
        )
    )

    assert record.profile_id == PROFILE_ID
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "map_render_profiles" in statements
    assert "map_render_profile_versions" in statements
    assert "activity_events" in statements
    version_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.map_render_profile_versions" in statement
    )
    configuration = version_parameters[11].obj
    assert configuration["renderer"] == "opengeo.deterministic-svg.v2"
    assert configuration["label"]["font"] == "opengeo-uppercase-5x7-v1"
    assert configuration["source_style"]["style_version_number"] == 4
    assert (
        version_parameters[12]
        == sha256(
            __import__("json").dumps(configuration, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
    )


def test_map_collection_discovery_uses_governed_extent_and_render_read_authorization() -> None:
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            (
                RESOURCE_ID,
                "roads",
                "Road network",
                "Curated road centerlines",
                "Open data office",
                [-71.2, 42.3, -71.0, 42.5],
                NOW,
                NOW,
            ),
        ]
    )

    collection = asyncio.run(
        repository(transaction).get_map_collection(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID
        )
    )

    assert collection.resource_id == RESOURCE_ID
    assert collection.slug == "roads"
    assert collection.spatial_extent == (-71.2, 42.3, -71.0, 42.5)
    assert collection.attribution == "Open data office"
    assert transaction.executions == []


def test_project_map_catalog_is_project_authorized_and_preserves_layer_order() -> None:
    transaction = Transaction(
        [("member", "viewer", "Research maps")],
        [
            [
                (
                    *publication_row(),
                    "roads",
                    "A roads",
                    "Road centerlines",
                    "Open data office",
                    [-71.2, 42.3, -71.0, 42.5],
                    NOW,
                    NOW,
                ),
                (
                    *publication_row(
                        publication_id=PUBLICATION_ID_2,
                        resource_id=RESOURCE_ID_2,
                        name="cite:Lakes",
                        default_profile_id=PROFILE_ID_2,
                    ),
                    "water",
                    "B water",
                    "Water polygons",
                    None,
                    [-71.3, 42.2, -70.9, 42.6],
                    None,
                    None,
                ),
            ],
            [
                composition_profile_row(),
                composition_profile_row(
                    resource_id=RESOURCE_ID_2,
                    profile_id=PROFILE_ID_2,
                    title="Water SVG",
                ),
            ],
        ],
    )

    catalog = asyncio.run(
        repository(transaction).get_project_map_catalog(TenantContext(USER_ID, ORG_ID), PROJECT_ID)
    )

    assert catalog.title == "Research maps"
    assert [layer.publication.name for layer in catalog.layers] == [
        "cite:RoadSegments",
        "cite:Lakes",
    ]
    assert [layer.collection.resource_id for layer in catalog.layers] == [
        RESOURCE_ID,
        RESOURCE_ID_2,
    ]
    assert [layer.profiles[0].profile_id for layer in catalog.layers] == [
        PROFILE_ID,
        PROFILE_ID_2,
    ]
    assert catalog.layers[1].collection.spatial_extent == (-71.3, 42.2, -70.9, 42.6)
    catalog_query = transaction.queries[1][0]
    assert "app.wms_layer_publications" in catalog_query
    assert "publication.withdrawn_at IS NULL" in catalog_query
    assert "resource.state = 'published'" in catalog_query
    assert transaction.executions == []


def test_public_map_catalog_never_reads_membership_and_filters_every_publication() -> None:
    transaction = Transaction(
        [public_service_row()],
        [
            [
                (
                    *publication_row(),
                    "roads",
                    "Roads",
                    "Public road centerlines",
                    "Open data office",
                    [-71.2, 42.3, -71.0, 42.5],
                    NOW,
                    NOW,
                )
            ],
            [profile_row()],
        ],
    )

    catalog = asyncio.run(
        repository(transaction).get_public_project_map_catalog(
            TenantContext(UUID(int=0), ORG_ID), PROJECT_ID, PUBLIC_SERVICE_ID
        )
    )

    assert catalog.title == "Public research maps"
    assert [layer.publication.name for layer in catalog.layers] == ["cite:RoadSegments"]
    statements = "\n".join(statement for statement, _ in transaction.queries)
    assert "app.organization_memberships" not in statements
    assert "publication.withdrawn_at IS NULL" in statements
    assert "resource.state = 'published'" in statements
    assert "resource.visibility = 'public'" in statements
    assert "public_service.disabled_at IS NULL" in statements
    assert transaction.executions == []


def test_public_wms_service_creation_is_owner_managed_idempotent_and_audited() -> None:
    transaction = Transaction(
        [
            ("member", "owner", "Research maps"),
            None,
            public_service_row(),
        ]
    )

    record = asyncio.run(
        repository(transaction).create_public_wms_service(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            "Public research maps",
            "create-public-wms",
        )
    )

    assert record.service_id == PUBLIC_SERVICE_ID
    insert = next(
        item for item in transaction.queries if "INSERT INTO app.public_wms_services" in item[0]
    )
    assert insert[1][1:] == (ORG_ID, PROJECT_ID, "Public research maps", USER_ID)
    assert len(transaction.executions) == 1
    event_statement, event_parameters = transaction.executions[0]
    assert "'public_wms_service'" in event_statement
    assert event_parameters[3:6] == (
        "map.wms.public_service.created",
        PUBLIC_SERVICE_ID,
        "create-public-wms",
    )


def test_public_wms_service_disable_is_one_way_actor_attributed_and_audited() -> None:
    transaction = Transaction(
        [
            ("member", "owner", "Research maps"),
            public_service_row(),
            public_service_row(disabled=True),
        ]
    )

    record = asyncio.run(
        repository(transaction).disable_public_wms_service(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            "disable-public-wms",
        )
    )

    assert record.disabled_by == USER_ID
    assert record.disabled_at == NOW
    update = transaction.queries[-1]
    assert "UPDATE app.public_wms_services" in update[0]
    assert update[1] == (USER_ID, ORG_ID, PROJECT_ID, PUBLIC_SERVICE_ID)
    assert "map.wms.public_service.disabled" in transaction.executions[0][1]


def test_wms_publication_creation_is_publish_authorized_race_safe_and_audited() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            None,
            publication_row(),
        ]
    )

    record = asyncio.run(
        repository(transaction).create_wms_publication(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            "cite:RoadSegments",
            PROFILE_ID,
            "publish-wms-layer",
        )
    )

    assert record.name == "cite:RoadSegments"
    insert = transaction.queries[-1]
    assert "INSERT INTO app.wms_layer_publications" in insert[0]
    assert "resource.state = 'published'" in insert[0]
    assert "version.id = profile.current_version_id" in insert[0]
    assert insert[1][-3:] == (ORG_ID, PROJECT_ID, RESOURCE_ID)
    assert len(transaction.executions) == 1
    assert "map.wms.publication.created" in transaction.executions[0][1]


def test_wms_publication_creation_is_idempotent_for_one_exact_active_identity() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            publication_row(),
        ]
    )

    record = asyncio.run(
        repository(transaction).create_wms_publication(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            "cite:RoadSegments",
            PROFILE_ID,
            "retry-publication",
        )
    )

    assert record.publication_id == PUBLICATION_ID
    assert not any(
        "INSERT INTO app.wms_layer_publications" in query for query, _ in transaction.queries
    )
    assert transaction.executions == []


def test_wms_publication_denies_viewer_before_lookup_or_write() -> None:
    transaction = Transaction([("member", "viewer", None, False)])

    with pytest.raises(RenderAccessDenied, match="action forbidden"):
        asyncio.run(
            repository(transaction).create_wms_publication(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                "cite:RoadSegments",
                PROFILE_ID,
                "denied-publication",
            )
        )

    assert len(transaction.queries) == 1
    assert transaction.executions == []


def test_wms_publication_withdrawal_is_actor_attributed_and_audited() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            publication_row(),
            publication_row(withdrawn=True),
        ]
    )

    record = asyncio.run(
        repository(transaction).withdraw_wms_publication(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            PUBLICATION_ID,
            "withdraw-wms-layer",
        )
    )

    assert record.withdrawn_by == USER_ID
    assert record.withdrawn_at == NOW
    update = transaction.queries[-1]
    assert "UPDATE app.wms_layer_publications" in update[0]
    assert update[1] == (USER_ID, ORG_ID, PROJECT_ID, RESOURCE_ID, PUBLICATION_ID)
    assert "map.wms.publication.withdrawn" in transaction.executions[0][1]


def test_render_request_is_idempotent_and_snapshots_current_profile_version() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            profile_row(),
            None,
            (UUID("b0000000-0000-4000-8000-0000000000d1"),),
            job_row(),
        ]
    )

    submission = asyncio.run(
        repository(transaction).request_render(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            PROFILE_ID,
            RenderRequest(
                UUID("a8000000-0000-4000-8000-0000000000d1"),
                (-71.2, 42.3, -71.0, 42.5),
                "CRS:84",
                800,
                600,
                "svg",
            ),
            "render-request",
        )
    )

    assert submission.dispatch_required is True
    assert submission.job.profile_version_id == PROFILE_VERSION_ID
    insert = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.map_render_jobs" in statement
    )
    assert insert[4] == UUID("a8000000-0000-4000-8000-0000000000d1")
    assert insert[5].obj == [-71.2, 42.3, -71.0, 42.5]
    assert insert[6] == "CRS:84"
    assert insert[10] is None
    assert insert[11] is False
    assert insert[-2:] == (1, "c" * 64)


def test_composite_render_reauthorizes_and_seals_exact_ordered_profile_snapshots() -> None:
    request = RenderRequest(
        UUID("a8000000-0000-4000-8000-0000000000d2"),
        (-71.2, 42.3, -71.0, 42.5),
        "CRS:84",
        800,
        600,
        "svg",
    )
    first = composition_profile_row(text=True)
    second = composition_profile_row(
        resource_id=RESOURCE_ID_2,
        profile_id=PROFILE_ID_2,
        title="Water SVG",
        text=True,
    )
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            first,
            ("member", None, "publish", False),
            second,
            None,
            (UUID("b0000000-0000-4000-8000-0000000000d1"),),
            (UUID("b0000000-0000-4000-8000-0000000000d2"),),
            (True,),
            job_row(),
        ]
    )

    submission = asyncio.run(
        repository(transaction).request_composite_render(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            (
                RenderLayerSelection(RESOURCE_ID, PROFILE_ID, 1),
                RenderLayerSelection(RESOURCE_ID_2, PROFILE_ID_2, 1),
            ),
            request,
            "render-composition",
        )
    )

    assert submission.dispatch_required is True
    assert submission.job.resource_id == RESOURCE_ID
    job_statement, job_parameters = next(
        item for item in transaction.executions if "INSERT INTO app.map_render_jobs" in item[0]
    )
    assert "version.version_number = %s" in job_statement
    assert job_parameters[-2:] == (1, "c" * 64)
    assert job_parameters[12] == render_request_checksum(
        tuple(repository(transaction)._profile(row) for row in (first, second)), request
    )
    layer_statement, layer_parameters = next(
        item
        for item in transaction.executions
        if "INSERT INTO app.map_render_job_layers" in item[0]
    )
    assert "version.checksum_sha256 = %s" in layer_statement
    assert layer_parameters[2] == 2
    assert layer_parameters[5:7] == (RESOURCE_ID_2, PROFILE_ID_2)
    assert layer_parameters[-2:] == (1, "c" * 64)
    assert "map.render.composition.queued" in transaction.executions[-1][1]


def test_composite_render_denies_before_writes_if_any_layer_lacks_request_authority() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            composition_profile_row(),
            ("member", "viewer", None, False),
        ]
    )

    with pytest.raises(RenderAccessDenied, match="action forbidden"):
        asyncio.run(
            repository(transaction).request_composite_render(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (
                    RenderLayerSelection(RESOURCE_ID, PROFILE_ID, 1),
                    RenderLayerSelection(RESOURCE_ID_2, PROFILE_ID_2, 1),
                ),
                RenderRequest(
                    UUID("a8000000-0000-4000-8000-0000000000d3"),
                    (-71.2, 42.3, -71.0, 42.5),
                    "CRS:84",
                    800,
                    600,
                    "svg",
                ),
                "denied-composition",
            )
        )

    assert transaction.executions == []


def test_read_only_collaborator_cannot_trigger_cost_incurring_render_work() -> None:
    transaction = Transaction([("member", "viewer", None, False)])

    with pytest.raises(RenderAccessDenied, match="action forbidden"):
        asyncio.run(
            repository(transaction).request_render(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                PROFILE_ID,
                RenderRequest(
                    UUID("a8000000-0000-4000-8000-0000000000d1"),
                    (-71.2, 42.3, -71.0, 42.5),
                    "CRS:84",
                    800,
                    600,
                    "svg",
                ),
                "denied-render",
            )
        )
    assert transaction.executions == []


def test_read_only_collaborator_can_reuse_an_existing_deterministic_render() -> None:
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            job_row("completed"),
        ]
    )

    record = asyncio.run(
        repository(transaction).find_job_by_idempotency(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            UUID("a8000000-0000-4000-8000-0000000000d1"),
        )
    )

    assert record is not None
    assert record.job_id == JOB_ID
    assert record.state == "completed"
    assert transaction.executions == []


def test_map_request_fails_closed_if_the_profile_changes_before_queueing() -> None:
    transaction = Transaction(
        [
            ("member", None, "publish", False),
            profile_row(),
        ]
    )

    with pytest.raises(RenderConflict, match="render_profile_version_changed") as raised:
        asyncio.run(
            repository(transaction).request_render(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                PROFILE_ID,
                RenderRequest(
                    UUID("a8000000-0000-4000-8000-0000000000d1"),
                    (-71.2, 42.3, -71.0, 42.5),
                    "CRS:84",
                    800,
                    600,
                    "svg",
                    expected_profile_version=2,
                ),
                "stale-map-request",
            )
        )

    assert raised.value.current_version == 1
    assert transaction.executions == []


def test_completed_output_download_is_exact_version_signed_rechecked_and_audited() -> None:
    key = "organizations/example/derivatives/renders/output.svg"
    target = (
        "opengeo-geodata",
        key,
        "s3-version-1",
        "roads-output.svg",
        OUTPUT_ID,
        "image/svg+xml",
        4096,
        "e" * 64,
    )
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            target,
            ("member", "viewer", None, False),
            target,
        ]
    )
    downloads = Downloads()

    ticket = asyncio.run(
        repository(transaction, downloads).request_download(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            JOB_ID,
            "render-download",
        )
    )

    assert ticket.method == "GET"
    assert downloads.specs == [
        DownloadSpec("opengeo-geodata", key, "s3-version-1", "roads-output.svg")
    ]
    assert len(transaction.executions) == 1
    assert "map.render.download.issued" in transaction.executions[0][1]


def test_completed_map_body_is_bounded_exact_version_rechecked_and_audited() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    checksum = sha256(body).hexdigest()
    key = "organizations/example/derivatives/renders/output.svg"
    target = (
        "opengeo-geodata",
        key,
        "s3-version-1",
        "roads-output.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            target,
            ("member", "viewer", None, False),
            target,
        ]
    )
    downloads = Downloads(body)

    output = asyncio.run(
        repository(transaction, downloads).read_map_output(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            JOB_ID,
            4_194_304,
            "map-body-read",
        )
    )

    assert output.body == body
    assert output.filename == "roads-output.svg"
    assert output.checksum_sha256 == checksum
    assert downloads.exact_specs == [
        ExactObjectSpec(
            "opengeo-geodata",
            key,
            "s3-version-1",
            "image/svg+xml",
            len(body),
            checksum,
            4_194_304,
        )
    ]
    assert len(transaction.executions) == 1
    assert "map.render.served" in transaction.executions[0][1]


def test_public_completed_map_body_is_policy_checked_twice_without_actor_audit() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>'
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/public.svg",
        "s3-version-public",
        "roads-public.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    transaction = Transaction([(1,), target, (1,), target])
    downloads = Downloads(body)

    output = asyncio.run(
        repository(transaction, downloads).read_public_map_output(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            RESOURCE_ID,
            JOB_ID,
            4_194_304,
        )
    )

    assert output.body == body
    assert output.version_id == "s3-version-public"
    public_checks = [
        statement
        for statement, _ in transaction.queries
        if "FROM app.public_wms_services service" in statement
    ]
    assert len(public_checks) == 2
    assert all("publication.withdrawn_at IS NULL" in statement for statement in public_checks)
    assert all("resource.visibility = 'public'" in statement for statement in public_checks)
    assert len(downloads.exact_specs) == 1
    assert transaction.executions == []


def test_public_completed_map_body_fails_closed_if_publication_is_withdrawn_during_read() -> None:
    body = b"<svg/>"
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/public.svg",
        "s3-version-public",
        "roads-public.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    transaction = Transaction([(1,), target, None])
    downloads = Downloads(body)

    with pytest.raises(RenderNotFound, match="public_wms_layer"):
        asyncio.run(
            repository(transaction, downloads).read_public_map_output(
                TenantContext(UUID(int=0), ORG_ID),
                PROJECT_ID,
                PUBLIC_SERVICE_ID,
                RESOURCE_ID,
                JOB_ID,
                4_194_304,
            )
        )

    assert len(downloads.exact_specs) == 1
    assert transaction.executions == []


def test_site_sealed_map_body_requires_exact_object_version_and_checksum_twice() -> None:
    body = b"\x89PNG\r\n\x1a\nsealed"
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/site.png",
        "s3-version-site",
        "roads-site.png",
        OUTPUT_ID,
        "image/png",
        len(body),
        checksum,
    )
    seal = SealedRenderOutput(
        output_object_id=OUTPUT_ID,
        storage_version_id="s3-version-site",
        content_type="image/png",
        size_bytes=len(body),
        checksum_sha256=checksum,
    )
    transaction = Transaction([target, target])
    downloads = Downloads(body)

    output = asyncio.run(
        repository(transaction, downloads).read_sealed_map_output(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            JOB_ID,
            seal,
            4_194_304,
        )
    )

    assert output.body == body
    assert len(transaction.queries) == 2
    assert len(downloads.exact_specs) == 1
    assert transaction.executions == []


def test_site_sealed_map_body_rejects_tampered_manifest_before_storage_read() -> None:
    body = b"\x89PNG\r\n\x1a\nsealed"
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/site.png",
        "s3-version-site",
        "roads-site.png",
        OUTPUT_ID,
        "image/png",
        len(body),
        checksum,
    )
    downloads = Downloads(body)

    with pytest.raises(RenderConflict, match="render_output_changed"):
        asyncio.run(
            repository(Transaction([target]), downloads).read_sealed_map_output(
                TenantContext(UUID(int=0), ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                JOB_ID,
                SealedRenderOutput(
                    output_object_id=OUTPUT_ID,
                    storage_version_id="wrong-version",
                    content_type="image/png",
                    size_bytes=len(body),
                    checksum_sha256=checksum,
                ),
                4_194_304,
            )
        )

    assert downloads.exact_specs == []


def test_public_job_lookup_is_cache_only_and_has_no_membership_or_write_query() -> None:
    transaction = Transaction([(1,), job_row("completed")])

    record = asyncio.run(
        repository(transaction).find_public_job_by_idempotency(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            RESOURCE_ID,
            UUID("a8000000-0000-4000-8000-0000000000d1"),
        )
    )

    assert record is not None and record.state == "completed"
    statements = "\n".join(statement for statement, _ in transaction.queries)
    assert "app.organization_memberships" not in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements
    assert "NOT job.composition_sealed" in statements
    assert transaction.executions == []


def test_public_composite_lookup_requires_exact_ordered_public_layers_without_writes() -> None:
    transaction = Transaction(
        [job_row("completed"), (1,), (1,)],
        [[(1, RESOURCE_ID), (2, RESOURCE_ID_2)]],
    )

    record = asyncio.run(
        repository(transaction).find_public_composite_job_by_idempotency(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            (RESOURCE_ID, RESOURCE_ID_2),
            UUID("a8000000-0000-4000-8000-0000000000d1"),
        )
    )

    assert record is not None and record.state == "completed"
    statements = "\n".join(statement for statement, _ in transaction.queries)
    assert "app.organization_memberships" not in statements
    assert "job.composition_sealed" in statements
    assert "ORDER BY layer.position" in statements
    assert statements.count("FROM app.public_wms_services service") == 2
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements
    assert transaction.executions == []


def test_public_composite_lookup_rejects_a_different_requested_layer_order() -> None:
    transaction = Transaction(
        [job_row("completed")],
        [[(1, RESOURCE_ID), (2, RESOURCE_ID_2)]],
    )

    with pytest.raises(RenderNotFound, match="public_wms_layer"):
        asyncio.run(
            repository(transaction).find_public_composite_job_by_idempotency(
                TenantContext(UUID(int=0), ORG_ID),
                PROJECT_ID,
                PUBLIC_SERVICE_ID,
                (RESOURCE_ID_2, RESOURCE_ID),
                UUID("a8000000-0000-4000-8000-0000000000d1"),
            )
        )

    assert not any(
        "FROM app.public_wms_services service" in statement for statement, _ in transaction.queries
    )
    assert transaction.executions == []


def test_public_composite_body_rechecks_every_layer_before_and_after_exact_read() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/public-composition.svg",
        "s3-version-public-composition",
        "roads-public-composition.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    transaction = Transaction(
        [(1,), (1,), target, (1,), (1,), target],
        [
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
        ],
    )
    downloads = Downloads(body)

    output = asyncio.run(
        repository(transaction, downloads).read_public_composite_map_output(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            (RESOURCE_ID, RESOURCE_ID_2),
            JOB_ID,
            4_194_304,
        )
    )

    assert output.body == body
    assert output.version_id == "s3-version-public-composition"
    public_checks = [
        statement
        for statement, _ in transaction.queries
        if "FROM app.public_wms_services service" in statement
    ]
    assert len(public_checks) == 4
    assert all("resource.visibility = 'public'" in statement for statement in public_checks)
    composition_checks = [
        statement for statement, _ in transaction.queries if "ORDER BY layer.position" in statement
    ]
    assert len(composition_checks) == 2
    assert len(downloads.exact_specs) == 1
    assert transaction.executions == []


def test_public_composite_signed_download_rechecks_every_layer_without_actor_audit() -> None:
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/public-composition.svg",
        "s3-version-public-composition",
        "roads-public-composition.svg",
        OUTPUT_ID,
        "image/svg+xml",
        4096,
        "e" * 64,
    )
    transaction = Transaction(
        [(1,), (1,), target, (1,), (1,), target],
        [
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
        ],
    )
    downloads = Downloads()

    ticket = asyncio.run(
        repository(transaction, downloads).request_public_composite_download(
            TenantContext(UUID(int=0), ORG_ID),
            PROJECT_ID,
            PUBLIC_SERVICE_ID,
            (RESOURCE_ID, RESOURCE_ID_2),
            JOB_ID,
        )
    )

    assert ticket.method == "GET"
    assert downloads.specs == [
        DownloadSpec(
            "opengeo-geodata",
            "organizations/example/derivatives/renders/public-composition.svg",
            "s3-version-public-composition",
            "roads-public-composition.svg",
        )
    ]
    public_checks = [
        statement
        for statement, _ in transaction.queries
        if "FROM app.public_wms_services service" in statement
    ]
    assert len(public_checks) == 4
    assert transaction.executions == []


def test_composite_map_body_reauthorizes_every_layer_before_and_after_exact_read() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/composition.svg",
        "s3-version-composition",
        "roads-composition.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    allowed = ("member", "viewer", None, False)
    transaction = Transaction(
        [
            allowed,
            allowed,
            (RESOURCE_ID,),
            target,
            allowed,
            allowed,
            (RESOURCE_ID,),
            target,
        ],
        [
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
            [(1, RESOURCE_ID), (2, RESOURCE_ID_2)],
        ],
    )
    downloads = Downloads(body)

    output = asyncio.run(
        repository(transaction, downloads).read_composite_map_output(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            JOB_ID,
            4_194_304,
            "composition-body-read",
        )
    )

    assert output.body == body
    assert len(downloads.exact_specs) == 1
    assert len(transaction.executions) == 1
    assert "map.render.composition.served" in transaction.executions[0][1]
    assert not transaction.one
    assert not transaction.all_rows


def test_completed_map_body_fails_closed_if_output_changes_during_read() -> None:
    body = b"<svg/>"
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/output.svg",
        "s3-version-1",
        "roads-output.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    changed = (*target[:2], "s3-version-2", *target[3:])
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            target,
            ("member", "viewer", None, False),
            changed,
        ]
    )

    with pytest.raises(RenderConflict, match="render_output_changed"):
        asyncio.run(
            repository(transaction, Downloads(body)).read_map_output(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                JOB_ID,
                4_194_304,
                "map-body-read",
            )
        )

    assert transaction.executions == []


def test_completed_map_body_fails_closed_if_read_access_is_revoked_during_read() -> None:
    body = b"<svg/>"
    checksum = sha256(body).hexdigest()
    target = (
        "opengeo-geodata",
        "organizations/example/derivatives/renders/output.svg",
        "s3-version-1",
        "roads-output.svg",
        OUTPUT_ID,
        "image/svg+xml",
        len(body),
        checksum,
    )
    transaction = Transaction(
        [
            ("member", "viewer", None, False),
            target,
            ("member", None, None, False),
        ]
    )
    downloads = Downloads(body)

    with pytest.raises(RenderAccessDenied, match="action forbidden"):
        asyncio.run(
            repository(transaction, downloads).read_map_output(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                JOB_ID,
                4_194_304,
                "map-body-read",
            )
        )

    assert len(downloads.exact_specs) == 1
    assert transaction.executions == []
