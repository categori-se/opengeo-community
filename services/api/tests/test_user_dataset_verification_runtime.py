import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.user_dataset_verification_runtime import (
    AssumeRoleDenied,
    AwsS3DatasetProbe,
    AwsStsRoleAssumer,
    AwsUserDatasetCredentialLoader,
    DatasetConnectionCredentials,
    DatasetVerificationClaim,
    DatasetVerificationCommand,
    DatasetVerificationCommandInvalid,
    DatasetVerificationDependencyUnavailable,
    DatasetVerificationOutcome,
    DatasetVerificationRejected,
    S3ProbeOutcome,
    UserDatasetAccessVerifier,
    UserDatasetVerificationProcessor,
    UserDatasetVerifierSettings,
    handle_sqs_event,
    parse_user_dataset_verification_command,
)

VERIFICATION_ID = UUID("b0000000-0000-4000-8000-000000000052")
ORG_ID = UUID("10000000-0000-4000-8000-000000000052")
OWNER_ID = UUID("20000000-0000-4000-8000-000000000052")
CONNECTION_ID = UUID("a0000000-0000-4000-8000-000000000052")
ROLE_ARN = "arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader"
SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/"
    f"user-connections/{ORG_ID}/{OWNER_ID}/{CONNECTION_ID}/version-AbCd12"
)
TASK_CREDENTIALS = AwsCredentials("TASKACCESSKEY", "task-secret", "task-token")
ASSUMED_CREDENTIALS = AwsCredentials("ASSUMEDACCESSKEY", "assumed-secret", "assumed-token")


def claim() -> DatasetVerificationClaim:
    return DatasetVerificationClaim(
        verification_id=VERIFICATION_ID,
        organization_id=ORG_ID,
        owner_user_id=OWNER_ID,
        connection_id=CONNECTION_ID,
        target_revision=1,
        credential_revision=1,
        bucket_name="example-geodata",
        region_name="us-east-1",
        object_prefix="",
        credential_mode="assume_role",
        role_arn=ROLE_ARN,
        secret_reference=SECRET_ARN,
    )


class Credentials:
    def load(self) -> AwsCredentials:
        return TASK_CREDENTIALS


class RoleAssumer:
    def __init__(self, reject_active: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self.reject_active = reject_active

    async def assume(self, role_arn: str, external_id: str) -> AwsCredentials:
        self.calls.append((role_arn, external_id))
        if external_id.startswith("opengeo-deny-canary") or self.reject_active:
            raise AssumeRoleDenied
        return ASSUMED_CREDENTIALS


class S3Probe:
    def __init__(self) -> None:
        self.calls = []

    async def probe(self, credentials, bucket, region, prefix, deny_prefix):
        self.calls.append((credentials, bucket, region, prefix, deny_prefix))
        return S3ProbeOutcome(True, True, True, 1)


class Coordinator:
    def __init__(self) -> None:
        self.completions: list[DatasetVerificationOutcome] = []
        self.releases: list[tuple[UUID, UUID, int]] = []

    async def claim(self, verification_id, worker_token, lease_seconds):
        assert verification_id == VERIFICATION_ID
        assert lease_seconds == 30
        self.worker_token = worker_token
        return claim()

    async def complete(self, verification_id, worker_token, outcome):
        assert verification_id == VERIFICATION_ID
        assert worker_token == self.worker_token
        self.completions.append(outcome)
        return True

    async def release(self, verification_id, worker_token, max_attempts):
        self.releases.append((verification_id, worker_token, max_attempts))
        return "queued"


class SecretLoader:
    async def load(self, verification_claim):
        assert verification_claim.connection_id == CONNECTION_ID
        return DatasetConnectionCredentials({"external_id": "live-external-id"})


def settings() -> UserDatasetVerifierSettings:
    return UserDatasetVerifierSettings(
        stage="dev",
        region="us-east-1",
        database_cluster_arn=("arn:aws:rds:us-east-1:222222222222:cluster:opengeo-dev-database"),
        database_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:222222222222:"
            "secret:opengeo/dev/dataset-verifier-AbCd12"
        ),
        deny_prefix="opengeo-deny-canary/",
    )


def test_command_is_id_only_and_strict() -> None:
    command = parse_user_dataset_verification_command(
        json.dumps(
            {
                "schema": "opengeo.user-dataset-verification.command.v1",
                "verification_id": str(VERIFICATION_ID),
            }
        )
    )
    assert command.verification_id == VERIFICATION_ID
    for payload in [
        {},
        {"schema": "wrong", "verification_id": str(VERIFICATION_ID)},
        {
            "schema": "opengeo.user-dataset-verification.command.v1",
            "verification_id": str(VERIFICATION_ID),
            "bucket": "secret-bucket",
        },
    ]:
        with pytest.raises(DatasetVerificationCommandInvalid):
            parse_user_dataset_verification_command(json.dumps(payload))


