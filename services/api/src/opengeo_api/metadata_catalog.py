import ipaddress
import math
import re
from datetime import datetime
from typing import Any, cast
from urllib.parse import urlsplit

OPEN_GEO_CATALOG_SCHEMA_VERSION = "1.3.0"
OPEN_GEO_CATALOG_SCHEMA_VERSIONS = {
    "1.0.0",
    "1.1.0",
    "1.2.0",
    OPEN_GEO_CATALOG_SCHEMA_VERSION,
}
OPEN_GEO_CATALOG_NAMESPACE = "opengeo"

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_MEDIA_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[^\s=;]+=[^;]+)*$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SENSITIVITY = {"public", "internal", "confidential", "restricted"}
_CATALOG_FIELDS_1_0 = {
    "schemaVersion",
    "contacts",
    "distributions",
    "referenceSystems",
    "lineage",
    "quality",
    "updateFrequency",
    "sensitivity",
}
_CATALOG_FIELDS_1_1 = {*_CATALOG_FIELDS_1_0, "funding", "acquisition"}
_FUNDER_IDENTIFIER_TYPES = {"ISNI", "GRID", "ROR", "Crossref Funder ID", "Other"}
_ACQUISITION_STATUSES = {
    "completed",
    "historicalArchive",
    "obsolete",
    "onGoing",
    "planned",
    "required",
    "underDevelopment",
    "final",
    "pending",
    "retired",
    "superseded",
    "tentative",
    "valid",
    "accepted",
    "notAccepted",
    "withdrawn",
    "proposed",
}
_ACQUISITION_OPERATION_TYPES = {"real", "simulated", "synthesized"}
_ACQUISITION_GEOMETRY_TYPES = {"areal", "linear", "point", "strip"}
_ACQUISITION_OBJECTIVE_TYPES = {
    "instantaniousCollection",
    "persistantView",
    "survey",
}
_ACQUISITION_PRIORITIES = {
    "critical",
    "highImportance",
    "mediumImportance",
    "lowImportance",
}
_ACQUISITION_EVENT_TRIGGERS = {"automatic", "manual", "PreProgrammed"}
_ACQUISITION_EVENT_CONTEXTS = {"acquisition", "pass", "wayPoint"}
_ACQUISITION_EVENT_SEQUENCES = {"start", "end", "instantaneous"}


class CatalogMetadataInvalid(ValueError):
    pass


def catalog_metadata(extensions: dict[str, Any]) -> dict[str, Any]:
    """Return validated native catalog metadata, or an empty mapping when absent."""
    value = extensions.get(OPEN_GEO_CATALOG_NAMESPACE)
    if value is None:
        return {}
    return validate_catalog_metadata(value)


def validate_catalog_extensions(extensions: dict[str, Any]) -> dict[str, Any]:
    """Fail closed and normalize the reserved ``opengeo`` extension when present."""
    result = dict(extensions)
    if OPEN_GEO_CATALOG_NAMESPACE in extensions:
        result[OPEN_GEO_CATALOG_NAMESPACE] = validate_catalog_metadata(
            extensions[OPEN_GEO_CATALOG_NAMESPACE]
        )
    return result


def validate_catalog_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid("metadata extensions.opengeo must be an object")
    schema_version = value.get("schemaVersion")
    if schema_version not in OPEN_GEO_CATALOG_SCHEMA_VERSIONS:
        raise CatalogMetadataInvalid(
            "metadata extensions.opengeo.schemaVersion must be 1.0.0, 1.1.0, 1.2.0, or 1.3.0"
        )
    allowed = _CATALOG_FIELDS_1_1 if schema_version != "1.0.0" else _CATALOG_FIELDS_1_0
    unknown = set(value) - allowed
    if unknown:
        raise CatalogMetadataInvalid(
            f"metadata extensions.opengeo contains unknown field {sorted(unknown)[0]}"
        )

    result: dict[str, Any] = {"schemaVersion": schema_version}
    if "contacts" in value:
        result["contacts"] = _contacts(value["contacts"])
    if "distributions" in value:
        result["distributions"] = _distributions(value["distributions"])
    if "referenceSystems" in value:
        result["referenceSystems"] = _reference_systems(value["referenceSystems"])
    if "lineage" in value:
        result["lineage"] = _lineage(value["lineage"])
    if "quality" in value:
        result["quality"] = _quality(value["quality"])
    if "updateFrequency" in value:
        result["updateFrequency"] = _string(
            value["updateFrequency"], 1, 300, "opengeo.updateFrequency"
        )
    if "sensitivity" in value:
        sensitivity = value["sensitivity"]
        if sensitivity not in _SENSITIVITY:
            raise CatalogMetadataInvalid(
                "metadata extensions.opengeo.sensitivity must be public, internal, "
                "confidential, or restricted"
            )
        result["sensitivity"] = sensitivity
    if "funding" in value:
        result["funding"] = _funding(value["funding"])
    if "acquisition" in value:
        result["acquisition"] = _acquisition(
            value["acquisition"],
            planning=schema_version in {"1.2.0", "1.3.0"},
            event_graph=schema_version == "1.3.0",
        )
    return result


