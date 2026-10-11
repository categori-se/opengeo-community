from copy import deepcopy
from uuid import UUID

import pytest

from opengeo_api.resource_knowledge import (
    empty_knowledge,
    validate_knowledge,
    verify_retained_sources_unchanged,
)

DATASET_ID = "aaaaaaaa-1111-4111-8111-111111111111"
PROJECT_ID = "bbbbbbbb-2222-4222-8222-222222222222"
DISCOVERY_JOB_ID = "cccccccc-3333-4333-8333-333333333333"
OTHER_ID = "dddddddd-4444-4444-8444-444444444444"


def knowledge():
    document = empty_knowledge()
    document["distributions"] = [
        {
            "id": "urn:distribution:api",
            "custody": "referenced",
            "accessUrl": "https://example.org/api",
        },
        {"id": "urn:distribution:copy", "custody": "hosted"},
    ]
    document["metadata"]["source"] = [
        {
            "id": "urn:source:original",
            "content": ' { "nested": {"population": 42} }\n',
            "sourceUrl": "https://example.org/metadata",
            "retrievedAt": "2026-09-19T12:00:00Z",
            "mediaType": "application/json",
        }
    ]
    document["metadata"]["normalized"] = [
        {
            "subject": "urn:distribution:api",
            "property": "http://purl.org/dc/terms/license",
            "value": "https://example.org/license",
            "provenance": "source_asserted",
            "evidence": ["urn:source:original"],
        }
    ]
    document["metadata"]["inferred"] = [
        {
            "subject": "resource",
            "property": "http://purl.org/dc/terms/subject",
            "value": {"population": {"unit": "persons", "year": 2025}},
            "provenance": "machine_inferred",
            "confidence": 0.4,
            "method": "field inspection",
        }
    ]
    return document


def test_preserves_source_text_nested_claims_and_distribution_rights():
    document = knowledge()
    result = validate_knowledge(document)
    assert result == document
    assert result is not document
    assert result["metadata"]["source"][0]["content"].endswith("\n")
    assert len(result["metadata"]["normalized"]) == 1  # No invented inheritance.
    assert "license" not in result["distributions"][1]
    assert validate_knowledge(empty_knowledge()) == empty_knowledge()


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d["metadata"]["normalized"][0].update(provenance="machine_inferred"),
        lambda d: d["metadata"]["inferred"][0].update(provenance="source_asserted"),
        lambda d: d["metadata"]["inferred"][0].update(confidence=True),
        lambda d: d["metadata"]["inferred"][0].update(confidence=1.1),
        lambda d: d["metadata"]["inferred"][0].update(confidence=float("nan")),
        lambda d: d["metadata"]["normalized"][0].update(subject="urn:missing:distribution"),
        lambda d: d["metadata"]["normalized"][0].update(subject={}),
        lambda d: d["metadata"]["normalized"][0].update(property="license"),
        lambda d: d["metadata"]["normalized"][0].update(provenance={}),
        lambda d: d["metadata"]["normalized"][0].update(provenance="unknown"),
        lambda d: d["metadata"]["source"][0].update(retrievedAt="2026-09-19"),
        lambda d: d["metadata"]["source"][0].update(content="x" * 49153),
        lambda d: d["distributions"][0].update(custody={}),
        lambda d: d["distributions"][0].update(accessUrl="javascript:alert(1)"),
        lambda d: d["distributions"].append(deepcopy(d["distributions"][0])),
    ],
)
def test_rejects_false_authority_invalid_claims_and_oversize_records(change):
    document = knowledge()
    change(document)
    with pytest.raises(ValueError):
        validate_knowledge(document)


def test_explicit_unknown_is_preserved_and_not_a_permission():
    document = empty_knowledge()
    document["metadata"]["curated"] = [
        {
            "subject": "resource",
            "property": "http://purl.org/dc/terms/accessRights",
            "value": None,
            "provenance": "unknown",
        }
    ]
    assert validate_knowledge(document) == document


def retained_source(**descriptor_changes):
    descriptor = {
        "datasetId": DATASET_ID,
        "projectId": PROJECT_ID,
        "discoveryJobId": DISCOVERY_JOB_ID,
        "sourceRevision": 1,
        "byteLength": 32_769,
        "sha256": "ab" * 32,
        **descriptor_changes,
    }
    return {
        "id": f"urn:opengeo:discovery:{descriptor['discoveryJobId']}:sha256:{descriptor['sha256']}",
        "retainedResponse": descriptor,
        "mediaType": "application/json",
        "sourceUrl": "https://example.org/metadata",
        "retrievedAt": "2026-10-06T12:00:00Z",
    }


def retained_knowledge(**descriptor_changes):
    document = knowledge()
    document["metadata"]["source"].append(retained_source(**descriptor_changes))
    return document


