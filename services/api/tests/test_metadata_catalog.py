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


def iso_transfer() -> dict[str, Any]:
    return {
        "unitsOfDistribution": "files",
        "transferSizeMegabytes": 0.125,
        "transferFrequency": "P1DT2H3M4.5S",
        "formats": [
            {
                "citation": {
                    "title": "GeoJSON",
                    "dates": [{"date": "2026-11-04", "dateType": "revision"}],
                    "edition": "RFC 7946",
                    "identifiers": [{"code": "7946", "codeSpace": "RFC"}],
                },
                "amendmentNumber": "1",
                "fileDecompressionTechnique": "gzip",
            }
        ],
        "onlineResources": [
            {
                "linkage": "https://data.example.test/roads",
                "protocol": "HTTPS",
                "applicationProfile": "OGC API",
                "name": "Roads information",
                "description": "Access and documentation",
                "function": "information",
                "protocolRequest": "GET",
            },
            {
                "linkage": "https://data.example.test/roads.geojson",
                "function": "download",
            },
        ],
        "projections": {"accessUrl": 0, "downloadUrl": 1, "title": 0, "format": 0},
    }


def test_native_catalog_15_accepts_typed_transfer_and_all_acquisition_context() -> None:
    value = acquisition_context()
    value["schemaVersion"] = "1.5.0"
    value["distributions"] = native_catalog()["distributions"]
    value["distributions"][0].update(
        {"accessUrl": "https://data.example.test/roads", "isoTransfer": iso_transfer()}
    )
    schema = json.loads((ROOT / "schemas/opengeo-catalog-metadata-1.5.0.schema.json").read_text())

    assert validate_catalog_metadata(value) == value
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
    request = ResourceMetadataRequest(title="Survey", extensions={"opengeo": value})
    assert request.extensions["opengeo"] == value

    # Independent rich context does not require inferred projection bindings.
    del value["distributions"][0]["isoTransfer"]["projections"]
    assert validate_catalog_metadata(value) == value


@pytest.mark.parametrize("version", ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"])
def test_native_catalog_15_preserves_old_versions_and_rejects_transfer(version: str) -> None:
    value = native_catalog()
    value["schemaVersion"] = version
    assert validate_catalog_metadata(value) == value
    value["distributions"][0]["isoTransfer"] = iso_transfer()
    with pytest.raises(CatalogMetadataInvalid, match="unknown field isoTransfer"):
        validate_catalog_metadata(value)
    if version == "1.4.0":
        schema = json.loads(
            (ROOT / "schemas/opengeo-catalog-metadata-1.4.0.schema.json").read_text()
        )
        assert not Draft202012Validator(schema).is_valid(value)


@pytest.mark.parametrize(
    "transfer",
    [
        None,
        [],
        {},
        {"unknown": "value"},
        {"unitsOfDistribution": ""},
        {"unitsOfDistribution": "x" * 1001},
        {"transferSizeMegabytes": 0},
        {"transferSizeMegabytes": -1},
        {"transferSizeMegabytes": True},
        {"transferSizeMegabytes": float("inf")},
        {"transferSizeMegabytes": float("nan")},
        {"formats": []},
        {"formats": [{"citation": {"title": "Format"}}] * 9},
        {"formats": [{}]},
        {"formats": [{"citation": {}}]},
        {"formats": [{"citation": {"title": "Format"}, "amendmentNumber": "x" * 1001}]},
        {"onlineResources": []},
        {"onlineResources": [{"linkage": "https://data.example.test"}] * 9},
        {"onlineResources": [{}]},
        {"onlineResources": [{"linkage": "http://data.example.test"}]},
        {"onlineResources": [{"linkage": "https://[invalid"}]},
        {"onlineResources": [{"linkage": "https://127.0.0.1/data"}]},
        {"onlineResources": [{"linkage": "https://user:pass@data.example.test"}]},
        {"onlineResources": [{"linkage": "https://data.example.test/#fragment"}]},
        {"onlineResources": [{"linkage": "https://data.example.test", "function": "x" * 301}]},
        {"onlineResources": [{"linkage": "https://data.example.test", "protocol": "x" * 1001}]},
        {"projections": {}},
        {"projections": {"accessUrl": 0}},
        {
            "onlineResources": [{"linkage": "https://data.example.test"}],
            "projections": {"title": 1},
        },
        {
            "onlineResources": [{"linkage": "https://data.example.test"}],
            "projections": {"title": True},
        },
        {"formats": [{"citation": {"title": "Format"}}], "projections": {"format": -1}},
        {"formats": [{"citation": {"title": "Format"}}], "projections": {"format": 8}},
        {"formats": [{"citation": {"title": "Format"}}], "projections": {"format": 0.0}},
        {"formats": [{"citation": {"title": "Format"}}], "projections": {"unknown": 0}},
    ],
)
def test_native_catalog_15_rejects_invalid_transfer_shapes_and_bindings(transfer: Any) -> None:
    value = native_catalog()
    value["schemaVersion"] = "1.5.0"
    value["distributions"][0]["isoTransfer"] = transfer
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)


