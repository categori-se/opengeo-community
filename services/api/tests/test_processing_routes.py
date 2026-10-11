from uuid import UUID

from asgi_test_client import DirectAsgiClient
from opengeo_api.app import create_app
from opengeo_api.auth_models import Principal, VerifiedAccessToken
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
        assert tool["software"]["gdal"] == "3.13.0"
        assert "sha256:" in tool["software"]["worker_base_image"]
        assert "password" not in str(tool).lower()
        assert "credential" not in str(tool).lower()


def test_processing_registry_has_no_side_effect_method() -> None:
    response = client().post("/processing/tools", headers={"Authorization": "Bearer valid-token"})

    assert response.status_code == 405
