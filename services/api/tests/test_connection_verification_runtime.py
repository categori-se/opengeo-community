import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.connection_verification import (
    PostgreSqlCredentials,
    VerificationOutcome,
)
from opengeo_api.connection_verification_runtime import (
    AwsConnectionVerificationSecretLoader,
    ConnectionVerificationProcessor,
    RdsDataVerificationCoordinator,
    VerificationClaim,
    VerificationCommand,
    VerificationCommandInvalid,
    VerificationDependencyUnavailable,
    VerifierRuntimeSettings,
    handle_sqs_event,
    parse_verification_command,
)
from opengeo_api.rds_data import DataApiResult

VERIFICATION_ID = UUID("8abcdef0-0000-4000-8000-000000000488")
ORG_ID = UUID("10000000-0000-4000-8000-000000000488")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000488")
CONNECTION_ID = UUID("70000000-0000-4000-8000-000000000488")
SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/"
    f"{ORG_ID}/{CONNECTION_ID}-AbCd12"
)


def claim() -> VerificationClaim:
    return VerificationClaim(
        verification_id=VERIFICATION_ID,
        organization_id=ORG_ID,
        project_id=PROJECT_ID,
        connection_id=CONNECTION_ID,
        connection_revision_number=1,
        endpoint_host="gis.example.test",
        endpoint_port=5432,
        database_name="research",
        tls_mode="verify_full",
        network_mode="public_internet",
        secret_reference=SECRET_ARN,
    )


class Coordinator:
    def __init__(self, claimed: VerificationClaim | None = None) -> None:
        self.claimed = claimed
        self.claim_calls: list[tuple] = []
        self.completions: list[tuple] = []
        self.releases: list[tuple] = []

    async def claim(self, verification_id, worker_token, lease_seconds):
        self.claim_calls.append((verification_id, worker_token, lease_seconds))
        return self.claimed

    async def complete(self, verification_id, worker_token, outcome):
        self.completions.append((verification_id, worker_token, outcome))
        return True

    async def release(self, verification_id, worker_token, max_attempts):
        self.releases.append((verification_id, worker_token, max_attempts))
        return "queued"


class SecretLoader:
    def __init__(self) -> None:
        self.references: list[str] = []

    async def load(self, secret_reference: str) -> PostgreSqlCredentials:
        self.references.append(secret_reference)
        return PostgreSqlCredentials("read_only", "database-password")


class Verifier:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def verify(self, target, credentials):
        self.calls.append((target, credentials))
        return VerificationOutcome(True, True, True, True, True, None, 25)


def test_command_accepts_only_one_canonical_identity() -> None:
    body = json.dumps(
        {
            "schema": "opengeo.connection-verification.command.v1",
            "verification_id": str(VERIFICATION_ID),
        }
    )
    assert parse_verification_command(body) == VerificationCommand(VERIFICATION_ID)

    for invalid in [
        "not-json",
        json.dumps({"schema": "opengeo.connection-verification.command.v1"}),
        json.dumps(
            {
                "schema": "opengeo.connection-verification.command.v1",
                "verification_id": str(VERIFICATION_ID).upper(),
            }
        ),
        json.dumps(
            {
                "schema": "opengeo.connection-verification.command.v1",
                "verification_id": str(VERIFICATION_ID),
                "host": "attacker.example.test",
            }
        ),
        "x" * 513,
    ]:
        with pytest.raises(VerificationCommandInvalid):
            parse_verification_command(invalid)


def test_processor_loads_credentials_only_after_a_successful_function_claim() -> None:
    coordinator = Coordinator(claim())
    secret_loader = SecretLoader()
    verifier = Verifier()
    completed = asyncio.run(
        ConnectionVerificationProcessor(coordinator, secret_loader, verifier).process(
            VerificationCommand(VERIFICATION_ID)
        )
    )

    assert completed is True
    assert coordinator.claim_calls[0][0] == VERIFICATION_ID
    worker_token = coordinator.claim_calls[0][1]
    assert coordinator.completions == [
        (
            VERIFICATION_ID,
            worker_token,
            VerificationOutcome(True, True, True, True, True, None, 25),
        )
    ]
    assert secret_loader.references == [SECRET_ARN]
    assert verifier.calls[0][0].host == "gis.example.test"
    serialized = repr(coordinator.completions) + repr(verifier.calls)
    assert "database-password" not in serialized
    assert SECRET_ARN not in serialized