@pytest.mark.parametrize(
    ("duration", "valid"),
    [(v, True) for v in ("P1Y2M3DT4H5M6.7S", "P1D", "PT1H", "PT0.5S", "P0D", "-P1D")]
    + [(v, False) for v in ("P", "PT", "P1DT", "P1W", "P1.5D", "P1H", "P1DT1.5H", "daily")],
)
def test_native_catalog_15_transfer_frequency_uses_xsd_duration(duration: str, valid: bool) -> None:
    value = native_catalog()
    value["schemaVersion"] = "1.5.0"
    value["distributions"][0]["isoTransfer"] = {"transferFrequency": duration}
    schema = json.loads((ROOT / "schemas/opengeo-catalog-metadata-1.5.0.schema.json").read_text())
    assert Draft202012Validator(schema).is_valid(value) is valid
    if valid:
        assert validate_catalog_metadata(value) == value
    else:
        with pytest.raises(CatalogMetadataInvalid, match="ISO duration"):
            validate_catalog_metadata(value)


def test_native_catalog_15_retains_simple_url_and_distribution_bounds() -> None:
    value = {"schemaVersion": "1.5.0", "distributions": [{"isoTransfer": iso_transfer()}]}
    with pytest.raises(CatalogMetadataInvalid, match="requires accessUrl or downloadUrl"):
        validate_catalog_metadata(value)
    value["distributions"] = native_catalog()["distributions"] * 33
    with pytest.raises(CatalogMetadataInvalid, match="at most 32"):
        validate_catalog_metadata(value)


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


def quality_reports_catalog() -> dict[str, Any]:
    value = native_catalog()
    value["schemaVersion"] = "1.6.0"
    value["qualityReports"] = [
        {
            "scope": {"level": "dataset"},
            "reports": [
                {
                    "id": "accuracy",
                    "type": "DQ_AbsoluteExternalPositionalAccuracy",
                    "standaloneDetails": "Independent survey assessment",
                    "measure": {
                        "identifier": {"code": "RMSE", "codeSpace": "survey"},
                        "names": ["Root mean square error", "RMSE"],
                        "description": "Against surveyed control points",
                    },
                    "evaluation": {
                        "type": "DQ_FullInspection",
                        "methodType": "directExternal",
                        "description": "Compare every control point",
                        "procedure": {"title": "Survey procedure"},
                        "referenceDocuments": [{"title": "Survey handbook"}],
                        "dateTimes": ["2026-11-04T18:00:00-05:00"],
                    },
                    "results": [
                        {
                            "type": "DQ_QuantitativeResult",
                            "values": ["001.2300", "1.2e-03", "001.2300"],
                            "unit": "metre",
                            "recordType": "decimal",
                            "dateTime": "2026-11-04T23:00:00.123456789Z",
                            "scope": {"level": "sample"},
                        },
                        {"type": "DQ_DescriptiveResult", "statement": "Control points checked"},
                        {
                            "type": "DQ_ConformanceResult",
                            "specification": {"title": "Survey standard"},
                            "explanation": "Tolerance exceeded",
                            "pass": False,
                        },
                    ],
                    "derivedReports": ["confidence"],
                },
                {
                    "id": "confidence",
                    "type": "DQ_Confidence",
                    "results": [{"type": "DQ_DescriptiveResult", "statement": "Low confidence"}],
                    "relatedReports": ["accuracy"],
                },
            ],
        }
    ]
    return value


