import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import UUID

import pytest
from fastapi import HTTPException, Request

from opengeo_api.artifact_release_routes import public_release_static
from opengeo_api.artifact_share_routes import _view_url, shared_artifact_view, unlock_artifact_view
from opengeo_api.artifact_static_delivery import static_artifact_ticket
from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.rendering import RenderConflict, RenderNotFound
from opengeo_api.s3_downloads import (
    AwsS3DownloadStorage,
    DownloadSpec,
    DownloadStorageUnavailable,
)

ORG, SHARE = UUID(int=1), UUID(int=2)
PASSWORD = "local fixture password"


class Credentials:
    def load(self):
        return AwsCredentials("EXAMPLE", "local-only-credential", "local-only-session")


def storage_and_target():
    storage = AwsS3DownloadStorage(
        Settings(
            env="test",
            aws_region="us-east-1",
            geodata_bucket="source.opengeo.tools",
            geodata_kms_key_arn=(
                "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
            ),
            download_url_ttl_seconds=120,
        ),
        credentials=Credentials(),
    )
    target = (None,) * 7 + (
        "source.opengeo.tools",
        "organizations/a/project-artifacts/artifact/objects/output.html",
        "retained-object-version",
        "text/html",
        128,
        "a" * 64,
    )
    return storage, target


def request(
    storage,
    *,
    body=None,
    origin="https://api.example.test",
    fetch_site="same-origin",
    artifact_view_origin=None,
    extra_headers=(),
):
    repository = SimpleNamespace(_artifact_downloads=storage)
    payload = body if body is not None else urlencode({"password": PASSWORD}).encode()

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(
        {
            "type": "http",
            "scheme": "https",
            "server": ("api.example.test", 443),
            "path": f"/shared/organizations/{ORG}/artifact-shares/{SHARE}/view",
            "query_string": b"",
            "headers": [
                (b"origin", origin.encode()),
                (b"sec-fetch-site", fetch_site.encode()),
                (b"content-type", b"application/x-www-form-urlencoded"),
                *extra_headers,
            ],
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    render_repository=repository,
                    settings=SimpleNamespace(
                        aws_region="us-east-1", artifact_view_origin=artifact_view_origin
                    ),
                )
            ),
        },
        receive=receive,
    )


def test_inline_signing_pins_version_headers_and_caps_lifetime_without_s3_reads():
    storage, target = storage_and_target()
    storage._transport.get = lambda *args: pytest.fail("static delivery must not fetch bytes")
    url = asyncio.run(static_artifact_ticket(storage, "us-east-1", target))
    query = parse_qs(urlsplit(url).query)
    assert query["versionId"] == [target[9]]
    assert query["X-Amz-Expires"] == ["120"]
    assert query["response-content-disposition"] == ['inline; filename="opengeo-map.html"']
    assert query["response-content-type"] == ["text/html; charset=utf-8"]
    assert query["response-cache-control"] == ["private, no-store"]


@pytest.mark.parametrize(
    "change",
    [
        {"versionId": "latest"},
        {"X-Amz-Expires": "901"},
        {"response-cache-control": "public, max-age=3600"},
        {"response-content-disposition": "attachment"},
        {"response-content-type": "text/javascript"},
    ],
)
def test_static_delivery_rejects_wrong_version_or_unsafe_ticket(change):
    storage, target = storage_and_target()
    ticket = asyncio.run(
        storage.create_download_url(
            DownloadSpec(target[7], target[8], target[9], "opengeo-map.html", "inline", 120)
        )
    )
    parts = urlsplit(ticket.url)
    query = {key: value[0] for key, value in parse_qs(parts.query).items()}
    query.update(change)
    fake = SimpleNamespace(
        create_download_url=AsyncMock(
            return_value=replace(ticket, url=parts._replace(query=urlencode(query)).geturl())
        )
    )
    with pytest.raises(DownloadStorageUnavailable):
        asyncio.run(static_artifact_ticket(fake, "us-east-1", target))


