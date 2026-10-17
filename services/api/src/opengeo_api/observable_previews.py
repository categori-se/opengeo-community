import base64
import hashlib
import hmac
import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from threading import Lock
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings, canonical_preview_origin

_KEY_PAIR_ID = re.compile(r"^[A-Z0-9]{8,32}$")
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
_PREVIEW_PATH = re.compile(
    rf"^/organizations/{_UUID}/projects/{_UUID}/"
    rf"source-projects/{_UUID}/builds/{_UUID}/output/\*$"
)


class PreviewCookieSigningUnavailable(RuntimeError):
    pass


class PreviewCookieSigner(Protocol):
    @property
    def available(self) -> bool: ...

    def sign(self, resource_url: str, expires_at: datetime) -> dict[str, str]: ...


class UnavailablePreviewCookieSigner:
    @property
    def available(self) -> bool:
        return False

    def sign(self, resource_url: str, expires_at: datetime) -> dict[str, str]:
        del resource_url, expires_at
        raise PreviewCookieSigningUnavailable("private preview signing is not configured")


class CloudFrontPreviewCookieSigner:
    """Create CloudFront custom-policy cookies without retaining raw policy in logs."""

    def __init__(
        self, key_pair_id: str, private_key_pem: bytes, *, allowed_origins: list[str] | None = None
    ) -> None:
        if _KEY_PAIR_ID.fullmatch(key_pair_id) is None:
            raise ValueError("CloudFront key pair id is invalid")
        loaded = serialization.load_pem_private_key(private_key_pem, password=None)
        if not isinstance(loaded, rsa.RSAPrivateKey) or loaded.key_size < 2048:
            raise ValueError("CloudFront private key must be RSA with at least 2048 bits")
        self._key_pair_id = key_pair_id
        self._private_key = loaded
        self._origins = frozenset(
            canonical_preview_origin(origin, allow_loopback_http=True)
            for origin in (
                allowed_origins if allowed_origins is not None else [
                    "https://preview.studio.opengeo.tools", "https://maps-preview.studio.opengeo.tools"
                ]
            )
        )
        if not self._origins:
            raise ValueError("private preview requires an explicit isolated origin")

    @property
    def available(self) -> bool:
        return True

    def sign(self, resource_url: str, expires_at: datetime) -> dict[str, str]:
        parsed = urlsplit(resource_url)
        if (
            f"{parsed.scheme}://{parsed.netloc}" not in self._origins
            or parsed.query or parsed.fragment or _PREVIEW_PATH.fullmatch(parsed.path) is None
        ):
            raise ValueError("private preview resource URL is invalid")
        expires_epoch = int(expires_at.timestamp())
        policy = json.dumps(
            {
                "Statement": [
                    {
                        "Resource": resource_url,
                        "Condition": {"DateLessThan": {"AWS:EpochTime": expires_epoch}},
                    }
                ]
            },
            separators=(",", ":"),
        ).encode("utf8")
        # CloudFront's signed-URL/cookie protocol requires RSA-SHA1. This is a
        # signature over a short-lived custom policy, not a password hash.
        signature = self._private_key.sign(policy, padding.PKCS1v15(), hashes.SHA1())
        return {
            "CloudFront-Policy": _cloudfront_base64(policy),
            "CloudFront-Signature": _cloudfront_base64(signature),
            "CloudFront-Key-Pair-Id": self._key_pair_id,
        }


class SecretsManagerTransport(Protocol):
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]: ...