def test_settings_require_exact_same_account_data_api_and_deny_prefix() -> None:
    parsed = UserDatasetVerifierSettings.from_environment(
        {
            "OPEN_GEO_DATASET_VERIFIER_STAGE": "dev",
            "OPEN_GEO_DATA_API_REGION": "us-east-1",
            "OPEN_GEO_DATA_API_CLUSTER_ARN": settings().database_cluster_arn,
            "OPEN_GEO_DATA_API_SECRET_ARN": settings().database_secret_arn,
            "OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX": "opengeo-deny-canary/",
            "OPEN_GEO_DB_NAME": "opengeo",
        }
    )
    assert parsed.account_id == "222222222222"
    assert (
        UserDatasetVerifierSettings.from_environment(
            {
                "OPEN_GEO_DATASET_VERIFIER_STAGE": "demo",
                "OPEN_GEO_DATA_API_REGION": "us-east-1",
                "OPEN_GEO_DATA_API_CLUSTER_ARN": settings().database_cluster_arn,
                "OPEN_GEO_DATA_API_SECRET_ARN": settings().database_secret_arn.replace(
                    "/dev/", "/demo/"
                ),
                "OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX": "opengeo-deny-canary/",
                "OPEN_GEO_DB_NAME": "opengeo",
            }
        ).stage
        == "demo"
    )
    with pytest.raises(DatasetVerificationDependencyUnavailable):
        UserDatasetVerifierSettings.from_environment(
            {
                "OPEN_GEO_DATASET_VERIFIER_STAGE": "dev",
                "OPEN_GEO_DATA_API_REGION": "us-east-1",
                "OPEN_GEO_DATA_API_CLUSTER_ARN": settings().database_cluster_arn,
                "OPEN_GEO_DATA_API_SECRET_ARN": settings().database_secret_arn,
                "OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX": "",
            }
        )


def test_verifier_requires_wrong_external_id_denial_then_positive_s3_and_deny_probe() -> None:
    roles = RoleAssumer()
    s3 = S3Probe()
    clock = iter([1.0, 1.125])
    verifier = UserDatasetAccessVerifier(
        roles, s3, Credentials(), "opengeo-deny-canary/", lambda: next(clock)
    )
    outcome = asyncio.run(
        verifier.verify(claim(), DatasetConnectionCredentials({"external_id": "live-external-id"}))
    )
    assert outcome == DatasetVerificationOutcome(True, True, True, 1, None, 125)
    assert roles.calls[0][1].startswith("opengeo-deny-canary")
    assert roles.calls[1] == (ROLE_ARN, "live-external-id")
    assert s3.calls == [
        (
            ASSUMED_CREDENTIALS,
            "example-geodata",
            "us-east-1",
            "",
            "opengeo-deny-canary/",
        )
    ]
    assert "live-external-id" not in repr(claim())


def test_verifier_sanitizes_active_external_id_denial() -> None:
    clock = iter([1.0, 1.001])
    verifier = UserDatasetAccessVerifier(
        RoleAssumer(reject_active=True),
        S3Probe(),
        Credentials(),
        "opengeo-deny-canary/",
        lambda: next(clock),
    )
    outcome = asyncio.run(
        verifier.verify(claim(), DatasetConnectionCredentials({"external_id": "wrong"}))
    )
    assert outcome.sanitized_error_code == "assume_role_denied"
    assert outcome.duration_ms == 0


def test_processor_completes_terminal_result_and_releases_dependency_failures() -> None:
    coordinator = Coordinator()
    roles = RoleAssumer()
    verifier = UserDatasetAccessVerifier(
        roles, S3Probe(), Credentials(), "opengeo-deny-canary/", lambda: 1.0
    )
    processor = UserDatasetVerificationProcessor(coordinator, SecretLoader(), verifier)
    assert asyncio.run(processor.process(DatasetVerificationCommand(VERIFICATION_ID))) is True
    assert coordinator.completions[0].sanitized_error_code is None
    assert coordinator.releases == []

    class UnavailableLoader:
        async def load(self, verification_claim):
            del verification_claim
            raise DatasetVerificationDependencyUnavailable("unavailable")

    coordinator = Coordinator()
    processor = UserDatasetVerificationProcessor(coordinator, UnavailableLoader(), verifier)
    with pytest.raises(DatasetVerificationDependencyUnavailable):
        asyncio.run(processor.process(DatasetVerificationCommand(VERIFICATION_ID)))
    assert len(coordinator.releases) == 1


