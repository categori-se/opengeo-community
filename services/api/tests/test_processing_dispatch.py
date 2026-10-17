import asyncio
from datetime import UTC, datetime
from urllib.parse import parse_qs
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.processing_dispatch import (
    AwsSqsConnectionVerificationDispatcher,
    AwsSqsExternalSourceDiscoveryDispatcher,
    AwsSqsExternalSourceSnapshotDispatcher,
    AwsSqsFrameworkPublicationDispatcher,
    AwsSqsGeoNodeHarvestDispatcher,
    AwsSqsObservableBuildDispatcher,
    AwsSqsPmtilesDerivativeDispatcher,
    AwsSqsRenderDispatcher,
    AwsSqsRepositoryObjectCopyDispatcher,
    AwsSqsUserDatasetVerificationDispatcher,
    ProcessingDispatchUnavailable,
    UnavailableFrameworkPublicationDispatcher,
)

JOB_ID = UUID("a6000000-0000-4000-8000-000000000001")


@pytest.fixture(autouse=True)
def inline_threadpool(monkeypatch: pytest.MonkeyPatch) -> None:
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)


class Credentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret-key", "session-token")


class Transport:
    def __init__(self, status: int = 200, response: bytes | None = None) -> None:
        self.status = status
        self.response = response or (
            b"<SendMessageResponse><SendMessageResult><MessageId>message-1</MessageId>"
            b"</SendMessageResult></SendMessageResponse>"
        )
        self.calls: list[tuple] = []

    def call(self, url, headers, body, timeout_seconds):
        self.calls.append((url, headers, body, timeout_seconds))
        return self.status, self.response


def settings() -> Settings:
    return Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="opengeo-render-test",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        processing_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
        connection_verification_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-verification"
        ),
        user_dataset_verification_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-dataset-verification"
        ),
        observable_build_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-observable-builds"
        ),
        external_source_snapshot_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-source-snapshots"
        ),
        repository_object_copy_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-repository-copies"
        ),
    )


def test_dispatches_only_a_bounded_render_identity_with_sigv4() -> None:
    transport = Transport()
    dispatcher = AwsSqsRenderDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    asyncio.run(dispatcher.dispatch_render(JOB_ID))

    url, headers, body, timeout = transport.calls[0]
    fields = parse_qs(body.decode())
    assert url.endswith("/111111111111/opengeo-processing")
    assert fields == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"render_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.render.command.v1"}'
        ],
        "Version": ["2012-11-05"],
    }
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert headers["x-amz-security-token"] == "session-token"
    assert timeout == 5.0


def test_publication_dispatch_carries_only_the_approved_review_identity() -> None:
    transport = Transport()
    dispatcher = AwsSqsRenderDispatcher(settings(), credentials=Credentials(), transport=transport)
    asyncio.run(dispatcher.dispatch_framework_publication(JOB_ID))
    fields = parse_qs(transport.calls[0][2].decode())
    assert fields["MessageBody"] == [
        '{"review_id":"a6000000-0000-4000-8000-000000000001",'
        '"schema":"opengeo.framework-publication.command.1.0.0"}'
    ]


def test_observation_retry_changes_visibility_without_sending_a_new_command() -> None:
    transport = Transport(response=b"<ChangeMessageVisibilityResponse/>")
    dispatcher = AwsSqsRenderDispatcher(settings(), credentials=Credentials(), transport=transport)
    asyncio.run(dispatcher.change_visibility("receipt-for-original-message", 60))
    assert parse_qs(transport.calls[0][2].decode()) == {
        "Action": ["ChangeMessageVisibility"],
        "Version": ["2012-11-05"],
        "ReceiptHandle": ["receipt-for-original-message"],
        "VisibilityTimeout": ["60"],
    }
    assert b"MessageBody" not in transport.calls[0][2]


