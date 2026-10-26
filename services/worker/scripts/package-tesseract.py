"""Prepare and package the reviewed downstream Tesseract security build."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

BUILD_ROOT = Path("/build")
SOURCE = BUILD_ROOT / "tesseract"
PATCHES = BUILD_ROOT / "tesseract-security"
BUILD = BUILD_ROOT / "tesseract-build"
STAGE = BUILD_ROOT / "tesseract-stage"
VERSION = "5.5.3"
PACKAGE_VERSION = "5.5.3+opengeo.20261025.1"
SOURCE_COMMIT = "db0ec62f81b0737fbbe184d8fea40af5738f8eef"
SOURCE_SHA256 = "21dbaff9867d937c156d0b898e90b726aa339129cfebd7e1365cd5fee5046d67"
TESTS = {
    "unicharset_load_test": 3,
    "fullyconnected_test": 2,
    "intproto_test": 4,
    "normproto_test": 3,
    "genericvector_test": 3,
}
# Preserve the installed Debian SONAME through the actual linker property.
# Existing upstream test targets need only libtesseract/GTest, not trainers.
CMAKE_ADDENDUM = """
# OpenGeo packaging integration; runtime and five security test sources remain unchanged.
set_target_properties(libtesseract PROPERTIES SOVERSION 5)
if(NOT HAVE_LIBCURL OR NOT HAVE_LIBARCHIVE)
  message(FATAL_ERROR "The reviewed Tesseract build requires curl and archive support")
endif()
if(BUILD_TESTS)
  foreach(test_name IN ITEMS unicharset_load_test fullyconnected_test
      intproto_test normproto_test genericvector_test)
    if(NOT TARGET ${test_name})
      message(FATAL_ERROR "Missing upstream security test target: ${test_name}")
    endif()
    set_property(TARGET ${test_name} PROPERTY LINK_LIBRARIES
      libtesseract GTest::gtest_main)
    target_compile_definitions(${test_name} PRIVATE OPEN_GEO_SECURITY_TESTS_ONLY)
  endforeach()
endif()
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest() -> dict:
    value = json.loads((PATCHES / "manifest.json").read_text())
    if (
        value.get("schemaVersion") != 1
        or value.get("upstreamVersion") != VERSION
        or value.get("packageVersion") != PACKAGE_VERSION
        or value.get("sourceCommit") != SOURCE_COMMIT
        or value.get("sourceSha256") != SOURCE_SHA256
        or value.get("sourceUrl")
        != f"https://codeload.github.com/tesseract-ocr/tesseract/tar.gz/{SOURCE_COMMIT}"
        or sha256(BUILD_ROOT / "tesseract.tar.gz") != SOURCE_SHA256
        or (SOURCE / "VERSION").read_text().strip() != VERSION
    ):
        raise RuntimeError("Tesseract source or package identity differs from the reviewed build")
    expected = ("88052", "88048", "88053", "88047", "88051")
    entries = value.get("patches", [])
    if len(entries) != len(expected):
        raise RuntimeError("The exact five reviewed security patches are required")
    for index, (entry, number) in enumerate(zip(entries, expected), start=1):
        filename = f"{index:02d}-CVE-2026-{number}.patch"
        if (
            entry.get("file") != filename
            or entry.get("cve") != f"CVE-2026-{number}"
            or re.fullmatch(r"[0-9a-f]{40}", entry.get("upstreamCommit", "")) is None
            or re.fullmatch(r"[0-9a-f]{64}", entry.get("upstreamPatchSha256", "")) is None
            or sha256(PATCHES / filename) != entry.get("patchSha256")
        ):
            raise RuntimeError("A reviewed security patch identity changed")
    return value


