import asyncio
import json
import time
from collections.abc import Mapping
from typing import Any, Protocol, cast

import httpx2
import jwt
from jwt import PyJWK

from opengeo_api.auth_models import VerifiedAccessToken
from opengeo_api.config import Settings

MAX_TOKEN_BYTES = 16_384
MAX_JWKS_BYTES = 1_048_576


class TokenVerificationError(RuntimeError):
    pass


class AuthenticationBackendUnavailable(RuntimeError):
    pass


class SigningKeyProvider(Protocol):
    async def get_key(self, key_id: str) -> PyJWK: ...


class TokenVerifier(Protocol):
    async def verify(self, token: str) -> VerifiedAccessToken: ...


class UnavailableTokenVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        del token
        raise AuthenticationBackendUnavailable("Cognito is not configured")


class CognitoJwksProvider:
    def __init__(self, settings: Settings) -> None:
        if not settings.auth_configured:
            raise ValueError("Cognito must be configured before creating a JWKS provider")
        self._url = settings.cognito_jwks_url
        self._cache_seconds = settings.cognito_jwks_cache_seconds
        self._minimum_refresh_seconds = settings.cognito_jwks_min_refresh_seconds
        self._http_timeout = settings.cognito_http_timeout_seconds
        self._keys: dict[str, PyJWK] = {}
        self._expires_at = 0.0
        self._last_refresh = 0.0
        self._lock = asyncio.Lock()

    async def get_key(self, key_id: str) -> PyJWK:
        now = time.monotonic()
        cached = self._keys.get(key_id)
        if cached is not None and now < self._expires_at:
            return cached

        async with self._lock:
            now = time.monotonic()
            cached = self._keys.get(key_id)
            if cached is not None and now < self._expires_at:
                return cached

            cache_expired = now >= self._expires_at
            refresh_allowed = now - self._last_refresh >= self._minimum_refresh_seconds
            if not self._keys or cache_expired or refresh_allowed:
                await self._refresh()

            key = self._keys.get(key_id)
            if key is None:
                raise TokenVerificationError("unknown signing key")
            return key

    async def _refresh(self) -> None:
        try:
            async with httpx2.AsyncClient(
                timeout=self._http_timeout,
                follow_redirects=False,
            ) as client:
                response = await client.get(
                    self._url,
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                if len(response.content) > MAX_JWKS_BYTES:
                    raise AuthenticationBackendUnavailable("JWKS response is too large")
                document = cast(Any, response.json())
        except AuthenticationBackendUnavailable:
            raise
        except (httpx2.HTTPError, json.JSONDecodeError, ValueError) as error:
            raise AuthenticationBackendUnavailable("unable to refresh Cognito keys") from error

        if not isinstance(document, Mapping) or not isinstance(document.get("keys"), list):
            raise AuthenticationBackendUnavailable("Cognito JWKS document is malformed")

        keys: dict[str, PyJWK] = {}
        for raw_key in document["keys"]:
            if not isinstance(raw_key, Mapping):
                continue
            key_id = raw_key.get("kid")
            if (
                not isinstance(key_id, str)
                or raw_key.get("kty") != "RSA"
                or raw_key.get("alg") != "RS256"
                or raw_key.get("use") != "sig"
            ):
                continue
            try:
                keys[key_id] = PyJWK.from_dict(dict(raw_key), algorithm="RS256")
            except (jwt.PyJWTError, ValueError):
                continue

        if not keys:
            raise AuthenticationBackendUnavailable("Cognito JWKS contains no usable keys")

        now = time.monotonic()
        self._keys = keys
        self._last_refresh = now
        self._expires_at = now + self._cache_seconds


class CognitoTokenVerifier:
    def __init__(
        self,
        settings: Settings,
        key_provider: SigningKeyProvider | None = None,
    ) -> None:
        if not settings.auth_configured or settings.cognito_client_id is None:
            raise ValueError("Cognito must be configured before creating a token verifier")
        self._issuer = settings.cognito_issuer
        self._client_ids = frozenset(settings.cognito_client_ids)
        self._leeway_seconds = settings.jwt_leeway_seconds
        self._keys = key_provider or CognitoJwksProvider(settings)

    async def verify(self, token: str) -> VerifiedAccessToken:
        if not token or len(token.encode("utf-8")) > MAX_TOKEN_BYTES:
            raise TokenVerificationError("token has an invalid size")

        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as error:
            raise TokenVerificationError("token header is invalid") from error

        key_id = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(key_id, str) or not key_id:
            raise TokenVerificationError("token algorithm or key id is invalid")

        key = await self._keys.get_key(key_id)
        try:
            payload = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                issuer=self._issuer,
                leeway=self._leeway_seconds,
                options={
                    "verify_aud": False,
                    "require": ["client_id", "exp", "iat", "iss", "sub", "token_use"],
                },
            )
        except jwt.PyJWTError as error:
            raise TokenVerificationError("token claims or signature are invalid") from error

        if payload.get("token_use") != "access":
            raise TokenVerificationError("token is not an access token")
        client_id = payload.get("client_id")
        if not isinstance(client_id, str) or client_id not in self._client_ids:
            raise TokenVerificationError("token client is invalid")

        subject = payload.get("sub")
        if not isinstance(subject, str) or not subject:
            raise TokenVerificationError("token subject is invalid")
        username_value = payload.get("username")
        username = username_value if isinstance(username_value, str) else None
        scope_value = payload.get("scope")
        scopes = tuple(sorted(set(scope_value.split()))) if isinstance(scope_value, str) else ()
        groups_value = payload.get("cognito:groups")
        groups = (
            tuple(group for group in groups_value if isinstance(group, str))
            if isinstance(groups_value, list)
            else ()
        )

        return VerifiedAccessToken(
            subject=subject,
            client_id=client_id,
            username=username,
            scopes=scopes,
            groups=groups,
        )
