"""Supplement the full worker image scan with image-bound native-library matching.

This checks the source-built OpenEXR and its bundled OpenJPH without representing
them as packages from another ecosystem. It does not replace Trivy or ECR.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

GRYPE_VERSION = "0.118.0"
OPENEXR_SHA256 = "445ed5b0ea4d9cf98be3a4f219e419628b123b61dec65ccb743ab9b07fbebdaa"
EXPECTED = {"openexr": "3.4.15", "openjph": "0.31.0"}
CONTROL_ADVISORIES = {"CVE-2026-53532", "CVE-2026-68516"}
HIGH_SEVERITIES = {"High", "Critical"}

# This program runs inside the exact image ID with no network or credentials.
# Only inventory and hashes leave the container. The loaded library provides its
# version independently of the package or SBOM's declarations.
INSPECT_NATIVE = r"""
import ctypes, hashlib, json, os, pathlib
p = pathlib.Path('/opt/opengeo-openexr')
lib = ctypes.CDLL(str(p / 'lib/libOpenEXRCore-3_4.so.33'))
lib.exr_get_library_version.argtypes = (
    [ctypes.POINTER(ctypes.c_int)] * 3 + [ctypes.POINTER(ctypes.c_char_p)]
)
lib.exr_get_library_version.restype = None
a, b, c, extra = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_char_p()
lib.exr_get_library_version(ctypes.byref(a), ctypes.byref(b), ctypes.byref(c), ctypes.byref(extra))
files = sorted({f.resolve() for f in (p / 'lib').glob('*.so*')})
plugins = list(pathlib.Path('/usr/lib').glob('*/gdalplugins/gdal_EXR.so'))
if len(plugins) != 1 or not files:
    raise RuntimeError('missing or ambiguous native runtime')
