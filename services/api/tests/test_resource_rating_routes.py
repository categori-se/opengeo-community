from datetime import UTC, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.resource_ratings import (
    ResourceRatingConflict,
    ResourceRatingMutationReceipt,
    ResourceRatingSummary,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000080")
ORG_ID = UUID("10000000-0000-4000-8000-000000000080")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000080")
RESOURCE_ID = UUID("90000000-0000-4000-8000-000000000080")
NOW = datetime(2026, 9, 3, 12, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            USER_ID,
            subject,
            "reader@example.test",
            "Reader",
            (OrganizationMembership(ORG_ID, "member"),),
        )


def summary(score: int | None = 4, version: int | None = 2) -> ResourceRatingSummary:
    return ResourceRatingSummary(
        PROJECT_ID, RESOURCE_ID, 3, 4.0, score, version, score is None and version is not None, NOW
    )


class FakeResourceRatingRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def get_summary(self, context, project_id, resource_id):
        self.calls.append(("get", context, project_id, resource_id))
        return summary()

    async def set_rating(
        self, context, project_id, resource_id, score, expected_version, request_id
    ):
        self.calls.append(
            ("set", context, project_id, resource_id, score, expected_version, request_id)
        )
        return ResourceRatingMutationReceipt(True, summary(score, 3))


class ConflictingResourceRatingRepository(FakeResourceRatingRepository):
    async def set_rating(self, *args, **kwargs):
        del args, kwargs
        raise ResourceRatingConflict("resource_rating_version_conflict", current_version=5)


def client(repository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test"),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            resource_rating_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-rating-route-80",
    }


def test_reads_and_sets_private_rating_against_an_aggregate_summary() -> None:
    repository = FakeResourceRatingRepository()
    api = client(repository)

    read = api.get(f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/rating", headers=headers())
    written = api.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/rating",
        headers=headers(),
        json={"score": 5, "expected_version": 2},
    )

    assert read.status_code == 200
    assert read.json()["rating_average"] == 4.0
    assert read.json()["caller_score"] == 4
    assert written.status_code == 200
    assert written.json()["summary"]["caller_score"] == 5
    assert repository.calls == [
        ("get", TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID),
        (
            "set",
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            5,
            2,
            "request-rating-route-80",
        ),
    ]


def test_rating_route_rejects_extra_fields_ranges_and_stale_versions() -> None:
    repository = FakeResourceRatingRepository()
    api = client(repository)
    target = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/rating"

    assert api.post(target, headers=headers(), json={"score": 0}).status_code == 422
    assert api.post(target, headers=headers(), json={"score": 6}).status_code == 422
    assert api.post(target, headers=headers(), json={"score": 4, "extra": True}).status_code == 422
    assert repository.calls == []

    conflict = client(ConflictingResourceRatingRepository()).post(
        target,
        headers=headers(),
        json={"score": None, "expected_version": 4},
    )
    assert conflict.status_code == 409
    assert conflict.json() == {
        "detail": {"code": "resource_rating_version_conflict", "current_version": 5}
    }
