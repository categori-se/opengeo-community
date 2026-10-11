import json
import re
from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote_plus
from uuid import UUID

from opengeo_worker.models import (
    CoverageDerivativeCommand,
    CoverageDerivativeReclamationCommand,
    PmtilesDerivativeCommand,
    QueueMessage,
    RenderCommand,
    S3ObjectEvent,
    TileCacheReclamationCommand,
    ValidationFailure,
)

_UPLOAD_KEY = re.compile(
    r"organizations/(?P<organization>[0-9a-f-]{36})/"
    r"projects/(?P<project>[0-9a-f-]{36})/"
    r"datasets/(?P<dataset>[0-9a-f-]{36})/"
    r"uploads/(?P<upload>[0-9a-f-]{36})/original/"
    r"(?P<filename>[A-Za-z0-9][A-Za-z0-9._ -]{2,254})"
)
_DERIVATIVE_KEY = re.compile(
    r"organizations/(?P<organization>[0-9a-f-]{36})/"
    r"projects/(?P<project>[0-9a-f-]{36})/"
    r"datasets/(?P<dataset>[0-9a-f-]{36})/"
    r"versions/(?P<version>[0-9a-f-]{36})/derivatives/"
    r"[a-z0-9][A-Za-z0-9._/-]{0,511}"
)
_ETAG = re.compile(r"[A-Fa-f0-9]{16,128}")
_SEQUENCER = re.compile(r"[A-Fa-f0-9]{1,128}")


def queue_message(raw: Mapping[str, Any]) -> QueueMessage:
    try:
        message_id = raw["MessageId"]
        receipt = raw["ReceiptHandle"]
        body = raw["Body"]
        attributes = raw.get("Attributes", {})
        receive_count = int(attributes.get("ApproximateReceiveCount", "1"))
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise ValidationFailure("queue_message_invalid") from error
    if (
        not isinstance(message_id, str)
        or not 1 <= len(message_id) <= 128
        or not isinstance(receipt, str)
        or not 1 <= len(receipt) <= 4096
        or not isinstance(body, str)
        or receive_count < 1
    ):
        raise ValidationFailure("queue_message_invalid")
    return QueueMessage(message_id, receipt, body, receive_count)


def parse_s3_events(
    body: str,
    *,
    expected_bucket: str,
    expected_region: str,
    max_message_bytes: int,
    max_object_bytes: int,
) -> tuple[S3ObjectEvent, ...]:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if not isinstance(payload, dict):
        raise ValidationFailure("queue_message_invalid")
    if payload.get("Event") == "s3:TestEvent":
        return ()
    records = payload.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise ValidationFailure("queue_records_invalid")

    events: list[S3ObjectEvent] = []
    for record in records:
        if not isinstance(record, dict):
            raise ValidationFailure("queue_record_invalid")
        try:
            event_source = record["eventSource"]
            event_name = record["eventName"]
            region = record["awsRegion"]
            s3_record = record["s3"]
            bucket = s3_record["bucket"]["name"]
            object_record = s3_record["object"]
            encoded_key = object_record["key"]
            version_id = object_record["versionId"]
            size_bytes = int(object_record["size"])
            etag = str(object_record["eTag"]).strip('"')
            sequencer = object_record["sequencer"]
        except (KeyError, TypeError, ValueError) as error:
            raise ValidationFailure("queue_record_invalid") from error
        if event_source != "aws:s3" or not str(event_name).startswith("ObjectCreated:"):
            raise ValidationFailure("queue_event_unsupported")
        if region != expected_region or bucket != expected_bucket:
            raise ValidationFailure("queue_event_scope_mismatch")
        if not isinstance(encoded_key, str) or len(encoded_key) > 3072:
            raise ValidationFailure("queue_object_key_invalid")
        key = unquote_plus(encoded_key)
        match = _UPLOAD_KEY.fullmatch(key)
        if match is None and _is_generated_derivative(key):
            continue
        if match is None or any(
            not _canonical_uuid(match.group(name))
            for name in ("organization", "project", "dataset", "upload")
        ):
            raise ValidationFailure("queue_object_key_invalid")
        if (
            not isinstance(version_id, str)
            or version_id in {"", "null"}
            or len(version_id) > 1024
            or not 1 <= size_bytes <= max_object_bytes
            or _ETAG.fullmatch(etag) is None
            or not isinstance(sequencer, str)
            or _SEQUENCER.fullmatch(sequencer) is None
        ):
            raise ValidationFailure("queue_object_metadata_invalid")
        events.append(
            S3ObjectEvent(
                bucket=bucket,
                key=key,
                version_id=version_id,
                size_bytes=size_bytes,
                etag=etag.lower(),
                sequencer=sequencer.lower(),
            )
        )
    return tuple(events)