def prepare_security_test_header() -> dict:
    header = SOURCE / "unittest/include_gunit.h"
    before = header.read_bytes()
    text = before.decode()
    include = '#include "fileio.h"  // for tesseract::File\n'
    start = 'static const char *FLAGS_test_tmpdir = "./tmp";\n'
    wrapper = "class file : public tesseract::File {\n"
    end = '// /usr/include/tensorflow/core/platform/default/logging.h defines the CHECK* macros.\n'
    if any(text.count(anchor) != 1 for anchor in (include, start, wrapper, end)) or (
        "OPEN_GEO_SECURITY_TESTS_ONLY" in text
    ):
        raise RuntimeError("Unexpected upstream common test header")
    test_sources = {}
    for name in TESTS:
        path = SOURCE / "unittest" / f"{name}.cc"
        body = path.read_bytes()
        if re.search(r"\b(?:file|File)::|\btrim\s*\(|\bFLAGS_test_tmpdir\b", body.decode()):
            raise RuntimeError("A security test requires the training-only helpers")
        test_sources[name] = hashlib.sha256(body).hexdigest()
    text = text.replace(
        include,
        "#ifdef OPEN_GEO_SECURITY_TESTS_ONLY\n"
        "#  if !defined(_WIN32)\n"
        "#    include <unistd.h> // for the existing rmdir test fixtures\n"
        "#  endif\n"
        "#else\n" + include + "#endif\n",
        1,
    )
    position = text.index(start)
    stop = text.index(end, position)
    text = (
        text[:position]
        + "#ifndef OPEN_GEO_SECURITY_TESTS_ONLY\n"
        + text[position:stop]
        + "#endif // OPEN_GEO_SECURITY_TESTS_ONLY\n\n"
        + text[stop:]
    )
    header.write_text(text)
    if any(sha256(SOURCE / "unittest" / f"{name}.cc") != digest
           for name, digest in test_sources.items()):
        raise RuntimeError("An upstream security test source changed")
    return {
        "path": "unittest/include_gunit.h",
        "beforeSha256": hashlib.sha256(before).hexdigest(),
        "afterSha256": sha256(header),
        "privateCompileDefinition": "OPEN_GEO_SECURITY_TESTS_ONLY",
        "targets": list(TESTS),
        "securityTestSourceSha256": test_sources,
        "securityTestSourcesUnchanged": True,
        "adaptation": "Guard unused training File helpers; preserve all security test payloads and assertions",
    }


def prepare() -> None:
    value = manifest()
    subprocess.run(["sha256sum", "--check", "--strict", "SHA256SUMS"], cwd=PATCHES, check=True)
    touched = set()
    applications = []
    for entry in value["patches"]:
        patch = PATCHES / entry["file"]
        result = subprocess.run(
            ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(patch)],
            cwd=SOURCE,
            check=True,
            capture_output=True,
            text=True,
        )
        # Stable and upstream line numbers differ; exact-context relocation is
        # expected. Never discard context to make a hunk apply.
        if re.search(r"\bfuzz\b", result.stdout + result.stderr, re.I):
            raise RuntimeError("A security patch required an unreviewed context adjustment")
        applications.append({"file": entry["file"], "output": result.stdout})
        for name in re.findall(r"^\+\+\+ b/([^\t\n]+)", patch.read_text(), re.M):
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Unsafe patched source path")
            touched.add(name)
    patched = {name: sha256(SOURCE / name) for name in sorted(touched)}
    header_provenance = prepare_security_test_header()
    cmake = SOURCE / "CMakeLists.txt"
    cmake.write_text(cmake.read_text() + CMAKE_ADDENDUM)
    googletest = SOURCE / "unittest/third_party/googletest"
    if not googletest.is_symlink() and googletest.is_dir():
        try:
            googletest.rmdir()  # The official archive retains an empty submodule directory.
        except OSError as error:
            raise RuntimeError("Unexpected bundled Googletest source") from error
    if googletest.exists() or googletest.is_symlink():
        raise RuntimeError("Unexpected bundled Googletest source")
    googletest.symlink_to("/usr/src/googletest", target_is_directory=True)
    (BUILD_ROOT / "tesseract-preparation.json").write_text(
        json.dumps(
            {
                "manifest": value,
                "patchApplications": applications,
                "patchedSourceSha256": patched,
                "securityTestHeader": header_provenance,
                "cmakeAddendumSha256": hashlib.sha256(CMAKE_ADDENDUM.encode()).hexdigest(),
                "buildIntegration": (
                    "System Googletest; five existing targets with private core-only test helpers "
                    "and link overrides; real SONAME 5"
                ),
            },
            indent=2,
        )
        + "\n"
    )