def test_processor_does_not_load_secrets_for_busy_or_terminal_work() -> None:
    coordinator = Coordinator(None)
    secret_loader = SecretLoader()
    verifier = Verifier()
    completed = asyncio.run(
        ConnectionVerificationProcessor(coordinator, secret_loader, verifier).process(
            VerificationCommand(VERIFICATION_ID)
        )
    )
    assert completed is False
    assert secret_loader.references == []
    assert verifier.calls == []
    assert coordinator.completions == []


def test_processor_releases_dependency_failures_and_consumes_terminal_exhaustion() -> None:
    class FailingLoader:
        async def load(self, secret_reference):
            del secret_reference
            raise VerificationDependencyUnavailable("temporary")

    coordinator = Coordinator(claim())
    processor = ConnectionVerificationProcessor(coordinator, FailingLoader(), Verifier())
    with pytest.raises(VerificationDependencyUnavailable):
        asyncio.run(processor.process(VerificationCommand(VERIFICATION_ID)))
    assert len(coordinator.releases) == 1
    assert coordinator.completions == []

    async def terminal_release(verification_id, worker_token, max_attempts):
        coordinator.releases.append((verification_id, worker_token, max_attempts))
        return "failed"

    coordinator.release = terminal_release
    assert asyncio.run(processor.process(VerificationCommand(VERIFICATION_ID))) is False


def test_processor_releases_unexpected_verifier_failure() -> None:
    class FailingVerifier:
        async def verify(self, target, credentials):
            del target, credentials
            raise RuntimeError("driver invariant")

    coordinator = Coordinator(claim())
    processor = ConnectionVerificationProcessor(coordinator, SecretLoader(), FailingVerifier())
    with pytest.raises(VerificationDependencyUnavailable):
        asyncio.run(processor.process(VerificationCommand(VERIFICATION_ID)))
    assert len(coordinator.releases) == 1
    assert coordinator.completions == []


def test_claim_repr_redacts_the_secret_reference_and_endpoint() -> None:
    serialized = repr(claim())
    assert SECRET_ARN not in serialized
    assert "gis.example.test" not in serialized


def runtime_settings() -> VerifierRuntimeSettings:
    return VerifierRuntimeSettings(
        stage="test",
        region="us-east-1",
        database_cluster_arn=("arn:aws:rds:us-east-1:111111111111:cluster:opengeo-test"),
        database_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connector-AbCd12"
        ),
    )


def test_runtime_configuration_rejects_cross_partition_database_identity() -> None:
    environment = {
        "OPEN_GEO_CONNECTION_VERIFIER_STAGE": "production",
        "OPEN_GEO_DATA_API_REGION": "us-gov-west-1",
        "OPEN_GEO_DATA_API_CLUSTER_ARN": (
            "arn:aws:rds:us-gov-west-1:111111111111:cluster:opengeo-production"
        ),
        "OPEN_GEO_DATA_API_SECRET_ARN": (
            "arn:aws-us-gov:secretsmanager:us-gov-west-1:111111111111:"
            "secret:opengeo/production/connector-AbCd12"
        ),
    }
    with pytest.raises(VerificationDependencyUnavailable):
        VerifierRuntimeSettings.from_environment(environment)


class DataApi:
    def __init__(self, *results: DataApiResult) -> None:
        self.results = list(results)
        self.calls: list[tuple] = []

    async def execute(self, statement, parameters=(), transaction_id=None):
        self.calls.append((statement, parameters, transaction_id))
        return self.results.pop(0)


