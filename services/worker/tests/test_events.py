import json
from urllib.parse import quote_plus

import pytest

from opengeo_worker.events import (
    parse_coverage_derivative_command,
    parse_coverage_derivative_reclamation_command,
    parse_pmtiles_derivative_command,
    parse_render_command,
    parse_s3_events,
    parse_tile_cache_reclamation_command,
    queue_message,
)
from opengeo_worker.models import ValidationFailure

ORG_ID = "10000000-0000-4000-8000-000000000001"
PROJECT_ID = "20000000-0000-4000-8000-000000000002"
DATASET_ID = "30000000-0000-4000-8000-000000000003"
UPLOAD_ID = "40000000-0000-4000-8000-000000000004"
VERSION_ID = "50000000-0000-4000-8000-000000000005"
KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DATASET_ID}/"
    f"uploads/{UPLOAD_ID}/original/source roads.geojson"
)


def event_body(**object_overrides: object) -> str:
    object_record = {
        "key": quote_plus(KEY),
        "versionId": "version-123",
        "size": 234,
        "eTag": "0123456789abcdef",
        "sequencer": "A1B2C3",
        **object_overrides,
    }
    return json.dumps(
        {
            "Records": [
                {
                    "eventSource": "aws:s3",
                    "eventName": "ObjectCreated:CompleteMultipartUpload",
                    "awsRegion": "us-east-1",
                    "s3": {
                        "bucket": {"name": "opengeo-test-geodata"},
                        "object": object_record,
                    },
                }
            ]
        }
    )


def parse(body: str) -> tuple:
    return parse_s3_events(
        body,
        expected_bucket="opengeo-test-geodata",
        expected_region="us-east-1",
        max_message_bytes=262_144,
        max_object_bytes=1024,
    )


def test_parses_only_exact_versioned_canonical_upload_events() -> None:
    events = parse(event_body())

    assert len(events) == 1
    assert events[0].key == KEY
    assert events[0].version_id == "version-123"
    assert events[0].etag == "0123456789abcdef"
    assert events[0].sequencer == "a1b2c3"


def test_ignores_generated_derivative_events_without_dropping_batched_uploads() -> None:
    payload = json.loads(event_body())
    derivative = json.loads(event_body())["Records"][0]
    derivative["s3"]["object"]["key"] = quote_plus(
        f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DATASET_ID}/"
        f"versions/{VERSION_ID}/derivatives/preview/preview.geojson"
    )
    payload["Records"].insert(0, derivative)

    events = parse(json.dumps(payload))

    assert len(events) == 1
    assert events[0].key == KEY


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("key", quote_plus(KEY.replace("/original/", "/derivatives/")), "queue_object_key_invalid"),
        (
            "key",
            quote_plus(KEY.replace(ORG_ID, "10000000-0000-4000-8000-00000000000A")),
            "queue_object_key_invalid",
        ),
        ("versionId", "null", "queue_object_metadata_invalid"),
        ("size", 1025, "queue_object_metadata_invalid"),
        ("eTag", "not-an-etag", "queue_object_metadata_invalid"),
        ("sequencer", "not hex", "queue_object_metadata_invalid"),
    ],
)
def test_rejects_noncanonical_or_unbounded_object_facts(
    field: str, value: object, code: str
) -> None:
    with pytest.raises(ValidationFailure, match=code):
        parse(event_body(**{field: value}))


def test_rejects_malformed_and_oversized_messages_but_accepts_s3_test_event() -> None:
    with pytest.raises(ValidationFailure, match="queue_message_invalid_json"):
        parse("not-json")
    with pytest.raises(ValidationFailure, match="queue_message_too_large"):
        parse(" " * 262_145)
    assert parse(json.dumps({"Event": "s3:TestEvent"})) == ()


def test_queue_envelope_is_bounded_and_requires_a_receipt() -> None:
    message = queue_message(
        {
            "MessageId": "message-1",
            "ReceiptHandle": "receipt-1",
            "Body": event_body(),
            "Attributes": {"ApproximateReceiveCount": "2"},
        }
    )
    assert message.receive_count == 2

    with pytest.raises(ValidationFailure, match="queue_message_invalid"):
        queue_message({"MessageId": "message-1", "Body": "{}"})


