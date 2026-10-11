import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from opengeo_api.features import (
    AttributeQueryStep,
    FeatureCollection,
    FeaturePage,
    PostgresFeatureRepository,
    SpatialQueryStep,
)
from opengeo_api.tenant_database import TenantContext

NOW = datetime(2026, 8, 29, 12, tzinfo=UTC)


class ConcurrentQueryTransaction:
    def __init__(
        self,
        *,
        organization_id: UUID,
        user_id: UUID,
        project_id: UUID,
        dataset_id: UUID,
        feature_base: int,
        number_matched: int = 10_000,
    ) -> None:
        self.organization_id = organization_id
        self.user_id = user_id
        self.project_id = project_id
        self.dataset_id = dataset_id
        self.feature_base = feature_base
        self.number_matched = number_matched
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        values = tuple(parameters)
        self.calls.append(("one", statement, values))
        if "FROM app.organization_memberships" in statement:
            assert values == (
                self.user_id,
                self.project_id,
                self.dataset_id,
                self.organization_id,
                self.user_id,
            )
            return ("member", "viewer", None, False, "active", "geojson")
        if "FROM app.feature_collections" in statement:
            assert values[:2] == (self.organization_id, self.dataset_id)
            return (
                self.dataset_id,
                "Point",
                {
                    "schemaVersion": "1.0.0",
                    "fields": [
                        {"name": "name", "type": "string", "required": True},
                        {"name": "priority", "type": "integer", "required": True},
                    ],
                },
                7,
                self.number_matched,
                self.user_id,
                NOW,
                self.user_id,
                NOW,
            )
        assert "SELECT count(*)::bigint" in statement
        assert values[0:2] == (self.organization_id, self.dataset_id)
        return (self.number_matched,)

    async def fetch_all(self, statement: str, parameters=()):
        values = tuple(parameters)
        self.calls.append(("all", statement, values))
        assert "ORDER BY feature.id" in statement
        assert values[0:2] == (self.organization_id, self.dataset_id)
        limit, offset = values[-2:]
        return [
            (
                UUID(int=self.feature_base + index),
                1,
                "Point",
                {"name": f"Station {index:05d}", "priority": 5},
                {"type": "Point", "coordinates": [-71.0 + index / 100_000, 42.0]},
                [-71.0 + index / 100_000, 42.0, -71.0 + index / 100_000, 42.0],
                self.user_id,
                NOW,
                self.user_id,
                NOW,
            )
            for index in range(offset, min(offset + limit, self.number_matched))
        ]

    async def execute(self, statement: str, parameters=()):
        raise AssertionError(f"read-only query executed a write: {statement} {parameters}")


class ConcurrentQueryExecutor:
    def __init__(self, transactions: dict[UUID, ConcurrentQueryTransaction]) -> None:
        self.transactions = transactions
        self.barrier = asyncio.Barrier(len(transactions))

    async def run(self, context, operation):
        transaction = self.transactions[context.organization_id]
        await self.barrier.wait()
        return await operation(transaction)

    async def fetch_one(self, context, statement, parameters=()):
        return await self.transactions[context.organization_id].fetch_one(statement, parameters)


def test_concurrent_queries_keep_tenant_context_and_stable_bounded_order() -> None:
    organizations = (
        UUID("10000000-0000-4000-8000-000000000201"),
        UUID("10000000-0000-4000-8000-000000000202"),
    )
    users = (
        UUID("20000000-0000-4000-8000-000000000201"),
        UUID("20000000-0000-4000-8000-000000000202"),
    )
    projects = (
        UUID("50000000-0000-4000-8000-000000000201"),
        UUID("50000000-0000-4000-8000-000000000202"),
    )
    datasets = (
        UUID("80000000-0000-4000-8000-000000000201"),
        UUID("80000000-0000-4000-8000-000000000202"),
    )
    transactions = {
        organizations[index]: ConcurrentQueryTransaction(
            organization_id=organizations[index],
            user_id=users[index],
            project_id=projects[index],
            dataset_id=datasets[index],
            feature_base=(index + 1) * 100_000,
        )
        for index in range(2)
    }
    repository = PostgresFeatureRepository(ConcurrentQueryExecutor(transactions))

    async def scenario() -> list[FeaturePage]:
        return await asyncio.gather(
            *(
                repository.query_features(
                    TenantContext(user_id=users[index], organization_id=organizations[index]),
                    projects[index],
                    datasets[index],
                    steps=(
                        AttributeQueryStep("name", "starts_with", "Station"),
                        AttributeQueryStep("priority", "greater_than_or_equal", 3),
                        SpatialQueryStep(
                            "intersects",
                            {"type": "Point", "coordinates": [-71.0, 42.0]},
                            1_000,
                        ),
                    ),
                    limit=100,
                    offset=9_900,
                    expected_generation=7,
                )
                for index in range(2)
            )
        )

    pages = asyncio.run(scenario())

    for index, page in enumerate(pages):
        assert isinstance(page.collection, FeatureCollection)
        assert page.collection.dataset_id == datasets[index]
        assert page.collection.generation == 7
        assert page.number_matched == 10_000
        assert page.limit == 100
        assert page.offset == 9_900
        assert len(page.features) == 100
        feature_ids = [feature.feature_id for feature in page.features]
        assert feature_ids == sorted(feature_ids)
        assert all(feature.feature_id.int // 100_000 == index + 1 for feature in page.features)

        transaction = transactions[organizations[index]]
        assert len(transaction.calls) == 4
        count_call = transaction.calls[2]
        rows_call = transaction.calls[3]
        expected_predicate_parameters = (
            organizations[index],
            datasets[index],
            "name",
            "Station%",
            "priority",
            3,
        )
        assert count_call[2][:6] == expected_predicate_parameters
        assert rows_call[2][:6] == expected_predicate_parameters
        assert count_call[2][6].obj == {
            "type": "Point",
            "coordinates": [-71.0, 42.0],
        }
        assert rows_call[2][6].obj == count_call[2][6].obj
        assert count_call[2][7] == 1_000.0
        assert rows_call[2][7] == 1_000.0
        assert len(count_call[2]) == 8
        assert len(rows_call[2]) == 10
        assert "ST_Intersects(feature.geometry, ST_Buffer(" in rows_call[1]
        assert rows_call[2][-2:] == (100, 9_900)