def test_password_gate_get_is_generic_and_needs_no_repository_or_s3():
    response = asyncio.run(shared_artifact_view(ORG, SHARE))
    assert response.status_code == 200
    assert b'type="password"' in response.body
    assert b"<iframe" not in response.body and b"<script" not in response.body
    assert "no-store" in response.headers["cache-control"]
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


@pytest.mark.parametrize(
    ("body", "origin", "fetch_site", "code"),
    [
        (b"password=a&password=b", "https://api.example.test", "same-origin", 400),
        (b"password=" + b"a" * 2048, "https://api.example.test", "same-origin", 413),
        (b"password=" + b"a" * 12, "https://other.example", "same-origin", 403),
        (b"password=" + b"a" * 12, "https://api.example.test", "cross-site", 403),
    ],
)
def test_gate_rejects_cross_origin_or_unbounded_forms_before_password_work(
    body, origin, fetch_site, code
):
    unlock = AsyncMock()
    with (
        patch("opengeo_api.artifact_share_routes.unlock_share", unlock),
        pytest.raises(HTTPException) as error,
    ):
        asyncio.run(
            unlock_artifact_view(
                ORG, SHARE, request(None, body=body, origin=origin, fetch_site=fetch_site)
            )
        )
    assert error.value.status_code == code
    unlock.assert_not_awaited()


def test_configured_studio_link_and_form_origin_survive_api_gateway_host_forwarding():
    storage, target = storage_and_target()
    configured = "https://studio.opengeo.tools"
    forwarded = request(storage, origin=configured, artifact_view_origin=configured)
    assert forwarded.url.netloc == "api.example.test"
    assert _view_url(forwarded, ORG, str(SHARE)) == (
        f"{configured}/api/shared/organizations/{ORG}/artifact-shares/{SHARE}/view"
    )
    with (
        patch(
            "opengeo_api.artifact_share_routes.unlock_share",
            AsyncMock(return_value=({"title": "Map"}, target)),
        ),
        patch("opengeo_api.artifact_share_routes.recheck_share", AsyncMock()),
    ):
        response = asyncio.run(unlock_artifact_view(ORG, SHARE, forwarded))
    assert response.status_code == 200 and b"X-Amz-Signature" in response.body


@pytest.mark.parametrize("fetch_site", ["same-origin", "same-site", "cross-site"])
def test_forwarded_host_cannot_authorize_an_unconfigured_form_origin(fetch_site):
    unlock = AsyncMock()
    with (
        patch("opengeo_api.artifact_share_routes.unlock_share", unlock),
        pytest.raises(HTTPException) as error,
    ):
        asyncio.run(
            unlock_artifact_view(
                ORG,
                SHARE,
                request(
                    None,
                    origin="https://attacker.example",
                    fetch_site=fetch_site,
                    artifact_view_origin="https://studio.opengeo.tools",
                    extra_headers=((b"x-forwarded-host", b"attacker.example"),),
                ),
            )
        )
    assert error.value.status_code == 403
    unlock.assert_not_awaited()


def test_configured_form_still_refuses_cross_site_posts_before_password_work():
    unlock = AsyncMock()
    with (
        patch("opengeo_api.artifact_share_routes.unlock_share", unlock),
        pytest.raises(HTTPException) as error,
    ):
        asyncio.run(
            unlock_artifact_view(
                ORG,
                SHARE,
                request(
                    None,
                    origin="https://studio.opengeo.tools",
                    artifact_view_origin="https://studio.opengeo.tools",
                    fetch_site="cross-site",
                ),
            )
        )
    assert error.value.status_code == 403
    unlock.assert_not_awaited()


