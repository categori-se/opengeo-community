import hashlib
import json
import os
from pathlib import Path

import pytest

from opengeo_worker.maplibre_package import verify_package
from opengeo_worker.models import ValidationFailure

FONT_DIRECTORY = Path("opengeo-open-sans-v1/1")
FONT_ROOT = Path(__file__).resolve().parents[3] / "app/src/assets/render-fonts" / FONT_DIRECTORY
FONT_REF = {
    "id": "opengeo-open-sans-v1",
    "version": 1,
    "manifestChecksumSha256": "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a",
}


def write(root, relative, content, mode=0o444):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.chmod(0o644)
    path.write_bytes(content)
    path.chmod(mode)


def seal(root, manifest):
    manifest["inventory"] = [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size,
            "mode": path.stat().st_mode & 0o7777,
        }
        for path in sorted(root.rglob("*"))
        if path.is_file() and path != root / "runtime.json"
    ]
    return save_manifest(root, manifest)


def save_manifest(root, manifest):
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    write(root, "runtime.json", encoded)
    return hashlib.sha256(encoded).hexdigest()


def build_package(tmp_path):
    root = tmp_path / "package"
    root.mkdir()
    for source in FONT_ROOT.iterdir():
        if source.is_file():
            write(root, Path("fonts") / FONT_DIRECTORY / source.name, source.read_bytes())
    entries = {
        "node": "runtime/bin/node",
        "browser": "runtime/browser/chromium",
        "script": "runtime/render-maplibre.mjs",
        "bundle": "runtime/maplibre.js",
        "playwrightPackage": "runtime/node_modules/playwright/package.json",
    }
    for name, path in entries.items():
        write(
            root, f"rootfs/{path}", name.encode(), 0o555 if name in {"node", "browser"} else 0o444
        )
    write(root, "launch-maplibre.py", b"never executed by verification", 0o555)
    write(root, "rootfs/lib64/libc.so.6", b"inventoried native dependency")
    write(root, "rootfs/provenance/LICENSE.txt", b"synthetic test package license")
    manifest = {
        "schema": "opengeo.maplibre-package.1.0.0",
        "renderer": "opengeo.maplibre-gl-js.v1",
        "architecture": "x86_64",
        "maplibreVersion": "5.24.0",
        "playwrightVersion": "1.61.1",
        "browserVersion": "151.0.7922.71",
        "entrypoints": entries,
        "sandbox": {
            "kind": "user-mount-pid-net-pivot-landlock.v1",
            "launcher": "launch-maplibre.py",
        },
        "fontRefs": [FONT_REF.copy()],
        "nativePackages": [
            {
                "name": "fixture-native-package",
                "version": "1.0",
                "licenseExpression": "MIT",
                "sourceRpm": "fixture-1.0.src.rpm",
                "licenseFiles": ["rootfs/provenance/LICENSE.txt"],
            }
        ],
    }
    checksum = seal(root, manifest)
    return root, manifest, checksum


@pytest.fixture
def package(tmp_path):
    return build_package(tmp_path)


def verify(root, checksum=None):
    return verify_package(root, expected_sha256=checksum, expected_architecture="x86_64")


def test_complete_package_and_real_glyph_inventory_are_verified_without_execution(
    package, monkeypatch
):
    root, manifest, checksum = package

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Package verification must not execute anything")

    monkeypatch.setattr("subprocess.run", forbidden)
    monkeypatch.setattr("subprocess.Popen", forbidden)
    monkeypatch.setattr(os, "system", forbidden)
    assert verify(root, checksum) == manifest


def test_wrong_manifest_digest_and_native_architecture_fail(package, monkeypatch):
    root, _manifest, checksum = package
    with pytest.raises(ValidationFailure, match="package_checksum_mismatch"):
        verify(root, "0" * 64)
    with pytest.raises(ValidationFailure, match="package_architecture_mismatch"):
        verify_package(root, expected_sha256=checksum, expected_architecture="aarch64")
    monkeypatch.setattr("opengeo_worker.maplibre_package.platform.machine", lambda: "aarch64")
    with pytest.raises(ValidationFailure, match="package_architecture_mismatch"):
        verify_package(root, expected_sha256=checksum)


def test_package_root_cannot_hide_behind_a_symlink(package):
    root, _manifest, checksum = package
    alias = root.parent / "alias"
    alias.symlink_to(root, target_is_directory=True)
    with pytest.raises(ValidationFailure):
        verify(alias, checksum)


@pytest.mark.parametrize(
    "change",
    [
        {"schema": "opengeo.maplibre-runtime.1.0.0"},
        {"extra": "unreviewed"},
        {"renderer": "other"},
        {"architecture": "amd64"},
        {"maplibreVersion": "5.25.0"},
        {"playwrightVersion": "1.60.0"},
        {"browserVersion": "latest"},
        {"sandbox": {"kind": "none", "launcher": "launch-maplibre.py"}},
        {"sandbox": {"kind": "user-mount-pid-net-chroot.v1", "launcher": "other.py"}},
        {"nativePackages": ["unstructured provenance"]},
        {"fontRefs": []},
        {"fontRefs": [FONT_REF, FONT_REF]},
    ],
)
def test_closed_schema_and_fixed_runtime_identities(package, change):
    root, manifest, _checksum = package
    manifest.update(change)
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)


