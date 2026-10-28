import time
from typing import Annotated, Any
from uuid import UUID

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jwt import PyJWK
from pydantic import ValidationError

from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
from opengeo_api.auth_routes import router as auth_router
from opengeo_api.auth_tokens import (
    AuthenticationBackendUnavailable,
    CognitoTokenVerifier,
    TokenVerificationError,
)
from opengeo_api.config import Settings
from opengeo_api.mcp_auth import require_mcp_session, router
from opengeo_api.principals import PrincipalBackendUnavailable

RESOURCE = "https://api.example.invalid/mcp"
ORG_A = UUID("10000000-0000-4000-8000-000000000001")
ORG_B = UUID("10000000-0000-4000-8000-000000000002")
PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
RAW_KEY = jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE_KEY.public_key(), as_dict=True)
RAW_KEY.update({"kid": "mcp-test-key", "alg": "RS256", "use": "sig"})


class StaticKeys:
    async def get_key(self, key_id: str) -> PyJWK:
        if key_id != "mcp-test-key":
            raise TokenVerificationError("unknown signing key")
        return PyJWK.from_dict(RAW_KEY)


def settings(**overrides: Any) -> Settings:
    return Settings(
        **{
            "env": "test",
            "cognito_region": "us-east-1",
            "cognito_user_pool_id": "us-east-1_example",
            "cognito_client_id": "studio-client",
            "cognito_additional_client_ids": "mcp-client",
            "mcp_resource_url": RESOURCE,
            "jwt_leeway_seconds": 0,
            **overrides,
        }
    )


def encoded_token(**overrides: Any) -> str:
    now = int(time.time())
    payload = {
        "sub": "subject-123",
        "iss": settings().cognito_issuer,
        "client_id": "mcp-client",
        "token_use": "access",
        "scope": "openid",
        "aud": RESOURCE,
        "iat": now,
        "exp": now + 300,
        **overrides,
    }
    return jwt.encode(payload, PRIVATE_KEY, algorithm="RS256", headers={"kid": "mcp-test-key"})


class Repository:
    def __init__(self, memberships: tuple[UUID, ...] = (ORG_A,)) -> None:
        self.subjects: list[str] = []
        self.principal: Principal | None = Principal(
            user_id=UUID("20000000-0000-4000-8000-000000000001"),
            subject="subject-123",
            email="test@example.invalid",
            display_name="Test",
            memberships=tuple(OrganizationMembership(value, "member") for value in memberships),
        )

    async def resolve(self, subject: str) -> Principal | None:
        self.subjects.append(subject)
        return self.principal


def client(configured: Settings | None = None, repository: Repository | None = None) -> TestClient:
    app = FastAPI()
    app.state.settings = configured or settings()
    app.state.token_verifier = CognitoTokenVerifier(app.state.settings, StaticKeys())
    app.state.principal_repository = repository or Repository()
    app.include_router(router)
    app.include_router(auth_router)

    @app.post("/mcp")
    async def protected(session: Annotated[AuthSession, Depends(require_mcp_session)]):
        assert session.selected_membership is not None
        return {"organization_id": str(session.selected_membership.organization_id)}

    return TestClient(app)


def headers(**claims: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {encoded_token(**claims)}"}


def test_mcp_signed_resource_bound_token_resolves_existing_membership() -> None:
    repository = Repository()
    response = client(repository=repository).post("/mcp", headers=headers())
    assert response.status_code == 200
    assert response.json() == {"organization_id": str(ORG_A)}
    assert repository.subjects == ["subject-123"]


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": None},
        {"aud": "https://other.example/mcp"},
        {"aud": ["https://other.example/mcp"]},
        {"aud": [RESOURCE, 1]},
        {"aud": RESOURCE + "/"},
        {"token_use": "id"},
        {"client_id": "unregistered-client"},
        {"iss": "https://attacker.example/pool"},
        {"exp": 1},
    ],
)
def test_mcp_rejects_invalid_signed_claims_before_principal_lookup(claims) -> None:
    repository = Repository()
    response = client(repository=repository).post("/mcp", headers=headers(**claims))
    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_token"}
    assert (
        'resource_metadata="https://api.example.invalid/.well-known/'
        in response.headers["www-authenticate"]
    )
    assert repository.subjects == []


def test_mcp_missing_token_challenges_without_trusting_host_or_query_token() -> None:
    response = client().post("/mcp?access_token=ignored", headers={"Host": "attacker.example"})
    assert response.status_code == 401
    assert (
        "api.example.invalid/.well-known/oauth-protected-resource/mcp"
        in response.headers["www-authenticate"]
    )
    assert "attacker.example" not in response.headers["www-authenticate"]