def test_data_api_coordinator_uses_only_fixed_claim_and_completion_functions() -> None:
    record = (
        "claimed",
        VERIFICATION_ID,
        ORG_ID,
        PROJECT_ID,
        CONNECTION_ID,
        1,
        "postgresql",
        "gis.example.test",
        5432,
        "research",
        "verify_full",
        "public_internet",
        SECRET_ARN,
        1,
    )
    client = DataApi(
        DataApiResult((record,), 0),
        DataApiResult(((True,),), 0),
        DataApiResult((("queued",),), 0),
    )
    coordinator = RdsDataVerificationCoordinator(client)

    async def exercise() -> None:
        claimed = await coordinator.claim(VERIFICATION_ID, CONNECTION_ID, 20)
        assert claimed == claim()
        assert await coordinator.complete(
            VERIFICATION_ID,
            CONNECTION_ID,
            VerificationOutcome(True, True, True, True, True, None, 25),
        )
        assert await coordinator.release(VERIFICATION_ID, CONNECTION_ID, 3) == "queued"

    asyncio.run(exercise())
    assert "claim_external_connection_verification" in client.calls[0][0]
    assert client.calls[0][1] == (VERIFICATION_ID, CONNECTION_ID, 20)
    assert "complete_external_connection_verification" in client.calls[1][0]
    assert "release_external_connection_verification" in client.calls[2][0]
    serialized = repr(client.calls)
    assert SECRET_ARN not in serialized
    assert "database-password" not in serialized


class Credentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "signing-secret", "session-token")


class SecretTransport:
    def __init__(self, response: dict | None = None) -> None:
        self.response = response or {
            "ARN": SECRET_ARN,
            "SecretString": json.dumps({"username": "read_only", "password": "database-password"}),
        }
        self.calls: list[tuple] = []

    def call(self, url, headers, body, timeout_seconds):
        self.calls.append((url, headers, body, timeout_seconds))
        return 200, json.dumps(self.response).encode()


def test_read_only_secret_loader_gets_only_the_exact_stage_connection_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = SecretTransport()
    loader = AwsConnectionVerificationSecretLoader(
        runtime_settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 23, 12, tzinfo=UTC),
    )
    loaded = asyncio.run(loader.load(SECRET_ARN))
    assert loaded.username == "read_only"
    assert loaded.password == "database-password"
    assert json.loads(transport.calls[0][2]) == {"SecretId": SECRET_ARN}
    assert transport.calls[0][1]["x-amz-target"] == "secretsmanager.GetSecretValue"
    serialized_headers = json.dumps(transport.calls[0][1])
    assert "database-password" not in serialized_headers
    assert "signing-secret" not in serialized_headers

    for invalid in [
        SECRET_ARN.replace("opengeo/test/", "opengeo/production/"),
        SECRET_ARN.replace("111111111111", "222222222222"),
        "arn:aws:secretsmanager:us-east-1:111111111111:secret:anything",
    ]:
        with pytest.raises(Exception, match="reference is invalid"):
            asyncio.run(loader.load(invalid))
    assert len(transport.calls) == 1


def test_runtime_configuration_requires_same_region_and_account() -> None:
    environment = {
        "OPEN_GEO_CONNECTION_VERIFIER_STAGE": "production",
        "OPEN_GEO_DATA_API_REGION": "us-east-1",
        "OPEN_GEO_DATA_API_CLUSTER_ARN": (
            "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production"
        ),
        "OPEN_GEO_DATA_API_SECRET_ARN": (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/production/connector-AbCd12"
        ),
        "OPEN_GEO_DB_NAME": "opengeo",
    }
    parsed = VerifierRuntimeSettings.from_environment(environment)
    assert parsed.account_id == "111111111111"
    assert parsed.data_api_settings().data_api_configured is True
    environment["OPEN_GEO_DATA_API_SECRET_ARN"] = environment[
        "OPEN_GEO_DATA_API_SECRET_ARN"
    ].replace("111111111111", "222222222222")
    with pytest.raises(Exception, match="configuration is invalid"):
        VerifierRuntimeSettings.from_environment(environment)


def test_sqs_handler_returns_only_partial_batch_failure_ids() -> None:
    coordinator = Coordinator(claim())
    processor = ConnectionVerificationProcessor(coordinator, SecretLoader(), Verifier())
    good = json.dumps(
        {
            "schema": "opengeo.connection-verification.command.v1",
            "verification_id": str(VERIFICATION_ID),
        }
    )
    result = asyncio.run(
        handle_sqs_event(
            {
                "Records": [
                    {"messageId": "message-good", "body": good},
                    {"messageId": "message-bad", "body": "not-json"},
                ]
            },
            processor,
        )
    )
    assert result == {"batchItemFailures": [{"itemIdentifier": "message-bad"}]}
