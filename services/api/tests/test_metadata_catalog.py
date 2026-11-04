import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError

from opengeo_api.metadata_catalog import CatalogMetadataInvalid, validate_catalog_metadata
from opengeo_api.metadata_profiles import validate_metadata_document
from opengeo_api.resource_routes import ResourceMetadataRequest

ROOT = Path(__file__).parents[3]


def acquisition_context() -> dict[str, Any]:
    return json.loads(
        (ROOT / "parity/fixtures/data/metadata-014-opengeo-acquisition-context.json").read_text()
    )


def native_catalog() -> dict[str, Any]:
    return {
        "schemaVersion": "1.0.0",
        "contacts": [
            {
                "name": "Ada Researcher",
                "organization": "Open Research Lab",
                "email": "ada@example.test",
                "role": "creator",
                "identifier": "https://orcid.org/0000-0001-2345-6789",
            }
        ],
        "distributions": [
            {
                "identifier": "roads-geojson",
                "title": "Roads GeoJSON",
                "downloadUrl": "https://data.example.test/roads.geojson",
                "mediaType": "application/geo+json",
                "byteSize": 4096,
                "checksumSha256": "a" * 64,
                "license": "CC-BY-4.0",
            }
        ],
        "referenceSystems": [
            {
                "identifier": "EPSG:4326",
                "uri": "http://www.opengis.net/def/crs/EPSG/0/4326",
            }
        ],
        "lineage": {
            "statement": "Field observations were checked before publication.",
            "sources": ["urn:uuid:10000000-0000-4000-8000-000000000001"],
        },
        "quality": [
            {
                "measure": "completeness",
                "result": 0.98,
                "unit": "ratio",
                "description": "Sampled against imagery.",
            }
        ],
        "updateFrequency": "annual",
        "sensitivity": "public",
    }


def test_native_catalog_contract_accepts_bounded_interoperable_fields() -> None:
    value = native_catalog()

    assert validate_catalog_metadata(value) == value
    request = ResourceMetadataRequest(title="Roads", extensions={"opengeo": value})
    assert request.extensions["opengeo"]["referenceSystems"][0]["identifier"] == "EPSG:4326"
    report = validate_metadata_document(
        {"title": "Roads", "extensions": {"opengeo": value}, "translations": {}},
        {},
    )
    assert report["warnings"] == 0


def test_native_catalog_11_adds_bounded_funding_and_relational_acquisition() -> None:
    value = native_catalog()
    value.update(
        {
            "schemaVersion": "1.1.0",
            "funding": [
                {
                    "funderName": "Open Research Foundation",
                    "funderIdentifier": "https://ror.org/012345678",
                    "funderIdentifierType": "ROR",
                    "schemeUri": "https://ror.org",
                    "awardNumber": "ORF-2026-0042",
                    "awardUri": "https://awards.example.test/ORF-2026-0042",
                    "awardTitle": "Road access field observations",
                }
            ],
            "acquisition": {
                "instruments": [
                    {
                        "identifier": "gnss-rover-01",
                        "type": "GNSS receiver",
                        "description": "Survey-grade field receiver.",
                    }
                ],
                "platforms": [
                    {
                        "identifier": "field-team-alpha",
                        "description": "Pedestrian survey team.",
                        "instrumentIdentifiers": ["gnss-rover-01"],
                    }
                ],
                "operations": [
                    {
                        "identifier": "survey-2026-04",
                        "description": "April road access survey.",
                        "status": "completed",
                        "type": "real",
                    }
                ],
            },
        }
    )

    assert validate_catalog_metadata(value) == value
    request = ResourceMetadataRequest(title="Roads", extensions={"opengeo": value})
    assert request.extensions["opengeo"]["funding"][0]["funderIdentifierType"] == "ROR"
    assert request.extensions["opengeo"]["acquisition"]["platforms"][0][
        "instrumentIdentifiers"
    ] == ["gnss-rover-01"]