def _contacts(value: Any) -> list[dict[str, str]]:
    records = _object_list(value, 32, "opengeo.contacts")
    allowed = {"name", "organization", "email", "role", "identifier"}
    result: list[dict[str, str]] = []
    for index, record in enumerate(records):
        _known_fields(record, allowed, f"opengeo.contacts[{index}]")
        contact = {
            field: _string(raw, 1, 300, f"opengeo.contacts[{index}].{field}")
            for field, raw in record.items()
        }
        if "name" not in contact and "organization" not in contact:
            raise CatalogMetadataInvalid(
                f"metadata opengeo.contacts[{index}] requires name or organization"
            )
        email = contact.get("email")
        if email is not None and _EMAIL.fullmatch(email) is None:
            raise CatalogMetadataInvalid(f"metadata opengeo.contacts[{index}].email is invalid")
        result.append(contact)
    return result


def _distributions(value: Any) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.distributions")
    allowed = {
        "identifier",
        "title",
        "accessUrl",
        "downloadUrl",
        "mediaType",
        "format",
        "byteSize",
        "checksumSha256",
        "license",
    }
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.distributions[{index}]"
        _known_fields(record, allowed, path)
        distribution: dict[str, Any] = {}
        for field, raw in record.items():
            if field == "byteSize":
                if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= 10**18:
                    raise CatalogMetadataInvalid(f"metadata {path}.byteSize is invalid")
                distribution[field] = raw
            else:
                maximum = 2_048 if field in {"accessUrl", "downloadUrl"} else 1_000
                distribution[field] = _string(raw, 1, maximum, f"{path}.{field}")
        if "accessUrl" not in distribution and "downloadUrl" not in distribution:
            raise CatalogMetadataInvalid(f"metadata {path} requires accessUrl or downloadUrl")
        for field in ("accessUrl", "downloadUrl"):
            if field in distribution:
                _public_https_url(cast(str, distribution[field]), f"{path}.{field}")
        media_type = distribution.get("mediaType")
        if isinstance(media_type, str) and _MEDIA_TYPE.fullmatch(media_type) is None:
            raise CatalogMetadataInvalid(f"metadata {path}.mediaType is invalid")
        checksum = distribution.get("checksumSha256")
        if isinstance(checksum, str) and _SHA256.fullmatch(checksum) is None:
            raise CatalogMetadataInvalid(f"metadata {path}.checksumSha256 is invalid")
        result.append(distribution)
    return result


def _reference_systems(value: Any) -> list[dict[str, str]]:
    records = _object_list(value, 16, "opengeo.referenceSystems")
    result: list[dict[str, str]] = []
    for index, record in enumerate(records):
        path = f"opengeo.referenceSystems[{index}]"
        _known_fields(record, {"identifier", "uri"}, path)
        identifier = _string(record.get("identifier"), 1, 300, f"{path}.identifier")
        reference: dict[str, str] = {"identifier": identifier}
        if "uri" in record:
            uri = _string(record["uri"], 1, 2_048, f"{path}.uri")
            _identifier_uri(uri, f"{path}.uri")
            reference["uri"] = uri
        result.append(reference)
    return result