def test_mcp_insufficient_scope_has_required_scope_challenge() -> None:
    response = client(settings(mcp_required_scopes="openid opengeo/read")).post(
        "/mcp", headers=headers()
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "insufficient_scope"}
    assert 'scope="openid opengeo/read"' in response.headers["www-authenticate"]


def test_mcp_resource_audience_array_uses_exact_matching_audience() -> None:
    assert client().post("/mcp", headers=headers(aud=[RESOURCE])).status_code == 200


def test_mcp_multitenant_selection_reuses_existing_membership_guards() -> None:
    current = client(repository=Repository((ORG_A, ORG_B)))
    assert current.post("/mcp", headers=headers()).status_code == 409
    assert current.post(
        "/mcp", headers=headers() | {"X-OpenGeo-Organization": str(ORG_B)}
    ).json() == {"organization_id": str(ORG_B)}
    assert (
        current.post(
            "/mcp", headers=headers() | {"X-OpenGeo-Organization": str(UUID(int=99))}
        ).status_code
        == 403
    )
    assert (
        current.post("/mcp", headers=headers() | {"X-OpenGeo-Organization": "invalid"}).status_code
        == 400
    )


def test_mcp_unknown_principal_has_no_implicit_provisioning() -> None:
    repository = Repository()
    repository.principal = None
    assert client(repository=repository).post("/mcp", headers=headers()).status_code == 403


def test_mcp_backend_failures_are_sanitized() -> None:
    current = client()

    class UnavailableVerifier:
        async def verify(self, _token):
            raise AuthenticationBackendUnavailable("private backend reason")

    current.app.state.token_verifier = UnavailableVerifier()
    response = current.post("/mcp", headers=headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "authentication_unavailable"}

    class UnavailableRepository:
        async def resolve(self, _subject):
            raise PrincipalBackendUnavailable("private identity reason")

    current.app.state.token_verifier = CognitoTokenVerifier(settings(), StaticKeys())
    current.app.state.principal_repository = UnavailableRepository()
    response = current.post("/mcp", headers=headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "identity_store_unavailable"}


def test_rest_still_accepts_existing_unbound_access_token() -> None:
    response = client().get("/auth/session", headers=headers(aud=None, client_id="studio-client"))
    assert response.status_code == 200


@pytest.mark.parametrize(
    "path", ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]
)
def test_mcp_discovery_names_configured_resource_and_cognito_issuer(path) -> None:
    response = client().get(path)
    assert response.status_code == 200
    assert response.json() == {
        "resource": RESOURCE,
        "authorization_servers": [settings().cognito_issuer],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["openid"],
        "resource_name": "OpenGeo read-only MCP",
    }


def test_mcp_disabled_without_explicit_resource_url() -> None:
    current = client(settings(mcp_resource_url=None))
    assert current.post("/mcp", headers=headers()).status_code == 404
    assert current.get("/.well-known/oauth-protected-resource/mcp").status_code == 404


@pytest.mark.parametrize("origin", ["null", "https://attacker.example", "https://ide.example/"])
def test_mcp_disallows_untrusted_origin_before_token_or_principal(origin) -> None:
    repository = Repository()
    response = client(repository=repository).post("/mcp", headers=headers() | {"Origin": origin})
    assert response.status_code == 403
    assert repository.subjects == []


def test_mcp_explicit_origin_and_loopback_dev_resource() -> None:
    configured = settings(mcp_allowed_origins="https://ide.example")
    assert (
        client(configured)
        .post("/mcp", headers=headers() | {"Origin": "https://ide.example"})
        .status_code
        == 200
    )
    assert settings(mcp_resource_url="http://127.0.0.1:8080/mcp").mcp_resource_url


@pytest.mark.parametrize(
    "override",
    [
        {"mcp_resource_url": "https://api.example.invalid/mcp/"},
        {"mcp_resource_url": "https://user@api.example.invalid/mcp"},
        {"mcp_resource_url": "http://api.example.invalid/mcp"},
        {"mcp_resource_url": "https://api.example.invalid/mcp?other=1"},
        {"mcp_resource_url": "https://api.example.invalid/mcp#fragment"},
        {"mcp_required_scopes": "openid  other"},
        {"mcp_required_scopes": 'openid"evil'},
        {"mcp_allowed_origins": "https://ide.example/path"},
        {"mcp_allowed_origins": "https://ide.example,https://ide.example"},
    ],
)
def test_mcp_configuration_rejects_ambiguous_resource_origins_and_scope(override) -> None:
    with pytest.raises(ValidationError, match="mcp_"):
        settings(**override)