def quality_schema() -> dict[str, Any]:
    return json.loads((ROOT / "schemas/opengeo-catalog-metadata-1.6.0.schema.json").read_text())


def test_native_catalog_16_preserves_rich_quality_lexical_values_false_and_legacy() -> None:
    value = quality_reports_catalog()
    value["acquisition"] = acquisition_context()["acquisition"]
    value["distributions"][0]["isoTransfer"] = iso_transfer()
    normalized = validate_catalog_metadata(value)
    assert normalized == value
    assert normalized["qualityReports"][0]["reports"][0]["results"][2]["pass"] is False
    assert normalized["quality"] == native_catalog()["quality"]
    Draft202012Validator(quality_schema(), format_checker=FormatChecker()).validate(value)


def test_native_catalog_16_report_and_evaluation_types_match_schema() -> None:
    from opengeo_api.metadata_catalog import (
        ISO_QUALITY_EVALUATION_TYPES,
        ISO_QUALITY_REPORT_TYPES,
    )

    schema = quality_schema()
    assert len(ISO_QUALITY_REPORT_TYPES) == 19
    assert len(ISO_QUALITY_EVALUATION_TYPES) == 5
    assert set(schema["$defs"]["qualityReport"]["properties"]["type"]["enum"]) == set(
        ISO_QUALITY_REPORT_TYPES
    )
    assert set(schema["$defs"]["qualityEvaluation"]["properties"]["type"]["enum"]) == set(
        ISO_QUALITY_EVALUATION_TYPES
    )
    for kind in ISO_QUALITY_REPORT_TYPES:
        value = quality_reports_catalog()
        report = value["qualityReports"][0]["reports"][0]
        report["type"] = kind
        assert validate_catalog_metadata(value) == value
        Draft202012Validator(schema).validate(value)


@pytest.mark.parametrize(
    "evaluation",
    [
        {"type": "DQ_EvaluationMethod"},
        {"type": "DQ_AggregationDerivation"},
        {"type": "DQ_FullInspection"},
        {"type": "DQ_IndirectEvaluation", "deductiveSources": ["Source observations"]},
        {
            "type": "DQ_SampleBasedInspection",
            "samplingScheme": "Stratified random sample",
            "lotDescription": "Road observations",
            "samplingRatio": "1:10",
        },
    ],
)
def test_native_catalog_16_all_concrete_evaluations(evaluation: dict[str, Any]) -> None:
    value = quality_reports_catalog()
    value["qualityReports"][0]["reports"][0]["evaluation"] = evaluation
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(quality_schema()).validate(value)