def _lineage(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid("metadata opengeo.lineage must be an object")
    _known_fields(value, {"statement", "sources"}, "opengeo.lineage")
    statement = _string(value.get("statement"), 1, 4_000, "opengeo.lineage.statement")
    result: dict[str, Any] = {"statement": statement}
    if "sources" in value:
        sources = value["sources"]
        if not isinstance(sources, list) or len(sources) > 32:
            raise CatalogMetadataInvalid(
                "metadata opengeo.lineage.sources must contain at most 32 identifiers"
            )
        result["sources"] = [
            _string(source, 1, 2_048, f"opengeo.lineage.sources[{index}]")
            for index, source in enumerate(sources)
        ]
    return result


def _quality(value: Any) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.quality")
    allowed = {"measure", "result", "unit", "description"}
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.quality[{index}]"
        _known_fields(record, allowed, path)
        measure = _string(record.get("measure"), 1, 300, f"{path}.measure")
        raw_result = record.get("result")
        if isinstance(raw_result, str):
            quality_result: str | int | float | bool = _string(
                raw_result, 1, 1_000, f"{path}.result"
            )
        elif isinstance(raw_result, bool | int | float):
            if isinstance(raw_result, float) and not math.isfinite(raw_result):
                raise CatalogMetadataInvalid(f"metadata {path}.result must be finite")
            quality_result = raw_result
        else:
            raise CatalogMetadataInvalid(f"metadata {path}.result is invalid")
        quality: dict[str, Any] = {"measure": measure, "result": quality_result}
        for field in ("unit", "description"):
            if field in record:
                quality[field] = _string(record[field], 1, 1_000, f"{path}.{field}")
        result.append(quality)
    return result


def _funding(value: Any) -> list[dict[str, str]]:
    records = _object_list(value, 32, "opengeo.funding")
    allowed = {
        "funderName",
        "funderIdentifier",
        "funderIdentifierType",
        "schemeUri",
        "awardNumber",
        "awardUri",
        "awardTitle",
    }
    result: list[dict[str, str]] = []
    for index, record in enumerate(records):
        path = f"opengeo.funding[{index}]"
        _known_fields(record, allowed, path)
        funding: dict[str, str] = {
            "funderName": _string(record.get("funderName"), 1, 300, f"{path}.funderName")
        }
        for field, maximum in (
            ("funderIdentifier", 2_048),
            ("funderIdentifierType", 100),
            ("schemeUri", 2_048),
            ("awardNumber", 300),
            ("awardUri", 2_048),
            ("awardTitle", 1_000),
        ):
            if field in record:
                funding[field] = _string(record[field], 1, maximum, f"{path}.{field}")
        if "funderIdentifier" in funding:
            identifier_type = funding.get("funderIdentifierType")
            if identifier_type not in _FUNDER_IDENTIFIER_TYPES:
                raise CatalogMetadataInvalid(
                    f"metadata {path}.funderIdentifierType is required and unsupported"
                )
        elif "funderIdentifierType" in funding or "schemeUri" in funding:
            raise CatalogMetadataInvalid(
                f"metadata {path} requires funderIdentifier for its identifier metadata"
            )
        if "awardUri" in funding and "awardNumber" not in funding:
            raise CatalogMetadataInvalid(
                f"metadata {path} requires awardNumber when awardUri is present"
            )
        for field in ("schemeUri", "awardUri"):
            if field in funding:
                _identifier_uri(funding[field], f"{path}.{field}")
        result.append(funding)
    return result


def _acquisition(value: Any, *, planning: bool, event_graph: bool) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid("metadata opengeo.acquisition must be an object")
    allowed = {"instruments", "platforms", "operations"}
    if planning:
        allowed.update({"plans", "objectives", "requirements"})
    if event_graph:
        allowed.update({"events", "platformPasses"})
    _known_fields(value, allowed, "opengeo.acquisition")
    result: dict[str, Any] = {}
    instruments = _acquisition_records(
        value.get("instruments", []),
        "instruments",
        32,
        required={"identifier", "type"},
        allowed={"identifier", "type", "description"},
    )
    if instruments:
        result["instruments"] = instruments
    instrument_identifiers = {record["identifier"] for record in instruments}
    platforms = _object_list(value.get("platforms", []), 16, "opengeo.acquisition.platforms")
    normalized_platforms: list[dict[str, Any]] = []
    for index, record in enumerate(platforms):
        path = f"opengeo.acquisition.platforms[{index}]"
        _known_fields(
            record,
            {"identifier", "description", "instrumentIdentifiers"},
            path,
        )
        instrument_values = record.get("instrumentIdentifiers")
        if not isinstance(instrument_values, list) or not 1 <= len(instrument_values) <= 32:
            raise CatalogMetadataInvalid(
                f"metadata {path}.instrumentIdentifiers must contain 1 to 32 identifiers"
            )
        references = [
            _string(item, 1, 300, f"{path}.instrumentIdentifiers[{item_index}]")
            for item_index, item in enumerate(instrument_values)
        ]
        if len(set(references)) != len(references):
            raise CatalogMetadataInvalid(f"metadata {path}.instrumentIdentifiers must be unique")
        unknown_references = set(references) - instrument_identifiers
        if unknown_references:
            raise CatalogMetadataInvalid(
                f"metadata {path} references unknown instrument {sorted(unknown_references)[0]}"
            )
        normalized_platforms.append(
            {
                "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier"),
                "description": _string(record.get("description"), 1, 1_000, f"{path}.description"),
                "instrumentIdentifiers": references,
            }
        )
    _unique_identifiers(normalized_platforms, "opengeo.acquisition.platforms")
    if normalized_platforms:
        result["platforms"] = normalized_platforms
    platform_passes = _acquisition_platform_passes(
        value.get("platformPasses", []) if event_graph else []
    )
    if platform_passes:
        result["platformPasses"] = platform_passes
    pass_identifiers = {record["identifier"] for record in platform_passes}
    objectives = _acquisition_objectives(
        value.get("objectives", []),
        instrument_identifiers,
        pass_identifiers,
        event_graph=event_graph,
    )
    if objectives:
        result["objectives"] = objectives
    objective_identifiers = {record["identifier"] for record in objectives}
    events = _acquisition_events(
        value.get("events", []) if event_graph else [],
        pass_identifiers,
        instrument_identifiers,
        objective_identifiers,
    )
    if events:
        result["events"] = events
    event_identifiers = {record["identifier"] for record in events}
    for collection, name in ((platform_passes, "platformPasses"), (objectives, "objectives")):
        for index, record in enumerate(collection):
            unknown = set(record.get("eventIdentifiers", [])) - event_identifiers
            if unknown:
                raise CatalogMetadataInvalid(
                    f"metadata opengeo.acquisition.{name}[{index}] references unknown event "
                    f"{sorted(unknown)[0]}"
                )
    operations = _acquisition_operations(
        value.get("operations", []), event_identifiers, event_graph=event_graph
    )
    if operations:
        result["operations"] = operations
    operation_identifiers = {record["identifier"] for record in operations}
    requirements = _acquisition_requirements(value.get("requirements", []))
    if requirements:
        result["requirements"] = requirements
    requirement_identifiers = {record["identifier"] for record in requirements}
    plans = _acquisition_plans(
        value.get("plans", []), operation_identifiers, requirement_identifiers
    )
    if plans:
        result["plans"] = plans
    if not result:
        raise CatalogMetadataInvalid(
            "metadata opengeo.acquisition requires an instrument, platform, or operation"
        )
    return result