print(json.dumps({
    'source': json.loads((p / 'share/source.json').read_text()),
    'sbom': json.loads((p / 'share/openexr.cdx.json').read_text()),
    'runtimeVersion': f'{a.value}.{b.value}.{c.value}',
    'uid': os.getuid(), 'gid': os.getgid(),
    'files': [{'path': str(f), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()}
              for f in [*files, plugins[0]]]
}))
"""


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def components(sbom: dict) -> dict:
    if sbom.get("bomFormat") != "CycloneDX" or not isinstance(sbom.get("components"), list):
        raise ValueError("missing native CycloneDX components")
    found = {}
    for component in sbom["components"]:
        name, version = component.get("name"), component.get("version")
        if name in found or name not in EXPECTED or version != EXPECTED[name]:
            raise ValueError("native components changed or were omitted")
        if component.get("purl") != f"pkg:generic/{name}@{version}":
            raise ValueError("native component was assigned a false package ecosystem")
        found[name] = version
    if found != EXPECTED:
        raise ValueError("native components changed or were omitted")
    return found


def validate_inventory(inventory: dict) -> dict:
    source = inventory.get("source", {})
    if (
        source.get("schemaVersion") != "opengeo.native-source.1.0.0"
        or source.get("name") != "openexr"
        or source.get("version") != EXPECTED["openexr"]
        or source.get("sourceSha256") != OPENEXR_SHA256
        or source.get("sourceUrl")
        != "https://github.com/AcademySoftwareFoundation/openexr/archive/refs/tags/v3.4.15.tar.gz"
        or source.get("bundledDependencies")
        != [
            {
                "name": "OpenJPH",
                "version": EXPECTED["openjph"],
                "license": "BSD-2-Clause",
                "sourceDirectory": "external/OpenJPH",
                "linkage": "static",
            }
        ]
        or inventory.get("runtimeVersion") != EXPECTED["openexr"]
        or (inventory.get("uid"), inventory.get("gid")) != (10001, 10001)
    ):
        raise ValueError("native source or actual runtime differs from the reviewed repair")
    files = inventory.get("files")
    if not isinstance(files, list) or len(files) < 2:
        raise ValueError("missing native binary fingerprints")
    for file in files:
        if not re.fullmatch(r"[0-9a-f]{64}", file.get("sha256", "")):
            raise ValueError("invalid native binary fingerprint")
    sbom = inventory["sbom"]
    components(sbom)
    refs = {name: f"pkg:generic/{name}@{version}" for name, version in EXPECTED.items()}
    if sbom.get("dependencies") != [
        {"ref": refs["openexr"], "dependsOn": [refs["openjph"]]},
        {"ref": refs["openjph"], "dependsOn": []},
    ]:
        raise ValueError("bundled codec dependency relation is missing")
    return sbom


def validate_scan(report: dict, target: Path, now: datetime) -> dict:
    descriptor = report.get("descriptor", {})
    config = descriptor.get("configuration", {})
    status = descriptor.get("db", {}).get("status", {})
    if (
        descriptor.get("name") != "grype"
        or descriptor.get("version") != GRYPE_VERSION
        or report.get("source") != {"type": "sbom-file", "target": str(target)}
        or config.get("add-cpes-if-none") is not True
        or config.get("match", {}).get("stock", {}).get("using-cpes") is not True
        or config.get("only-fixed") is not False
        or config.get("only-notfixed") is not False
        or config.get("ignore-wontfix") != ""
        or config.get("fail-on-severity") != "high"
        or config.get("ignore") != []
        or config.get("exclude") != []
        or config.get("vex-documents") != []
        or config.get("vex-add") != []
        or config.get("externalSources", {}).get("enable") is not False
        or report.get("ignoredMatches", []) != []
        or not isinstance(report.get("matches"), list)
        or status.get("valid") is not True
        or config.get("db", {}).get("validate-by-hash-on-start") is not True
        or config.get("db", {}).get("auto-update") is not False
    ):
        raise ValueError("native scan is incomplete, unbound, or uses exclusions")
    built = datetime.fromisoformat(status.get("built", ""))
    if built.tzinfo is None or not timedelta(minutes=-5) <= now - built <= timedelta(hours=24):
        raise ValueError("native scan database is stale or future-dated")
    if "nvd" not in descriptor.get("db", {}).get("providers", {}):
        raise ValueError("native scan has no NVD advisory feed")
    for match in report["matches"]:
        if match.get("vulnerability", {}).get("severity") not in {
            "Negligible",
            "Low",
            "Medium",
            "High",
            "Critical",
        }:
            raise ValueError("malformed native vulnerability match")
    return status


def validate_results(candidate: dict, control: dict, matched_sbom: dict) -> dict:
    components(matched_sbom)
    for match in candidate["matches"]:
        artifact = match.get("artifact", {})
        if (
            artifact.get("name") not in EXPECTED
            or artifact.get("version") != EXPECTED[artifact["name"]]
        ):
            raise ValueError("native vulnerability match is bound to another library")
    if any(m["vulnerability"]["severity"] in HIGH_SEVERITIES for m in candidate["matches"]):
        raise ValueError("native libraries contain High or Critical findings")
    detected = {
        m["vulnerability"]["id"]
        for m in control["matches"]
        if m.get("artifact", {}).get("name") == "openexr"
        and m["artifact"].get("version") == "3.4.11"
        and m.get("matchDetails")
    }
    if not detected >= CONTROL_ADVISORIES or not any(
        m["vulnerability"]["severity"] in HIGH_SEVERITIES for m in control["matches"]
    ):
        raise ValueError("affected-version advisory matching control did not fail as expected")
    if candidate["descriptor"]["db"] != control["descriptor"]["db"]:
        raise ValueError("native scan database changed between candidate and control")
    return {
        "components": EXPECTED,
        "findings": len(candidate["matches"]),
        "high": 0,
        "critical": 0,
        "controlAdvisories": sorted(detected),
        "controlIsMetadataOnly": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("docker", "podman"), default="docker")
    parser.add_argument("--engine-arg", action="append", default=[])
    parser.add_argument("--image", required=True)
    parser.add_argument("--grype", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--update-db", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(mode=0o700)  # Never overwrite or reuse a prior acceptance result.
    engine = [args.engine, *args.engine_arg]
    inspect = subprocess.check_output([*engine, "image", "inspect", "--", args.image], timeout=30)
    image = json.loads(inspect)[0]
    digest = image["Id"].removeprefix("sha256:")
    if (
        not re.fullmatch(r"[0-9a-f]{64}", digest)
        or image.get("Architecture") not in {"amd64", "arm64"}
        or image.get("Config", {}).get("User") != "10001:10001"
    ):
        raise ValueError("unexpected worker image identity or architecture")
    command = [
        *engine,
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--entrypoint",
        "python3",
    ]
    if args.engine == "podman":
        command.append("--read-only-tmpfs=false")
    result = subprocess.run(
        [*command, digest, "-"],
        input=INSPECT_NATIVE,
        text=True,
        capture_output=True,
        check=True,
        timeout=60,
    )
    inventory = json.loads(result.stdout)
    sbom = validate_inventory(inventory)
    write_json(
        output / "native-image-inventory.json",
        {
            "imageConfigDigest": f"sha256:{digest}",
            "architecture": image["Architecture"],
            "inventory": inventory,
        },
    )
    native_path = output / "native.cdx.json"
    write_json(native_path, sbom)
    # Deliberately synthetic version metadata: do not copy source hashes or
    # licenses from the candidate and misrepresent an older installed library.
    control_path = output / "control.cdx.json"
    write_json(
        control_path,
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "version": 1,
            "components": [
                {
                    "type": "library",
                    "name": "openexr",
                    "version": "3.4.11",
                    "purl": "pkg:generic/openexr@3.4.11",
                    "bom-ref": "pkg:generic/openexr@3.4.11",
                }
            ],
        },
    )
    config_path = output / "grype-config.json"
    write_json(
        config_path,
        {
            "ignore": [],
            "exclude": [],
            "match-upstream-kernel-headers": True,
            "external-sources": {"enable": False},
        },
    )
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith(("GRYPE_", "SYFT_"))
    }
    environment.update(
        {
            "GRYPE_CHECK_FOR_APP_UPDATE": "false",
            "GRYPE_DB_AUTO_UPDATE": "false",
            "GRYPE_DB_CACHE_DIR": str(args.cache_dir.resolve()),
            "GRYPE_DB_MAX_ALLOWED_BUILT_AGE": "24h",
            "GRYPE_DB_VALIDATE_AGE": "true",
        }
    )
    scanner = str(args.grype.resolve())
    if args.update_db:
        with (output / "database-update.log").open("w") as log:
            subprocess.run(
                [scanner, "--config", str(config_path), "db", "update"],
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=300,
            )
    reports = {}
    for name, target, encoding, expected_exit in (
        ("candidate", native_path, "json", 0),
        ("matched", native_path, "cyclonedx-json", 0),
        ("control", control_path, "json", 2),
    ):
        report_path = output / f"{name}.json"
        with (output / f"{name}.log").open("w") as log:
            process = subprocess.run(
                [
                    scanner,
                    "--config",
                    str(config_path),
                    f"sbom:{target}",
                    "--add-cpes-if-none",
                    "--fail-on",
                    "high",
                    "--output",
                    encoding,
                    "--file",
                    str(report_path),
                    "-vv",
                ],
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=180,
            )
        if process.returncode != expected_exit:
            raise ValueError(f"{name} scan returned {process.returncode}, expected {expected_exit}")
        reports[name] = json.loads(report_path.read_text())
    now = datetime.now(UTC)
    db = validate_scan(reports["candidate"], native_path, now)
    validate_scan(reports["control"], control_path, now)
    summary = validate_results(reports["candidate"], reports["control"], reports["matched"])
    receipt = {
        "schemaVersion": "opengeo.worker-native-scan.1.0.0",
        "status": "passed",
        "observedAt": now.isoformat(),
        "scope": (
            "Native-library inventory and known-advisory matching; not full-image or ECR acceptance"
        ),
        "imageConfigDigest": f"sha256:{digest}",
        "architecture": image["Architecture"],
        "scanner": {"name": "grype", "version": GRYPE_VERSION, "sha256": sha256(args.grype)},
        "database": db,
        "matching": summary,
        "waivers": [],
        "limitations": [
            "CPE matching is heuristic; advisories for vendored OpenJPH may be filed under OpenEXR",
            "No standalone OpenJPH advisory match is proved by the OpenEXR metadata control",
            "Trivy full-image and independent ECR gates remain mandatory",
        ],
        "artifacts": [
            {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in sorted(output.iterdir())
            if path.is_file()
        ],
    }
    write_json(output / "native-scan-result.json", receipt)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
