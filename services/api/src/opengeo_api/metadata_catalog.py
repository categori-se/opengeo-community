import ipaddress
import math
import re
from collections.abc import Collection
from datetime import date, datetime
from typing import Any, cast
from urllib.parse import urlsplit

OPEN_GEO_CATALOG_SCHEMA_VERSION = "1.9.0"
OPEN_GEO_CATALOG_SCHEMA_VERSIONS = {
    "1.0.0",
    "1.1.0",
    "1.2.0",
    "1.3.0",
    "1.4.0",
    "1.5.0",
    "1.6.0",
    "1.7.0",
    "1.8.0",
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
_ACQUISITION_PLAN_ID_CODE_SPACE = "urn:opengeo:catalog:acquisition-plan"
_CITATION_DATE_TYPES = {"creation", "publication", "revision"}
_CONTEXT_DATE_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?"
    r"(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))"
)
_ISO_TRANSFER_DURATION = re.compile(
    r"-?P(?=[0-9]|T[0-9])(?:[0-9]+Y)?(?:[0-9]+M)?(?:[0-9]+D)?"
    r"(?:T(?=[0-9])(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]+)?S)?)?"
)

_ISO_MEDIUM_DENSITY = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")

_ISO_ORDER_DATE_TIME = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T"
    r"(?:[0-2][0-9]:[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?)"
    r"(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))?"
)


ISO_QUALITY_REPORT_TYPES = frozenset(
    {
        "DQ_AbsoluteExternalPositionalAccuracy",
        "DQ_AccuracyOfATimeMeasurement",
        "DQ_CompletenessCommission",
        "DQ_CompletenessOmission",
        "DQ_ConceptualConsistency",
        "DQ_DomainConsistency",
        "DQ_FormatConsistency",
        "DQ_GriddedDataPositionalAccuracy",
        "DQ_NonQuantitativeAttributeCorrectness",
        "DQ_QuantitativeAttributeAccuracy",
        "DQ_RelativeInternalPositionalAccuracy",
        "DQ_TemporalConsistency",
        "DQ_TemporalValidity",
        "DQ_ThematicClassificationCorrectness",
        "DQ_TopologicalConsistency",
        "DQ_UsabilityElement",
        "DQ_Confidence",
        "DQ_Homogeneity",
        "DQ_Representativity",
    }
)
ISO_QUALITY_EVALUATION_TYPES = frozenset(
    {
        "DQ_EvaluationMethod",
        "DQ_AggregationDerivation",
        "DQ_FullInspection",
        "DQ_IndirectEvaluation",
        "DQ_SampleBasedInspection",
    }
)
_QUALITY_METAQUALITY_TYPES = {"DQ_Confidence", "DQ_Homogeneity", "DQ_Representativity"}
# XML 1.0 Fifth Edition NCName (Name without colon), including non-ASCII names.
_QUALITY_NAME_START = (
    "A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d"
    "\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef"
    "\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\U00010000-\U000effff"
)
_QUALITY_XML_ID = re.compile(
    f"[{_QUALITY_NAME_START}][{_QUALITY_NAME_START}\\.0-9\\-\u00b7\u0300-\u036f\u203f-\u2040]*"
)


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
            "metadata extensions.opengeo.schemaVersion must be "
            "1.0.0, 1.1.0, 1.2.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.8.0, or 1.9.0"
        )
    allowed = _CATALOG_FIELDS_1_1 if schema_version != "1.0.0" else _CATALOG_FIELDS_1_0
    if schema_version in {"1.6.0", "1.7.0", "1.8.0", "1.9.0"}:
        allowed = {*allowed, "qualityReports"}
    if schema_version in {"1.8.0", "1.9.0"}:
        allowed = {*allowed, "isoDistributionGroups"}
    unknown = set(value) - allowed
    if unknown:
        raise CatalogMetadataInvalid(
            f"metadata extensions.opengeo contains unknown field {sorted(unknown)[0]}"
        )

    result: dict[str, Any] = {"schemaVersion": schema_version}
    if "contacts" in value:
        result["contacts"] = _contacts(value["contacts"])
    if "distributions" in value:
        result["distributions"] = _distributions(
            value["distributions"],
            iso_transfer=schema_version in {"1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0"},
            offline_media=schema_version in {"1.7.0", "1.8.0", "1.9.0"},
        )
    if "referenceSystems" in value:
        result["referenceSystems"] = _reference_systems(value["referenceSystems"])
    if "lineage" in value:
        result["lineage"] = _lineage(value["lineage"])
    if "quality" in value:
        result["quality"] = _quality(value["quality"])
    if "qualityReports" in value:
        result["qualityReports"] = _quality_reports(
            value["qualityReports"], unit_references=schema_version == "1.9.0"
        )
    if "isoDistributionGroups" in value:
        quality_ids = {
            report["id"]
            for group in result.get("qualityReports", [])
            for report in group["reports"]
            if "id" in report
        }
        result["isoDistributionGroups"] = _iso_distribution_groups(
            value["isoDistributionGroups"],
            reserved_ids=quality_ids,
            rich_contacts=schema_version == "1.9.0",
        )
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
            planning=schema_version
            in {"1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0"},
            event_graph=schema_version in {"1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0"},
            context=schema_version in {"1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0"},
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


def _distributions(
    value: Any, *, iso_transfer: bool = False, offline_media: bool = False
) -> list[dict[str, Any]]:
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
    if iso_transfer:
        allowed.add("isoTransfer")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.distributions[{index}]"
        _known_fields(record, allowed, path)
        distribution: dict[str, Any] = {}
        for field, raw in record.items():
            if field == "isoTransfer":
                distribution[field] = _iso_transfer(
                    raw, f"{path}.isoTransfer", offline_media=offline_media
                )
            elif field == "byteSize":
                if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= 10**18:
                    raise CatalogMetadataInvalid(f"metadata {path}.byteSize is invalid")
                distribution[field] = raw
            else:
                maximum = 2_048 if field in {"accessUrl", "downloadUrl"} else 1_000
                distribution[field] = _string(raw, 1, maximum, f"{path}.{field}")
        if (
            "accessUrl" not in distribution
            and "downloadUrl" not in distribution
            and not (offline_media and distribution.get("isoTransfer", {}).get("offlineMedia"))
        ):
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