def _acquisition_objectives(
    value: Any,
    instrument_identifiers: set[str],
    pass_identifiers: set[str],
    *,
    event_graph: bool,
) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.objectives")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.objectives[{index}]"
        allowed = {"identifier", "priority", "types", "functions", "instrumentIdentifiers"}
        if event_graph:
            allowed.update({"passIdentifiers", "eventIdentifiers"})
        _known_fields(record, allowed, path)
        objective: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier")
        }
        if "priority" in record:
            objective["priority"] = _string(record["priority"], 1, 300, f"{path}.priority")
        if "types" in record:
            types = _string_list(record["types"], 8, 300, f"{path}.types")
            unsupported = set(types) - _ACQUISITION_OBJECTIVE_TYPES
            if unsupported:
                raise CatalogMetadataInvalid(
                    f"metadata {path}.types contains unsupported value {sorted(unsupported)[0]}"
                )
            objective["types"] = types
        if "functions" in record:
            objective["functions"] = _string_list(
                record["functions"], 16, 1_000, f"{path}.functions"
            )
        if "instrumentIdentifiers" in record:
            references = _string_list(
                record["instrumentIdentifiers"],
                32,
                300,
                f"{path}.instrumentIdentifiers",
            )
            unknown = set(references) - instrument_identifiers
            if unknown:
                raise CatalogMetadataInvalid(
                    f"metadata {path} references unknown instrument {sorted(unknown)[0]}"
                )
            objective["instrumentIdentifiers"] = references
        for field, identifiers, singular in (
            ("passIdentifiers", pass_identifiers, "platform pass"),
            ("eventIdentifiers", None, "event"),
        ):
            if field in record:
                references = _string_list(record[field], 32, 300, f"{path}.{field}")
                if identifiers is not None:
                    unknown = set(references) - identifiers
                    if unknown:
                        raise CatalogMetadataInvalid(
                            f"metadata {path} references unknown {singular} {sorted(unknown)[0]}"
                        )
                objective[field] = references
        result.append(objective)
    _unique_identifiers(result, "opengeo.acquisition.objectives")
    return result