def test_native_catalog_12_adds_relational_acquisition_planning() -> None:
    value = native_catalog()
    value.update(
        {
            "schemaVersion": "1.2.0",
            "acquisition": {
                "instruments": [{"identifier": "camera-01", "type": "camera"}],
                "operations": [{"identifier": "mission-01", "status": "planned", "type": "real"}],
                "objectives": [
                    {
                        "identifier": "objective-01",
                        "priority": "Capture post-storm conditions",
                        "types": ["survey"],
                        "functions": ["damage assessment"],
                        "instrumentIdentifiers": ["camera-01"],
                    }
                ],
                "requirements": [
                    {
                        "identifier": "requirement-01",
                        "requestors": ["Investigations desk"],
                        "recipients": ["Public data team"],
                        "priority": "highImportance",
                        "requestedDate": {
                            "requestedDateOfCollection": "2026-07-01T09:00:00Z",
                            "latestAcceptableDate": "2026-07-31T18:00:00Z",
                        },
                        "expiryDate": "2026-08-31T18:00:00Z",
                    }
                ],
                "plans": [
                    {
                        "identifier": "plan-01",
                        "status": "planned",
                        "type": "areal",
                        "operationIdentifiers": ["mission-01"],
                        "requirementIdentifiers": ["requirement-01"],
                    }
                ],
            },
        }
    )

    assert validate_catalog_metadata(value) == value


def test_native_catalog_13_adds_relational_events_and_platform_passes() -> None:
    value = native_catalog()
    value.update(
        {
            "schemaVersion": "1.3.0",
            "acquisition": {
                "instruments": [{"identifier": "camera-01", "type": "camera"}],
                "platformPasses": [{"identifier": "pass-01", "eventIdentifiers": ["event-01"]}],
                "objectives": [
                    {
                        "identifier": "objective-01",
                        "instrumentIdentifiers": ["camera-01"],
                        "passIdentifiers": ["pass-01"],
                        "eventIdentifiers": ["event-01"],
                    }
                ],
                "events": [
                    {
                        "identifier": "event-01",
                        "trigger": "automatic",
                        "context": "acquisition",
                        "sequence": "start",
                        "time": "2026-07-01T09:00:00Z",
                        "passIdentifier": "pass-01",
                        "instrumentIdentifiers": ["camera-01"],
                        "objectiveIdentifiers": ["objective-01"],
                    }
                ],
                "operations": [
                    {
                        "identifier": "mission-01",
                        "status": "planned",
                        "eventIdentifiers": ["event-01"],
                    }
                ],
            },
        }
    )

    assert validate_catalog_metadata(value) == value