def test_dispatches_only_a_bounded_coverage_derivative_identity() -> None:
    transport = Transport()
    dispatcher = AwsSqsRenderDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    asyncio.run(dispatcher.dispatch_coverage_derivative(JOB_ID))

    _, _, body, _ = transport.calls[0]
    assert parse_qs(body.decode())["MessageBody"] == [
        '{"coverage_derivative_job_id":"a6000000-0000-4000-8000-000000000001",'
        '"schema":"opengeo.coverage-derivative.command.v1"}'
    ]


def test_dispatches_only_a_bounded_coverage_reclamation_identity() -> None:
    transport = Transport()
    dispatcher = AwsSqsRenderDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    asyncio.run(dispatcher.dispatch_coverage_derivative_reclamation(JOB_ID))

    _, _, body, _ = transport.calls[0]
    assert parse_qs(body.decode())["MessageBody"] == [
        '{"coverage_derivative_reclamation_id":'
        '"a6000000-0000-4000-8000-000000000001",'
        '"schema":"opengeo.coverage-derivative-reclamation.command.v1"}'
    ]


def test_dispatches_only_a_bounded_render_cache_reclamation_identity() -> None:
    transport = Transport()
    dispatcher = AwsSqsRenderDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    asyncio.run(dispatcher.dispatch_tile_cache_reclamation(JOB_ID))

    _, _, body, _ = transport.calls[0]
    assert parse_qs(body.decode())["MessageBody"] == [
        '{"render_cache_reclamation_id":'
        '"a6000000-0000-4000-8000-000000000001",'
        '"schema":"opengeo.render-cache-reclamation.command.v1"}'
    ]


def test_fails_closed_on_rejected_or_malformed_queue_responses() -> None:
    for transport in (Transport(503, b"unavailable"), Transport(200, b"<invalid")):
        dispatcher = AwsSqsRenderDispatcher(
            settings(), credentials=Credentials(), transport=transport
        )
        with pytest.raises(ProcessingDispatchUnavailable):
            asyncio.run(dispatcher.dispatch_render(JOB_ID))


def test_dispatches_only_a_connection_verification_identity_to_its_separate_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsConnectionVerificationDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 23, 12, tzinfo=UTC),
    )
    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_connection_verification(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-verification")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"schema":"opengeo.connection-verification.command.v1",'
            '"verification_id":"a6000000-0000-4000-8000-000000000001"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_an_observable_build_identity_to_its_separate_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsObservableBuildDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 23, 12, tzinfo=UTC),
    )
    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_observable_build(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-observable-builds")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"build_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.observable-build.command.1.0.0"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_repository_copy_identity_to_its_isolated_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsRepositoryObjectCopyDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 31, 12, tzinfo=UTC),
    )

    asyncio.run(dispatcher.dispatch_repository_object_copy(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-repository-copies")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"copy_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.repository-object-copy.command.1.0.0"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_user_dataset_verification_id_to_its_separate_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsUserDatasetVerificationDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 25, 12, tzinfo=UTC),
    )
    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_user_dataset_verification(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-dataset-verification")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"schema":"opengeo.user-dataset-verification.command.v1",'
            '"verification_id":"a6000000-0000-4000-8000-000000000001"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_source_snapshot_id_to_the_outbound_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsExternalSourceSnapshotDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 28, 12, tzinfo=UTC),
    )

    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_external_source_snapshot(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-source-snapshots")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"schema":"opengeo.external-source-snapshot.command.1.0.0",'
            '"snapshot_job_id":"a6000000-0000-4000-8000-000000000001"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_source_discovery_id_to_the_outbound_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsExternalSourceDiscoveryDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 30, 12, tzinfo=UTC),
    )

    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_external_source_discovery(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-source-snapshots")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"discovery_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.external-source-discovery.command.1.0.0"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_geonode_harvest_id_to_the_outbound_queue() -> None:
    transport = Transport()
    dispatcher = AwsSqsGeoNodeHarvestDispatcher(
        settings(),
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 31, 12, tzinfo=UTC),
    )

    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_geonode_harvest(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-source-snapshots")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"harvest_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.geonode-harvest.command.1.0.0"}'
        ],
        "Version": ["2012-11-05"],
    }


