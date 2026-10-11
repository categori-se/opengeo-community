"""Verify an explicitly provisioned, immutable MapLibre runtime package."""

import hashlib
import json
import os
import platform
import re
import stat
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from opengeo_worker.models import ValidationFailure
from opengeo_worker.render_runtime import SUPPORTED_MAPLIBRE_VERSIONS

PACKAGE_SCHEMA = "opengeo.maplibre-package.1.0.0"
SANDBOX_KIND = "user-mount-pid-net-pivot-landlock.v1"
MAX_MANIFEST_BYTES = 4_194_304
MAX_PACKAGE_FILES = 12_000
MAX_PACKAGE_BYTES = 2_147_483_648
_HASH = re.compile(r"[a-f0-9]{64}")
_SEGMENT = re.compile(r"[A-Za-z0-9_@+.,=-]+")
_ARCHITECTURES = {"x86_64", "aarch64"}
_FIELDS = {
    "schema",
    "renderer",
    "architecture",
    "maplibreVersion",
    "playwrightVersion",
    "browserVersion",
    "entrypoints",
    "sandbox",
    "inventory",
    "fontRefs",
    "nativePackages",
}
_ENTRYPOINTS = {"node", "browser", "script", "bundle", "playwrightPackage"}


def _fail(code: str = "saved_map_gl_package_invalid") -> NoReturn:
    raise ValidationFailure(code)


def _relative(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        _fail()
    parts = value.split("/")
    if (
        len(parts) > 64
        or any(part in {"", ".", ".."} or not _SEGMENT.fullmatch(part) for part in parts)
        or PurePosixPath(value).is_absolute()
        or str(PurePosixPath(value)) != value
    ):
        _fail()
    return value


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def _read_manifest(path: Path) -> bytes:
    if not stat.S_ISREG(path.lstat().st_mode):
        _fail()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        information = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(information.st_mode)
            or not 1 <= information.st_size <= MAX_MANIFEST_BYTES
        ):
            _fail()
        content = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(content) != information.st_size or len(content) > MAX_MANIFEST_BYTES:
            _fail()
        return content


def _inventory(manifest: dict[str, Any], manifest_size: int) -> dict[str, dict[str, Any]]:
    items = manifest["inventory"]
    # runtime.json is the single unlisted file, but still counts toward bounds.
    if not isinstance(items, list) or not 1 <= len(items) < MAX_PACKAGE_FILES:
        _fail()
    inventory: dict[str, dict[str, Any]] = {}
    total = manifest_size
    for entry in items:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes", "mode"}:
            _fail()
        name = _relative(entry["path"])
        if (
            name == "runtime.json"
            or name in inventory
            or not isinstance(entry["sha256"], str)
            or not _HASH.fullmatch(entry["sha256"])
            or type(entry["bytes"]) is not int
            or not 0 <= entry["bytes"] <= MAX_PACKAGE_BYTES
            or type(entry["mode"]) is not int
            or entry["mode"] not in {0o444, 0o555}
        ):
            _fail()
        total += entry["bytes"]
        if total > MAX_PACKAGE_BYTES:
            _fail()
        inventory[name] = entry
    return inventory


def _verify_file(path: Path, expected: dict[str, Any]) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        information = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(information.st_mode)
            or stat.S_IMODE(information.st_mode) != expected["mode"]
            or information.st_size != expected["bytes"]
        ):
            _fail()
        digest = hashlib.sha256()
        size = 0
        while chunk := stream.read(1_048_576):
            size += len(chunk)
            if size > expected["bytes"]:
                _fail()
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        if (
            size != expected["bytes"]
            or after.st_size != expected["bytes"]
            or stat.S_IMODE(after.st_mode) != expected["mode"]
            or digest.hexdigest() != expected["sha256"]
        ):
            _fail("saved_map_gl_package_checksum_mismatch")


def _verify_tree(root: Path, inventory: dict[str, dict[str, Any]]) -> None:
    seen: set[str] = set()
    directories = [root]
    visited = 0
    while directories:
        directory = directories.pop()
        visited += 1
        if visited > MAX_PACKAGE_FILES * 4:
            _fail()
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                relative = _relative(path.relative_to(root).as_posix())
                information = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(information.st_mode):
                    if visited + len(directories) >= MAX_PACKAGE_FILES * 4:
                        _fail()
                    directories.append(path)
                elif stat.S_ISREG(information.st_mode):
                    if relative == "runtime.json":
                        continue
                    if relative not in inventory or len(seen) >= MAX_PACKAGE_FILES:
                        _fail()
                    _verify_file(path, inventory[relative])
                    seen.add(relative)
                else:
                    _fail()
    if seen != set(inventory):
        _fail()


