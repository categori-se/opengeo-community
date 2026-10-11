import asyncio
import hashlib
import hmac
import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from opengeo_api.config import Settings


class IdentityProvisioningUnavailable(RuntimeError):
    pass


class IdentityProvisioningConflict(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProvisionedIdentity:
    subject: str
    email: str
    display_name: str


class IdentityProvisioner(Protocol):
    async def ensure_user(self, email: str, display_name: str) -> ProvisionedIdentity: ...


class UnavailableIdentityProvisioner:
    async def ensure_user(self, email: str, display_name: str) -> ProvisionedIdentity:
        del email, display_name
        raise IdentityProvisioningUnavailable("Cognito provisioning is not configured")


@dataclass(frozen=True, slots=True)
class AwsCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


class CredentialProvider(Protocol):
    def load(self) -> AwsCredentials: ...


class AwsCredentialProvider:
    """Load task-role credentials without adding a broad AWS SDK dependency."""

    def __init__(
        self,
        environ: Mapping[str, str] | None = None,
        opener: Callable[..., Any] = urlopen,
        timeout_seconds: float = 2.0,
    ) -> None:
        self._environ = environ if environ is not None else os.environ
        self._opener = opener
        self._timeout_seconds = timeout_seconds

    def load(self) -> AwsCredentials:
        access_key = self._environ.get("AWS_ACCESS_KEY_ID")
        secret_key = self._environ.get("AWS_SECRET_ACCESS_KEY")
        if access_key and secret_key:
            return AwsCredentials(
                access_key,
                secret_key,
                self._environ.get("AWS_SESSION_TOKEN"),
            )

        relative_uri = self._environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        if not relative_uri or not relative_uri.startswith("/"):
            raise IdentityProvisioningUnavailable("AWS task credentials are unavailable")
        request = Request(f"http://169.254.170.2{relative_uri}")
        try:
            with self._opener(request, timeout=self._timeout_seconds) as response:
                payload = json.loads(response.read())
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            raise IdentityProvisioningUnavailable(
                "AWS task credentials could not be loaded"
            ) from error
        if not isinstance(payload, dict):
            raise IdentityProvisioningUnavailable("AWS task credentials are invalid")
        try:
            return AwsCredentials(
                access_key_id=str(payload["AccessKeyId"]),
                secret_access_key=str(payload["SecretAccessKey"]),
                session_token=str(payload["Token"]),
            )
        except (KeyError, TypeError) as error:
            raise IdentityProvisioningUnavailable("AWS task credentials are invalid") from error


class CognitoTransport(Protocol):
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


class UrlCognitoTransport:
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(url, data=body, headers=dict(headers), method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                return response.status, dict(response.headers.items()), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()
        except (URLError, TimeoutError, OSError) as error:
            raise IdentityProvisioningUnavailable("Cognito could not be reached") from error


class AwsCognitoIdentityProvisioner:
    """Minimal AdminGetUser/AdminCreateUser adapter with SigV4 task-role authentication."""

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: CognitoTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.auth_configured:
            raise ValueError("Cognito must be configured")
        assert settings.cognito_region is not None
        assert settings.cognito_user_pool_id is not None
        self._region = settings.cognito_region
        self._user_pool_id = settings.cognito_user_pool_id
        self._timeout_seconds = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlCognitoTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def ensure_user(self, email: str, display_name: str) -> ProvisionedIdentity:
        normalized_email = email.strip().lower()
        normalized_name = display_name.strip()
        if not normalized_email or not normalized_name:
            raise IdentityProvisioningConflict("invited identity is invalid")

        try:
            existing = await self._call("AdminGetUser", {"Username": normalized_email})
        except _CognitoNotFound:
            try:
                created = await self._call(
                    "AdminCreateUser",
                    {
                        "Username": normalized_email,
                        "UserAttributes": [
                            {"Name": "email", "Value": normalized_email},
                            {"Name": "name", "Value": normalized_name},
                        ],
                        "DesiredDeliveryMediums": ["EMAIL"],
                    },
                )
            except _CognitoAlreadyExists:
                existing = await self._call("AdminGetUser", {"Username": normalized_email})
            else:
                user = created.get("User")
                if not isinstance(user, dict):
                    raise IdentityProvisioningUnavailable("Cognito returned an invalid user")
                return self._identity(user, normalized_email, normalized_name)
        return self._identity(existing, normalized_email, normalized_name)

    async def _call(self, operation: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        request_payload = {"UserPoolId": self._user_pool_id, **payload}
        return await asyncio.to_thread(self._signed_call, operation, request_payload)

    def _signed_call(self, operation: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        target = f"AWSCognitoIdentityProviderService.{operation}"
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = f"cognito-idp.{self._region}.amazonaws.com"
        credentials = self._credentials.load()

        canonical = {
            "content-type": "application/x-amz-json-1.1",
            "host": host,
            "x-amz-date": amz_date,
            "x-amz-target": target,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_header_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{key}:{canonical[key]}\n" for key in sorted(canonical))
        canonical_request = "\n".join(
            [
                "POST",
                "/",
                "",
                canonical_headers,
                signed_header_names,
                hashlib.sha256(body).hexdigest(),
            ]
        )
        scope = f"{date_stamp}/{self._region}/cognito-idp/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._signing_key(credentials.secret_access_key, date_stamp),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_header_names}, Signature={signature}"
            ),
        }
        status_code, response_headers, response_body = self._transport.call(
            f"https://{host}/",
            headers,
            body,
            self._timeout_seconds,
        )
        try:
            decoded = json.loads(response_body) if response_body else {}
        except ValueError as error:
            raise IdentityProvisioningUnavailable("Cognito returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise IdentityProvisioningUnavailable("Cognito returned an invalid response")
        if 200 <= status_code < 300:
            return cast(dict[str, Any], decoded)

        error_type = (
            str(
                response_headers.get("x-amzn-errortype")
                or response_headers.get("X-Amzn-Errortype")
                or decoded.get("__type", "")
            )
            .split(":", 1)[0]
            .rsplit("#", 1)[-1]
        )
        if error_type == "UserNotFoundException":
            raise _CognitoNotFound
        if error_type in {"UsernameExistsException", "AliasExistsException"}:
            raise _CognitoAlreadyExists
        if error_type in {"InvalidParameterException", "InvalidPasswordException"}:
            raise IdentityProvisioningConflict("Cognito rejected the invited identity")
        raise IdentityProvisioningUnavailable("Cognito provisioning failed")

    def _signing_key(self, secret: str, date_stamp: str) -> bytes:
        date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, b"cognito-idp", hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()

    @staticmethod
    def _identity(
        user: Mapping[str, Any], expected_email: str, fallback_name: str
    ) -> ProvisionedIdentity:
        attributes_value = user.get("Attributes") or user.get("UserAttributes")
        if not isinstance(attributes_value, list):
            raise IdentityProvisioningUnavailable("Cognito returned invalid user attributes")
        attributes = {
            str(item.get("Name")): str(item.get("Value"))
            for item in attributes_value
            if isinstance(item, dict) and item.get("Name") and item.get("Value")
        }
        subject = attributes.get("sub")
        email = attributes.get("email", "").lower()
        if not subject or email != expected_email:
            raise IdentityProvisioningConflict("Cognito identity does not match the invitation")
        return ProvisionedIdentity(
            subject=subject,
            email=email,
            display_name=attributes.get("name") or fallback_name,
        )


class _CognitoNotFound(RuntimeError):
    pass


class _CognitoAlreadyExists(RuntimeError):
    pass