def test_dispatches_only_a_pmtiles_job_id_to_the_isolated_v2_queue() -> None:
    transport = Transport()
    configured = settings().model_copy(
        update={
            "worker_processing_mode": "pmtiles-v2",
            "pmtiles_derivative_queue_url": (
                "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-pmtiles-v2"
            ),
            "pmtiles_worker_image_digest": "sha256:" + "d" * 64,
        }
    )
    dispatcher = AwsSqsPmtilesDerivativeDispatcher(
        configured,
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 28, 12, tzinfo=UTC),
    )

    assert dispatcher.available is True
    assert dispatcher.supports_recipe("gdal-pmtiles-v2")
    assert not dispatcher.supports_recipe("gdal-pmtiles-v1")
    asyncio.run(dispatcher.dispatch_pmtiles_derivative(JOB_ID))

    url, _, body, _ = transport.calls[0]
    assert url.endswith("/111111111111/opengeo-pmtiles-v2")
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"pmtiles_derivative_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.pmtiles-derivative.command.v1"}'
        ],
        "Version": ["2012-11-05"],
    }


@pytest.mark.parametrize("snapshot_configured", [False, True])
def test_discovery_dispatch_uses_explicit_queue_and_only_sealed_job_uuid(
    snapshot_configured: bool,
) -> None:
    queue_url = "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only"
    configured = Settings(
        **{
            **settings().model_dump(),
            "external_source_discovery_queue_url": queue_url,
            "external_source_snapshot_queue_url": (
                settings().external_source_snapshot_queue_url if snapshot_configured else None
            ),
        }
    )
    transport = Transport()
    dispatcher = AwsSqsExternalSourceDiscoveryDispatcher(
        configured,
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 10, 3, 12, tzinfo=UTC),
    )
    asyncio.run(dispatcher.dispatch_external_source_discovery(JOB_ID))

    assert len(transport.calls) == 1
    url, headers, body, timeout = transport.calls[0]
    assert url == queue_url
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert timeout == 5.0
    assert parse_qs(body.decode()) == {
        "Action": ["SendMessage"],
        "MessageBody": [
            '{"discovery_job_id":"a6000000-0000-4000-8000-000000000001",'
            '"schema":"opengeo.external-source-discovery.command.1.0.0"}'
        ],
        "Version": ["2012-11-05"],
    }
    if not snapshot_configured:
        with pytest.raises(ValueError, match="snapshot dispatch must be configured"):
            AwsSqsExternalSourceSnapshotDispatcher(configured)
        with pytest.raises(ValueError, match="harvest dispatch must be configured"):
            AwsSqsGeoNodeHarvestDispatcher(configured)


def test_framework_publication_adapter_uses_only_its_configured_queue_and_review_id():
    import json

    configuration = settings()
    with pytest.raises(ValueError):
        AwsSqsFrameworkPublicationDispatcher(configuration)
    unavailable = UnavailableFrameworkPublicationDispatcher()
    assert unavailable.available is False
    with pytest.raises(ProcessingDispatchUnavailable):
        asyncio.run(unavailable.dispatch_framework_publication(JOB_ID))
    queue = "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-publications"
    configuration.framework_publication_queue_url = queue
    transport = Transport()
    dispatcher = AwsSqsFrameworkPublicationDispatcher(
        configuration,
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 10, 17, tzinfo=UTC),
    )
    assert dispatcher.available is True
    asyncio.run(dispatcher.dispatch_framework_publication(JOB_ID))
    assert len(transport.calls) == 1
    url, _, body, _ = transport.calls[0]
    assert url == queue
    payload = parse_qs(body.decode())
    assert json.loads(payload["MessageBody"][0]) == {
        "schema": "opengeo.framework-publication.command.1.0.0",
        "review_id": str(JOB_ID),
    }
