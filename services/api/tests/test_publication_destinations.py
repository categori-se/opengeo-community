import asyncio
import json
from dataclasses import asdict, replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from opengeo_api.framework_publisher import PublicationConflict
from opengeo_api.publication_destinations import (
    PROTECTED_STUDIO_HOSTS,
    PublicationDestination,
    PublicationDestinationRouter,
    configured_destination_router,
)

TARGETS = (
    PublicationDestination("opengeo.tools", "opengeo.tools", "EROOT", "root"),
    PublicationDestination("pages.studio.opengeo.tools", "public-pages", "EPAGES", "pages"),
    PublicationDestination("example.org", "external-pages", "EOTHER", "external"),
)
PROTECTED = PROTECTED_STUDIO_HOSTS


def router(targets=TARGETS):
    # Construction and resolution must not request credentials or call AWS.
    return PublicationDestinationRouter(
        object(),
        "private-sources",
        targets,
        protected_hosts=PROTECTED,
    )


def test_explicit_hosts_select_only_their_paired_adapters():
    configured = router()
    for target in TARGETS:
        bucket, storage, edge = configured.resolve(asdict(target))
        assert bucket == storage.public_bucket == target.bucket
        assert storage.source_bucket == "private-sources"
        assert edge.distribution_id == target.distribution_id


def test_existing_dotted_origin_id_is_preserved_in_multi_host_configuration():
    existing = replace(
        TARGETS[0],
        distribution_id="E35IMG4BMV4YSZ",
        origin_id="opengeo.tools.s3.us-east-1.amazonaws.com-mnkd5ulkkgh",
    )
    configured = router((existing, TARGETS[1]))
    assert configured.resolve(asdict(existing))[0] == "opengeo.tools"
    with pytest.raises(PublicationConflict):
        configured.resolve({**asdict(existing), "origin_id": "other.example"})


@pytest.mark.parametrize("field", ["hostname", "bucket", "distribution_id", "origin_id"])
def test_cross_paired_or_missing_origin_is_denied(field):
    configured = router()
    origin = asdict(TARGETS[0])
    origin[field] = getattr(TARGETS[1], field)
    with pytest.raises(PublicationConflict):
        configured.resolve(origin)
    del origin[field]
    with pytest.raises(PublicationConflict):
        configured.resolve(origin)


@pytest.mark.parametrize(
    "changes",
    [{"hostname": host} for host in PROTECTED]
    + [
        {"hostname": "https://example.org"},
        {"hostname": "*.example.org"},
        {"bucket": "private-sources"},
        {"distribution_id": "*"},
        {"origin_id": "../root"},
    ],
)
def test_unsafe_configuration_is_denied(changes):
    with pytest.raises(ValueError):
        router((replace(TARGETS[0], **changes),))


def test_duplicate_host_or_distribution_and_unbounded_configuration_are_denied():
    for targets in [
        (),
        TARGETS * 5,
        (TARGETS[0], TARGETS[0]),
        (TARGETS[0], replace(TARGETS[1], distribution_id="EROOT")),
    ]:
        with pytest.raises(ValueError):
            router(targets)


def settings(records=None, protected=None):
    return SimpleNamespace(
        framework_publication_destinations=records,
        framework_publication_protected_hosts=protected,
        framework_publication_public_bucket="opengeo.tools",
        framework_publication_distribution_id="EROOT",
        application_bucket="private-sources",
    )


def test_deployment_configuration_is_opt_in_and_preserves_legacy_target():
    assert configured_destination_router(object(), settings()) is None
    configured = configured_destination_router(
        object(),
        settings(json.dumps([asdict(item) for item in TARGETS])),
    )
    assert configured.resolve(asdict(TARGETS[1]))[0] == "public-pages"


@pytest.mark.parametrize(
    "records",
    [
        "",
        "null",
        "{}",
        "[]",
        '[{"hostname":"example.org"}]',
        json.dumps([asdict(TARGETS[1])]),
        json.dumps([{**asdict(TARGETS[0]), "extra": "not-allowed"}]),
        json.dumps([{**asdict(TARGETS[0]), "bucket": ["opengeo.tools"]}]),
    ],
)
def test_invalid_configuration_never_silently_falls_back(records):
    with pytest.raises(ValueError, match="Invalid publication destination configuration"):
        configured_destination_router(object(), settings(records))


def test_operator_protected_hosts_extend_non_removable_studio_protection():
    records = json.dumps([asdict(item) for item in TARGETS])
    with pytest.raises(ValueError):
        configured_destination_router(object(), settings(records, '["example.org"]'))
    unsafe = json.dumps(
        [asdict(TARGETS[0]), asdict(replace(TARGETS[1], hostname="studio.opengeo.tools"))]
    )
    with pytest.raises(ValueError):
        configured_destination_router(object(), settings(unsafe, "[]"))


def test_queue_passes_only_configured_router_not_message_destination(monkeypatch):
    from opengeo_api import framework_publication_controller as controller

    publish = AsyncMock(return_value="deployed")
    monkeypatch.setattr(controller, "publish_step", publish)
    configured = object()
    queue = SimpleNamespace(change_visibility=AsyncMock())
    command = {
        "schema": "opengeo.framework-publication.command.1.0.0",
        "review_id": "00000000-0000-0000-0000-000000000001",
    }

    def run(body):
        return asyncio.run(
            controller.process_publication_queue(
                {
                    "Records": [
                        {"messageId": "one", "receiptHandle": "receipt", "body": json.dumps(body)}
                    ]
                },
                settings=settings(),
                repository=object(),
                storage=object(),
                edge=object(),
                queue=queue,
                destination_router=configured,
            )
        )

    assert run(command) == {"batchItemFailures": []}
    assert publish.await_args.kwargs["destination_router"] is configured
    publish.reset_mock()
    assert run({**command, "destination": asdict(TARGETS[1])}) == {
        "batchItemFailures": [{"itemIdentifier": "one"}],
    }
    publish.assert_not_awaited()


def test_production_constructs_router_from_settings_before_processing(monkeypatch):
    from opengeo_api import framework_publication_controller as controller

    config = settings(json.dumps([asdict(item) for item in TARGETS]))
    config.framework_publication_queue_url = "https://queue.invalid/publications"
    config.aws_region = "us-east-1"
    monkeypatch.setattr(controller, "Settings", lambda: config)
    monkeypatch.setattr(controller, "PublicationAws", lambda region: object())
    monkeypatch.setattr(controller, "RdsDataApiClient", lambda settings: object())
    monkeypatch.setattr(controller, "AwsSqsRenderDispatcher", lambda *args, **kwargs: object())
    process = AsyncMock(return_value={"batchItemFailures": []})
    monkeypatch.setattr(controller, "process_publication_queue", process)
    assert asyncio.run(controller._production({})) == {"batchItemFailures": []}
    configured = process.await_args.kwargs["destination_router"]
    assert configured.resolve(asdict(TARGETS[2]))[0] == "external-pages"
    process.reset_mock()
    config.framework_publication_destinations = "[]"
    with pytest.raises(ValueError):
        asyncio.run(controller._production({}))
    process.assert_not_awaited()