def test_native_catalog_14_accepts_context_schema_and_environment_only() -> None:
    value = acquisition_context()
    schema = json.loads((ROOT / "schemas/opengeo-catalog-metadata-1.4.0.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    assert validate_catalog_metadata(value) == value
    request = ResourceMetadataRequest(title="Survey", extensions={"opengeo": value})
    assert request.extensions["opengeo"] == value
    validator.validate(value)
    environmental_only = {
        "schemaVersion": "1.4.0",
        "acquisition": {"environmentalConditions": {"averageAirTemperature": 0}},
    }
    assert validate_catalog_metadata(environmental_only) == environmental_only
    validator.validate(environmental_only)

    # Preserve separate boxes, the antimeridian and absent versus false inclusion.
    boxes = value["acquisition"]["objectives"][0]["extents"][0]["geographicBounds"]
    assert boxes[0]["west"] > boxes[0]["east"]
    assert boxes[0]["extentTypeCode"] is False
    assert "extentTypeCode" not in boxes[1]
    plan = value["acquisition"]["plans"][0]
    assert plan["identifier"] != plan["citation"]["title"]
    assert len(plan["citation"]["identifiers"]) == 2


def test_native_catalog_14_preserves_old_versions_and_gates_new_fields() -> None:
    for version in ("1.0.0", "1.1.0", "1.2.0", "1.3.0"):
        value = native_catalog()
        value["schemaVersion"] = version
        assert validate_catalog_metadata(value) == value
        value["acquisition"] = {"environmentalConditions": {"solarElevation": 0}}
        with pytest.raises(CatalogMetadataInvalid, match="unknown field"):
            validate_catalog_metadata(value)

    for collection, records in (
        ("objectives", [{"identifier": "objective", "extents": [{"description": "Area"}]}]),
        ("platformPasses", [{"identifier": "pass", "extent": {"description": "Area"}}]),
        ("plans", [{"identifier": "plan", "status": "planned", "citation": {"title": "Guide"}}]),
    ):
        with pytest.raises(CatalogMetadataInvalid, match="unknown field"):
            validate_catalog_metadata(
                {"schemaVersion": "1.3.0", "acquisition": {collection: records}}
            )


@pytest.mark.parametrize(
    ("path", "replacement", "message"),
    [
        (("objectives", 0, "extents"), [], "at least one"),
        (("objectives", 0, "extents"), [{"description": "Area"}] * 5, "at most 4"),
        (("platformPasses", 0, "extent"), {}, "nonempty extent"),
        (("platformPasses", 0, "extent"), {"vertical": 20}, "unknown field"),
        (("platformPasses", 0, "extent", "geographicBounds"), [], "at least one"),
        (
            ("platformPasses", 0, "extent", "geographicBounds"),
            [{"west": 0, "east": 1, "south": 0, "north": 1}] * 5,
            "at most 4",
        ),
        (("platformPasses", 0, "extent", "geographicBounds", 0, "west"), True, "finite number"),
        (("platformPasses", 0, "extent", "geographicBounds", 0, "east"), 181, "out of range"),
        (("platformPasses", 0, "extent", "geographicBounds", 0, "south"), 40, "south <= north"),
        (
            ("platformPasses", 0, "extent", "geographicBounds", 0, "extentTypeCode"),
            "false",
            "must be a boolean",
        ),
        (
            ("platformPasses", 0, "extent", "temporal"),
            {"start": "2026-07-01T09:00:00Z"},
            "start and end",
        ),
        (
            ("platformPasses", 0, "extent", "temporal", "end"),
            "2026-07-01T08:00:00Z",
            "start <= end",
        ),
        (
            ("platformPasses", 0, "extent", "temporal"),
            {"start": "2026-07-01T09:00:00.0000002Z", "end": "2026-07-01T09:00:00.0000001Z"},
            "start <= end",
        ),
        (
            ("platformPasses", 0, "extent", "temporal", "start"),
            "2026-02-30T09:00:00Z",
            "ISO 8601",
        ),
        (
            ("platformPasses", 0, "extent", "temporal", "start"),
            "2026-07-01 09:00:00Z",
            "full date-time",
        ),
        (("environmentalConditions",), {}, "nonempty"),
        (("environmentalConditions", "averageAirTemperature"), float("nan"), "finite number"),
        (("environmentalConditions", "maxAltitude"), True, "finite number"),
        (("environmentalConditions", "solarAzimuth"), float("inf"), "finite number"),
        (("plans", 0, "citation"), {}, "title must be a string"),
        (("plans", 0, "citation", "alternateTitles"), ["Title"] * 9, "1 to 8"),
        (("plans", 0, "citation", "dates"), [], "at least one"),
        (("plans", 0, "citation", "dates", 0, "date"), "2026-02-30", "valid YYYY-MM-DD"),
        (("plans", 0, "citation", "dates", 0, "dateType"), "unknown", "unsupported"),
        (("plans", 0, "citation", "editionDate"), "2026-07-01T09:00:00+14:01", "full date-time"),
        (("plans", 0, "citation", "identifiers"), [{"code": "same"}] * 2, "must be unique"),
        (("plans", 0, "citation", "identifiers"), [{"code": "id"}] * 9, "at most 8"),
        (
            ("plans", 0, "citation", "identifiers"),
            [{"code": "id", "codeSpace": "urn:opengeo:catalog:acquisition-plan"}],
            "reserved for plan identity",
        ),
        (
            ("requirements", 0, "citation", "identifiers"),
            [{"code": "id", "codeSpace": " urn:opengeo:catalog:acquisition-plan "}],
            "reserved for plan identity",
        ),
        (("requirements", 0, "citation", "identifiers", 0, "codeSpace"), "", "length is invalid"),
    ],
    ids=[
        "empty-objective-extents",
        "too-many-objective-extents",
        "empty-pass-extent",
        "unknown-extent",
        "empty-bounds",
        "too-many-bounds",
        "boolean-coordinate",
        "longitude-range",
        "latitude-order",
        "inclusion-type",
        "open-time",
        "reversed-time",
        "reversed-submicrosecond-time",
        "invalid-calendar-time",
        "nonstandard-time",
        "empty-environment",
        "nonfinite-temperature",
        "boolean-altitude",
        "nonfinite-azimuth",
        "missing-citation-title",
        "too-many-titles",
        "empty-citation-dates",
        "invalid-citation-date",
        "unknown-date-type",
        "invalid-edition-offset",
        "duplicate-citation-identity",
        "too-many-citation-identities",
        "reserved-plan-carrier",
        "normalized-reserved-carrier",
        "empty-citation-code-space",
    ],
)
def test_native_catalog_14_rejects_invalid_context(
    path: tuple[str | int, ...], replacement: Any, message: str
) -> None:
    value = deepcopy(acquisition_context())
    current = value["acquisition"]
    for component in path[:-1]:
        current = current[component]
    current[path[-1]] = replacement

    with pytest.raises(CatalogMetadataInvalid, match=message):
        validate_catalog_metadata(value)
    with pytest.raises(ValidationError):
        ResourceMetadataRequest(title="Survey", extensions={"opengeo": value})


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"unexpected": True}, "unknown field"),
        ({"schemaVersion": "2.0.0"}, "must be 1.0.0"),
        ({"funding": [{"funderName": "Unversioned"}]}, "unknown field funding"),
        ({"sensitivity": "secret"}, "sensitivity"),
        (
            {"distributions": [{"downloadUrl": "https://user:secret@example.test/a"}]},
            "without credentials",
        ),
        (
            {"distributions": [{"downloadUrl": "https://127.0.0.1/a"}]},
            "public hostname",
        ),
        ({"contacts": [{"email": "missing-name@example.test"}]}, "requires name"),
        ({"quality": [{"measure": "accuracy", "result": float("nan")}]}, "finite"),
        (
            {
                "schemaVersion": "1.1.0",
                "acquisition": {
                    "instruments": [{"identifier": "gps", "type": "receiver"}],
                    "platforms": [
                        {
                            "identifier": "team",
                            "description": "Field team",
                            "instrumentIdentifiers": ["missing"],
                        }
                    ],
                },
            },
            "unknown instrument missing",
        ),
        (
            {
                "schemaVersion": "1.1.0",
                "funding": [{"funderName": "Foundation", "funderIdentifier": "012345"}],
            },
            "funderIdentifierType is required",
        ),
        (
            {
                "schemaVersion": "1.1.0",
                "acquisition": {"plans": [{"identifier": "plan-01", "status": "planned"}]},
            },
            "unknown field plans",
        ),
        (
            {
                "schemaVersion": "1.2.0",
                "acquisition": {
                    "plans": [
                        {
                            "identifier": "plan-01",
                            "status": "planned",
                            "operationIdentifiers": ["missing"],
                        }
                    ]
                },
            },
            "unknown operation missing",
        ),
        (
            {
                "schemaVersion": "1.2.0",
                "acquisition": {
                    "requirements": [
                        {
                            "identifier": "requirement-01",
                            "requestors": ["Desk"],
                            "recipients": ["Team"],
                            "priority": "critical",
                            "requestedDate": {
                                "requestedDateOfCollection": "2026-08-01T00:00:00Z",
                                "latestAcceptableDate": "2026-07-01T00:00:00Z",
                            },
                            "expiryDate": "2026-09-01T00:00:00Z",
                        }
                    ]
                },
            },
            "requestedDateOfCollection <= latestAcceptableDate",
        ),
        (
            {
                "schemaVersion": "1.2.0",
                "acquisition": {
                    "events": [
                        {
                            "identifier": "event-01",
                            "trigger": "automatic",
                            "context": "acquisition",
                            "sequence": "start",
                            "time": "2026-07-01T09:00:00Z",
                        }
                    ]
                },
            },
            "unknown field events",
        ),
        (
            {
                "schemaVersion": "1.3.0",
                "acquisition": {
                    "events": [
                        {
                            "identifier": "event-01",
                            "trigger": "automatic",
                            "context": "acquisition",
                            "sequence": "start",
                            "time": "2026-07-01T09:00:00Z",
                            "passIdentifier": "missing",
                        }
                    ]
                },
            },
            "unknown platform pass missing",
        ),
        (
            {
                "schemaVersion": "1.3.0",
                "acquisition": {
                    "events": [
                        {
                            "identifier": "event-01",
                            "trigger": "automatic",
                            "context": "acquisition",
                            "sequence": "start",
                            "time": "2026-07-01T09:00:00",
                        }
                    ]
                },
            },
            "timezone offset",
        ),
    ],
)
def test_native_catalog_contract_rejects_unsafe_or_ambiguous_values(
    change: dict[str, Any], message: str
) -> None:
    value = native_catalog()
    value.update(change)

    with pytest.raises(CatalogMetadataInvalid, match=message):
        validate_catalog_metadata(value)
    with pytest.raises(ValidationError, match=message):
        ResourceMetadataRequest(title="Roads", extensions={"opengeo": value})
