import asyncio
import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt import PyJWK

from opengeo_api.auth_tokens import (
    AuthenticationBackendUnavailable,
    CognitoJwksProvider,
    CognitoTokenVerifier,
    TokenVerificationError,
)
from opengeo_api.config import Settings

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY_ID = "test-key"


def public_jwk(private_key: rsa.RSAPrivateKey, key_id: str = KEY_ID) -> PyJWK:
    raw = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    raw.update({"kid": key_id, "alg": "RS256", "use": "sig"})
    return PyJWK.from_dict(raw, algorithm="RS256")


class StaticKeyProvider:
    def __init__(self, key: PyJWK) -> None:
        self.key = key

    async def get_key(self, key_id: str) -> PyJWK:
        if key_id != KEY_ID:
            raise TokenVerificationError("unknown signing key")
        return self.key


def auth_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "env": "test",
        "cognito_region": "us-east-1",
        "cognito_user_pool_id": "us-east-1_example",
        "cognito_client_id": "client-123",
        "jwt_leeway_seconds": 0,
    }
    values.update(overrides)
    return Settings(**values)


def encoded_token(**overrides: Any) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": "subject-123",
        "client_id": "client-123",
        "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
        "token_use": "access",
        "iat": now,
        "exp": now + 300,
        "username": "ada",
        "scope": "openid maps:read maps:read",
        "cognito:groups": ["operators"],
    }
    payload.update(overrides)
    return jwt.encode(
        payload,
        PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": KEY_ID},
    )


def verifier(key: PyJWK | None = None) -> CognitoTokenVerifier:
    return CognitoTokenVerifier(
        auth_settings(),
        StaticKeyProvider(key or public_jwk(PRIVATE_KEY)),
    )


def verify(token: str, token_verifier: CognitoTokenVerifier | None = None):
    return asyncio.run((token_verifier or verifier()).verify(token))


def test_valid_access_token_is_normalized() -> None:
    result = verify(encoded_token())

    assert result.subject == "subject-123"
    assert result.client_id == "client-123"
    assert result.scopes == ("maps:read", "openid")
    assert result.groups == ("operators",)


def test_explicit_additional_client_is_accepted_and_preserved() -> None:
    token_verifier = CognitoTokenVerifier(
        auth_settings(cognito_additional_client_ids="client-456,client-789"),
        StaticKeyProvider(public_jwk(PRIVATE_KEY)),
    )

    result = verify(encoded_token(client_id="client-456"), token_verifier)

    assert result.client_id == "client-456"


def test_unlisted_client_remains_rejected_when_additional_clients_are_configured() -> None:
    token_verifier = CognitoTokenVerifier(
        auth_settings(cognito_additional_client_ids="client-456"),
        StaticKeyProvider(public_jwk(PRIVATE_KEY)),
    )

    with pytest.raises(TokenVerificationError):
        verify(encoded_token(client_id="client-789"), token_verifier)


@pytest.mark.parametrize(
    ("override", "value"),
    [
        ("iss", "https://attacker.example/pool"),
        ("client_id", "other-client"),
        ("token_use", "id"),
        ("exp", 1),
        ("iat", int(time.time()) + 600),
    ],
)
def test_rejects_invalid_security_claims(override: str, value: Any) -> None:
    with pytest.raises(TokenVerificationError):
        verify(encoded_token(**{override: value}))


def test_rejects_missing_required_claim() -> None:
    now = int(time.time())
    token = jwt.encode(
        {
            "client_id": "client-123",
            "iss": auth_settings().cognito_issuer,
            "token_use": "access",
            "iat": now,
            "exp": now + 300,
        },
        PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": KEY_ID},
    )

    with pytest.raises(TokenVerificationError):
        verify(token)


def test_rejects_token_signed_by_another_key() -> None:
    with pytest.raises(TokenVerificationError):
        verify(encoded_token(), verifier(public_jwk(OTHER_PRIVATE_KEY)))


def test_rejects_non_rs256_algorithm_before_key_use() -> None:
    token = jwt.encode(
        {"sub": "subject-123"},
        "not-a-real-secret-that-is-long-enough",
        algorithm="HS256",
        headers={"kid": KEY_ID},
    )

    with pytest.raises(TokenVerificationError):
        verify(token)


def test_rejects_oversized_token() -> None:
    with pytest.raises(TokenVerificationError):
        verify("x" * 16_385)


class FakeJwksResponse:
    def __init__(self, document: dict[str, Any]) -> None:
        self._document = document
        self.content = json.dumps(document).encode()

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict[str, Any]:
        return self._document


class FakeJwksClient:
    def __init__(self, response: FakeJwksResponse, calls: list[str], **options: Any) -> None:
        assert options["follow_redirects"] is False
        self._response = response
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass

    async def get(self, url: str, **options: Any) -> FakeJwksResponse:
        assert options["headers"] == {"Accept": "application/json"}
        self._calls.append(url)
        return self._response


def jwks_document() -> dict[str, Any]:
    raw = jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE_KEY.public_key(), as_dict=True)
    raw.update({"kid": KEY_ID, "alg": "RS256", "use": "sig"})
    return {"keys": [raw]}


def test_jwks_provider_fetches_derived_url_without_redirects(monkeypatch) -> None:
    calls: list[str] = []
    response = FakeJwksResponse(jwks_document())
    monkeypatch.setattr(
        "opengeo_api.auth_tokens.httpx2.AsyncClient",
        lambda **options: FakeJwksClient(response, calls, **options),
    )
    settings = auth_settings()
    provider = CognitoJwksProvider(settings)

    key = asyncio.run(provider.get_key(KEY_ID))

    assert key.key_id == KEY_ID
    assert calls == [settings.cognito_jwks_url]


def test_unknown_key_is_negative_cached_between_refresh_windows(monkeypatch) -> None:
    calls: list[str] = []
    response = FakeJwksResponse(jwks_document())
    monkeypatch.setattr(
        "opengeo_api.auth_tokens.httpx2.AsyncClient",
        lambda **options: FakeJwksClient(response, calls, **options),
    )
    provider = CognitoJwksProvider(auth_settings())

    with pytest.raises(TokenVerificationError):
        asyncio.run(provider.get_key("attacker-key"))
    with pytest.raises(TokenVerificationError):
        asyncio.run(provider.get_key("attacker-key"))

    assert len(calls) == 1


def test_jwks_provider_rejects_document_without_usable_keys(monkeypatch) -> None:
    response = FakeJwksResponse({"keys": []})
    monkeypatch.setattr(
        "opengeo_api.auth_tokens.httpx2.AsyncClient",
        lambda **options: FakeJwksClient(response, [], **options),
    )
    provider = CognitoJwksProvider(auth_settings())

    with pytest.raises(AuthenticationBackendUnavailable):
        asyncio.run(provider.get_key(KEY_ID))
