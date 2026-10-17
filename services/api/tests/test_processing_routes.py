from uuid import UUID

from asgi_test_client import DirectAsgiClient
from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.processing_tools import PROCESSING_REGISTRY_SCHEMA_VERSION


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken(
            subject="processing-user",
            client_id="client",
            username="operator",
            scopes=(),
            groups=(),
        )


class FakeRepository:
    async def resolve(self, subject: str) -> Principal | None:
        assert subject == "processing-user"
        return Principal(
            user_id=UUID("20000000-0000-4000-8000-000000000001"),
            subject=subject,
            email="operator@example.test",
            display_name="Operator",
            memberships=(),
        )


def client() -> DirectAsgiClient:
    return DirectAsgiClient(
        create_app(Settings(env="test"), PassingProbe(), FakeVerifier(), FakeRepository())
    )


def test_processing_registry_requires_authentication() -> None:
    response = client().get("/processing/tools")

    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_token"}


def test_processing_registry_exposes_exact_bounded_activation_only_tools() -> None:
    first = client().get("/processing/tools", headers={"Authorization": "Bearer valid-token"})
    repeated = client().get("/processing/tools", headers={"Authorization": "Bearer valid-token"})

    assert first.status_code == 200
    assert first.json() == repeated.json()
    payload = first.json()
    assert payload["schema_version"] == PROCESSING_REGISTRY_SCHEMA_VERSION
    assert [tool["id"] for tool in payload["tools"]] == [
        "vector-to-pmtiles",
        "raster-to-cog",
    ]
    for tool in payload["tools"]:
        assert tool["execution_mode"] == "activation-only-server-job"
        assert tool["deterministic"] is True
        assert tool["ordinary_reads_create_work"] is False
        assert tool["limits"]["networkAccess"] == "disabled"
        if tool["id"] == "vector-to-pmtiles":
            assert tool["version"] == "1.1.0"
            assert tool["request_schema_version"] == "opengeo.pmtiles-derivative-request.1.1.0"
            assert tool["software"]["gdal"] == "3.13.1"
            assert tool["software"]["tippecanoe"] is None
            assert tool["limits"]["runtimeImagePin"] == "immutable-per-job"
            assert tool["limits"]["adaptiveGeneralization"] is True
            assert tool["limits"]["inputFormats"] == "geojson"
            assert tool["limits"]["admissionReady"] is False
            assert tool["limits"]["admissionReason"] == "runtime_not_configured"
            assert any(parameter["id"] == "options" for parameter in tool["parameters"])
        else:
            assert tool["software"]["gdal"] == "3.13.0"
        assert "sha256:" in tool["software"]["worker_base_image"]
        assert "password" not in str(tool).lower()
        assert "credential" not in str(tool).lower()


def test_processing_registry_has_no_side_effect_method() -> None:
    response = client().post("/processing/tools", headers={"Authorization": "Bearer valid-token"})

    assert response.status_code == 405


def test_processing_registry_returns_deliberate_read_only_admission_reason() -> None:
    from dataclasses import replace

    class MemberRepository(FakeRepository):
        async def resolve(self, subject):
            principal = await super().resolve(subject)
            return replace(
                principal,
                memberships=(
                    OrganizationMembership(UUID("10000000-0000-4000-8000-000000000001"), "member"),
                ),
            )

    class AdmissionRepository:
        calls = 0

        async def pmtiles_admission_status(self, context):
            self.calls += 1
            return {"ready": False, "reason": "runtime_budget_exhausted"}

    repository = AdmissionRepository()
    settings = Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="offline-test",
        geodata_kms_key_arn="arn:aws:kms:us-east-1:111111111111:key/offline",
        worker_processing_mode="pmtiles-v2",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
        pmtiles_derivative_queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2",
    )
    api = DirectAsgiClient(
        create_app(
            settings,
            PassingProbe(),
            FakeVerifier(),
            MemberRepository(),
            data_preservation_repository=repository,
        )
    )
    response = api.get("/processing/tools", headers={"Authorization": "Bearer valid-token"})
    assert response.status_code == 200
    limits = response.json()["tools"][0]["limits"]
    assert (
        limits["admissionReady"] is False
        and limits["admissionReason"] == "runtime_budget_exhausted"
    )
    assert repository.calls == 1