@pytest.mark.parametrize("version", ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"])
def test_native_catalog_16_quality_reports_are_version_gated(version: str) -> None:
    value = native_catalog()
    value["schemaVersion"] = version
    assert validate_catalog_metadata(value) == value
    schema = json.loads(
        (ROOT / f"schemas/opengeo-catalog-metadata-{version}.schema.json").read_text()
    )
    value["qualityReports"] = quality_reports_catalog()["qualityReports"]
    with pytest.raises(CatalogMetadataInvalid, match="unknown field qualityReports"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(schema).is_valid(value)


@pytest.mark.parametrize("invalid_pass", [0, 1, "false", "true", None, [], {}])
def test_native_catalog_16_conformance_requires_strict_boolean(invalid_pass: Any) -> None:
    value = quality_reports_catalog()
    value["qualityReports"][0]["reports"][0]["results"][2]["pass"] = invalid_pass
    with pytest.raises(CatalogMetadataInvalid, match="pass must be a boolean"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(quality_schema()).is_valid(value)


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("type", "AbstractDQ_Element"),
        ("id", "contains:colon"),
        ("id", "1startsWithDigit"),
        ("id", "has space"),
        ("id", "x" * 101),
        ("standaloneDetails", "x" * 1001),
        ("measure", {}),
        ("measure", {"identifier": {"codeSpace": "survey"}}),
        ("measure", {"names": []}),
        ("measure", {"names": ["x"] * 9}),
        ("evaluation", {"type": "AbstractDQ_DataEvaluation"}),
        ("evaluation", {"type": "DQ_IndirectEvaluation"}),
        ("evaluation", {"type": "DQ_SampleBasedInspection", "samplingScheme": "random"}),
        ("evaluation", {"type": "DQ_FullInspection", "deductiveSources": ["source"]}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "samplingRatio": "1:10"}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "methodType": "unknown"}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "dateTimes": []}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "dateTimes": ["2026-11-04"]}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "dateTimes": ["2026-11-04T23:00:00+14:01"]}),
        ("evaluation", {"type": "DQ_EvaluationMethod", "referenceDocuments": []}),
        ("results", []),
        ("results", [{"type": "DQ_DescriptiveResult", "statement": "ok"}] * 9),
        ("results", [{"type": "DQ_QuantitativeResult", "values": [1.23]}]),
        ("results", [{"type": "DQ_QuantitativeResult", "values": []}]),
        ("results", [{"type": "DQ_QuantitativeResult", "values": ["x"] * 9}]),
        ("results", [{"type": "DQ_QuantitativeResult", "values": ["x" * 1001]}]),
        ("results", [{"type": "DQ_DescriptiveResult"}]),
        ("results", [{"type": "DQ_DescriptiveResult", "statement": "ok", "values": ["1"]}]),
        ("results", [{"type": "DQ_ConformanceResult", "pass": False}]),
        ("results", [{"type": "DQ_ConformanceResult", "specification": {"title": "Standard"}}]),
        ("derivedReports", []),
        ("derivedReports", ["accuracy"] * 9),
        ("relatedReports", ["accuracy"]),
        ("unknown", "unrecognized"),
    ],
)
def test_native_catalog_16_invalid_local_report_shapes_match_schema(
    field: str, invalid: Any
) -> None:
    value = quality_reports_catalog()
    value["qualityReports"][0]["reports"][0][field] = invalid
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(quality_schema(), format_checker=FormatChecker()).is_valid(
        value
    )


@pytest.mark.parametrize(
    "groups", [None, {}, [], [{}], [{"scope": {"level": "dataset"}, "reports": []}]]
)
def test_native_catalog_16_requires_owned_nonempty_groups(groups: Any) -> None:
    value = {"schemaVersion": "1.6.0", "qualityReports": groups}
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(quality_schema()).is_valid(value)


def test_native_catalog_16_group_and_total_report_cardinality() -> None:
    report = {
        "type": "DQ_UsabilityElement",
        "results": [{"type": "DQ_DescriptiveResult", "statement": "ok"}],
    }
    group = {"scope": {"level": "dataset"}, "reports": [report]}
    value = {"schemaVersion": "1.6.0", "qualityReports": [group] * 9}
    with pytest.raises(CatalogMetadataInvalid, match="at most 8"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(quality_schema()).is_valid(value)
    value["qualityReports"] = [{"scope": group["scope"], "reports": [report] * 32}]
    assert validate_catalog_metadata(value) == value
    value["qualityReports"].append(group)
    # JSON Schema checks local shape; the API checks the cross-group sum.
    assert Draft202012Validator(quality_schema()).is_valid(value)
    with pytest.raises(CatalogMetadataInvalid, match="32 total reports"):
        validate_catalog_metadata(value)


@pytest.mark.parametrize("graph_error", ["duplicate", "derivedMissing", "relatedMissing"])
def test_native_catalog_16_runtime_checks_global_report_references(graph_error: str) -> None:
    value = quality_reports_catalog()
    reports = value["qualityReports"][0]["reports"]
    if graph_error == "duplicate":
        reports[1]["id"] = reports[0]["id"]
    elif graph_error == "derivedMissing":
        reports[0]["derivedReports"] = ["missing"]
    else:
        reports[1]["relatedReports"] = ["missing"]
    # Dynamic identity resolution is intentionally an API validation rule.
    assert Draft202012Validator(quality_schema()).is_valid(value)
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)