def _acquisition_platform_passes(value: Any) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.platformPasses")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.platformPasses[{index}]"
        _known_fields(record, {"identifier", "eventIdentifiers"}, path)
        platform_pass: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier")
        }
        if "eventIdentifiers" in record:
            platform_pass["eventIdentifiers"] = _string_list(
                record["eventIdentifiers"], 32, 300, f"{path}.eventIdentifiers"
            )
        result.append(platform_pass)
    _unique_identifiers(result, "opengeo.acquisition.platformPasses")
    return result


def _acquisition_events(
    value: Any,
    pass_identifiers: set[str],
    instrument_identifiers: set[str],
    objective_identifiers: set[str],
) -> list[dict[str, Any]]:
    records = _object_list(value, 64, "opengeo.acquisition.events")
    result: list[dict[str, Any]] = []
    required = {"identifier", "trigger", "context", "sequence", "time"}
    allowed = {
        *required,
        "passIdentifier",
        "instrumentIdentifiers",
        "objectiveIdentifiers",
    }
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.events[{index}]"
        _known_fields(record, allowed, path)
        missing = required - set(record)
        if missing:
            raise CatalogMetadataInvalid(f"metadata {path} requires {sorted(missing)[0]}")
        trigger = _string(record["trigger"], 1, 300, f"{path}.trigger")
        context = _string(record["context"], 1, 300, f"{path}.context")
        sequence = _string(record["sequence"], 1, 300, f"{path}.sequence")
        for field, actual, supported in (
            ("trigger", trigger, _ACQUISITION_EVENT_TRIGGERS),
            ("context", context, _ACQUISITION_EVENT_CONTEXTS),
            ("sequence", sequence, _ACQUISITION_EVENT_SEQUENCES),
        ):
            if actual not in supported:
                raise CatalogMetadataInvalid(f"metadata {path}.{field} is unsupported")
        _, event_time = _date_time(record["time"], f"{path}.time")
        event: dict[str, Any] = {
            "identifier": _string(record["identifier"], 1, 300, f"{path}.identifier"),
            "trigger": trigger,
            "context": context,
            "sequence": sequence,
            "time": event_time,
        }
        if "passIdentifier" in record:
            pass_identifier = _string(record["passIdentifier"], 1, 300, f"{path}.passIdentifier")
            if pass_identifier not in pass_identifiers:
                raise CatalogMetadataInvalid(
                    f"metadata {path} references unknown platform pass {pass_identifier}"
                )
            event["passIdentifier"] = pass_identifier
        for field, identifiers, singular in (
            ("instrumentIdentifiers", instrument_identifiers, "instrument"),
            ("objectiveIdentifiers", objective_identifiers, "objective"),
        ):
            if field in record:
                references = _string_list(record[field], 32, 300, f"{path}.{field}")
                unknown = set(references) - identifiers
                if unknown:
                    raise CatalogMetadataInvalid(
                        f"metadata {path} references unknown {singular} {sorted(unknown)[0]}"
                    )
                event[field] = references
        result.append(event)
    _unique_identifiers(result, "opengeo.acquisition.events")
    return result