@pytest.mark.parametrize(
    ("error", "code"),
    [(RenderNotFound("artifact_share"), 404), (RenderConflict("artifact_share_rate_limited"), 429)],
)
def test_wrong_or_rate_limited_password_never_signs_or_exposes_output(error, code):
    storage = SimpleNamespace(create_download_url=AsyncMock())
    with patch("opengeo_api.artifact_share_routes.unlock_share", AsyncMock(side_effect=error)):
        response = asyncio.run(unlock_artifact_view(ORG, SHARE, request(storage)))
    assert response.status_code == code
    assert PASSWORD.encode() not in response.body and b"<iframe" not in response.body
    storage.create_download_url.assert_not_awaited()


def test_unlocked_view_loads_exact_s3_html_in_isolated_frame_without_studio_or_broker_bytes():
    storage, target = storage_and_target()
    storage.read_exact_object = AsyncMock(side_effect=AssertionError("not a brokered read"))
    record = {"title": "Local <private> map"}
    checked = AsyncMock(return_value=(record, target))
    with (
        patch(
            "opengeo_api.artifact_share_routes.unlock_share",
            AsyncMock(return_value=(record, target)),
        ),
        patch("opengeo_api.artifact_share_routes.recheck_share", checked),
    ):
        response = asyncio.run(unlock_artifact_view(ORG, SHARE, request(storage)))
    assert response.status_code == 200
    assert b'sandbox="allow-scripts"' in response.body
    assert b"Local &lt;private&gt; map" in response.body
    assert b"s3.us-east-1.amazonaws.com" in response.body
    assert PASSWORD.encode() not in response.body
    assert b"studio.opengeo.tools" not in response.body
    checked.assert_awaited_once()
    storage.read_exact_object.assert_not_awaited()


def test_revocation_during_signing_withholds_fresh_static_url():
    storage, target = storage_and_target()
    with (
        patch(
            "opengeo_api.artifact_share_routes.unlock_share",
            AsyncMock(return_value=({"title": "Map"}, target)),
        ),
        patch(
            "opengeo_api.artifact_share_routes.recheck_share",
            AsyncMock(side_effect=RenderNotFound("artifact_share")),
        ),
    ):
        response = asyncio.run(unlock_artifact_view(ORG, SHARE, request(storage)))
    assert response.status_code == 404 and b"X-Amz-Signature" not in response.body


def test_public_static_view_rechecks_source_access_and_uses_s3_not_html_broker():
    storage, target = storage_and_target()
    record = {"title": "Map", "attribution": "Source", "license": "CC0-1.0"}
    storage.read_exact_object = AsyncMock()
    authority = AsyncMock(return_value=(record, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(public_release_static(ORG, SHARE, request(storage)))
    assert response.status_code == 200 and b"X-Amz-Signature" in response.body
    assert authority.await_count == 2
    storage.read_exact_object.assert_not_awaited()
    with (
        patch(
            "opengeo_api.artifact_release_routes._public",
            AsyncMock(side_effect=[(record, target), HTTPException(404, "unavailable")]),
        ),
        pytest.raises(HTTPException) as error,
    ):
        asyncio.run(public_release_static(ORG, SHARE, request(storage)))
    assert error.value.status_code == 404


def test_inline_signing_never_extends_configured_expiry_or_accepts_other_media():
    storage, target = storage_and_target()
    ticket = asyncio.run(
        storage.create_download_url(
            DownloadSpec(target[7], target[8], target[9], "opengeo-map.html", "inline", 60)
        )
    )
    assert 0 < (ticket.expires_at - datetime.now(UTC)).total_seconds() <= 60
    with pytest.raises(DownloadStorageUnavailable):
        asyncio.run(
            storage.create_download_url(
                DownloadSpec(target[7], target[8], target[9], "script.js", "inline")
            )
        )
    invalid = replace(ticket, expires_at=datetime.now(UTC) + timedelta(seconds=901))
    with pytest.raises(DownloadStorageUnavailable):
        asyncio.run(
            static_artifact_ticket(
                SimpleNamespace(create_download_url=AsyncMock(return_value=invalid)),
                "us-east-1",
                target,
            )
        )