def _iso_transfer(value: Any, path: str, *, offline_media: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict) or not value:
        raise CatalogMetadataInvalid(f"metadata {path} must be a nonempty transfer object")
    allowed = {
        "unitsOfDistribution",
        "transferSizeMegabytes",
        "transferFrequency",
        "formats",
        "onlineResources",
        "projections",
    }
    if offline_media:
        allowed.add("offlineMedia")
    _known_fields(value, allowed, path)
    result: dict[str, Any] = {}
    if "unitsOfDistribution" in value:
        result["unitsOfDistribution"] = _string(
            value["unitsOfDistribution"], 1, 1_000, f"{path}.unitsOfDistribution"
        )
    if "transferSizeMegabytes" in value:
        size = _finite_number(value["transferSizeMegabytes"], f"{path}.transferSizeMegabytes")
        if size <= 0:
            raise CatalogMetadataInvalid(f"metadata {path}.transferSizeMegabytes must be positive")
        result["transferSizeMegabytes"] = size
    if "transferFrequency" in value:
        frequency = _string(value["transferFrequency"], 1, 100, f"{path}.transferFrequency")
        if _ISO_TRANSFER_DURATION.fullmatch(frequency) is None:
            raise CatalogMetadataInvalid(
                f"metadata {path}.transferFrequency must be an ISO duration"
            )
        result["transferFrequency"] = frequency
    if "formats" in value:
        formats: list[dict[str, Any]] = []
        for index, record in enumerate(_bounded_objects(value["formats"], 8, f"{path}.formats")):
            item_path = f"{path}.formats[{index}]"
            _known_fields(
                record, {"citation", "amendmentNumber", "fileDecompressionTechnique"}, item_path
            )
            item: dict[str, Any] = {
                "citation": _acquisition_citation(record.get("citation"), f"{item_path}.citation")
            }
            for field in ("amendmentNumber", "fileDecompressionTechnique"):
                if field in record:
                    item[field] = _string(record[field], 1, 1_000, f"{item_path}.{field}")
            formats.append(item)
        result["formats"] = formats
    if "onlineResources" in value:
        resources: list[dict[str, Any]] = []
        records = _bounded_objects(value["onlineResources"], 8, f"{path}.onlineResources")
        allowed = {
            "linkage",
            "protocol",
            "applicationProfile",
            "name",
            "description",
            "function",
            "protocolRequest",
        }
        for index, record in enumerate(records):
            item_path = f"{path}.onlineResources[{index}]"
            _known_fields(record, allowed, item_path)
            linkage = _string(record.get("linkage"), 1, 2_048, f"{item_path}.linkage")
            try:
                _public_https_url(linkage, f"{item_path}.linkage")
            except ValueError:
                raise CatalogMetadataInvalid(
                    f"metadata {item_path}.linkage must be a public HTTPS URL "
                    "without credentials or fragments"
                ) from None
            item = {"linkage": linkage}
            for field in allowed - {"linkage"}:
                if field in record:
                    item[field] = _string(
                        record[field],
                        1,
                        300 if field == "function" else 1_000,
                        f"{item_path}.{field}",
                    )
            resources.append(item)
        result["onlineResources"] = resources
    if "offlineMedia" in value:
        result["offlineMedia"] = [
            _iso_medium(record, f"{path}.offlineMedia[{index}]")
            for index, record in enumerate(
                _bounded_objects(value["offlineMedia"], 8, f"{path}.offlineMedia")
            )
        ]
    if "projections" in value:
        projections = value["projections"]
        projection_path = f"{path}.projections"
        if not isinstance(projections, dict) or not projections:
            raise CatalogMetadataInvalid(f"metadata {projection_path} must be a nonempty object")
        _known_fields(projections, {"accessUrl", "downloadUrl", "title", "format"}, projection_path)
        for field, index in projections.items():
            collection = "formats" if field == "format" else "onlineResources"
            if (
                isinstance(index, bool)
                or not isinstance(index, int)
                or not 0 <= index <= 7
                or index >= len(result.get(collection, []))
            ):
                raise CatalogMetadataInvalid(
                    f"metadata {projection_path}.{field} must reference "
                    f"an existing {collection} index"
                )
        result["projections"] = dict(projections)
    return result