def test_sqs_handler_reports_only_retryable_or_invalid_records() -> None:
    class Processor:
        async def process(self, command):
            if command.verification_id == VERIFICATION_ID:
                return True
            raise DatasetVerificationDependencyUnavailable("retry")

    event = {
        "Records": [
            {
                "messageId": "ok",
                "body": json.dumps(
                    {
                        "schema": "opengeo.user-dataset-verification.command.v1",
                        "verification_id": str(VERIFICATION_ID),
                    }
                ),
            },
            {"messageId": "bad", "body": "{}"},
        ]
    }
    assert asyncio.run(handle_sqs_event(event, Processor())) == {
        "batchItemFailures": [{"itemIdentifier": "bad"}]
    }


class OrderedTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def call(self, method, url, headers, body, timeout_seconds, maximum_bytes):
        self.calls.append((method, url, headers, body, timeout_seconds, maximum_bytes))
        return self.responses.pop(0)


def test_s3_probe_lists_at_most_one_key_heads_it_and_requires_denial() -> None:
    root = (
        b"<ListBucketResult><Prefix></Prefix><CommonPrefixes>"
        b"<Prefix>bhutan/</Prefix></CommonPrefixes></ListBucketResult>"
    )
    nested = (
        b"<ListBucketResult><Prefix>bhutan/</Prefix><Contents>"
        b"<Key>bhutan/private/example.tif</Key></Contents></ListBucketResult>"
    )
    transport = OrderedTransport(
        [
            (200, {}, root),
            (200, {}, nested),
            (200, {"Content-Length": "123"}, b""),
            (403, {}, b"<Error><Code>AccessDenied</Code></Error>"),
        ]
    )
    probe = AwsS3DatasetProbe(
        transport=transport,
        now=lambda: datetime(2026, 8, 25, 12, 0, tzinfo=UTC),
    )
    outcome = asyncio.run(
        probe.probe(
            ASSUMED_CREDENTIALS,
            "example-geodata",
            "us-east-1",
            "",
            "opengeo-deny-canary/",
        )
    )
    assert outcome == S3ProbeOutcome(True, True, True, 1)
    assert [call[0] for call in transport.calls] == ["GET", "GET", "HEAD", "GET"]
    assert all(
        "max-keys=1" in call[1]
        for call in (transport.calls[0], transport.calls[1], transport.calls[3])
    )
    assert "bhutan/private/example.tif" in transport.calls[2][1]
    assert "bhutan/private/example.tif" not in repr(outcome)


def test_secret_loader_accepts_only_exact_owner_connection_path_and_shape() -> None:
    response = json.dumps(
        {"SecretString": json.dumps({"external_id": "live-external-id"})}
    ).encode()
    transport = OrderedTransport([(200, {}, response)])
    loader = AwsUserDatasetCredentialLoader(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 25, 12, 0, tzinfo=UTC),
    )
    loaded = asyncio.run(loader.load(claim()))
    assert loaded.values == {"external_id": "live-external-id"}
    assert "live-external-id" not in repr(loaded)

    invalid = DatasetVerificationClaim(
        **{
            field: getattr(claim(), field)
            for field in claim().__dataclass_fields__
            if field != "secret_reference"
        },
        secret_reference=SECRET_ARN.replace(str(OWNER_ID), str(UUID(int=9))),
    )
    with pytest.raises(DatasetVerificationRejected, match="secret_invalid"):
        asyncio.run(loader.load(invalid))


def test_sts_assumer_signs_regional_request_and_parses_temporary_credentials() -> None:
    xml = (
        b"<AssumeRoleResponse><AssumeRoleResult><Credentials>"
        b"<AccessKeyId>A</AccessKeyId><SecretAccessKey>B</SecretAccessKey>"
        b"<SessionToken>C</SessionToken></Credentials></AssumeRoleResult>"
        b"</AssumeRoleResponse>"
    )
    transport = OrderedTransport([(200, {}, xml)])
    assumer = AwsStsRoleAssumer(
        "us-east-1",
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 25, 12, 0, tzinfo=UTC),
    )
    result = asyncio.run(assumer.assume(ROLE_ARN, "external-id"))
    assert result == AwsCredentials("A", "B", "C")
    method, url, headers, body, *_ = transport.calls[0]
    assert method == "POST"
    assert url == "https://sts.us-east-1.amazonaws.com/"
    assert b"ExternalId=external-id" in body
    assert "authorization" in headers
    assert "external-id" not in repr(result)
