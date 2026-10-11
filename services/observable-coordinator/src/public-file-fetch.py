"""One-shot trusted bridge to the shared anonymous, DNS-pinned TIFF transport."""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any, cast

MAXIMUM_REQUEST_BYTES = 4096


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate request key")
        result[key] = value
    return result


def _request() -> dict[str, Any]:
    body = sys.stdin.buffer.read(MAXIMUM_REQUEST_BYTES + 1)
    if not 1 <= len(body) <= MAXIMUM_REQUEST_BYTES:
        raise ValueError("invalid request length")
    value = json.loads(body, object_pairs_hook=_unique_object)
    if not isinstance(value, dict) or set(value) != {
        "url", "contentType", "sizeBytes", "checksumSha256"
    }:
        raise ValueError("invalid request keys")
    if (
        not isinstance(value["url"], str)
        or not 1 <= len(value["url"]) <= 2048
        or value["contentType"] not in {"image/tiff", "image/geotiff"}
        or type(value["sizeBytes"]) is not int
        or not 1 <= value["sizeBytes"] <= 67_108_864
        or not isinstance(value["checksumSha256"], str)
        or re.fullmatch(r"[0-9a-f]{64}", value["checksumSha256"]) is None
    ):
        raise ValueError("invalid request facts")
    return value


def _configure_imports() -> None:
    if sys.version_info < (3, 12) or not sys.flags.isolated:
        raise RuntimeError("isolated Python 3.12 or newer required")
    coordinator = Path(__file__).resolve().parent.parent
    packaged = coordinator / "python"
    # The release bundle and the existing runtime installer copy the exact API
    # sources here. Local development uses only the fixed sibling API package.
    package = packaged if packaged.is_dir() else coordinator.parent / "api" / "src"
    if not (package / "opengeo_api" / "source_archiver.py").is_file():
        raise RuntimeError("trusted transport package unavailable")
    sys.path.insert(0, str(package))


async def _fetch(value: dict[str, Any]) -> dict[str, Any]:
    from opengeo_api.source_archiver import AnonymousSourceFetcher, PublicFileContentType

    fetched = await AnonymousSourceFetcher().fetch_public_file(
        value["url"],
        content_type=cast(PublicFileContentType, value["contentType"]),
        size_bytes=value["sizeBytes"],
        checksum_sha256=value["checksumSha256"],
        destination=Path.cwd() / "response.bin",
    )
    return {
        "contentType": fetched.content_type,
        "sizeBytes": fetched.size_bytes,
        "checksumSha256": fetched.checksum_sha256,
    }


def main() -> int:
    try:
        _configure_imports()
        from opengeo_api.source_archiver import SourceArchiveFailure

    except Exception:
        result: dict[str, Any] = {"code": "public_file_transport_unavailable", "retryable": False}
    else:
        try:
            request = _request()
        except Exception:
            result = {"code": "public_file_request_invalid", "retryable": False}
        else:
            try:
                result = asyncio.run(_fetch(request))
            except Exception as error:
                result = (
                    {"code": f"public_file_{error.code}", "retryable": error.retryable}
                    if isinstance(error, SourceArchiveFailure)
                    else {"code": "public_file_transport_unavailable", "retryable": True}
                )
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 1 if "code" in result else 0


if __name__ == "__main__":
    raise SystemExit(main())
