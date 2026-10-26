import importlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from opengeo_worker.config import Settings
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.malware import parse_clamav_version

TOOL_ENVIRONMENT = {**os.environ, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC"}

PYTHON_MODULES = (
    "duckdb",
    "geopandas",
    "psycopg",
    "pyarrow",
    "rasterio",
    "rio_cogeo",
    "shapely",
)
BINARIES = (
    "clamscan",
    "gdalinfo",
    "gdalsrsinfo",
    "gdal_translate",
    "gdalwarp",
    "ogr2ogr",
    "ogrinfo",
    "pdfdetach",
    "pdfinfo",
    "pdftoppm",
    "pdftotext",
    "prlimit",
    "tesseract",
    "tippecanoe",
)
VECTOR_DRIVERS = ("CSV", "ESRI Shapefile", "GeoJSON", "GPKG", "Parquet", "PMTiles")


def minimal_pdf() -> bytes:
    objects = (
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
    )
    content = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(content))
        content.extend(f"{index} 0 obj\n".encode())
        content.extend(body)
        content.extend(b"\nendobj\n")
    xref = len(content)
    content.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    content.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        content.extend(f"{offset:010d} 00000 n \n".encode())
    content.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(content)


def worker_settings(workspace: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="opengeo-verifier-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        processing_queue_url=("https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-verifier"),
        db_host="database.internal",
        db_port=5432,
        db_name="opengeo",
        db_user="opengeo_worker",
        db_password="not-used-by-toolchain-verifier",
        db_sslrootcert="/etc/ssl/certs/aws-rds-global-bundle.pem",
        workspace_root=workspace,
        command_timeout_seconds=30,
    )


def output(command: list[str]) -> str:
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        env=TOOL_ENVIRONMENT,
        timeout=30,
    )
    return completed.stdout + completed.stderr


def main() -> None:
    output(
        [
            "python3",
            "/opt/opengeo-gdal/verify-gdal-runtime.py",
            "verify",
            "/opt/opengeo-gdal/driver-baseline.json",
            "--scratch-root",
            "/tmp/opengeo-worker",
        ]
    )
    for module in PYTHON_MODULES:
        importlib.import_module(module)
    for binary in BINARIES:
        if shutil.which(binary) is None:
            raise RuntimeError(f"missing required GIS binary: {binary}")
    vector_formats = output(["ogrinfo", "--formats"])
    for driver in VECTOR_DRIVERS:
        if driver not in vector_formats:
            raise RuntimeError(f"missing required OGR driver: {driver}")
    raster_formats = output(["gdalinfo", "--formats"])
    for driver in ("COG", "GTiff", "JPEG", "PNG"):
        if driver not in raster_formats:
            raise RuntimeError(f"missing required raster driver: {driver}")
    output(["tippecanoe", "--version"])
    tesseract_version = output(["tesseract", "--version"])
    if re.match(r"tesseract 5\.[0-9]+\.[0-9]+", tesseract_version) is None:
        raise RuntimeError("Tesseract 5 runtime is unavailable")
    ocr_models = set(output(["tesseract", "--list-langs"]).splitlines())
    for model in (
        "eng",
        "Arabic",
        "Bengali",
        "Cyrillic",
        "Devanagari",
        "Ethiopic",
        "Greek",
        "Hangul",
        "HanS",
        "HanT",
        "Hebrew",
        "Japanese",
        "Latin",
        "Thai",
    ):
        if model not in ocr_models:
            raise RuntimeError(f"missing required OCR model: {model}")
    clamav_version = output(["clamscan", "--version"])
    parse_clamav_version(clamav_version)
    with tempfile.TemporaryDirectory(dir="/tmp/opengeo-worker") as directory:
        eicar = Path(directory) / "eicar.txt"
        eicar.write_bytes(b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")
        scan = subprocess.run(
            [
                "clamscan",
                "--database=/var/lib/clamav",
                "--no-summary",
                "--infected",
                str(eicar),
            ],
            check=False,
            capture_output=True,
            env=TOOL_ENVIRONMENT,
            timeout=30,
        )
        if scan.returncode != 1:
            raise RuntimeError("ClamAV failed its blocked-signature control")
        document = Path(directory) / "source.pdf"
        document.write_bytes(minimal_pdf())
        inspection = DatasetInspector(worker_settings(Path(directory))).inspect(
            document, "pdf", Path(directory)
        )
        metadata = inspection.schema_definition.get("document")
        if (
            not isinstance(metadata, dict)
            or metadata.get("page_count") != 1
            or inspection.quality_results.get("safety_scan", {}).get("comprehensive_malware_scan")
            is not True
            or metadata.get("accessible_preview_schema") != "opengeo.document-preview.3.0.0"
            or metadata.get("text_extraction") != "poppler_pdftotext_tesseract"
            or metadata.get("ocr_performed") is not True
            or len(inspection.artifacts) != 4
            or any(
                artifact.content_type not in {"image/png", "application/json"}
                or not artifact.path.is_file()
                for artifact in inspection.artifacts
            )
        ):
            raise RuntimeError("isolated scanned PDF preview contract failed")


if __name__ == "__main__":
    main()
