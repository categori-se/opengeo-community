"""Offline version admission checks; no GDAL process or image is executed."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock, call

import pytest


class FormatsProbeReached(Exception):
    pass


@pytest.fixture
def verifier(monkeypatch):
    source = Path(__file__).resolve().parents[1] / "scripts/verify-pmtiles-toolchain.py"
    spec = importlib.util.spec_from_file_location("pmtiles_toolchain_verifier", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.os, "getuid", lambda: 10001)
    monkeypatch.setenv("PROJ_NETWORK", "OFF")
    return module


@pytest.mark.parametrize(
    "version",
    [
        'GDAL 3.13.1 "Iowa City", released 2026/06/01\n',
        "GDAL 3.13.1, released 2026/06/01\n",
        "GDAL 3.13.1",
    ],
)
def test_pinned_release_banner_reaches_driver_probe(verifier, monkeypatch, version):
    run = Mock(side_effect=[version, FormatsProbeReached])
    monkeypatch.setattr(verifier, "run", run)

    with pytest.raises(FormatsProbeReached):
        verifier.main()

    assert run.call_args_list == [
        call("/usr/bin/ogrinfo", "--version"),
        call("/usr/bin/ogrinfo", "--formats"),
    ]


@pytest.mark.parametrize(
    "version",
    [
        'GDAL 3.13.10 "Iowa City", released 2026/06/01\n',
        'GDAL 3.13.1dev "Iowa City", released 2026/06/01\n',
        "GDAL 3.13.0, released 2026/05/01\n",
    ],
)
def test_other_version_rejected_before_driver_probe(verifier, monkeypatch, version):
    run = Mock(side_effect=[version, FormatsProbeReached])
    monkeypatch.setattr(verifier, "run", run)

    with pytest.raises(RuntimeError, match=r"^PMTiles runtime requires exact GDAL 3\.13\.1$"):
        verifier.main()

    run.assert_called_once_with("/usr/bin/ogrinfo", "--version")
