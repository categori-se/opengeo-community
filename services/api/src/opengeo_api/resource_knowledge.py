"""Bounded metadata knowledge, without promoting an inference to a source fact.

Properties use vocabulary IRIs (DCAT/DCTERMS/PROV/ODRL or another declared
vocabulary). These records describe claims; they never grant data access.
"""

import json
import math
import re
from copy import deepcopy
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

CUSTODY = {"referenced", "hosted", "cached", "mirrored", "derived", "locally_created"}
PROVENANCE = {
    "source_asserted",
    "curator_asserted",
    "extracted_from_documentation",
    "inherited",
    "machine_inferred",
    "derived",
    "unknown",
}
MAX_KNOWLEDGE_BYTES = 49_152


def empty_knowledge() -> dict[str, Any]:
    return {
        "schemaVersion": "1.0.0",
        "distributions": [],
        "metadata": {"source": [], "normalized": [], "curated": [], "inferred": []},
        "context": [],
    }


def _object(value: Any, allowed: set[str], required: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - allowed or not required <= set(value):
        raise ValueError("Metadata object contains missing or unsupported fields")
    return value


def _text(value: Any, maximum: int = 2048) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        raise ValueError("Metadata text is empty or too long")
    return value


def _uri(value: Any) -> str:
    text = _text(value)
    parsed = urlsplit(text)
    if (
        parsed.scheme not in {"https", "http", "urn"}
        or any(c.isspace() for c in text)
        or parsed.username
        or parsed.password
        or (parsed.scheme in {"https", "http"} and not parsed.hostname)
    ):
        raise ValueError("Metadata identifier must be an absolute HTTP(S) URI or URN")
    return text


def _timestamp(value: Any) -> None:
    if datetime.fromisoformat(_text(value, 100).replace("Z", "+00:00")).tzinfo is None:
        raise ValueError("Metadata timestamps must include a timezone")


def _array(value: Any, maximum: int = 64) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("Metadata list is invalid or too long")
    return value


def _confidence(value: Any) -> None:
    if type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Confidence must be a number between zero and one")


def _canonical_uuid(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Retained response identifiers must be canonical UUID strings")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise ValueError("Retained response identifiers must be canonical UUID strings") from error
    if str(parsed) != value:
        raise ValueError("Retained response identifiers must be canonical UUID strings")
    return value


def _retained_response(value: Any, identifier: str) -> None:
    fields = {
        "datasetId",
        "projectId",
        "discoveryJobId",
        "sourceRevision",
        "byteLength",
        "sha256",
    }
    descriptor = _object(value, fields, fields)
    for field in ("datasetId", "projectId", "discoveryJobId"):
        _canonical_uuid(descriptor[field])
    if type(descriptor["sourceRevision"]) is not int or not (
        1 <= descriptor["sourceRevision"] <= 2_147_483_647
    ):
        raise ValueError("Retained response source revision is invalid")
    if type(descriptor["byteLength"]) is not int or not (
        32_769 <= descriptor["byteLength"] <= 2_097_152
    ):
        raise ValueError("Retained response byte length is invalid")
    checksum = descriptor["sha256"]
    if not isinstance(checksum, str) or re.fullmatch(r"[a-f0-9]{64}", checksum) is None:
        raise ValueError("Retained response checksum is invalid")
    expected = f"urn:opengeo:discovery:{descriptor['discoveryJobId']}:sha256:{checksum}"
    if identifier != expected:
        raise ValueError("Retained response source identity does not match its descriptor")


def validate_knowledge(document: Any) -> dict[str, Any]:
    # Bound both bytes and nesting before recursive serialization/deepcopy.
    stack = [(document, 0)]
    count = 0
    while stack:
        item, depth = stack.pop()
        count += 1
        if depth > 24 or count > 4096:
            raise ValueError("Metadata structure exceeds its bound")
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError("Metadata object keys must be strings")
            stack.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
    raw = json.dumps(document, ensure_ascii=False, allow_nan=False)
    if len(raw.encode("utf-8")) > MAX_KNOWLEDGE_BYTES:
        raise ValueError("Metadata record exceeds 49152 bytes")
    doc = _object(
        document,
        {"schemaVersion", "distributions", "metadata", "context"},
        {"schemaVersion", "distributions", "metadata", "context"},
    )
    if doc["schemaVersion"] != "1.0.0":
        raise ValueError("Unsupported metadata schema version")
    subjects = {"resource"}
    for distribution in _array(doc["distributions"], 32):
        value = _object(
            distribution,
            {"id", "custody", "accessUrl", "downloadUrl", "mediaType", "format", "service"},
            {"id", "custody"},
        )
        identifier = _uri(value["id"])
        if identifier in subjects:
            raise ValueError("Distribution identifiers must be unique")
        subjects.add(identifier)
        if value["custody"] is not None and _text(value["custody"], 50) not in CUSTODY:
            raise ValueError("Unknown distribution custody relationship")
        for field in {"accessUrl", "downloadUrl", "service"} & value.keys():
            _uri(value[field])
        for field in {"mediaType", "format"} & value.keys():
            _text(value[field], 200)
    metadata = _object(
        doc["metadata"],
        {"source", "normalized", "curated", "inferred"},
        {"source", "normalized", "curated", "inferred"},
    )
    sources: set[str] = set()
    for source in _array(metadata["source"], 16):
        value = _object(
            source,
            {"id", "content", "retainedResponse", "mediaType", "sourceUrl", "retrievedAt"},
            {"id", "mediaType", "sourceUrl", "retrievedAt"},
        )
        identifier = _uri(value["id"])
        if identifier in sources:
            raise ValueError("Source document identifiers must be unique")
        sources.add(identifier)
        if ("content" in value) == ("retainedResponse" in value):
            raise ValueError("Source documents require exactly one content representation")
        if "content" in value:
            _text(value["content"], MAX_KNOWLEDGE_BYTES)  # Preserve exact text and whitespace.
        else:
            _retained_response(value["retainedResponse"], identifier)
        _text(value["mediaType"], 200)
        _uri(value["sourceUrl"])
        _timestamp(value["retrievedAt"])
    for level in ("normalized", "curated", "inferred"):
        for assertion in _array(metadata[level]):
            value = _object(
                assertion,
                {
                    "subject",
                    "property",
                    "value",
                    "provenance",
                    "confidence",
                    "evidence",
                    "method",
                    "timestamp",
                    "agent",
                },
                {"subject", "property", "value", "provenance"},
            )
            if _text(value["subject"]) not in subjects:
                raise ValueError("Assertion subject must name this resource or a distribution")
            _uri(value["property"])
            provenance = _text(value["provenance"], 100)
            if provenance not in PROVENANCE:
                raise ValueError("Unknown assertion provenance")
            if level != "inferred" and provenance == "machine_inferred":
                raise ValueError("Machine inferences belong in inferred metadata")
            if level == "inferred" and provenance not in {"machine_inferred", "derived", "unknown"}:
                raise ValueError("Inferred metadata cannot claim source or curator authority")
            if provenance == "unknown" and value["value"] is not None:
                raise ValueError("Unknown assertions must have a null value")
            if "confidence" in value:
                _confidence(value["confidence"])
            for evidence in _array(value.get("evidence", []), 16):
                _uri(evidence)
            if "timestamp" in value:
                _timestamp(value["timestamp"])
            for field in {"method", "agent"} & value.keys():
                _text(value[field], 1000)
    for context in _array(doc["context"]):
        value = _object(
            context,
            {"resourceId", "relationship", "evidence", "confidence"},
            {"resourceId", "relationship", "evidence"},
        )
        _uri(value["resourceId"])
        _uri(value["relationship"])
        for evidence in _array(value["evidence"], 16):
            _uri(evidence)
        if "confidence" in value:
            _confidence(value["confidence"])
    return deepcopy(doc)


def verify_retained_sources_unchanged(
    candidate: dict[str, Any], previous: dict[str, Any], dataset_id: UUID | str
) -> None:
    """Check validated ordinary edits without granting retained-response authority.

    Only the refresh acceptance path may introduce a sealed response reference.
    Ordinary edits may retain complete entries unchanged or remove them, while
    immutable prior knowledge revisions preserve the removed entries.
    """
    expected_dataset_id = _canonical_uuid(str(dataset_id))
    previous_sources = {source["id"]: source for source in previous["metadata"]["source"]}
    for source in candidate["metadata"]["source"]:
        prior = previous_sources.get(source["id"])
        if "retainedResponse" not in source:
            if prior is not None and "retainedResponse" in prior:
                raise ValueError("Retained response sources must remain unchanged")
            continue
        if source["retainedResponse"]["datasetId"] != expected_dataset_id:
            raise ValueError("Retained response belongs to another dataset")
        if source != prior:
            raise ValueError("Retained response sources must remain unchanged")