def _verify_fonts(
    root: Path, manifest: dict[str, Any], inventory: dict[str, dict[str, Any]]
) -> None:
    # Runtime imports this verifier for packaged mode; defer the existing font
    # registry import until module initialization is complete in either direction.
    from opengeo_worker.maplibre_runtime import FontRegistry

    references = manifest["fontRefs"]
    if not isinstance(references, list) or not 1 <= len(references) <= 16:
        _fail()
    registry = FontRegistry(root / "fonts")
    identities: set[tuple[str, int]] = set()
    for reference in references:
        if not isinstance(reference, dict):
            _fail()
        registry.resolve(reference, [])
        identity = (reference["id"], reference["version"])
        if identity in identities:
            _fail()
        identities.add(identity)
        directory = f"fonts/{identity[0]}/{identity[1]}"
        font_manifest = json.loads((root / directory / "manifest.json").read_bytes())
        required = {
            f"{directory}/manifest.json",
            f"{directory}/LICENSE.txt",
            f"{directory}/NOTICE.txt",
            *(f"{directory}/{entry['range']}.pbf" for entry in font_manifest["ranges"]),
        }
        if not required.issubset(inventory):
            _fail()


def _verify_native_packages(manifest: dict[str, Any], inventory: dict[str, dict[str, Any]]) -> None:
    packages = manifest["nativePackages"]
    if not isinstance(packages, list) or not 1 <= len(packages) <= 4096:
        _fail()
    identities: set[tuple[str, str]] = set()
    for package in packages:
        if not isinstance(package, dict) or set(package) != {
            "name",
            "version",
            "licenseExpression",
            "sourceRpm",
            "licenseFiles",
        }:
            _fail()
        for field, maximum in (
            ("name", 256),
            ("version", 256),
            ("licenseExpression", 2048),
            ("sourceRpm", 512),
        ):
            value = package[field]
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                _fail()
        identity = (package["name"], package["version"])
        if identity in identities:
            _fail()
        identities.add(identity)
        licenses = package["licenseFiles"]
        if not isinstance(licenses, list) or len(licenses) > 256:
            _fail()
        paths = [_relative(path) for path in licenses]
        if len(paths) != len(set(paths)) or not set(paths).issubset(inventory):
            _fail()


def verify_package(
    root: Path,
    *,
    expected_sha256: str | None = None,
    expected_architecture: str | None = None,
) -> dict[str, Any]:
    """Check every package byte and required font without executing any input."""
    try:
        root = Path(root)
        if (
            not root.is_absolute()
            or root.is_symlink()
            or not root.is_dir()
            or root.resolve() != root
        ):
            _fail()
        encoded = _read_manifest(root / "runtime.json")
        if expected_sha256 is not None and (
            not _HASH.fullmatch(expected_sha256)
            or hashlib.sha256(encoded).hexdigest() != expected_sha256
        ):
            _fail("saved_map_gl_package_checksum_mismatch")
        manifest = json.loads(encoded.decode("utf-8"), object_pairs_hook=_closed_object)
        if (
            not isinstance(manifest, dict)
            or set(manifest) != _FIELDS
            or manifest["schema"] != PACKAGE_SCHEMA
            or manifest["renderer"] != "opengeo.maplibre-gl-js.v1"
            or manifest["architecture"] not in _ARCHITECTURES
            or manifest["maplibreVersion"] not in SUPPORTED_MAPLIBRE_VERSIONS
            or manifest["playwrightVersion"] != "1.61.1"
            or not isinstance(manifest["browserVersion"], str)
            or len(manifest["browserVersion"]) > 64
            or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", manifest["browserVersion"])
            or not isinstance(manifest["entrypoints"], dict)
            or set(manifest["entrypoints"]) != _ENTRYPOINTS
            or manifest["sandbox"] != {"kind": SANDBOX_KIND, "launcher": "launch-maplibre.py"}
        ):
            _fail()
        architecture = expected_architecture or platform.machine()
        if architecture not in _ARCHITECTURES or manifest["architecture"] != architecture:
            _fail("saved_map_gl_package_architecture_mismatch")
        inventory = _inventory(manifest, len(encoded))
        _verify_native_packages(manifest, inventory)
        if "launch-maplibre.py" not in inventory:
            _fail()
        for name, relative in manifest["entrypoints"].items():
            path = f"rootfs/{_relative(relative)}"
            if path not in inventory or (
                name in {"node", "browser"} and inventory[path]["mode"] != 0o555
            ):
                _fail()
        _verify_tree(root, inventory)
        _verify_fonts(root, manifest, inventory)
        # Retain the exact identity verified before the potentially large walk.
        if _read_manifest(root / "runtime.json") != encoded:
            _fail("saved_map_gl_package_checksum_mismatch")
        return manifest
    except ValidationFailure:
        raise
    except (OSError, ValueError, TypeError, KeyError, RecursionError, OverflowError) as error:
        raise ValidationFailure("saved_map_gl_package_invalid") from error
