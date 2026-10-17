import asyncio
import copy
import json
from datetime import UTC, datetime

import pytest

from opengeo_api.config import Settings
from opengeo_api.postgis_layers import (
    MAX_PREVIEW_BYTES,
    PREVIEW_ERRORS,
    AwsLambdaPostgisPreviewClient,
    PostgisPreviewFailure,
    PostgisPreviewUnavailable,
    create_postgis_preview_client,
    validate_postgis_preview,
)
from test_postgis_layers import BBOX, DATASET, PREVIEW, result
from test_processing_dispatch import Credentials
from test_processing_dispatch import settings as dispatch_settings


class Transport:
    status = 200

    def __init__(self, value=None):
        self.response = json.dumps(result() if value is None else value).encode()
        self.headers = {}
        self.calls = []

    def call(self, *args):
        self.calls.append(args)
        return self.status, self.headers, self.response


def settings():
    return dispatch_settings().model_copy(update={
        "connection_postgis_preview_enabled": True,
        "connection_verification_function_name": "selected-private-connector",
    })


def test_signed_transport_invokes_only_the_lease_identity_with_bounded_single_response():
    transport = Transport()
    client = AwsLambdaPostgisPreviewClient(settings(), Credentials(), transport,
                                           lambda: datetime(2026, 10, 16, tzinfo=UTC))
    response = asyncio.run(client.preview(PREVIEW, DATASET, 1, BBOX))
    assert response == result()
    assert len(transport.calls) == 1
    method, url, headers, body, timeout, maximum = transport.calls[0]
    assert method == "POST" and url.endswith("/selected-private-connector/invocations")
    assert json.loads(body) == {"schema": "opengeo.postgis-preview.command.v1",
                                "preview_id": str(PREVIEW)}
    assert "authorization" in headers and timeout == 12 and maximum == MAX_PREVIEW_BYTES
    assert response["geojson"]["features"][0]["properties"]["amount"] == "0.12345678901234567890"


def test_preview_client_is_disabled_until_explicitly_configured():
    for disabled in (Settings(env="test"), settings().model_copy(update={
        "connection_postgis_preview_enabled": False}), settings().model_copy(update={
        "connection_verification_function_name": None})):
        client = create_postgis_preview_client(disabled)
        assert client.available is False
        with pytest.raises(PostgisPreviewUnavailable):
            asyncio.run(client.preview(PREVIEW, DATASET, 1, BBOX))
        with pytest.raises(ValueError):
            AwsLambdaPostgisPreviewClient(disabled)


def test_response_must_match_requested_identity_version_bounds_and_exact_envelope():
    for field, bad in (("previewId", str(DATASET)), ("datasetId", str(PREVIEW)),
                       ("sourceVersion", 2), ("sourceVersion", True), ("bbox", [0, 0, 3, 3]),
                       ("bbox", [False, False, 2, 2]), ("connectionRevision", 0),
                       ("schemaFingerprint", "bad"), ("observedAt", "2026-10-16"),
                       ("limit", 101), ("returned", 0), ("truncated", 0)):
        value = {**result(), field: bad}
        with pytest.raises(PostgisPreviewUnavailable):
            validate_postgis_preview(value, PREVIEW, DATASET, 1, BBOX)
    with pytest.raises(PostgisPreviewUnavailable):
        validate_postgis_preview({**result(), "secret_arn": "never"}, PREVIEW, DATASET, 1, BBOX)


def test_geojson_preserves_exact_values_and_rejects_oversized_or_unsafe_features():
    empty_key = copy.deepcopy(result())
    empty_key["geojson"]["features"][0]["id"] = ""
    assert validate_postgis_preview(empty_key, PREVIEW, DATASET, 1, BBOX) == empty_key
    candidates = []
    for patch in (
        {"id": 99}, {"properties": {"amount": 0.123}},
        {"properties": {"amount": "not numeric"}},
        {"properties": {"id": 9_007_199_254_740_993}},
        {"properties": {"nested": {"unsupported": True}}},
        {"geometry": {"type": "Point", "coordinates": [181, 1]}},
        {"geometry": {"type": "Point", "coordinates": [1, 1, 1]}},
        {"geometry": {"type": "Point", "coordinates": [float("nan"), 1]}},
        {"geometry": {"type": "MultiPoint", "coordinates": [[1, 1]] * 10_001}},
        {"geometry": {"type": "MultiPoint", "coordinates": []}},
    ):
        value = copy.deepcopy(result())
        value["geojson"]["features"][0].update(patch)
        candidates.append(value)
    value = copy.deepcopy(result())
    value["propertyEncodings"] = {"amount": "unknown"}
    candidates.append(value)
    value = copy.deepcopy(result())
    value["geojson"]["features"] *= 2
    value["returned"] = 2
    candidates.append(value)
    for value in candidates:
        with pytest.raises(PostgisPreviewUnavailable):
            validate_postgis_preview(value, PREVIEW, DATASET, 1, BBOX)


def test_error_responses_are_strict_sanitized_and_never_become_features():
    for code in PREVIEW_ERRORS:
        value = {"schemaVersion": "opengeo.postgis-preview.error.1.0.0",
                 "previewId": str(PREVIEW), "code": code}
        with pytest.raises(PostgisPreviewFailure, match=code):
            validate_postgis_preview(value, PREVIEW, DATASET, 1, BBOX)
    for code in ("password=unsafe", "", None):
        with pytest.raises(PostgisPreviewUnavailable):
            validate_postgis_preview({"schemaVersion": "opengeo.postgis-preview.error.1.0.0",
                                     "previewId": str(PREVIEW), "code": code},
                                    PREVIEW, DATASET, 1, BBOX)


def test_transport_failure_malformed_json_and_function_errors_are_not_retried():
    for status, headers, response in ((503, {}, b"provider text"),
        (200, {"X-Amz-Function-Error": "Unhandled"}, b"private traceback"),
        (200, {}, b"not json"), (200, {}, b"[1]"), (200, {}, b" " * (MAX_PREVIEW_BYTES + 1))):
        transport = Transport()
        transport.status, transport.headers, transport.response = status, headers, response
        client = AwsLambdaPostgisPreviewClient(settings(), Credentials(), transport)
        with pytest.raises(PostgisPreviewUnavailable):
            asyncio.run(client.preview(PREVIEW, DATASET, 1, BBOX))
        assert len(transport.calls) == 1
