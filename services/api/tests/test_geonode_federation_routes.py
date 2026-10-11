import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.geonode_federation import GeoNodeFederationConfiguration
from opengeo_api.geonode_federations import (
    GeoNodeFederatedIdentity,
    GeoNodeFederatedIdentityVersion,
    GeoNodeFederationAccessDenied,
    GeoNodeFederationSource,
    GeoNodeFederationSourceSubmission,
    GeoNodeHarvestJob,
    GeoNodeHarvestSubmission,
)
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable

USER_ID = UUID("20000000-0000-4000-8000-000000000269")
ORG_ID = UUID("10000000-0000-4000-8000-000000000269")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000269")
SOURCE_ID = UUID("60000000-0000-4000-8000-000000000269")
JOB_ID = UUID("70000000-0000-4000-8000-000000000269")
IDEMPOTENCY_KEY = UUID("80000000-0000-4000-8000-000000000269")
REMOTE_ID = "11111111-1111-4111-8111-111111111111"
NOW = datetime(2026, 8, 31, 12, tzinfo=UTC)


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
            user_id=USER_ID,
            subject=subject,
            email="user@example.test",
            display_name="User",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def configuration() -> GeoNodeFederationConfiguration:
    return GeoNodeFederationConfiguration(
        "Research catalog",
        "https://catalog.example.test/geonode",
        False,
        1_440,
        100,
        "anonymous",
    )


def source(*, status="active") -> GeoNodeFederationSource:
    return GeoNodeFederationSource(
        SOURCE_ID,
        PROJECT_ID,
        configuration(),
        configuration().configuration_checksum_sha256,
        status,
        USER_ID,
        NOW,
        NOW if status == "disabled" else None,
    )


def job(*, state="queued") -> GeoNodeHarvestJob:
    return GeoNodeHarvestJob(
        JOB_ID,
        SOURCE_ID,
        PROJECT_ID,
        configuration().configuration_checksum_sha256,
        "a" * 64,
        IDEMPOTENCY_KEY,
        state,
        None,
        "cancelled_by_user" if state == "cancelled" else None,
        0,
        USER_ID,
        NOW,
        None,
        NOW if state == "cancelled" else None,
    )


class MemoryRepository:
    def __init__(self) -> None:
        self.source = source()
        self.job = job()
        self.calls: list[tuple] = []

    async def create_source(self, context, project_id, config):
        self.calls.append(("create_source", context, project_id, config))
        return GeoNodeFederationSourceSubmission(self.source, True)

    async def list_sources(self, context, project_id, page):
        self.calls.append(("list_sources", context, project_id, page))
        return (self.source,)

    async def get_source(self, context, project_id, source_id):
        self.calls.append(("get_source", context, project_id, source_id))
        return self.source

    async def disable_source(self, context, project_id, source_id, request_id):
        self.calls.append(("disable_source", context, project_id, source_id, request_id))
        self.source = source(status="disabled")
        return self.source

    async def create_harvest(self, context, project_id, source_id, idempotency_key, request_id):
        self.calls.append(
            (
                "create_harvest",
                context,
                project_id,
                source_id,
                idempotency_key,
                request_id,
            )
        )
        return GeoNodeHarvestSubmission(self.job, True)

    async def list_harvests(self, context, project_id, source_id, page):
        self.calls.append(("list_harvests", context, project_id, source_id, page))
        return (self.job,)

    async def get_harvest(self, context, project_id, source_id, job_id):
        self.calls.append(("get_harvest", context, project_id, source_id, job_id))
        return self.job

    async def cancel_harvest(self, context, project_id, source_id, job_id, request_id):
        self.calls.append(("cancel_harvest", context, project_id, source_id, job_id, request_id))
        self.job = job(state="cancelled")
        return self.job

    async def list_resources(self, context, project_id, source_id, page):
        self.calls.append(("list_resources", context, project_id, source_id, page))
        return (
            GeoNodeFederatedIdentity(
                SOURCE_ID,
                REMOTE_ID,
                "dataset",
                "Road network",
                "current",
                1,
                "b" * 64,
                NOW - timedelta(days=1),
                NOW - timedelta(days=1),
                NOW,
                NOW + timedelta(days=1),
                None,
            ),
        )

    async def list_resource_versions(self, context, project_id, source_id, remote_identifier, page):
        self.calls.append(
            (
                "list_resource_versions",
                context,
                project_id,
                source_id,
                remote_identifier,
                page,
            )
        )
        return (
            GeoNodeFederatedIdentityVersion(
                SOURCE_ID,
                REMOTE_ID,
                1,
                JOB_ID,
                "added",
                "dataset",
                "Road network",
                "b" * 64,
                {"uuid": REMOTE_ID, "resource_type": "dataset", "title": "Road network"},
                NOW - timedelta(days=1),
                NOW,
            ),
        )