def test_native_catalog_16_references_cross_groups_and_unicode_xml_ids() -> None:
    value = quality_reports_catalog()
    group = value["qualityReports"][0]
    second = group["reports"].pop()
    second["id"] = "\u0394\U00010400.report-1"
    group["reports"][0]["derivedReports"] = [second["id"]]
    value["qualityReports"].append({"scope": {"level": "series"}, "reports": [second]})
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(quality_schema()).validate(value)


def iso_medium() -> dict[str, Any]:
    return {
        "name": {
            "title": "DVD archive",
            "dates": [{"date": "2026-11-05", "dateType": "publication"}],
            "identifiers": [{"code": "DVD", "codeSpace": "archive"}],
        },
        "density": "+001.2300e+02",
        "densityUnits": "megabytes per square centimetre",
        "volumes": -2,
        "mediumFormats": ["iso9660", "tar", "iso9660", "providerDefinedFormat"],
        "mediumNote": "Read with an optical drive",
        "identifier": {"code": "archive-001", "codeSpace": "media"},
    }


def offline_catalog() -> dict[str, Any]:
    return {
        "schemaVersion": "1.7.0",
        "distributions": [{"isoTransfer": {"offlineMedia": [iso_medium()]}}],
    }


def offline_schema() -> dict[str, Any]:
    return json.loads((ROOT / "schemas/opengeo-catalog-metadata-1.7.0.schema.json").read_text())


def test_native_catalog_17_offline_only_and_mixed_preserve_all_existing_features() -> None:
    value = quality_reports_catalog()
    value["schemaVersion"] = "1.7.0"
    value["acquisition"] = acquisition_context()["acquisition"]
    value["distributions"][0]["isoTransfer"] = iso_transfer()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [iso_medium()]
    value["distributions"].extend(offline_catalog()["distributions"])
    assert validate_catalog_metadata(value) == value
    assert value["distributions"][1]["isoTransfer"]["offlineMedia"][0]["density"] == "+001.2300e+02"
    Draft202012Validator(offline_schema(), format_checker=FormatChecker()).validate(value)


@pytest.mark.parametrize("field", list(iso_medium()))
def test_native_catalog_17_each_medium_field_is_independently_usable(field: str) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [{field: iso_medium()[field]}]
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(offline_schema(), format_checker=FormatChecker()).validate(value)