def _acquisition_operations(
    value: Any, event_identifiers: set[str], *, event_graph: bool
) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.operations")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.operations[{index}]"
        allowed = {"identifier", "description", "status", "type"}
        if event_graph:
            allowed.add("eventIdentifiers")
        _known_fields(record, allowed, path)
        operation: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier"),
            "status": _string(record.get("status"), 1, 300, f"{path}.status"),
        }
        if operation["status"] not in _ACQUISITION_STATUSES:
            raise CatalogMetadataInvalid(f"metadata {path}.status is unsupported")
        if "description" in record:
            operation["description"] = _string(
                record["description"], 1, 1_000, f"{path}.description"
            )
        if "type" in record:
            operation_type = _string(record["type"], 1, 300, f"{path}.type")
            if operation_type not in _ACQUISITION_OPERATION_TYPES:
                raise CatalogMetadataInvalid(f"metadata {path}.type is unsupported")
            operation["type"] = operation_type
        if "eventIdentifiers" in record:
            references = _string_list(
                record["eventIdentifiers"], 64, 300, f"{path}.eventIdentifiers"
            )
            unknown = set(references) - event_identifiers
            if unknown:
                raise CatalogMetadataInvalid(
                    f"metadata {path} references unknown event {sorted(unknown)[0]}"
                )
            operation["eventIdentifiers"] = references
        result.append(operation)
    _unique_identifiers(result, "opengeo.acquisition.operations")
    return result


def _acquisition_requirements(value: Any) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.requirements")
    result: list[dict[str, Any]] = []
    required = {
        "identifier",
        "requestors",
        "recipients",
        "priority",
        "requestedDate",
        "expiryDate",
    }
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.requirements[{index}]"
        _known_fields(record, required, path)
        missing = required - set(record)
        if missing:
            raise CatalogMetadataInvalid(f"metadata {path} requires {sorted(missing)[0]}")
        priority = _string(record["priority"], 1, 300, f"{path}.priority")
        if priority not in _ACQUISITION_PRIORITIES:
            raise CatalogMetadataInvalid(f"metadata {path}.priority is unsupported")
        requested_date = record["requestedDate"]
        if not isinstance(requested_date, dict):
            raise CatalogMetadataInvalid(f"metadata {path}.requestedDate must be an object")
        _known_fields(
            requested_date,
            {"requestedDateOfCollection", "latestAcceptableDate"},
            f"{path}.requestedDate",
        )
        if set(requested_date) != {
            "requestedDateOfCollection",
            "latestAcceptableDate",
        }:
            raise CatalogMetadataInvalid(
                f"metadata {path}.requestedDate requires requestedDateOfCollection "
                "and latestAcceptableDate"
            )
        requested, requested_value = _date_time(
            requested_date["requestedDateOfCollection"],
            f"{path}.requestedDate.requestedDateOfCollection",
        )
        latest, latest_value = _date_time(
            requested_date["latestAcceptableDate"],
            f"{path}.requestedDate.latestAcceptableDate",
        )
        expiry, expiry_value = _date_time(record["expiryDate"], f"{path}.expiryDate")
        if requested > latest or latest > expiry:
            raise CatalogMetadataInvalid(
                f"metadata {path} dates must satisfy requestedDateOfCollection <= "
                "latestAcceptableDate <= expiryDate"
            )
        result.append(
            {
                "identifier": _string(record["identifier"], 1, 300, f"{path}.identifier"),
                "requestors": _required_string_list(
                    record["requestors"], 16, 300, f"{path}.requestors"
                ),
                "recipients": _required_string_list(
                    record["recipients"], 16, 300, f"{path}.recipients"
                ),
                "priority": priority,
                "requestedDate": {
                    "requestedDateOfCollection": requested_value,
                    "latestAcceptableDate": latest_value,
                },
                "expiryDate": expiry_value,
            }
        )
    _unique_identifiers(result, "opengeo.acquisition.requirements")
    return result


def _acquisition_plans(
    value: Any,
    operation_identifiers: set[str],
    requirement_identifiers: set[str],
) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.plans")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.plans[{index}]"
        _known_fields(
            record,
            {
                "identifier",
                "status",
                "type",
                "operationIdentifiers",
                "requirementIdentifiers",
            },
            path,
        )
        plan: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier"),
            "status": _string(record.get("status"), 1, 300, f"{path}.status"),
        }
        if plan["status"] not in _ACQUISITION_STATUSES:
            raise CatalogMetadataInvalid(f"metadata {path}.status is unsupported")
        if "type" in record:
            plan_type = _string(record["type"], 1, 300, f"{path}.type")
            if plan_type not in _ACQUISITION_GEOMETRY_TYPES:
                raise CatalogMetadataInvalid(f"metadata {path}.type is unsupported")
            plan["type"] = plan_type
        for field, identifiers in (
            ("operationIdentifiers", operation_identifiers),
            ("requirementIdentifiers", requirement_identifiers),
        ):
            if field in record:
                references = _string_list(record[field], 32, 300, f"{path}.{field}")
                unknown = set(references) - identifiers
                if unknown:
                    singular = "operation" if field == "operationIdentifiers" else "requirement"
                    raise CatalogMetadataInvalid(
                        f"metadata {path} references unknown {singular} {sorted(unknown)[0]}"
                    )
                plan[field] = references
        result.append(plan)
    _unique_identifiers(result, "opengeo.acquisition.plans")
    return result