def test_accepts_only_the_identity_only_render_command_contract() -> None:
    command = parse_render_command(
        json.dumps(
            {
                "schema": "opengeo.render.command.v1",
                "render_job_id": "a6000000-0000-4000-8000-000000000001",
            }
        ),
        max_message_bytes=262_144,
    )
    assert command is not None
    assert str(command.render_job_id) == "a6000000-0000-4000-8000-000000000001"
    assert parse_render_command("{}", max_message_bytes=262_144) is None

    with pytest.raises(ValidationFailure, match="render_command_invalid"):
        parse_render_command(
            json.dumps(
                {
                    "schema": "opengeo.render.command.v1",
                    "render_job_id": "a6000000-0000-4000-8000-000000000001",
                    "configuration": {"untrusted": "payload"},
                }
            ),
            max_message_bytes=262_144,
        )


def test_accepts_only_the_identity_only_coverage_derivative_command() -> None:
    job_id = "b6000000-0000-4000-8000-000000000001"
    command = parse_coverage_derivative_command(
        json.dumps(
            {
                "schema": "opengeo.coverage-derivative.command.v1",
                "coverage_derivative_job_id": job_id,
            }
        ),
        max_message_bytes=262_144,
    )
    assert command is not None
    assert str(command.coverage_derivative_job_id) == job_id
    assert parse_coverage_derivative_command("{}", max_message_bytes=262_144) is None

    with pytest.raises(ValidationFailure, match="coverage_derivative_command_invalid"):
        parse_coverage_derivative_command(
            json.dumps(
                {
                    "schema": "opengeo.coverage-derivative.command.v1",
                    "coverage_derivative_job_id": job_id,
                    "target_crs": "EPSG:3857",
                }
            ),
            max_message_bytes=262_144,
        )


def test_accepts_only_the_identity_only_pmtiles_derivative_command() -> None:
    job_id = "b9000000-0000-4000-8000-000000000001"
    command = parse_pmtiles_derivative_command(
        json.dumps(
            {
                "schema": "opengeo.pmtiles-derivative.command.v1",
                "pmtiles_derivative_job_id": job_id,
            }
        ),
        max_message_bytes=262_144,
    )
    assert command is not None
    assert str(command.pmtiles_derivative_job_id) == job_id
    assert parse_pmtiles_derivative_command("{}", max_message_bytes=262_144) is None

    for payload in (
        {
            "schema": "opengeo.pmtiles-derivative.command.v1",
            "pmtiles_derivative_job_id": job_id,
            "source_url": "https://untrusted.example/source.geojson",
        },
        {
            "schema": "opengeo.pmtiles-derivative.command.v1",
            "pmtiles_derivative_job_id": job_id.upper(),
        },
    ):
        with pytest.raises(ValidationFailure, match="pmtiles_derivative_command_invalid"):
            parse_pmtiles_derivative_command(
                json.dumps(payload),
                max_message_bytes=262_144,
            )


def test_accepts_only_the_identity_only_coverage_reclamation_command() -> None:
    reclamation_id = "b7000000-0000-4000-8000-000000000001"
    command = parse_coverage_derivative_reclamation_command(
        json.dumps(
            {
                "schema": "opengeo.coverage-derivative-reclamation.command.v1",
                "coverage_derivative_reclamation_id": reclamation_id,
            }
        ),
        max_message_bytes=262_144,
    )
    assert command is not None
    assert str(command.coverage_derivative_reclamation_id) == reclamation_id
    assert parse_coverage_derivative_reclamation_command("{}", max_message_bytes=262_144) is None

    with pytest.raises(ValidationFailure, match="coverage_derivative_reclamation_command_invalid"):
        parse_coverage_derivative_reclamation_command(
            json.dumps(
                {
                    "schema": "opengeo.coverage-derivative-reclamation.command.v1",
                    "coverage_derivative_reclamation_id": reclamation_id,
                    "object_key": "untrusted",
                }
            ),
            max_message_bytes=262_144,
        )


def test_accepts_only_the_identity_only_render_cache_reclamation_command() -> None:
    reclamation_id = "b8000000-0000-4000-8000-000000000001"
    command = parse_tile_cache_reclamation_command(
        json.dumps(
            {
                "schema": "opengeo.render-cache-reclamation.command.v1",
                "render_cache_reclamation_id": reclamation_id,
            }
        ),
        max_message_bytes=262_144,
    )
    assert command is not None
    assert str(command.render_cache_reclamation_id) == reclamation_id
    assert parse_tile_cache_reclamation_command("{}", max_message_bytes=262_144) is None

    with pytest.raises(ValidationFailure, match="render_cache_reclamation_command_invalid"):
        parse_tile_cache_reclamation_command(
            json.dumps(
                {
                    "schema": "opengeo.render-cache-reclamation.command.v1",
                    "render_cache_reclamation_id": reclamation_id,
                    "bucket": "untrusted",
                }
            ),
            max_message_bytes=262_144,
        )
