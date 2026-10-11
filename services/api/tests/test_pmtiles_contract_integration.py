import hashlib
import json
import sys
from pathlib import Path
from uuid import UUID

from opengeo_api.data_preservation import (
    PMTILES_DERIVATIVE_RECIPE,
    PMTILES_DERIVATIVE_REQUEST_SCHEMA,
    PmtilesDerivativeRequest,
    pmtiles_derivative_request_canonical_bytes,
    pmtiles_derivative_request_checksum,
)

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "schemas" / "pmtiles-derivative-request-checksum-1.0.0.vectors.json"
JOB_ID = UUID("b9000000-0000-4000-8000-000000000001")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000001")
IDEMPOTENCY_KEY = UUID("84000000-0000-4000-8000-000000000258")


def test_api_and_worker_share_the_versioned_pmtiles_checksum_vectors() -> None:
    worker_source = str(ROOT / "services" / "worker" / "src")
    sys.path.insert(0, worker_source)
    try:
        from opengeo_worker.models import ObjectReference, PmtilesDerivativeClaim
        from opengeo_worker.pmtiles_derivatives import (
            PMTILES_DERIVATIVE_RECIPE as WORKER_RECIPE,
        )
        from opengeo_worker.pmtiles_derivatives import (
            PMTILES_DERIVATIVE_REQUEST_SCHEMA as WORKER_SCHEMA,
        )
        from opengeo_worker.pmtiles_derivatives import (
            pmtiles_derivative_request_canonical_bytes as worker_canonical_bytes,
        )
        from opengeo_worker.pmtiles_derivatives import (
            pmtiles_derivative_request_checksum as worker_checksum,
        )
    finally:
        sys.path.remove(worker_source)

    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    contract = vectors["contract"]
    assert contract["requestSchema"] == PMTILES_DERIVATIVE_REQUEST_SCHEMA == WORKER_SCHEMA
    assert contract["recipe"] == PMTILES_DERIVATIVE_RECIPE == WORKER_RECIPE

    for vector in vectors["cases"]:
        project_id = UUID(vector["projectId"])
        dataset_id = UUID(vector["datasetId"])
        dataset_version_id = UUID(vector["datasetVersionId"])
        source_object_id = UUID(vector["sourceObjectId"])
        bounds = tuple(vector["bounds"])
        request = PmtilesDerivativeRequest(
            bounds=bounds,
            minimum_zoom=vector["minimumZoom"],
            maximum_zoom=vector["maximumZoom"],
            source_layer=vector["sourceLayer"],
            idempotency_key=IDEMPOTENCY_KEY,
        )
        claim = PmtilesDerivativeClaim(
            status="claimed",
            job_id=JOB_ID,
            organization_id=ORGANIZATION_ID,
            project_id=project_id,
            dataset_id=dataset_id,
            dataset_version_id=dataset_version_id,
            source=ObjectReference(
                source_object_id,
                "opengeo-test-geodata",
                "sealed/source.parquet",
                "version-1",
                "0123456789abcdef",
                "application/vnd.apache.parquet",
                4096,
                "1" * 64,
            ),
            bounds=bounds,
            minimum_zoom=vector["minimumZoom"],
            maximum_zoom=vector["maximumZoom"],
            source_layer=vector["sourceLayer"],
            request_checksum_sha256="0" * 64,
            attempt_count=1,
            output_object_key="sealed/output.pmtiles",
        )

        api_bytes = pmtiles_derivative_request_canonical_bytes(
            project_id=project_id,
            dataset_id=dataset_id,
            dataset_version_id=dataset_version_id,
            source_object_id=source_object_id,
            request=request,
        )
        worker_bytes = worker_canonical_bytes(claim)
        expected_bytes = vector["expectedCanonicalJson"].encode("utf-8")
        expected_checksum = vector["expectedSha256"]

        assert api_bytes == worker_bytes == expected_bytes, vector["name"]
        assert hashlib.sha256(expected_bytes).hexdigest() == expected_checksum
        assert (
            pmtiles_derivative_request_checksum(
                project_id=project_id,
                dataset_id=dataset_id,
                dataset_version_id=dataset_version_id,
                source_object_id=source_object_id,
                request=request,
            )
            == worker_checksum(claim)
            == expected_checksum
        ), vector["name"]
