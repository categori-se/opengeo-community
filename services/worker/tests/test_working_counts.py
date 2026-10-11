import pytest

from opengeo_worker.models import ValidationFailure
from opengeo_worker.working_counts import working_count_evidence


@pytest.mark.parametrize("before,after", [(0, 0), (4, 4)])
def test_matching_counts_include_empty(before, after):
    result = working_count_evidence(before, {"layers": [{"featureCount": after}]})
    assert result["status"] == "matched" and result["working_count"] == after


@pytest.mark.parametrize("before,after", [(3, 2), (2, 3), (1, 0)])
def test_loss_extra_and_empty_replacement_fail(before, after):
    with pytest.raises(ValidationFailure, match="working_feature_count_mismatch"):
        working_count_evidence(before, {"layers": [{"featureCount": after}]})


@pytest.mark.parametrize("unknown", [None, True, -1, "3"])
def test_unknown_counts_stay_unknown(unknown):
    result = working_count_evidence(unknown, {"layers": [{"featureCount": 3}]})
    assert result["status"] == "unavailable" and result["source_count"] is None
    result = working_count_evidence(3, {"layers": [{"featureCount": unknown}]})
    assert result["status"] == "unavailable" and result["working_count"] is None


@pytest.mark.parametrize("document", [None, {}, {"layers": []}, {"layers": [{}, {}]}])
def test_ambiguous_working_metadata_fails(document):
    with pytest.raises(ValidationFailure, match="working_metadata_invalid"):
        working_count_evidence(3, document)
