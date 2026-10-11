from copy import deepcopy

import pytest

from opengeo_api.dataset_refresh_review import upload_review_evidence


def version(**changes):
    return {
        "versionId": "version",
        "featureCount": 5,
        "schema": {"layers": [{"fields": [{"name": "value", "type": "Real"}]}]},
        "geometryType": "Point",
        "crs": "EPSG:4326",
        "original": {"sha256": "a" * 64, "storageVersion": "exact-v1"},
        **changes,
    }


def test_processed_counts_do_not_claim_source_completeness():
    base = version()
    candidate = version(versionId="candidate")
    before = deepcopy((base, candidate))
    result = upload_review_evidence("org", "layer", base, candidate)
    assert result["decision"] == "review_required"
    assert result["expectedFeatureCount"] is None
    assert result["countStatus"] == "unavailable"
    assert result["reviewReasons"] == [
        "source_count_unavailable",
        "coordinate_dimension_unavailable",
    ]
    assert result["candidate"]["original"]["storageVersion"] == "exact-v1"
    assert (base, candidate) == before


def test_empty_schema_and_spatial_changes_require_review():
    result = upload_review_evidence(
        "org",
        "layer",
        version(),
        version(featureCount=0, schema={"layers": []}, geometryType="Polygon", crs=None),
    )
    assert {"empty_result", "schema_changed", "geometry_type_changed", "crs_unavailable"} <= set(
        result["reviewReasons"]
    )
    unknown = upload_review_evidence("org", "layer", version(), version(featureCount=None))
    assert "fetched_count_unavailable" in unknown["reviewReasons"]
    assert "empty_result" not in unknown["reviewReasons"]


def test_oversized_retained_schema_fails_before_database_insert():
    with pytest.raises(ValueError, match="limit"):
        upload_review_evidence("org", "layer", version(), version(schema={"large": "x" * 120_000}))


def test_declared_dimension_change_is_reviewed_and_missing_history_stays_unknown():
    base = version(coordinateDimension=3)
    candidate = version(coordinateDimension=2)
    result = upload_review_evidence("org", "layer", base, candidate)
    assert "coordinate_dimension_changed" in result["reviewReasons"]
    assert "coordinate_dimension_unavailable" not in result["reviewReasons"]
    for unknown in (None, True, "3", 0):
        result = upload_review_evidence(
            "org", "layer", version(coordinateDimension=unknown), candidate
        )
        assert "coordinate_dimension_unavailable" in result["reviewReasons"]


def captured_versions(*, processed=3, matched=3, limit=10):
    base = version(versionId="base", coordinateDimension=2)
    capture = {
        "jobId": "old-job",
        "sourceDatasetId": "upstream",
        "sourceRevision": 1,
        "scope": {"maximum_features": limit},
        "counts": None,
    }
    base["capture"] = capture
    candidate = version(versionId="candidate", featureCount=processed, coordinateDimension=2)
    candidate["capture"] = {
        **deepcopy(capture),
        "jobId": "new-job",
        "stagedBaseVersionId": "base",
        "counts": {
            "numberMatched": matched,
            "fetchedCount": min(matched, limit) if matched is not None else 3,
            "scope": {"maximum_features": limit},
            "limitedByMaximumFeatures": matched is not None and matched > limit,
        },
    }
    return base, candidate


def test_capture_counts_reject_processed_loss_and_keep_scope_limits_visible():
    from opengeo_api.dataset_refresh_review import capture_review_evidence

    base, candidate = captured_versions(processed=2)
    evidence = capture_review_evidence("org", "layer", base, candidate)
    assert evidence["decision"] == "rejected"
    assert evidence["countStatus"] == "mismatched"
    base, candidate = captured_versions(processed=3, matched=100, limit=3)
    evidence = capture_review_evidence("org", "layer", base, candidate)
    assert evidence["expectedFeatureCount"] == 3
    assert "bounded_source_subset" in evidence["reviewReasons"]
    assert evidence["decision"] == "review_required"


def test_capture_unknown_counts_and_changed_scope_require_review():
    from opengeo_api.dataset_refresh_review import capture_review_evidence

    base, candidate = captured_versions(matched=None)
    base["capture"]["scope"] = {"maximum_features": 1}
    evidence = capture_review_evidence("org", "layer", base, candidate)
    assert {"source_count_unavailable", "capture_scope_changed"} <= set(evidence["reviewReasons"])
    candidate["capture"]["counts"] = None
    assert (
        "capture_count_evidence_unavailable"
        in capture_review_evidence("org", "layer", base, candidate)["reviewReasons"]
    )
    candidate["capture"]["sourceDatasetId"] = "unrelated"
    with pytest.raises(ValueError, match="binding"):
        capture_review_evidence("org", "layer", base, candidate)
