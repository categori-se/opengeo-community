import copy
import runpy
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

SCAN = runpy.run_path(str(Path(__file__).parents[1] / "scripts/scan-native-libraries.py"))
NOW = datetime(2026, 9, 7, 21, 30, tzinfo=UTC)
TARGET = Path("/tmp/worker-native.cdx.json")


def sbom() -> dict:
    return {
        "bomFormat": "CycloneDX",
        "components": [
            {"name": name, "version": version, "purl": f"pkg:generic/{name}@{version}"}
            for name, version in SCAN["EXPECTED"].items()
        ],
    }


def report() -> dict:
    return {
        "source": {"type": "sbom-file", "target": str(TARGET)},
        "matches": [],
        "descriptor": {
            "name": "grype",
            "version": SCAN["GRYPE_VERSION"],
            "configuration": {
                "add-cpes-if-none": True,
                "match": {"stock": {"using-cpes": True}},
                "only-fixed": False,
                "only-notfixed": False,
                "ignore-wontfix": "",
                "fail-on-severity": "high",
                "ignore": [],
                "exclude": [],
                "vex-documents": [],
                "vex-add": [],
                "externalSources": {"enable": False},
                "db": {"validate-by-hash-on-start": True, "auto-update": False},
            },
            "db": {
                "status": {"valid": True, "built": (NOW - timedelta(hours=1)).isoformat()},
                "providers": {"nvd": {}},
            },
        },
    }


def control() -> dict:
    result = report()
    result["matches"] = [
        {
            "artifact": {"name": "openexr", "version": "3.4.11"},
            "vulnerability": {"id": cve, "severity": "High"},
            "matchDetails": [{"matcher": "stock-matcher", "type": "cpe-match"}],
        }
        for cve in SCAN["CONTROL_ADVISORIES"]
    ]
    return result


def test_exact_native_inventory_and_scan_pass_with_detected_control() -> None:
    SCAN["validate_scan"](report(), TARGET, NOW)
    result = SCAN["validate_results"](report(), control(), sbom())
    assert result["components"] == {"openexr": "3.4.15", "openjph": "0.31.0"}
    assert result["controlIsMetadataOnly"] is True


@pytest.mark.parametrize("mutation", ["missing-codec", "duplicate", "version", "false-ecosystem"])
def test_rejects_missing_or_misrepresented_native_components(mutation: str) -> None:
    value = sbom()
    if mutation == "missing-codec":
        value["components"].pop()
    elif mutation == "duplicate":
        value["components"].append(copy.deepcopy(value["components"][0]))
    elif mutation == "version":
        value["components"][0]["version"] = "3.1.13"
    else:
        value["components"][1]["purl"] = "pkg:conan/openjph@0.31.0"
    with pytest.raises(ValueError):
        SCAN["components"](value)


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "unbound",
        "no-cpe",
        "stock-disabled",
        "ignore",
        "excluded",
        "vex",
        "fixed-only",
        "suppressed",
        "invalid-db",
        "stale-db",
        "future-db",
        "no-feed",
    ],
)
def test_rejects_incomplete_suppressed_or_stale_scans(mutation: str) -> None:
    value = report()
    config = value["descriptor"]["configuration"]
    if mutation == "missing":
        del value["matches"]
    elif mutation == "unbound":
        value["source"]["target"] = "/tmp/other.json"
    elif mutation == "no-cpe":
        config["add-cpes-if-none"] = False
    elif mutation == "stock-disabled":
        config["match"]["stock"]["using-cpes"] = False
    elif mutation == "ignore":
        config["ignore"] = [{"vulnerability": "CVE-2026-53532"}]
    elif mutation == "excluded":
        config["exclude"] = ["**"]
    elif mutation == "vex":
        config["vex-documents"] = ["waiver.json"]
    elif mutation == "fixed-only":
        config["only-fixed"] = True
    elif mutation == "suppressed":
        value["ignoredMatches"] = control()["matches"]
    elif mutation == "invalid-db":
        value["descriptor"]["db"]["status"]["valid"] = False
    elif mutation == "stale-db":
        value["descriptor"]["db"]["status"]["built"] = (NOW - timedelta(days=2)).isoformat()
    elif mutation == "future-db":
        value["descriptor"]["db"]["status"]["built"] = (NOW + timedelta(days=2)).isoformat()
    else:
        value["descriptor"]["db"]["providers"] = {}
    with pytest.raises(ValueError):
        SCAN["validate_scan"](value, TARGET, NOW)


@pytest.mark.parametrize("mutation", ["affected", "empty-control", "wrong-version", "different-db"])
def test_positive_control_cannot_be_replaced_by_an_empty_result(mutation: str) -> None:
    candidate, affected = report(), control()
    if mutation == "affected":
        candidate["matches"] = copy.deepcopy(affected["matches"])
        for match in candidate["matches"]:
            match["artifact"]["version"] = "3.4.15"
    elif mutation == "empty-control":
        affected["matches"] = []
    elif mutation == "wrong-version":
        affected["matches"][0]["artifact"]["version"] = "3.4.15"
    else:
        affected["descriptor"]["db"]["status"]["built"] = NOW.isoformat()
    with pytest.raises(ValueError):
        SCAN["validate_results"](candidate, affected, sbom())
