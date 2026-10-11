import base64
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.metadata_refresh import append_refresh_source
from opengeo_api.resource_knowledge import empty_knowledge

JOB = UUID("86000000-0000-4000-8000-000000000001")


def source(raw=b' {"license": null}\n'):
    return (
        "arcgis",
        "https://example.org/service/0",
        "0",
        {
            "status": "retained",
            "body_base64": base64.b64encode(raw).decode(),
            "byte_length": len(raw),
            "sha256": sha256(raw).hexdigest(),
            "retrieved_at": "2026-09-23T00:00:00Z",
        },
        2,
    )


def test_refresh_preserves_curation_and_exact_source_text_without_mutating_input():
    before = empty_knowledge()
    before["metadata"]["curated"].append(
        {
            "subject": "resource",
            "property": "http://purl.org/dc/terms/license",
            "value": None,
            "provenance": "unknown",
        }
    )
    result = append_refresh_source(before, source(), JOB)
    assert result["metadata"]["curated"] == before["metadata"]["curated"]
    assert before["metadata"]["source"] == []
    assert result["metadata"]["source"][0]["content"] == ' {"license": null}\n'
    with pytest.raises(ValueError, match="already retained"):
        append_refresh_source(result, source(), JOB)


@pytest.mark.parametrize(
    "field,value",
    [
        ("sha256", "0" * 64),
        ("byte_length", 0),
        ("body_base64", "!"),
        ("status", "not_retained_size"),
    ],
)
def test_refresh_rejects_unverifiable_response(field, value):
    row = source()
    row[3][field] = value
    with pytest.raises(ValueError):
        append_refresh_source(empty_knowledge(), row, JOB)


def test_refresh_rejects_non_utf8_and_oversized_source():
    for raw in [b"\xff", b"x" * 32769]:
        with pytest.raises(ValueError):
            append_refresh_source(empty_knowledge(), source(raw), JOB)


def stored_source():
    row = list(source(b" " * 32_769))
    row[3] = {
        **row[3],
        "status": "retained_object",
        "body_base64": None,
        "object": {"version_id": "immutable-version", "key": "internal-only"},
    }
    return tuple(row)


def test_stored_refresh_keeps_curation_and_appends_compact_verified_reference():
    import copy

    dataset = UUID("80000000-0000-4000-8000-000000000001")
    project = UUID("50000000-0000-4000-8000-000000000001")
    before = append_refresh_source(empty_knowledge(), source(), JOB)
    # Use a different response identity while preserving the earlier inline source.
    job = UUID("86000000-0000-4000-8000-000000000002")
    before["metadata"]["curated"].append(
        {
            "subject": "resource",
            "property": "urn:curation",
            "value": "keep",
            "provenance": "curator_asserted",
        }
    )
    original = copy.deepcopy(before)
    row = stored_source()
    updated = append_refresh_source(
        before,
        row,
        job,
        dataset_id=dataset,
        project_id=project,
        verified_document=copy.deepcopy(row[3]),
    )
    assert before == original
    assert updated["metadata"]["curated"] == before["metadata"]["curated"]
    assert updated["metadata"]["source"][0] == before["metadata"]["source"][0]
    retained = updated["metadata"]["source"][1]
    assert "content" not in retained and "object" not in retained
    assert retained["retainedResponse"] == {
        "datasetId": str(dataset),
        "projectId": str(project),
        "discoveryJobId": str(job),
        "sourceRevision": 2,
        "byteLength": 32_769,
        "sha256": row[3]["sha256"],
    }
    with pytest.raises(ValueError, match="already retained"):
        append_refresh_source(
            updated, row, job, dataset_id=dataset, project_id=project, verified_document=row[3]
        )


def test_stored_refresh_requires_verified_exact_document_and_resource_binding():
    import copy

    row = stored_source()
    dataset = UUID("80000000-0000-4000-8000-000000000001")
    project = UUID("50000000-0000-4000-8000-000000000001")
    for kwargs in [
        {},
        {"dataset_id": dataset, "project_id": project},
        {"dataset_id": dataset, "verified_document": row[3]},
    ]:
        with pytest.raises(ValueError, match="verified Layer"):
            append_refresh_source(empty_knowledge(), row, JOB, **kwargs)
    changed = copy.deepcopy(row[3])
    changed["object"]["version_id"] = "substituted"
    with pytest.raises(ValueError, match="Reviewed response changed"):
        append_refresh_source(
            empty_knowledge(),
            row,
            JOB,
            dataset_id=dataset,
            project_id=project,
            verified_document=changed,
        )
