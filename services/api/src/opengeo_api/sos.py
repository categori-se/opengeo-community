"""Bounded SOS 2.0 observation profile over governed feature collections."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from opengeo_api.features import FeatureCollection, FeaturePage, FeatureRecord

SOS_VERSION = "2.0.0"
SOS_RESPONSE_FORMAT = "http://www.opengis.net/om/2.0"
SOS_PROCEDURE_DESCRIPTION_FORMAT = "http://www.opengis.net/sensorml/2.0"
SOS_OBSERVATION_TYPE = "http://www.opengis.net/def/observationType/OGC-OM/2.0/OM_Measurement"
SOS_DEFAULT_UNIT = "urn:ogc:def:uom:OGC:1.0:unity"
SOS_MAX_OBSERVATIONS = 100
SOS_PHENOMENON_TIME_FIELD = "sos_phenomenon_time"
SOS_RESULT_FIELD = "sos_result"
SOS_RESULT_UNIT_FIELD = "sos_result_unit"

NS = {
    "sos": "http://www.opengis.net/sos/2.0",
    "swes": "http://www.opengis.net/swes/2.0",
    "ows": "http://www.opengis.net/ows/1.1",
    "om": "http://www.opengis.net/om/2.0",
    "gml": "http://www.opengis.net/gml/3.2",
    "sml": "http://www.opengis.net/sensorml/2.0",
    "xlink": "http://www.w3.org/1999/xlink",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}
for _prefix, _namespace in NS.items():
    ET.register_namespace(_prefix, _namespace)

_GML_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,255}$")


class SosProfileError(ValueError):
    """The collection or an observation does not satisfy the bounded profile."""


@dataclass(frozen=True, slots=True)
class SosProfile:
    endpoint: str
    collection_name: str
    title: str
    description: str | None

    @property
    def offering(self) -> str:
        return f"{self.endpoint}#offering"

    @property
    def procedure(self) -> str:
        return f"{self.endpoint}#procedure"

    @property
    def observed_property(self) -> str:
        return f"{self.endpoint}#observed-property"


def observation_profile(
    collection: FeatureCollection,
    *,
    endpoint: str,
    collection_name: str,
    title: str,
    description: str | None,
) -> SosProfile:
    """Require an explicit scalar observation schema and a safe HTTPS endpoint."""

    parsed = urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username:
        raise SosProfileError("SOS endpoint is invalid")
    fields = {field.name: field for field in collection.fields}
    phenomenon_time = fields.get(SOS_PHENOMENON_TIME_FIELD)
    result = fields.get(SOS_RESULT_FIELD)
    unit = fields.get(SOS_RESULT_UNIT_FIELD)
    if phenomenon_time is None or phenomenon_time.type != "string" or not phenomenon_time.required:
        raise SosProfileError(
            f"SOS profile requires a required string {SOS_PHENOMENON_TIME_FIELD} field"
        )
    if result is None or result.type not in {"integer", "number"} or not result.required:
        raise SosProfileError(f"SOS profile requires a required numeric {SOS_RESULT_FIELD} field")
    if unit is not None and unit.type != "string":
        raise SosProfileError(f"optional {SOS_RESULT_UNIT_FIELD} field must be a string")
    return SosProfile(endpoint, collection_name, title, description)


def capabilities_document(profile: SosProfile) -> bytes:
    root = ET.Element(_q("sos", "Capabilities"), {"version": SOS_VERSION})
    identification = ET.SubElement(root, _q("ows", "ServiceIdentification"))
    ET.SubElement(identification, _q("ows", "Title")).text = profile.title
    if profile.description:
        ET.SubElement(identification, _q("ows", "Abstract")).text = profile.description
    ET.SubElement(identification, _q("ows", "ServiceType")).text = "SOS"
    ET.SubElement(identification, _q("ows", "ServiceTypeVersion")).text = SOS_VERSION
    ET.SubElement(identification, _q("ows", "Fees")).text = "NONE"
    ET.SubElement(
        identification, _q("ows", "AccessConstraints")
    ).text = "Authenticated project membership required"

    operations = ET.SubElement(root, _q("ows", "OperationsMetadata"))
    for name in ("GetCapabilities", "DescribeSensor", "GetObservation"):
        operation = ET.SubElement(operations, _q("ows", "Operation"), {"name": name})
        dcp = ET.SubElement(operation, _q("ows", "DCP"))
        http = ET.SubElement(dcp, _q("ows", "HTTP"))
        ET.SubElement(
            http,
            _q("ows", "Get"),
            {_q("xlink", "href"): profile.endpoint},
        )

    contents_wrapper = ET.SubElement(root, _q("sos", "contents"))
    contents = ET.SubElement(contents_wrapper, _q("sos", "Contents"))
    ET.SubElement(
        contents, _q("swes", "procedureDescriptionFormat")
    ).text = SOS_PROCEDURE_DESCRIPTION_FORMAT
    ET.SubElement(contents, _q("swes", "observableProperty")).text = profile.observed_property
    offering_wrapper = ET.SubElement(contents, _q("swes", "offering"))
    offering = ET.SubElement(offering_wrapper, _q("sos", "ObservationOffering"))
    ET.SubElement(offering, _q("swes", "identifier")).text = profile.offering
    ET.SubElement(offering, _q("swes", "name")).text = profile.title
    ET.SubElement(offering, _q("swes", "procedure")).text = profile.procedure
    ET.SubElement(
        offering, _q("swes", "procedureDescriptionFormat")
    ).text = SOS_PROCEDURE_DESCRIPTION_FORMAT
    ET.SubElement(offering, _q("swes", "observableProperty")).text = profile.observed_property
    ET.SubElement(offering, _q("sos", "responseFormat")).text = SOS_RESPONSE_FORMAT
    ET.SubElement(offering, _q("sos", "observationType")).text = SOS_OBSERVATION_TYPE
    ET.SubElement(contents, _q("sos", "responseFormat")).text = SOS_RESPONSE_FORMAT
    ET.SubElement(contents, _q("sos", "observationType")).text = SOS_OBSERVATION_TYPE
    return _xml(root)


def describe_sensor_document(profile: SosProfile) -> bytes:
    root = ET.Element(_q("swes", "DescribeSensorResponse"))
    ET.SubElement(
        root, _q("swes", "procedureDescriptionFormat")
    ).text = SOS_PROCEDURE_DESCRIPTION_FORMAT
    description = ET.SubElement(root, _q("swes", "description"))
    sensor_description = ET.SubElement(description, _q("swes", "SensorDescription"))
    data = ET.SubElement(sensor_description, _q("swes", "data"))
    component = ET.SubElement(
        data,
        _q("sml", "PhysicalComponent"),
        {_q("gml", "id"): "opengeo-procedure"},
    )
    ET.SubElement(component, _q("gml", "description")).text = (
        profile.description or f"Governed observation procedure for {profile.title}"
    )
    ET.SubElement(
        component,
        _q("gml", "identifier"),
        {"codeSpace": profile.endpoint},
    ).text = profile.procedure
    ET.SubElement(component, _q("gml", "name")).text = profile.title
    return _xml(root)


def observation_document(profile: SosProfile, page: FeaturePage) -> bytes:
    if page.number_matched > SOS_MAX_OBSERVATIONS:
        raise SosProfileError(
            f"SOS response exceeds the {SOS_MAX_OBSERVATIONS}-observation profile limit"
        )
    root = ET.Element(_q("sos", "GetObservationResponse"))
    for feature in page.features:
        wrapper = ET.SubElement(root, _q("sos", "observationData"))
        observation = ET.SubElement(
            wrapper,
            _q("om", "OM_Observation"),
            {_q("gml", "id"): f"observation-{feature.feature_id}"},
        )
        ET.SubElement(
            observation,
            _q("om", "type"),
            {_q("xlink", "href"): SOS_OBSERVATION_TYPE},
        )
        phenomenon_time = _observation_time(feature)
        phenomenon = ET.SubElement(observation, _q("om", "phenomenonTime"))
        time_id = f"phenomenon-{feature.feature_id}"
        instant = ET.SubElement(
            phenomenon,
            _q("gml", "TimeInstant"),
            {_q("gml", "id"): time_id},
        )
        ET.SubElement(instant, _q("gml", "timePosition")).text = phenomenon_time
        ET.SubElement(
            observation,
            _q("om", "resultTime"),
            {_q("xlink", "href"): f"#{time_id}"},
        )
        ET.SubElement(
            observation,
            _q("om", "procedure"),
            {_q("xlink", "href"): profile.procedure},
        )
        ET.SubElement(
            observation,
            _q("om", "observedProperty"),
            {_q("xlink", "href"): profile.observed_property},
        )
        ET.SubElement(
            observation,
            _q("om", "featureOfInterest"),
            {
                _q("xlink", "href"): (
                    f"{profile.endpoint.rsplit('/sos/', 1)[0]}/ogc/collections/"
                    f"{profile.collection_name}/items/{feature.feature_id}"
                )
            },
        )
        result, unit = _observation_result(feature)
        ET.SubElement(
            observation,
            _q("om", "result"),
            {_q("xsi", "type"): "gml:MeasureType", "uom": unit},
        ).text = result
    return _xml(root)


def exception_report(code: str, locator: str, message: str) -> bytes:
    root = ET.Element(_q("ows", "ExceptionReport"), {"version": SOS_VERSION})
    exception = ET.SubElement(
        root,
        _q("ows", "Exception"),
        {"exceptionCode": code, "locator": locator[:100]},
    )
    ET.SubElement(exception, _q("ows", "ExceptionText")).text = message
    return _xml(root)


def _observation_time(feature: FeatureRecord) -> str:
    value = feature.properties.get(SOS_PHENOMENON_TIME_FIELD)
    if not isinstance(value, str) or len(value) > 64:
        raise SosProfileError(
            f"observation {feature.feature_id} has an invalid {SOS_PHENOMENON_TIME_FIELD}"
        )
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SosProfileError(
            f"observation {feature.feature_id} has an invalid {SOS_PHENOMENON_TIME_FIELD}"
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SosProfileError(
            f"observation {feature.feature_id} requires an offset-aware phenomenon time"
        )
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _observation_result(feature: FeatureRecord) -> tuple[str, str]:
    value = feature.properties.get(SOS_RESULT_FIELD)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise SosProfileError(f"observation {feature.feature_id} has an invalid {SOS_RESULT_FIELD}")
    number = float(value)
    if not math.isfinite(number):
        raise SosProfileError(
            f"observation {feature.feature_id} has a non-finite {SOS_RESULT_FIELD}"
        )
    unit = feature.properties.get(SOS_RESULT_UNIT_FIELD, SOS_DEFAULT_UNIT)
    if not isinstance(unit, str) or not _safe_uri(unit):
        raise SosProfileError(
            f"observation {feature.feature_id} has an invalid {SOS_RESULT_UNIT_FIELD}"
        )
    result = str(value) if isinstance(value, int) else format(value, ".15g")
    return result, unit


def _safe_uri(value: str) -> bool:
    if not 1 <= len(value) <= 300 or any(character.isspace() for character in value):
        return False
    parsed = urlsplit(value)
    return bool(parsed.scheme) and parsed.username is None and parsed.password is None


def _q(prefix: str, local_name: str) -> str:
    return f"{{{NS[prefix]}}}{local_name}"


def _xml(root: ET.Element) -> bytes:
    for element in root.iter():
        identifier = element.attrib.get(_q("gml", "id"))
        if identifier is not None and not _GML_ID.fullmatch(identifier):
            raise SosProfileError("generated GML identifier is invalid")
    return cast(
        bytes,
        ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True),
    )
