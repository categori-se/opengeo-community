"""Execute the declared OpenGeo GIS format matrix through the production inspector.

This is a local evidence runner. It creates only synthetic, public fixtures inside
the caller-supplied output directory and performs no network access.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any

from opengeo_worker.config import Settings
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.malware import MalwareScanEvidence
from opengeo_worker.models import ArtifactFile, DatasetFormat, InspectionResult

VECTOR_CASES: tuple[tuple[DatasetFormat, str, str], ...] = (
    ("geojson", "GeoJSON", "OGC:CRS84"),
    ("csv", "CSV", "none"),
    ("shapefile", "ESRI Shapefile", "EPSG:26986"),
    ("geopackage", "GPKG", "EPSG:3857"),
    ("geoparquet", "Parquet", "EPSG:32619"),
    ("pmtiles", "PMTiles", "OGC:CRS84"),
)
RASTER_CASES: tuple[DatasetFormat, ...] = ("cog", "png", "jpeg")
EXPECTED_COORDINATES = (
    (-71.12, 42.34),
    (-71.08, 42.38),
    (-71.02, 42.36),
    (-71.11, 42.35),
    (-71.04, 42.41),
)


class EvidenceScanner:
    """Keep this peer about formats; malware execution has a separate evidence packet."""

    def scan(self, source: Path, workdir: Path) -> MalwareScanEvidence:
        if source.parent.resolve() != workdir.resolve():
            raise ValueError("format-matrix source escaped its work directory")
        return MalwareScanEvidence("separate-evidence-not-executed", 0)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vector", type=Path, required=True)
    parser.add_argument("--raster", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args()


def run(*command: str, cwd: Path) -> str:
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(cwd),
        "TMPDIR": str(cwd),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "OMP_THREAD_LIMIT": "1",
        "PROJ_NETWORK": "OFF",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": "",
        "CPL_CURL_ENABLE_VSIMEM": "NO",
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "OGR_SQLITE_PRAGMA": "trusted_schema=OFF",
    }
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return (completed.stdout + completed.stderr).strip()


def settings(root: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="opengeo-format-matrix",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        processing_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-format-matrix"
        ),
        db_host="database.invalid",
        db_port=5432,
        db_name="opengeo",
        db_user="opengeo_worker",
        db_password="not-used-by-format-matrix",
        db_sslrootcert="/etc/ssl/certs/aws-rds-global-bundle.pem",
        workspace_root=root,
        command_timeout_seconds=60,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def relative_artifact(artifact: ArtifactFile, root: Path) -> dict[str, Any]:
    return {
        "role": artifact.role,
        "relativeKey": artifact.relative_key,
        "contentType": artifact.content_type,
        "bytes": artifact.path.stat().st_size,
        "sha256": sha256(artifact.path),
        "path": str(artifact.path.relative_to(root)),
    }


def flatten_coordinates(value: Any) -> list[tuple[float, float]]:
    if (
        isinstance(value, list)
        and len(value) >= 2
        and all(isinstance(component, (int, float)) for component in value[:2])
    ):
        return [(float(value[0]), float(value[1]))]
    if not isinstance(value, list):
        return []
    points: list[tuple[float, float]] = []
    for child in value:
        points.extend(flatten_coordinates(child))
    return points


def preview_facts(result: InspectionResult) -> dict[str, Any] | None:
    preview = next(
        (
            artifact
            for artifact in result.artifacts
            if artifact.relative_key == "preview/preview.geojson"
        ),
        None,
    )
    if preview is None:
        return None
    document = json.loads(preview.path.read_text(encoding="utf-8"))
    features = document.get("features", [])
    points = [
        point
        for feature in features
        for point in flatten_coordinates(feature.get("geometry", {}).get("coordinates"))
    ]
    maximum_error = max(
        (
            max(abs(actual[0] - expected[0]), abs(actual[1] - expected[1]))
            for actual, expected in zip(points, EXPECTED_COORDINATES, strict=True)
        ),
        default=0.0,
    )
    return {
        "featureCount": len(features),
        "properties": [feature.get("properties", {}) for feature in features],
        "coordinateCount": len(points),
        "maximumCrs84RoundTripErrorDegrees": maximum_error,
    }


def vector_mapfile(
    workdir: Path,
    connection: str,
    layer_name: str,
    source_crs: str,
) -> str:
    path = workdir / "mapserver.map"
    path.write_text(
        f'''MAP
  NAME "opengeo-format-matrix"
  STATUS ON
  EXTENT -7928000 5206000 -7896000 5230000
  SIZE 320 240
  UNITS METERS
  IMAGETYPE "png"
  IMAGECOLOR 255 255 255
  PROJECTION
    "init=epsg:3857"
  END
  OUTPUTFORMAT
    NAME "png"
    DRIVER "AGG/PNG"
    MIMETYPE "image/png"
    IMAGEMODE RGB
    EXTENSION "png"
  END
  LAYER
    NAME "roads"
    TYPE LINE
    STATUS DEFAULT
    CONNECTIONTYPE OGR
    CONNECTION "{connection}"
    DATA "{layer_name}"
    CLASSITEM "status"
    PROJECTION
      "init={source_crs.lower()}"
    END
    CLASS
      EXPRESSION "open"
      STYLE
        COLOR 22 129 95
        WIDTH 3
      END
    END
    CLASS
      EXPRESSION "closed"
      STYLE
        COLOR 180 35 24
        WIDTH 3
      END
    END
  END
END
''',
        encoding="utf-8",
    )
    return str(path.relative_to(workdir.parent))


def raster_mapfile(workdir: Path, source: Path) -> str:
    path = workdir / "mapserver.map"
    path.write_text(
        f"""MAP
  NAME "opengeo-raster-format-matrix"
  STATUS ON
  EXTENT -7928000 5160000 -7890000 5260000
  SIZE 320 240
  UNITS METERS
  IMAGETYPE "png"
  IMAGECOLOR 255 255 255
  PROJECTION
    "init=epsg:3857"
  END
  OUTPUTFORMAT
    NAME "png"
    DRIVER "AGG/PNG"
    MIMETYPE "image/png"
    IMAGEMODE RGB
    EXTENSION "png"
  END
  LAYER
    NAME "raster"
    TYPE RASTER
    STATUS DEFAULT
    DATA "/evidence/{source.relative_to(workdir.parent)}"
    PROJECTION
      "init=epsg:4326"
    END
  END