def _acquisition_records(
    value: Any,
    name: str,
    maximum: int,
    *,
    required: set[str],
    allowed: set[str],
) -> list[dict[str, str]]:
    records = _object_list(value, maximum, f"opengeo.acquisition.{name}")
    result: list[dict[str, str]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.{name}[{index}]"
        _known_fields(record, allowed, path)
        missing = required - set(record)
        if missing:
            raise CatalogMetadataInvalid(f"metadata {path} requires {sorted(missing)[0]}")
        normalized = {
            field: _string(raw, 1, 1_000 if field == "description" else 300, f"{path}.{field}")
            for field, raw in record.items()
        }
        result.append(normalized)
    _unique_identifiers(result, f"opengeo.acquisition.{name}")
    return result


def _unique_identifiers(records: list[dict[str, Any]], path: str) -> None:
    identifiers = [record["identifier"] for record in records]
    if len(set(identifiers)) != len(identifiers):
        raise CatalogMetadataInvalid(f"metadata {path} identifiers must be unique")


def _string_list(value: Any, maximum: int, item_maximum: int, path: str) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise CatalogMetadataInvalid(f"metadata {path} must contain at most {maximum} strings")
    result = [
        _string(item, 1, item_maximum, f"{path}[{index}]") for index, item in enumerate(value)
    ]
    if len(set(result)) != len(result):
        raise CatalogMetadataInvalid(f"metadata {path} values must be unique")
    return result


def _required_string_list(value: Any, maximum: int, item_maximum: int, path: str) -> list[str]:
    result = _string_list(value, maximum, item_maximum, path)
    if not result:
        raise CatalogMetadataInvalid(f"metadata {path} requires at least one string")
    return result


def _date_time(value: Any, path: str) -> tuple[datetime, str]:
    normalized = _string(value, 1, 100, path)
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        raise CatalogMetadataInvalid(f"metadata {path} must be an ISO 8601 date-time") from None
    if parsed.utcoffset() is None:
        raise CatalogMetadataInvalid(f"metadata {path} must include a timezone offset")
    return parsed, normalized


def _object_list(value: Any, maximum: int, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > maximum:
        raise CatalogMetadataInvalid(f"metadata {path} must contain at most {maximum} objects")
    if any(not isinstance(item, dict) for item in value):
        raise CatalogMetadataInvalid(f"metadata {path} values must be objects")
    return cast(list[dict[str, Any]], value)


def _known_fields(value: dict[str, Any], allowed: set[str], path: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise CatalogMetadataInvalid(f"metadata {path} contains unknown field {sorted(unknown)[0]}")


def _string(value: Any, minimum: int, maximum: int, path: str) -> str:
    if not isinstance(value, str):
        raise CatalogMetadataInvalid(f"metadata {path} must be a string")
    normalized = value.strip()
    if not minimum <= len(normalized) <= maximum:
        raise CatalogMetadataInvalid(f"metadata {path} length is invalid")
    return normalized


def _public_https_url(value: str, path: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise CatalogMetadataInvalid(
            f"metadata {path} must be a public HTTPS URL without credentials or fragments"
        )
    hostname = parsed.hostname.casefold().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise CatalogMetadataInvalid(f"metadata {path} must use a public hostname")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if "." not in hostname:
            raise CatalogMetadataInvalid(f"metadata {path} must use a public hostname") from None
        return
    if not address.is_global:
        raise CatalogMetadataInvalid(f"metadata {path} must use a public hostname")


def _identifier_uri(value: str, path: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme == "urn":
        if not parsed.path or " " in parsed.path:
            raise CatalogMetadataInvalid(f"metadata {path} must be an absolute identifier URI")
        return
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise CatalogMetadataInvalid(
            f"metadata {path} must be an HTTP(S) or URN identifier without credentials or fragments"
        )