@pytest.mark.parametrize("revision,length", [(1, 32_769), (2_147_483_647, 2_097_152)])
def test_retained_source_preserves_descriptor_and_inline_compatibility(revision, length):
    document = retained_knowledge(sourceRevision=revision, byteLength=length)
    result = validate_knowledge(document)
    assert result == document
    assert result["schemaVersion"] == "1.0.0"
    assert result["metadata"]["source"][0]["content"].endswith("\n")
    assert "content" not in result["metadata"]["source"][1]
    retained = result["metadata"]["source"][1]["retainedResponse"]
    assert retained is not document["metadata"]["source"][1]["retainedResponse"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("datasetId", DATASET_ID.upper()),
        ("datasetId", DATASET_ID.replace("-", "")),
        ("datasetId", None),
        ("projectId", f"{{{PROJECT_ID}}}"),
        ("projectId", False),
        ("discoveryJobId", f"urn:uuid:{DISCOVERY_JOB_ID}"),
        ("discoveryJobId", "not-a-uuid"),
        ("sourceRevision", True),
        ("sourceRevision", 1.0),
        ("sourceRevision", "1"),
        ("sourceRevision", 0),
        ("sourceRevision", 2_147_483_648),
        ("byteLength", True),
        ("byteLength", 32_769.0),
        ("byteLength", "32769"),
        ("byteLength", 32_768),
        ("byteLength", 2_097_153),
        ("sha256", "AB" * 32),
        ("sha256", "a" * 63),
        ("sha256", "g" * 64),
        ("sha256", None),
    ],
)
def test_rejects_noncanonical_or_invalid_retained_descriptor_fields(field, value):
    document = retained_knowledge()
    document["metadata"]["source"][1]["retainedResponse"][field] = value
    with pytest.raises(ValueError):
        validate_knowledge(document)


@pytest.mark.parametrize(
    "change",
    [
        lambda source: source.update(content="also inline"),
        lambda source: source.pop("retainedResponse"),
        lambda source: source["retainedResponse"].pop("projectId"),
        lambda source: source["retainedResponse"].update(bucket="private-storage"),
        lambda source: source.update(id="urn:opengeo:discovery:substituted"),
        lambda source: source.update(sourceUrl="https://secret@example.org/metadata"),
        lambda source: source.update(retrievedAt="2026-10-06"),
    ],
)
def test_rejects_ambiguous_unbound_or_widened_retained_sources(change):
    document = retained_knowledge()
    change(document["metadata"]["source"][1])
    with pytest.raises(ValueError):
        validate_knowledge(document)


def test_retained_sources_keep_the_existing_total_byte_and_source_count_limits():
    document = retained_knowledge()
    document["metadata"]["source"][0]["content"] = "x" * 49_152
    with pytest.raises(ValueError, match="49152 bytes"):
        validate_knowledge(document)
    document = retained_knowledge()
    for index in range(14):
        source = deepcopy(document["metadata"]["source"][0])
        source["id"] = f"urn:source:{index}"
        document["metadata"]["source"].append(source)
    assert len(validate_knowledge(document)["metadata"]["source"]) == 16
    document["metadata"]["source"].append({**source, "id": "urn:source:seventeenth"})
    with pytest.raises(ValueError, match="list is invalid or too long"):
        validate_knowledge(document)


@pytest.mark.parametrize("dataset_id", [DATASET_ID, UUID(DATASET_ID)])
def test_ordinary_save_allows_retained_entries_inline_edits_reordering_and_removal(dataset_id):
    previous = validate_knowledge(retained_knowledge())
    original = deepcopy(previous)
    candidate = deepcopy(previous)
    candidate["metadata"]["source"][0]["content"] += "Ordinary inline edit\n"
    candidate["metadata"]["source"].reverse()
    validated = validate_knowledge(candidate)
    assert verify_retained_sources_unchanged(validated, previous, dataset_id) is None
    without_retained = validate_knowledge(knowledge())
    assert verify_retained_sources_unchanged(without_retained, previous, dataset_id) is None
    assert previous == original


def test_ordinary_save_cannot_forge_a_retained_reference_or_promote_an_inline_source():
    candidate = validate_knowledge(retained_knowledge())
    previous = validate_knowledge(knowledge())
    with pytest.raises(ValueError, match="must remain unchanged"):
        verify_retained_sources_unchanged(candidate, previous, DATASET_ID)
    previous["metadata"]["source"].append(
        {
            key: value
            for key, value in candidate["metadata"]["source"][1].items()
            if key != "retainedResponse"
        }
    )
    previous["metadata"]["source"][1]["content"] = "Unverified inline text"
    with pytest.raises(ValueError, match="must remain unchanged"):
        verify_retained_sources_unchanged(candidate, validate_knowledge(previous), DATASET_ID)


@pytest.mark.parametrize(
    "change",
    [
        lambda source: source.update(mediaType="application/xml"),
        lambda source: source.update(sourceUrl="https://example.org/other"),
        lambda source: source.update(retrievedAt="2026-10-07T12:00:00Z"),
        lambda source: source["retainedResponse"].update(projectId=OTHER_ID),
        lambda source: source["retainedResponse"].update(sourceRevision=2),
        lambda source: source["retainedResponse"].update(byteLength=32_770),
    ],
)
def test_ordinary_save_rejects_changes_to_any_part_of_a_retained_source(change):
    previous = validate_knowledge(retained_knowledge())
    candidate = deepcopy(previous)
    change(candidate["metadata"]["source"][1])
    with pytest.raises(ValueError, match="must remain unchanged"):
        verify_retained_sources_unchanged(validate_knowledge(candidate), previous, DATASET_ID)


def test_ordinary_save_cannot_substitute_inline_text_for_an_existing_retained_entry():
    previous = validate_knowledge(retained_knowledge())
    candidate = deepcopy(previous)
    candidate["metadata"]["source"][1].pop("retainedResponse")
    candidate["metadata"]["source"][1]["content"] = "Substituted text"
    with pytest.raises(ValueError, match="must remain unchanged"):
        verify_retained_sources_unchanged(validate_knowledge(candidate), previous, DATASET_ID)


def test_ordinary_save_rejects_even_unchanged_retained_entries_from_another_dataset():
    previous = validate_knowledge(retained_knowledge(datasetId=OTHER_ID))
    with pytest.raises(ValueError, match="another dataset"):
        verify_retained_sources_unchanged(deepcopy(previous), previous, DATASET_ID)
