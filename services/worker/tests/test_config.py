from pathlib import Path

import pytest

from opengeo_worker.config import Settings
from opengeo_worker.models import WorkerError


def environment(cert: Path) -> dict[str, str]:
    return {
        "OPEN_GEO_AWS_REGION": "us-east-1",
        "OPEN_GEO_GEODATA_BUCKET": "opengeo-test-geodata",
        "OPEN_GEO_GEODATA_KMS_KEY_ARN": (
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        "OPEN_GEO_PROCESSING_QUEUE_URL": (
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
        "OPEN_GEO_DB_HOST": "database.internal",
        "OPEN_GEO_DB_NAME": "opengeo",
        "OPEN_GEO_DB_USER": "opengeo_worker",
        "OPEN_GEO_DB_PASSWORD": "secret-value",
        "OPEN_GEO_DB_SSLROOTCERT": str(cert),
    }


def test_accepts_complete_worker_only_configuration(tmp_path: Path) -> None:
    cert = tmp_path / "root.pem"
    cert.write_text("certificate", encoding="utf-8")
    settings = Settings.from_env(environment(cert))

    assert settings.db_user == "opengeo_worker"
    assert settings.database_connection_kwargs()["sslmode"] == "verify-full"
    assert "secret-value" not in repr(settings)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OPEN_GEO_DB_USER", "opengeo_runtime"),
        ("OPEN_GEO_AWS_REGION", "invalid"),
        ("OPEN_GEO_PROCESSING_QUEUE_URL", "https://example.test/queue"),
        ("OPEN_GEO_MAX_ATTEMPTS", "11"),
        ("OPEN_GEO_GEODATA_EXPECTED_OWNER", "11111111111"),
        ("OPEN_GEO_GEODATA_EXPECTED_OWNER", ""),
        ("OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST", "latest"),
    ],
)
def test_rejects_cross_service_or_unbounded_configuration(
    tmp_path: Path, name: str, value: str
) -> None:
    cert = tmp_path / "root.pem"
    cert.write_text("certificate", encoding="utf-8")
    values = environment(cert)
    values[name] = value
    with pytest.raises(WorkerError, match="configuration_invalid"):
        Settings.from_env(values)


def test_expected_bucket_owner_is_explicit_and_not_inferred_from_kms(tmp_path: Path) -> None:
    cert = tmp_path / "root.pem"
    cert.write_text("certificate", encoding="utf-8")
    values = environment(cert)
    assert Settings.from_env(values).geodata_expected_owner is None
    values["OPEN_GEO_GEODATA_EXPECTED_OWNER"] = "222222222222"
    assert Settings.from_env(values).geodata_expected_owner == "222222222222"
