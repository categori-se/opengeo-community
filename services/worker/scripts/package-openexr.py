"""Package source-built OpenEXR with discoverable versions and license metadata."""

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


def header_version(path: Path, prefix: str) -> str:
    text = path.read_text()
    parts = []
    for component in ("MAJOR", "MINOR", "PATCH"):
        matches = re.findall(
            rf"^[ \t]*#[ \t]*define[ \t]+{prefix}_VERSION_{component}[ \t]+(\d+)[ \t]*$",
            text,
            re.M,
        )
        if len(matches) != 1:
            raise RuntimeError(f"missing version component in {path}")
        parts.append(matches[0])
    return ".".join(parts)


def main() -> None:
    source = Path("/build/openexr")
    version = header_version(source / "src/lib/OpenEXRCore/openexr_version.h", "OPENEXR")
    jph_version = header_version(
        source / "external/OpenJPH/src/core/openjph/ojph_version.h", "OPENJPH"
    )
    if version != "3.4.15" or jph_version != "0.31.0":
        raise RuntimeError("source versions differ from the reviewed dependency repair")
    prefix = Path("/opt/opengeo-openexr")
    for name, source_file in (
        ("OpenEXR", source / "LICENSE.md"),
        ("OpenJPH", source / "external/OpenJPH/LICENSE"),
    ):
        destination = prefix / "share/licenses" / name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_file, destination / "LICENSE")
    provenance = {
        "schemaVersion": "opengeo.native-source.1.0.0",
        "name": "openexr",
        "version": version,
        "sourceUrl": f"https://github.com/AcademySoftwareFoundation/openexr/archive/refs/tags/v{version}.tar.gz",
        "sourceSha256": hashlib.sha256(Path("/build/openexr.tar.gz").read_bytes()).hexdigest(),
        "bundledDependencies": [
            {
                "name": "OpenJPH",
                "version": jph_version,
                "license": "BSD-2-Clause",
                "sourceDirectory": "external/OpenJPH",
                "linkage": "static",
            }
        ],
    }
    (prefix / "share/source.json").write_text(json.dumps(provenance, indent=2) + "\n")
    # Include the vendored codec in a standard inventory as well as the package
    # record. This supplements filesystem scanning; it never replaces the full
    # image scan or asserts that an unexamined component is vulnerability-free.
    openexr_ref = f"pkg:generic/openexr@{version}"
    openjph_ref = f"pkg:generic/openjph@{jph_version}"
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "components": [
            {
                "type": "library",
                "name": "openexr",
                "version": version,
                "bom-ref": openexr_ref,
                "purl": openexr_ref,
                "licenses": [{"license": {"id": "BSD-3-Clause"}}],
                "externalReferences": [
                    {
                        "type": "distribution",
                        "url": provenance["sourceUrl"],
                        "hashes": [{"alg": "SHA-256", "content": provenance["sourceSha256"]}],
                    }
                ],
            },
            {
                "type": "library",
                "name": "openjph",
                "version": jph_version,
                "bom-ref": openjph_ref,
                "purl": openjph_ref,
                "licenses": [{"license": {"id": "BSD-2-Clause"}}],
                "properties": [
                    {"name": "opengeo:bundled-source", "value": "external/OpenJPH"},
                    {"name": "opengeo:linkage", "value": "static"},
                ],
            },
        ],
        "dependencies": [
            {"ref": openexr_ref, "dependsOn": [openjph_ref]},
            {"ref": openjph_ref, "dependsOn": []},
        ],
    }
    (prefix / "share/openexr.cdx.json").write_text(json.dumps(sbom, indent=2) + "\n")
    package = Path("/build/openexr-package")
    package.mkdir()
    shutil.copytree(prefix, package / "opt/opengeo-openexr", symlinks=True)
    control = package / "DEBIAN"
    control.mkdir()
    architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    (control / "control").write_text(
        "Package: opengeo-openexr\nSource: openexr\n"
        f"Version: {version}-1opengeo1\nArchitecture: {architecture}\n"
        "Section: libs\nPriority: optional\nMaintainer: OpenGeo.Tools contributors\n"
        "Depends: libc6, libdeflate0, libgcc-s1, libimath-3-1-29t64, libstdc++6\n"
        f"Built-Using: openjph (= {jph_version})\nHomepage: https://openexr.com/\n"
        "Description: Source-built OpenEXR with its original ABI and bundled OpenJPH\n"
        " Installed in a private prefix for the matching GDAL EXR plugin.\n"
    )
    subprocess.run(
        ["dpkg-deb", "--root-owner-group", "--build", str(package), "/build/opengeo-openexr.deb"],
        check=True,
    )


if __name__ == "__main__":
    main()
