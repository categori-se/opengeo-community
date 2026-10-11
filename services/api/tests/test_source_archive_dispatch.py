import asyncio
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from urllib.parse import parse_qs
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.source_archive_dispatch import (
    SourceArchiveDispatchUnavailable,
    SourceArchiveIngestionDispatcher,
)
from opengeo_api.source_archiver import StoredArchive

JOB_ID = UUID("91000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("81000000-0000-4000-8000-000000000001")
BUCKET = "opengeo-geodata"
KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DATASET_ID}/"
    f"uploads/{JOB_ID}/original/snapshot.png"
)
BODY = b"\x89PNG\r\n\x1a\nsource"


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


def stored() -> StoredArchive:
    return StoredArchive(
        BUCKET,
        KEY,
        "version-1",
        "0123456789abcdef",
        "image/png",
        len(BODY),
        hashlib.sha256(BODY).hexdigest(),
    )


def dispatcher(transport: Transport) -> SourceArchiveIngestionDispatcher:
    return SourceArchiveIngestionDispatcher(
        region="us-east-1",
        account_id="111111111111",
        queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing",
        credentials=Credentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 29, 12, tzinfo=UTC),
    )


def test_dispatches_exact_completed_object_as_standard_s3_ingestion_event() -> None:
    transport = Transport()
    ingestion = dispatcher(transport)

    asyncio.run(ingestion.dispatch(JOB_ID, stored()))

    url, headers, body, timeout = transport.calls[0]
    fields = parse_qs(body.decode())
    event = json.loads(fields["MessageBody"][0])
    assert url.endswith("/111111111111/opengeo-processing")
    assert fields["Action"] == ["SendMessage"]
    assert fields["Version"] == ["2012-11-05"]
    assert event == {
        "Records": [
            {
                "eventVersion": "2.1",
                "eventSource": "aws:s3",
                "awsRegion": "us-east-1",
                "eventName": "ObjectCreated:Put",
                "s3": {
                    "s3SchemaVersion": "1.0",
                    "configurationId": "opengeo-source-archive-post-completion",
                    "bucket": {"name": BUCKET},
                    "object": {
                        "key": KEY,
                        "size": len(BODY),
                        "eTag": "0123456789abcdef",
                        "versionId": "version-1",
                        "sequencer": event["Records"][0]["s3"]["object"]["sequencer"],
                    },
                },
            }
        ]
    }
    assert len(event["Records"][0]["s3"]["object"]["sequencer"]) == 64
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert headers["x-amz-security-token"] == "session-token"
    assert timeout == 5.0
    assert "secret-key" not in body.decode()


def test_repeated_dispatch_uses_the_same_object_identity_and_sequencer() -> None:
    transport = Transport()
    ingestion = dispatcher(transport)

    asyncio.run(ingestion.dispatch(JOB_ID, stored()))
    asyncio.run(ingestion.dispatch(JOB_ID, stored()))

    messages = [parse_qs(call[2].decode())["MessageBody"][0] for call in transport.calls]
    assert messages[0] == messages[1]


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ("source.geojson", "application/geo+json"),
        ("source.csv", "text/csv"),
        ("source.zip", "application/zip"),
        ("source.gpkg", "application/geopackage+sqlite3"),
        ("source.parquet", "application/vnd.apache.parquet"),
        ("source.tif", "image/tiff"),
        ("source.pmtiles", "application/vnd.pmtiles"),
        ("source.png", "image/png"),
        ("source.jpg", "image/jpeg"),
        ("source.pdf", "application/pdf"),
        ("source.odt", "application/vnd.oasis.opendocument.text"),
    ],
)
def test_dispatches_each_governed_repository_copy_format(filename: str, content_type: str) -> None:
    transport = Transport()
    artifact = replace(
        stored(),
        object_key=KEY.rsplit("/", 1)[0] + f"/{filename}",
        content_type=content_type,
    )

    asyncio.run(dispatcher(transport).dispatch(JOB_ID, artifact))

    event = json.loads(parse_qs(transport.calls[0][2].decode())["MessageBody"][0])
    assert event["Records"][0]["s3"]["object"]["key"].endswith(filename)


@pytest.mark.parametrize(
    "artifact",
    [
        replace(stored(), object_key=KEY.replace(str(JOB_ID), str(UUID(int=2)))),
        replace(stored(), bucket="127.0.0.1"),
        replace(stored(), s3_version_id="null"),
        replace(stored(), etag="not-an-etag"),
        replace(stored(), size_bytes=0),
        replace(stored(), checksum_sha256="f" * 63),
    ],
)
def test_rejects_unsealed_or_malformed_completed_object_facts(
    artifact: StoredArchive,
) -> None:
    transport = Transport()
    with pytest.raises(SourceArchiveDispatchUnavailable):
        asyncio.run(dispatcher(transport).dispatch(JOB_ID, artifact))
    assert transport.calls == []


def test_fails_closed_on_rejected_or_malformed_queue_responses() -> None:
    for transport in (Transport(503, b"unavailable"), Transport(200, b"<invalid")):
        with pytest.raises(SourceArchiveDispatchUnavailable):
            asyncio.run(dispatcher(transport).dispatch(JOB_ID, stored()))
