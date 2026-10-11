"""Compare input inspection with independently reopened working-file metadata."""

from typing import Any

from opengeo_worker.models import ValidationFailure


def working_count_evidence(source_count: object, document: object) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValidationFailure("working_metadata_invalid")
    layers = document.get("layers")
    if not isinstance(layers, list) or len(layers) != 1 or not isinstance(layers[0], dict):
        raise ValidationFailure("working_metadata_invalid")

    def count(value: object) -> int | None:
        return value if type(value) is int and value >= 0 else None

    before = count(source_count)
    after = count(layers[0].get("featureCount"))
    if before is not None and after is not None and before != after:
        raise ValidationFailure("working_feature_count_mismatch")
    return {
        "source_count": before,
        "working_count": after,
        "status": "matched" if before is not None and after is not None else "unavailable",
        "basis": "independent ogrinfo working-file inspection",
    }