def dependencies(binary: Path, library_directory: Path, packaging: Path) -> str:
    output = subprocess.check_output(
        ["dpkg-shlibdeps", "-O", f"-l{library_directory}", f"-e{binary}"],
        cwd=packaging,
        text=True,
    )
    matches = re.findall(r"^shlibs:Depends=(.+)$", output, re.M)
    if len(matches) != 1:
        raise RuntimeError("Cannot derive the actual runtime package dependencies")
    return matches[0]


def package() -> None:
    value = manifest()
    preparation = json.loads((BUILD_ROOT / "tesseract-preparation.json").read_text())
    if preparation["manifest"] != value:
        raise RuntimeError("The source manifest changed after preparation")
    multiarch = subprocess.check_output(
        ["dpkg-architecture", "-qDEB_HOST_MULTIARCH"], text=True
    ).strip()
    architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    library_directory = STAGE / "usr/lib" / multiarch
    library = library_directory / f"libtesseract.so.{VERSION}"
    cli = STAGE / "usr/bin/tesseract"
    dynamic = subprocess.check_output(["readelf", "--dynamic", str(library)], text=True)
    if "Library soname: [libtesseract.so.5]" not in dynamic:
        raise RuntimeError("The actual Tesseract library SONAME must remain 5")
    loaded = ctypes.CDLL(str(library))
    loaded.TessVersion.restype = ctypes.c_char_p
    if loaded.TessVersion().decode() != VERSION:
        raise RuntimeError("The actual Tesseract library version differs from its source")
    environment = {**os.environ, "LD_LIBRARY_PATH": str(library_directory), "LC_ALL": "C.UTF-8"}
    cli_version = subprocess.check_output(
        [str(cli), "--version"], stderr=subprocess.STDOUT, env=environment, text=True
    )
    linkage = subprocess.check_output(["ldd", str(cli)], env=environment, text=True)
    if (
        re.match(r"tesseract 5\.5\.3(?:\s|$)", cli_version) is None
        or f"libtesseract.so.5 => {library_directory}/libtesseract.so.5 " not in linkage
        or "Found libarchive" not in cli_version
        or "Found libcurl" not in cli_version
    ):
        raise RuntimeError("The CLI must load the new library with archive/curl capabilities")
    tests = {}
    for name, count in TESTS.items():
        result = ET.parse(BUILD_ROOT / "tesseract-security-results" / f"{name}.xml").getroot()
        if (
            int(result.get("tests", "-1")) != count
            or int(result.get("failures", "-1")) != 0
            or int(result.get("disabled", "-1")) != 0
            or int(result.get("errors", "-1")) != 0
        ):
            raise RuntimeError("An upstream security regression did not pass completely")
        tests[name] = count
    packaging = BUILD_ROOT / "tesseract-packages"
    (packaging / "debian").mkdir(parents=True)
    (packaging / "debian/control").write_text(
        "Source: tesseract\nSection: graphics\nPriority: optional\n"
        "Maintainer: OpenGeo.Tools contributors\n\n"
        "Package: libtesseract5\nArchitecture: any\nDescription: Patched Tesseract OCR library\n\n"
        "Package: tesseract-ocr\nArchitecture: any\nDescription: Patched Tesseract OCR CLI\n"
    )
    (packaging / "debian/shlibs.local").write_text(
        f"libtesseract 5 libtesseract5 (= {PACKAGE_VERSION})\n"
    )
    library_dependencies = dependencies(library, library_directory, packaging)
    cli_dependencies = dependencies(cli, library_directory, packaging)
    # Preserve the existing separately owned model dependencies. The public
    # builder need not install/download those models merely to compile sources.
    models = [
        "tesseract-ocr-eng (>= 4.0.9~)",
        "tesseract-ocr-osd (>= 4.0.9~)",
    ]
    if f"libtesseract5 (= {PACKAGE_VERSION})" not in cli_dependencies:
        raise RuntimeError("The CLI must retain its exact library and existing model dependencies")
    binaries = {
        "/usr/bin/tesseract": sha256(cli),
        f"/usr/lib/{multiarch}/{library.name}": sha256(library),
    }
    provenance = {
        **preparation,
        "runtimeVersion": VERSION,
        "packageVersion": PACKAGE_VERSION,
        "architecture": architecture,
        "soname": "libtesseract.so.5",
        "tessdataDirectory": "/usr/share/tesseract-ocr/5/tessdata",
        "binarySha256": binaries,
        "cliVersion": cli_version,
        "upstreamSecurityTests": {"targets": tests, "casesPassed": sum(tests.values())},
        "fullImageAndEcrAcceptance": "required separately; not established by packaging",
    }
    configs = STAGE / "usr/share/tesseract-ocr/5/tessdata"
    if any(not (configs / "configs" / name).is_file() for name in ("txt", "tsv", "pdf")):
        raise RuntimeError("The installed runtime output configurations must be preserved")
    if any(configs.rglob("*.traineddata")):
        raise RuntimeError("Language-package traineddata must not be claimed by these packages")
    for name, depends in (
        ("libtesseract5", library_dependencies),
        ("tesseract-ocr", ", ".join([cli_dependencies, *models])),
    ):
        destination = packaging / name
        if name == "libtesseract5":
            target = destination / "usr/lib" / multiarch
            target.mkdir(parents=True)
            for path in library_directory.glob("libtesseract.so.*"):
                shutil.copy2(path, target / path.name, follow_symlinks=False)
        else:
            (destination / "usr/bin").mkdir(parents=True)
            shutil.copy2(cli, destination / "usr/bin/tesseract")
            shutil.copytree(configs, destination / "usr/share/tesseract-ocr/5/tessdata")
        documents = destination / "usr/share/doc" / name
        documents.mkdir(parents=True)
        shutil.copy2(SOURCE / "LICENSE", documents / "copyright")
        shutil.copytree(PATCHES, documents / "opengeo-patches")
        (documents / "opengeo-source.json").write_text(json.dumps(provenance, indent=2) + "\n")
        control = destination / "DEBIAN"
        control.mkdir()
        (control / "control").write_text(
            f"Package: {name}\nSource: tesseract\nVersion: {PACKAGE_VERSION}\n"
            f"Architecture: {architecture}\nSection: graphics\nPriority: optional\n"
            "Maintainer: OpenGeo.Tools contributors\n"
            f"Depends: {depends}\nHomepage: https://github.com/tesseract-ocr/tesseract\n"
            "Description: Tesseract 5.5.3 with five reviewed downstream security patches\n"
            " Custom OpenGeo build; not an Ubuntu/ESM package or an upstream 5.5.4 release.\n"
        )
        if name == "libtesseract5":
            (control / "triggers").write_text("activate-noawait ldconfig\n")
            (control / "shlibs").write_text(
                f"libtesseract 5 libtesseract5 (>= {PACKAGE_VERSION})\n"
            )
        subprocess.run(
            [
                "dpkg-deb", "--root-owner-group", "--build",
                str(destination), str(BUILD_ROOT / f"{name}.deb"),
            ],
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true")
    options = parser.parse_args()
    prepare() if options.prepare else package()
