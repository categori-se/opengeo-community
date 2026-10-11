import asyncio
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from opengeo_api.cognito_provisioning import (
    AwsCognitoIdentityProvisioner,
    AwsCredentials,
    IdentityProvisioningConflict,
)
from opengeo_api.config import Settings


class StaticCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret", "session-token")


class ScriptedTransport:
    def __init__(self, responses: list[tuple[int, Mapping[str, str], dict[str, Any]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, Mapping[str, str], dict[str, Any], float]] = []

    def call(self, url, headers, body, timeout_seconds):
        self.calls.append((url, headers, json.loads(body), timeout_seconds))
        status, response_headers, response = self.responses.pop(0)
        return status, response_headers, json.dumps(response).encode()


def settings() -> Settings:
    return Settings(
        env="test",
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_test",
        cognito_client_id="client-id",
    )


def provisioner(transport: ScriptedTransport) -> AwsCognitoIdentityProvisioner:
    return AwsCognitoIdentityProvisioner(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 19, 12, tzinfo=UTC),
    )


def test_existing_user_is_returned_without_creation() -> None:
    transport = ScriptedTransport(
        [
            (
                200,
                {},
                {
                    "Username": "invitee@example.test",
                    "UserAttributes": [
                        {"Name": "sub", "Value": "subject-123"},
                        {"Name": "email", "Value": "invitee@example.test"},
                        {"Name": "name", "Value": "Existing Name"},
                    ],
                },
            )
        ]
    )

    identity = asyncio.run(provisioner(transport).ensure_user(" Invitee@Example.Test ", "Invitee"))

    assert identity.subject == "subject-123"
    assert identity.display_name == "Existing Name"
    assert len(transport.calls) == 1
    assert transport.calls[0][2] == {
        "UserPoolId": "us-east-1_test",
        "Username": "invitee@example.test",
    }


def test_missing_user_is_created_with_email_delivery_and_sigv4() -> None:
    transport = ScriptedTransport(
        [
            (400, {"x-amzn-errortype": "UserNotFoundException:"}, {}),
            (
                200,
                {},
                {
                    "User": {
                        "Attributes": [
                            {"Name": "sub", "Value": "new-subject"},
                            {"Name": "email", "Value": "new@example.test"},
                            {"Name": "name", "Value": "New User"},
                        ]
                    }
                },
            ),
        ]
    )

    identity = asyncio.run(provisioner(transport).ensure_user("new@example.test", "New User"))

    assert identity.subject == "new-subject"
    assert transport.calls[1][2]["DesiredDeliveryMediums"] == ["EMAIL"]
    headers = transport.calls[1][1]
    assert headers["x-amz-target"].endswith(".AdminCreateUser")
    assert headers["x-amz-security-token"] == "session-token"
    assert (
        "Credential=AKIDEXAMPLE/20260819/us-east-1/cognito-idp/aws4_request"
        in headers["authorization"]
    )
    assert "Signature=" in headers["authorization"]


def test_create_race_reloads_the_winning_identity() -> None:
    transport = ScriptedTransport(
        [
            (400, {"x-amzn-errortype": "UserNotFoundException"}, {}),
            (400, {"x-amzn-errortype": "UsernameExistsException"}, {}),
            (
                200,
                {},
                {
                    "UserAttributes": [
                        {"Name": "sub", "Value": "winner"},
                        {"Name": "email", "Value": "race@example.test"},
                    ]
                },
            ),
        ]
    )

    identity = asyncio.run(provisioner(transport).ensure_user("race@example.test", "Race"))

    assert identity.subject == "winner"
    assert len(transport.calls) == 3


def test_mismatched_cognito_email_fails_closed() -> None:
    transport = ScriptedTransport(
        [
            (
                200,
                {},
                {
                    "UserAttributes": [
                        {"Name": "sub", "Value": "subject"},
                        {"Name": "email", "Value": "different@example.test"},
                    ]
                },
            )
        ]
    )

    with pytest.raises(IdentityProvisioningConflict):
        asyncio.run(provisioner(transport).ensure_user("expected@example.test", "Expected"))
