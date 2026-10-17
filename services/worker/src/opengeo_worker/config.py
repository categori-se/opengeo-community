import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from opengeo_worker.models import WorkerError

_REGION = re.compile(r"[a-z]{2}(?:-gov)?-[a-z]+-\d")
_BUCKET = re.compile(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?")
_QUEUE_URL = re.compile(
    r"https://sqs\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com/\d{12}/[A-Za-z0-9_-]{1,80}"
)


@dataclass(frozen=True, slots=True)
class Settings:
    aws_region: str
    geodata_bucket: str
    geodata_kms_key_arn: str
    processing_queue_url: str
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str = field(repr=False)
    db_sslrootcert: str
    workspace_root: Path = Path("/tmp/opengeo-worker")
    max_object_bytes: int = 536_870_912
    max_message_bytes: int = 262_144
    max_archive_entries: int = 512
    max_archive_expanded_bytes: int = 2_147_483_648
    max_archive_ratio: int = 200
    command_timeout_seconds: int = 300
    command_output_bytes: int = 1_048_576
    lease_seconds: int = 900
    heartbeat_seconds: int = 60
    visibility_seconds: int = 900
    max_attempts: int = 3
    http_timeout_seconds: int = 30
    statement_timeout_seconds: int = 30
    geodata_expected_owner: str | None = None
    pmtiles_worker_image_digest: str | None = None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        values = environ if environ is not None else os.environ

        def required(name: str) -> str:
            value = values.get(name)
            if value is None or not value.strip() or "\x00" in value:
                raise WorkerError("configuration_missing")
            return value.strip()

        try:
            settings = cls(
                aws_region=required("OPEN_GEO_AWS_REGION"),
                geodata_bucket=required("OPEN_GEO_GEODATA_BUCKET"),
                geodata_kms_key_arn=required("OPEN_GEO_GEODATA_KMS_KEY_ARN"),
                processing_queue_url=required("OPEN_GEO_PROCESSING_QUEUE_URL"),
                db_host=required("OPEN_GEO_DB_HOST"),
                db_port=int(values.get("OPEN_GEO_DB_PORT", "5432")),
                db_name=required("OPEN_GEO_DB_NAME"),
                db_user=required("OPEN_GEO_DB_USER"),
                db_password=required("OPEN_GEO_DB_PASSWORD"),
                db_sslrootcert=required("OPEN_GEO_DB_SSLROOTCERT"),
                workspace_root=Path(values.get("OPEN_GEO_WORKSPACE_ROOT", "/tmp/opengeo-worker")),
                max_object_bytes=int(values.get("OPEN_GEO_MAX_OBJECT_BYTES", "536870912")),
                command_timeout_seconds=int(values.get("OPEN_GEO_COMMAND_TIMEOUT_SECONDS", "300")),
                lease_seconds=int(values.get("OPEN_GEO_LEASE_SECONDS", "900")),
                heartbeat_seconds=int(values.get("OPEN_GEO_HEARTBEAT_SECONDS", "60")),
                visibility_seconds=int(values.get("OPEN_GEO_VISIBILITY_SECONDS", "900")),
                max_attempts=int(values.get("OPEN_GEO_MAX_ATTEMPTS", "3")),
                geodata_expected_owner=values.get("OPEN_GEO_GEODATA_EXPECTED_OWNER"),
                pmtiles_worker_image_digest=values.get("OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST"),
            )
        except ValueError as error:
            raise WorkerError("configuration_invalid") from error
        settings.validate()
        return settings

    def validate(self) -> None:
        if (
            self.pmtiles_worker_image_digest is not None
            and re.fullmatch(r"sha256:[0-9a-f]{64}", self.pmtiles_worker_image_digest) is None
        ):
            raise WorkerError("configuration_invalid")
        if (
            self.geodata_expected_owner is not None
            and re.fullmatch(r"[0-9]{12}", self.geodata_expected_owner) is None
        ):
            raise WorkerError("configuration_invalid")
        if _REGION.fullmatch(self.aws_region) is None:
            raise WorkerError("configuration_invalid")
        if (
            _BUCKET.fullmatch(self.geodata_bucket) is None
            or ".." in self.geodata_bucket
            or ".-" in self.geodata_bucket
            or "-." in self.geodata_bucket
        ):
            raise WorkerError("configuration_invalid")
        queue_match = _QUEUE_URL.fullmatch(self.processing_queue_url)
        if queue_match is None or queue_match.group(1) != self.aws_region:
            raise WorkerError("configuration_invalid")
        kms_pattern = re.compile(
            r"arn:aws(?:-us-gov)?:kms:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:key/[A-Za-z0-9-]+"
        )
        kms_match = kms_pattern.fullmatch(self.geodata_kms_key_arn)
        if kms_match is None or kms_match.group(1) != self.aws_region:
            raise WorkerError("configuration_invalid")
        if not (1 <= self.db_port <= 65535) or len(self.db_host) > 253:
            raise WorkerError("configuration_invalid")
        if self.db_user != "opengeo_worker" or self.db_name != "opengeo":
            raise WorkerError("configuration_invalid")
        if not self.db_sslrootcert.startswith("/") or not Path(self.db_sslrootcert).is_file():
            raise WorkerError("configuration_invalid")
        if not self.workspace_root.is_absolute() or self.workspace_root == Path("/"):
            raise WorkerError("configuration_invalid")
        bounds = (
            1 <= self.max_object_bytes <= 5_368_709_120,
            10 <= self.command_timeout_seconds <= 3600,
            60 <= self.lease_seconds <= 3600,
            15 <= self.heartbeat_seconds < self.lease_seconds,
            60 <= self.visibility_seconds <= 43_200,
            1 <= self.max_attempts <= 10,
        )
        if not all(bounds):
            raise WorkerError("configuration_invalid")

    def database_connection_kwargs(self) -> dict[str, Any]:
        return {
            "host": self.db_host,
            "port": self.db_port,
            "dbname": self.db_name,
            "user": self.db_user,
            "password": self.db_password,
            "connect_timeout": 5,
            "sslmode": "verify-full",
            "sslrootcert": self.db_sslrootcert,
        }