def parse_render_command(body: str, *, max_message_bytes: int) -> RenderCommand | None:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if not isinstance(payload, dict) or payload.get("schema") != "opengeo.render.command.v1":
        return None
    if set(payload) != {"schema", "render_job_id"}:
        raise ValidationFailure("render_command_invalid")
    raw_job_id = payload.get("render_job_id")
    if not isinstance(raw_job_id, str) or not _canonical_uuid(raw_job_id):
        raise ValidationFailure("render_command_invalid")
    return RenderCommand(UUID(raw_job_id))


def parse_coverage_derivative_command(
    body: str, *, max_message_bytes: int
) -> CoverageDerivativeCommand | None:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "opengeo.coverage-derivative.command.v1"
    ):
        return None
    if set(payload) != {"schema", "coverage_derivative_job_id"}:
        raise ValidationFailure("coverage_derivative_command_invalid")
    raw_job_id = payload.get("coverage_derivative_job_id")
    if not isinstance(raw_job_id, str) or not _canonical_uuid(raw_job_id):
        raise ValidationFailure("coverage_derivative_command_invalid")
    return CoverageDerivativeCommand(UUID(raw_job_id))


def parse_pmtiles_derivative_command(
    body: str, *, max_message_bytes: int
) -> PmtilesDerivativeCommand | None:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "opengeo.pmtiles-derivative.command.v1"
    ):
        return None
    if set(payload) != {"schema", "pmtiles_derivative_job_id"}:
        raise ValidationFailure("pmtiles_derivative_command_invalid")
    raw_job_id = payload.get("pmtiles_derivative_job_id")
    if not isinstance(raw_job_id, str) or not _canonical_uuid(raw_job_id):
        raise ValidationFailure("pmtiles_derivative_command_invalid")
    return PmtilesDerivativeCommand(UUID(raw_job_id))


def parse_coverage_derivative_reclamation_command(
    body: str, *, max_message_bytes: int
) -> CoverageDerivativeReclamationCommand | None:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "opengeo.coverage-derivative-reclamation.command.v1"
    ):
        return None
    if set(payload) != {"schema", "coverage_derivative_reclamation_id"}:
        raise ValidationFailure("coverage_derivative_reclamation_command_invalid")
    raw_id = payload.get("coverage_derivative_reclamation_id")
    if not isinstance(raw_id, str) or not _canonical_uuid(raw_id):
        raise ValidationFailure("coverage_derivative_reclamation_command_invalid")
    return CoverageDerivativeReclamationCommand(UUID(raw_id))


def parse_tile_cache_reclamation_command(
    body: str, *, max_message_bytes: int
) -> TileCacheReclamationCommand | None:
    if len(body.encode("utf-8")) > max_message_bytes:
        raise ValidationFailure("queue_message_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise ValidationFailure("queue_message_invalid_json") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != "opengeo.render-cache-reclamation.command.v1"
    ):
        return None
    if set(payload) != {"schema", "render_cache_reclamation_id"}:
        raise ValidationFailure("render_cache_reclamation_command_invalid")
    raw_id = payload.get("render_cache_reclamation_id")
    if not isinstance(raw_id, str) or not _canonical_uuid(raw_id):
        raise ValidationFailure("render_cache_reclamation_command_invalid")
    return TileCacheReclamationCommand(UUID(raw_id))


def _canonical_uuid(value: str) -> bool:
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _is_generated_derivative(key: str) -> bool:
    match = _DERIVATIVE_KEY.fullmatch(key)
    if match is None or "//" in key:
        return False
    relative_key = key.split("/derivatives/", 1)[1]
    return (
        all(
            _canonical_uuid(match.group(name))
            for name in ("organization", "project", "dataset", "version")
        )
        and not relative_key.endswith("/")
        and all(part not in {"", ".", ".."} for part in PurePosixPath(relative_key).parts)
    )