@pytest.mark.parametrize("version", ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0"])
def test_native_catalog_17_old_versions_keep_urls_and_reject_offline_media(version: str) -> None:
    value = native_catalog()
    value["schemaVersion"] = version
    assert validate_catalog_metadata(value) == value
    schema = json.loads(
        (ROOT / f"schemas/opengeo-catalog-metadata-{version}.schema.json").read_text()
    )
    value["distributions"][0]["isoTransfer"] = {"offlineMedia": [iso_medium()]}
    with pytest.raises(CatalogMetadataInvalid, match="unknown field"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(schema).is_valid(value)
    value["distributions"] = [{"title": "No URL"}]
    with pytest.raises(CatalogMetadataInvalid, match="requires accessUrl or downloadUrl"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(schema).is_valid(value)


@pytest.mark.parametrize(
    "transfer",
    [{}, {"unitsOfDistribution": "files"}, {"offlineMedia": []}, {"offlineMedia": [{}]}],
)
def test_native_catalog_17_url_exception_requires_nonempty_valid_media(
    transfer: dict[str, Any],
) -> None:
    value = {"schemaVersion": "1.7.0", "distributions": [{"isoTransfer": transfer}]}
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(offline_schema()).is_valid(value)


@pytest.mark.parametrize(
    "density",
    [
        "-1",
        "+001.2300e+02",
        "-0",
        "0",
        "+0",
        ".1",
        "1.",
        "1E-3",
        "1e308",
        "0e999999999",
        "1.7976931348623157e308",
    ],
)
def test_native_catalog_17_density_preserves_finite_xsd_double_lexemes(density: str) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [{"density": density}]
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(offline_schema()).validate(value)


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("name", "DVD"),
        ("name", {}),
        ("name", {"title": "x" * 1001}),
        ("name", {"title": "DVD", "unknown": "x"}),
        ("density", True),
        ("density", False),
        ("density", 1),
        ("density", 1.2),
        ("density", None),
        ("density", ""),
        ("density", " 1"),
        ("density", "1 "),
        ("density", "1\n"),
        ("density", "NaN"),
        ("density", "INF"),
        ("density", "-INF"),
        ("density", "Infinity"),
        ("density", "1_000"),
        ("density", "1,000"),
        ("density", "1d3"),
        ("density", "1e"),
        ("density", "1e+"),
        ("density", "\u0661.\u0662"),
        ("density", "1" * 101),
        ("densityUnits", ""),
        ("densityUnits", True),
        ("densityUnits", "x" * 1001),
        ("volumes", True),
        ("volumes", False),
        ("volumes", "2"),
        ("volumes", 1.5),
        ("volumes", -(10**18) - 1),
        ("volumes", 10**18 + 1),
        ("mediumFormats", []),
        ("mediumFormats", ["tar"] * 9),
        ("mediumFormats", [""]),
        ("mediumFormats", [True]),
        ("mediumFormats", ["x" * 301]),
        ("mediumNote", ""),
        ("mediumNote", "x" * 1001),
        ("identifier", {}),
        ("identifier", "archive-001"),
        ("identifier", {"code": ""}),
        ("identifier", {"code": "x" * 301}),
        ("identifier", {"code": "x", "codeSpace": "x" * 301}),
        ("identifier", {"code": "x", "authority": {"title": "Authority"}}),
        ("identifier", {"code": "x", "version": "1"}),
        ("identifier", {"code": "x", "description": "Unsupported"}),
        ("unknown", "unrecognized"),
    ],
)
def test_native_catalog_17_invalid_medium_local_shapes_match_schema(
    field: str, invalid: Any
) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [{field: invalid}]
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(offline_schema(), format_checker=FormatChecker()).is_valid(
        value
    )


@pytest.mark.parametrize(
    "density", ["1e309", "-1e309", "1.7976931348623159e308", "9" * 95 + "e999"]
)
def test_native_catalog_17_density_runtime_rejects_double_overflow(density: str) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [{"density": density}]
    # JSON Schema enforces lexical shape; conversion to a finite double is an API rule.
    assert Draft202012Validator(offline_schema()).is_valid(value)
    with pytest.raises(CatalogMetadataInvalid, match="finite xs:double lexical string"):
        validate_catalog_metadata(value)


@pytest.mark.parametrize("media", [None, {}, [], [None], [{}], [{"mediumNote": "DVD"}] * 9])
def test_native_catalog_17_offline_media_requires_one_to_eight_nonempty_objects(media: Any) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = media
    with pytest.raises(CatalogMetadataInvalid):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(offline_schema()).is_valid(value)


@pytest.mark.parametrize("volumes", [-(10**18), -1, 0, 1, 10**18])
def test_native_catalog_17_signed_volume_bounds_and_media_format_multiplicity(volumes: int) -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [
        {"volumes": volumes, "mediumFormats": ["providerFormat", "tar", "tar"]}
    ] * 8
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(offline_schema()).validate(value)


def test_native_catalog_17_accepts_scalar_limits_and_retains_distribution_cap() -> None:
    value = offline_catalog()
    value["distributions"][0]["isoTransfer"]["offlineMedia"] = [
        {
            "name": {"title": "x" * 1000},
            "density": "0" * 100,
            "densityUnits": "x" * 1000,
            "mediumNote": "x" * 1000,
            "mediumFormats": ["x" * 300] * 8,
            "identifier": {"code": "x" * 300, "codeSpace": "x" * 300},
        }
    ]
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(offline_schema()).validate(value)
    value["distributions"] = [{"isoTransfer": {"offlineMedia": [{"mediumNote": "DVD"}]}}] * 32
    assert validate_catalog_metadata(value) == value
    Draft202012Validator(offline_schema()).validate(value)
    value["distributions"].append(value["distributions"][0])
    with pytest.raises(CatalogMetadataInvalid, match="at most 32"):
        validate_catalog_metadata(value)
    assert not Draft202012Validator(offline_schema()).is_valid(value)
