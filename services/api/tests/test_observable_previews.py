import base64
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.observable_previews import (
    CloudFrontPreviewCookieSigner,
    SecretsManagerPreviewCookieSigner,
)


def cloudfront_decode(value: str) -> bytes:
    return base64.b64decode(value.replace("-", "+").replace("_", "=").replace("~", "/"))


@pytest.mark.parametrize("hostname", ["preview", "maps-preview"])
def test_cloudfront_preview_cookie_signer_seals_one_exact_path_and_expiry(hostname: str) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    signer = CloudFrontPreviewCookieSigner("KEYPAIR123", pem)
    expires_at = datetime(2026, 8, 22, 20, 15, tzinfo=UTC)
    resource = (
        f"https://{hostname}.studio.opengeo.tools/organizations/10000000-0000-4000-8000-"
        "000000000459/projects/50000000-0000-4000-8000-000000000459/source-projects/"
        "b0000000-0000-4000-8000-000000000459/builds/"
        "e0000000-0000-4000-8000-000000000459/output/*"
    )
    cookies = signer.sign(resource, expires_at)
    assert set(cookies) == {
        "CloudFront-Policy",
        "CloudFront-Signature",
        "CloudFront-Key-Pair-Id",
    }
    assert cookies["CloudFront-Key-Pair-Id"] == "KEYPAIR123"
    policy = cloudfront_decode(cookies["CloudFront-Policy"])
    assert json.loads(policy) == {
        "Statement": [
            {
                "Resource": resource,
                "Condition": {"DateLessThan": {"AWS:EpochTime": int(expires_at.timestamp())}},
            }
        ]
    }
    private_key.public_key().verify(
        cloudfront_decode(cookies["CloudFront-Signature"]),
        policy,
        padding.PKCS1v15(),
        hashes.SHA1(),
    )


def test_cloudfront_preview_cookie_signer_rejects_wrong_keys_and_origins() -> None:
    weak_key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    weak_pem = weak_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with pytest.raises(ValueError, match="at least 2048"):
        CloudFrontPreviewCookieSigner("KEYPAIR123", weak_pem)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with pytest.raises(ValueError, match="key pair id"):
        CloudFrontPreviewCookieSigner("bad", pem)
    signer = CloudFrontPreviewCookieSigner("KEYPAIR123", pem)
    with pytest.raises(ValueError, match="resource URL"):
        signer.sign("https://studio.opengeo.tools/private/*", datetime.now(UTC))
    for hostname in ["maps-preview.studio.opengeo.tools.evil.test", "other.studio.opengeo.tools"]:
        with pytest.raises(ValueError, match="resource URL"):
            signer.sign(f"https://{hostname}/organizations/*", datetime.now(UTC))


class FakeCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIATEST", "test-secret", "session-token")


class FakeSecretsManagerTransport:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self.payload = payload
        self.calls: list[tuple[str, dict[str, str], bytes, float]] = []

    def call(
        self,
        url: str,
        headers: dict[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]:
        self.calls.append((url, dict(headers), body, timeout_seconds))
        return self.status_code, json.dumps(self.payload).encode()


def preview_settings() -> Settings:
    return Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="storage.opengeo.tools",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        observable_preview_origin="https://preview.studio.opengeo.tools",
        observable_preview_key_pair_id="KEYPAIR123",
        observable_preview_private_key_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/preview-AbCd"
        ),
    )


def test_secrets_manager_signer_loads_exact_secret_once_before_signing() -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    transport = FakeSecretsManagerTransport(
        200,
        {"SecretString": json.dumps({"key_pair_id": "KEYPAIR123", "private_key_pem": pem})},
    )
    signer = SecretsManagerPreviewCookieSigner(
        preview_settings(),
        credentials=FakeCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 22, 20, 0, tzinfo=UTC),
    )
    assert signer.available is True
    assert signer.available is True
    cookies = signer.sign(
        "https://preview.studio.opengeo.tools/organizations/10000000-0000-4000-8000-"
        "000000000459/projects/50000000-0000-4000-8000-000000000459/source-projects/"
        "b0000000-0000-4000-8000-000000000459/builds/"
        "e0000000-0000-4000-8000-000000000459/output/*",
        datetime(2026, 8, 22, 20, 15, tzinfo=UTC),
    )
    assert cookies["CloudFront-Key-Pair-Id"] == "KEYPAIR123"
    assert len(transport.calls) == 1
    url, headers, body, timeout = transport.calls[0]
    assert url == "https://secretsmanager.us-east-1.amazonaws.com/"
    assert json.loads(body) == {
        "SecretId": preview_settings().observable_preview_private_key_secret_arn
    }
    assert headers["x-amz-target"] == "secretsmanager.GetSecretValue"
    assert "20260822/us-east-1/secretsmanager/aws4_request" in headers["authorization"]
    assert headers["x-amz-security-token"] == "session-token"
    assert timeout == preview_settings().cognito_http_timeout_seconds


@pytest.mark.parametrize(
    ("status_code", "secret"),
    [
        (503, {}),
        (200, {"SecretString": "not-json"}),
        (
            200,
            {
                "SecretString": json.dumps(
                    {"key_pair_id": "WRONGKEY1", "private_key_pem": "not-a-key"}
                )
            },
        ),
        (
            200,
            {
                "SecretString": json.dumps(
                    {
                        "key_pair_id": "KEYPAIR123",
                        "private_key_pem": "not-a-key",
                        "unexpected": True,
                    }
                )
            },
        ),
    ],
)
def test_secrets_manager_signer_fails_closed(status_code: int, secret: dict[str, Any]) -> None:
    signer = SecretsManagerPreviewCookieSigner(
        preview_settings(),
        credentials=FakeCredentials(),
        transport=FakeSecretsManagerTransport(status_code, secret),
        now=lambda: datetime(2026, 8, 22, 20, 0, tzinfo=UTC),
    )
    assert signer.available is False
