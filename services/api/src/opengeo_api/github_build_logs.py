"""Retain bounded, redacted logs from an already verified GitHub run attempt."""

import hashlib
import io
import re
import zipfile
from datetime import UTC, datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener

from opengeo_api.github_publications import REPOSITORY, GitHubPublicationError, NoRedirect

MAX_ARCHIVE = 4 * 1024 * 1024
MAX_TEXT = 24_000


def redact_log(text: str) -> str:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    text = re.sub(
        r"-----BEGIN[^\n]*PRIVATE KEY-----.*?(?:-----END[^\n]*PRIVATE KEY-----|$)",
        "[redacted private key]",
        text,
        flags=re.S,
    )
    text = re.sub(
        r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b",
        "[redacted]",
        text,
    )
    text = re.sub(r"(?i)(bearer\s+)[^\s]+", r"\1[redacted]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted JWT]", text)
    text = re.sub(
        r"(?im)(\b[\w-]*(?:secret|token|password|private_key|access_key)[\w-]*\s*[:=]\s*)[^\r\n]+",
        r"\1[redacted]",
        text,
    )
    text = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[redacted query]", text)
    return text


def unavailable_logs(message: str) -> dict[str, Any]:
    return {
        "state": "unavailable",
        "text": message,
        "truncated": False,
        "checksum_sha256": None,
        "captured_at": datetime.now(UTC).isoformat(),
    }


def summarize_log_archive(body: bytes) -> dict[str, Any]:
    if len(body) > MAX_ARCHIVE:
        raise GitHubPublicationError("github_log_archive_limit")
    parts: list[str] = []
    truncated = False
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()]
            if len(entries) > 128:
                raise GitHubPublicationError("github_log_archive_limit")
            remaining = MAX_TEXT
            for entry in sorted(entries, key=lambda item: item.filename):
                if remaining < 256:
                    truncated = True
                    break
                if entry.flag_bits & 1 or entry.compress_type not in {
                    zipfile.ZIP_STORED,
                    zipfile.ZIP_DEFLATED,
                }:
                    raise GitHubPublicationError("github_log_archive_invalid")
                # Never extract paths. A filename is only an escaped text label.
                with archive.open(entry) as stream:
                    raw = stream.read(min(remaining, 8192) + 1)
                truncated |= len(raw) < entry.file_size
                label = redact_log(entry.filename)[:160]
                excerpt = redact_log(raw.decode("utf-8", errors="replace"))
                encoded = f"\n--- {label} ---\n{excerpt}\n".encode()
                truncated |= len(encoded) > remaining
                section = encoded[:remaining].decode("utf-8", errors="ignore")
                parts.append(section)
                remaining -= len(section.encode())
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError):
        raise GitHubPublicationError("github_log_archive_invalid") from None
    text = "".join(parts)
    return {
        "state": "retained",
        "text": text,
        "truncated": truncated,
        "checksum_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "captured_at": datetime.now(UTC).isoformat(),
    }


def download_build_logs(repository: str, token: str, run_id: int, attempt: int) -> dict[str, Any]:
    if (
        not REPOSITORY.fullmatch(repository)
        or type(run_id) is not int
        or run_id < 1
        or type(attempt) is not int
        or attempt < 1
    ):
        raise GitHubPublicationError("github_log_identity_invalid")
    path = f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}/logs"
    request = Request(
        "https://api.github.com" + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "OpenGeo-Studio-Publications",
        },
    )
    opener = build_opener(NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            if response.status in {404, 410}:
                return unavailable_logs("GitHub did not retain logs for this attempt.")
            if response.status != 302:
                raise GitHubPublicationError("github_logs_unavailable")
            location = response.headers.get("location", "")
        parsed = urlsplit(location)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.port not in {None, 443}
            or parsed.fragment
            or not re.fullmatch(
                r"[a-z0-9-]+\.(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)",
                parsed.hostname or "",
            )
        ):
            raise GitHubPublicationError("github_log_redirect_invalid")
        # The GitHub token is deliberately absent from the signed download request.
        with opener.open(
            Request(location, headers={"User-Agent": "OpenGeo-Studio-Publications"}), timeout=20
        ) as download:
            body = download.read(MAX_ARCHIVE + 1)
        try:
            return summarize_log_archive(body)
        except GitHubPublicationError:
            # A large/unsupported archive must not obscure a verified terminal run.
            return unavailable_logs(
                "The log archive exceeds Studio's retention limits or uses an unsupported format. "
                "Open GitHub logs for this attempt."
            )
    except (HTTPError, URLError, TimeoutError, OSError):
        raise GitHubPublicationError("github_logs_unavailable") from None
