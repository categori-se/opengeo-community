"""Server-owned review evidence for processed, staged upload candidates.

Upload bytes have no independent provider count. Unknown completeness must remain
visible even when local inspection succeeded. Acceptance is a separate operation.
"""

import json
from typing import Any

VERSION_EVIDENCE_SQL = """
SELECT jsonb_build_object(
  'versionId', version.id, 'parentVersionId', version.parent_version_id,
  'state', version.state, 'featureCount', version.feature_count,
  'schema', version.schema_definition, 'geometryType', version.geometry_type,
  'crs', version.crs, 'coordinateDimension', version.schema_definition->'coordinate_dimension',
  'original', jsonb_build_object('id', object.id, 'bucket', object.bucket,
    'key', object.object_key, 'storageVersion', object.s3_version_id,
    'sha256', object.checksum_sha256, 'sizeBytes', object.size_bytes)
) || CASE WHEN capture.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
  'capture', jsonb_build_object(
    'jobId', capture.id, 'sourceDatasetId', capture.source_dataset_id,
    'sourceRevision', capture.source_revision_number,
    'stagedBaseVersionId', capture.staged_base_version_id,
    'scope', estimate.capture_scope, 'counts', counts.evidence
  )
) END
FROM app.dataset_versions version
JOIN app.data_objects object
  ON object.organization_id = version.organization_id
 AND object.dataset_id = version.dataset_id AND object.id = version.original_object_id
LEFT JOIN app.external_source_snapshot_jobs capture
  ON capture.organization_id=version.organization_id
 AND capture.destination_dataset_id=version.dataset_id
 AND capture.output_dataset_version_id=version.id
 AND capture.output_object_id=version.original_object_id AND capture.state='completed'
LEFT JOIN app.external_source_copy_estimates estimate
  ON estimate.organization_id=capture.organization_id AND estimate.id=capture.estimate_id
LEFT JOIN app.source_capture_count_evidence counts
  ON counts.organization_id=capture.organization_id AND counts.snapshot_job_id=capture.id
 AND counts.dataset_id=version.dataset_id AND counts.dataset_version_id=version.id
 AND counts.original_object_id=version.original_object_id
WHERE version.organization_id = %s AND version.dataset_id = %s AND version.id = %s
"""


def upload_review_evidence(
    organization_id: str, dataset_id: str, base: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    """Inputs come only from retained server records, never the request payload."""
    reasons = ["source_count_unavailable"]
    dimensions = (base.get("coordinateDimension"), candidate.get("coordinateDimension"))
    if any(type(value) is not int or value not in (2, 3, 4) for value in dimensions):
        reasons.append("coordinate_dimension_unavailable")
    elif dimensions[0] != dimensions[1]:
        reasons.append("coordinate_dimension_changed")
    if candidate["featureCount"] is None:
        reasons.append("fetched_count_unavailable")
    if candidate["featureCount"] == 0 and base["featureCount"] != 0:
        reasons.append("empty_result")
    if base["schema"] != candidate["schema"]:
        reasons.append("schema_changed")
    for key, label in (("geometryType", "geometry_type"), ("crs", "crs")):
        if not base[key] or not candidate[key]:
            reasons.append(f"{label}_unavailable")
        elif base[key] != candidate[key]:
            reasons.append(f"{label}_changed")
    evidence = {
        "schemaVersion": "opengeo.dataset-refresh-review.1.0.0",
        "organizationId": organization_id,
        "datasetId": dataset_id,
        "sourceKind": "staged_upload",
        "sourceRevision": None,
        "expectedFeatureCount": None,
        "countStatus": "unavailable",
        "decision": "review_required",
        "reviewReasons": reasons,
        "base": base,
        "candidate": candidate,
    }
    # Leave room for the database JSONB representation's additional whitespace.
    if len(json.dumps(evidence, ensure_ascii=False).encode()) > 120_000:
        raise ValueError("refresh evidence exceeds retained review limit")
    return evidence


def capture_review_evidence(
    organization_id: str, dataset_id: str, base: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    """Only retained server capture records are accepted as inputs here."""
    capture = candidate.get("capture")
    previous = base.get("capture")
    if (
        not isinstance(capture, dict)
        or not isinstance(previous, dict)
        or capture.get("sourceDatasetId") != previous.get("sourceDatasetId")
        or capture.get("stagedBaseVersionId") != base["versionId"]
    ):
        raise ValueError("capture source or parent binding unavailable")
    evidence = upload_review_evidence(organization_id, dataset_id, base, candidate)
    reasons = evidence["reviewReasons"]
    evidence.update(sourceKind="staged_source_capture", sourceRevision=capture["sourceRevision"])
    # Counts are for the approved query scope, never the whole upstream dataset.
    counts = capture.get("counts")
    expected = None
    if isinstance(counts, dict):
        if counts.get("scope") != capture["scope"]:
            raise ValueError("capture scope binding changed")
        declared = counts.get("numberMatched")
        maximum = capture["scope"].get("maximum_features")
        if type(declared) is int and declared >= 0 and type(maximum) is int and maximum > 0:
            expected = min(declared, maximum)
            reasons.remove("source_count_unavailable")
            evidence["expectedFeatureCount"] = expected
            evidence["countStatus"] = "matched_bounded_scope"
        fetched = counts.get("fetchedCount")
        processed = candidate.get("featureCount")
        if processed is None:
            evidence["countStatus"] = "unavailable"
        if (type(processed) is int and type(fetched) is int and processed != fetched) or (
            expected is not None and fetched != expected
        ):
            evidence["decision"] = "rejected"
            evidence["countStatus"] = "mismatched"
            reasons.append("source_count_mismatch")
        if counts.get("limitedByMaximumFeatures") is True:
            reasons.append("bounded_source_subset")
    else:
        reasons.append("capture_count_evidence_unavailable")
    if previous.get("scope") != capture.get("scope"):
        reasons.append("capture_scope_changed")
    if previous.get("sourceRevision") != capture.get("sourceRevision"):
        reasons.append("source_revision_changed")
    if not reasons:
        evidence["decision"] = "ready"
    if len(json.dumps(evidence, ensure_ascii=False).encode()) > 120_000:
        raise ValueError("refresh evidence exceeds retained review limit")
    return evidence
