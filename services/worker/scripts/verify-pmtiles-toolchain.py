"""Offline verification of the isolated GDAL 3.13.1 vector-to-PMTiles runtime."""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


def run(*arguments: str) -> str:
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=60).stdout


def main() -> None:
    if os.getuid() != 10001 or os.environ.get("PROJ_NETWORK") != "OFF":
        raise RuntimeError("PMTiles runtime boundary is not configured")
    if re.match(r"GDAL\s+3\.13\.1(?:[ ,]|$)", run("/usr/bin/ogrinfo", "--version")) is None:
        raise RuntimeError("PMTiles runtime requires exact GDAL 3.13.1")
    formats = run("/usr/bin/ogrinfo", "--formats")
    source_drivers = {
        "geojson": "GeoJSON",
        "geopackage": "GPKG",
        "csv": "CSV",
        "shapefile": "ESRI Shapefile",
        "geoparquet": "Parquet",
    }
    available = {
        name: re.search(r"^\s*" + re.escape(driver) + r"\s+-", formats, re.MULTILINE) is not None
        for name, driver in source_drivers.items()
    }
    for driver in ("GeoJSON", "PMTiles"):
        if re.search(r"^\s*" + re.escape(driver) + r"\s+-", formats, re.MULTILINE) is None:
            raise RuntimeError("PMTiles vector driver is missing: " + driver)
    for forbidden in ("tesseract", "pdftoppm", "pdftotext", "pdfdetach"):
        if Path("/usr/bin", forbidden).exists():
            raise RuntimeError("Document tools do not belong in the PMTiles runtime")
    import psycopg

    if psycopg.__version__ != "3.3.4":
        raise RuntimeError("PMTiles database client version changed")
    with tempfile.TemporaryDirectory(dir="/tmp/opengeo-worker") as directory:
        root = Path(directory)
        source = root / "source.geojson"
        target = root / "output.pmtiles"
        source.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {"name": "Berkshires"},
                            "geometry": {"type": "Point", "coordinates": [-73.2, 42.4]},
                        }
                    ],
                }
            )
        )
        run(
            "/usr/bin/ogr2ogr",
            "-f",
            "PMTiles",
            "-dsco",
            "MINZOOM=0",
            "-dsco",
            "MAXZOOM=2",
            "-nln",
            "source",
            str(target),
            str(source),
        )
        with target.open("rb") as stream:
            if stream.read(8) != b"PMTiles\x03":
                raise RuntimeError("PMTiles writer produced an invalid header")
        document = json.loads(run("/usr/bin/ogrinfo", "-ro", "-so", "-al", "-json", str(target)))
        if not any(layer.get("name") == "source" for layer in document.get("layers", [])):
            raise RuntimeError("PMTiles vector layer did not reopen")
    print(
        json.dumps(
            {
                "status": "passed",
                "gdal": "3.13.1",
                "network": "disabled",
                "uid": os.getuid(),
                "pmtilesRoundtrip": True,
                "inputDriverAvailability": available,
                "inputFormatsRoundtripVerified": ["geojson"],
            }
        )
    )


if __name__ == "__main__":
    main()
