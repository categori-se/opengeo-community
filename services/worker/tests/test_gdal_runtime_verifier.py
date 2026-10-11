import copy
import runpy
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[1] / "scripts"
VERIFY = runpy.run_path(str(SCRIPTS / "verify-gdal-runtime.py"))
PACKAGE = runpy.run_path(str(SCRIPTS / "package-openexr.py"))


def full_inventory() -> dict:
    return {
        "gdalVersion": "3.13.1",
        "drivers": {name: {"DCAP_OPEN": "YES"} for name in ["EXR", *map(str, range(219))]},
    }


def test_preserves_every_driver_and_capability() -> None:
    expected = full_inventory()
    VERIFY["check_inventory"](expected, copy.deepcopy(expected))
    for mutation in ("remove", "capability", "add", "version"):
        actual = copy.deepcopy(expected)
        if mutation == "remove":
            del actual["drivers"]["EXR"]
        elif mutation == "capability":
            actual["drivers"]["EXR"]["DCAP_OPEN"] = "NO"
        elif mutation == "add":
            actual["drivers"]["unexpected"] = {}
        else:
            actual["gdalVersion"] = "3.13.0"
        with pytest.raises(RuntimeError, match=r"changed|drift"):
            VERIFY["check_inventory"](expected, actual)


def test_rejects_a_narrowed_baseline() -> None:
    baseline = {"gdalVersion": "3.13.1", "drivers": {"EXR": {}}}
    with pytest.raises(RuntimeError, match="not the full"):
        VERIFY["check_inventory"](baseline, baseline)


@pytest.mark.parametrize("directive", ["#define", "#    define"])
def test_reads_actual_upstream_version_headers(tmp_path: Path, directive: str) -> None:
    header = tmp_path / "version.h"
    header.write_text(
        "\n".join(
            [
                f"{directive} OPENEXR_VERSION_MAJOR 3",
                f"{directive} OPENEXR_VERSION_MINOR 4",
                f"{directive} OPENEXR_VERSION_PATCH 15",
                "",
            ]
        )
    )
    assert PACKAGE["header_version"](header, "OPENEXR") == "3.4.15"
    header.write_text(header.read_text() + f"{directive} OPENEXR_VERSION_PATCH 14\n")
    with pytest.raises(RuntimeError, match="version component"):
        PACKAGE["header_version"](header, "OPENEXR")


def test_missing_version_is_not_invented(tmp_path: Path) -> None:
    header = tmp_path / "version.h"
    header.write_text("#define OPENEXR_VERSION_MAJOR 3\n")
    with pytest.raises(RuntimeError, match="version component"):
        PACKAGE["header_version"](header, "OPENEXR")
