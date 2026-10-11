"""Short-lived inline delivery of one authorized, retained HTML object version."""

import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

from opengeo_api.s3_downloads import DownloadSpec, DownloadStorage, DownloadStorageUnavailable
from opengeo_api.s3_endpoints import object_path, regional_s3_host


async def static_artifact_ticket(
    storage: DownloadStorage | None, region: str | None, target: tuple[Any, ...]
) -> str:
    if (
        storage is None
        or region is None
        or len(target) < 13
        or target[10] != "text/html"
        or not 0 < target[11] <= 4 * 1024 * 1024
        or not target[9]
    ):
        raise DownloadStorageUnavailable("static map delivery is unavailable")
    ticket = await storage.create_download_url(
        DownloadSpec(
            bucket=target[7],
            key=target[8],
            version_id=target[9],
            filename="opengeo-map.html",
            disposition="inline",
            ttl_seconds=900,
        )
    )
    try:
        url = urlsplit(ticket.url)
        query = parse_qs(url.query, strict_parsing=True, max_num_fields=20)
        ttl = query.get("X-Amz-Expires", [""])
        remaining = (ticket.expires_at - datetime.now(UTC)).total_seconds()
        valid = (
            ticket.method == "GET"
            and url.scheme == "https"
            and url.netloc == regional_s3_host(region)
            and url.path == object_path(target[7], target[8])
            and not url.fragment
            and query.get("versionId") == [target[9]]
            and query.get("response-content-disposition") == ['inline; filename="opengeo-map.html"']
            and query.get("response-content-type") == ["text/html; charset=utf-8"]
            and query.get("response-cache-control") == ["private, no-store"]
            and len(ttl) == 1
            and ttl[0].isdigit()
            and 1 <= int(ttl[0]) <= 900
            and 0 < remaining <= 900
            and len(query.get("X-Amz-Signature", [])) == 1
            and re.fullmatch(r"[0-9a-f]{64}", query["X-Amz-Signature"][0]) is not None
        )
    except (ValueError, TypeError, OverflowError):
        valid = False
    if not valid:
        raise DownloadStorageUnavailable("static map delivery ticket is invalid")
    return ticket.url
