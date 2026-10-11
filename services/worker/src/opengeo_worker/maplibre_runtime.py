"""Fail-closed local assets and a bounded, network-isolated GL subprocess.

Provisioning /opt/opengeo-maplibre is a release task, never a job side effect.
The existing worker container memory limit remains the process-tree RSS limit;
this adapter additionally bounds input, output, CPU, files and wall-clock time.
"""

import base64
import json
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import suppress
from hashlib import sha256
from pathlib import Path
from typing import Any

from opengeo_worker.maplibre_package import MAX_MANIFEST_BYTES, PACKAGE_SCHEMA, verify_package
from opengeo_worker.models import ValidationFailure
from opengeo_worker.render_runtime import (
    runtime_reference, require_render_capabilities, bound_engine_version, SUPPORTED_MAPLIBRE_VERSIONS,
)

_HASH = re.compile(r"[0-9a-f]{64}")
_RANGE = re.compile(r"(0|[1-9][0-9]*)-(0|[1-9][0-9]*)")


def _read(path: Path, maximum: int, code: str) -> bytes:
    try:
        if not path.is_file():
            raise ValidationFailure(code)
        with path.open("rb") as stream:
            content = stream.read(maximum + 1)
        if len(content) > maximum:
            raise ValidationFailure(code)
        return content
    except OSError as error:
        raise ValidationFailure(code) from error