def _iso_medium(value: Any, path: str) -> dict[str, Any]:
    """Validate the bounded, directly owned ISO MD_Medium subset."""
    if not isinstance(value, dict) or not value:
        raise CatalogMetadataInvalid(f"metadata {path} must be a nonempty medium object")
    _known_fields(
        value,
        {"name", "density", "densityUnits", "volumes", "mediumFormats", "mediumNote", "identifier"},
        path,
    )
    result: dict[str, Any] = {}
    if "name" in value:
        result["name"] = _acquisition_citation(value["name"], f"{path}.name")
    if "density" in value:
        density = value["density"]
        if (
            not isinstance(density, str)
            or not 1 <= len(density) <= 100
            or _ISO_MEDIUM_DENSITY.fullmatch(density) is None
            or not math.isfinite(float(density))
        ):
            raise CatalogMetadataInvalid(
                f"metadata {path}.density must be a finite xs:double lexical string"
            )
        result["density"] = density
    for field in ("densityUnits", "mediumNote"):
        if field in value:
            result[field] = _string(value[field], 1, 1_000, f"{path}.{field}")
    if "volumes" in value:
        volumes = value["volumes"]
        if (
            isinstance(volumes, bool)
            or not isinstance(volumes, int)
            or not -(10**18) <= volumes <= 10**18
        ):
            raise CatalogMetadataInvalid(f"metadata {path}.volumes must be a bounded integer")
        result["volumes"] = volumes
    if "mediumFormats" in value:
        formats = value["mediumFormats"]
        if not isinstance(formats, list) or not 1 <= len(formats) <= 8:
            raise CatalogMetadataInvalid(f"metadata {path}.mediumFormats requires 1 to 8 strings")
        result["mediumFormats"] = [
            _string(raw, 1, 300, f"{path}.mediumFormats[{index}]")
            for index, raw in enumerate(formats)
        ]
    if "identifier" in value:
        identifier = value["identifier"]
        if not isinstance(identifier, dict):
            raise CatalogMetadataInvalid(f"metadata {path}.identifier must be an object")
        _known_fields(identifier, {"code", "codeSpace"}, f"{path}.identifier")
        result["identifier"] = {
            "code": _string(identifier.get("code"), 1, 300, f"{path}.identifier.code")
        }
        if "codeSpace" in identifier:
            result["identifier"]["codeSpace"] = _string(
                identifier["codeSpace"], 1, 300, f"{path}.identifier.codeSpace"
            )
    return result


def _iso_order_date_time(value: Any, path: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 100
        or _ISO_ORDER_DATE_TIME.fullmatch(value) is None
    ):
        raise CatalogMetadataInvalid(f"metadata {path} must be an ISO date-time")
    try:
        if value[11:13] == "24":
            date.fromisoformat(value[:10])
            if re.fullmatch(r"24:00:00(?:\.0+)?(?:Z|[+-][0-9]{2}:[0-9]{2})?", value[11:]) is None:
                raise ValueError
        else:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise CatalogMetadataInvalid(
            f"metadata {path} must be a valid calendar date-time"
        ) from None
    return value


ISO_ADDRESS_FIELDS = {"deliveryPoints", "city", "administrativeArea", "postalCode", "country"}
ISO_CONTACT_FIELDS = {
    "phones",
    "onlineResources",
    "hoursOfService",
    "contactInstructions",
    "contactType",
}
ISO_UNIT_REFERENCE_FIELDS = {
    "href",
    "uuidref",
    "type",
    "role",
    "arcrole",
    "title",
    "show",
    "actuate",
}


def _iso_raw_text(value: Any, path: str, *, minimum: int = 0, maximum: int = 1_000) -> str:
    if (
        not isinstance(value, str)
        or not minimum <= len(value) <= maximum
        or not all(
            c in "\t\n"
            or 0x20 <= ord(c) <= 0xD7FF
            or 0xE000 <= ord(c) <= 0xFFFD
            or 0x10000 <= ord(c) <= 0x10FFFF
            for c in value
        )
    ):
        raise CatalogMetadataInvalid(f"metadata {path} must be exact XML-safe text")
    return value


