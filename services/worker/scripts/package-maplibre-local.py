"""Stage an offline native rendering payload from explicitly pinned local inputs.

This builds no image and downloads nothing. The result is a local candidate,
not a deployment approval, complete SBOM, or vulnerability/license clearance.
Native architecture and distribution files are retained, never relabeled ARM64.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services/worker/src"))

from opengeo_worker.maplibre_package import SANDBOX_KIND, verify_package  # noqa: E402
from opengeo_worker.render_runtime import SUPPORTED_MAPLIBRE_VERSIONS  # noqa: E402

HASH = re.compile(r"[a-f0-9]{64}")
FONT = {
    "id": "opengeo-open-sans-v1",
    "version": 1,
    "manifestChecksumSha256": "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a",
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1_048_576):
            value.update(block)
    return value.hexdigest()


def checked_command(arguments):
    result = subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    if len(result.stdout) > 4_194_304:
        raise ValueError("native inventory output exceeds its bound")
    return result.stdout


class Package:
    def __init__(self, output):
        if (
            output.is_symlink()
            or output != output.resolve()
            or not output.is_relative_to(Path("/tmp"))
            or output == Path("/tmp")
        ):
            raise ValueError("use a new explicit directory under /tmp")
        output.mkdir(mode=0o700, exist_ok=False)
        self.root = output
        self.sources = {}
        self.bytes = 0

    def copy(self, source, relative, *, executable=None):
        source = Path(source)
        # Native library symlinks are resolved into regular payload files. The
        # payload itself never contains a symlink or a link outside its root.
        resolved = source.resolve(strict=True)
        if (
            not resolved.is_file()
            or any(part in {"", ".", ".."} for part in Path(relative).parts)
            or Path(relative).is_absolute()
        ):
            raise ValueError("invalid package file")
        target = self.root / relative
        if relative in self.sources:
            if digest(target) != digest(resolved):
                raise ValueError("conflicting native dependency destination")
            return
        size = resolved.stat().st_size
        self.bytes += size
        if len(self.sources) >= 12_000 or self.bytes > 2_147_483_648:
            raise ValueError("package exceeds file or byte limit")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(resolved, target)
        executable = bool(resolved.stat().st_mode & 0o111) if executable is None else executable
        target.chmod(0o555 if executable else 0o444)
        self.sources[relative] = str(resolved)

    def tree(self, source, relative):
        source = Path(source).resolve(strict=True)
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("runtime input directories must not contain symlinks")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError("runtime input contains a special file")
            self.copy(path, str(Path(relative) / path.relative_to(source)))

    def inventory(self):
        return [
            {
                "path": relative,
                "sha256": digest(self.root / relative),
                "bytes": (self.root / relative).stat().st_size,
                "mode": stat.S_IMODE((self.root / relative).stat().st_mode),
            }
            for relative in sorted(self.sources)
        ]


def native_dependencies(paths):
    libraries = set()
    for path in paths:
        with path.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                continue
        output = checked_command(["ldd", str(path)])
        if "not found" in output:
            raise ValueError("a native runtime dependency is unavailable")
        for line in output.splitlines():
            match = re.search(r"(?:=>\s+)?(/[^\s]+)\s+\(", line)
            if match:
                libraries.add(Path(match[1]))
    return sorted(libraries)


def native_provenance(package, paths):
    """Retain installed RPM identities/source names and shipped license files."""
    names = set()
    for path in paths:
        owner = checked_command(
            ["rpm", "-qf", "--queryformat", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n", str(path)]
        ).strip()
        if not re.fullmatch(r"[A-Za-z0-9+_.~^-]+", owner):
            raise ValueError("native library has no unique reviewed RPM owner")
        names.add(owner)
    result = []
    for name in sorted(names):
        fields = checked_command(
            [
                "rpm",
                "-q",
                "--queryformat",
                "%{NAME}\n%{VERSION}-%{RELEASE}.%{ARCH}\n%{LICENSE}\n%{SOURCERPM}\n",
                name,
            ]
        ).splitlines()
        if len(fields) != 4:
            raise ValueError("invalid native package identity")
        licenses = []
        for text in checked_command(["rpm", "-ql", name]).splitlines():
            path = Path(text)
            if text.startswith("/usr/share/licenses/") and path.is_file():
                identity = fields[0] + "/" + hashlib.sha256(name.encode()).hexdigest()[:16]
                relative = (
                    "licenses/native/"
                    + identity
                    + "/"
                    + str(path.relative_to("/usr/share/licenses"))
                )
                package.copy(path, relative, executable=False)
                licenses.append(relative)
        result.append(
            {
                "name": fields[0],
                "version": fields[1],
                "licenseExpression": fields[2],
                "sourceRpm": fields[3],
                "licenseFiles": licenses,
            }
        )
    return result


def build(arguments):
    source_manifest = Path(arguments.input_manifest).resolve(strict=True)
    if (
        not HASH.fullmatch(arguments.input_sha256)
        or digest(source_manifest) != arguments.input_sha256
    ):
        raise ValueError("local input manifest checksum mismatch")
    manifest = json.loads(source_manifest.read_text())
    if (
        manifest.get("schema") != "opengeo.maplibre-runtime.1.0.0"
        or manifest.get("maplibreVersion") not in SUPPORTED_MAPLIBRE_VERSIONS
        or manifest.get("playwrightVersion") != "1.61.1"
    ):
        raise ValueError("unsupported local rendering input")
    inputs = {}
    for name, entry in manifest["files"].items():
        path = Path(entry["path"])
        if not path.is_absolute() or digest(path) != entry["checksumSha256"]:
            raise ValueError("changed pinned local input: " + name)
        inputs[name] = path
    if manifest["maplibreVersion"] == "6.0.0" and "maplibreLicense" not in inputs:
        raise ValueError("v6 requires a checksum-pinned MapLibre license")
    machine = os.uname().machine
    if machine not in {"x86_64", "aarch64"}:
        raise ValueError("unsupported native architecture")
    package = Package(Path(arguments.output))
    package.copy(inputs["node"], "rootfs/runtime/bin/node", executable=True)
    package.tree(inputs["browser"].parent, "rootfs/runtime/browser")
    playwright = inputs["playwrightPackage"].parent
    core = playwright.parent / "playwright-core"
    for source, target in [(playwright, "playwright"), (core, "playwright-core")]:
        if json.loads((source / "package.json").read_text())["version"] != "1.61.1":
            raise ValueError("Playwright package identity mismatch")
        package.tree(source, "rootfs/runtime/node_modules/" + target)
    package.copy(inputs["script"], "rootfs/runtime/render-maplibre.mjs", executable=False)
    package.copy(inputs["bundle"], "rootfs/runtime/maplibre.js", executable=False)
    package.copy(
        ROOT / "services/worker/scripts/launch-maplibre.py", "launch-maplibre.py", executable=False
    )
    font_root = ROOT / "app/src/assets/render-fonts"
    package.tree(
        font_root / FONT["id"] / str(FONT["version"]), f"fonts/{FONT['id']}/{FONT['version']}"
    )
    package.copy(
        inputs["node"].parent.parent / "LICENSE", "licenses/Node-LICENSE.txt", executable=False
    )
    package.copy(
        inputs.get("maplibreLicense", ROOT / "app/node_modules/maplibre-gl/LICENSE.txt"),
        "licenses/MapLibre-LICENSE.txt",
        executable=False,
    )
    native_inputs = [
        inputs["node"],
        *[
            Path(path)
            for relative, path in package.sources.items()
            if relative.startswith("rootfs/runtime/browser/")
        ],
    ]
    libraries = native_dependencies(native_inputs)
    for library in libraries:
        package.copy(library, "rootfs" + str(library))
        # ldd has already resolved loader-cache paths (for example Fedora's
        # ffmpeg directory). The minimal root has no host ld.so.cache. Seal a
        # regular alias in its default library directory; conflicting basenames
        # fail in Package.copy rather than selecting an arbitrary dependency.
        package.copy(library, "rootfs/lib64/" + library.name)
    provenance = native_provenance(package, [*native_inputs[1:], *libraries])
    for directory in ("work", "tmp", "proc", "dev", "oldroot"):
        (package.root / "rootfs" / directory).mkdir(exist_ok=True)
    # Node/Playwright resolve a home directory via getpwuid when no environment
    # override is present. The namespace UID is local; the outer worker stays
    # nonroot. Do not copy the host's passwd, NSS settings or home directory.
    local_identity = {
        "passwd": "renderer:x:0:0:OpenGeo renderer:/work:/sbin/nologin\n",
        "group": "renderer:x:0:\n",
        "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files\n",
    }
    (package.root / "rootfs/etc").mkdir()
    for name, content in local_identity.items():
        target = package.root / "rootfs/etc" / name
        target.write_text(content, encoding="utf-8")
        target.chmod(0o444)
        package.bytes += target.stat().st_size
        package.sources[str(target.relative_to(package.root))] = "generated-sandbox-identity"
    # These become narrowly selected device bind targets only in the child
    # mount namespace. No devices or sensitive workstation files are packaged.
    for device in ("null", "zero", "random", "urandom"):
        target = package.root / "rootfs/dev" / device
        target.write_bytes(b"")
        target.chmod(0o444)
        package.sources[str(target.relative_to(package.root))] = (
            "generated-empty-device-bind-target"
        )
    result = {
        "schema": "opengeo.maplibre-package.1.0.0",
        "renderer": "opengeo.maplibre-gl-js.v1",
        "architecture": machine,
        "maplibreVersion": manifest["maplibreVersion"],
        "playwrightVersion": "1.61.1",
        "browserVersion": manifest["browserVersion"],
        "entrypoints": {
            "node": "runtime/bin/node",
            "browser": "runtime/browser/" + inputs["browser"].name,
            "script": "runtime/render-maplibre.mjs",
            "bundle": "runtime/maplibre.js",
            "playwrightPackage": "runtime/node_modules/playwright/package.json",
        },
        "sandbox": {
            "kind": SANDBOX_KIND,
            "launcher": "launch-maplibre.py",
        },
        "inventory": package.inventory(),
        "fontRefs": [FONT],
        "nativePackages": provenance,
    }
    (package.root / "runtime.json").write_text(json.dumps(result, indent=2) + "\n")
    (package.root / "runtime.json").chmod(0o444)
    for directory in [*package.root.rglob("*"), package.root]:
        if directory.is_dir():
            directory.chmod(0o555)
    checksum = digest(package.root / "runtime.json")
    verify_package(package.root, expected_sha256=checksum, expected_architecture=machine)
    return {
        "status": "pass",
        "scope": (
            "offline local native payload; no image build, release, SBOM "
            "or security-clearance claim"
        ),
        "package": str(package.root),
        "manifestSha256": checksum,
        "architecture": machine,
        "files": len(result["inventory"]) + 1,
        "bytes": package.bytes + (package.root / "runtime.json").stat().st_size,
        "inputManifestSha256": arguments.input_sha256,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-manifest", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--output", required=True)
    print(json.dumps(build(parser.parse_args()), indent=2))
