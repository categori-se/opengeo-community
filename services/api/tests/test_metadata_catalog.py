from typing import Any

import pytest
from pydantic import ValidationError

from opengeo_api.metadata_catalog import CatalogMetadataInvalid, validate_catalog_metadata
from opengeo_api.metadata_profiles import validate_metadata_document
from opengeo_api.resource_routes import ResourceMetadataRequest


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