def _iso_raw_strings(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        raise CatalogMetadataInvalid(f"metadata {path} requires 1 to 8 strings")
    return [_iso_raw_text(item, f"{path}[{i}]") for i, item in enumerate(value)]


def _iso_reference_uri(value: Any, path: str) -> str:
    raw = _iso_raw_text(value, path, minimum=1, maximum=2_048)
    try:
        parsed = urlsplit(raw)
        valid = (
            not any(c.isspace() or ord(c) < 0x20 or ord(c) == 0x7F for c in raw)
            and parsed.scheme in {"http", "https", "urn"}
            and parsed.username is None
            and parsed.password is None
            and (bool(parsed.hostname) if parsed.scheme in {"http", "https"} else bool(parsed.path))
        )
    except ValueError:
        valid = False
    if not valid:
        raise CatalogMetadataInvalid(
            f"metadata {path} requires an absolute HTTP/HTTPS/URN identifier"
        )
    return raw


def _iso_unit_reference(value: Any, path: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid(f"metadata {path} must be an object")
    _known_fields(value, ISO_UNIT_REFERENCE_FIELDS, path)
    if not {"href", "uuidref"} & value.keys():
        raise CatalogMetadataInvalid(f"metadata {path} requires href or uuidref")
    result: dict[str, str] = {}
    for field, raw in value.items():
        field_path = f"{path}.{field}"
        if field in {"href", "role", "arcrole"}:
            result[field] = _iso_reference_uri(raw, field_path)
        else:
            result[field] = _iso_raw_text(raw, field_path, minimum=0 if field == "title" else 1)
    enums = {
        "type": {"simple"},
        "show": {"new", "replace", "embed", "other", "none"},
        "actuate": {"onLoad", "onRequest", "other", "none"},
    }
    for field, accepted in enums.items():
        if field in result and result[field] not in accepted:
            raise CatalogMetadataInvalid(f"metadata {path}.{field} is unsupported")
    return result


def _iso_distribution_groups(
    value: Any,
    path: str = "opengeo.isoDistributionGroups",
    *,
    reserved_ids: Collection[str] = (),
    rich_contacts: bool = False,
) -> list[dict[str, Any]]:
    """Validate owned graph nodes without expanding declared local references."""
    identities: dict[str, str] = {}
    references: list[tuple[str, str, str]] = []
    total = 0

    def objects(raw: Any, location: str) -> list[dict[str, Any]]:
        return _bounded_objects(raw, 8, location)

    def party(raw: Any, location: str, *, individual: bool = False) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise CatalogMetadataInvalid(f"metadata {location} must be an object")
        kind = _string(raw.get("type"), 1, 100, f"{location}.type")
        if kind not in {"individual", "organisation"} or (individual and kind != "individual"):
            raise CatalogMetadataInvalid(f"metadata {location}.type is unsupported")
        allowed = {"type", "name", "contacts"}
        allowed.add("positionName" if kind == "individual" else "individuals")
        _known_fields(raw, allowed, location)
        result: dict[str, Any] = {"type": kind}
        for field in ("name", "positionName"):
            if field in raw:
                result[field] = _string(raw[field], 1, 1_000, f"{location}.{field}")
        if "individuals" in raw:
            result["individuals"] = [
                party(record, f"{location}.individuals[{i}]", individual=True)
                for i, record in enumerate(objects(raw["individuals"], f"{location}.individuals"))
            ]
        if "contacts" in raw:
            contacts: list[dict[str, Any]] = []
            for i, contact in enumerate(objects(raw["contacts"], f"{location}.contacts")):
                contact_path = f"{location}.contacts[{i}]"
                _known_fields(
                    contact,
                    {"addresses"} | (ISO_CONTACT_FIELDS if rich_contacts else set()),
                    contact_path,
                )
                normalized: dict[str, Any] = {}
                if "addresses" in contact:
                    addresses: list[dict[str, Any]] = []
                    for j, address in enumerate(
                        objects(contact["addresses"], f"{contact_path}.addresses")
                    ):
                        address_path = f"{contact_path}.addresses[{j}]"
                        _known_fields(
                            address,
                            {"emails"} | (ISO_ADDRESS_FIELDS if rich_contacts else set()),
                            address_path,
                        )
                        normalized_address: dict[str, Any] = {}
                        if "emails" in address:
                            emails = address["emails"]
                            if not isinstance(emails, list) or not 1 <= len(emails) <= 8:
                                raise CatalogMetadataInvalid(
                                    f"metadata {address_path}.emails requires 1 to 8 strings"
                                )
                            normalized_emails: list[str] = []
                            for k, raw_email in enumerate(emails):
                                email_path = f"{address_path}.emails[{k}]"
                                email = _string(raw_email, 1, 300, email_path)
                                if _EMAIL.fullmatch(email) is None:
                                    raise CatalogMetadataInvalid(
                                        f"metadata {email_path} is invalid"
                                    )
                                normalized_emails.append(email)
                            normalized_address["emails"] = normalized_emails
                        for field in ISO_ADDRESS_FIELDS & address.keys():
                            if field == "deliveryPoints":
                                normalized_address[field] = _iso_raw_strings(
                                    address[field], f"{address_path}.{field}"
                                )
                            else:
                                normalized_address[field] = _iso_raw_text(
                                    address[field], f"{address_path}.{field}"
                                )
                        addresses.append(normalized_address)
                    normalized["addresses"] = addresses
                if "phones" in contact:
                    phones: list[dict[str, str]] = []
                    for phone_index, phone in enumerate(
                        objects(contact["phones"], f"{contact_path}.phones")
                    ):
                        phone_path = f"{contact_path}.phones[{phone_index}]"
                        _known_fields(phone, {"number", "numberType"}, phone_path)
                        if "number" not in phone:
                            raise CatalogMetadataInvalid(
                                f"metadata {phone_path}.number is required"
                            )
                        item = {"number": _iso_raw_text(phone["number"], f"{phone_path}.number")}
                        if "numberType" in phone:
                            code = _iso_raw_text(
                                phone["numberType"],
                                f"{phone_path}.numberType",
                                minimum=1,
                                maximum=300,
                            )
                            if code != code.strip() or any(c in code for c in "\t\n"):
                                raise CatalogMetadataInvalid(
                                    f"metadata {phone_path}.numberType is invalid"
                                )
                            item["numberType"] = code
                        phones.append(item)
                    normalized["phones"] = phones
                if "onlineResources" in contact:
                    normalized["onlineResources"] = _iso_transfer(
                        {"onlineResources": contact["onlineResources"]}, contact_path
                    )["onlineResources"]
                if "hoursOfService" in contact:
                    normalized["hoursOfService"] = _iso_raw_strings(
                        contact["hoursOfService"], f"{contact_path}.hoursOfService"
                    )
                for field in ("contactInstructions", "contactType"):
                    if field in contact:
                        normalized[field] = _iso_raw_text(contact[field], f"{contact_path}.{field}")
                contacts.append(normalized)
            result["contacts"] = contacts
        return result

    def responsibility(raw: Any, location: str) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise CatalogMetadataInvalid(f"metadata {location} must be an object")
        _known_fields(raw, {"role", "parties"}, location)
        return {
            "role": _string(raw.get("role"), 1, 300, f"{location}.role"),
            "parties": [
                party(record, f"{location}.parties[{i}]")
                for i, record in enumerate(objects(raw.get("parties"), f"{location}.parties"))
            ],
        }

    children = {
        "Group": {"formats": "Format", "distributors": "Distributor", "transferOptions": "DTO"},
        "Format": {"media": "Medium", "distributors": "Distributor"},
        "Distributor": {"orders": "Order", "formats": "Format", "transferOptions": "DTO"},
        "DTO": {"formats": "Format", "offlineMedia": "Medium"},
        "Medium": {},
        "Order": {},
    }
    scalar_fields = {
        "Group": {"description"},
        "Format": {"citation", "amendmentNumber", "fileDecompressionTechnique"},
        "Distributor": {"contact"},
        "DTO": {
            "unitsOfDistribution",
            "transferSizeMegabytes",
            "transferFrequency",
            "onlineResources",
        },
        "Medium": {
            "name",
            "density",
            "densityUnits",
            "volumes",
            "mediumFormats",
            "mediumNote",
            "identifier",
        },
        "Order": {
            "fees",
            "plannedAvailableDateTime",
            "orderingInstructions",
            "turnaround",
            "orderOptionsType",
            "orderOptions",
        },
    }

    def node(raw: Any, kind: str, location: str, depth: int) -> dict[str, Any]:
        nonlocal total
        if not isinstance(raw, dict):
            raise CatalogMetadataInvalid(f"metadata {location} must be an object")
        if "ref" in raw:
            _known_fields(raw, {"ref"}, location)
            identifier = _quality_id(raw["ref"], f"{location}.ref")
            references.append((identifier, kind, f"{location}.ref"))
            return {"ref": identifier}
        total += 1
        if total > 64:
            raise CatalogMetadataInvalid(f"metadata {location} exceeds 64 embedded graph nodes")
        if depth > 16:
            raise CatalogMetadataInvalid(f"metadata {location} exceeds 16 nested typed graph nodes")
        _known_fields(raw, {"id", *scalar_fields[kind], *children[kind]}, location)
        result: dict[str, Any] = {}
        if "id" in raw:
            identifier = _quality_id(raw["id"], f"{location}.id")
            if identifier in identities or identifier in reserved_ids:
                raise CatalogMetadataInvalid(f"metadata {location}.id must be globally unique")
            identities[identifier] = kind
            result["id"] = identifier
        base = {key: raw[key] for key in scalar_fields[kind] if key in raw}
        if kind == "Format":
            result["citation"] = _acquisition_citation(base.get("citation"), f"{location}.citation")
            for field in ("amendmentNumber", "fileDecompressionTechnique"):
                if field in base:
                    result[field] = _string(base[field], 1, 1_000, f"{location}.{field}")
        elif kind == "Distributor":
            result["contact"] = responsibility(base.get("contact"), f"{location}.contact")
        elif kind == "DTO":
            if base:
                result.update(_iso_transfer(base, location, offline_media=True))
        elif kind == "Medium":
            if base:
                result.update(_iso_medium(base, location))
        elif kind == "Order":
            for field, raw_field in base.items():
                if field == "plannedAvailableDateTime":
                    result[field] = _iso_order_date_time(raw_field, f"{location}.{field}")
                elif field in {"orderOptionsType", "orderOptions"}:
                    if not isinstance(raw_field, str) or len(raw_field) > 1_000:
                        raise CatalogMetadataInvalid(
                            f"metadata {location}.{field} must be a plaintext string "
                            "up to 1000 characters"
                        )
                    result[field] = raw_field
                else:
                    result[field] = _string(raw_field, 1, 1_000, f"{location}.{field}")
        elif "description" in base:
            result["description"] = _string(
                base["description"], 1, 1_000, f"{location}.description"
            )
        for field, child_kind in children[kind].items():
            if field in raw:
                result[field] = [
                    node(record, child_kind, f"{location}.{field}[{i}]", depth + 1)
                    for i, record in enumerate(objects(raw[field], f"{location}.{field}"))
                ]
        return result

    result = [node(raw, "Group", f"{path}[{i}]", 1) for i, raw in enumerate(objects(value, path))]
    for identifier, kind, location in references:
        if identities.get(identifier) != kind:
            raise CatalogMetadataInvalid(f"metadata {location} requires a declared {kind} graph id")
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


def _quality_strings(value: Any, maximum: int, path: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        raise CatalogMetadataInvalid(f"metadata {path} requires 1 to 8 strings")
    return [_string(item, 1, maximum, f"{path}[{i}]") for i, item in enumerate(value)]


def _quality_id(value: Any, path: str) -> str:
    identifier = _string(value, 1, 100, path)
    if _QUALITY_XML_ID.fullmatch(identifier) is None:
        raise CatalogMetadataInvalid(f"metadata {path} must be an XML NCName")
    return identifier


def _quality_scope(value: Any, path: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid(f"metadata {path} must be an object")
    _known_fields(value, {"level"}, path)
    return {"level": _string(value.get("level"), 1, 300, f"{path}.level")}


def _quality_measure(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid(f"metadata {path} must be an object")
    _known_fields(value, {"identifier", "names", "description"}, path)
    result: dict[str, Any] = {}
    if "identifier" in value:
        identifier = value["identifier"]
        if not isinstance(identifier, dict):
            raise CatalogMetadataInvalid(f"metadata {path}.identifier must be an object")
        _known_fields(identifier, {"code", "codeSpace"}, f"{path}.identifier")
        result["identifier"] = {
            "code": _string(identifier.get("code"), 1, 300, f"{path}.identifier.code")
        }
        if "codeSpace" in identifier:
            result["identifier"]["codeSpace"] = _string(
                identifier["codeSpace"], 1, 300, f"{path}.identifier.codeSpace"
            )
    if "names" in value:
        result["names"] = _quality_strings(value["names"], 300, f"{path}.names")
    if "identifier" not in result and "names" not in result:
        raise CatalogMetadataInvalid(f"metadata {path} requires identifier or names")
    if "description" in value:
        result["description"] = _string(value["description"], 1, 1_000, f"{path}.description")
    return result


def _quality_evaluation(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid(f"metadata {path} must be an object")
    kind = _string(value.get("type"), 1, 100, f"{path}.type")
    if kind not in ISO_QUALITY_EVALUATION_TYPES:
        raise CatalogMetadataInvalid(f"metadata {path}.type is unsupported")
    allowed = {"type", "methodType", "description", "procedure", "referenceDocuments", "dateTimes"}
    required_strings: tuple[str, ...] = ()
    if kind == "DQ_IndirectEvaluation":
        allowed.add("deductiveSources")
    if kind == "DQ_SampleBasedInspection":
        required_strings = ("samplingScheme", "lotDescription", "samplingRatio")
        allowed.update(required_strings)
    _known_fields(value, allowed, path)
    result: dict[str, Any] = {"type": kind}
    if "methodType" in value:
        method = _string(value["methodType"], 1, 100, f"{path}.methodType")
        if method not in {"directInternal", "directExternal", "indirect"}:
            raise CatalogMetadataInvalid(f"metadata {path}.methodType is unsupported")
        result["methodType"] = method
    for field in (*required_strings, "description"):
        if field in value or field in required_strings:
            result[field] = _string(value.get(field), 1, 1_000, f"{path}.{field}")
    if "procedure" in value:
        result["procedure"] = _acquisition_citation(value["procedure"], f"{path}.procedure")
    if "referenceDocuments" in value:
        result["referenceDocuments"] = [
            _acquisition_citation(record, f"{path}.referenceDocuments[{i}]")
            for i, record in enumerate(
                _bounded_objects(value["referenceDocuments"], 8, f"{path}.referenceDocuments")
            )
        ]
    if "dateTimes" in value:
        result["dateTimes"] = [
            _context_date_time(raw, f"{path}.dateTimes[{i}]")[1]
            for i, raw in enumerate(_quality_strings(value["dateTimes"], 100, f"{path}.dateTimes"))
        ]
    if kind == "DQ_IndirectEvaluation":
        result["deductiveSources"] = _quality_strings(
            value.get("deductiveSources"), 1_000, f"{path}.deductiveSources"
        )
    return result


def _quality_result(
    value: dict[str, Any], path: str, *, unit_references: bool = False
) -> dict[str, Any]:
    kind = _string(value.get("type"), 1, 100, f"{path}.type")
    variants = {
        "DQ_QuantitativeResult": {"values", "unit", "recordType"}
        | ({"unitReference"} if unit_references else set()),
        "DQ_DescriptiveResult": {"statement"},
        "DQ_ConformanceResult": {"specification", "explanation", "pass"},
    }
    if kind not in variants:
        raise CatalogMetadataInvalid(f"metadata {path}.type is unsupported")
    _known_fields(value, {"type", "dateTime", "scope", *variants[kind]}, path)
    result: dict[str, Any] = {"type": kind}
    if "dateTime" in value:
        result["dateTime"] = _context_date_time(value["dateTime"], f"{path}.dateTime")[1]
    if "scope" in value:
        result["scope"] = _quality_scope(value["scope"], f"{path}.scope")
    if kind == "DQ_QuantitativeResult":
        result["values"] = _quality_strings(value.get("values"), 1_000, f"{path}.values")
        if "unitReference" in value:
            if "unit" in value:
                raise CatalogMetadataInvalid(
                    f"metadata {path}.unit and unitReference are mutually exclusive"
                )
            result["unitReference"] = _iso_unit_reference(
                value["unitReference"], f"{path}.unitReference"
            )
        for field in ("unit", "recordType"):
            if field in value:
                result[field] = _string(value[field], 1, 1_000, f"{path}.{field}")
    elif kind == "DQ_DescriptiveResult":
        result["statement"] = _string(value.get("statement"), 1, 1_000, f"{path}.statement")
    else:
        result["specification"] = _acquisition_citation(
            value.get("specification"), f"{path}.specification"
        )
        if type(value.get("pass")) is not bool:
            raise CatalogMetadataInvalid(f"metadata {path}.pass must be a boolean")
        result["pass"] = value["pass"]
        if "explanation" in value:
            result["explanation"] = _string(value["explanation"], 1, 1_000, f"{path}.explanation")
    return result


def _quality_reports(value: Any, *, unit_references: bool = False) -> list[dict[str, Any]]:
    groups = _bounded_objects(value, 8, "opengeo.qualityReports")
    result: list[dict[str, Any]] = []
    declared: set[str] = set()
    references: list[tuple[str, list[str]]] = []
    total = 0
    for group_index, group in enumerate(groups):
        path = f"opengeo.qualityReports[{group_index}]"
        _known_fields(group, {"scope", "reports"}, path)
        scope = _quality_scope(group.get("scope"), f"{path}.scope")
        reports = _bounded_objects(group.get("reports"), 32, f"{path}.reports")
        total += len(reports)
        if total > 32:
            raise CatalogMetadataInvalid(
                "metadata opengeo.qualityReports requires at most 32 total reports"
            )
        normalized: list[dict[str, Any]] = []
        for report_index, report in enumerate(reports):
            report_path = f"{path}.reports[{report_index}]"
            _known_fields(
                report,
                {
                    "id",
                    "type",
                    "standaloneDetails",
                    "measure",
                    "evaluation",
                    "results",
                    "derivedReports",
                    "relatedReports",
                },
                report_path,
            )
            kind = _string(report.get("type"), 1, 100, f"{report_path}.type")
            if kind not in ISO_QUALITY_REPORT_TYPES:
                raise CatalogMetadataInvalid(f"metadata {report_path}.type is unsupported")
            item: dict[str, Any] = {"type": kind}
            if "id" in report:
                identifier = _quality_id(report["id"], f"{report_path}.id")
                if identifier in declared:
                    raise CatalogMetadataInvalid(
                        f"metadata {report_path}.id must be globally unique"
                    )
                declared.add(identifier)
                item["id"] = identifier
            if "standaloneDetails" in report:
                item["standaloneDetails"] = _string(
                    report["standaloneDetails"], 1, 1_000, f"{report_path}.standaloneDetails"
                )
            if "measure" in report:
                item["measure"] = _quality_measure(report["measure"], f"{report_path}.measure")
            if "evaluation" in report:
                item["evaluation"] = _quality_evaluation(
                    report["evaluation"], f"{report_path}.evaluation"
                )
            item["results"] = [
                _quality_result(
                    record, f"{report_path}.results[{i}]", unit_references=unit_references
                )
                for i, record in enumerate(
                    _bounded_objects(report.get("results"), 8, f"{report_path}.results")
                )
            ]
            for field in ("derivedReports", "relatedReports"):
                if field in report:
                    if field == "relatedReports" and kind not in _QUALITY_METAQUALITY_TYPES:
                        raise CatalogMetadataInvalid(
                            f"metadata {report_path}.relatedReports requires a metaquality report"
                        )
                    refs = _quality_strings(report[field], 100, f"{report_path}.{field}")
                    item[field] = [
                        _quality_id(ref, f"{report_path}.{field}[{i}]")
                        for i, ref in enumerate(refs)
                    ]
                    references.append((f"{report_path}.{field}", item[field]))
            normalized.append(item)
        result.append({"scope": scope, "reports": normalized})
    for path, refs in references:
        if any(ref not in declared for ref in refs):
            raise CatalogMetadataInvalid(f"metadata {path} references an undeclared report id")
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


def _acquisition(value: Any, *, planning: bool, event_graph: bool, context: bool) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid("metadata opengeo.acquisition must be an object")
    allowed = {"instruments", "platforms", "operations"}
    if planning:
        allowed.update({"plans", "objectives", "requirements"})
    if event_graph:
        allowed.update({"events", "platformPasses"})
    if context:
        allowed.add("environmentalConditions")
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
        value.get("platformPasses", []) if event_graph else [], context=context
    )
    if platform_passes:
        result["platformPasses"] = platform_passes
    pass_identifiers = {record["identifier"] for record in platform_passes}
    objectives = _acquisition_objectives(
        value.get("objectives", []),
        instrument_identifiers,
        pass_identifiers,
        event_graph=event_graph,
        context=context,
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
    requirements = _acquisition_requirements(value.get("requirements", []), context=context)
    if requirements:
        result["requirements"] = requirements
    requirement_identifiers = {record["identifier"] for record in requirements}
    plans = _acquisition_plans(
        value.get("plans", []), operation_identifiers, requirement_identifiers, context=context
    )
    if plans:
        result["plans"] = plans
    if "environmentalConditions" in value:
        result["environmentalConditions"] = _acquisition_environment(
            value["environmentalConditions"]
        )
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
    context: bool,
) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.objectives")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.objectives[{index}]"
        allowed = {"identifier", "priority", "types", "functions", "instrumentIdentifiers"}
        if event_graph:
            allowed.update({"passIdentifiers", "eventIdentifiers"})
        if context:
            allowed.add("extents")
        _known_fields(record, allowed, path)
        objective: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier")
        }
        if "priority" in record:
            objective["priority"] = _string(record["priority"], 1, 300, f"{path}.priority")
        if "extents" in record:
            extents = _bounded_objects(record["extents"], 4, f"{path}.extents")
            objective["extents"] = [
                _acquisition_extent(extent, f"{path}.extents[{extent_index}]")
                for extent_index, extent in enumerate(extents)
            ]
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


def _acquisition_platform_passes(value: Any, *, context: bool) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.platformPasses")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.platformPasses[{index}]"
        allowed = {"identifier", "eventIdentifiers"}
        if context:
            allowed.add("extent")
        _known_fields(record, allowed, path)
        platform_pass: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier")
        }
        if "extent" in record:
            platform_pass["extent"] = _acquisition_extent(record["extent"], f"{path}.extent")
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


def _acquisition_requirements(value: Any, *, context: bool) -> list[dict[str, Any]]:
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
        _known_fields(record, required | ({"citation"} if context else set()), path)
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
        if "citation" in record:
            result[-1]["citation"] = _acquisition_citation(record["citation"], f"{path}.citation")
    _unique_identifiers(result, "opengeo.acquisition.requirements")
    return result


def _acquisition_plans(
    value: Any,
    operation_identifiers: set[str],
    requirement_identifiers: set[str],
    *,
    context: bool,
) -> list[dict[str, Any]]:
    records = _object_list(value, 32, "opengeo.acquisition.plans")
    result: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = f"opengeo.acquisition.plans[{index}]"
        allowed = {
            "identifier",
            "status",
            "type",
            "operationIdentifiers",
            "requirementIdentifiers",
        }
        if context:
            allowed.add("citation")
        _known_fields(record, allowed, path)
        plan: dict[str, Any] = {
            "identifier": _string(record.get("identifier"), 1, 300, f"{path}.identifier"),
            "status": _string(record.get("status"), 1, 300, f"{path}.status"),
        }
        if plan["status"] not in _ACQUISITION_STATUSES:
            raise CatalogMetadataInvalid(f"metadata {path}.status is unsupported")
        if "citation" in record:
            plan["citation"] = _acquisition_citation(record["citation"], f"{path}.citation")
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


def _bounded_objects(value: Any, maximum: int, path: str) -> list[dict[str, Any]]:
    records = _object_list(value, maximum, path)
    if not records:
        raise CatalogMetadataInvalid(f"metadata {path} requires at least one object")
    return records


def _finite_number(value: Any, path: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise CatalogMetadataInvalid(f"metadata {path} must be a finite number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise CatalogMetadataInvalid(f"metadata {path} must be a finite number")
    return value


def _context_date_time(value: Any, path: str) -> tuple[tuple[datetime, str], str]:
    normalized = _string(value, 1, 100, path)
    match = _CONTEXT_DATE_TIME.fullmatch(normalized)
    if match is None:
        raise CatalogMetadataInvalid(
            f"metadata {path} must be a full date-time with a timezone offset up to 14:00"
        )
    parsed, normalized = _date_time(normalized, path)
    # Compare arbitrary fractional precision without datetime's microsecond truncation.
    key = (parsed.replace(microsecond=0), (match.group(1) or "").rstrip("0"))
    return key, normalized


def _acquisition_extent(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not value:
        raise CatalogMetadataInvalid(f"metadata {path} must be a nonempty extent object")
    _known_fields(value, {"description", "geographicBounds", "temporal"}, path)
    result: dict[str, Any] = {}
    if "description" in value:
        result["description"] = _string(value["description"], 1, 1_000, f"{path}.description")
    if "geographicBounds" in value:
        bounds = _bounded_objects(value["geographicBounds"], 4, f"{path}.geographicBounds")
        boxes: list[dict[str, Any]] = []
        for index, box in enumerate(bounds):
            box_path = f"{path}.geographicBounds[{index}]"
            required = {"west", "east", "south", "north"}
            _known_fields(box, required | {"extentTypeCode"}, box_path)
            missing = required - set(box)
            if missing:
                raise CatalogMetadataInvalid(f"metadata {box_path} requires {sorted(missing)[0]}")
            normalized: dict[str, Any] = {}
            for field, maximum in (("west", 180), ("east", 180), ("south", 90), ("north", 90)):
                coordinate = _finite_number(box[field], f"{box_path}.{field}")
                if not -maximum <= coordinate <= maximum:
                    raise CatalogMetadataInvalid(f"metadata {box_path}.{field} is out of range")
                normalized[field] = coordinate
            if normalized["south"] > normalized["north"]:
                raise CatalogMetadataInvalid(f"metadata {box_path} requires south <= north")
            if "extentTypeCode" in box:
                if not isinstance(box["extentTypeCode"], bool):
                    raise CatalogMetadataInvalid(
                        f"metadata {box_path}.extentTypeCode must be a boolean"
                    )
                normalized["extentTypeCode"] = box["extentTypeCode"]
            boxes.append(normalized)
        result["geographicBounds"] = boxes
    if "temporal" in value:
        temporal = value["temporal"]
        temporal_path = f"{path}.temporal"
        if not isinstance(temporal, dict):
            raise CatalogMetadataInvalid(f"metadata {temporal_path} must be an object")
        _known_fields(temporal, {"start", "end"}, temporal_path)
        if set(temporal) != {"start", "end"}:
            raise CatalogMetadataInvalid(f"metadata {temporal_path} requires start and end")
        start, start_value = _context_date_time(temporal["start"], f"{temporal_path}.start")
        end, end_value = _context_date_time(temporal["end"], f"{temporal_path}.end")
        if start > end:
            raise CatalogMetadataInvalid(f"metadata {temporal_path} requires start <= end")
        result["temporal"] = {"start": start_value, "end": end_value}
    return result


def _acquisition_environment(value: Any) -> dict[str, Any]:
    path = "opengeo.acquisition.environmentalConditions"
    if not isinstance(value, dict) or not value:
        raise CatalogMetadataInvalid(f"metadata {path} must be a nonempty object")
    numeric = {
        "averageAirTemperature",
        "maxRelativeHumidity",
        "maxAltitude",
        "solarAzimuth",
        "solarElevation",
    }
    _known_fields(value, numeric | {"meteorologicalConditions"}, path)
    return {
        field: (
            _finite_number(raw, f"{path}.{field}")
            if field in numeric
            else _string(raw, 1, 1_000, f"{path}.{field}")
        )
        for field, raw in value.items()
    }


def _acquisition_citation(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogMetadataInvalid(f"metadata {path} must be an object")
    _known_fields(
        value,
        {"title", "alternateTitles", "dates", "edition", "editionDate", "identifiers"},
        path,
    )
    result: dict[str, Any] = {"title": _string(value.get("title"), 1, 1_000, f"{path}.title")}
    if "alternateTitles" in value:
        titles = value["alternateTitles"]
        if not isinstance(titles, list) or not 1 <= len(titles) <= 8:
            raise CatalogMetadataInvalid(f"metadata {path}.alternateTitles requires 1 to 8 strings")
        result["alternateTitles"] = [
            _string(title, 1, 1_000, f"{path}.alternateTitles[{index}]")
            for index, title in enumerate(titles)
        ]
    if "dates" in value:
        dates: list[dict[str, str]] = []
        for index, record in enumerate(_bounded_objects(value["dates"], 8, f"{path}.dates")):
            date_path = f"{path}.dates[{index}]"
            _known_fields(record, {"date", "dateType"}, date_path)
            raw_date = _string(record.get("date"), 10, 10, f"{date_path}.date")
            try:
                if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", raw_date) is None:
                    raise ValueError
                date.fromisoformat(raw_date)
            except ValueError:
                raise CatalogMetadataInvalid(
                    f"metadata {date_path}.date must be a valid YYYY-MM-DD calendar date"
                ) from None
            date_type = _string(record.get("dateType"), 1, 300, f"{date_path}.dateType")
            if date_type not in _CITATION_DATE_TYPES:
                raise CatalogMetadataInvalid(f"metadata {date_path}.dateType is unsupported")
            dates.append({"date": raw_date, "dateType": date_type})
        result["dates"] = dates
    if "edition" in value:
        result["edition"] = _string(value["edition"], 1, 300, f"{path}.edition")
    if "editionDate" in value:
        _, result["editionDate"] = _context_date_time(value["editionDate"], f"{path}.editionDate")
    if "identifiers" in value:
        identifiers: list[dict[str, str]] = []
        identities: set[tuple[str | None, str]] = set()
        for index, record in enumerate(
            _bounded_objects(value["identifiers"], 8, f"{path}.identifiers")
        ):
            identifier_path = f"{path}.identifiers[{index}]"
            _known_fields(record, {"code", "codeSpace"}, identifier_path)
            identifier = {"code": _string(record.get("code"), 1, 300, f"{identifier_path}.code")}
            if "codeSpace" in record:
                identifier["codeSpace"] = _string(
                    record["codeSpace"], 1, 300, f"{identifier_path}.codeSpace"
                )
                if identifier["codeSpace"] == _ACQUISITION_PLAN_ID_CODE_SPACE:
                    raise CatalogMetadataInvalid(
                        f"metadata {identifier_path}.codeSpace is reserved for plan identity"
                    )
            identity = (identifier.get("codeSpace"), identifier["code"])
            if identity in identities:
                raise CatalogMetadataInvalid(f"metadata {path}.identifiers must be unique")
            identities.add(identity)
            identifiers.append(identifier)
        result["identifiers"] = identifiers
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
