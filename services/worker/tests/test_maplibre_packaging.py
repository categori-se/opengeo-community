"""Offline builder checks, not execution or security approval of a native runtime."""

import hashlib
import importlib.util
import json
import shutil
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[3]
FONT_DIRECTORY = Path("opengeo-open-sans-v1/1")


@pytest.fixture
def builder():
    spec = importlib.util.spec_from_file_location(
        "maplibre_local_packager", ROOT / "services/worker/scripts/package-maplibre-local.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_file(path, content, *, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(0o755 if executable else 0o644)
    return path


def seal_input_manifest(inputs):
    inputs.arguments.input_manifest = str(inputs.manifest_path)
    inputs.manifest_path.write_text(json.dumps(inputs.manifest))
    inputs.arguments.input_sha256 = hashlib.sha256(inputs.manifest_path.read_bytes()).hexdigest()


@pytest.fixture
def inputs(tmp_path, builder, monkeypatch):
    """Small inert executables and real font bytes; never invoke these inputs."""
    source = tmp_path / "source"
    files = {
        "node": write_file(source / "node/bin/node", b"\x7fELFfixture-node", executable=True),
        "browser": write_file(
            source / "browser/chromium", b"\x7fELFfixture-chromium", executable=True
        ),
        "script": write_file(source / "render-maplibre.mjs", b"// fixture runtime script\n"),
        "bundle": write_file(source / "maplibre.js", b"// fixture MapLibre bundle\n"),
        "playwrightPackage": write_file(
            source / "node_modules/playwright/package.json",
            b'{"name":"playwright","version":"1.61.1"}',
        ),
        "unshare": write_file(source / "bin/unshare", b"unused legacy input", executable=True),
        "prlimit": write_file(source / "bin/prlimit", b"unused legacy input", executable=True),
    }
    core = write_file(
        source / "node_modules/playwright-core/package.json",
        b'{"name":"playwright-core","version":"1.61.1"}',
    )
    write_file(source / "node_modules/playwright/lib/index.js", b"// fixture Playwright code")
    write_file(core.parent / "lib/index.js", b"// fixture Playwright Core code")
    write_file(source / "node/LICENSE", b"fixture Node license")
    browser_data = write_file(source / "browser/resources.pak", b"fixture browser data")
    library = write_file(source / "lib/libfixture.so.1", b"fixture native dependency")
    library_alias = source / "lib/libfixture.so"
    library_alias.symlink_to(library.name)
    fake_root = tmp_path / "repository"
    write_file(fake_root / "services/worker/scripts/launch-maplibre.py", b"# inert launcher\n")
    write_file(fake_root / "app/node_modules/maplibre-gl/LICENSE.txt", b"fixture MapLibre license")
    shutil.copytree(
        ROOT / "app/src/assets/render-fonts" / FONT_DIRECTORY,
        fake_root / "app/src/assets/render-fonts" / FONT_DIRECTORY,
    )
    monkeypatch.setattr(builder, "ROOT", fake_root)
    fixture = SimpleNamespace(
        files=files,
        core=core,
        browser_data=browser_data,
        library=library,
        library_alias=library_alias,
        manifest_path=source / "runtime.json",
        arguments=SimpleNamespace(output=str(tmp_path / "package")),
        manifest={
            "schema": "opengeo.maplibre-runtime.1.0.0",
            "maplibreVersion": "5.24.0",
            "playwrightVersion": "1.61.1",
            "browserVersion": "151.0.7922.71",
            "files": {
                name: {"path": str(path), "checksumSha256": builder.digest(path)}
                for name, path in files.items()
            },
        },
    )
    seal_input_manifest(fixture)
    return fixture


@pytest.mark.parametrize("mutation", ["manifest", "requested_checksum", "pinned_file"])
def test_exact_input_checksums_fail_before_staging_or_native_commands(
    builder, inputs, monkeypatch, mutation
):
    if mutation == "manifest":
        inputs.manifest_path.write_text(inputs.manifest_path.read_text() + "\n")
    elif mutation == "requested_checksum":
        inputs.arguments.input_sha256 = "0" * 64
    else:
        inputs.files["script"].write_bytes(b"changed pinned script")

    def forbidden(_arguments):
        raise AssertionError("Rejected input must not reach native inventory commands")

    monkeypatch.setattr(builder, "checked_command", forbidden)
    with pytest.raises(ValueError, match=r"checksum mismatch|changed pinned local input: script"):
        builder.build(inputs.arguments)
    assert not Path(inputs.arguments.output).exists()


def test_mismatched_pinned_engine_and_transitive_playwright_versions_fail(builder, inputs):
    inputs.manifest["maplibreVersion"] = "5.25.0"
    seal_input_manifest(inputs)
    with pytest.raises(ValueError, match="unsupported local rendering input"):
        builder.build(inputs.arguments)
    assert not Path(inputs.arguments.output).exists()
    inputs.manifest["maplibreVersion"] = "5.24.0"
    seal_input_manifest(inputs)
    inputs.core.write_text('{"name":"playwright-core","version":"1.60.0"}')
    with pytest.raises(ValueError, match="Playwright package identity mismatch"):
        builder.build(inputs.arguments)
    assert not (Path(inputs.arguments.output) / "runtime.json").exists()


def test_output_must_be_a_new_explicit_canonical_directory_under_tmp(builder, tmp_path):
    alias = tmp_path / "alias"
    alias.symlink_to(tmp_path, target_is_directory=True)
    for output in (Path("/tmp"), Path("relative-package"), tmp_path, alias / "package", ROOT):
        with pytest.raises((ValueError, FileExistsError)):
            builder.Package(output)
    output = tmp_path / "new-package"
    assert builder.Package(output).root == output
    assert stat.S_IMODE(output.stat().st_mode) == 0o700


def test_native_symlink_copy_is_regular_idempotent_and_cannot_conflict(builder, tmp_path):
    source = write_file(tmp_path / "libfixture.so.1", b"native bytes", executable=True)
    alias = tmp_path / "libfixture.so"
    alias.symlink_to(source.name)
    package = builder.Package(tmp_path / "package")
    package.copy(alias, "rootfs/lib64/libfixture.so")
    package.copy(source, "rootfs/lib64/libfixture.so")
    target = package.root / "rootfs/lib64/libfixture.so"
    assert target.is_file() and not target.is_symlink()
    assert target.read_bytes() == source.read_bytes()
    assert stat.S_IMODE(target.stat().st_mode) == 0o555
    assert package.bytes == len(b"native bytes")
    assert len(package.inventory()) == 1
    changed = write_file(tmp_path / "changed.so", b"different native bytes")
    with pytest.raises(ValueError, match="conflicting native dependency destination"):
        package.copy(changed, "rootfs/lib64/libfixture.so")
    assert target.read_bytes() == source.read_bytes()


def test_input_trees_reject_symlinks_and_copies_reject_escape_destinations(builder, tmp_path):
    source = write_file(tmp_path / "input/real-file", b"data")
    (source.parent / "alias").symlink_to(source.name)
    package = builder.Package(tmp_path / "package")
    with pytest.raises(ValueError, match="must not contain symlinks"):
        package.tree(source.parent, "runtime")
    for destination in ("../escaped", "/tmp/escaped", "runtime/../escaped"):
        with pytest.raises(ValueError, match="invalid package file"):
            package.copy(source, destination)
    assert package.inventory() == []


@pytest.mark.parametrize("bound", ["files", "bytes"])
def test_copy_bounds_fail_without_writing_the_overflowing_file(builder, tmp_path, bound):
    source = write_file(tmp_path / "input", b"two bytes or more")
    package = builder.Package(tmp_path / "package")
    if bound == "files":
        package.sources = {f"synthetic-{index}": "not written" for index in range(12_000)}
    else:
        package.bytes = 2_147_483_647
    with pytest.raises(ValueError, match="package exceeds file or byte limit"):
        package.copy(source, "overflow")
    assert not (package.root / "overflow").exists()


def test_native_dependencies_parse_loader_aliases_skip_data_and_reject_missing(
    builder, tmp_path, monkeypatch
):
    executable = write_file(tmp_path / "binary", b"\x7fELFfixture", executable=True)
    data = write_file(tmp_path / "data.pak", b"not ELF")
    calls = []

    def ldd(arguments):
        calls.append(arguments)
        return (
            "linux-vdso.so.1 (0x00000000)\n"
            "libfixture.so => /lib64/libfixture.so (0x00000001)\n"
            "/lib64/ld-linux-x86-64.so.2 (0x00000002)\n"
        )

    monkeypatch.setattr(builder, "checked_command", ldd)
    assert builder.native_dependencies([data, executable]) == [
        Path("/lib64/ld-linux-x86-64.so.2"),
        Path("/lib64/libfixture.so"),
    ]
    assert calls == [["ldd", str(executable)]]
    monkeypatch.setattr(builder, "checked_command", lambda _arguments: "libfixture.so => not found")
    with pytest.raises(ValueError, match="native runtime dependency is unavailable"):
        builder.native_dependencies([executable])


def test_rpm_provenance_uses_exact_nevra_with_multiarch_and_rpm_version_characters(
    builder, tmp_path, monkeypatch
):
    owner = "bzip2-libs-1.0.8~rc1^git2-21.fc43.x86_64"
    calls = []

    def rpm(arguments):
        calls.append(arguments)
        if arguments[:2] == ["rpm", "-qf"]:
            assert arguments[3] == "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n"
            return owner + "\n"
        # An unqualified name also finds the installed i686 RPM and returns
        # multiple identities. Only the exact owning NEVRA is unambiguous.
        if arguments[:2] == ["rpm", "-q"]:
            fields = "bzip2-libs\n1.0.8~rc1^git2-21.fc43.x86_64\nBSD-4-Clause\nbzip2.src.rpm\n"
            return fields if arguments[-1] == owner else fields + fields.replace("x86_64", "i686")
        if arguments[:2] == ["rpm", "-ql"]:
            assert arguments[-1] == owner
            return ""
        raise AssertionError(f"Unexpected native command: {arguments}")

    monkeypatch.setattr(builder, "checked_command", rpm)
    first = write_file(tmp_path / "libbz2.so.1", b"fixture")
    second = write_file(tmp_path / "libbz2.so", b"fixture")
    records = builder.native_provenance(builder.Package(tmp_path / "package"), [first, second])
    assert records == [
        {
            "name": "bzip2-libs",
            "version": "1.0.8~rc1^git2-21.fc43.x86_64",
            "licenseExpression": "BSD-4-Clause",
            "sourceRpm": "bzip2.src.rpm",
            "licenseFiles": [],
        }
    ]
    assert [command[-1] for command in calls if command[1] in {"-q", "-ql"}] == [owner, owner]


@pytest.mark.parametrize("version", ["5.24.0", "6.0.0"])
def test_full_staging_verifies_real_fonts_and_reports_manifest_in_file_and_byte_totals(
    builder, inputs, monkeypatch, version
):
    inputs.manifest["maplibreVersion"] = version
    if version == "6.0.0":
        license_path = write_file(inputs.manifest_path.parent / "v6-license.txt", b"pinned v6 license")
        inputs.manifest["files"]["maplibreLicense"] = {"path": str(license_path), "checksumSha256": builder.digest(license_path)}
    seal_input_manifest(inputs)
    calls = []
    owner = "fixture-native-1.0-1.x86_64"

    def native_command(arguments):
        calls.append(arguments)
        if arguments[0] == "ldd":
            return f"libfixture.so => {inputs.library_alias} (0x00000001)\n"
        if arguments[:2] == ["rpm", "-qf"]:
            return owner + "\n"
        if arguments[:2] == ["rpm", "-q"]:
            assert arguments[-1] == owner
            return "fixture-native\n1.0-1.x86_64\nMIT\nfixture-native-1.0-1.src.rpm\n"
        if arguments[:2] == ["rpm", "-ql"]:
            assert arguments[-1] == owner
            return ""
        raise AssertionError(f"No runtime may execute during packaging: {arguments}")

    monkeypatch.setattr(builder, "checked_command", native_command)
    result = builder.build(inputs.arguments)
    output = Path(inputs.arguments.output)
    manifest_path = output / "runtime.json"
    manifest = json.loads(manifest_path.read_bytes())
    files = [path for path in output.rglob("*") if path.is_file()]
    assert result["status"] == "pass"
    assert manifest["maplibreVersion"] == version
    if version == "6.0.0":
        assert (output / "licenses/MapLibre-LICENSE.txt").read_bytes() == b"pinned v6 license"
    assert result["manifestSha256"] == builder.digest(manifest_path)
    assert result["inputManifestSha256"] == inputs.arguments.input_sha256
    assert result["files"] == len(files) == len(manifest["inventory"]) + 1
    assert result["bytes"] == sum(path.stat().st_size for path in files)
    assert result["bytes"] == (
        sum(entry["bytes"] for entry in manifest["inventory"]) + manifest_path.stat().st_size
    )
    assert not any(path.is_symlink() for path in output.rglob("*"))
    assert all(stat.S_IMODE(path.stat().st_mode) in {0o444, 0o555} for path in files)
    assert all(
        stat.S_IMODE(path.stat().st_mode) == 0o555
        for path in [output, *output.rglob("*")]
        if path.is_dir()
    )
    inventory = {entry["path"]: entry for entry in manifest["inventory"]}
    assert "launch-maplibre.py" in inventory
    assert f"fonts/{FONT_DIRECTORY}/NOTICE.txt" in inventory
    assert f"fonts/{FONT_DIRECTORY}/LICENSE.txt" in inventory
    assert "rootfs/runtime/node_modules/playwright-core/lib/index.js" in inventory
    assert "rootfs/runtime/browser/resources.pak" in inventory
    assert (output / "rootfs/etc/passwd").read_text() == (
        "renderer:x:0:0:OpenGeo renderer:/work:/sbin/nologin\n"
    )
    assert (output / "rootfs/etc/group").read_text() == "renderer:x:0:\n"
    assert (output / "rootfs/etc/nsswitch.conf").read_text() == (
        "passwd: files\ngroup: files\nhosts: files\n"
    )
    assert "rootfs" + str(inputs.library_alias) in inventory
    assert "rootfs/lib64/" + inputs.library_alias.name in inventory
    for entry in manifest["inventory"]:
        assert builder.digest(output / entry["path"]) == entry["sha256"]
    for name, relative in manifest["entrypoints"].items():
        assert "rootfs/" + relative in inventory
        if name in {"node", "browser"}:
            assert inventory["rootfs/" + relative]["mode"] == 0o555
    assert {command[-1] for command in calls if command[:2] == ["rpm", "-qf"]} == {
        str(inputs.files["browser"]),
        str(inputs.browser_data),
        str(inputs.library_alias),
    }
    assert {command[-1] for command in calls if command[0] == "ldd"} == {
        str(inputs.files["node"]),
        str(inputs.files["browser"]),
    }


def test_v6_requires_pinned_license_before_staging(builder, inputs):
    inputs.manifest["maplibreVersion"] = "6.0.0"
    seal_input_manifest(inputs)
    with pytest.raises(ValueError, match="checksum-pinned MapLibre license"):
        builder.build(inputs.arguments)
    assert not Path(inputs.arguments.output).exists()