class UrlSecretsManagerTransport:
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]:
        request = Request(url, data=body, headers=dict(headers), method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                body = response.read(65_537)
                if len(body) > 65_536:
                    raise PreviewCookieSigningUnavailable("Secrets Manager response is too large")
                return response.status, body
        except HTTPError as error:
            return error.code, error.read(65_537)
        except (URLError, TimeoutError, OSError) as error:
            raise PreviewCookieSigningUnavailable("Secrets Manager could not be reached") from error


class SecretsManagerPreviewCookieSigner:
    """Lazily load one exact signing key; availability is checked before token consumption."""

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: SecretsManagerTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.observable_preview_signing_configured:
            raise ValueError("private preview signing must be configured")
        assert settings.aws_region is not None
        assert settings.observable_preview_key_pair_id is not None
        assert settings.observable_preview_private_key_secret_arn is not None
        self._region = settings.aws_region
        self._key_pair_id = settings.observable_preview_key_pair_id
        self._secret_arn = settings.observable_preview_private_key_secret_arn
        self._origins = [origin for origin in (
            settings.observable_preview_origin, settings.observable_public_maps_preview_origin
        ) if origin is not None]
        self._timeout_seconds = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlSecretsManagerTransport()
        self._now = now or (lambda: datetime.now(UTC))
        self._delegate: CloudFrontPreviewCookieSigner | None = None
        self._lock = Lock()

    @property
    def available(self) -> bool:
        try:
            self._load()
        except PreviewCookieSigningUnavailable:
            return False
        return True

    def sign(self, resource_url: str, expires_at: datetime) -> dict[str, str]:
        return self._load().sign(resource_url, expires_at)

    def _load(self) -> CloudFrontPreviewCookieSigner:
        if self._delegate is not None:
            return self._delegate
        with self._lock:
            return self._load_locked()

    def _load_locked(self) -> CloudFrontPreviewCookieSigner:
        if self._delegate is not None:
            return self._delegate
        payload = self._get_secret()
        if set(payload) != {"key_pair_id", "private_key_pem"}:
            raise PreviewCookieSigningUnavailable("private preview secret schema is invalid")
        if payload.get("key_pair_id") != self._key_pair_id:
            raise PreviewCookieSigningUnavailable("private preview key identity does not match")
        private_key = payload.get("private_key_pem")
        if not isinstance(private_key, str) or not 1 <= len(private_key) <= 8192:
            raise PreviewCookieSigningUnavailable("private preview key material is invalid")
        try:
            signer = CloudFrontPreviewCookieSigner(
                self._key_pair_id,
                private_key.encode("ascii"),
                allowed_origins=self._origins,
            )
        except (UnicodeEncodeError, ValueError) as error:
            raise PreviewCookieSigningUnavailable(
                "private preview key material is invalid"
            ) from error
        self._delegate = signer
        return signer

    def _get_secret(self) -> dict[str, Any]:
        body = json.dumps({"SecretId": self._secret_arn}, separators=(",", ":")).encode()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = f"secretsmanager.{self._region}.amazonaws.com"
        target = "secretsmanager.GetSecretValue"
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise PreviewCookieSigningUnavailable("AWS credentials are unavailable") from error
        canonical = {
            "content-type": "application/x-amz-json-1.1",
            "host": host,
            "x-amz-date": amz_date,
            "x-amz-target": target,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{key}:{canonical[key]}\n" for key in sorted(canonical))
        canonical_request = "\n".join(
            [
                "POST",
                "/",
                "",
                canonical_headers,
                signed_names,
                hashlib.sha256(body).hexdigest(),
            ]
        )
        scope = f"{date_stamp}/{self._region}/secretsmanager/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            _signing_key(credentials.secret_access_key, date_stamp, self._region),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }
        status_code, response_body = self._transport.call(
            f"https://{host}/",
            headers,
            body,
            self._timeout_seconds,
        )
        if status_code < 200 or status_code >= 300:
            raise PreviewCookieSigningUnavailable("private preview secret could not be loaded")
        try:
            envelope = json.loads(response_body)
            secret_string = envelope["SecretString"]
            if not isinstance(secret_string, str) or len(secret_string) > 16_384:
                raise ValueError("secret string shape")
            payload = json.loads(secret_string)
        except (KeyError, TypeError, ValueError) as error:
            raise PreviewCookieSigningUnavailable(
                "private preview secret response is invalid"
            ) from error
        if not isinstance(payload, dict):
            raise PreviewCookieSigningUnavailable("private preview secret schema is invalid")
        return cast(dict[str, Any], payload)


def _cloudfront_base64(value: bytes) -> str:
    return (
        base64.b64encode(value)
        .decode("ascii")
        .replace("+", "-")
        .replace("=", "_")
        .replace("/", "~")
    )


def _signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"secretsmanager", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