def _varint(content: bytes, position: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(content):
            break
        byte = content[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ValidationFailure("saved_map_gl_glyph_invalid")


def _fields(content: bytes) -> Iterator[tuple[int, int | bytes]]:
    position = 0
    while position < len(content):
        tag, position = _varint(content, position)
        if tag >> 3 == 0:
            raise ValidationFailure("saved_map_gl_glyph_invalid")
        if tag & 7 == 0:
            value, position = _varint(content, position)
            yield tag >> 3, value
        elif tag & 7 == 2:
            size, position = _varint(content, position)
            if position + size > len(content):
                raise ValidationFailure("saved_map_gl_glyph_invalid")
            yield tag >> 3, content[position : position + size]
            position += size
        else:
            raise ValidationFailure("saved_map_gl_glyph_invalid")


def glyph_ids(content: bytes, stack: str, range_name: str) -> set[int]:
    """Validate the ordinary 24px/3px-border PBF actually consumed by MapLibre."""
    fields = list(_fields(content))
    if len(fields) != 1 or fields[0][0] != 1 or not isinstance(fields[0][1], bytes):
        raise ValidationFailure("saved_map_gl_glyph_invalid")
    entries = list(_fields(fields[0][1]))
    names = [(tag, value) for tag, value in entries if tag != 3]
    if names != [(1, stack.encode()), (2, range_name.encode())]:
        raise ValidationFailure("saved_map_gl_glyph_invalid")
    ids: set[int] = set()
    first, last = (int(part) for part in range_name.split("-"))
    for tag, value in entries:
        if tag != 3:
            continue
        if not isinstance(value, bytes):
            raise ValidationFailure("saved_map_gl_glyph_invalid")
        raw = list(_fields(value))
        glyph = dict(raw)
        if (
            len(raw) != 7
            or set(glyph) != set(range(1, 8))
            or any(not isinstance(glyph[key], int) for key in (1, 3, 4, 5, 6, 7))
            or not isinstance(glyph[2], bytes)
        ):
            raise ValidationFailure("saved_map_gl_glyph_invalid")
        identifier, width, height, advance = (int(glyph[key]) for key in (1, 3, 4, 7))
        if (
            identifier in ids
            or not first <= identifier <= last
            or not 0 <= width <= 128
            or not 0 <= height <= 128
            or advance > 256
            or len(glyph[2]) != (width + 6) * (height + 6)
            or int(glyph[5]) > 512
            or int(glyph[6]) > 512
        ):
            raise ValidationFailure("saved_map_gl_glyph_invalid")
        ids.add(identifier)
    if not ids or len(ids) > 256:
        raise ValidationFailure("saved_map_gl_glyph_invalid")
    return ids


class FontRegistry:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def resolve(self, reference: dict[str, Any], required: list[int]) -> dict[str, Any]:
        if (
            set(reference) != {"id", "version", "manifestChecksumSha256"}
            or not isinstance(reference["id"], str)
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", reference["id"])
            or type(reference["version"]) is not int
            or not 1 <= reference["version"] <= 2_147_483_647
            or not isinstance(reference["manifestChecksumSha256"], str)
            or not _HASH.fullmatch(reference["manifestChecksumSha256"])
        ):
            raise ValidationFailure("saved_map_gl_font_identity_mismatch")
        directory = (self.root / reference["id"] / str(reference["version"])).resolve()
        if not directory.is_relative_to(self.root):
            raise ValidationFailure("saved_map_gl_font_identity_mismatch")
        encoded = _read(directory / "manifest.json", 131_072, "saved_map_gl_font_unavailable")
        if sha256(encoded).hexdigest() != reference["manifestChecksumSha256"]:
            raise ValidationFailure("saved_map_gl_font_checksum_mismatch")
        try:
            manifest = json.loads(encoded)
        except (ValueError, RecursionError) as error:
            raise ValidationFailure("saved_map_gl_font_invalid") from error
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema") != "opengeo.glyph-manifest.1.0.0"
            or manifest.get("id") != reference["id"]
            or manifest.get("version") != reference["version"]
            or type(manifest.get("version")) is not int
            or not isinstance(manifest.get("fontStack"), str)
            or not re.fullmatch(r"[A-Za-z0-9 _-]{1,128}", manifest["fontStack"])
            or not isinstance(manifest.get("codepoints"), list)
            or not 1 <= len(manifest["codepoints"]) <= 65_536
            or any(
                type(point) is not int or not 0 <= point <= 0xFFFF or 0xD800 <= point <= 0xDFFF
                for point in manifest["codepoints"]
            )
            or manifest["codepoints"] != sorted(set(manifest["codepoints"]))
            or not isinstance(manifest.get("ranges"), list)
            or not 1 <= len(manifest["ranges"]) <= 256
            or any(
                not isinstance(manifest.get(key), str) or not _HASH.fullmatch(manifest[key])
                for key in ("fontSha256", "licenseSha256")
            )
        ):
            raise ValidationFailure("saved_map_gl_font_invalid")
        coverage = set(manifest["codepoints"])
        if any(type(point) is not int or point not in coverage for point in required):
            raise ValidationFailure("saved_map_gl_font_coverage_missing")
        license_bytes = _read(directory / "LICENSE.txt", 65_536, "saved_map_gl_font_unavailable")
        if sha256(license_bytes).hexdigest() != manifest["licenseSha256"]:
            raise ValidationFailure("saved_map_gl_font_checksum_mismatch")
        # The original font copyright is a required attribution companion.
        # Its release-inventory seal is separate from this frozen manifest.
        notice = _read(directory / "NOTICE.txt", 65_536, "saved_map_gl_font_notice_unavailable")
        if not notice.strip():
            raise ValidationFailure("saved_map_gl_font_notice_unavailable")
        ranges = []
        declared: set[int] = set()
        total_bytes = 0
        for item in manifest["ranges"]:
            if (
                not isinstance(item, dict)
                or set(item) != {"range", "checksumSha256", "sizeBytes"}
                or not isinstance(item["range"], str)
                or not _RANGE.fullmatch(item["range"])
                or not isinstance(item["checksumSha256"], str)
                or not _HASH.fullmatch(item["checksumSha256"])
                or type(item["sizeBytes"]) is not int
                or not 1 <= item["sizeBytes"] <= 1_048_576
            ):
                raise ValidationFailure("saved_map_gl_font_invalid")
            first, last = (int(part) for part in item["range"].split("-"))
            if first % 256 or last != first + 255 or not 0 <= first <= 0xFF00 or first in declared:
                raise ValidationFailure("saved_map_gl_font_invalid")
            declared.add(first)
            path = (directory / f"{item['range']}.pbf").resolve()
            if not path.is_relative_to(directory):
                raise ValidationFailure("saved_map_gl_font_invalid")
            content = _read(path, item["sizeBytes"], "saved_map_gl_glyph_unavailable")
            total_bytes += len(content)
            if total_bytes > 16_777_216:
                raise ValidationFailure("saved_map_gl_font_invalid")
            if (
                len(content) != item["sizeBytes"]
                or sha256(content).hexdigest() != item["checksumSha256"]
            ):
                raise ValidationFailure("saved_map_gl_glyph_checksum_mismatch")
            actual = glyph_ids(content, manifest["fontStack"], item["range"])
            if actual != {point for point in coverage if first <= point <= last}:
                raise ValidationFailure("saved_map_gl_glyph_coverage_mismatch")
            if any(first <= point <= last for point in required):
                ranges.append({**item, "contentBase64": base64.b64encode(content).decode()})
        if {point // 256 * 256 for point in coverage} != declared:
            raise ValidationFailure("saved_map_gl_glyph_coverage_mismatch")
        return {
            "fontRef": reference,
            "fontStack": manifest["fontStack"],
            "codepoints": manifest["codepoints"],
            "ranges": ranges,
        }


class MapLibreRuntime:
    """Fixed operator-provisioned runtime; no package/path choices come from jobs."""

    def __init__(
        self,
        *,
        font_root: Path = Path("/opt/opengeo-maplibre/fonts"),
        runtime_manifest: Path = Path("/opt/opengeo-maplibre/runtime.json"),
        timeout_seconds: int = 30,
    ) -> None:
        if not 1 <= timeout_seconds <= 120:
            raise ValueError("GL runtime timeout must be between 1 and 120 seconds")
        self._fonts = FontRegistry(font_root)
        self._manifest = runtime_manifest
        self._timeout = timeout_seconds
        self.last_receipt: dict[str, Any] | None = None

    def render(self, request: dict[str, Any], target: Path) -> None:
        self.last_receipt = None
        runtime_pin = (
            runtime_reference(request["runtimeReference"])
            if "runtimeReference" in request
            else None
        )
        package = self._package(runtime_pin)
        if package is not None and (
            self._fonts.root != self._manifest.parent / "fonts"
            or any(
                item["fontRef"] is not None and item["fontRef"] not in package["fontRefs"]
                for item in request["occurrences"]
            )
        ):
            raise ValidationFailure("saved_map_gl_font_identity_mismatch")
        fonts: dict[str, dict[str, Any]] = {}
        for occurrence in request["occurrences"]:
            reference = occurrence["fontRef"]
            if reference is None:
                continue
            font = self._fonts.resolve(reference, occurrence["requiredCodepoints"])
            stack = font["fontStack"]
            for layer in occurrence["style"]["layers"]:
                if layer["type"] == "symbol" and layer["layout"]["text-font"] != [stack]:
                    raise ValidationFailure("saved_map_gl_font_identity_mismatch")
            if stack in fonts:
                if fonts[stack]["fontRef"] != reference:
                    raise ValidationFailure("saved_map_gl_font_identity_mismatch")
                merged = {
                    item["range"]: item for item in [*fonts[stack]["ranges"], *font["ranges"]]
                }
                font["ranges"] = list(merged.values())
            fonts[stack] = font
        runtime = self._runtime() if package is None else self._package_runtime(package)
        require_render_capabilities(request, runtime)
        engine_version = bound_engine_version(request, runtime)
        payload = {**request, "maplibreVersion": engine_version, "fonts": list(fonts.values()), "runtime": runtime}
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        if len(encoded) > 40_000_000:
            raise ValidationFailure("saved_map_gl_input_limit")
        # Host Chromium creates Unix sockets under TMPDIR (typically limited to
        # 108 bytes). Output/archive paths can be much longer. Packaged jobs use
        # their existing mounted workspace; host jobs use a short private tempdir.
        with tempfile.TemporaryDirectory(
            prefix="gl-", dir=target.parent if package is not None else "/tmp"
        ) as temporary:
            workdir = Path(temporary)
            request_path = workdir / "request.json"
            request_path.write_bytes(encoded)
            result_path = target if package is None else workdir / "result.png"
            command = (
                self._package_command(workdir)
                if package is not None
                else [
                    runtime["prlimit"],
                    "--cpu=30",
                    "--fsize=20971520",
                    "--nofile=512",
                    "--",
                    runtime["unshare"],
                    "--user",
                    "--map-root-user",
                    "--net",
                    runtime["node"],
                    "--max-old-space-size=256",
                    runtime["script"],
                    str(request_path),
                    str(target.resolve()),
                ]
            )
            try:
                with (
                    tempfile.TemporaryFile(dir=workdir) as stdout,
                    tempfile.TemporaryFile(dir=workdir) as stderr,
                ):
                    process = subprocess.Popen(
                        command,
                        cwd=workdir,
                        env={
                            "PATH": "/usr/bin:/bin",
                            "TMPDIR": str(workdir),
                            "LANG": "C.UTF-8",
                            "LC_ALL": "C.UTF-8",
                        },
                        stdin=subprocess.DEVNULL,
                        stdout=stdout,
                        stderr=stderr,
                        start_new_session=True,
                        close_fds=True,
                    )
                    try:
                        code = process.wait(timeout=self._timeout)
                    except subprocess.TimeoutExpired as error:
                        _kill_runtime_tree(process.pid)
                        process.wait()
                        raise ValidationFailure("saved_map_gl_runtime_timeout") from error
                    except BaseException:
                        # Cancellation must not strand a detached browser process.
                        _kill_runtime_tree(process.pid)
                        process.wait()
                        raise
                    stdout.seek(0)
                    stderr.seek(0)
                    result, errors = stdout.read(65_537), stderr.read(65_537)
                    if len(result) > 65_536 or len(errors) > 65_536:
                        raise ValidationFailure("saved_map_gl_runtime_output_limit")
                    if code != 0:
                        raise ValidationFailure("saved_map_gl_runtime_failed")
                    receipt = json.loads(result)
                    if (
                        not isinstance(receipt, dict)
                        or receipt.get("status") != "pass"
                        or receipt.get("localGlyphCalls") != 0
                        or receipt.get("fontFaceCount") != 0
                        or receipt.get("deniedRequests") != 0
                        or receipt.get("maplibreVersion") != engine_version
                    ):
                        raise ValidationFailure("saved_map_gl_runtime_failed")
                    output = (
                        _read(result_path, 20_971_520, "saved_map_gl_output_invalid")
                        if package is None
                        else _package_output(result_path, request)
                    )
                    if sha256(output).hexdigest() != receipt.get("pngSha256"):
                        raise ValidationFailure("saved_map_gl_output_invalid")
                    if package is not None:
                        # Never expose a child-produced path or replace an existing output.
                        with target.open("xb") as destination:
                            destination.write(output)
                    self.last_receipt = {
                        **receipt,
                        **({"runtimeReference": runtime_pin} if runtime_pin is not None else {}),
                    }
            except (OSError, ValueError) as error:
                raise ValidationFailure("saved_map_gl_runtime_unavailable") from error

    def _package(self, reference: dict[str, str] | None = None) -> dict[str, Any] | None:
        encoded = _read(self._manifest, MAX_MANIFEST_BYTES, "saved_map_gl_runtime_unavailable")
        if reference is not None and sha256(encoded).hexdigest() != reference["manifestSha256"]:
            raise ValidationFailure("saved_map_gl_runtime_identity_mismatch")
        try:
            manifest = json.loads(encoded)
            if not isinstance(manifest, dict):
                raise ValueError("runtime manifest must be an object")
            if manifest.get("schema") == PACKAGE_SCHEMA:
                if self._manifest.name != "runtime.json":
                    raise ValidationFailure("saved_map_gl_package_invalid")
                package = verify_package(
                    self._manifest.parent,
                    expected_sha256=reference["manifestSha256"]
                    if reference is not None
                    else sha256(encoded).hexdigest(),
                )
                if reference is not None and package["architecture"] != reference["architecture"]:
                    raise ValidationFailure("saved_map_gl_runtime_identity_mismatch")
                return package
            if reference is not None:
                raise ValidationFailure("saved_map_gl_runtime_identity_mismatch")
            if manifest.get("schema") != "opengeo.maplibre-runtime.1.0.0":
                raise ValueError("runtime schema unavailable")
            return None
        except (ValueError, RecursionError) as error:
            raise ValidationFailure("saved_map_gl_runtime_unavailable") from error

    @staticmethod
    def _package_runtime(package: dict[str, Any]) -> dict[str, Any]:
        inventory = {item["path"]: item for item in package["inventory"]}
        runtime = {
            name: package[name]
            for name in ("browserVersion", "maplibreVersion", "playwrightVersion")
        }
        for name, relative in package["entrypoints"].items():
            runtime[name] = f"/{relative}"
            runtime[f"{name}ChecksumSha256"] = inventory[f"rootfs/{relative}"]["sha256"]
        return runtime

    def _package_command(self, workdir: Path) -> list[str]:
        return [
            "/usr/bin/prlimit",
            "--cpu=30",
            "--fsize=20971520",
            "--nofile=512",
            "--",
            "/usr/bin/unshare",
            "--user",
            "--map-root-user",
            "--net",
            "--mount",
            "--pid",
            "--fork",
            "--kill-child=KILL",
            sys.executable,
            "-I",
            str(self._manifest.parent / "launch-maplibre.py"),
            str(self._manifest.parent / "rootfs"),
            str(workdir),
        ]

    def _runtime(self) -> dict[str, Any]:
        encoded = _read(self._manifest, 32_768, "saved_map_gl_runtime_unavailable")
        try:
            manifest = json.loads(encoded)
            if (
                manifest["schema"] != "opengeo.maplibre-runtime.1.0.0"
                or manifest["maplibreVersion"] not in SUPPORTED_MAPLIBRE_VERSIONS
                or manifest["playwrightVersion"] != "1.61.1"
                or not isinstance(manifest["browserVersion"], str)
            ):
                raise ValueError("runtime identity mismatch")
            runtime: dict[str, Any] = {
                "browserVersion": manifest["browserVersion"],
                "maplibreVersion": manifest["maplibreVersion"],
                "playwrightVersion": "1.61.1",
            }
            for name in (
                "node",
                "browser",
                "script",
                "bundle",
                "playwrightPackage",
                "unshare",
                "prlimit",
            ):
                entry = manifest["files"][name]
                path = Path(entry["path"])
                if not path.is_absolute() or not _HASH.fullmatch(entry["checksumSha256"]):
                    raise ValueError("runtime file identity missing")
                digest = sha256()
                with path.open("rb") as stream:
                    while chunk := stream.read(1_048_576):
                        digest.update(chunk)
                if digest.hexdigest() != entry["checksumSha256"]:
                    raise ValueError("runtime file checksum mismatch")
                runtime[name] = str(path)
                runtime[f"{name}ChecksumSha256"] = entry["checksumSha256"]
            return runtime
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise ValidationFailure("saved_map_gl_runtime_unavailable") from error


def _package_output(path: Path, request: dict[str, Any]) -> bytes:
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValidationFailure("saved_map_gl_output_invalid")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValidationFailure("saved_map_gl_output_invalid")
            content = stream.read(20_971_521)
    except OSError as error:
        raise ValidationFailure("saved_map_gl_output_invalid") from error
    if (
        len(content) < 33
        or len(content) > 20_971_520
        or content[:8] != b"\x89PNG\r\n\x1a\n"
        or content[12:16] != b"IHDR"
        or struct.unpack(">II", content[16:24]) != (request["width"], request["height"])
        or content[-12:] != b"\x00\x00\x00\x00IEND\xaeB`\x82"
    ):
        raise ValidationFailure("saved_map_gl_output_invalid")
    return content


def _kill_runtime_tree(root: int) -> None:
    """Chromium may create its own session; kill only this command's descendants."""
    groups = {root}
    pending = [root]
    visited: set[int] = set()
    while pending and len(visited) < 256:
        pid = pending.pop()
        if pid in visited:
            continue
        visited.add(pid)
        try:
            children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
            for text in children:
                child = int(text)
                status = Path(f"/proc/{child}/status").read_text()
                parent = re.search(r"^PPid:\s+(\d+)$", status, re.MULTILINE)
                if parent is not None and int(parent[1]) == pid:
                    groups.add(os.getpgid(child))
                    pending.append(child)
        except (OSError, ValueError):
            continue
    for group in sorted(groups, reverse=True):
        # start_new_session=True ensures the worker's own group is never owned.
        if group > 0 and group != os.getpgrp():
            with suppress(ProcessLookupError):
                os.killpg(group, signal.SIGKILL)
