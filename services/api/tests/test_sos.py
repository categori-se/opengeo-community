from datetime import UTC, datetime
from uuid import UUID
from xml.etree import ElementTree as ET

import pytest

from opengeo_api.features import FeatureCollection, FeatureField, FeaturePage, FeatureRecord
from opengeo_api.sos import (
    NS,
    SOS_DEFAULT_UNIT,
    SOS_MAX_OBSERVATIONS,
    SOS_OBSERVATION_TYPE,
    SOS_PHENOMENON_TIME_FIELD,
    SOS_RESULT_FIELD,
    SOS_RESULT_UNIT_FIELD,
    SosProfileError,
    capabilities_document,
    describe_sensor_document,
    observation_document,
    observation_profile,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000271")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000271")
FEATURE_ID = UUID("90000000-0000-4000-8000-000000000271")
NOW = datetime(2026, 9, 7, 15, 30, tzinfo=UTC)
ENDPOINT = "https://studio.example.test/projects/example/services/observations/sos/temperature"


def collection(*, include_unit: bool = True) -> FeatureCollection:
    fields = [
        FeatureField(SOS_PHENOMENON_TIME_FIELD, "string", True),
        FeatureField(SOS_RESULT_FIELD, "number", True),
    ]
    if include_unit:
        fields.append(FeatureField(SOS_RESULT_UNIT_FIELD, "string", False))
    return FeatureCollection(
        DATASET_ID,
        "Point",
        tuple(fields),
        4,
        1,
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )


def feature(properties: dict | None = None) -> FeatureRecord:
    return FeatureRecord(
        FEATURE_ID,
        2,
        "Point",
        {"type": "Point", "coordinates": [-71.1, 42.4]},
        (-71.1, 42.4, -71.1, 42.4),
        properties
        or {
            SOS_PHENOMENON_TIME_FIELD: "2026-09-07T11:30:00-04:00",
            SOS_RESULT_FIELD: 21.25,
            SOS_RESULT_UNIT_FIELD: "urn:ogc:def:uom:UCUM:Cel",
        },
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )


def profile():
    return observation_profile(
        collection(),
        endpoint=ENDPOINT,
        collection_name="temperature",
        title="Air temperature",
        description="Reviewed field observations",
    )


def test_sos_documents_have_exact_governed_identifiers_and_observation_values() -> None:
    current = profile()
    capabilities = ET.fromstring(capabilities_document(current))
    sensor = ET.fromstring(describe_sensor_document(current))
    page = FeaturePage(collection(), (feature(),), 1, SOS_MAX_OBSERVATIONS, 0)
    observations = ET.fromstring(observation_document(current, page))

    assert capabilities.tag == f"{{{NS['sos']}}}Capabilities"
    assert capabilities.attrib["version"] == "2.0.0"
    assert capabilities.findtext(".//swes:procedure", namespaces=NS) == current.procedure
    assert capabilities.findtext(".//swes:observableProperty", namespaces=NS) == (
        current.observed_property
    )
    assert sensor.find(".//sml:PhysicalComponent", NS) is not None
    assert sensor.findtext(".//gml:identifier", namespaces=NS) == current.procedure
    observation = observations.find(".//om:OM_Observation", NS)
    assert observation is not None
    assert observation.find("om:type", NS).attrib[f"{{{NS['xlink']}}}href"] == (
        SOS_OBSERVATION_TYPE
    )
    assert observation.findtext(".//gml:timePosition", namespaces=NS) == ("2026-09-07T15:30:00Z")
    result = observation.find("om:result", NS)
    assert result is not None
    assert result.text == "21.25"
    assert result.attrib["uom"] == "urn:ogc:def:uom:UCUM:Cel"
    assert (
        str(FEATURE_ID)
        in observation.find("om:featureOfInterest", NS).attrib[f"{{{NS['xlink']}}}href"]
    )


def test_sos_profile_and_values_fail_closed() -> None:
    invalid_schema = FeatureCollection(
        DATASET_ID,
        "Point",
        (FeatureField(SOS_RESULT_FIELD, "string", True),),
        4,
        1,
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )
    with pytest.raises(SosProfileError, match="phenomenon_time"):
        observation_profile(
            invalid_schema,
            endpoint=ENDPOINT,
            collection_name="temperature",
            title="Air temperature",
            description=None,
        )

    current = profile()
    naive_time = feature({SOS_PHENOMENON_TIME_FIELD: "2026-09-07T15:30:00", SOS_RESULT_FIELD: 2.0})
    with pytest.raises(SosProfileError, match="offset-aware"):
        observation_document(
            current,
            FeaturePage(collection(), (naive_time,), 1, SOS_MAX_OBSERVATIONS, 0),
        )
    infinite = feature(
        {
            SOS_PHENOMENON_TIME_FIELD: "2026-09-07T15:30:00Z",
            SOS_RESULT_FIELD: float("inf"),
        }
    )
    with pytest.raises(SosProfileError, match="non-finite"):
        observation_document(
            current,
            FeaturePage(collection(), (infinite,), 1, SOS_MAX_OBSERVATIONS, 0),
        )
    with pytest.raises(SosProfileError, match="exceeds"):
        observation_document(
            current,
            FeaturePage(collection(), (), SOS_MAX_OBSERVATIONS + 1, SOS_MAX_OBSERVATIONS, 0),
        )


def test_sos_default_unit_is_explicit() -> None:
    current = observation_profile(
        collection(include_unit=False),
        endpoint=ENDPOINT,
        collection_name="temperature",
        title="Air temperature",
        description=None,
    )
    record = feature({SOS_PHENOMENON_TIME_FIELD: "2026-09-07T15:30:00Z", SOS_RESULT_FIELD: 7})
    document = ET.fromstring(
        observation_document(
            current,
            FeaturePage(collection(include_unit=False), (record,), 1, 100, 0),
        )
    )
    assert document.find(".//om:result", NS).attrib["uom"] == SOS_DEFAULT_UNIT
