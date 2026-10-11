#!/usr/bin/env python3
"""Fetch one bounded public build asset from redundant HTTPS mirrors."""

from __future__ import annotations

import argparse
import hashlib
import os
import socket
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--max-bytes", required=True, type=int)
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("urls", nargs="+")
    arguments = parser.parse_args()
    if not (arguments.sha256.isascii() and len(arguments.sha256) == 64):
        parser.error("--sha256 must contain 64 lowercase hexadecimal characters")
    try:
        int(arguments.sha256, 16)
    except ValueError:
        parser.error("--sha256 must contain 64 lowercase hexadecimal characters")
    if arguments.sha256 != arguments.sha256.lower():
        parser.error("--sha256 must contain 64 lowercase hexadecimal characters")
    if not 1 <= arguments.max_bytes <= 64 * 1024 * 1024:
        parser.error("--max-bytes must be between 1 and 67108864")
    if not 1 <= arguments.attempts <= 5:
        parser.error("--attempts must be between 1 and 5")
    if not 1 <= arguments.timeout <= 60:
        parser.error("--timeout must be between 1 and 60 seconds")
    for value in arguments.urls:
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            parser.error("every source must be a credential-free HTTPS URL")
    return arguments


def ipv4_getaddrinfo(
    host: str,
    port: int | str,
    family: int = 0,
    type_: int = 0,
    proto: int = 0,
    flags: int = 0,
) -> list[tuple[int, int, int, str, tuple[str, int]]]:
    """Keep CI downloads on the IPv4 route supplied by hosted runners."""

    return ORIGINAL_GETADDRINFO(host, port, socket.AF_INET, type_, proto, flags)


ORIGINAL_GETADDRINFO = socket.getaddrinfo


def download(arguments: argparse.Namespace, url: str) -> None:
    output = arguments.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=output.parent,
            prefix=f".{output.name}.",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            digest = hashlib.sha256()
            observed_bytes = 0
            request = Request(url, headers={"User-Agent": "OpenGeo-build/1"})
            with urlopen(request, timeout=arguments.timeout) as response:
                final_url = urlparse(response.geturl())
                if final_url.scheme != "https" or final_url.username or final_url.password:
                    raise RuntimeError("source redirected outside credential-free HTTPS")
                declared_length = response.headers.get("Content-Length")
                if declared_length is not None and int(declared_length) > arguments.max_bytes:
                    raise RuntimeError("declared asset length exceeds the configured limit")
                while chunk := response.read(64 * 1024):
                    observed_bytes += len(chunk)
                    if observed_bytes > arguments.max_bytes:
                        raise RuntimeError("asset exceeds the configured byte limit")
                    digest.update(chunk)
                    temporary.write(chunk)
        if digest.hexdigest() != arguments.sha256:
            raise RuntimeError("asset checksum does not match the pinned SHA-256")
        os.chmod(temporary_name, 0o444)
        os.replace(temporary_name, output)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main() -> int:
    arguments = parse_arguments()
    socket.getaddrinfo = ipv4_getaddrinfo
    failures: list[str] = []
    for url in arguments.urls:
        hostname = urlparse(url).hostname or "unknown"
        for attempt in range(1, arguments.attempts + 1):
            try:
                download(arguments, url)
                print(f"Fetched pinned build asset from {hostname}.")
                return 0
            except Exception as error:
                failures.append(f"{hostname} attempt {attempt}: {type(error).__name__}: {error}")
                if attempt < arguments.attempts:
                    time.sleep(1)
    print("Unable to fetch the pinned build asset from any approved mirror:", file=sys.stderr)
    for failure in failures:
        print(f"- {failure}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