END
""",
        encoding="utf-8",
    )
    return str(path.relative_to(workdir.parent))


def fixed_zip(source_directory: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source_directory.iterdir(), key=lambda item: item.name):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def create_vector_source(
    dataset_format: DatasetFormat,
    source_crs: str,
    canonical: Path,
    workdir: Path,
) -> Path:
    if dataset_format == "geojson":
        target = workdir / "source.geojson"
        shutil.copyfile(canonical, target)
        return target
    if dataset_format == "csv":
        target = workdir / "source.csv"
        run(
            "ogr2ogr",
            "-f",
            "CSV",
            str(target),
            str(canonical),
            "-select",
            "name,status",
            cwd=workdir,
        )
        return target
    if dataset_format == "shapefile":
        unpacked = workdir / "shape"
        unpacked.mkdir()
        run(
            "ogr2ogr",
            "-f",
            "ESRI Shapefile",
            str(unpacked),
            str(canonical),
            "-t_srs",
            source_crs,
            "-nln",
            "roads",
            cwd=workdir,
        )
        target = workdir / "source.zip"
        fixed_zip(unpacked, target)
        shutil.rmtree(unpacked)
        return target
    driver, suffix = {
        "geopackage": ("GPKG", ".gpkg"),
        "geoparquet": ("Parquet", ".parquet"),
        "pmtiles": ("PMTiles", ".pmtiles"),
    }[dataset_format]
    target = workdir / f"source{suffix}"
    command = ["ogr2ogr", "-f", driver, str(target), str(canonical), "-nln", "roads"]
    if source_crs != "OGC:CRS84":
        command.extend(["-t_srs", source_crs])
    run(*command, cwd=workdir)
    return target


def inspect_vector_cases(inspector: DatasetInspector, canonical: Path, root: Path) -> list[dict]:
    cases: list[dict] = []
    for dataset_format, expected_driver, source_crs in VECTOR_CASES:
        workdir = root / f"vector-{dataset_format}"
        workdir.mkdir()
        source = create_vector_source(dataset_format, source_crs, canonical, workdir)
        result = inspector.inspect(source, dataset_format, workdir)
        preview = preview_facts(result)
        layers = result.schema_definition.get("layers", [])
        layer_name = layers[0].get("name") if layers else None
        mapfile = None
        if dataset_format != "csv" and isinstance(layer_name, str):
            connection = f"/evidence/{source.relative_to(root)}"
            if dataset_format == "shapefile":
                connection = f"/vsizip/{connection}/roads.shp"
            map_crs = {
                "pmtiles": "EPSG:3857",
                "geojson": "EPSG:4326",
            }.get(dataset_format, source_crs)
            mapfile = vector_mapfile(workdir, connection, layer_name, map_crs)
        cases.append(
            {
                "format": dataset_format,
                "expectedDriver": expected_driver,
                "sourceCrs": source_crs,
                "sourceBytes": source.stat().st_size,
                "sourceSha256": sha256(source),
                "featureCount": result.feature_count,
                "geometryType": result.geometry_type,
                "reportedCrs": result.crs,
                "extent": result.extent,
                "schema": result.schema_definition,
                "preview": preview,
                "mapserverMapfile": mapfile,
                "artifacts": [relative_artifact(artifact, root) for artifact in result.artifacts],
                "quality": result.quality_results,
            }
        )
    return cases


def create_mapserver_only_cases(canonical: Path, root: Path) -> list[dict]:
    workdir = root / "mapserver-flatgeobuf"
    workdir.mkdir()
    source = workdir / "source.fgb"
    run(
        "ogr2ogr",
        "-f",
        "FlatGeobuf",
        str(source),
        str(canonical),
        "-nln",
        "roads",
        cwd=workdir,
    )
    return [
        {
            "format": "flatgeobuf",
            "sourceCrs": "OGC:CRS84",
            "sourceBytes": source.stat().st_size,
            "sourceSha256": sha256(source),
            "openGeoManagedInput": False,
            "declaredDifference": (
                "MapServer advertises INPUT=FLATGEOBUF, while OpenGeo does not yet accept "
                "FlatGeobuf as a managed upload format."
            ),
            "mapserverMapfile": vector_mapfile(
                workdir,
                "/evidence/mapserver-flatgeobuf/source.fgb",
                "roads",
                "EPSG:4326",
            ),
        }
    ]


def create_raster_seed(source: Path, workdir: Path) -> Path:
    seed = workdir / "seed.tif"
    run(
        "gdal_translate",
        "-of",
        "GTiff",
        "-a_srs",
        "OGC:CRS84",
        "-a_ullr",
        "-71.2",
        "42.5",
        "-70.9",
        "42.2",
        str(source),
        str(seed),
        cwd=workdir,
    )
    return seed


def inspect_raster_cases(inspector: DatasetInspector, raster: Path, root: Path) -> list[dict]:
    cases: list[dict] = []
    for dataset_format in RASTER_CASES:
        workdir = root / f"raster-{dataset_format}"
        workdir.mkdir()
        seed = create_raster_seed(raster, workdir)
        if dataset_format == "cog":
            source = workdir / "source.tif"
            run(
                "gdal_translate",
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
                str(seed),
                str(source),
                cwd=workdir,
            )
        elif dataset_format == "png":
            source = workdir / "source.png"
            run("gdal_translate", "-of", "PNG", str(seed), str(source), cwd=workdir)
        else:
            source = workdir / "source.jpg"
            run(
                "gdal_translate",
                "-of",
                "JPEG",
                "-co",
                "QUALITY=90",
                str(seed),
                str(source),
                cwd=workdir,
            )
        result = inspector.inspect(source, dataset_format, workdir)
        cases.append(
            {
                "format": dataset_format,
                "sourceBytes": source.stat().st_size,
                "sourceSha256": sha256(source),
                "reportedCrs": result.crs,
                "extent": result.extent,
                "geometryType": result.geometry_type,
                "schema": result.schema_definition,
                "mapserverMapfile": raster_mapfile(workdir, source),
                "artifacts": [relative_artifact(artifact, root) for artifact in result.artifacts],
                "quality": result.quality_results,
            }
        )
    return cases


def main() -> None:
    options = arguments()
    vector = options.vector.resolve(strict=True)
    raster = options.raster.resolve(strict=True)
    output = options.output_directory.resolve()
    if output == Path("/") or options.report.resolve().parent != output:
        raise ValueError("format-matrix output boundary is invalid")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("format-matrix output directory must be empty")
    inspector = DatasetInspector(settings(output), scanner=EvidenceScanner())
    vector_cases = inspect_vector_cases(inspector, vector, output)
    mapserver_only_cases = create_mapserver_only_cases(vector, output)
    raster_cases = inspect_raster_cases(inspector, raster, output)
    report = {
        "schemaVersion": "opengeo.format-matrix-execution.1.0.0",
        "gdalVersion": run("gdalinfo", "--version", cwd=output),
        "productionInspectorUsed": True,
        "productionCommandBoundaryUsed": True,
        "malwareScannerExecuted": False,
        "projNetwork": False,
        "networkRequests": 0,
        "vectorCases": vector_cases,
        "mapserverOnlyCases": mapserver_only_cases,
        "rasterCases": raster_cases,
    }
    temporary = output / "report.tmp"
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, options.report)


if __name__ == "__main__":
    main()