class DeniedRepository(MemoryRepository):
    async def create_source(self, *args, **kwargs):
        del args, kwargs
        raise GeoNodeFederationAccessDenied("private detail")


class Dispatcher:
    def __init__(self, *, fail=False) -> None:
        self.fail = fail
        self.job_ids: list[UUID] = []

    @property
    def available(self) -> bool:
        return not self.fail

    async def dispatch_geonode_harvest(self, job_id):
        self.job_ids.append(job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("private queue detail")


def api_client(repository=None, dispatcher=None) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            geonode_federation_repository=repository or MemoryRepository(),
            geonode_harvest_dispatcher=dispatcher or Dispatcher(),
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-geonode-federation-269",
    }


def url(suffix="") -> str:
    return f"/projects/{PROJECT_ID}/geonode-federations{suffix}"


def source_payload() -> dict:
    return {"configuration": configuration().json_value()}


def test_imports_and_exports_exact_no_secret_configuration() -> None:
    response = api_client().post(url(), headers=headers(), json=source_payload())

    assert response.status_code == 201
    body = response.json()
    assert body["configuration"] == configuration().json_value()
    assert body["conversion_report"]["summary"]["credentials"] == 0
    assert body["conversion_report"]["source"]["version"] == "5.1.0"
    encoded_configuration = json.dumps(body["configuration"]).lower()
    assert all(
        token not in encoded_configuration
        for token in ("password", "access_token", "client_secret", "authorization")
    )


def test_rejects_secret_fields_without_reflecting_values() -> None:
    payload = source_payload()
    payload["configuration"]["harvester"]["access_token"] = "do-not-reflect"
    response = api_client().post(url(), headers=headers(), json=payload)

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "geonode_federation_configuration_unsafe"}}
    assert "do-not-reflect" not in response.text


def test_queues_only_the_persisted_harvest_identity() -> None:
    repository = MemoryRepository()
    dispatcher = Dispatcher()
    response = api_client(repository, dispatcher).post(
        url(f"/{SOURCE_ID}/harvests"),
        headers=headers(),
        json={"idempotency_key": str(IDEMPOTENCY_KEY)},
    )

    assert response.status_code == 202
    assert response.json()["state"] == "queued"
    assert response.json()["cancellable"] is True
    assert dispatcher.job_ids == [JOB_ID]
    assert repository.calls[0][0] == "create_harvest"


def test_lists_sources_harvests_resources_versions_and_cancels_running_work() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    listed_sources = client.get(url(), headers=headers())
    listed_jobs = client.get(url(f"/{SOURCE_ID}/harvests"), headers=headers())
    listed_resources = client.get(url(f"/{SOURCE_ID}/resources"), headers=headers())
    listed_versions = client.get(
        url(f"/{SOURCE_ID}/resources/{REMOTE_ID}/versions"), headers=headers()
    )
    cancelled = client.post(url(f"/{SOURCE_ID}/harvests/{JOB_ID}/cancel"), headers=headers())

    assert all(
        response.status_code == 200
        for response in (
            listed_sources,
            listed_jobs,
            listed_resources,
            listed_versions,
            cancelled,
        )
    )
    assert listed_resources.json()[0]["fresh_until"].startswith("2026-09-01")
    assert listed_versions.json()[0]["action"] == "added"
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["cancellable"] is False


def test_disable_is_explicit_and_authorization_and_dispatch_errors_are_redacted() -> None:
    disabled = api_client().post(url(f"/{SOURCE_ID}/disable"), headers=headers())
    denied = api_client(DeniedRepository()).post(url(), headers=headers(), json=source_payload())
    unavailable = api_client(MemoryRepository(), Dispatcher(fail=True)).post(
        url(f"/{SOURCE_ID}/harvests"),
        headers=headers(),
        json={"idempotency_key": str(IDEMPOTENCY_KEY)},
    )

    assert disabled.status_code == 200
    assert disabled.json()["status"] == "disabled"
    assert denied.status_code == 403
    assert denied.json() == {"detail": "action_forbidden"}
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "geonode_harvest_dispatch_unavailable"}
    assert "private" not in unavailable.text