@pytest.mark.parametrize(
    "path",
    [
        "/usr/bin/node",
        "../node",
        "runtime/../node",
        "runtime//node",
        "runtime\\node",
        "runtime\nnode",
        "runtime/missing",
    ],
)
def test_entrypoints_must_be_safe_rootfs_relative_inventory_files(package, path):
    root, manifest, _checksum = package
    manifest["entrypoints"]["node"] = path
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)


@pytest.mark.parametrize(
    "change",
    [
        {"path": "../outside"},
        {"path": "runtime.json"},
        {"sha256": "A" * 64},
        {"bytes": True},
        {"bytes": -1},
        {"bytes": 2_147_483_649},
        {"mode": True},
        {"mode": 0o644},
        {"mode": 0o4555},
        {"extra": True},
    ],
)
def test_inventory_fields_are_closed_bounded_and_read_only(package, change):
    root, manifest, _checksum = package
    manifest["inventory"][0].update(change)
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)


@pytest.mark.parametrize(
    "mutation",
    [
        "changed",
        "mode",
        "missing",
        "extra",
        "duplicate",
        "unlisted",
        "directory",
        "symlink",
        "directory_symlink",
        "fifo",
    ],
)
def test_complete_tree_rejects_byte_mode_and_file_type_drift(package, mutation):
    root, manifest, _checksum = package
    target = root / "rootfs/lib64/libc.so.6"
    if mutation == "changed":
        write(root, "rootfs/lib64/libc.so.6", b"different native dependency")
    elif mutation == "mode":
        target.chmod(0o644)
    elif mutation == "missing":
        target.unlink()
    elif mutation == "extra":
        write(root, "extra.dat", b"not in inventory")
    elif mutation == "duplicate":
        manifest["inventory"].append(manifest["inventory"][0])
        save_manifest(root, manifest)
    elif mutation == "unlisted":
        manifest["inventory"].pop()
        save_manifest(root, manifest)
    elif mutation == "directory":
        target.unlink()
        target.mkdir()
    elif mutation == "symlink":
        target.unlink()
        target.symlink_to(root / "launch-maplibre.py")
    elif mutation == "directory_symlink":
        (root / "extra-link").symlink_to(root / "fonts", target_is_directory=True)
    elif mutation == "fifo":
        os.mkfifo(root / "extra-pipe")
    with pytest.raises(ValidationFailure):
        verify(root)


def test_required_font_notice_and_glyph_checks_are_not_replaced_by_self_seals(package):
    root, manifest, _checksum = package
    notice = root / "fonts" / FONT_DIRECTORY / "NOTICE.txt"
    notice.unlink()
    checksum = seal(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root, checksum)
    write(root, Path("fonts") / FONT_DIRECTORY / "NOTICE.txt", b"notice")
    write(root, Path("fonts") / FONT_DIRECTORY / "0-255.pbf", b"invalid glyph bytes")
    checksum = seal(root, manifest)
    with pytest.raises(ValidationFailure, match="glyph_checksum_mismatch"):
        verify(root, checksum)


def test_manifest_is_bounded_unique_key_json_and_cannot_be_a_symlink(package):
    root, _manifest, _checksum = package
    write(root, "runtime.json", b" " * 4_194_305)
    with pytest.raises(ValidationFailure):
        verify(root)
    (root / "runtime.json").unlink()
    os.mkfifo(root / "runtime.json")
    with pytest.raises(ValidationFailure):
        verify(root)


@pytest.mark.parametrize(
    "change",
    [
        {"unexpected": "value"},
        {"licenseExpression": None},
        {"name": ""},
        {"licenseFiles": ["../LICENSE"]},
        {"licenseFiles": ["missing-license.txt"]},
        {"licenseFiles": ["rootfs/provenance/LICENSE.txt"] * 2},
    ],
)
def test_native_provenance_is_closed_and_links_only_inventoried_licenses(package, change):
    root, manifest, _checksum = package
    manifest["nativePackages"][0].update(change)
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)
    write(root, "runtime.json", b'{"schema":"first","schema":"second"}')
    with pytest.raises(ValidationFailure):
        verify(root)
    (root / "runtime.json").unlink()
    (root / "runtime.json").symlink_to(root / "launch-maplibre.py")
    with pytest.raises(ValidationFailure):
        verify(root)


def test_inventory_file_count_and_total_bytes_are_bounded(package):
    root, manifest, _checksum = package
    manifest["inventory"] = [manifest["inventory"][0]] * 12_001
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)
    manifest["inventory"] = [
        {"path": f"rootfs/large-{index}", "sha256": "0" * 64, "bytes": 1_073_741_825, "mode": 0o444}
        for index in range(2)
    ]
    save_manifest(root, manifest)
    with pytest.raises(ValidationFailure):
        verify(root)


def test_inventory_hashes_stream_large_files_instead_of_read_bytes(package, monkeypatch):
    root, manifest, _checksum = package
    write(root, "rootfs/large.bin", b"x" * 3_145_728)
    checksum = seal(root, manifest)
    original = Path.read_bytes

    def bounded(path):
        assert path.stat().st_size <= 131_072, "Large package files must be streamed"
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", bounded)
    assert verify(root, checksum) == manifest
